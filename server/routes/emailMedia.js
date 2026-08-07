/**
 * Email image variants — /email-media/:kind/:id
 *
 * Derives a small, email-friendly JPEG from a record's existing image and
 * caches it on disk. First request renders, everything after is a file read.
 *
 * Derived rather than a stored email_image field, because a field is something
 * a person has to remember to fill and the failure is silent — a 3MB hero that
 * nobody notices until deliverability drops. Events already carry image_url and
 * social_image_url; a third hand-maintained variant is the problem, not the fix.
 *
 * PUBLIC AND UNAUTHENTICATED, necessarily. Mail clients fetch images with no
 * cookies, no token and no session, from wherever the recipient happens to be,
 * so this cannot sit behind requireAuth like the rest of the API. That makes it
 * the one endpoint where a path-handling mistake is reachable by anyone, so:
 *
 *   - the caller names a RECORD (kind + id), never a path or a URL
 *   - the source is read from that record's own column, so the set of
 *     reachable files is exactly the set already published on the website
 *   - width is clamped to a fixed allow-list, so the cache cannot be filled
 *     with thousands of arbitrary renders by hitting ?w=1..2000
 */

import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import sharp from 'sharp';
import { query } from '../db.js';

const router = express.Router();

const CACHE_DIR = path.join(process.cwd(), 'uploads', 'email-cache');
const UPLOAD_ROOT = path.join(process.cwd(), 'uploads');

// 1200 covers a full-width 600px email at 2x; 700 covers the wine thumbnail.
// An allow-list rather than a range: an open width parameter is a cache-filling
// primitive, and two sizes is all the design actually uses.
const WIDTHS = new Set([700, 1200]);
const QUALITY = 78;

/** Which column on which table holds the source image. */
const SOURCES = {
  event:   { table: 'events',            column: 'image_url'  },
  product: { table: 'product.products',  column: 'images'     },
  recipe:  { table: 'recipes',           column: 'photo_path' },
};

/**
 * Resolve a record's source image to a path under uploads/.
 * Returns null rather than throwing — a missing image is a 404, not a 500.
 */
async function sourceFor(kind, id, companyId) {
  const src = SOURCES[kind];
  if (!src) return null;

  const r = await query(
    `SELECT ${src.column} AS img FROM ${src.table} WHERE id = $1
       ${companyId ? 'AND company_id = $2' : ''} LIMIT 1`,
    companyId ? [id, companyId] : [id]
  );
  let val = r.rows[0]?.img;
  if (!val) return null;

  // products.images is jsonb — take the first entry.
  if (typeof val === 'object') val = Array.isArray(val) ? val[0] : Object.values(val)[0];
  if (val && typeof val === 'object') val = val.url || val.path || val.src;
  if (!val || typeof val !== 'string') return null;

  // Only local uploads are derivable. A remote URL is returned as-is by the
  // caller instead; fetching arbitrary URLs server-side would turn this into
  // an SSRF hole reachable without authentication.
  if (/^https?:\/\//i.test(val)) return null;

  const rel = val.replace(/^\/+/, '').replace(/^uploads\//, '');
  const abs = path.resolve(UPLOAD_ROOT, rel);
  // Containment check: resolve() collapses any ../ before this comparison, so a
  // crafted value cannot climb out of uploads/.
  if (!abs.startsWith(UPLOAD_ROOT + path.sep)) return null;

  try { await fs.access(abs); } catch { return null; }
  return abs;
}

// ── GET /email-media/:kind/:id.jpg?w=1200 ────────────────────────────────────
router.get('/:kind/:id.jpg', async (req, res) => {
  try {
    const { kind, id } = req.params;
    const w = Number(req.query.w) || 1200;
    if (!WIDTHS.has(w)) return res.status(400).send('Unsupported width');
    if (!SOURCES[kind]) return res.status(404).send('Unknown kind');

    const abs = await sourceFor(kind, id, req.query.c || null);
    if (!abs) return res.status(404).send('No image');

    // Cache key includes the source's mtime, so replacing the underlying image
    // produces a new key rather than serving the previous crop forever.
    const stat = await fs.stat(abs);
    const key = crypto.createHash('sha1')
      .update(`${kind}:${id}:${w}:${stat.mtimeMs}`).digest('hex').slice(0, 20);
    const cached = path.join(CACHE_DIR, `${key}.jpg`);

    let buf;
    try {
      buf = await fs.readFile(cached);
    } catch {
      buf = await sharp(abs)
        .rotate()                                   // honour EXIF orientation
        .resize({ width: w, withoutEnlargement: true })
        .jpeg({ quality: QUALITY, progressive: true, mozjpeg: true })
        .toBuffer();
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.writeFile(cached, buf);
    }

    // Immutable: the key changes when the source does, so clients and the
    // recipient's mail proxy can hold onto this indefinitely.
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(buf);
  } catch (err) {
    console.error('email-media:', err.message);
    res.status(500).send('Image error');
  }
});

export { router as emailMediaRouter };
