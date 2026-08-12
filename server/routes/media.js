/**
 * Website media manager — Marketing → Website → Media.
 * Stores originals under uploads/media/ (served at /api/uploads/media/...),
 * generates responsive webp/avif variants, and keeps metadata (alt text, credit,
 * folder, tags) in kindred_web.media. Read by the Astro website via URL.
 *
 * Table lives in the fixed `kindred_web` schema, so queries are schema-qualified
 * (db.js sets search_path to the app schema, teamtask_hub).
 */
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { query } from '../db.js';
import { requireManager } from '../middleware/auth.js';
import { MEDIA_DIR, generateVariants, safeBase, filesFor, publicUrl } from '../lib/mediaVariants.js';
import { importWordpressMedia } from '../lib/importWordpressMedia.js';
import { absMedia, absMediaAll } from '../lib/mediaUrls.js';

const router = express.Router();
const cId = (req) => req.companyId;

// In-memory state for the WordPress import (runs in the background so the HTTP
// request returns immediately and the UI polls for progress).
let importState = { running: false, startedAt: null, finishedAt: null, report: null, error: null };

const storage = multer.diskStorage({
  destination: MEDIA_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${safeBase(file.originalname)}-${Date.now()}${ext}`);
  },
});
// One 500MB ceiling for images and video alike. Disk is not the constraint
// (the host is unmetered); what needed guarding was memory, and that lives in
// generateVariants, which skips resizing for absurd pixel counts rather than
// trying to decode them.
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

const isVideo = (mime = '') => mime.startsWith('video/');
const isImage = (mime = '') => mime.startsWith('image/');

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    if (file.fieldname === 'poster') {
      // Poster frame for a video, grabbed in the browser at upload time.
      if (!isImage(file.mimetype)) return cb(new Error('Poster must be an image'));
      return cb(null, true);
    }
    if (!isImage(file.mimetype) && !isVideo(file.mimetype)) {
      return cb(new Error('Only image and video files are allowed'));
    }
    cb(null, true);
  },
});

// GET /api/media — list with optional filters (folder, source, tag, q) + paging.
router.get('/', async (req, res) => {
  const { folder, source, tag, q } = req.query;
  const where = [];
  const params = [];
  if (folder) { params.push(folder); where.push(`folder = $${params.length}`); }
  if (source) { params.push(source); where.push(`source = $${params.length}`); }
  if (tag) { params.push(tag); where.push(`$${params.length} = ANY(tags)`); }
  if (q) { params.push(`%${q}%`); where.push(`(alt_text ILIKE $${params.length} OR original_name ILIKE $${params.length} OR caption ILIKE $${params.length})`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const countRes = await query(`SELECT COUNT(*)::int AS n FROM kindred_web.media ${clause}`, params);

  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Number(req.query.offset) || 0;
  params.push(limit); const limIdx = params.length;
  params.push(offset); const offIdx = params.length;
  const rows = await query(
    `SELECT * FROM kindred_web.media ${clause} ORDER BY created_at DESC LIMIT $${limIdx} OFFSET $${offIdx}`,
    params
  );
  res.json({ media: absMediaAll(rows.rows), total: countRes.rows[0].n });
});

// Special folders that always exist and can't be removed.
const PROTECTED_FOLDERS = ['library', 'needs-review'];

async function declaredFolders() {
  const r = await query(`SELECT value FROM kindred_web.settings WHERE key = 'media_folders'`);
  return Array.isArray(r.rows[0]?.value) ? r.rows[0].value : [];
}
async function saveDeclaredFolders(list, userId) {
  await query(
    `INSERT INTO kindred_web.settings (key, value, updated_by)
     VALUES ('media_folders', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW(), updated_by = $2`,
    [JSON.stringify(list), userId || null]
  );
}

// GET /api/media/folders — every folder (declared + in-use + protected) with counts.
router.get('/folders', async (_req, res) => {
  const counts = await query(`SELECT folder, COUNT(*)::int AS n FROM kindred_web.media GROUP BY folder`);
  const countMap = new Map(counts.rows.map((r) => [r.folder, r.n]));
  const declared = await declaredFolders();
  const names = new Set([...PROTECTED_FOLDERS, ...declared, ...counts.rows.map((r) => r.folder)]);
  const folders = [...names].sort((a, b) => a.localeCompare(b)).map((folder) => ({
    folder,
    n: countMap.get(folder) || 0,
    protected: PROTECTED_FOLDERS.includes(folder),
  }));
  res.json({ folders });
});

// POST /api/media/folders {name} — create a (possibly empty) folder. Manager only.
router.post('/folders', requireManager, async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Folder name is required' });
  if (name.length > 280) return res.status(400).json({ error: 'Folder name is too long' });
  const list = await declaredFolders();
  if (!list.includes(name)) list.push(name);
  await saveDeclaredFolders(list, req.userId);
  res.status(201).json({ ok: true, name });
});

// DELETE /api/media/folders — remove a folder; its images move to reassignTo. Manager only.
router.delete('/folders', requireManager, async (req, res) => {
  const name = (req.body?.name || req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Folder name is required' });
  if (PROTECTED_FOLDERS.includes(name)) return res.status(400).json({ error: `"${name}" can't be removed` });
  const reassignTo = (req.body?.reassignTo || 'library').trim() || 'library';
  const moved = await query(
    `UPDATE kindred_web.media SET folder = $1, updated_at = NOW() WHERE folder = $2`,
    [reassignTo, name]
  );
  const list = (await declaredFolders()).filter((f) => f !== name);
  await saveDeclaredFolders(list, req.userId);
  res.json({ ok: true, reassignedTo: reassignTo, moved: moved.rowCount });
});

// GET /api/media/import/status — poll the background import.
router.get('/import/status', (_req, res) => res.json(importState));

// POST /api/media/import/wordpress — kick off the WordPress import in the background.
router.post('/import/wordpress', requireManager, (req, res) => {
  if (importState.running) return res.status(409).json({ error: 'An import is already running.' });
  const dryRun = req.query.dryRun === '1' || req.body?.dryRun === true;
  importState = { running: true, startedAt: new Date().toISOString(), finishedAt: null, report: null, error: null };
  importWordpressMedia({
    dryRun,
    companyId: cId(req) || null,
    onProgress: (r) => { importState.report = r; },
  })
    .then((report) => { importState = { ...importState, running: false, finishedAt: new Date().toISOString(), report }; })
    .catch((err) => { importState = { ...importState, running: false, finishedAt: new Date().toISOString(), error: err.message }; });
  res.status(202).json({ started: true });
});

// GET /api/media/:id
router.get('/:id', async (req, res) => {
  const r = await query(`SELECT * FROM kindred_web.media WHERE id = $1`, [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(absMedia(r.rows[0]));
});

// POST /api/media/upload — upload one image (field name: "file").
router.post('/upload', requireManager,
  upload.fields([{ name: 'file', maxCount: 1 }, { name: 'poster', maxCount: 1 }]),
  async (req, res) => {
  const file = req.files?.file?.[0];
  if (!file) return res.status(400).json({ error: 'No file uploaded' });
  const { filename, originalname, mimetype, size } = file;

  let original, variants, width, height;
  if (isVideo(mimetype)) {
    // No resizing for video: there is no ffmpeg on the server, and a poster
    // frame captured in the browser gives the library something to show
    // without one. Playback is served straight from disk -- express.static
    // answers range requests, so seeking works.
    original = { url: publicUrl(filename), w: null, h: null };
    width = height = null;
    const poster = req.files?.poster?.[0];
    variants = poster ? { poster: publicUrl(poster.filename) } : null;
  } else {
    ({ original, variants, width, height } =
      await generateVariants(path.join(MEDIA_DIR, filename), filename));
  }

  const b = req.body || {};
  const tags = Array.isArray(b.tags)
    ? b.tags
    : (typeof b.tags === 'string' && b.tags ? b.tags.split(',').map((t) => t.trim()).filter(Boolean) : null);

  const r = await query(
    `INSERT INTO kindred_web.media
       (filename, original_name, url, mime, width, height, size_bytes,
        alt_text, caption, credit, folder, tags, variants, source, company_id, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'upload',$14,$15)
     RETURNING *`,
    [filename, originalname, original.url, mimetype, width, height, size,
     b.alt_text || null, b.caption || null, b.credit || null, b.folder || 'library',
     tags, variants ? JSON.stringify(variants) : null, cId(req), req.userId]
  );
  res.status(201).json(absMedia(r.rows[0]));
});

// PATCH /api/media/:id — edit metadata (alt_text, caption, credit, folder, tags).
router.patch('/:id', requireManager, async (req, res) => {
  const editable = ['alt_text', 'caption', 'credit', 'folder', 'tags'];
  const sets = [];
  const params = [];
  for (const k of editable) {
    if (!(k in req.body)) continue;
    let v = req.body[k];
    if (k === 'tags') {
      v = Array.isArray(v) ? v : (typeof v === 'string' && v ? v.split(',').map((t) => t.trim()).filter(Boolean) : null);
    }
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'No editable fields provided' });
  params.push(req.params.id);
  const r = await query(
    `UPDATE kindred_web.media SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(absMedia(r.rows[0]));
});

// DELETE /api/media/:id — remove the row and all on-disk files (original + variants).
router.delete('/:id', requireManager, async (req, res) => {
  const r = await query(`SELECT filename, variants FROM kindred_web.media WHERE id = $1`, [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  for (const f of filesFor(r.rows[0])) fs.unlink(path.join(MEDIA_DIR, f), () => {});
  await query(`DELETE FROM kindred_web.media WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

export { router as mediaRouter };
