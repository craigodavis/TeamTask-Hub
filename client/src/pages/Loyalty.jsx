import React, { useState, useEffect, useCallback } from 'react';
import {
  getLoyaltyStats, getLoyaltyRules, putLoyaltyRule,
  getLoyaltyBalances, getLoyaltyLedger, runLoyaltyBackfill,
} from '../api';
import './Loyalty.css';

const N = (n) => Number(n || 0).toLocaleString();
const DATE = (d) => (d ? new Date(d).toLocaleDateString() : '—');

export function Loyalty() {
  const [stats, setStats] = useState(null);
  const [rules, setRules] = useState([]);
  const [balances, setBalances] = useState([]);
  const [ledger, setLedger] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('members');

  const load = useCallback(() => {
    setError('');
    Promise.all([
      getLoyaltyStats().then(setStats).catch(() => setStats(null)),
      getLoyaltyRules().then((r) => setRules(r.rules || [])).catch(() => setRules([])),
      getLoyaltyBalances().then((r) => setBalances(r.balances || [])).catch(() => setBalances([])),
      getLoyaltyLedger().then((r) => setLedger(r.entries || [])).catch(() => setLedger([])),
    ]);
  }, []);
  useEffect(() => { load(); }, [load]);

  const saveRule = async (key, patch) => {
    setBusy(true); setError('');
    try { await putLoyaltyRule(key, patch); load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const backfill = async () => {
    if (!window.confirm(
      'Award points for the last 12 months of history?\n\n'
      + 'Only rules with real evidence behind them are awarded — club pickups today. '
      + 'Re-running is safe: entries are keyed to their source record, so nothing doubles.'
    )) return;
    setBusy(true); setError('');
    try {
      const r = await runLoyaltyBackfill({ months: 12 });
      load();
      window.alert(`${N(r.totalEntries)} entries, ${N(r.totalPoints)} points, ${N(r.members)} members.`);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <section className="manager-section loyalty">
      <h2>Loyalty</h2>
      <p className="hint">
        Points accrue on an append-only ledger — a balance is the sum of its entries, so
        every one can be explained and a wrong award reversed rather than edited away.
      </p>

      {error && <p className="loy-error">{error}</p>}

      {/* ── The cost model ─────────────────────────────────────────────── */}
      <div className="loy-stats">
        <div className="loy-stat">
          <div className="loy-stat-n">{N(stats?.outstanding)}</div>
          <div className="loy-stat-l">Points outstanding</div>
        </div>
        <div className="loy-stat">
          <div className="loy-stat-n">{N(stats?.members)}</div>
          <div className="loy-stat-l">Members earning</div>
        </div>
        <div className="loy-stat">
          <div className="loy-stat-n">{N(stats?.points_awarded)}</div>
          <div className="loy-stat-l">Awarded all time</div>
        </div>
        <div className="loy-stat">
          <div className="loy-stat-n">{N(stats?.points_redeemed)}</div>
          <div className="loy-stat-l">Redeemed</div>
        </div>
      </div>

      {/* ── Earn rates ─────────────────────────────────────────────────── */}
      <h3 className="loy-h3">Ways to earn</h3>
      <p className="hint">
        Rates are data, not code. Changing one takes effect from now on — it never
        rewrites points already earned at the old rate.
      </p>
      <table className="loy-table">
        <thead>
          <tr><th>Rule</th><th className="num">Points</th><th>Active</th></tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.rule_key} className={r.active ? '' : 'off'}>
              <td>
                <span className="loy-ic">{r.icon}</span> {r.label}
                <em className="loy-desc">{r.description}</em>
              </td>
              <td className="num">
                <input
                  type="number" className="loy-pts" defaultValue={r.points} disabled={busy}
                  onBlur={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (Number.isInteger(v) && v !== r.points) saveRule(r.rule_key, { points: v });
                  }}
                />
              </td>
              <td>
                <input
                  type="checkbox" checked={r.active} disabled={busy}
                  onChange={(e) => saveRule(r.rule_key, { active: e.target.checked })}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="loy-actions">
        <button className="loy-btn" onClick={backfill} disabled={busy}>
          {busy ? 'Working…' : 'Award the last 12 months'}
        </button>
        <span className="loy-note">
          Safe to re-run — entries are keyed to their source, so nothing doubles.
        </span>
      </div>

      {/* ── Who has what ───────────────────────────────────────────────── */}
      <div className="loy-tabs">
        <button className={tab === 'members' ? 'on' : ''} onClick={() => setTab('members')}>
          Members
        </button>
        <button className={tab === 'ledger' ? 'on' : ''} onClick={() => setTab('ledger')}>
          Recent activity
        </button>
      </div>

      {tab === 'members' && (
        <table className="loy-table">
          <thead>
            <tr><th>Member</th><th className="num">Balance</th><th className="num">Entries</th><th>Last activity</th></tr>
          </thead>
          <tbody>
            {balances.map((b) => (
              <tr key={b.customer_id}>
                <td>{`${b.first_name || ''} ${b.last_name || ''}`.trim() || <em>{b.customer_id.slice(0, 8)}</em>}</td>
                <td className="num">{N(b.balance)}</td>
                <td className="num">{b.entries}</td>
                <td>{DATE(b.last_activity)}</td>
              </tr>
            ))}
            {!balances.length && (
              <tr><td colSpan={4} className="loy-empty">No points awarded yet.</td></tr>
            )}
          </tbody>
        </table>
      )}

      {tab === 'ledger' && (
        <table className="loy-table">
          <thead>
            <tr><th>When</th><th>Member</th><th>Reason</th><th className="num">Points</th></tr>
          </thead>
          <tbody>
            {ledger.map((e) => (
              <tr key={e.id}>
                <td>{DATE(e.occurred_at)}</td>
                <td>{`${e.first_name || ''} ${e.last_name || ''}`.trim() || <em>{e.customer_id.slice(0, 8)}</em>}</td>
                <td>{e.reason || e.rule_key}</td>
                <td className={`num${e.points < 0 ? ' neg' : ''}`}>
                  {e.points > 0 ? `+${N(e.points)}` : N(e.points)}
                </td>
              </tr>
            ))}
            {!ledger.length && (
              <tr><td colSpan={4} className="loy-empty">Nothing on the ledger yet.</td></tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}
