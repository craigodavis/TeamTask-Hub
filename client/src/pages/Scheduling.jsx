import { useState, useEffect, useCallback } from 'react';
import { getSchedulingScoreboard, getSchedulingCorrelation, getSchedulingSettings, updateSchedulingSettings } from '../api';

const money = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString());
const pct = (n) => (n == null ? '—' : Number(n).toFixed(1) + '%');
const fbFace = (g) => (g == null ? '—' : g >= 2.5 ? '🙂' : g >= 1.75 ? '😐' : '🙁');

function Info({ t, align = 'left' }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const h = () => setOpen(false);
    document.addEventListener('click', h);
    return () => document.removeEventListener('click', h);
  }, [open]);
  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        aria-label="More info"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        style={{ cursor: 'pointer', border: 'none', background: 'none', color: 'inherit', opacity: open ? 0.9 : 0.5, marginLeft: 4, fontSize: 13, padding: 0, lineHeight: 1, verticalAlign: 'middle' }}
      >ⓘ</button>
      {open && (
        <span
          onClick={(e) => { e.stopPropagation(); setOpen(false); }}
          style={{ position: 'absolute', zIndex: 100, top: '140%', [align === 'right' ? 'right' : 'left']: 0, width: 'min(320px, 84vw)',
            background: '#1f2430', color: '#fff', padding: '10px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 400,
            boxShadow: '0 6px 20px rgba(0,0,0,.28)', lineHeight: 1.5, textAlign: 'left', whiteSpace: 'pre-line' }}
        >{t}</span>
      )}
    </span>
  );
}
const card = { background: 'var(--card-bg, #fff)', border: '1px solid var(--border, #e3e3e3)', borderRadius: 10, padding: 16 };
const chip = (bg, fg) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 12, fontSize: 12, fontWeight: 600, background: bg, color: fg });

function addDays(ds, n) { const d = new Date(ds + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

export default function Scheduling() {
  const [tab, setTab] = useState('scoreboard');
  return (
    <div style={{ padding: 20, maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ margin: '0 0 4px' }}>📅 Scheduling</h1>
      <p style={{ marginTop: 0, opacity: 0.7 }}>Forecast-driven labor planning for the Wed–Tue week. Deterministic engine; every number has an ⓘ.</p>
      <div style={{ display: 'flex', gap: 8, margin: '14px 0 18px', flexWrap: 'wrap' }}>
        {[['scoreboard', 'Scoreboard'], ['correlation', 'What drives revenue'], ['settings', 'Settings']].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            style={{ padding: '7px 14px', borderRadius: 20, border: '1px solid var(--border,#ddd)', cursor: 'pointer',
              background: tab === k ? 'var(--accent,#4f46e5)' : 'transparent', color: tab === k ? '#fff' : 'inherit', fontWeight: 600 }}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'scoreboard' && <Scoreboard />}
      {tab === 'correlation' && <Correlation />}
      {tab === 'settings' && <Settings />}
    </div>
  );
}

function Scoreboard() {
  const [week, setWeek] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (w) => {
    setLoading(true); setErr('');
    try { const d = await getSchedulingScoreboard(w); setData(d); setWeek(d.week_start); }
    catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(''); }, [load]);

  if (loading && !data) return <p>Loading…</p>;
  if (err) return <p style={{ color: 'crimson' }}>{err}</p>;
  if (!data) return null;

  const evByDay = {}, wxByDay = {};
  for (const e of data.events) (evByDay[e.location_id + '|' + e.date] ??= []).push(e);
  for (const w of data.weather) wxByDay[w.location_id + '|' + w.date] = w;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <button onClick={() => load(addDays(data.week_start, -7))} style={navBtn}>← Prev</button>
        <strong>{data.week_label}</strong>
        <button onClick={() => load(addDays(data.week_start, 7))} style={navBtn}>Next →</button>
        {loading && <span style={{ opacity: 0.5 }}>…</span>}
      </div>

      {data.locations.map((loc) => {
        const overTarget = loc.ytd_labor_pct != null && loc.ytd_labor_pct > loc.target_labor_pct;
        return (
          <div key={loc.location_id} style={{ ...card, marginBottom: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
              <h3 style={{ margin: 0 }}>{loc.name}</h3>
              <span style={chip(overTarget ? '#fde2e2' : '#e2f7e6', overTarget ? '#a11' : '#137a2f')}>
                YTD labor {pct(loc.ytd_labor_pct)} vs {pct(loc.target_labor_pct)} target
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, margin: '14px 0' }}>
              <Stat label="Forecast sales" val={money(loc.forecast_week)} info={`Each day = ${data.settings.forecast_w_lastweek}×(last week, same weekday) + ${data.settings.forecast_w_lastyear}×(same week last year × YoY growth), summed Wed–Tue. YoY growth = trailing 28 days vs the same 28 days last year. Closed days (no history that weekday) show —. Weights are editable in Settings.`} />
              <Stat label="Labor budget" val={money(loc.labor_budget)} info={`Forecast × target labor % (${pct(loc.target_labor_pct)}).`} />
              <Stat label="Target hours" val={loc.target_hours == null ? '—' : loc.target_hours + ' h'} info={`Labor budget ÷ blended wage (${money(loc.blended_wage)}/h).`} />
              <Stat label="YoY growth" val={(loc.yoy_growth_pct >= 0 ? '+' : '') + loc.yoy_growth_pct + '%'} info="Trailing 28 days vs the same 28 days last year (POS sales)." />
              <Stat label="Last year, this week" val={money(loc.last_year_week_sales)} info={`Labor % that week: ${pct(loc.last_year_week_labor_pct)}.`} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 6 }}>
              {loc.days.map((d, di) => {
                const evs = evByDay[loc.location_id + '|' + d.date] || [];
                const wx = wxByDay[loc.location_id + '|' + d.date];
                const gy = loc.yoy_growth_pct;
                const warnThresh = data.settings.labor_warn_threshold;
                const lines = [
                  `Forecast for ${d.dow} ${d.date}`,
                  `• last week (same weekday): ${d.last_week == null ? 'no data yet' : money(d.last_week)}`,
                  `• last year (same weekday): ${d.last_year == null ? 'no data' : money(d.last_year) + ` × ${gy >= 0 ? '+' : ''}${gy}% YoY`}`,
                  `→ forecast ${money(d.forecast)}`,
                  `Music booked: ${evs.length ? evs.map((e) => e.performer || e.title?.slice(0, 20)).join(', ') : 'none'}`,
                  `The forecast is historical only — it does NOT yet add a lift for booked music (that's the learned-score phase). A slow, music-free ${d.dow} looks slow here.`,
                ];
                if (d.warn_labor) {
                  const basis = (d.ly_labor_pct != null && d.ly_labor_pct >= warnThresh)
                    ? `${d.ly_labor_pct}% last year` : `${d.lw_labor_pct}% last week`;
                  lines.push(`⚠ Labor warning: a comparable ${d.dow} ran ${basis} labor (over your ${warnThresh}% threshold). Cut staff that day, or drive traffic — e.g. book an act.`);
                }
                if (d.feedback) {
                  const fb = d.feedback;
                  lines.push(`— Crew feedback, same date ${fb.years.join('/')} (${fb.n} response${fb.n === 1 ? '' : 's'}) —`);
                  lines.push(`Grade ${fbFace(fb.grade)}${fb.grade != null ? ` (${fb.grade}/3)` : ''} · staffing: ${fb.staffing_lean || '—'} (emphasis-weighted)`);
                  fb.comments.forEach((c) => lines.push(`  ${'★'.repeat(c.emphasis)} "${c.note}"`));
                }
                return (
                  <div key={d.date} style={{ border: '1px solid var(--border,#eee)', borderRadius: 8, padding: 8, fontSize: 12, borderLeft: d.warn_labor ? '3px solid #d33' : '1px solid var(--border,#eee)' }}>
                    <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span>{d.dow} <span style={{ opacity: 0.5, fontWeight: 400 }}>{d.date.slice(5)}</span></span>
                      <Info t={lines.join('\n')} align={di >= 4 ? 'right' : 'left'} />
                    </div>
                    <div style={{ margin: '4px 0', fontSize: 14 }}>{money(d.forecast)}</div>
                    {wx && <div style={{ opacity: 0.7 }}>{Math.round(wx.temp_max)}°/{Math.round(wx.temp_min)}° {wx.condition || ''}{wx.precip_prob >= 40 ? ` ☔${wx.precip_prob}%` : ''}</div>}
                    {evs.map((e, i) => <div key={i} style={{ marginTop: 3, color: 'var(--accent,#4f46e5)' }}>🎵 {e.performer || e.title?.slice(0, 22)}</div>)}
                    {d.warn_labor && <div style={{ marginTop: 3, color: '#d33', fontWeight: 600 }}>⚠ {d.warn_labor}% labor — close or drive business</div>}
                    {d.feedback && <div style={{ marginTop: 3, opacity: 0.8 }}>📝 {fbFace(d.feedback.grade)} {d.feedback.staffing_lean || ''} ({d.feedback.n})</div>}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <p style={{ opacity: 0.6, fontSize: 13 }}>Draft builder + owner-approval publish to Square are the next phase. Events & weather here are advisory.</p>
    </div>
  );
}

function Stat({ label, val, info }) {
  return (
    <div>
      <div style={{ fontSize: 12, opacity: 0.65 }}>{label}<Info t={info} /></div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{val}</div>
    </div>
  );
}
const navBtn = { padding: '5px 12px', borderRadius: 8, border: '1px solid var(--border,#ddd)', background: 'transparent', cursor: 'pointer' };

function Correlation() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { getSchedulingCorrelation().then(setData).catch((e) => setErr(e.message)); }, []);
  if (err) return <p style={{ color: 'crimson' }}>{err}</p>;
  if (!data) return <p>Loading…</p>;
  return (
    <div>
      <div style={{ ...card, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Performer lift <Info t={`How it's computed:
For each performer we take the actual POS net sales on every night they played, and compare it to a baseline — the average sales on that SAME weekday and location, on days with NO event. Lift = their avg ÷ baseline − 1.
So a Friday act is measured against a typical music-free Friday (day-of-week is controlled for).

Trust it as directional, not exact:
• Correlation, not causation — weather, holidays and season on their nights are NOT subtracted out yet, so a band that happened to play perfect Saturdays looks better than it is.
• Small samples (1–2 nights) are noisy and firm up as they play more.
• The baseline excludes all event days, so "a normal Friday" is built from your music-free Fridays only.

Coming next: a learned score that controls for weather/holiday/season so the number reflects the performer, not their luck.`} /></h3>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead><tr style={{ textAlign: 'left', opacity: 0.6 }}><th>Performer</th><th>Location</th><th>Nights</th><th>Avg/night</th><th>Baseline</th><th>Lift</th></tr></thead>
          <tbody>
            {data.performers.map((p, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--border,#eee)' }}>
                <td style={{ padding: '5px 0' }}>{p.performer}</td><td>{p.location}</td><td>{p.nights}</td>
                <td>{money(p.avg)}</td><td>{money(p.baseline)}</td>
                <td style={{ fontWeight: 700, color: p.lift_pct >= 0 ? '#137a2f' : '#a11' }}>{(p.lift_pct >= 0 ? '+' : '') + p.lift_pct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 16 }}>
        <div style={card}>
          <h3 style={{ marginTop: 0 }}>By day of week <Info t={`Plain average of POS net sales for each weekday at each location, over the last ~2 years (all days, events included).
This is your weekly rhythm — the backbone the forecast leans on before any performer/weather/holiday adjustment.`} /></h3>
          <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
            <tbody>{data.day_of_week.sort((a, b) => a.location.localeCompare(b.location) || a.dow_num - b.dow_num).map((r, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--border,#eee)' }}><td style={{ padding: '4px 0' }}>{r.location}</td><td>{r.dow}</td><td style={{ textAlign: 'right' }}>{money(r.avg)}</td></tr>
            ))}</tbody>
          </table>
        </div>
        <div style={card}>
          <h3 style={{ marginTop: 0 }}>By weather <Info t={`Average POS net sales grouped by that day's weather at each location:
• hot95+ = daytime high ≥ 95°F
• likely_rain = ≥ 50% chance of precip
• mild_dry = everything else
Directional only — these buckets are NOT yet weekday- or season-adjusted, so treat gaps as a hint, not proof.`} /></h3>
          <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
            <tbody>{data.weather.map((r, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--border,#eee)' }}><td style={{ padding: '4px 0' }}>{r.location}</td><td>{r.bucket}</td><td style={{ textAlign: 'right' }}>{money(r.avg)} <span style={{ opacity: 0.5 }}>({r.n})</span></td></tr>
            ))}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Settings() {
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { getSchedulingSettings().then(setS).catch((e) => setErr(e.message)); }, []);
  if (err) return <p style={{ color: 'crimson' }}>{err}</p>;
  if (!s) return <p>Loading…</p>;
  const save = async (patch) => {
    try { const next = await updateSchedulingSettings(patch); setS(next); setSaved(true); setTimeout(() => setSaved(false), 1500); }
    catch (e) { setErr(e.message); }
  };
  const num = (k, label, info, step = '0.5') => (
    <label style={{ display: 'block', margin: '12px 0' }}>
      <div style={{ fontSize: 13, opacity: 0.7 }}>{label}<Info t={info} /></div>
      <input type="number" step={step} defaultValue={s[k]} onBlur={(e) => save({ [k]: Number(e.target.value) })}
        style={{ padding: 8, borderRadius: 8, border: '1px solid var(--border,#ddd)', width: 140 }} />
    </label>
  );
  return (
    <div style={{ ...card, maxWidth: 520 }}>
      {num('target_labor_pct', 'Target labor %', 'Goal applied to forecast sales to set the labor budget.')}
      {num('labor_warn_threshold', 'Labor % warning threshold', 'Days whose labor % (last year or last week) exceeds this get a "close or drive business" flag.')}
      {num('forecast_w_lastweek', 'Forecast weight — last week', 'Weight on last week (same weekday). Pairs with last-year weight; keep them summing to 1.', '0.05')}
      {num('forecast_w_lastyear', 'Forecast weight — last year', 'Weight on same week last year (scaled by YoY growth).', '0.05')}
      {num('max_hours_per_week', 'Max hours / week per employee', 'Cap used by the draft builder (next phase).', '1')}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0' }}>
        <input type="checkbox" defaultChecked={s.avoid_overtime} onChange={(e) => save({ avoid_overtime: e.target.checked })} />
        <span>Avoid overtime<Info t="Cap anyone approaching 40h in the Wed–Tue workweek (used by the draft builder)." /></span>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0' }}>
        <input type="checkbox" defaultChecked={s.feedback_prompt_enabled} onChange={(e) => save({ feedback_prompt_enabled: e.target.checked })} />
        <span>Post-shift feedback prompt<Info t="SMS + PIN survey to that day's workers after close. Off while we build." /></span>
      </label>
      {saved && <span style={chip('#e2f7e6', '#137a2f')}>✓ saved</span>}
    </div>
  );
}
