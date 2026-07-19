/**
 * Factor sync — keeps the Scheduling factor layer as LIVING data.
 * Runs daily (see startFactorSyncScheduler) and refreshes, per company:
 *   - our events + performers   (WordPress / The Events Calendar REST API)
 *   - weather                   (Open-Meteo: 16-day forecast; ERA5 archive for history)
 *   - local events              (external feeds — see syncLocalEvents; stub for now)
 * Journal (post-shift feedback) has its own time-of-day cadence and lives elsewhere.
 *
 * All sources are HTTPS and run from the prod box. Everything is upsert/idempotent.
 * Manual run:  DB_HOST=localhost node lib/factorSync.js [companyId]
 */
import { query } from '../db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// WordPress WAF blocks default fetch UA — present a browser UA.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const TZ = 'America/Denver';
const WCODE = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Fog', 51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle',
  56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Freezing rain', 71: 'Snow', 73: 'Snow', 75: 'Heavy snow',
  77: 'Snow grains', 80: 'Showers', 81: 'Showers', 82: 'Heavy showers',
  85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm',
};

// ── performer / category extraction ──────────────────────────────────────────
const NOISE = /^(the |a )?(sunset|music|series|live|background|final|kindred|creek|vineyard|thursday|night|nights|band|tba|tbd)\b/i;
function normName(s) {
  return s.replace(/\./g, ' ').replace(/\s+/g, ' ').trim().replace(/\s*21\+$/, '');
}
export function extractPerformer(title, descHtml) {
  const t = title || '';
  let m = t.match(/Series:\s*(.+?)\s*(?:@|21\+|$)/i) ||
          t.match(/(?:featuring|feat\.?|ft\.?|with)\s+(.+?)\s*(?:@|21\+|$)/i);
  if (m && m[1] && !NOISE.test(m[1].trim())) return normName(m[1]);
  const desc = (descHtml || '').replace(/<[^>]+>/g, ' ').replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ');
  m = desc.match(/brought to you by\s+([A-Za-z0-9&.'\- ]{2,40}?)(?:[.,!]|\s*\$|$)/i);
  if (m && m[1] && !NOISE.test(m[1].trim())) return normName(m[1]);
  return null;
}
function categorize(title, perf) {
  if (perf) return 'music_named';
  const t = title || '';
  if (/thursdays? at the creek|background live music/i.test(t)) return 'creek_live';
  if (/tasting|dinner|club|release|pickup|vertical|harvest|brunch|feast|paint|yoga|market/i.test(t)) return 'other';
  if (/music|live|sunset|concert|band|nights/i.test(t)) return 'music_unnamed';
  return 'other';
}
function matchLocation(venueName, locations) {
  const v = (venueName || '').toLowerCase();
  if (/creek/.test(v)) return locations.find((l) => /creek/i.test(l.name));
  if (/vineyard|winery/.test(v)) return locations.find((l) => /winery|vineyard/i.test(l.name));
  return null;
}
const strip = (h) => (h || '').replace(/<[^>]+>/g, ' ').replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim();

// ── our events (WordPress / The Events Calendar) ─────────────────────────────
export async function syncKindredEvents(company, opts = {}) {
  const base = (company.wordpress_url || '').replace(/\/$/, '');
  if (!base) return { skipped: 'no wordpress_url' };
  const locs = (await query(
    `SELECT id, name, square_location_id FROM locations WHERE company_id = $1`, [company.company_id])).rows;
  // Daily sync uses a rolling ±400-day window; an initial backfill passes startDate to reach all history.
  const start = opts.startDate || new Date(Date.now() - 400 * DAY_MS).toISOString().slice(0, 10);
  const end = opts.endDate || new Date(Date.now() + 400 * DAY_MS).toISOString().slice(0, 10);
  let page = 1, seen = 0, upserts = 0;
  while (page <= 30) {
    const url = `${base}/wp-json/tribe/events/v1/events?per_page=50&page=${page}&start_date=${start}&end_date=${end}`;
    let j;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) break;
      j = await res.json();
    } catch (e) { console.error('  events fetch failed p' + page + ':', e.message); break; }
    const events = j.events || [];
    if (events.length === 0) break;
    for (const e of events) {
      const evDate = (e.start_date || '').slice(0, 10);
      if (!evDate) continue;
      const venue = (e.venue && e.venue.venue) || null;
      const loc = matchLocation(venue, locs);
      const perf = extractPerformer(e.title, e.description);
      await query(
        `INSERT INTO kindred_events
           (company_id, location_id, source, source_id, event_date, start_at, end_at, title, performer, category, venue_name, raw_excerpt, synced_at)
         VALUES ($1,$2,'wordpress',$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
         ON CONFLICT (company_id, source, source_id, event_date) DO UPDATE SET
           location_id = EXCLUDED.location_id, start_at = EXCLUDED.start_at, end_at = EXCLUDED.end_at,
           title = EXCLUDED.title, performer = EXCLUDED.performer, category = EXCLUDED.category,
           venue_name = EXCLUDED.venue_name, raw_excerpt = EXCLUDED.raw_excerpt, synced_at = NOW()`,
        [company.company_id, loc?.id || null, String(e.id), evDate, e.start_date || null, e.end_date || null,
         e.title || null, perf, categorize(e.title, perf), venue, strip(e.excerpt || e.description).slice(0, 500)]);
      upserts++;
    }
    seen += events.length;
    if (events.length < 50) break;
    page++;
  }
  return { seen, upserts };
}

// ── weather (Open-Meteo) ─────────────────────────────────────────────────────
async function weatherLocations(companyId) {
  return (await query(
    `SELECT l.id, l.name, sl.latitude AS lat, sl.longitude AS lon
       FROM locations l JOIN team_square.location sl ON sl.id = l.square_location_id
      WHERE l.company_id = $1 AND sl.latitude IS NOT NULL AND sl.longitude IS NOT NULL`,
    [companyId])).rows;
}
async function upsertWeatherDaily(companyId, locId, daily, isForecast) {
  if (!daily || !daily.time) return 0;
  let n = 0;
  for (let i = 0; i < daily.time.length; i++) {
    const code = daily.weather_code?.[i];
    await query(
      `INSERT INTO weather_daily
         (company_id, location_id, wx_date, temp_max, temp_min, precip_prob, precip_sum, weather_code, condition, is_forecast, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       ON CONFLICT (company_id, location_id, wx_date) DO UPDATE SET
         temp_max = EXCLUDED.temp_max, temp_min = EXCLUDED.temp_min, precip_prob = EXCLUDED.precip_prob,
         precip_sum = EXCLUDED.precip_sum, weather_code = EXCLUDED.weather_code, condition = EXCLUDED.condition,
         is_forecast = EXCLUDED.is_forecast, synced_at = NOW()`,
      [companyId, locId, daily.time[i],
       daily.temperature_2m_max?.[i] ?? null, daily.temperature_2m_min?.[i] ?? null,
       daily.precipitation_probability_max?.[i] ?? null, daily.precipitation_sum?.[i] ?? null,
       code ?? null, code != null ? (WCODE[code] || 'code ' + code) : null, isForecast]);
    n++;
  }
  return n;
}
export async function syncWeather(company) {
  const locs = await weatherLocations(company.company_id);
  let forecast = 0;
  for (const loc of locs) {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}`
        + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum`
        + `&temperature_unit=fahrenheit&timezone=${encodeURIComponent(TZ)}&forecast_days=16`;
      const j = await (await fetch(url)).json();
      forecast += await upsertWeatherDaily(company.company_id, loc.id, j.daily, true);
    } catch (e) { console.error('  weather forecast failed', loc.name, e.message); }
  }
  return { locations: locs.length, forecastDays: forecast };
}
// One-time / occasional historical backfill (ERA5 archive). Bounded, idempotent.
export async function backfillWeatherHistory(company, startDate = '2023-04-01') {
  const locs = await weatherLocations(company.company_id);
  const end = new Date(Date.now() - 6 * DAY_MS).toISOString().slice(0, 10); // archive lags ~5 days
  let rows = 0;
  for (const loc of locs) {
    try {
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${loc.lat}&longitude=${loc.lon}`
        + `&start_date=${startDate}&end_date=${end}`
        + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum`
        + `&temperature_unit=fahrenheit&timezone=${encodeURIComponent(TZ)}`;
      const j = await (await fetch(url)).json();
      rows += await upsertWeatherDaily(company.company_id, loc.id, j.daily, false);
    } catch (e) { console.error('  weather backfill failed', loc.name, e.message); }
  }
  return { locations: locs.length, historyDays: rows };
}

// ── local events (external feeds) ────────────────────────────────────────────
// TODO(next): Indian Creek Plaza / Destination Caldwell + Boise/Nampa ticketed feed.
// Advisory-only; stored in kindred_events with source='local' once implemented.
export async function syncLocalEvents(_company) {
  return { skipped: 'not yet implemented' };
}

// ── orchestration ────────────────────────────────────────────────────────────
async function companiesToSync() {
  // Companies with a Square integration; join their (optional) scheduling settings.
  return (await query(
    `SELECT ci.company_id,
            ss.wordpress_url,
            ss.event_feeds
       FROM company_integrations ci
       LEFT JOIN scheduling_settings ss ON ss.company_id = ci.company_id
      WHERE ci.square_access_token IS NOT NULL`)).rows;
}
export async function runFactorSync() {
  const companies = await companiesToSync();
  for (const c of companies) {
    try {
      const ev = await syncKindredEvents(c);
      const wx = await syncWeather(c);
      await syncLocalEvents(c);
      await query(`UPDATE scheduling_settings SET factor_synced_at = NOW() WHERE company_id = $1`, [c.company_id]);
      console.log(`  factorSync ${c.company_id}: events`, ev, 'weather', wx);
    } catch (e) {
      console.error('  factorSync failed for', c.company_id, e.message);
    }
  }
  return companies.length;
}

let started = false;
export function startFactorSyncScheduler() {
  if (started) return;
  started = true;
  const run = () => runFactorSync().catch((e) => console.error('factorSync loop failed:', e.message));
  setTimeout(run, 45 * 1000);   // warm up shortly after boot
  setInterval(run, DAY_MS);     // then daily
  console.log('Factor sync scheduler started (daily).');
}

// Manual entrypoint
if (process.argv[1]?.endsWith('factorSync.js')) {
  (async () => {
    const companyId = process.argv[2];
    if (companyId) {
      const rows = await companiesToSync();
      const c = rows.find((r) => r.company_id === companyId) || { company_id: companyId };
      if (!c.wordpress_url) {
        const s = (await query(`SELECT wordpress_url, event_feeds FROM scheduling_settings WHERE company_id=$1`, [companyId])).rows[0];
        Object.assign(c, s || {});
      }
      console.log('events (full history):', await syncKindredEvents(c, { startDate: '2023-01-01' }));
      console.log('weather forecast:', await syncWeather(c));
      console.log('weather history:', await backfillWeatherHistory(c));
    } else {
      console.log('synced companies:', await runFactorSync());
    }
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
