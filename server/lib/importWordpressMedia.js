/**
 * Import real photography from the existing WordPress site into kindred_web.media.
 * Shared by the Team UI ("Import from WordPress" button) and the CLI script.
 *
 * Uses the WP REST API so alt text + captions are preserved. AI-generated files
 * are excluded; ambiguous filenames land in the "needs-review" folder. Safe to
 * re-run — rows are de-duped by source_url.
 */
import path from 'path';
import fs from 'fs';
import { query } from '../db.js';
import { MEDIA_DIR, generateVariants, safeBase, isLikelyAI } from './mediaVariants.js';

const DEFAULT_WP_BASE = 'https://kindredvineyards.com';

async function fetchAllMedia(wpBase) {
  const items = [];
  for (let page = 1; page <= 100; page++) {
    const url = `${wpBase}/wp-json/wp/v2/media?per_page=100&page=${page}&media_type=image`;
    const res = await fetch(url);
    if (res.status === 400) break; // WP returns 400 for pages past the end
    if (!res.ok) break;
    const batch = await res.json();
    if (!Array.isArray(batch) || !batch.length) break;
    items.push(...batch);
    const totalPages = Number(res.headers.get('x-wp-totalpages') || 0);
    if (totalPages && page >= totalPages) break;
  }
  return items;
}

// library (real) | needs-review (ambiguous) | skip-ai (excluded)
function classify(name) {
  if (isLikelyAI(name)) return 'skip-ai';
  const base = name.replace(/\.[^.]+$/, '');
  if (/^(img[-_]?\d+|image\d*|untitled|screenshot.*|photo[-_]?\d+|\d{6,}|[a-f0-9]{8,})$/i.test(base)) return 'needs-review';
  return 'library';
}

const stripHtml = (s) => (s || '').replace(/<[^>]+>/g, '').trim() || null;

/**
 * @param {object} opts
 * @param {boolean} [opts.dryRun]      list actions without writing
 * @param {string}  [opts.wpBase]      WordPress base URL
 * @param {string}  [opts.companyId]   tag imported rows with a company id
 * @param {function}[opts.onProgress]  called with the running report after each item
 * @returns {Promise<object>} report { total, imported, skippedAI, needsReview, alreadyHave, failed, dryRun }
 */
export async function importWordpressMedia(opts = {}) {
  const { dryRun = false, wpBase = process.env.WP_IMPORT_BASE || DEFAULT_WP_BASE, companyId = null, onProgress } = opts;

  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const media = await fetchAllMedia(wpBase);

  const report = { total: media.length, imported: 0, skippedAI: 0, needsReview: 0, alreadyHave: 0, failed: 0, dryRun };

  for (const m of media) {
    const src = m.source_url;
    if (!src) continue;
    const origName = path.basename(new URL(src).pathname);

    const exists = await query(`SELECT id FROM kindred_web.media WHERE source_url = $1`, [src]);
    if (exists.rows.length) { report.alreadyHave++; onProgress?.(report); continue; }

    const verdict = classify(origName);
    if (verdict === 'skip-ai') { report.skippedAI++; onProgress?.(report); continue; }
    const folder = verdict === 'needs-review' ? 'needs-review' : 'library';

    if (dryRun) {
      report.imported++;
      if (folder === 'needs-review') report.needsReview++;
      onProgress?.(report);
      continue;
    }

    try {
      const dl = await fetch(src);
      if (!dl.ok) throw new Error(`download HTTP ${dl.status}`);
      const buf = Buffer.from(await dl.arrayBuffer());

      const ext = path.extname(origName).toLowerCase() || '.jpg';
      const filename = `${safeBase(origName)}-${Date.now()}${ext}`;
      fs.writeFileSync(path.join(MEDIA_DIR, filename), buf);

      const { original, variants, width, height } = await generateVariants(path.join(MEDIA_DIR, filename), filename);

      await query(
        `INSERT INTO kindred_web.media
           (filename, original_name, url, mime, width, height, size_bytes,
            alt_text, caption, folder, variants, source, source_url, company_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'imported',$12,$13)`,
        [filename, origName, original.url, m.mime_type || null, width, height, buf.length,
         stripHtml(m.alt_text), stripHtml(m.caption?.rendered), folder,
         variants ? JSON.stringify(variants) : null, src, companyId]
      );
      report.imported++;
      if (folder === 'needs-review') report.needsReview++;
    } catch {
      report.failed++;
    }
    onProgress?.(report);
  }

  return report;
}
