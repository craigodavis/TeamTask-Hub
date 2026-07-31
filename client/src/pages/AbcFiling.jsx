import React, { useState, useEffect, useCallback } from 'react';
import { getAbcFiling, markAbcFiled } from '../api';
import './AbcFiling.css';

const GAL = (n) => (n === null || n === undefined ? '—' : Number(n).toFixed(2));
const DATE = (d) => (d ? new Date(d).toLocaleDateString() : '—');

function prevMonth() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function AbcFiling() {
  const [month, setMonth] = useState(prevMonth);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    getAbcFiling(month)
      .then(setData)
      .catch((e) => { setError(e.message); setData(null); })
      .finally(() => setLoading(false));
  }, [month]);

  useEffect(() => { load(); }, [load]);

  const confirmFiled = async () => {
    if (!window.confirm(
      `Record ${month} as filed with Idaho ABC?\n\n` +
      `Only do this after you have reviewed the numbers and submitted the report on the state portal yourself.`
    )) return;
    setSaving(true);
    try { await markAbcFiled(month); load(); }
    catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  const l = data?.lines;
  const d = data?.detail;
  const filed = data?.stored?.status === 'filed';

  return (
    <div className="abc-page">
      <h2 className="abc-title">Idaho ABC Wine Report</h2>
      <p className="abc-sub">
        Prepared automatically. Nothing here has been submitted to the state — review the
        numbers, submit on the portal yourself, then record it below.
      </p>

      <div className="abc-toolbar">
        <label>
          Period
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </label>
        {data?.stored && (
          <span className={`abc-status abc-status-${data.stored.status}`}>
            {data.stored.status === 'filed'
              ? `Filed ${DATE(data.stored.filed_at)}`
              : `Draft prepared ${DATE(data.stored.prepared_at)}`}
          </span>
        )}
      </div>

      {error && <p className="abc-error">{error}</p>}
      {loading && <p className="abc-loading">Loading…</p>}

      {!loading && data && (
        <>
          {/* ── Preflight ────────────────────────────────────────────────── */}
          <div className={`abc-verdict ${data.readyToFile ? 'ok' : 'blocked'}`}>
            {data.readyToFile
              ? 'All checks passed — the numbers below reconcile to the physical count.'
              : `Not ready to file — ${data.blocking.join('; ')}.`}
          </div>

          <ul className="abc-checks">
            {data.checks.map((c) => (
              <li key={c.id} className={c.ok ? 'pass' : 'fail'}>
                <span className="abc-check-mark">{c.ok ? '✓' : '✕'}</span>
                <span className="abc-check-label">{c.label}</span>
                <span className="abc-check-detail">{c.detail}</span>
              </li>
            ))}
          </ul>

          {/* ── Counted vs expected ──────────────────────────────────────── */}
          <h3 className="abc-h3">Counted inventory vs. what the books expect</h3>
          <table className="abc-table abc-recon">
            <tbody>
              <tr>
                <td>Beginning inventory <em>(as filed last month)</em></td>
                <td className="num">{GAL(l.beginningInventory)}</td>
              </tr>
              <tr>
                <td>+ Production <em>(bottling runs in {month})</em></td>
                <td className="num">{GAL(l.production)}</td>
              </tr>
              <tr>
                <td>− Sales to consumers</td>
                <td className="num">{GAL(l.salesConsumers)}</td>
              </tr>
              <tr>
                <td>− Free tastings</td>
                <td className="num">{GAL(d.freeTastings)}</td>
              </tr>
              <tr>
                <td>+ Returned product</td>
                <td className="num">{GAL(l.returnedProduct)}</td>
              </tr>
              <tr className="abc-subtotal">
                <td>= Expected inventory at month end</td>
                <td className="num">{GAL(d.expectedEnding)}</td>
              </tr>
              <tr>
                <td>
                  Actual counted inventory
                  <em>
                    {' '}({d.countedBottles?.toLocaleString()} bottles, counted {DATE(d.countedAt)})
                  </em>
                </td>
                <td className="num">{GAL(d.countedGallons)}</td>
              </tr>
              {(d.postCountBackout?.salesConsumers > 0 || d.postCountBackout?.freeTastings > 0) && (
                <tr>
                  <td>
                    + Activity between month end and the count
                    <em> (sales {GAL(d.postCountBackout.salesConsumers)}, tastings{' '}
                      {GAL(d.postCountBackout.freeTastings)}, returns −{GAL(d.postCountBackout.returns)})</em>
                  </td>
                  <td className="num">
                    {GAL(d.postCountBackout.salesConsumers + d.postCountBackout.freeTastings
                         - d.postCountBackout.returns)}
                  </td>
                </tr>
              )}
              <tr className="abc-subtotal">
                <td>= Counted inventory restated to month end</td>
                <td className="num">{GAL(l.endingInventory)}</td>
              </tr>
              <tr className={`abc-residual ${data.checks.find((c) => c.id === 'residual_within_tolerance')?.ok ? '' : 'bad'}`}>
                <td>
                  <strong>Unexplained {Number(d.residual) < 0 ? 'overage' : 'loss'}</strong>
                  <em> — breakage, spillage, over-pours or miscount. Tolerance ±{GAL(d.residualTolerance)}.</em>
                </td>
                <td className="num">{GAL(Math.abs(Number(d.residual)))}</td>
              </tr>
            </tbody>
          </table>

          {/* ── The form ─────────────────────────────────────────────────── */}
          <h3 className="abc-h3">The ABC form, line for line</h3>
          <table className="abc-table abc-form">
            <tbody>
              <tr><td>Beginning Inventory</td><td className="num">{GAL(l.beginningInventory)}</td></tr>
              <tr><td>Purchases / In-State Transfer</td><td className="num">{GAL(l.purchases)}</td></tr>
              <tr><td>Production</td><td className="num">{GAL(l.production)}</td></tr>
              <tr>
                <td>Spoilage / Samples / Tastings
                  <em> (free tastings {GAL(d.freeTastings)} + unexplained {GAL(d.residual)})</em>
                </td>
                <td className="num">{GAL(l.spoilageSamples)}</td>
              </tr>
              <tr><td>Sales to Wholesalers</td><td className="num">{GAL(l.salesWholesale)}</td></tr>
              <tr><td>Sales to Retailers</td><td className="num">{GAL(l.salesRetail)}</td></tr>
              <tr><td>Sales — Other</td><td className="num">{GAL(l.salesOther)}</td></tr>
              <tr><td>Sales to Consumers</td><td className="num">{GAL(l.salesConsumers)}</td></tr>
              <tr><td>Returned Product</td><td className="num">{GAL(l.returnedProduct)}</td></tr>
              <tr className="abc-subtotal"><td>Ending Inventory</td><td className="num">{GAL(l.endingInventory)}</td></tr>
            </tbody>
          </table>

          {/* ── Backup ───────────────────────────────────────────────────── */}
          {/* Only a freshly computed filing carries the source breakdown. A
              hand-reconciled month is served straight from storage and has no
              salesBreakdown/productionRuns to show. */}
          <h3 className="abc-h3">Where the numbers came from</h3>
          {d.source === 'stored' ? (
            <p className="abc-empty">
              These figures come from the original hand reconciliation, not a live
              computation, so there is no source breakdown to show. Enter them as-is.
            </p>
          ) : (
            <div className="abc-backup">
              <div>
                <h4>Sales to consumers</h4>
                <table className="abc-table"><tbody>
                  <tr><td>Commerce7 bottles</td><td className="num">{GAL(d.salesBreakdown?.commerce7Bottles)}</td></tr>
                  <tr><td>Square bottles</td><td className="num">{GAL(d.salesBreakdown?.squareBottles)}</td></tr>
                  <tr><td>Wine by the glass</td><td className="num">{GAL(d.salesBreakdown?.wineGlasses)}</td></tr>
                  <tr><td>Paid tastings</td><td className="num">{GAL(d.salesBreakdown?.paidTastings)}</td></tr>
                </tbody></table>
              </div>
              <div>
                <h4>Production</h4>
                {(d.productionRuns?.length ?? 0) === 0 ? (
                  <p className="abc-empty">No bottling runs dated in {month}.</p>
                ) : (
                  <table className="abc-table"><tbody>
                    {d.productionRuns.map((r, i) => (
                      <tr key={i}>
                        <td>{r.name} <em>{r.date}</em>
                          {r.cases === null && <strong className="abc-warn"> — no case count</strong>}
                        </td>
                        <td className="num">{r.cases === null ? '—' : `${r.cases} cs / ${GAL(r.gallons)}`}</td>
                      </tr>
                    ))}
                  </tbody></table>
                )}
              </div>
            </div>
          )}

          <div className="abc-actions">
            <button
              className="abc-filed-btn"
              onClick={confirmFiled}
              disabled={saving || filed || !data.readyToFile}
            >
              {filed ? 'Recorded as filed' : 'I submitted this — record it as filed'}
            </button>
            {!data.readyToFile && !filed && (
              <span className="abc-actions-note">Resolve the failed checks above first.</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
