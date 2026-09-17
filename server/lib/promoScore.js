/**
 * Promotion scoring for events — four dimensions plus a composite grade.
 *
 *   Reach    formula from channel coverage (basic vs premium)
 *   Timing   formula from how far ahead the event went on the calendar
 *   Image    AI vision judges the hero image (0–100 + a note)
 *   Message  AI judges the promo copy (0–100 + a note)
 *   Composite = Reach·0.35 + Timing·0.25 + Image·0.20 + Message·0.20
 *
 * Reach + Timing are cheap and recomputed on every read. Image + Message cost an
 * Anthropic call, so they are cached in event_promo_scores and refreshed on
 * demand. A missing Anthropic key degrades gracefully — the formula scores still
 * work; the AI dimensions come back null with a note.
 */
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { query } from '../db.js';

// Channels we always use vs the premium outlets for a wider net.
const BASIC = new Set(['website', 'app_push', 'google_business', 'facebook_event', 'instagram']);
export const SCORE_WEIGHTS = { reach: 0.35, timing: 0.25, image: 0.20, message: 0.20 };

function appBase() { return (process.env.APP_BASE_URL || 'https://team.kindredvineyards.com').replace(/\/$/, ''); }
const abs = (u) => !u ? null : (/^https?:\/\//i.test(u) ? u : `${appBase()}${u.startsWith('/') ? '' : '/'}${u}`);

function textOf(message) {
  return (message?.content || []).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim();
}
function parseScore(text, fallbackNote) {
  try {
    const j = JSON.parse((text.match(/\{[\s\S]*\}/) || [text])[0]);
    return { score: Math.max(0, Math.min(100, Math.round(Number(j.score) || 0))), note: String(j.note || fallbackNote || '').slice(0, 240) };
  } catch { return { score: 0, note: fallbackNote || 'Could not score.' }; }
}

// ── Formula dimensions ───────────────────────────────────────────────────────
async function channelClasses(companyId) {
  const rows = (await query(`SELECT key, enabled FROM promo_channels WHERE company_id = $1`, [companyId])).rows;
  const basic = [], premium = [];
  for (const r of rows) { if (!r.enabled) continue; (BASIC.has(r.key) ? basic : premium).push(r.key); }
  return { basic, premium };
}

export async function reachAndCoverage(companyId, eventId) {
  const { basic, premium } = await channelClasses(companyId);
  const posted = new Set((await query(
    `SELECT channel_key FROM event_channel_posts WHERE company_id = $1 AND event_id = $2 AND status = 'posted'`,
    [companyId, eventId]
  )).rows.map((r) => r.channel_key));
  const basicHit = basic.filter((k) => posted.has(k)).length;
  const premiumHit = premium.filter((k) => posted.has(k)).length;
  const basicTot = basic.length;
  const reach = Math.round((basicTot ? basicHit / basicTot : 0) * 70 + Math.min(premiumHit, 3) / 3 * 30);
  const flag = basicTot && basicHit < basicTot ? 'red' : (premiumHit === 0 ? 'ok' : 'gold');
  return { reach, flag, basicHit, basicTot, premiumHit, premiumTot: premium.length };
}

export function timingScore(weeks) {
  return weeks >= 12 ? 100 : weeks >= 8 ? 92 : weeks >= 6 ? 82 : weeks >= 4 ? 75 : weeks >= 3 ? 65 : weeks >= 2 ? 50 : weeks >= 1 ? 30 : 12;
}
function leadWeeks(ev) {
  if (!ev.start_at || !ev.created_at) return 0;
  return Math.max(0, (new Date(ev.start_at) - new Date(ev.created_at)) / (7 * 86400000));
}
function timingNote(weeks) {
  return weeks >= 12 ? `On the calendar ${Math.round(weeks)} weeks out — ideal runway.`
    : weeks >= 6 ? `${Math.round(weeks)} weeks of runway — good; aim for 12+.`
    : weeks >= 4 ? 'About a month of runway — a bit tight.'
    : 'Short runway — put events on the calendar earlier.';
}

// ── AI dimensions ────────────────────────────────────────────────────────────
async function aiScoreMessage(apiKey, ev) {
  const desc = String(ev.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!desc) return { score: 0, note: 'No description written yet.' };
  if (!apiKey) return { score: null, note: 'Add an Anthropic key in Settings to AI-score copy.' };
  try {
    const client = new Anthropic({ apiKey });
    const m = await client.messages.create({
      model: 'claude-haiku-4-5', max_tokens: 200,
      messages: [{ role: 'user', content: `You are a marketing editor scoring promo copy for a winery event. Title: "${ev.title || ''}". Copy: """${desc.slice(0, 1500)}""". Score 0-100 on clarity, a compelling hook, a clear call-to-action, and appropriate length. Return ONLY JSON: {"score": <int 0-100>, "note": "<one short sentence of feedback>"}` }],
    });
    return parseScore(textOf(m), 'Scored.');
  } catch (e) { return { score: null, note: `AI copy scoring failed: ${e.message}` }; }
}

// Fetch + downscale the hero image once, and compute a 16×16 average-hash for
// near-duplicate detection. Returns { jpeg, hash } or null.
async function prepImage(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = Buffer.from(await res.arrayBuffer());
    const base = sharp(raw).rotate();
    // Vision copy: Claude's optimal max edge, cheaper.
    const jpeg = await base.clone().resize(1568, 1568, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    // aHash: 16×16 grayscale, bit per pixel above the mean → 64-char hex.
    const { data } = await sharp(raw).rotate().grayscale().resize(16, 16, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
    let sum = 0; for (const v of data) sum += v;
    const avg = sum / data.length;
    let hex = '';
    for (let i = 0; i < data.length; i += 4) {
      let nib = 0; for (let b = 0; b < 4; b++) nib = (nib << 1) | (data[i + b] > avg ? 1 : 0);
      hex += nib.toString(16);
    }
    return { jpeg, hash: hex };
  } catch { return null; }
}
function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 999;
  let d = 0;
  for (let i = 0; i < a.length; i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { d += x & 1; x >>= 1; } }
  return d;
}
// "Sunset Music Series: Reid McIntire" → "sunset music series". Falls back to
// category + venue so any recurring pattern groups.
function seriesKey(ev) {
  const t = String(ev.title || '').split(':')[0].trim().toLowerCase();
  return t.length >= 4 ? t : `${(ev.category || '').toLowerCase()}|${ev.location_id || ''}`;
}

/**
 * Freshness: dock the image when a recurring series reuses the same artwork.
 * Compares this event's hash to recent same-series events' cached hashes.
 */
async function imageFreshness(companyId, ev, hash) {
  if (!hash) return { freshness: 100, reuse: 0, note: null };
  const key = seriesKey(ev);
  const rows = (await query(
    `SELECT e.title, e.category, e.location_id, s.image_hash
       FROM events e JOIN event_promo_scores s ON s.event_id = e.id
      WHERE e.company_id = $1 AND e.id <> $2 AND s.image_hash IS NOT NULL
      ORDER BY e.start_at DESC LIMIT 40`,
    [companyId, ev.id]
  )).rows;
  const recent = rows.filter((r) => seriesKey(r) === key).slice(0, 6);
  const reuse = recent.filter((r) => hamming(hash, r.image_hash) <= 12).length;
  const freshness = Math.max(25, 100 - 22 * reuse);
  if (!reuse) return { freshness, reuse, note: null };
  const label = ev.title ? String(ev.title).split(':')[0].trim() : 'this series';
  const feature = ev.musician_name
    ? ` — rotate it or feature ${ev.musician_name}${ev.musician_photo ? ' (their photo is on file)' : ''}.`
    : ' — rotate the artwork so the feed stays fresh.';
  return { freshness, reuse, note: `Same image as ${reuse} recent ${label} show${reuse === 1 ? '' : 's'}${feature}` };
}

async function aiImageQuality(apiKey, jpeg, ev) {
  if (!apiKey) return { score: null, note: 'Add an Anthropic key in Settings to AI-score images.' };
  try {
    const client = new Anthropic({ apiKey });
    const who = ev.musician_name ? ` The event features ${ev.musician_name}.` : '';
    const m = await client.messages.create({
      model: 'claude-sonnet-5', max_tokens: 220,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
        { type: 'text', text: `Score this event promo image 0-100 for a winery's website and social feeds: resolution/sharpness, composition, on-brand feel, and whether any overlaid text stays legible on a phone. Also weigh whether the event's specific performer/subject is the focus versus a generic reusable backdrop — for a recurring series a performer-forward image is worth more than a repeated scenic background.${who} Return ONLY JSON: {"score": <int 0-100>, "note": "<one short sentence of feedback>"}` },
      ] }],
    });
    return parseScore(textOf(m), 'Scored.');
  } catch (e) { return { score: null, note: `AI image scoring failed: ${e.message}` }; }
}

function composite(parts) {
  // Weighted blend; a null AI dimension is treated as 0 so an unscored/empty
  // event reads honestly low rather than being flattered by omission.
  const v = (x) => (typeof x === 'number' ? x : 0);
  return Math.round(v(parts.reach) * SCORE_WEIGHTS.reach + v(parts.timing) * SCORE_WEIGHTS.timing
    + v(parts.image) * SCORE_WEIGHTS.image + v(parts.message) * SCORE_WEIGHTS.message);
}
export const grade = (s) => s >= 90 ? 'A' : s >= 80 ? 'B' : s >= 70 ? 'C' : s >= 60 ? 'D' : 'F';

async function loadEvent(companyId, eventId) {
  return (await query(
    `SELECT e.id, e.title, e.description, e.start_at, e.created_at, e.category, e.location_id,
            e.image_url, e.social_image_url, e.fb_image_url,
            m.name AS musician_name, m.photo_url AS musician_photo
       FROM events e LEFT JOIN musicians m ON m.id = e.musician_id
      WHERE e.id = $1 AND e.company_id = $2`, [eventId, companyId]
  )).rows[0];
}

/** Cheap read: formula dimensions fresh + cached AI dimensions, no AI call. */
export async function getScore(companyId, eventId) {
  const ev = await loadEvent(companyId, eventId);
  if (!ev) return null;
  const rc = await reachAndCoverage(companyId, eventId);
  const wk = leadWeeks(ev);
  const timing = timingScore(wk);
  const cache = (await query(`SELECT image, message, image_note, message_note, scored_at FROM event_promo_scores WHERE event_id = $1`, [eventId])).rows[0];
  const parts = { reach: rc.reach, timing, image: cache?.image ?? null, message: cache?.message ?? null };
  return {
    ...parts, composite: composite(parts), grade: grade(composite(parts)),
    coverage: rc, timing_note: timingNote(wk),
    image_note: cache?.image_note || null, message_note: cache?.message_note || null,
    ai_scored: !!cache, scored_at: cache?.scored_at || null,
  };
}

/** Full re-score, including the AI dimensions. Caches the AI parts. */
export async function scoreEvent(companyId, eventId) {
  const ev = await loadEvent(companyId, eventId);
  if (!ev) throw Object.assign(new Error('Event not found'), { statusCode: 404 });
  const apiKey = (await query(`SELECT anthropic_api_key FROM company_integrations WHERE company_id = $1`, [companyId])).rows[0]?.anthropic_api_key || process.env.ANTHROPIC_API_KEY || null;

  const rc = await reachAndCoverage(companyId, eventId);
  const wk = leadWeeks(ev);
  const timing = timingScore(wk);

  // Image: quality (AI) capped by freshness (repetition penalty). A gorgeous but
  // recycled series image can't score high.
  const imgUrl = abs(ev.social_image_url || ev.image_url || ev.fb_image_url);
  let img = { score: 0, note: 'No hero image set. Add a 2400×1000 landscape.' };
  let imageHash = null;
  const [prepped, msg] = await Promise.all([imgUrl ? prepImage(imgUrl) : null, aiScoreMessage(apiKey, ev)]);
  if (imgUrl && !prepped) {
    img = { score: null, note: 'Could not load the image to score it.' };
  } else if (prepped) {
    imageHash = prepped.hash;
    const [ai, fresh] = await Promise.all([aiImageQuality(apiKey, prepped.jpeg, ev), imageFreshness(companyId, ev, imageHash)]);
    if (ai.score == null) {
      img = ai; // no key / error — surface as-is
    } else {
      const score = Math.min(ai.score, fresh.freshness);
      img = { score, note: (fresh.reuse && fresh.freshness <= ai.score) ? fresh.note : ai.note };
    }
  }

  const parts = { reach: rc.reach, timing, image: img.score, message: msg.score };
  const comp = composite(parts);

  await query(
    `INSERT INTO event_promo_scores (event_id, company_id, reach, timing, image, message, composite, coverage_flag, image_note, message_note, image_hash, scored_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
     ON CONFLICT (event_id) DO UPDATE SET
       reach=$3, timing=$4, image=$5, message=$6, composite=$7, coverage_flag=$8, image_note=$9, message_note=$10, image_hash=$11, scored_at=NOW()`,
    [eventId, companyId, rc.reach, timing, img.score, msg.score, comp, rc.flag, img.note, msg.note, imageHash]
  );
  return {
    ...parts, composite: comp, grade: grade(comp), coverage: rc, timing_note: timingNote(wk),
    image_note: img.note, message_note: msg.note, ai_scored: true, scored_at: new Date().toISOString(),
  };
}
