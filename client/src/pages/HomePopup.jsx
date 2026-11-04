import React, { useState, useEffect, useCallback } from 'react';
import { getHomePopup, saveHomePopup } from '../api';
import { ImageField } from '../components/MediaPicker';

/**
 * Marketing → Website → Home Popup.
 *
 * The promotional modal on the website's home page. Built so that whoever is
 * running a promotion can put one up without help: the destination is chosen
 * from a list of our actual pages rather than typed as a URL, and the preview
 * beside the form is what a visitor will see.
 *
 * The end date matters more than it looks. A popup has no natural end — nothing
 * stops advertising a holiday party in February except somebody remembering —
 * so it carries the date it should stop, and the website obeys it whether or
 * not anyone comes back to switch it off.
 */

/* The pages worth sending somebody to. Deliberately not every route: the cart
   and the checkout are places a visitor arrives at, not places to be sent. */
const PAGES = [
  { url: '/events/request', label: 'Private event request form' },
  { url: '/events/', label: 'Events' },
  { url: '/club', label: 'Wine Club' },
  { url: '/estate/events/', label: 'Winery events' },
  { url: '/creek/events/', label: 'Creek events' },
  { url: '/about', label: 'About' },
  { url: '/contact', label: 'Contact' },
];

const card = { border: '1px solid var(--border,#e5e7eb)', borderRadius: 10, padding: 18, background: 'var(--surface,#fff)' };
const lbl = { display: 'block', fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.05em', color: '#6b7280', marginBottom: 6 };
const inp = { width: '100%', padding: '8px 10px', border: '1px solid var(--border,#d1d5db)', borderRadius: 6, font: 'inherit', background: 'var(--surface,#fff)', color: 'inherit' };
const hint = { fontSize: 12, opacity: 0.62, marginTop: 4, lineHeight: 1.5 };
const btn = (primary) => ({
  padding: '9px 16px', borderRadius: 6, font: 'inherit', cursor: 'pointer',
  border: primary ? 0 : '1px solid var(--border,#d1d5db)',
  background: primary ? '#2f6f4f' : 'transparent',
  color: primary ? '#fff' : 'inherit', fontWeight: primary ? 600 : 400,
});

const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

export function HomePopup() {
  const [p, setP] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [customUrl, setCustomUrl] = useState(false);

  const load = useCallback(async () => {
    try {
      const v = await getHomePopup();
      setP(v);
      setCustomUrl(Boolean(v.target_url) && !PAGES.some((x) => x.url === v.target_url));
    } catch (e) { setErr(e.message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (k, v) => setP((x) => ({ ...x, [k]: v }));

  const save = async () => {
    setSaving(true); setErr(''); setMsg('');
    try {
      const saved = await saveHomePopup(p);
      setP(saved);
      setMsg('Saved. The website picks it up on its next build, usually within the hour.');
      setTimeout(() => setMsg(''), 4000);
    } catch (e) { setErr(e.message); } finally { setSaving(false); }
  };

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!p) return <div style={{ padding: 24, color: '#991b1b' }}>{err || 'Could not load.'}</div>;

  const expired = p.ends_on && p.ends_on < todayISO();
  const destination = p.target_type === 'reservation'
    ? `Reservation page — ${p.venue === 'creek' ? 'Kindred by the Creek' : 'Winery'}${p.date ? `, ${p.date}` : ''}${p.time ? ` at ${p.time}` : ''}`
    : (p.target_url || '(nowhere yet)');

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '20px 24px 60px' }}>
      <h1 style={{ fontSize: '1.5rem', margin: '0 0 4px' }}>Home Popup</h1>
      <p style={{ color: '#6b7280', margin: '0 0 22px', fontSize: '.9rem' }}>
        A promotion that appears over the website's home page a few seconds after someone arrives.
      </p>

      {err && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: '.86rem' }}>{err}</div>}
      {msg && <div style={{ background: '#dcfce7', color: '#166534', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: '.86rem' }}>{msg}</div>}
      {p.enabled && expired && (
        <div style={{ background: '#fef3c7', color: '#92400e', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: '.86rem' }}>
          This is switched on but its end date ({p.ends_on}) has passed, so the website is not showing it.
          Change the date to run it again.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 340px', gap: 22, alignItems: 'start' }}>
        {/* ------------------------------------------------------- the form */}
        <div style={card}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', marginBottom: 18 }}>
            <input type="checkbox" style={{ marginTop: 3 }} checked={p.enabled}
                   onChange={(e) => set('enabled', e.target.checked)} />
            <span>
              <b>Show this popup on the home page</b>
              <div style={hint}>Switch off to take it down without losing what you have written.</div>
            </span>
          </label>

          <div style={{ display: 'grid', gap: 14 }}>
            <div>
              <label style={lbl}>Small line above the heading <span style={{ textTransform: 'none', opacity: .7 }}>optional</span></label>
              <input style={inp} value={p.eyebrow} maxLength={60}
                     onChange={(e) => set('eyebrow', e.target.value)} placeholder="At the Winery" />
            </div>
            <div>
              <label style={lbl}>Heading</label>
              <input style={inp} value={p.heading} maxLength={120}
                     onChange={(e) => set('heading', e.target.value)} placeholder="Holiday parties" />
            </div>
            <div>
              <label style={lbl}>Message</label>
              <textarea rows={3} style={{ ...inp, resize: 'vertical' }} value={p.body} maxLength={400}
                        onChange={(e) => set('body', e.target.value)}
                        placeholder="The perfect room for your holiday party. Tell us what you have in mind." />
            </div>
            <div>
              <label style={lbl}>Picture <span style={{ textTransform: 'none', opacity: .7 }}>optional</span></label>
              <ImageField value={p.image_url || ''} onChange={(url) => set('image_url', url)} />
            </div>

            <hr style={{ border: 0, borderTop: '1px solid var(--border,#eee)', margin: '4px 0' }} />

            <div>
              <label style={lbl}>Button text</label>
              <input style={inp} value={p.cta_label} maxLength={40}
                     onChange={(e) => set('cta_label', e.target.value)} placeholder="Plan your event" />
            </div>

            <div>
              <label style={lbl}>Where the button goes</label>
              <div style={{ display: 'flex', gap: 16, margin: '2px 0 10px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="radio" checked={p.target_type !== 'reservation'}
                         onChange={() => set('target_type', 'page')} />
                  <span>A page on our website</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="radio" checked={p.target_type === 'reservation'}
                         onChange={() => set('target_type', 'reservation')} />
                  <span>Book a table</span>
                </label>
              </div>

              {p.target_type !== 'reservation' ? (
                <>
                  <select style={inp}
                          value={customUrl ? '__other' : p.target_url}
                          onChange={(e) => {
                            if (e.target.value === '__other') { setCustomUrl(true); set('target_url', ''); }
                            else { setCustomUrl(false); set('target_url', e.target.value); }
                          }}>
                    <option value="">— choose a page —</option>
                    {PAGES.map((x) => <option key={x.url} value={x.url}>{x.label}</option>)}
                    <option value="__other">Somewhere else (paste a link)…</option>
                  </select>
                  {customUrl && (
                    <input style={{ ...inp, marginTop: 8 }} value={p.target_url}
                           onChange={(e) => set('target_url', e.target.value)}
                           placeholder="https://… or /some/page" />
                  )}
                </>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={lbl}>Which place</label>
                    <select style={inp} value={p.venue} onChange={(e) => set('venue', e.target.value)}>
                      <option value="estate">Winery</option>
                      <option value="creek">Kindred by the Creek</option>
                    </select>
                  </div>
                  <div>
                    <label style={lbl}>Guests</label>
                    <input type="number" min="1" max="40" style={inp} value={p.party}
                           onChange={(e) => set('party', e.target.value)} />
                  </div>
                  <div>
                    <label style={lbl}>Date <span style={{ textTransform: 'none', opacity: .7 }}>optional</span></label>
                    <input type="date" style={inp} value={p.date} onChange={(e) => set('date', e.target.value)} />
                  </div>
                  <div>
                    <label style={lbl}>Time <span style={{ textTransform: 'none', opacity: .7 }}>optional</span></label>
                    <input type="time" style={inp} value={p.time} onChange={(e) => set('time', e.target.value)} />
                  </div>
                  <div style={{ gridColumn: '1 / -1', ...hint }}>
                    Leave the date and time blank to drop people on the booking page with nothing chosen.
                  </div>
                </div>
              )}
            </div>

            <hr style={{ border: 0, borderTop: '1px solid var(--border,#eee)', margin: '4px 0' }} />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
              <div>
                <label style={lbl}>Stop showing after</label>
                <input type="date" style={inp} value={p.ends_on}
                       onChange={(e) => set('ends_on', e.target.value)} />
                <div style={hint}>It comes down on its own.</div>
              </div>
              <div>
                <label style={lbl}>Wait before showing</label>
                <input type="number" min="0" max="120" style={inp} value={p.delay_seconds}
                       onChange={(e) => set('delay_seconds', e.target.value)} />
                <div style={hint}>Seconds.</div>
              </div>
              <div>
                <label style={lbl}>Show again after</label>
                <input type="number" min="0" max="365" style={inp} value={p.reshow_days}
                       onChange={(e) => set('reshow_days', e.target.value)} />
                <div style={hint}>Days. 0 = every visit.</div>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 20 }}>
            <button style={btn(true)} disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
            <span style={{ fontSize: '.82rem', opacity: .65 }}>Goes to: {destination}</span>
          </div>
        </div>

        {/* ---------------------------------------------------- the preview */}
        <div>
          <div style={{ ...lbl, marginBottom: 8 }}>Preview</div>
          <div style={{ background: '#2a2724', borderRadius: 10, padding: 18 }}>
            <div style={{ background: '#fbf7ef', borderRadius: 8, padding: '22px 18px', textAlign: 'center', color: '#1a2124' }}>
              <div style={{ textAlign: 'right', fontSize: 18, opacity: .45, lineHeight: 1 }}>×</div>
              {p.eyebrow && <div style={{ fontSize: 10, letterSpacing: '.18em', textTransform: 'uppercase', color: '#9a7b4f', marginBottom: 8 }}>{p.eyebrow}</div>}
              <div style={{ fontSize: 20, lineHeight: 1.2, marginBottom: 10 }}>{p.heading || 'Your heading'}</div>
              {p.image_url && <img src={p.image_url} alt="" style={{ width: '100%', borderRadius: 6, margin: '0 0 12px' }} />}
              <div style={{ fontSize: 13, lineHeight: 1.6, opacity: .8, marginBottom: 16 }}>{p.body || 'Your message goes here.'}</div>
              <div style={{ background: '#2f6f4f', color: '#fff', padding: '10px 18px', borderRadius: 4, fontSize: 13, display: 'inline-block' }}>
                {p.cta_label || 'Find out more'}
              </div>
            </div>
          </div>
          <div style={{ ...hint, marginTop: 10 }}>
            Roughly what a visitor sees. The real one uses the website's own fonts and spacing.
          </div>
        </div>
      </div>
    </div>
  );
}
