import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';

/**
 * The performer-facing form. PUBLIC — reached by a 24-hour link, no login.
 *
 * Calls /api/talent-link/* directly rather than through api.js, because every
 * helper in there attaches a bearer token and a performer has none. Sending one
 * from here would be the bug that quietly couples a public page to staff auth.
 *
 * See docs/TALENT_SELF_SERVICE.md.
 */
const API = '/api';

/**
 * Colours are set explicitly, not inherited.
 *
 * This page is served by the staff app and therefore sits inside its theme —
 * which is dark. A performer opening a link from a text message got dark text
 * on a dark background and inputs they could barely read. They are not a user
 * of our admin UI and should not be subject to its appearance, so the page
 * paints its own surface and leaves nothing to a cascading variable.
 */
const page = { background: '#fdfbfa', color: '#2a2224', minHeight: '100vh' };
const wrap = { maxWidth: 680, margin: '0 auto', padding: '24px 18px 64px', fontFamily: 'system-ui, sans-serif', color: '#2a2224' };
const card = { background: '#fff', border: '1px solid #e6e1df', borderRadius: 12, padding: 18, marginBottom: 16, color: '#2a2224' };
const lbl = { display: 'block', fontSize: 12, fontWeight: 700, color: '#6b5d5f', marginBottom: 5 };
const inp = { width: '100%', padding: 10, borderRadius: 8, border: '1px solid #ccc', fontSize: 16, boxSizing: 'border-box', background: '#fff', color: '#2a2224' };
const row = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12, marginBottom: 12 };
const btn = (p) => ({ padding: '12px 20px', borderRadius: 8, border: p ? 'none' : '1px solid #ccc', background: p ? '#7c2d3a' : 'transparent', color: p ? '#fff' : 'inherit', fontWeight: 700, fontSize: 16, cursor: 'pointer' });

const FIELDS = [
  ['stage_name', 'Band or stage name', 'What we put on the poster'],
  ['genre', 'Genre', 'Americana, jazz, classic rock…'],
  ['phone', 'Phone', ''],
  ['email', 'Email', ''],
  ['website_url', 'Website', 'https://'],
  ['instagram_url', 'Instagram', 'https://instagram.com/…'],
  ['youtube_url', 'YouTube', 'https://youtube.com/…'],
  ['facebook_url', 'Facebook', 'https://facebook.com/…'],
  ['photo_url', 'Photo URL', 'A link to a good photo of you'],
];

export default function TalentUpdate() {
  const { token } = useParams();
  const [state, setState] = useState('loading'); // loading|form|done|dead
  const [reason, setReason] = useState('');
  const [data, setData] = useState(null);
  const [f, setF] = useState({});
  const [accept, setAccept] = useState(false);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [resent, setResent] = useState('');

  useEffect(() => {
    fetch(`${API}/talent-link/${token}`)
      .then(async (r) => ({ ok: r.ok, body: await r.json() }))
      .then(({ ok, body }) => {
        if (!ok) { setReason(body.error || 'invalid'); setState('dead'); return; }
        setData(body);
        const m = body.musician || {};
        setF(Object.fromEntries(Object.entries(m).filter(([, v]) => v != null)));
        setState('form');
      })
      .catch(() => { setReason('invalid'); setState('dead'); });
  }, [token]);

  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  const submit = async () => {
    setSaving(true); setErr('');
    try {
      const r = await fetch(`${API}/talent-link/${token}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...f, accept_terms: accept }),
      });
      const body = await r.json();
      if (!r.ok) { setErr(body.error || 'Something went wrong.'); return; }
      setState('done');
    } catch { setErr('Could not reach us just now — please try again.'); }
    finally { setSaving(false); }
  };

  const resend = async (contact) => {
    const r = await fetch(`${API}/talent-link`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contact }),
    });
    setResent((await r.json()).message || 'Sent.');
  };

  if (state === 'loading') return <div style={page}><div style={wrap}><p>Loading…</p></div></div>;

  // A 24-hour link WILL lapse on people. The dead end is the failure mode, not
  // the expiry, so this page's job is to hand back a working one.
  if (state === 'dead') {
    const msg = reason === 'expired' ? 'That link has expired — they only last 24 hours.'
      : reason === 'used' ? 'Those details are already with us. Thank you!'
      : 'That link is not valid.';
    return (
      <div style={page}><div style={wrap}>
        <h1 style={{ fontSize: 22 }}>Kindred Vineyards</h1>
        <div style={card}>
          <p style={{ marginTop: 0 }}>{msg}</p>
          {reason !== 'used' && (
            <>
              <p style={{ fontSize: 14, opacity: 0.75 }}>Enter the phone or email we have for you and we'll send a fresh one.</p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input style={{ ...inp, flex: 1, minWidth: 200 }} placeholder="Phone or email"
                       onKeyDown={(e) => { if (e.key === 'Enter') resend(e.target.value); }}
                       id="resend-contact" />
                <button style={btn(true)} onClick={() => resend(document.getElementById('resend-contact').value)}>Send</button>
              </div>
              {resent && <p style={{ fontSize: 14, marginBottom: 0 }}>{resent}</p>}
            </>
          )}
        </div>
      </div></div>
    );
  }

  if (state === 'done') return (
    <div style={page}><div style={wrap}>
      <h1 style={{ fontSize: 22 }}>Kindred Vineyards</h1>
      <div style={card}>
        <p style={{ marginTop: 0, fontSize: 18 }}>Thank you — we've got it.</p>
        <p style={{ opacity: 0.75, fontSize: 14, marginBottom: 0 }}>
          We'll look it over and it'll show up on our site before your next show.
        </p>
      </div>
    </div></div>
  );

  const terms = data?.terms;
  return (
    <div style={page}><div style={wrap}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Kindred Vineyards</h1>
      <p style={{ opacity: 0.7, marginTop: 0 }}>
        Your details for <strong>{data.musician.name}</strong>
      </p>

      {data.pending && (
        <div style={{ ...card, background: '#fff7e6', borderColor: '#e8d9a8' }}>
          We already have changes from you waiting to be looked at — anything you send now adds to them.
        </div>
      )}

      <div style={card}>
        <h2 style={{ marginTop: 0, fontSize: 17 }}>About you</h2>
        <div style={row}>
          {FIELDS.map(([k, label, hint]) => (
            <div key={k}>
              <label style={lbl}>{label}</label>
              <input style={inp} value={f[k] || ''} placeholder={hint} onChange={(e) => set(k, e.target.value)} />
            </div>
          ))}
        </div>
        <label style={lbl}>A bit about you <span style={{ fontWeight: 400 }}>(shown on our website)</span></label>
        <textarea style={{ ...inp, minHeight: 90 }} value={f.bio || ''} onChange={(e) => set('bio', e.target.value)} />
        <button type="button" style={{ ...btn(false), marginTop: 10, padding: '8px 14px', fontSize: 14 }}
                onClick={() => setPreview((p) => !p)}>
          {preview ? 'Hide preview' : 'Preview how this looks on our website'}
        </button>
        {preview && <PerformerCard m={f} />}
      </div>

      <div style={card}>
        <h2 style={{ marginTop: 0, fontSize: 17 }}>For our records</h2>
        <p style={{ fontSize: 13, opacity: 0.7, marginTop: 0 }}>
          We need this to pay you. <strong>Do not</strong> put bank details or your Social Security number
          here — we'll take those over the phone.
        </p>
        <div style={row}>
          <div><label style={lbl}>Legal first name</label>
            <input style={inp} value={f.legal_first_name || ''} onChange={(e) => set('legal_first_name', e.target.value)} /></div>
          <div><label style={lbl}>Legal last name</label>
            <input style={inp} value={f.legal_last_name || ''} onChange={(e) => set('legal_last_name', e.target.value)} /></div>
          <div><label style={lbl}>Business name <span style={{ fontWeight: 400 }}>(if you're paid as one)</span></label>
            <input style={inp} value={f.business_name || ''} onChange={(e) => set('business_name', e.target.value)} /></div>
          <div><label style={lbl}>Paid as</label>
            <select style={inp} value={f.tax_entity || ''} onChange={(e) => set('tax_entity', e.target.value)}>
              <option value="">Not set</option>
              <option value="individual">An individual</option>
              <option value="business">A business</option>
            </select></div>
        </div>
        <label style={lbl}>Mailing address</label>
        <textarea style={{ ...inp, minHeight: 70 }} value={f.address || ''} onChange={(e) => set('address', e.target.value)} />
      </div>

      <div style={card}>
        <label style={lbl}>Anything we should know?</label>
        <textarea style={{ ...inp, minHeight: 70 }} value={f.performer_notes || ''}
                  onChange={(e) => set('performer_notes', e.target.value)} />
      </div>

      {terms && (
        <div style={card}>
          <h2 style={{ marginTop: 0, fontSize: 17 }}>Playing at Kindred</h2>
          <div style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
            {terms.body_md.replace(/^## .*\n/, '').replace(/\*\*/g, '')}
          </div>
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 14, fontSize: 15 }}>
            <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} style={{ marginTop: 3 }} />
            <span>I've read the above.</span>
          </label>
        </div>
      )}

      {err && <p style={{ color: '#b00', fontWeight: 600 }}>{err}</p>}
      <button style={btn(true)} disabled={saving || (terms && !accept)} onClick={submit}>
        {saving ? 'Sending…' : 'Send to Kindred'}
      </button>
      <p style={{ fontSize: 12, opacity: 0.55, marginTop: 12 }}>
        This link expires {data.expires_at ? new Date(data.expires_at).toLocaleString() : 'in 24 hours'}.
      </p>
    </div></div>
  );
}

/**
 * How a performer appears on the website. Lives here for now so Preview has
 * something real to show before the public musicians page exists; it is meant
 * to be lifted into the site when that page is built.
 *
 * Deliberately does not prettify an empty card — a performer who sees blanks is
 * the whole reason Preview earns its place.
 */
export function PerformerCard({ m }) {
  const socials = [['instagram_url', 'Instagram'], ['youtube_url', 'YouTube'], ['facebook_url', 'Facebook'], ['website_url', 'Website']]
    .filter(([k]) => m[k]);
  return (
    <div style={{ marginTop: 14, border: '1px solid #e6e1df', borderRadius: 12, overflow: 'hidden', background: '#faf7f5' }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.08em', opacity: 0.5, padding: '8px 14px 0' }}>
        How this looks on kindredvineyards.com
      </div>
      <div style={{ display: 'flex', gap: 14, padding: 14, alignItems: 'flex-start' }}>
        {m.photo_url
          ? <img src={m.photo_url} alt="" style={{ width: 110, height: 110, objectFit: 'cover', borderRadius: 10, flexShrink: 0 }} />
          : <div style={{ width: 110, height: 110, borderRadius: 10, border: '1px dashed #c9bfbb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#a2938f', textAlign: 'center', flexShrink: 0 }}>No photo yet</div>}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 18 }}>{m.stage_name || m.name || 'Your name'}</div>
          <div style={{ fontSize: 13, opacity: 0.65, marginBottom: 6 }}>
            {[m.genre, m.act_type].filter(Boolean).join(' · ') || 'No genre set'}
          </div>
          <div style={{ fontSize: 14, lineHeight: 1.5 }}>
            {m.bio || <span style={{ opacity: 0.5, fontStyle: 'italic' }}>No bio yet — visitors will see an empty space here.</span>}
          </div>
          <div style={{ marginTop: 8, fontSize: 13, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {socials.length
              ? socials.map(([k, l]) => <span key={k} style={{ color: '#7c2d3a', fontWeight: 600 }}>{l}</span>)
              : <span style={{ opacity: 0.5, fontStyle: 'italic' }}>No links yet</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
