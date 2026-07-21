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
    'labor_warn_threshold', 'feedback_prompt_enabled', 'max_hours_per_week',
    'talent_reminders_enabled', 'reminder_msg_month', 'reminder_msg_week', 'reminder_msg_day'];
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

// ════════════════ Schedule builder ════════════════
const TZ = 'America/Denver';
function computeGrowth(nn) {
  const anchor = todayISO(); let rSum = 0, yaSum = 0;
  for (let i = 1; i <= 28; i++) { const rv = nn[addDays(anchor, -i)], yv = nn[addDays(anchor, -i - 364)]; if (Number.isFinite(rv) && Number.isFinite(yv)) { rSum += rv; yaSum += yv; } }
  const g = yaSum > 0 ? rSum / yaSum : 1; return Math.min(2, Math.max(0.5, g));
}
function dayForecast(nn, d, wLast, wYear, growth) {
  const lw = nn[addDays(d, -7)], ly = nn[addDays(d, -364)];
  if (Number.isFinite(lw) && Number.isFinite(ly)) return wLast * lw + wYear * ly * growth;
  if (Number.isFinite(ly)) return ly * growth;
  if (Number.isFinite(lw)) return lw;
  return null;
}
async function roster(companyId) {
  const r = await query(
    `SELECT tm.id AS tmid, tm.given_name, tm.family_name, rw.role, rw.wage_cents
       FROM team_square.team_member tm
       LEFT JOIN LATERAL (
         SELECT mode() WITHIN GROUP (ORDER BY wage_title) AS role,
                AVG(wage_hourly_rate_amount) AS wage_cents
           FROM team_square.shift
          WHERE team_member_id = tm.id AND wage_title IS NOT NULL
            AND start_at > NOW() - INTERVAL '180 days'
       ) rw ON true
      WHERE tm.status = 'ACTIVE' AND tm.is_owner = false
      ORDER BY rw.role NULLS LAST, tm.given_name`);
  return r.rows.map((x) => ({
    tmid: x.tmid,
    name: [x.given_name, x.family_name].filter(Boolean).join(' ') || '(unnamed)',
    role: x.role || 'Staff',
    wage: x.wage_cents != null ? Math.round(Number(x.wage_cents)) / 100 : null,
  }));
}
async function getOrCreateDraft(companyId, locationId, weekStart, userId) {
  const r = await query(
    `INSERT INTO schedule_drafts (company_id, location_id, week_start, status, created_by)
     VALUES ($1,$2,$3,'draft',$4)
     ON CONFLICT (company_id, location_id, week_start) DO UPDATE SET updated_at = NOW()
     RETURNING *, (xmax = 0) AS just_created`, [companyId, locationId, weekStart, userId || null]);
  return r.rows[0];
}
// Seed a new draft from the ACTUAL published Square schedule for the SAME period (not a template).
async function seedDraftFromPublished(sid, draftId, periodStart, periodEnd) {
  const pub = (await query(
    `SELECT pub_team_member_id AS tmid, pub_job_id, pub_start_at, pub_end_at
       FROM team_square.scheduled_shift
      WHERE pub_location_id = $1 AND pub_is_deleted = false AND pub_start_at IS NOT NULL
        AND (pub_start_at AT TIME ZONE $2)::date BETWEEN $3 AND $4`,
    [sid, TZ, periodStart, periodEnd])).rows;
  for (const p of pub) {
    const jt = (await query(`SELECT job_title FROM team_square.team_member_job_assignment WHERE job_id = $1 LIMIT 1`, [p.pub_job_id])).rows[0]?.job_title || null;
    await query(
      `INSERT INTO schedule_draft_shifts (draft_id, square_team_member_id, square_job_id, job_title, start_at, end_at, source)
       VALUES ($1,$2,$3,$4,$5,$6,'published')`, [draftId, p.tmid, p.pub_job_id, jt, p.pub_start_at, p.pub_end_at]);
  }
  return pub.length;
}
const hrs = (s) => (new Date(s.end_at) - new Date(s.start_at)) / 3600000;

// GET /builder?location_id=&week_start=  — everything the grid needs
router.get('/builder', async (req, res) => {
  try {
    const companyId = cId(req);
    const settings = await ensureSettings(companyId);
    const dow = settings.week_start_dow ?? 3;
    const periodStart = weekStartOf(req.query.week_start || todayISO(), dow);
    const days = Array.from({ length: 14 }, (_, i) => addDays(periodStart, i));
    const periodEnd = days[13];
    const locs = await getLocations(companyId);
    if (!locs.length) return res.status(400).json({ error: 'No locations configured' });

    const rangeStart = periodStart < todayISO() ? periodStart : todayISO();
    const net = await netSalesMap(companyId, addDays(rangeStart, -400), periodEnd);
    const wLast = Number(settings.forecast_w_lastweek), wYear = Number(settings.forecast_w_lastyear);
    const today = todayISO();
    // COMBINED forecast across both locations: actual for elapsed days, forecast for the rest.
    const growthBy = {}; for (const l of locs) growthBy[l.square_location_id] = computeGrowth(net[l.square_location_id] || {});
    const forecast = {}, isActual = {}, modelForecast = {}, actualSales = {};
    for (const d of days) {
      let basis = 0, model = 0, act = 0, anyBasis = false, anyModel = false, anyAct = false;
      for (const l of locs) {
        const nn = net[l.square_location_id] || {};
        const m = dayForecast(nn, d, wLast, wYear, growthBy[l.square_location_id]);
        if (Number.isFinite(m)) { model += m; anyModel = true; }
        const a = (d < today && Number.isFinite(nn[d])) ? nn[d] : null;
        if (a != null) { act += a; anyAct = true; }
        const b = a != null ? a : m;
        if (Number.isFinite(b)) { basis += b; anyBasis = true; }
      }
      forecast[d] = anyBasis ? basis : null;         // budget basis: actual where available
      modelForecast[d] = anyModel ? model : null;    // pure model forecast (for accuracy)
      actualSales[d] = anyAct ? act : null;
      isActual[d] = anyAct && d < today;
    }
    // Actual labor SPENT per day (both locations, from timecards)
    const actualLabor = {};
    for (const r of (await query(
      `SELECT v.work_date::text AS d, SUM(v.labor_cost) AS lab
         FROM team_square.v_labor_daily v
         JOIN locations l ON l.square_location_id = v.location_id AND l.company_id = $1
        WHERE v.work_date BETWEEN $2 AND $3 GROUP BY 1`, [companyId, periodStart, periodEnd])).rows) {
      actualLabor[r.d] = Number(r.lab);
    }

    // A draft per location; shifts from both, each tagged with its location.
    const drafts = [];
    for (const l of locs) {
      const dr = await getOrCreateDraft(companyId, l.id, periodStart, req.userId);
      if (dr.just_created) await seedDraftFromPublished(l.square_location_id, dr.id, periodStart, periodEnd);
      drafts.push({ id: dr.id, location_id: l.id, location_name: l.name });
    }
    const shifts = (await query(
      `SELECT s.id, s.square_team_member_id AS tmid, s.square_job_id, s.job_title, s.start_at, s.end_at, s.source,
              d.location_id, l.name AS location_name, (s.start_at AT TIME ZONE $2)::date::text AS date
         FROM schedule_draft_shifts s JOIN schedule_drafts d ON d.id = s.draft_id JOIN locations l ON l.id = d.location_id
        WHERE s.draft_id = ANY($1) ORDER BY s.start_at`, [drafts.map((x) => x.id), TZ])).rows
      .map((s) => ({ ...s, hours: Math.round(hrs(s) * 10) / 10 }));

    const staff = await roster(companyId);

    // per-member hours per week (across both locations — overtime is cross-location)
    const wk = (await query(
      `SELECT s.square_team_member_id AS tmid,
              (s.start_at AT TIME ZONE $2)::date < $4 AS wk1,
              SUM(EXTRACT(EPOCH FROM (s.end_at - s.start_at))/3600.0) AS h
         FROM schedule_draft_shifts s JOIN schedule_drafts d ON d.id = s.draft_id
        WHERE d.company_id = $1 AND (s.start_at AT TIME ZONE $2)::date BETWEEN $3 AND $5
        GROUP BY 1,2`, [companyId, TZ, periodStart, addDays(periodStart, 7), periodEnd])).rows;
    const memberHours = {};
    for (const r of wk) { (memberHours[r.tmid] ??= { w1: 0, w2: 0 })[r.wk1 ? 'w1' : 'w2'] += Number(r.h); }

    res.json({
      period_start: periodStart, period_end: periodEnd, days,
      locations: locs.map((l) => ({ id: l.id, name: l.name })),
      drafts,
      forecast, is_actual: isActual, model_forecast: modelForecast, actual_sales: actualSales, actual_labor: actualLabor,
      today, shifts, roster: staff, member_hours: memberHours,
      settings: { target_labor_pct: Number(settings.target_labor_pct) },
    });
  } catch (e) { console.error('builder', e); res.status(500).json({ error: e.message }); }
});

// POST /builder/shift — add/update a shift  { draft_id, tmid, job_title, square_job_id, date, start, end }
router.post('/builder/shift', async (req, res) => {
  try {
    const { draft_id, tmid, job_title, square_job_id, date, start, end } = req.body || {};
    if (!draft_id || !tmid || !date || !start || !end) return res.status(400).json({ error: 'Missing fields' });
    const r = await query(
      `INSERT INTO schedule_draft_shifts (draft_id, square_team_member_id, square_job_id, job_title, start_at, end_at, source)
       VALUES ($1,$2,$3,$4, (($5||' '||$6)::timestamp AT TIME ZONE $8), (($5||' '||$7)::timestamp AT TIME ZONE $8), 'manual')
       RETURNING id`, [draft_id, tmid, square_job_id || null, job_title || null, date, start, end, TZ]);
    await query(`UPDATE schedule_drafts SET updated_at = NOW() WHERE id = $1`, [draft_id]);
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { console.error('builder shift', e); res.status(500).json({ error: e.message }); }
});

// DELETE /builder/shift/:id
router.delete('/builder/shift/:id', async (req, res) => {
  try { await query(`DELETE FROM schedule_draft_shifts WHERE id = $1`, [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /builder/fill-from-last — copy the last published Square week into BOTH
// locations' drafts (shifted +14 days). Body: { period_start }
router.post('/builder/fill-from-last', async (req, res) => {
  try {
    const companyId = cId(req);
    const { period_start } = req.body || {};
    const locs = await getLocations(companyId);
    let copied = 0, source = 0;
    for (const loc of locs) {
      const sid = loc.square_location_id;
      const draft = await getOrCreateDraft(companyId, loc.id, period_start, req.userId);
      const prior = (await query(
        `SELECT pub_team_member_id AS tmid, pub_job_id, pub_start_at, pub_end_at
           FROM team_square.scheduled_shift
          WHERE pub_location_id = $1 AND pub_is_deleted = false AND pub_start_at IS NOT NULL
            AND (pub_start_at AT TIME ZONE $2)::date BETWEEN $3 AND $4`,
        [sid, TZ, addDays(period_start, -14), addDays(period_start, -1)])).rows;
      source += prior.length;
      await query(`DELETE FROM schedule_draft_shifts WHERE draft_id = $1`, [draft.id]);
      for (const p of prior) {
        const start = new Date(new Date(p.pub_start_at).getTime() + 14 * 86400000).toISOString();
        const end = new Date(new Date(p.pub_end_at).getTime() + 14 * 86400000).toISOString();
        const jt = (await query(`SELECT job_title FROM team_square.team_member_job_assignment WHERE job_id = $1 LIMIT 1`, [p.pub_job_id])).rows[0]?.job_title || null;
        await query(
          `INSERT INTO schedule_draft_shifts (draft_id, square_team_member_id, square_job_id, job_title, start_at, end_at, source)
           VALUES ($1,$2,$3,$4,$5,$6,'scaled')`, [draft.id, p.tmid, p.pub_job_id, jt, start, end]);
        copied++;
      }
      await query(`UPDATE schedule_drafts SET updated_at = NOW() WHERE id = $1`, [draft.id]);
    }
    res.json({ ok: true, copied, source_shifts: source });
  } catch (e) { console.error('fill-from-last', e); res.status(500).json({ error: e.message }); }
});

// POST /builder/pull-from-square — refresh the draft from THIS period's currently
// published Square schedule (both locations). For the workflow where she still
// authors in Square and uses this as a forecasting view.
router.post('/builder/pull-from-square', async (req, res) => {
  try {
    const companyId = cId(req);
    const { period_start } = req.body || {};
    const periodEnd = addDays(period_start, 13);
    const locs = await getLocations(companyId);
    let copied = 0;
    for (const l of locs) {
      const draft = await getOrCreateDraft(companyId, l.id, period_start, req.userId);
      await query(`DELETE FROM schedule_draft_shifts WHERE draft_id = $1`, [draft.id]);
      copied += await seedDraftFromPublished(l.square_location_id, draft.id, period_start, periodEnd);
      await query(`UPDATE schedule_drafts SET updated_at = NOW() WHERE id = $1`, [draft.id]);
    }
    res.json({ ok: true, copied });
  } catch (e) { console.error('pull-from-square', e); res.status(500).json({ error: e.message }); }
});

// POST /builder/clear — empty both locations' drafts for the period (reset to blank).
router.post('/builder/clear', async (req, res) => {
  try {
    const companyId = cId(req);
    const { period_start } = req.body || {};
    if (addDays(period_start, 13) < todayISO()) {
      return res.status(400).json({ error: 'This pay period is in the past — clearing it would erase its planned-schedule history. Use “Pull from Square” to refresh instead.' });
    }
    const r = await query(
      `DELETE FROM schedule_draft_shifts WHERE draft_id IN
         (SELECT id FROM schedule_drafts WHERE company_id = $1 AND week_start = $2)`,
      [companyId, period_start]);
    await query(`UPDATE schedule_drafts SET updated_at = NOW() WHERE company_id = $1 AND week_start = $2`, [companyId, period_start]);
    res.json({ ok: true, cleared: r.rowCount });
  } catch (e) { console.error('clear', e); res.status(500).json({ error: e.message }); }
});

export { router as schedulingRouter };
