import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';

const wrap = { maxWidth: 460, margin: '0 auto', padding: '28px 18px', fontFamily: 'system-ui, sans-serif' };
const bigBtn = (active, color) => ({
  flex: 1, padding: '16px 6px', fontSize: 15, borderRadius: 12, cursor: 'pointer', fontWeight: 600,
  border: active ? `2px solid ${color}` : '1px solid #ccc', background: active ? color + '18' : '#fff', color: active ? color : '#333',
});

export default function ShiftFeedback() {
  const { token } = useParams();
  const [ctx, setCtx] = useState(null);
  const [err, setErr] = useState('');
  const [sentiment, setSentiment] = useState(null);
  const [staffing, setStaffing] = useState(null);
  const [emphasis, setEmphasis] = useState(1);
  const [locationId, setLocationId] = useState(null);
  const [note, setNote] = useState('');
  const [pin, setPin] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/feedback/${token}`).then((r) => r.json()).then((d) => {
      if (d.error) setErr(d.error); else { setCtx(d); if (d.responded) setDone(true); }
    }).catch(() => setErr('Could not load this link.'));
  }, [token]);

  const submit = async () => {
    setErr(''); setBusy(true);
    try {
      const r = await fetch(`/api/feedback/${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, sentiment, staffing, note, emphasis, location_id: locationId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Something went wrong');
      setDone(true);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  if (err && !ctx) return <div style={wrap}><h2>🍷 Kindred</h2><p style={{ color: 'crimson' }}>{err}</p></div>;
  if (!ctx) return <div style={wrap}><p>Loading…</p></div>;
  if (done) return (
    <div style={wrap}>
      <h2>🍷 Kindred</h2>
      <p style={{ fontSize: 18 }}>Thanks{ctx.name ? `, ${ctx.name}` : ''}! 🙌</p>
      <p style={{ opacity: 0.7 }}>Your check-in is recorded. It helps us staff smarter next time.</p>
    </div>
  );

  const canSubmit = sentiment && staffing && pin.length >= 3 && (!ctx.needs_location || locationId) && !busy;
  return (
    <div style={wrap}>
      <h2 style={{ marginBottom: 2 }}>🍷 Kindred</h2>
      <p style={{ marginTop: 0, opacity: 0.7 }}>
        How did {ctx.location ? ctx.location + ' ' : ''}go{ctx.work_date ? ` on ${new Date(ctx.work_date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}` : ''}? Takes 10 seconds.
      </p>

      {ctx.needs_location && (
        <>
          <label style={{ fontWeight: 600, fontSize: 14 }}>Which location?</label>
          <div style={{ display: 'flex', gap: 10, margin: '8px 0 20px' }}>
            {(ctx.locations || []).map((l) => (
              <button key={l.id} onClick={() => setLocationId(l.id)} style={bigBtn(locationId === l.id, '#7c2d3a')}>{l.name}</button>
            ))}
          </div>
        </>
      )}

      <label style={{ fontWeight: 600, fontSize: 14 }}>How did today go?</label>
      <div style={{ display: 'flex', gap: 10, margin: '8px 0 20px' }}>
        {[[3, '🙂', 'Great', '#137a2f'], [2, '😐', 'OK', '#b7791f'], [1, '🙁', 'Rough', '#c0392b']].map(([v, e, l, c]) => (
          <button key={v} onClick={() => setSentiment(v)} style={bigBtn(sentiment === v, c)}>
            <div style={{ fontSize: 30 }}>{e}</div>{l}
          </button>
        ))}
      </div>

      <label style={{ fontWeight: 600, fontSize: 14 }}>Staffing today?</label>
      <div style={{ display: 'flex', gap: 10, margin: '8px 0 20px' }}>
        {[['over', 'Overstaffed', '#b7791f'], ['right', 'Just right', '#137a2f'], ['under', 'Understaffed', '#c0392b']].map(([v, l, c]) => (
          <button key={v} onClick={() => setStaffing(v)} style={bigBtn(staffing === v, c)}>{l}</button>
        ))}
      </div>

      <label style={{ fontWeight: 600, fontSize: 14 }}>Anything to add? <span style={{ opacity: 0.5, fontWeight: 400 }}>(optional)</span></label>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="e.g. slammed 2–5pm, needed another pourer"
        style={{ width: '100%', margin: '8px 0 20px', padding: 10, borderRadius: 10, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box' }} />

      <label style={{ fontWeight: 600, fontSize: 14 }}>Emphasis</label>
      <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2 }}>{['', 'Just FYI', 'Minor', 'Worth a look', 'Important', 'Please act on it'][emphasis]}</div>
      <div style={{ display: 'flex', gap: 8, margin: '8px 0 20px' }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} onClick={() => setEmphasis(n)} aria-label={`Importance ${n} of 5`}
            style={{ flex: 1, padding: '12px 0', fontSize: 30, lineHeight: 1, cursor: 'pointer', borderRadius: 10,
              border: emphasis >= n ? '1px solid #e0a500' : '1px solid #ddd',
              background: emphasis >= n ? '#fff6df' : '#fff', color: emphasis >= n ? '#e0a500' : '#cfcfcf' }}>
            {emphasis >= n ? '★' : '☆'}
          </button>
        ))}
      </div>

      <label style={{ fontWeight: 600, fontSize: 14 }}>Your PIN <span style={{ opacity: 0.5, fontWeight: 400 }}>(so we know it's you)</span></label>
      <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} inputMode="numeric" type="password" placeholder="••••"
        style={{ width: '100%', margin: '8px 0 20px', padding: 12, borderRadius: 10, border: '1px solid #ccc', fontSize: 18, letterSpacing: 4, boxSizing: 'border-box' }} />

      {err && <p style={{ color: 'crimson', marginTop: 0 }}>{err}</p>}
      <button onClick={submit} disabled={!canSubmit}
        style={{ width: '100%', padding: 15, fontSize: 17, fontWeight: 700, borderRadius: 12, border: 'none', cursor: canSubmit ? 'pointer' : 'not-allowed',
          background: canSubmit ? '#7c2d3a' : '#ccc', color: '#fff' }}>
        {busy ? 'Sending…' : 'Submit'}
      </button>
    </div>
  );
}
