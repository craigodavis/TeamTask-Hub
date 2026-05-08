import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import './ScheduledReports.css';

function formatCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      const m = d.getMonth() + 1;
      const day = String(d.getDate()).padStart(2, '0');
      const yr = d.getFullYear();
      return `${m}/${day}/${yr}`;
    }
  }
  if (typeof value === 'number' && !Number.isInteger(value)) {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return s;
}

function formatRunAt(isoString) {
  const d = new Date(isoString);
  const m = d.getMonth() + 1;
  const day = String(d.getDate()).padStart(2, '0');
  const yr = d.getFullYear();
  const h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hr = h % 12 || 12;
  return `${m}/${day}/${yr} at ${hr}:${min} ${ampm}`;
}

export default function ReportView() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/reports/view/${token}`)
      .then(r => r.json())
      .then(json => {
        if (json.error) setError(json.error);
        else setData(json);
      })
      .catch(() => setError('Failed to load report.'))
      .finally(() => setLoading(false));
  }, [token]);

  const params = data?.params_snapshot || [];

  return (
    <div className="rv-page">
      <div className="rv-card">
        <div className="rv-brand">TeamHub · Scheduled Report</div>

        {loading && <div className="rv-loading">Loading report…</div>}

        {error && !loading && (
          <div className="rv-error">
            <div style={{ fontSize: '2rem', marginBottom: 8 }}>⚠️</div>
            <div>{error}</div>
            {error.includes('expired') && (
              <div style={{ marginTop: 8, fontSize: '0.85rem', color: '#999' }}>
                Report links are valid for 7 days.
              </div>
            )}
          </div>
        )}

        {data && !loading && (
          <>
            <h1 className="rv-title">{data.name}</h1>
            {data.description && <p className="rv-desc">{data.description}</p>}

            {/* Param pills */}
            {params.length > 0 && (
              <div className="rv-params">
                {params.map((p) => (
                  <span key={p.name} className="rv-param-pill">
                    <span className="rv-param-label">{p.name}</span>
                    <span className="rv-param-value">{p.display}</span>
                  </span>
                ))}
              </div>
            )}

            <div className="rv-meta">Generated {formatRunAt(data.ran_at)}</div>

            {(!data.rows || data.rows.length === 0) ? (
              <div style={{ color: '#888', fontStyle: 'italic' }}>No data returned.</div>
            ) : (
              <>
                <div className="rv-table-wrap">
                  <table className="rv-table">
                    <thead>
                      <tr>
                        {(data.fields || []).map(f => (
                          <th key={f}>{f}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((row, i) => (
                        <tr key={i}>
                          {(data.fields || []).map(f => (
                            <td key={f}>{formatCell(row[f])}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="rv-row-count">{data.rows_returned} row{data.rows_returned !== 1 ? 's' : ''}</div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
