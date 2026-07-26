/**
 * Import real photography from the existing WordPress site into kindred_web.media.
 * Shared by the Team UI ("Import from WordPress" button) and the CLI script.
 *
 * Uses the WP REST API so alt text + captions are preserved. AI-generated files
 * are excluded; ambiguous filenames land in the "needs-review" folder. Safe to
 * re-run — rows are de-duped by source_url.
 *
 * NETWORK NOTE: kindredvineyards.com is Cloudflare-proxied, and WP runs on THIS
 * same server. Connecting out to Cloudflare's edge from the origin hairpins and
 * times out (UND_ERR_CONNECT_TIMEOUT). So we connect straight to a local origin
 * IP (127.0.0.1 / the server IP), while keeping SNI + Host = the real domain so
 * TLS and the Apache vhost still resolve correctly. Override the connect IP with
 * WP_IMPORT_CONNECT_IP if needed.
 */
import path from 'path';
import fs from 'fs';
import https from 'node:https';
import { query } from '../db.js';
import { MEDIA_DIR, generateVariants, safeBase, isLikelyAI } from './mediaVariants.js';

const DEFAULT_WP_BASE = 'https://kindredvineyards.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36 KindredMediaImporter/1.0';

// Candidate local origin IPs, tried in order (skips Cloudflare entirely).
const CONNECT_IPS = process.env.WP_IMPORT_CONNECT_IP
  ? [process.env.WP_IMPORT_CONNECT_IP]
  : ['127.0.0.1', '65.181.116.57'];

/** GET over HTTPS, connecting to `connectIp` but presenting SNI/Host = url host. */
function httpsGet(urlStr, connectIp, extraHeaders = {}, timeoutMs = 20000, redirectsLeft = 2) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const req = https.request(
      {
        host: connectIp, // actual TCP target (local origin, not Cloudflare)
        servername: u.hostname, // SNI → correct cert + vhost
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { Host: u.hostname, 'User-Agent': UA, ...extraHeaders },
        rejectUnauthorized: false, // controlled, local connection to our own origin
        timeout: timeoutMs,
      },
      (res) => {
        // Follow same-site redirects (WP canonical http→https etc.).
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          const next = new URL(res.headers.location, urlStr).toString();
          return resolve(httpsGet(next, connectIp, extraHeaders, timeoutMs, redirectsLeft - 1));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }
    );
    req.on('timeout', () => req.destroy(new Error(`connect timeout to ${connectIp}:443`)));
    req.on('error', reject);
    req.end();
  });
}

// Probe the candidate IPs once and remember the first that answers.
let chosenIp = null;
async function ensureConnectIp(wpBase) {
  if (chosenIp) return chosenIp;
  const host = new URL(wpBase).hostname;
  const errors = [];
  for (const ip of CONNECT_IPS) {
    try {
      const r = await httpsGet(`${wpBase}/wp-json/`, ip, { Accept: 'application/json' }, 8000);
      if (r.status && r.status < 500) { chosenIp = ip; return ip; }
      errors.push(`${ip}→HTTP ${r.status}`);
    } catch (e) {
      errors.push(`${ip}→${e.message}`);
    }
  }
  throw new Error(`Could not reach ${host} from the server on any local IP (${errors.join('; ')}). Set WP_IMPORT_CONNECT_IP to the correct origin IP.`);
}

async function fetchAllMedia(wpBase) {
  const ip = await ensureConnectIp(wpBase);
  const items = [];
  for (let page = 1; page <= 100; page++) {
    const url = `${wpBase}/wp-json/wp/v2/media?per_page=100&page=${page}&media_type=image`;
    const res = await httpsGet(url, ip, { Accept: 'application/json' });
    if (res.status === 400 && page > 1) break; // past the last page
    if (res.status >= 400) {
      throw new Error(`WP media list page ${page} → HTTP ${res.status}: ${res.body.toString('utf8').slice(0, 160).replace(/\s+/g, ' ')}`);
    }
    const ct = res.headers['content-type'] || '';
    if (!ct.includes('json')) {
      throw new Error(`WP media list page ${page} → non-JSON (${ct}): ${res.body.toString('utf8').slice(0, 160).replace(/\s+/g, ' ')}`);
    }
    let batch;
    try { batch = JSON.parse(res.body.toString('utf8')); } catch { break; }
    if (!Array.isArray(batch) || !batch.length) break;
    items.push(...batch);
    const totalPages = Number(res.headers['x-wp-totalpages'] || 0);
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
 * @returns {Promise<object>} report
 */
export async function importWordpressMedia(opts = {}) {
  const { dryRun = false, wpBase = process.env.WP_IMPORT_BASE || DEFAULT_WP_BASE, companyId = null, onProgress } = opts;

  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const ip = await ensureConnectIp(wpBase);
  const media = await fetchAllMedia(wpBase);

  const report = { total: media.length, imported: 0, skippedAI: 0, needsReview: 0, alreadyHave: 0, failed: 0, firstError: null, dryRun };

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
      const dl = await httpsGet(src, ip);
      if (dl.status >= 400) throw new Error(`download HTTP ${dl.status}`);
      const buf = dl.body;

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
    } catch (e) {
      report.failed++;
      if (!report.firstError) report.firstError = `${origName}: ${e.message}`;
    }
    onProgress?.(report);
  }

  return report;
}
