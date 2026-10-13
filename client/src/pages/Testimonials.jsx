import React, { useState, useEffect, useCallback } from 'react';
import {
  getTestimonials, createTestimonial, updateTestimonial, deleteTestimonial,
  getWebsiteSettings, saveWebsiteSettings,
} from '../api';
import { ImageField } from '../components/MediaPicker';

/**
 * Marketing → Website → Testimonials.
 *
 * What members have said about the club, shown as a carousel on the wine-club
 * page. The switch and the timing live here too rather than in Website Settings:
 * turning the carousel on is the same decision as deciding what is in it, and
 * splitting the two across two screens means visiting both to answer "why is
 * nothing showing".
 */

const card = { border: '1px solid var(--border,#e5e7eb)', borderRadius: 10, padding: 18, background: 'var(--surface,#fff)' };
const lbl = { display: 'block', fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.05em', color: '#6b7280', marginBottom: 6 };
const inp = { width: '100%', padding: '8px 10px', border: '1px solid var(--border,#d1d5db)', borderRadius: 6, font: 'inherit', background: 'var(--surface,#fff)', color: 'inherit' };
const btn = (primary) => ({
  padding: '8px 14px', borderRadius: 6, font: 'inherit', cursor: 'pointer',
  border: primary ? 0 : '1px solid var(--border,#d1d5db)',
  background: primary ? '#2f6f4f' : 'transparent',
  color: primary ? '#fff' : 'inherit', fontWeight: primary ? 600 : 400,
});

const BLANK = { quote: '', author_name: '', author_detail: '', image_url: '', active: true, sort_order: 0 };

export function Testimonials() {
  const [rows, setRows] = useState([]);
  const [enabled, setEnabled] = useState(false);
  const [seconds, setSeconds] = useState(7);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [editing, setEditing] = useState(null); // row being edited, or BLANK for new

  const load = useCallback(async () => {
    setErr('');
    try {
      const [list, settings] = await Promise.all([getTestimonials(), getWebsiteSettings()]);
      setRows(list);
      setEnabled(settings.club_testimonials_enabled === true);
      setSeconds(Number(settings.club_testimonials_seconds) || 7);
    } catch (e) { setErr(e.message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 2500); };

  const saveSettings = async (patch) => {
    setErr('');
    try {
      const s = await saveWebsiteSettings(patch);
      setEnabled(s.club_testimonials_enabled === true);
      setSeconds(Number(s.club_testimonials_seconds) || 7);
      flash('Saved. The website picks this up on its next build.');
    } catch (e) { setErr(e.message); }
  };

  const saveRow = async () => {
    setErr('');
    if (!editing.quote.trim()) { setErr('A quote is required.'); return; }
    try {
      if (editing.id) await updateTestimonial(editing.id, editing);
      else await createTestimonial(editing);
      setEditing(null);
      await load();
      flash('Saved.');
    } catch (e) { setErr(e.message); }
  };

  const remove = async (row) => {
    // Deleting loses the member's exact words. Hiding is almost always what is
    // actually wanted, so the confirm says so rather than just asking twice.
    if (!window.confirm(`Delete this testimonial permanently?\n\nTo take it off the website but keep the wording, untick "Show on the website" instead.`)) return;
    setErr('');
    try { await deleteTestimonial(row.id); await load(); flash('Deleted.'); }
    catch (e) { setErr(e.message); }
  };

  const liveCount = rows.filter((r) => r.active).length;

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 820, margin: '0 auto', padding: '20px 24px 60px' }}>
      <h1 style={{ fontSize: '1.5rem', margin: '0 0 4px' }}>Testimonials</h1>
      <p style={{ color: '#6b7280', margin: '0 0 22px', fontSize: '.9rem' }}>
        Shown as a carousel on the wine-club page, between the header and the clubs.
      </p>

      {err && <div style={{ background: '#fee2e2', color: '#991b1b', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: '.86rem' }}>{err}</div>}
      {msg && <div style={{ background: '#dcfce7', color: '#166534', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: '.86rem' }}>{msg}</div>}

      {/* ---- the switch ---- */}
      <div style={{ ...card, marginBottom: 20 }}>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
          <input type="checkbox" style={{ marginTop: 3 }} checked={enabled}
                 onChange={(e) => saveSettings({ club_testimonials_enabled: e.target.checked })} />
          <span>
            <b>Show the testimonial carousel on the wine-club page</b>
            <div style={{ fontSize: 12, opacity: 0.65, marginTop: 2, lineHeight: 1.5 }}>
              {enabled
                ? (liveCount
                    ? `On — showing ${liveCount} testimonial${liveCount === 1 ? '' : 's'}.`
                    : 'On, but nothing is ticked to show, so the section stays hidden.')
                : 'Off — the section is not on the page at all.'}
            </div>
          </span>
        </label>

        <div style={{ marginTop: 16, maxWidth: 320 }}>
          <label style={lbl}>Time on screen</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="number" min="3" max="30" value={seconds} style={{ ...inp, width: 90 }}
                   onChange={(e) => setSeconds(e.target.value)}
                   onBlur={() => saveSettings({ club_testimonials_seconds: Number(seconds) })} />
            <span style={{ fontSize: '.85rem', opacity: 0.7 }}>seconds per quote</span>
          </div>
          <div style={{ fontSize: 12, opacity: 0.65, marginTop: 6, lineHeight: 1.5 }}>
            A starting point, not a fixed rule. Longer quotes are held longer automatically,
            so a wordy one is not cut off mid-sentence. It also pauses while someone is
            reading it, and never auto-advances for visitors who have asked their device to
            reduce motion.
          </div>
        </div>
      </div>

      {/* ---- the list ---- */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <h2 style={{ fontSize: '1.05rem', margin: 0 }}>Testimonials ({rows.length})</h2>
        <button style={btn(true)} onClick={() => setEditing({ ...BLANK, sort_order: (rows.length + 1) * 10 })}>
          Add testimonial
        </button>
      </div>

      {!rows.length && (
        <div style={{ ...card, color: '#6b7280', fontSize: '.9rem' }}>
          Nothing yet. Add a member's words and tick the box above to put them on the page.
        </div>
      )}

      {rows.map((r) => (
        <div key={r.id} style={{ ...card, marginBottom: 10, opacity: r.active ? 1 : 0.55 }}>
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
            {r.image_url
              ? <img src={r.image_url} alt="" style={{ width: 54, height: 54, borderRadius: '50%', objectFit: 'cover', flex: '0 0 auto' }} />
              : <div style={{ width: 54, height: 54, borderRadius: '50%', background: 'var(--bg-subtle,#f3f4f6)', flex: '0 0 auto' }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '.95rem', lineHeight: 1.55 }}>“{r.quote}”</div>
              <div style={{ fontSize: '.82rem', color: '#6b7280', marginTop: 6 }}>
                {r.author_name || <i>no name</i>}
                {r.author_detail ? ` · ${r.author_detail}` : ''}
                {!r.active && ' · hidden'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flex: '0 0 auto' }}>
              <button style={btn(false)} onClick={() => setEditing({ ...r })}>Edit</button>
              <button style={{ ...btn(false), color: '#b91c1c' }} onClick={() => remove(r)}>Delete</button>
            </div>
          </div>
        </div>
      ))}

      {/* ---- editor ---- */}
      {editing && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,12,14,.45)', display: 'flex',
                      alignItems: 'flex-start', justifyContent: 'center', padding: '4vh 16px', overflowY: 'auto', zIndex: 60 }}
             onClick={(e) => { if (e.target === e.currentTarget) setEditing(null); }}>
          <div style={{ ...card, width: 'min(620px, 100%)' }}>
            <h3 style={{ margin: '0 0 16px' }}>{editing.id ? 'Edit testimonial' : 'Add testimonial'}</h3>

            <div style={{ marginBottom: 14 }}>
              <label style={lbl}>What they said</label>
              <textarea rows={4} style={{ ...inp, resize: 'vertical' }} value={editing.quote}
                        onChange={(e) => setEditing({ ...editing, quote: e.target.value })}
                        placeholder="The wines are the reason we joined. The welcome is why we stayed." />
              <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>
                No quote marks needed — the page adds them.
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
              <div>
                <label style={lbl}>Name</label>
                <input style={inp} value={editing.author_name || ''}
                       onChange={(e) => setEditing({ ...editing, author_name: e.target.value })}
                       placeholder="Sarah M." />
              </div>
              <div>
                <label style={lbl}>Detail</label>
                <input style={inp} value={editing.author_detail || ''}
                       onChange={(e) => setEditing({ ...editing, author_detail: e.target.value })}
                       placeholder="Voyager member since 2021" />
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={lbl}>Photo</label>
              <ImageField value={editing.image_url || ''}
                          onChange={(url) => setEditing({ ...editing, image_url: url })} />
              <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6, lineHeight: 1.5 }}>
                Optional, and shown as a circle — a square photo of the person's face works best.
                Without one the quote simply stands on its own.
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'end' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={editing.active !== false}
                       onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
                <span>Show on the website</span>
              </label>
              <div>
                <label style={lbl}>Order</label>
                <input type="number" style={inp} value={editing.sort_order ?? 0}
                       onChange={(e) => setEditing({ ...editing, sort_order: e.target.value })} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <button style={btn(true)} onClick={saveRow}>Save</button>
              <button style={btn(false)} onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
