import { useState, useEffect, useCallback } from 'react';
import { getEvents, createEvent, deleteEvent, getMusicians, createMusician, updateMusician, getLocations, uploadEventImage } from '../api';

const card = { background: 'var(--card-bg,#fff)', border: '1px solid var(--border,#e3e3e3)', borderRadius: 10, padding: 16 };
const inp = { width: '100%', padding: 9, borderRadius: 8, border: '1px solid var(--border,#ccc)', fontSize: 15, boxSizing: 'border-box' };
const lbl = { fontSize: 12, opacity: 0.7, fontWeight: 600, display: 'block', marginBottom: 4 };
const btn = (primary) => ({ padding: '9px 16px', borderRadius: 8, border: primary ? 'none' : '1px solid var(--border,#ccc)', cursor: 'pointer', fontWeight: 600, background: primary ? '#7c2d3a' : 'transparent', color: primary ? '#fff' : 'inherit' });
const money = (n) => (n == null ? '' : '$' + Number(n).toLocaleString());
const fmtDT = (s) => (s ? new Date(s).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

export default function Events() {
  const [tab, setTab] = useState('events');
  return (
    <div style={{ padding: 20, maxWidth: 1000, margin: '0 auto' }}>
      <h1 style={{ margin: '0 0 4px' }}>🎪 Events</h1>
      <p style={{ marginTop: 0, opacity: 0.7 }}>Plan events in TeamHub. Publishing pushes them to the website. Musician lift helps you book with staffing in mind.</p>
      <div style={{ display: 'flex', gap: 8, margin: '14px 0 18px' }}>
        {[['events', 'Events'], ['musicians', 'Musician/Talent']].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{ ...btn(tab === k), borderRadius: 20 }}>{l}</button>
        ))}
      </div>
      {tab === 'events' ? <EventsTab /> : <MusiciansTab />}
    </div>
  );
}

function EventsTab() {
  const [events, setEvents] = useState([]);
  const [musicians, setMusicians] = useState([]);
  const [locations, setLocations] = useState([]);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [form, setForm] = useState({ start_at: '', end_at: '', musician_id: '', location_id: '', title: '', description: '', cost: '', category: 'Live Music', status: 'draft', image_url: '' });

  const onPhoto = async (file) => {
    if (!file) return;
    setUploading(true); setErr('');
    try { const { url } = await uploadEventImage(file); setForm((f) => ({ ...f, image_url: url })); }
    catch (x) { setErr(x.message); } finally { setUploading(false); }
  };

  const load = useCallback(async () => {
    try {
      const [e, m, l] = await Promise.all([getEvents('upcoming'), getMusicians(), getLocations()]);
      setEvents(Array.isArray(e) ? e : []); setMusicians(Array.isArray(m) ? m : []);
      setLocations(Array.isArray(l) ? l : (l?.locations || []));
    } catch (x) { setErr(x.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (k, v) => setForm((f) => {
    const next = { ...f, [k]: v };
    // auto-suggest a title when a musician is chosen and title is blank/auto
    if (k === 'musician_id' && (!f.title || f._auto)) {
      const m = musicians.find((mm) => mm.id === v);
      if (m) { next.title = `Sunset Music Series: ${m.name}`; next._auto = true; }
    }
    if (k === 'title') next._auto = false;
    return next;
  });

  const save = async () => {
    setErr(''); setSaving(true);
    try {
      const body = { ...form };
      delete body._auto;
      Object.keys(body).forEach((k) => { if (body[k] === '') delete body[k]; });
      await createEvent(body);
      setForm({ start_at: '', end_at: '', musician_id: '', location_id: '', title: '', description: '', cost: '', category: 'Live Music', status: 'draft' });
      await load();
    } catch (x) { setErr(x.message); } finally { setSaving(false); }
  };

  const remove = async (id) => { if (window.confirm('Delete this event?')) { await deleteEvent(id); load(); } };

  return (
    <div>
      <div style={{ ...card, marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>Add event</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 12 }}>
          <div><label style={lbl}>Starts</label><input type="datetime-local" style={inp} value={form.start_at} onChange={(e) => set('start_at', e.target.value)} /></div>
          <div><label style={lbl}>Ends</label><input type="datetime-local" style={inp} value={form.end_at} onChange={(e) => set('end_at', e.target.value)} /></div>
          <div><label style={lbl}>Musician</label>
            <select style={inp} value={form.musician_id} onChange={(e) => set('musician_id', e.target.value)}>
              <option value="">— none —</option>
              {musicians.map((m) => <option key={m.id} value={m.id}>{m.name}{m.lift_pct != null ? `  (+${m.lift_pct}%)` : ''}</option>)}
            </select>
          </div>
          <div><label style={lbl}>Location</label>
            <select style={inp} value={form.location_id} onChange={(e) => set('location_id', e.target.value)}>
              <option value="">— select —</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div style={{ gridColumn: '1 / -1' }}><label style={lbl}>Title</label><input style={inp} value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Event title" /></div>
          <div style={{ gridColumn: '1 / -1' }}><label style={lbl}>Description</label><textarea rows={2} style={inp} value={form.description} onChange={(e) => set('description', e.target.value)} /></div>
          <div><label style={lbl}>Category</label><input style={inp} value={form.category} onChange={(e) => set('category', e.target.value)} /></div>
          <div><label style={lbl}>Cost</label><input type="number" step="1" style={inp} value={form.cost} onChange={(e) => set('cost', e.target.value)} placeholder="0 = free" /></div>
          <div><label style={lbl}>Status</label>
            <select style={inp} value={form.status} onChange={(e) => set('status', e.target.value)}>
              <option value="draft">Draft (not on website)</option>
              <option value="published">Published (to website)</option>
            </select>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={lbl}>Photo</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              {form.image_url && <img src={form.image_url} alt="" style={{ height: 60, borderRadius: 8, objectFit: 'cover' }} />}
              <input type="file" accept="image/*" onChange={(e) => onPhoto(e.target.files[0])} />
              {uploading && <span style={{ opacity: 0.6 }}>uploading…</span>}
              {form.image_url && <button style={{ ...btn(false), padding: '4px 10px' }} onClick={() => set('image_url', '')}>Remove</button>}
            </div>
          </div>
        </div>
        {err && <p style={{ color: 'crimson' }}>{err}</p>}
        <div style={{ marginTop: 14 }}>
          <button style={btn(true)} disabled={saving || !form.start_at || !form.title} onClick={save}>{saving ? 'Saving…' : 'Add event'}</button>
          <span style={{ marginLeft: 10, opacity: 0.6, fontSize: 12 }}>Website publishing goes live in the next step; for now events are saved in TeamHub.</span>
        </div>
      </div>

      <h3>Upcoming ({events.length})</h3>
      {events.length === 0 && <p style={{ opacity: 0.6 }}>No upcoming events yet.</p>}
      {events.map((e) => (
        <div key={e.id} style={{ ...card, marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <div>
            <div style={{ fontWeight: 700 }}>{e.title} {e.status === 'published' ? <span style={{ fontSize: 11, color: '#137a2f' }}>● live</span> : <span style={{ fontSize: 11, opacity: 0.5 }}>draft</span>}</div>
            <div style={{ fontSize: 13, opacity: 0.75 }}>{fmtDT(e.start_at)}{e.location_name ? ` · ${e.location_name}` : ''}{e.musician_name ? ` · 🎵 ${e.musician_name}${e.lift_pct != null ? ` (+${e.lift_pct}%)` : ''}` : ''}{e.cost != null ? ` · ${money(e.cost)}` : ''}</div>
          </div>
          <button style={{ ...btn(false), padding: '5px 10px' }} onClick={() => remove(e.id)}>Delete</button>
        </div>
      ))}
    </div>
  );
}

function MusiciansTab() {
  const [list, setList] = useState([]);
  const [err, setErr] = useState('');
  const [form, setForm] = useState(null);
  const load = useCallback(async () => { try { setList(await getMusicians()); } catch (x) { setErr(x.message); } }, []);
  useEffect(() => { load(); }, [load]);

  const blank = { name: '', type: 'musician', website_url: '', photo_url: '', rate_amount: '', rate_unit: 'event', phone: '', email: '', notes: '' };
  const save = async () => {
    try {
      const body = { ...form }; Object.keys(body).forEach((k) => { if (body[k] === '') delete body[k]; });
      if (form.id) await updateMusician(form.id, body); else await createMusician(body);
      setForm(null); await load();
    } catch (x) { setErr(x.message); }
  };

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        {!form && <button style={btn(true)} onClick={() => setForm({ ...blank })}>Add Talent</button>}
      </div>
      {form && (
        <div style={{ ...card, marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>{form.id ? 'Edit' : 'Add'} Talent</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 12 }}>
            <div><label style={lbl}>Name</label><input style={inp} value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><label style={lbl}>Type</label>
              <select style={inp} value={form.type || 'musician'} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="musician">Musician</option>
                <option value="instructor">Class / Instructor</option>
                <option value="business">Business / Vendor</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div><label style={lbl}>Phone <span style={{ color: '#c0392b' }}>*required</span></label><input style={inp} value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="for event reminders" /></div>
            <div><label style={lbl}>Website / social</label><input style={inp} value={form.website_url || ''} onChange={(e) => setForm({ ...form, website_url: e.target.value })} /></div>
            <div><label style={lbl}>Photo URL</label><input style={inp} value={form.photo_url || ''} onChange={(e) => setForm({ ...form, photo_url: e.target.value })} /></div>
            <div><label style={lbl}>Rate</label><input type="number" style={inp} value={form.rate_amount || ''} onChange={(e) => setForm({ ...form, rate_amount: e.target.value })} /></div>
            <div><label style={lbl}>Rate unit</label>
              <select style={inp} value={form.rate_unit || 'event'} onChange={(e) => setForm({ ...form, rate_unit: e.target.value })}>
                <option value="event">per event</option><option value="hour">per hour</option>
              </select>
            </div>
            <div><label style={lbl}>Email</label><input style={inp} value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
            <div style={{ gridColumn: '1 / -1' }}><label style={lbl}>Notes</label><textarea rows={2} style={inp} value={form.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          </div>
          {err && <p style={{ color: 'crimson' }}>{err}</p>}
          <div style={{ marginTop: 12 }}>
            <button style={btn(true)} disabled={!form.name || !form.phone?.trim()} onClick={save}>Save</button>
            <button style={{ ...btn(false), marginLeft: 8 }} onClick={() => setForm(null)}>Cancel</button>
            {!form.phone?.trim() && <span style={{ marginLeft: 10, fontSize: 12, color: '#c0392b' }}>Phone required</span>}
          </div>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 10 }}>
        {list.map((m) => (
          <div key={m.id} style={{ ...card, cursor: 'pointer' }} onClick={() => setForm({ ...m, rate_amount: m.rate_amount ?? '' })}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              {m.photo_url ? <img src={m.photo_url} alt="" style={{ width: 44, height: 44, borderRadius: 22, objectFit: 'cover' }} /> : <div style={{ width: 44, height: 44, borderRadius: 22, background: '#eee', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>🎵</div>}
              <div>
                <div style={{ fontWeight: 700 }}>{m.name}{m.type && m.type !== 'musician' ? <span style={{ fontSize: 11, opacity: 0.6, fontWeight: 400 }}> · {m.type}</span> : ''}{!m.phone ? <span style={{ fontSize: 11, color: '#c0392b' }}> · no phone</span> : ''}</div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  {m.lift_pct != null ? `lift +${m.lift_pct}% · ${m.lift_nights}n` : 'no lift yet'}
                  {m.rate_amount != null ? ` · ${money(m.rate_amount)}/${m.rate_unit || 'event'}` : ''}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
