import React, { useState, useEffect } from 'react';
import { getDashboard } from '../api';
import './Overview.css';

const money = (n) => (n === null || n === undefined ? '—'
  : `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const num = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());
const pct = (n) => (n === null || n === undefined ? '—' : `${Number(n).toFixed(1)}%`);

/**
 * A change badge, or an explicit "no comparison" when last year is missing.
 * `goodWhenDown` flips the colour for measures where lower is better — labor
 * running below last year is a win, and colouring it red would read as alarm.
 */
function Change({ change, goodWhenDown = false }) {
  if (change === null || change === undefined) {
    return <span className="ov-change none">no comparison yet</span>;
  }
  const up = change >= 0;
  const good = goodWhenDown ? !up : up;
  return (
    <span className={`ov-change ${good ? 'good' : 'bad'}`}>
      {up ? '▲' : '▼'} {Math.abs(change).toFixed(1)}%
    </span>
  );
}

function Card({ title, sub, value, lastYear, change, goodWhenDown, children }) {
  return (
    <div className="ov-card">
      <div className="ov-card-head">
        <h3>{title}</h3>
        {sub && <span className="ov-card-sub">{sub}</span>}
      </div>
      <div className="ov-value">{value}</div>
      <div className="ov-compare">
        <Change change={change} goodWhenDown={goodWhenDown} />
        <span className="ov-ly">
          {lastYear === null || lastYear === undefined
            ? 'last year unavailable'
            : <>last year {lastYear}</>}
        </span>
      </div>
      {children}
    </div>
  );
}

export function Overview() {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getDashboard()
      .then(setD)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="ov-page"><p className="ov-loading">Loading…</p></div>;
  if (error) return <div className="ov-page"><p className="ov-error">{error}</p></div>;
  if (!d) return null;

  const inv = d.inventory;

  return (
    <div className="ov-page">
      <h2 className="ov-title">Dashboard</h2>
      <p className="ov-sub">
        Each figure against the same window a year ago. Where last year isn't on
        record yet it says so rather than showing a zero.
      </p>

      <div className="ov-grid">
        {/* Square net sales — after discounts, before tax, and the same figure
            the labor percentage divides into. Commerce7 is a separate channel
            and is listed rather than folded in, so this matches Square. */}
        <Card
          title="Sales" sub="Square, last 7 days"
          value={money(d.sales7.value)}
          lastYear={d.sales7.lastYear === null ? null : money(d.sales7.lastYear)}
          change={d.sales7.change}
        >
          <table className="ov-breakdown">
            <tbody>
              <tr>
                <td>Commerce7</td>
                <td className="num">{money(d.sales7.commerce7)}</td>
              </tr>
            </tbody>
          </table>
          <p className="ov-note">Net of discounts, before tax.</p>
        </Card>

        <Card
          title="Events" sub="last 7 days"
          value={num(d.events7.value)}
          lastYear={num(d.events7.lastYear)}
          change={d.events7.change}
        />

        <Card
          title="Labor" sub="last 14 days, of Square net"
          value={pct(d.labor14.value)}
          lastYear={d.labor14.lastYear === null ? null : pct(d.labor14.lastYear)}
          change={d.labor14.change}
          goodWhenDown
        />

        {/* Inventory is the one that needed rethinking: the headline number
            people act on is what is still sellable, not what is on the floor. */}
        <Card
          title="Inventory" sub="sellable now"
          value={`${num(inv.sellableCases)} cases`}
          lastYear={inv.lastYearBottles === null ? null
            : `${num(Math.round(inv.lastYearBottles / 12))} cases`}
          change={inv.change}
        >
          <table className="ov-breakdown">
            <tbody>
              <tr>
                <td>On the floor</td>
                <td className="num">{num(inv.totalCases)} cases</td>
              </tr>
              <tr className="held">
                <td>Sold, not collected</td>
                <td className="num">
                  {num(inv.heldCases)} cases
                  {inv.heldPct !== null && <em> · {inv.heldPct}%</em>}
                </td>
              </tr>
              <tr className="ov-net">
                <td>Still sellable</td>
                <td className="num">{num(inv.sellableCases)} cases</td>
              </tr>
            </tbody>
          </table>
          {inv.heldByMethod?.length > 0 && (
            <p className="ov-note">
              {inv.heldByMethod.map((m) => `${m.method} ${m.bottles} btl`).join(' · ')}
            </p>
          )}
        </Card>

        <div className="ov-card ov-card-muted">
          <div className="ov-card-head">
            <h3>Grocery spend</h3>
            <span className="ov-card-sub">last 30 days</span>
          </div>
          <div className="ov-value">—</div>
          <p className="ov-note">Not wired up yet.</p>
        </div>
      </div>
    </div>
  );
}
