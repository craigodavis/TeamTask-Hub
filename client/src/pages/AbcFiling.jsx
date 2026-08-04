import React, { useState, useEffect, useCallback } from 'react';
import { getAbcFiling, markAbcFiled, fillAbcPortal, getAbcPortalRun } from '../api';
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
  const [portalRun, setPortalRun] = useState(null);
  const [filling, setFilling] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    getAbcFiling(month)
      .then(setData)
      .catch((e) => { setError(e.message); setData(null); })
      .finally(() => setLoading(false));
    getAbcPortalRun(month).then(setPortalRun).catch(() => setPortalRun(null));
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

  const runPortalFill = async () => {
    if (!window.confirm(
      `Fill the ${month} report on the Idaho ABC portal?\n\n` +
      `This signs in and saves the figures below. It does NOT submit — ` +
      `submitting stays yours.`
    )) return;
    setFilling(true);
    setError('');
    try {
      const r = await fillAbcPortal(month);
      setPortalRun(r.run || (await getAbcPortalRun(month)));
      if (r.status === 'failed') setError(r.error || 'Portal run failed.');
    } catch (e) { setError(e.message); }
    finally { setFilling(false); load(); }
  };

  const l = data?.lines;
  const d = data?.detail;
  const filed = data?.stored?.status === 'filed';
  const mismatches = portalRun?.mismatches || [];

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

          {/* ── Sold but not collected ───────────────────────────────────── */}
          {data.unfulfilled?.bottles > 0 && (
            <>
              <h3 className="abc-h3">Sold but not yet collected</h3>
              <p className="hint">
                Wine paid for on or before {month} closed, still on the premises at
                month end. It has already been counted as a sale, so it has left the
                expected inventory — but the physical count still finds it on the
                shelf. That makes the count read <strong>high</strong> by roughly this
                much, showing up as an unexplained overage rather than a loss.
              </p>
              <table className="abc-table abc-unfulfilled">
                <tbody>
                  {data.unfulfilled.byMethod.map((m) => (
                    <tr key={m.method}>
                      <td>
                        {m.method}
                        <em> — {m.orders} order{m.orders === 1 ? '' : 's'}, {m.bottles} bottles</em>
                      </td>
                      <td className="num">{GAL(m.gallons)}</td>
                    </tr>
                  ))}
                  <tr className="abc-subtotal">
                    <td>Outstanding at month end</td>
                    <td className="num">{GAL(data.unfulfilled.closing)}</td>
                  </tr>
                  <tr>
                    <td>Outstanding at month start</td>
                    <td className="num">{GAL(data.unfulfilled.opening)}</td>
                  </tr>
                  <tr className="abc-subtotal">
                    <td>
                      = Change over the month
                      <em> — how much of the unexplained difference this accounts for</em>
                    </td>
                    <td className="num">
                      {data.unfulfilled.change >= 0 ? '+' : '−'}{GAL(Math.abs(data.unfulfilled.change))}
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="hint">
                The <strong>change</strong> is the figure that reconciles, not the
                total. Beginning inventory came from a count that already contained
                last month's outstanding wine, so only what sales outran collections
                during {month} pushes the books and the shelf apart. A rising balance
                makes the count read high by that much.
              </p>
              <p className="hint">
                Nothing here is entered on the ABC form and nothing is subtracted
                anywhere — this explains the unexplained difference above rather than
                adjusting it.
              </p>
            </>
          )}

          {/* ── Portal ───────────────────────────────────────────────────── */}
          <h3 className="abc-h3">State portal</h3>
          {portalRun ? (
            <div className={`abc-portal-run abc-portal-${portalRun.status}`}>
              <div className="abc-portal-line">
                <strong>
                  {portalRun.status === 'saved' && 'Saved on the portal — verified'}
                  {portalRun.status === 'saved_with_mismatches' && 'Saved, but the read-back disagrees'}
                  {portalRun.status === 'failed' && 'Last portal run failed'}
                  {portalRun.status === 'dry_run' && 'Dry run only — nothing was saved'}
                  {portalRun.status === 'running' && 'Portal run in progress…'}
                </strong>
                <span className="abc-portal-when">
                  {DATE(portalRun.started_at)} · {portalRun.trigger}
                </span>
              </div>
              {portalRun.error && <p className="abc-error">{portalRun.error}</p>}
              {mismatches.length > 0 && (
                <table className="abc-table abc-mismatch">
                  <thead><tr><th>Line</th><th className="num">Entered</th><th className="num">Portal shows</th></tr></thead>
                  <tbody>
                    {mismatches.map((m, i) => (
                      <tr key={i}>
                        <td>{m.line}{m.note ? <em> ({m.note})</em> : null}</td>
                        <td className="num">{GAL(m.entered)}</td>
                        <td className="num">{GAL(m.observed)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {portalRun.status?.startsWith('saved') && !mismatches.length && (
                <p className="hint">
                  Every line was read back off the portal and matches what was entered.
                </p>
              )}
            </div>
          ) : (
            <p className="abc-empty">Nothing has been put on the portal for {month}.</p>
          )}

          <div className="abc-actions">
            <button
              className="abc-portal-btn"
              onClick={runPortalFill}
              disabled={filling || filed || !data.readyToFile}
            >
              {filling ? 'Filling the portal…' : 'Fill the portal now'}
            </button>
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
