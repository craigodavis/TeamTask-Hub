import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getSquareReconcile } from '../api';

const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);

// Day-by-day comparison of our synced team_square DB against live Square sales.
// Reached from the SMS discrepancy alert (?start=&end=&loc=).
export function SquareReconcile() {
  const [sp] = useSearchParams();
  const start = sp.get('start');
  const end   = sp.get('end');
  const loc   = sp.get('loc');
  const [data, setData]     = useState(null);
  const [loading, setLoad]  = useState(true);
  const [error, setError]   = useState('');

  useEffect(() => {
    if (!start || !end) { setError('Missing date range in the link.'); setLoad(false); return; }
    getSquareReconcile({ start, end, loc })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoad(false));
  }, [start, end, loc]);

  const cell = { padding: '0.4rem 0.6rem', borderBottom: '1px solid var(--border,#e2e2e2)' };
  const rt = { ...cell, textAlign: 'right' };
  const flag = (d) => Math.abs(Number(d)) >= 0.5;

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '1rem' }}>
      <h2 style={{ marginBottom: '0.25rem' }}>Sales Reconciliation — Database vs Live Square</h2>
      <p style={{ color: 'var(--text-muted,#888)', marginTop: 0 }}>
        {start} → {end}{loc ? ` · ${loc}` : ''}
      </p>

      {loading && <p style={{ color: 'var(--text-muted,#888)' }}>Loading…</p>}
      {error && <p style={{ color: '#c62828' }}>{error}</p>}

      {data && (
        <>
          <div style={{ background: 'var(--card,#f5f7fa)', borderRadius: 10, padding: '0.75rem 1rem', margin: '0.5rem 0 1rem' }}>
            Totals — Database <strong>{money(data.db_total)}</strong> · Live Square <strong>{money(data.live_total)}</strong> ·
            Difference <strong style={{ color: flag(data.diff) ? '#c62828' : '#1a7f37' }}>{money(data.diff)}</strong>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
              <thead>
                <tr>
                  <th style={{ ...cell, textAlign: 'left' }}>Date</th>
                  <th style={rt}>Database</th>
                  <th style={rt}>Live Square</th>
                  <th style={rt}>Difference</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 && (
                  <tr><td style={cell} colSpan={4}>No sales in this range.</td></tr>
                )}
                {data.rows.map((r) => (
                  <tr key={r.date} style={{ background: flag(r.diff) ? 'rgba(198,40,40,0.06)' : 'transparent' }}>
                    <td style={{ ...cell, textAlign: 'left' }}>{r.date}</td>
                    <td style={rt}>{money(r.db_total)}</td>
                    <td style={rt}>{money(r.live_total)}</td>
                    <td style={{ ...rt, color: flag(r.diff) ? '#c62828' : 'inherit', fontWeight: flag(r.diff) ? 700 : 400 }}>{money(r.diff)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ color: 'var(--text-muted,#888)', fontSize: '0.78rem', marginTop: '0.75rem' }}>
            Live Square is the source of truth. A non-zero difference means our synced database is drifting for that day —
            re-run the Square sync (Settings → Square Sync) and re-check.
          </p>
        </>
      )}
    </div>
  );
}
