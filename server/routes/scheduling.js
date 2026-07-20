import express from 'express';
import { query } from '../db.js';

const router = express.Router();
const cId = (req) => req.companyId;

// ── helpers ──────────────────────────────────────────────────────────────────
const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dnum = (ds) => new Date(ds + 'T12:00:00').getDay();
function addDays(ds, n) {
  const d = new Date(ds + 'T12:00:00'); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
// Wed→Tue week: the week_start_dow (default 3=Wed) on/before the given date.
function weekStartOf(ds, dow = 3) {
  const diff = (dnum(ds) - dow + 7) % 7;
  return addDays(ds, -diff);
}
function todayISO() { return new Date().toISOString().slice(0, 10); }

async function ensureSettings(companyId) {
  await query(`INSERT INTO scheduling_settings (company_id) VALUES ($1) ON CONFLICT (company_id) DO NOTHING`, [companyId]);
  return (await query(`SELECT * FROM scheduling_settings WHERE company_id = $1`, [companyId])).rows[0];
}
async function getLocations(companyId) {
  return (await query(`SELECT id, name, square_location_id FROM locations WHERE company_id = $1 ORDER BY name`, [companyId])).rows;
}
// date → net_sales ($) per location, over [start,end]
async function netSalesMap(companyId, start, end) {
  const r = await query(
    `SELECT s.location_id, s.sales_date::text AS d, s.net_sales
       FROM team_square.v_square_net_sales_daily s
       JOIN locations l ON l.square_location_id = s.location_id AND l.company_id = $1
      WHERE s.sales_date BETWEEN $2 AND $3`, [companyId, start, end]);
  const m = {};
  for (const row of r.rows) ((m[row.location_id] ??= {})[row.d] = Number(row.net_sales));
  return m; // keyed by SQUARE location_id
}
// date → { cost, hours } per location
async function laborMap(companyId, start, end) {
  const r = await query(
    `SELECT v.location_id, v.work_date::text AS d, SUM(v.labor_cost) AS lcost, SUM(v.hours) AS lhours
       FROM team_square.v_labor_daily v
       JOIN locations l ON l.square_location_id = v.location_id AND l.company_id = $1
      WHERE v.work_date BETWEEN $2 AND $3
      GROUP BY 1,2`, [companyId, start, end]);
  const m = {};
  for (const row of r.rows) ((m[row.location_id] ??= {})[row.d] = { cost: Number(row.lcost), hours: Number(row.lhours) });
  return m;
}
const sum = (arr) => arr.reduce((a, b) => a + (b || 0), 0);

// ── settings ─────────────────────────────────────────────────────────────────
router.get('/settings', async (req, res) => {
  try { res.json(await ensureSettings(cId(req))); }
  catch (e) { console.error('scheduling settings', e); res.status(500).json({ error: e.message }); }
});

router.patch('/settings', async (req, res) => {
  const allowed = ['target_labor_pct', 'avoid_overtime', 'forecast_w_lastweek', 'forecast_w_lastyear',
    'labor_warn_threshold', 'feedback_prompt_enabled', 'max_hours_per_week'];
  const sets = [], vals = [];
  for (const k of allowed) if (k in req.body) { sets.push(`${k} = $${sets.length + 1}`); vals.push(req.body[k]); }
  if (!sets.length) return res.json(await ensureSettings(cId(req)));
  try {
    await ensureSettings(cId(req));
    vals.push(req.userId || null, cId(req));
    await query(`UPDATE scheduling_settings SET ${sets.join(', ')}, updated_at = NOW(), updated_by = $${vals.length - 1}
                 WHERE company_id = $${vals.length}`, vals);
    res.json((await query(`SELECT * FROM scheduling_settings WHERE company_id = $1`, [cId(req)])).rows[0]);
  } catch (e) { console.error('scheduling settings patch', e); res.status(500).json({ error: e.message }); }
});

// ── scoreboard: forecast + labor budget + day cards for a Wed–Tue week ────────
router.get('/scoreboard', async (req, res) => {
  try {
    const companyId = cId(req);
    const settings = await ensureSettings(companyId);
    const dow = settings.week_start_dow ?? 3;
    const weekStart = weekStartOf(req.query.week || todayISO(), dow);
    const weekEnd = addDays(weekStart, 6);
    const target = Number(settings.target_labor_pct);
    const wLast = Number(settings.forecast_w_lastweek), wYear = Number(settings.forecast_w_lastyear);
    const warn = Number(settings.labor_warn_threshold);
    const locs = await getLocations(companyId);

    // Load 400 days of history back from whichever is earlier — the week being viewed
    // or today — so the today-anchored growth window is always fully covered even for
    // future weeks (otherwise a later histStart clips its year-ago days).
    const rangeStart = weekStart < todayISO() ? weekStart : todayISO();
    const histStart = addDays(rangeStart, -400);
    const [net, labor] = [await netSalesMap(companyId, histStart, weekEnd), await laborMap(companyId, histStart, weekEnd)];

    const yearStart = new Date().getFullYear() + '-01-01';
    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

    // Prior-year post-shift feedback, indexed by location + MM-DD; summarized emphasis-weighted.
    const EMPHASIS_W = { 1: 0, 2: 0.2, 3: 0.3, 4: 0.4, 5: 0.5 };
    const fbRows = (await query(
      `SELECT work_date::text AS d, location_id, sentiment, staffing, note, emphasis
         FROM day_feedback WHERE company_id = $1 AND responded_at IS NOT NULL`, [companyId])).rows;
    const fbIndex = {};
    for (const r of fbRows) (fbIndex[r.location_id + '|' + r.d.slice(5)] ??= []).push(r);
    function summarizeFeedback(locId, dateStr) {
      const rows = (fbIndex[locId + '|' + dateStr.slice(5)] || []).filter((r) => r.d < weekStart);
      if (!rows.length) return null;
      let wNum = 0, wDen = 0, uNum = 0, uDen = 0;
      const staffW = { over: 0, right: 0, under: 0 }, staffU = { over: 0, right: 0, under: 0 };
      const comments = [];
      for (const r of rows) {
        const w = EMPHASIS_W[r.emphasis] ?? 0;
        if (r.sentiment) { wNum += r.sentiment * w; wDen += w; uNum += r.sentiment; uDen++; }
        if (r.staffing && staffW[r.staffing] != null) { staffW[r.staffing] += w; staffU[r.staffing]++; }
        if (r.note) comments.push({ note: r.note, emphasis: r.emphasis, sentiment: r.sentiment, year: r.d.slice(0, 4) });
      }
      const grade = wDen > 0 ? wNum / wDen : (uDen > 0 ? uNum / uDen : null);
      const staffScore = Object.values(staffW).some((v) => v > 0) ? staffW : staffU;
      const leanEntry = Object.entries(staffScore).sort((a, b) => b[1] - a[1])[0];
      comments.sort((a, b) => b.emphasis - a.emphasis);
      return {
        n: rows.length, years: [...new Set(rows.map((r) => r.d.slice(0, 4)))],
        grade: grade == null ? null : Math.round(grade * 10) / 10,
        staffing_lean: leanEntry && leanEntry[1] > 0 ? leanEntry[0] : null,
        comments: comments.slice(0, 6),
      };
    }

    const locationCards = [];
    for (const loc of locs) {
      const sid = loc.square_location_id;
      const nn = net[sid] || {}, ll = labor[sid] || {};
      // YoY growth run-rate: trailing 28 ACTUAL days vs the same calendar days last year.
      // Anchor on today (NOT weekStart) so forecasting future weeks doesn't deflate the
      // recent side with not-yet-happened days, and pair days so both sides cover the
      // same dates. Guard against sparse-data extremes.
      const anchor = todayISO();
      let rSum = 0, yaSum = 0;
      for (let i = 1; i <= 28; i++) {
        const rv = nn[addDays(anchor, -i)], yv = nn[addDays(anchor, -i - 364)];
        if (Number.isFinite(rv) && Number.isFinite(yv)) { rSum += rv; yaSum += yv; }
      }
      let growth = yaSum > 0 ? rSum / yaSum : 1;
      growth = Math.min(2, Math.max(0.5, growth));
      // blended wage: last 90 days
      let wc = 0, wh = 0;
      for (let i = 1; i <= 90; i++) { const e = ll[addDays(weekStart, -i)]; if (e) { wc += e.cost; wh += e.hours; } }
      const blendedWage = wh > 0 ? wc / wh : null;

      const dayCards = days.map((d) => {
        const lastWeek = nn[addDays(d, -7)];
        const lastYear = nn[addDays(d, -364)];
        let forecast = null;
        if (Number.isFinite(lastWeek) && Number.isFinite(lastYear)) forecast = wLast * lastWeek + wYear * lastYear * growth;
        else if (Number.isFinite(lastYear)) forecast = lastYear * growth;
        else if (Number.isFinite(lastWeek)) forecast = lastWeek;
        // day labor % from last year same date + last week same weekday (for the >50% warning)
        const lyLab = ll[addDays(d, -364)], lwLab = ll[addDays(d, -7)];
        const lyPct = (lyLab && lastYear) ? (lyLab.cost / lastYear) * 100 : null;
        const lwPct = (lwLab && lastWeek) ? (lwLab.cost / lastWeek) * 100 : null;
        const worstPct = Math.max(lyPct ?? 0, lwPct ?? 0);
        return {
          date: d, dow: DOW_NAMES[dnum(d)],
          forecast: forecast == null ? null : Math.round(forecast),
          last_week: Number.isFinite(lastWeek) ? Math.round(lastWeek) : null,
          last_year: Number.isFinite(lastYear) ? Math.round(lastYear) : null,
          ly_labor_pct: lyPct == null ? null : Math.round(lyPct),
          lw_labor_pct: lwPct == null ? null : Math.round(lwPct),
          warn_labor: worstPct >= warn ? Math.round(worstPct) : null,
          feedback: summarizeFeedback(loc.id, d),
        };
      });

      const forecastWeek = sum(dayCards.map((c) => c.forecast));
      const laborBudget = forecastWeek * target / 100;
      const targetHours = blendedWage ? laborBudget / blendedWage : null;

      // YTD labor % (this location) — sum ALL labor and ALL sales INDEPENDENTLY so labor
      // on closed-but-staffed days (no sales) is still counted, matching the canonical
      // v_labor_pct_daily / labor reports / Kindred AI. (Gating labor on sales-days
      // understated it, e.g. Winery 22% vs the correct 27%.)
      let ytdCost = 0, ytdSales = 0;
      for (const d of Object.keys(nn)) if (d >= yearStart && d <= todayISO()) ytdSales += nn[d];
      for (const d of Object.keys(ll)) if (d >= yearStart && d <= todayISO()) ytdCost += ll[d].cost;
      const ytdLaborPct = ytdSales > 0 ? (ytdCost / ytdSales) * 100 : null;
      // same week last year
      const lyWeekSales = sum(days.map((d) => nn[addDays(d, -364)]).filter(Number.isFinite));
      const lyWeekCost = sum(days.map((d) => ll[addDays(d, -364)]?.cost).filter(Number.isFinite));
      const lyWeekPct = lyWeekSales > 0 ? (lyWeekCost / lyWeekSales) * 100 : null;

      locationCards.push({
        location_id: loc.id, name: loc.name,
        forecast_week: Math.round(forecastWeek),
        labor_budget: Math.round(laborBudget),
        target_hours: targetHours == null ? null : Math.round(targetHours),
        target_labor_pct: target,
        blended_wage: blendedWage == null ? null : Math.round(blendedWage * 100) / 100,
        yoy_growth_pct: Math.round((growth - 1) * 1000) / 10,
        ytd_labor_pct: ytdLaborPct == null ? null : Math.round(ytdLaborPct * 10) / 10,
        last_year_week_sales: lyWeekSales ? Math.round(lyWeekSales) : null,
        last_year_week_labor_pct: lyWeekPct == null ? null : Math.round(lyWeekPct * 10) / 10,
        days: dayCards,
      });
    }

    // events + weather for the week (advisory panels), keyed to app location ids
    const events = (await query(
      `SELECT event_date::text AS date, location_id, title, performer, category, venue_name
         FROM kindred_events WHERE company_id = $1 AND event_date BETWEEN $2 AND $3
        ORDER BY event_date`, [companyId, weekStart, weekEnd])).rows;
    const weather = (await query(
      `SELECT wx_date::text AS date, location_id, temp_max, temp_min, precip_prob, condition, is_forecast
         FROM weather_daily WHERE company_id = $1 AND wx_date BETWEEN $2 AND $3`, [companyId, weekStart, weekEnd])).rows;

    res.json({
      week_start: weekStart, week_end: weekEnd, week_label: `${weekStart} → ${weekEnd} (Wed–Tue)`,
      settings: { target_labor_pct: target, avoid_overtime: settings.avoid_overtime, labor_warn_threshold: warn,
        forecast_w_lastweek: wLast, forecast_w_lastyear: wYear },
      locations: locationCards, events, weather,
    });
  } catch (e) { console.error('scheduling scoreboard', e); res.status(500).json({ error: e.message }); }
});

// ── factor correlation report ────────────────────────────────────────────────
router.get('/correlation', async (req, res) => {
  try {
    const companyId = cId(req);
    const locs = await getLocations(companyId);
    const bySid = Object.fromEntries(locs.map((l) => [l.square_location_id, l.name]));
    const idBySid = Object.fromEntries(locs.map((l) => [l.square_location_id, l.id]));
    const start = addDays(todayISO(), -730), end = todayISO();
    const net = await netSalesMap(companyId, start, end);

    // events keyed by app location_id → we need square id; map via locations
    const sidByAppId = Object.fromEntries(locs.map((l) => [l.id, l.square_location_id]));
    const evRows = (await query(
      `SELECT event_date::text AS d, location_id, performer FROM kindred_events
        WHERE company_id = $1 AND performer IS NOT NULL AND event_date BETWEEN $2 AND $3`,
      [companyId, start, end])).rows;
    const eventDay = new Set(); // sid|date has an event
    const perf = {}; // performer|sid
    for (const e of evRows) {
      const sid = sidByAppId[e.location_id]; if (!sid) continue;
      eventDay.add(sid + '|' + e.d);
    }
    // weekday baselines per location on non-event days
    const baseAcc = {};
    for (const sid of Object.keys(net)) for (const d of Object.keys(net[sid])) {
      if (eventDay.has(sid + '|' + d)) continue;
      const w = dnum(d); ((baseAcc[sid] ??= {})[w] ??= { s: 0, n: 0 });
      baseAcc[sid][w].s += net[sid][d]; baseAcc[sid][w].n++;
    }
    const baseline = (sid, w) => baseAcc[sid]?.[w]?.n ? baseAcc[sid][w].s / baseAcc[sid][w].n : null;
    for (const e of evRows) {
      const sid = sidByAppId[e.location_id]; if (!sid) continue;
      const s = net[sid]?.[e.d]; if (s == null) continue;
      const b = baseline(sid, dnum(e.d));
      const key = e.performer + '|' + sid;
      (perf[key] ??= { performer: e.performer, sid, nights: 0, s: 0, b: 0, nb: 0 });
      perf[key].nights++; perf[key].s += s; if (b != null) { perf[key].b += b; perf[key].nb++; }
    }
    const performers = Object.values(perf).filter((p) => p.nb > 0).map((p) => ({
      performer: p.performer, location: bySid[p.sid], nights: p.nights,
      avg: Math.round(p.s / p.nights), baseline: Math.round(p.b / p.nb),
      lift_pct: Math.round((p.s / p.nights / (p.b / p.nb) - 1) * 100),
    })).sort((a, b) => b.lift_pct - a.lift_pct);

    // day-of-week averages per location
    const dowRows = [];
    for (const sid of Object.keys(net)) {
      const acc = {};
      for (const d of Object.keys(net[sid])) { const w = dnum(d); (acc[w] ??= { s: 0, n: 0 }); acc[w].s += net[sid][d]; acc[w].n++; }
      for (let w = 0; w < 7; w++) if (acc[w]) dowRows.push({ location: bySid[sid], dow: DOW_NAMES[w], dow_num: w, avg: Math.round(acc[w].s / acc[w].n), n: acc[w].n });
    }

    // weather buckets (hot ≥95°F, rain) vs mild-dry, per location
    const wxRows = (await query(
      `SELECT w.wx_date::text AS d, l.square_location_id AS sid, w.temp_max, w.precip_prob
         FROM weather_daily w JOIN locations l ON l.id = w.location_id
        WHERE w.company_id = $1 AND NOT w.is_forecast`, [companyId])).rows;
    const wxAcc = {}; // sid → bucket → {s,n}
    for (const w of wxRows) {
      const s = net[w.sid]?.[w.d]; if (s == null) continue;
      const bucket = Number(w.temp_max) >= 95 ? 'hot95+' : (Number(w.precip_prob) >= 50 ? 'likely_rain' : 'mild_dry');
      ((wxAcc[w.sid] ??= {})[bucket] ??= { s: 0, n: 0 }); wxAcc[w.sid][bucket].s += s; wxAcc[w.sid][bucket].n++;
    }
    const weather = [];
    for (const sid of Object.keys(wxAcc)) for (const b of Object.keys(wxAcc[sid]))
      weather.push({ location: bySid[sid], bucket: b, avg: Math.round(wxAcc[sid][b].s / wxAcc[sid][b].n), n: wxAcc[sid][b].n });

    res.json({ performers, day_of_week: dowRows, weather, window: { start, end } });
  } catch (e) { console.error('scheduling correlation', e); res.status(500).json({ error: e.message }); }
});

export { router as schedulingRouter };
