import { useState, useEffect, useCallback } from 'react';
import { getTalentSubmissions, applyTalentSubmission, rejectTalentSubmission, getTermsCoverage } from '../api';

/**
 * What performers have sent back, as a diff to accept or decline.
 *
 * Nothing applies without someone seeing it. A 1099 address and a legal name
 * are things you file against, so "Mike" must not quietly replace "Michael
 * Sorenson" because someone typed it on a phone.
 *
 * Per-field accept matters as much as accept-all: a good photo should not wait
 * on a misspelled address.
 */
const card = { background: 'var(--card-bg,#fff)', border: '1px solid var(--border,#e3e3e3)', borderRadius: 10, padding: 16, marginBottom: 14 };
const btn = (p) => ({ padding: '7px 14px', borderRadius: 8, border: p ? 'none' : '1px solid var(--border,#ccc)', cursor: 'pointer', fontWeight: 600, background: p ? '#7c2d3a' : 'transparent', color: p ? '#fff' : 'inherit', fontSize: 13 });
const LABEL = {
  legal_first_name: 'Legal first name', legal_last_name: 'Legal last name', business_name: 'Business name',
  tax_entity: 'Paid as', stage_name: 'Band/stage name', phone: 'Phone', email: 'Email', address: 'Address',
  genre: 'Genre', act_type: 'Act', website_url: 'Website', instagram_url: 'Instagram',
  youtube_url: 'YouTube', facebook_url: 'Facebook', photo_url: 'Photo', bio: 'Bio',
  performer_notes: 'Their notes',
};

export default function TalentInbox() {
  const [subs, setSubs] = useState([]);
  const [coverage, setCoverage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    getTalentSubmissions().then(setSubs).catch((e) => setErr(e.message));
    getTermsCoverage().then(setCoverage).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const apply = async (id, fields) => {
    setBusy(true); setErr('');
    try { await applyTalentSubmission(id, fields); load(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const reject = async (id) => {
    if (!window.confirm('Decline everything in this submission?')) return;
    setBusy(true); setErr('');
    try { await rejectTalentSubmission(id, null); load(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const show = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));

  return (
    <div>
      {err && <p style={{ color: 'crimson' }}>{err}</p>}

      {coverage?.current_version && coverage.behind.length > 0 && (
        <div style={{ ...card, background: '#fff7e6', borderColor: '#e8d9a8' }}>
          <strong>{coverage.behind.length}</strong> performer{coverage.behind.length === 1 ? ' has' : 's have'} not
          accepted the current terms (<code>{coverage.current_version}</code>).
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
            {coverage.behind.slice(0, 12).map((b) => b.name).join(' · ')}
            {coverage.behind.length > 12 ? ` … +${coverage.behind.length - 12} more` : ''}
          </div>
        </div>
      )}

      {!subs.length && <p style={{ opacity: 0.6 }}>Nothing waiting to be reviewed.</p>}

      {subs.map((s) => (
        <div key={s.id} style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <strong style={{ fontSize: 16 }}>{s.musician_name}</strong>
            <span style={{ fontSize: 12, opacity: 0.6 }}>
              sent {new Date(s.created_at).toLocaleString()}
              {s.terms_version ? ` · accepted terms ${s.terms_version}` : ' · no terms recorded'}
            </span>
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10, fontSize: 14 }}>
            <tbody>
              {s.changes.map((c) => (
                <tr key={c.field} style={{ borderTop: '1px solid var(--border,#eee)' }}>
                  <td style={{ padding: '7px 8px 7px 0', width: 150, fontWeight: 600, verticalAlign: 'top' }}>
                    {LABEL[c.field] || c.field}
                  </td>
                  <td style={{ padding: '7px 8px', opacity: 0.55, verticalAlign: 'top', textDecoration: c.current ? 'line-through' : 'none' }}>
                    {show(c.current)}
                  </td>
                  <td style={{ padding: '7px 8px', verticalAlign: 'top', wordBreak: 'break-word' }}>{show(c.proposed)}</td>
                  <td style={{ padding: '7px 0', textAlign: 'right', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                    <button style={btn(false)} disabled={busy} onClick={() => apply(s.id, [c.field])}>Accept</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button style={btn(true)} disabled={busy} onClick={() => apply(s.id, null)}>Accept all</button>
            <button style={btn(false)} disabled={busy} onClick={() => reject(s.id)}>Decline</button>
          </div>
        </div>
      ))}
    </div>
  );
}
