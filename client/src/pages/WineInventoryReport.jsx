import React, { useState, useEffect, useCallback } from 'react';
import { getLocations, getWineInventoryReport } from '../api';
import { todayInTimezone } from '../utils/dateUtils';
import './WineInventory.css';
import './WineInventoryReport.css';

export function WineInventoryReport() {
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState('all');
  const [asOf, setAsOf] = useState(() => todayInTimezone());
  const [allItems, setAllItems] = useState(false);
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    getLocations().then((d) => setLocations(d.locations || [])).catch(() => {});
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    getWineInventoryReport({ asOf, locationId, allItems })
      .then((d) => { setItems(d.items || []); setSummary(d.summary || null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [asOf, locationId, allItems]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="wine-inv-page">
      <h2 className="wine-inv-title">Wine Inventory Report</h2>

      <div className="wine-report-toolbar">
        <label>
          As of
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </label>
        <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
          <option value="all">All locations (total)</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <label className="wine-report-checkbox">
          <input type="checkbox" checked={allItems} onChange={(e) => setAllItems(e.target.checked)} />
          Include unavailable items
        </label>
      </div>

      {error && <p className="wine-inv-error">{error}</p>}

      {loading ? (
        <p className="wine-inv-loading">Loading…</p>
      ) : items.length === 0 ? (
        <p className="wine-inv-empty">No inventory data for this selection.</p>
      ) : (
        <div className="wine-report-table-wrap">
          <table className="wine-report-table">
            <thead>
              <tr>
                <th>Wine</th>
                <th>Varietal</th>
                <th style={{ textAlign: 'right' }}>Cases</th>
                <th style={{ textAlign: 'right' }}>Bottles</th>
                <th>Last counted</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.product_id} style={{ opacity: item.is_available ? 1 : 0.6 }}>
                  <td>{item.name}{item.vintage ? ` (${item.vintage})` : ''}</td>
                  <td>{item.varietal || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{item.cases}</td>
                  <td style={{ textAlign: 'right' }}>{item.bottles}</td>
                  <td>{item.last_counted_at ? new Date(item.last_counted_at).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {summary && (
        <div className="wine-report-summary">
          <h3 className="wine-report-summary-title">Totals</h3>
          <table className="wine-report-summary-table">
            <tbody>
              <tr>
                <td>All locations</td>
                <td style={{ textAlign: 'right' }}>{summary.all_locations.cases} cases</td>
              </tr>
              {summary.by_location.map((l) => (
                <tr key={l.location_id}>
                  <td>{l.location_name}</td>
                  <td style={{ textAlign: 'right' }}>{l.cases} cases</td>
                </tr>
              ))}
              <tr>
                <td>Total liters</td>
                <td style={{ textAlign: 'right' }}>
                  {summary.volume.liters.toLocaleString(undefined, { maximumFractionDigits: 1 })} L
                </td>
              </tr>
              <tr>
                <td>Total gallons</td>
                <td style={{ textAlign: 'right' }}>
                  {summary.volume.gallons.toLocaleString(undefined, { maximumFractionDigits: 1 })} gal
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
