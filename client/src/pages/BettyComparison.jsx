/**
 * Betty vs Bookkeeper — read-only comparison report.
 * Shows what the human bookkeeper coded in QBO vs what Betty recommends.
 * No changes are made to QuickBooks.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { getQBOStatus, syncQBO } from '../api';
import './BettyComparison.css';

const token = () => localStorage.getItem('teamtask_token');
const authH  = () => ({ Authorization: `Bearer ${token()}` });

const STATUS_LABELS = {
  pending:      { label: 'Pending',      cls: 'st-pending' },
  agree:        { label: '✓ Agree',      cls: 'st-agree' },
  disagree:     { label: '✗ Disagree',   cls: 'st-disagree' },
  needs_review: { label: '⚠ Review',     cls: 'st-review' },
};

const AGREEMENT_LABELS = {
  match:             { label: '✓ Match',    cls: 'ag-match' },
  mismatch:          { label: '✗ Mismatch', cls: 'ag-mismatch' },
  no_recommendation: { label: '— No rec',   cls: 'ag-none' },
};

function fmt(amount) {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Row detail expand ─────────────────────────────────────────────────────────
function RowDetail({ row, onReview }) {
  const [note, setNote] = useState(row.reviewer_note || '');
  const [saving, setSaving] = useState(false);

  const submit = async (status) => {
    setSaving(true);
    try {
      const r = await fetch(`/api/betty/recommendations/${row.id}`, {
        method: 'PATCH',
        headers: { ...authH(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, reviewer_note: note }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      onReview(d.recommendation);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bc-detail">
      <div className="bc-detail-grid">
        <div className="bc-detail-col">
          <h5>Bookkeeper</h5>
          <div className="bc-detail-account">{row.bookkeeper_account_name || <em>Not coded</em>}</div>
          {row.bookkeeper_class_name && <div className="bc-detail-class">Class: {row.bookkeeper_class_name}</div>}
        </div>
        <div className="bc-detail-col">
          <h5>Betty's Recommendation</h5>
          {row.betty_account_name
            ? <>
                <div className="bc-detail-account">{row.betty_account_name}</div>
                {row.betty_class_name && <div className="bc-detail-class">Class: {row.betty_class_name}</div>}
                {row.betty_confidence && (
                  <div className={`bc-confidence bc-conf-${row.betty_confidence}`}>
                    Confidence: {row.betty_confidence}
                  </div>
                )}
              </>
            : <em className="bc-no-rec">No recommendation yet</em>
          }
        </div>
        {row.betty_reasoning && (
          <div className="bc-detail-reasoning">
            <h5>Betty's Reasoning</h5>
            <p>{row.betty_reasoning}</p>
          </div>
        )}
      </div>

      {row.betty_account_name && (
        <div className="bc-review-bar">
          <textarea
            className="bc-review-note"
            placeholder="Optional note…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
          />
          <div className="bc-review-btns">
            <button className="bc-btn-agree"        disabled={saving} onClick={() => submit('agree')}>✓ Agree</button>
            <button className="bc-btn-disagree"     disabled={saving} onClick={() => submit('disagree')}>✗ Disagree</button>
            <button className="bc-btn-needs-review" disabled={saving} onClick={() => submit('needs_review')}>⚠ Flag for Review</button>
          </div>
        </div>
      )}

      {row.reviewed_at && (
        <div className="bc-reviewed-by">
          Reviewed {new Date(row.reviewed_at).toLocaleDateString()}
          {row.reviewer_note && ` — "${row.reviewer_note}"`}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function BettyComparison() {
  const [rows, setRows]           = useState([]);
  const [summary, setSummary]     = useState(null);
  const [loading, setLoading]     = useState(true);
  const [days, setDays]           = useState(30);
  const [statusFilter, setStatus] = useState('');
  const [expanded, setExpanded]   = useState(null);
  const [error, setError]         = useState('');
  const [qboStatus, setQboStatus] = useState(null);
  const [syncing, setSyncing]     = useState(false);
  const [syncMsg, setSyncMsg]     = useState('');

  const loadQboStatus = useCallback(() => {
    getQBOStatus().then(setQboStatus).catch(() => {});
  }, []);

  useEffect(() => { loadQboStatus(); }, [loadQboStatus]);

  const handleSync = async () => {
    setSyncing(true); setSyncMsg(''); setError('');
    try {
      const r = await syncQBO();
      setSyncMsg(`Synced ${r.accounts} accounts and ${r.classes} classes from QuickBooks.`);
      loadQboStatus();
    } catch (e) { setError(e.message); }
    finally { setSyncing(false); }
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ days });
      if (statusFilter) params.set('status', statusFilter);
      const r = await fetch(`/api/betty/comparison?${params}`, { headers: authH() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setRows(d.comparison);
      setSummary(d.summary);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [days, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const handleReview = (updated) => {
    setRows((prev) => prev.map((r) => r.id === updated.id ? { ...r, ...updated } : r));
  };

  const mismatches = rows.filter((r) => r.agreement === 'mismatch').length;
  const pending    = rows.filter((r) => r.status === 'pending' && r.betty_account_name).length;

  return (
    <div className="bc-wrap">
      {/* ── QuickBooks connection / sync card (moved here from Receipts) ── */}
      {qboStatus?.connected && (
        <div className="qb-status-card">
          <div className="qb-status-row">
            <span className="qb-status-dot connected" />
            <span>QuickBooks {qboStatus.environment === 'sandbox' ? 'Sandbox' : 'Live'}</span>
          </div>
          <div className="qb-sync-info">
            {qboStatus.last_synced
              ? <span>Last synced: {new Date(qboStatus.last_synced).toLocaleString()}</span>
              : <span className="qb-sync-never">Never synced — run a sync to import accounts and classes.</span>}
            <div className="qb-counts">
              <span>{qboStatus.accounts} accounts</span>
              <span>{qboStatus.classes} classes</span>
            </div>
          </div>
          <button type="button" className="qb-btn-sync" onClick={handleSync} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync Now'}
          </button>
        </div>
      )}
      {syncMsg && <p className="bc-sync-msg">{syncMsg}</p>}

      <div className="bc-header">
        <div>
          <h2 className="bc-title">Betty Bookkeeper</h2>
          <p className="bc-subtitle">
            Read-only comparison — no changes are made to QuickBooks.
          </p>
        </div>
        <div className="bc-controls">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="bc-select">
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={60}>Last 60 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <select value={statusFilter} onChange={(e) => setStatus(e.target.value)} className="bc-select">
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="agree">Agree</option>
            <option value="disagree">Disagree</option>
            <option value="needs_review">Needs Review</option>
          </select>
        </div>
      </div>

      {summary && (
        <div className="bc-summary">
          <div className="bc-stat">
            <span className="bc-stat-n">{summary.total}</span>
            <span className="bc-stat-l">Transactions</span>
          </div>
          <div className="bc-stat bc-stat-match">
            <span className="bc-stat-n">{summary.match}</span>
            <span className="bc-stat-l">Matches</span>
          </div>
          <div className={`bc-stat ${summary.mismatch > 0 ? 'bc-stat-mismatch' : ''}`}>
            <span className="bc-stat-n">{summary.mismatch}</span>
            <span className="bc-stat-l">Mismatches</span>
          </div>
          <div className="bc-stat">
            <span className="bc-stat-n">{summary.no_recommendation}</span>
            <span className="bc-stat-l">No rec yet</span>
          </div>
          {pending > 0 && (
            <div className="bc-stat bc-stat-pending">
              <span className="bc-stat-n">{pending}</span>
              <span className="bc-stat-l">Needs review</span>
            </div>
          )}
          {summary.total > 0 && summary.match + summary.mismatch > 0 && (
            <div className="bc-stat bc-stat-pct">
              <span className="bc-stat-n">
                {Math.round(summary.match / (summary.match + summary.mismatch) * 100)}%
              </span>
              <span className="bc-stat-l">Agreement</span>
            </div>
          )}
        </div>
      )}

      {error && <p className="bc-error">{error}</p>}
      {loading && <p className="bc-loading">Loading…</p>}

      {!loading && rows.length === 0 && (
        <div className="bc-empty">
          <p>No recommendations yet.</p>
          <p className="bc-empty-hint">
            Have Betty call <code>POST /api/betty/recommendations</code> with her analysis of recent QBO transactions,
            then come back here to review.
          </p>
        </div>
      )}

      {!loading && rows.length > 0 && (
        <table className="bc-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Payee / Description</th>
              <th>Type</th>
              <th className="bc-th-amt">Amount</th>
              <th>Bookkeeper</th>
              <th>Betty</th>
              <th>Agreement</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const ag = AGREEMENT_LABELS[row.agreement] || {};
              const st = STATUS_LABELS[row.status] || {};
              const isOpen = expanded === row.id;
              return (
                <React.Fragment key={row.id}>
                  <tr
                    className={`bc-row ${isOpen ? 'bc-row-open' : ''} bc-row-${row.agreement}`}
                    onClick={() => setExpanded(isOpen ? null : row.id)}
                  >
                    <td className="bc-td-date">{fmtDate(row.txn_date)}</td>
                    <td className="bc-td-desc">
                      <div className="bc-payee">{row.payee_name || '—'}</div>
                      {row.txn_description && <div className="bc-desc-note">{row.txn_description}</div>}
                    </td>
                    <td className="bc-td-type">{row.qbo_txn_type}</td>
                    <td className="bc-td-amt">{fmt(row.txn_amount)}</td>
                    <td className="bc-td-account">{row.bookkeeper_account_name || <em>—</em>}</td>
                    <td className="bc-td-account">{row.betty_account_name || <em className="bc-norec">pending</em>}</td>
                    <td><span className={`bc-badge ${ag.cls}`}>{ag.label}</span></td>
                    <td><span className={`bc-badge ${st.cls}`}>{st.label}</span></td>
                  </tr>
                  {isOpen && (
                    <tr className="bc-detail-row">
                      <td colSpan={8}>
                        <RowDetail row={row} onReview={handleReview} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
