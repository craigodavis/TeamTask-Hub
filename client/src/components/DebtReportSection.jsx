import React, { useState, useEffect, useCallback } from 'react';
import { getDebtReport, postDebtBalancesBulk, putDebtCeiling } from '../api';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function seriesToDraft(series) {
  return (series || []).map((cell) =>
    cell?.ending_balance != null && !Number.isNaN(Number(cell.ending_balance))
      ? String(cell.ending_balance)
      : ''
  );
}

/**
 * 12 forward months from last current-year actual (anchor). Anchor→Dec uses prior-year month deltas.
 * After the calendar wrap (Dec→Jan), prefers current-year month-to-month deltas when both months exist;
 * otherwise falls back to prior-year deltas.
 */
function buildProjectionPath(priorSeries, currentSeries) {
  const p = priorSeries || [];
  const c = currentSeries || [];
  let anchorIdx = -1;
  for (let i = 11; i >= 0; i--) {
    const cell = c[i];
    if (cell?.ending_balance != null && !Number.isNaN(Number(cell.ending_balance))) {
      anchorIdx = i;
      break;
    }
  }
  if (anchorIdx < 0) return null;

  const priorBal = (idx) => {
    const cell = p[idx];
    if (cell?.ending_balance == null || Number.isNaN(Number(cell.ending_balance))) return null;
    return Number(cell.ending_balance);
  };

  const currentBal = (idx) => {
    const cell = c[idx];
    if (cell?.ending_balance == null || Number.isNaN(Number(cell.ending_balance))) return null;
    return Number(cell.ending_balance);
  };

  const deltaPrior = (mPrev, mNext) => {
    const pbP = priorBal(mPrev);
    const pbN = priorBal(mNext);
    if (pbP === null || pbN === null) return null;
    return pbN - pbP;
  };

  const deltaCurrentElsePrior = (mPrev, mNext) => {
    const cbP = currentBal(mPrev);
    const cbN = currentBal(mNext);
    if (cbP !== null && cbN !== null) return cbN - cbP;
    return deltaPrior(mPrev, mNext);
  };

  const pts = [];
  let val = Number(c[anchorIdx].ending_balance);
  pts.push({ month0: anchorIdx, val });

  let afterCalendarWrap = false;
  for (let k = 1; k <= 12; k++) {
    const mPrev = (anchorIdx + k - 1) % 12;
    const mNext = (anchorIdx + k) % 12;
    const crossesDecToJan = mPrev === 11 && mNext === 0;
    const d =
      afterCalendarWrap || crossesDecToJan ? deltaCurrentElsePrior(mPrev, mNext) : deltaPrior(mPrev, mNext);
    if (d === null) break;
    val += d;
    pts.push({ month0: mNext, val });
    if (crossesDecToJan) afterCalendarWrap = true;
  }

  if (pts.length < 2) return null;

  const rawSegments = [];
  let seg = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prevM = pts[i - 1].month0;
    const thisM = pts[i].month0;
    if (prevM === 11 && thisM === 0) {
      rawSegments.push(seg);
      seg = [pts[i]];
    } else {
      seg.push(pts[i]);
    }
  }
  if (seg.length) rawSegments.push(seg);

  // Do not merge singleton Dec with [Jan…Dec]: one polyline would draw a long diagonal from Dec's x to Jan's x.
  const allVals = pts.map((q) => q.val);
  return { segments: rawSegments, allVals };
}

function DebtSvgChart({ priorYear, currentYear, prior, current, debt_ceiling }) {
  const W = 640;
  const H = 260;
  const padL = 56;
  const padR = 24;
  const padT = 20;
  const padB = 36;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const ceilingNum =
    debt_ceiling != null && !Number.isNaN(Number(debt_ceiling)) ? Number(debt_ceiling) : null;

  const projection = buildProjectionPath(prior, current);

  const vals = [];
  for (const s of [prior, current]) {
    for (const c of s || []) {
      if (c?.ending_balance != null) vals.push(Number(c.ending_balance));
    }
  }
  if (ceilingNum != null) vals.push(ceilingNum);
  if (projection) for (const v of projection.allVals) vals.push(v);

  if (vals.length === 0) {
    return (
      <div className="debt-chart-empty">
        <p>No balances yet. Enter ending debt by month below, then save.</p>
      </div>
    );
  }
  let minY = Math.min(...vals);
  let maxY = Math.max(...vals);
  if (minY === maxY) {
    minY -= 1;
    maxY += 1;
  }
  const padY = (maxY - minY) * 0.08 || 1;
  minY -= padY;
  maxY += padY;

  const xForMonth = (m) => padL + ((m - 1) / 11) * innerW;
  const yForVal = (v) => padT + innerH - ((v - minY) / (maxY - minY)) * innerH;

  const pointsFor = (series) => {
    const pts = [];
    for (let i = 0; i < 12; i++) {
      const cell = series[i];
      if (cell?.ending_balance != null && !Number.isNaN(Number(cell.ending_balance))) {
        pts.push({ x: xForMonth(i + 1), y: yForVal(Number(cell.ending_balance)), m: i + 1 });
      }
    }
    return pts;
  };

  const ptsPrior = pointsFor(prior);
  const ptsCurrent = pointsFor(current);
  const lineD = (pts) =>
    pts.length ? pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') : '';

  const projSegments =
    projection?.segments
      .map((seg) =>
        seg.map((q) => ({
          x: xForMonth(q.month0 + 1),
          y: yForVal(q.val),
          m: q.month0 + 1,
        }))
      )
      .filter((seg) => seg.length > 1) || [];

  const yTicks = 5;
  const ticks = [];
  for (let i = 0; i <= yTicks; i++) {
    const t = minY + (i / yTicks) * (maxY - minY);
    ticks.push({ v: t, y: yForVal(t) });
  }

  const ceilingY = ceilingNum != null ? yForVal(ceilingNum) : null;

  return (
    <div className="debt-chart-wrap">
      <svg className="debt-chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Debt by month">
        <rect x="0" y="0" width={W} height={H} fill="var(--card)" stroke="var(--border)" rx="8" />
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={t.y} y2={t.y} stroke="var(--border)" strokeDasharray="4 4" />
            <text x={padL - 6} y={t.y + 4} textAnchor="end" fontSize="10" fill="var(--text-muted)">
              {money.format(t.v)}
            </text>
          </g>
        ))}
        {MONTHS.map((label, i) => (
          <text
            key={label}
            x={xForMonth(i + 1)}
            y={H - 10}
            textAnchor="middle"
            fontSize="11"
            fill="var(--text-muted)"
          >
            {label}
          </text>
        ))}
        {ceilingY != null && (
          <g className="debt-ceiling-line">
            <line
              x1={padL}
              x2={W - padR}
              y1={ceilingY}
              y2={ceilingY}
              stroke="#c62828"
              strokeWidth="2"
              strokeDasharray="6 4"
            />
            <text
              x={W - padR - 4}
              y={ceilingY < padT + 28 ? ceilingY + 14 : ceilingY - 6}
              textAnchor="end"
              fontSize="10"
              fill="#c62828"
            >
              Ceiling {money.format(ceilingNum)}
            </text>
          </g>
        )}
        {ptsPrior.length > 1 && (
          <polyline
            fill="none"
            stroke="var(--primary)"
            strokeWidth="2.5"
            points={lineD(ptsPrior)}
          />
        )}
        {ptsPrior.length === 1 && (
          <circle cx={ptsPrior[0].x} cy={ptsPrior[0].y} r="5" fill="var(--primary)" />
        )}
        {ptsCurrent.length > 1 && (
          <polyline
            fill="none"
            stroke="#2e7d32"
            strokeWidth="2.5"
            points={lineD(ptsCurrent)}
          />
        )}
        {ptsCurrent.length === 1 && (
          <circle cx={ptsCurrent[0].x} cy={ptsCurrent[0].y} r="5" fill="#2e7d32" />
        )}
        {ptsPrior.map((p) => (
          <circle key={`p-${p.m}`} cx={p.x} cy={p.y} r="4" fill="var(--primary)" stroke="var(--card)" strokeWidth="1" />
        ))}
        {ptsCurrent.map((p) => (
          <circle key={`c-${p.m}`} cx={p.x} cy={p.y} r="4" fill="#2e7d32" stroke="var(--card)" strokeWidth="1" />
        ))}
        {projSegments.map((seg, idx) => (
          <polyline
            key={`proj-${idx}`}
            fill="none"
            stroke="#ef6c00"
            strokeWidth="2"
            strokeDasharray="6 4"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={lineD(seg)}
          />
        ))}
      </svg>
      <div className="debt-chart-legend">
        <span className="debt-legend-prior">
          <span className="debt-legend-dot debt-legend-dot-prior" aria-hidden /> {priorYear}
        </span>
        <span className="debt-legend-current">
          <span className="debt-legend-dot debt-legend-dot-current" aria-hidden /> {currentYear}
        </span>
        {ceilingNum != null && (
          <span className="debt-legend-ceiling">
            <span className="debt-legend-dash" aria-hidden /> Ceiling
          </span>
        )}
        {projSegments.length > 0 && (
          <span
            className="debt-legend-projection"
            title={`Through December: month-to-month from ${priorYear}. After January: ${currentYear} where both months have balances, else ${priorYear}.`}
          >
            <span className="debt-legend-dash-proj" aria-hidden /> Projection ({priorYear} → {currentYear})
          </span>
        )}
      </div>
    </div>
  );
}

export function DebtReportSection() {
  const y = new Date().getFullYear();
  const [priorYear, setPriorYear] = useState(y - 1);
  const [currentYear, setCurrentYear] = useState(y);
  const [report, setReport] = useState(null);
  const [draftPrior, setDraftPrior] = useState(() => Array(12).fill(''));
  const [draftCurrent, setDraftCurrent] = useState(() => Array(12).fill(''));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ceilingDraft, setCeilingDraft] = useState('');
  const [ceilingSaving, setCeilingSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const loadReport = useCallback(async () => {
    setError('');
    setMessage('');
    setLoading(true);
    try {
      const r = await getDebtReport(priorYear, currentYear);
      setReport(r);
      setDraftPrior(seriesToDraft(r.prior));
      setDraftCurrent(seriesToDraft(r.current));
      setCeilingDraft(
        r.debt_ceiling != null && !Number.isNaN(Number(r.debt_ceiling)) ? String(r.debt_ceiling) : ''
      );
    } catch (e) {
      setError(e.message);
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [priorYear, currentYear]);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

  const updateDraftPrior = (idx, val) => {
    setDraftPrior((prev) => {
      const next = [...prev];
      next[idx] = val;
      return next;
    });
  };

  const updateDraftCurrent = (idx, val) => {
    setDraftCurrent((prev) => {
      const next = [...prev];
      next[idx] = val;
      return next;
    });
  };

  const handleSave = async () => {
    setError('');
    setMessage('');
    if (priorYear === currentYear) {
      setError('Choose two different years to compare.');
      return;
    }
    const balances = [];
    for (let i = 0; i < 12; i++) {
      const m = i + 1;
      const pv = draftPrior[i].trim();
      const cv = draftCurrent[i].trim();
      balances.push({
        year: priorYear,
        month: m,
        ending_balance: pv === '' ? null : Number(pv),
      });
      balances.push({
        year: currentYear,
        month: m,
        ending_balance: cv === '' ? null : Number(cv),
      });
    }
    for (const b of balances) {
      if (b.ending_balance !== null && Number.isNaN(b.ending_balance)) {
        setError('Enter valid numbers for balances, or leave blank to clear.');
        return;
      }
    }
    setSaving(true);
    try {
      await postDebtBalancesBulk(balances);
      setMessage('Balances saved.');
      await loadReport();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveCeiling = async () => {
    setError('');
    setMessage('');
    const trimmed = ceilingDraft.trim();
    let debt_ceiling = null;
    if (trimmed !== '') {
      const n = Number(trimmed);
      if (Number.isNaN(n) || n < 0) {
        setError('Debt ceiling must be a non-negative number, or leave blank to clear.');
        return;
      }
      debt_ceiling = n;
    }
    setCeilingSaving(true);
    try {
      const out = await putDebtCeiling(debt_ceiling);
      setMessage(out.debt_ceiling != null ? 'Debt ceiling saved.' : 'Debt ceiling cleared.');
      await loadReport();
    } catch (e) {
      setError(e.message);
    } finally {
      setCeilingSaving(false);
    }
  };

  return (
    <div className="manager-report-panel debt-report-panel">
      <h3 className="manager-report-panel-title">Debt report</h3>
      <p className="hint">
        Compare ending debt month by month for two years. Dollar amounts are month-end balances. Clear a cell and save
        to remove that month.
      </p>
      <div className="debt-year-row">
        <label>
          Prior year
          <input
            type="number"
            min={1900}
            max={2100}
            value={priorYear}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!Number.isNaN(v)) setPriorYear(Math.max(1900, Math.min(2100, v)));
            }}
          />
        </label>
        <label>
          Current year
          <input
            type="number"
            min={1900}
            max={2100}
            value={currentYear}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!Number.isNaN(v)) setCurrentYear(Math.max(1900, Math.min(2100, v)));
            }}
          />
        </label>
        <button type="button" onClick={loadReport} disabled={loading}>
          {loading ? 'Loading…' : 'Reload'}
        </button>
      </div>
      <div className="debt-ceiling-row">
        <label>
          Debt ceiling ($)
          <input
            type="text"
            inputMode="decimal"
            className="debt-ceiling-input"
            value={ceilingDraft}
            onChange={(e) => setCeilingDraft(e.target.value)}
            placeholder="e.g. 211000 (max borrowing)"
            aria-label="Debt ceiling in dollars"
          />
        </label>
        <button type="button" onClick={handleSaveCeiling} disabled={ceilingSaving || loading}>
          {ceilingSaving ? 'Saving…' : 'Save ceiling'}
        </button>
      </div>
      {error && <p className="manager-error">{error}</p>}
      {message && <p className="manager-message">{message}</p>}
      {report && !loading && (
        <DebtSvgChart
          priorYear={report.prior_year}
          currentYear={report.current_year}
          prior={report.prior}
          current={report.current}
          debt_ceiling={report.debt_ceiling}
        />
      )}
      {loading && <p>Loading chart…</p>}
      <h4 className="debt-table-title">Ending balance by month</h4>
      <div className="debt-table-scroll">
        <table className="report-table debt-balance-table">
          <thead>
            <tr>
              <th>Month</th>
              <th>{priorYear} ($)</th>
              <th>{currentYear} ($)</th>
            </tr>
          </thead>
          <tbody>
            {MONTHS.map((label, i) => (
              <tr key={label}>
                <td>{label}</td>
                <td>
                  <input
                    type="text"
                    inputMode="decimal"
                    className="debt-balance-input"
                    value={draftPrior[i]}
                    onChange={(e) => updateDraftPrior(i, e.target.value)}
                    placeholder="—"
                    aria-label={`${priorYear} ${label} ending balance`}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    inputMode="decimal"
                    className="debt-balance-input"
                    value={draftCurrent[i]}
                    onChange={(e) => updateDraftCurrent(i, e.target.value)}
                    placeholder="—"
                    aria-label={`${currentYear} ${label} ending balance`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="debt-save-row">
        <button type="button" onClick={handleSave} disabled={saving || loading}>
          {saving ? 'Saving…' : 'Save balances'}
        </button>
      </div>
    </div>
  );
}
