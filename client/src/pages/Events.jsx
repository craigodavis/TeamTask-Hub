import { useState, useEffect, useCallback, useRef } from 'react';
import { getEvents, createEvent, updateEvent, deleteEvent, getMusicians, createMusician, updateMusician, getLocations, uploadEventImage, getSchedulingSettings, updateSchedulingSettings, getAssignableUsers, getEventTasks, createEventTask, updateEventTask, deleteEventTask } from '../api';

const card = { background: 'var(--card-bg,#fff)', border: '1px solid var(--border,#e3e3e3)', borderRadius: 10, padding: 16 };
const inp = { width: '100%', padding: 9, borderRadius: 8, border: '1px solid var(--border,#ccc)', fontSize: 15, boxSizing: 'border-box' };
const lbl = { fontSize: 12, opacity: 0.7, fontWeight: 600, display: 'block', marginBottom: 4 };
const btn = (primary) => ({ padding: '9px 16px', borderRadius: 8, border: primary ? 'none' : '1px solid var(--border,#ccc)', cursor: 'pointer', fontWeight: 600, background: primary ? '#7c2d3a' : 'transparent', color: primary ? '#fff' : 'inherit' });
const money = (n) => (n == null ? '' : '$' + Number(n).toLocaleString());
const fmtDT = (s) => (s ? new Date(s).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };

export default function Events() {
  const [tab, setTab] = useState('events');
  return (
    <div style={{ padding: 20, maxWidth: 1000, margin: '0 auto' }}>
      <h1 style={{ margin: '0 0 4px' }}>🎪 Events</h1>
      <p style={{ marginTop: 0, opacity: 0.7 }}>Plan events in TeamHub. Publishing pushes them to the website. Musician lift helps you book with staffing in mind.</p>
      <div style={{ display: 'flex', gap: 8, margin: '14px 0 18px' }}>
        {[['events', 'Events'], ['musicians', 'Musician/Talent'], ['reminders', 'Reminders']].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{ ...btn(tab === k), borderRadius: 20 }}>{l}</button>
        ))}
      </div>
      {tab === 'events' ? <EventsTab /> : tab === 'musicians' ? <MusiciansTab /> : <RemindersTab />}
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
  const [selected, setSelected] = useState(null);
  const [users, setUsers] = useState([]);
  const [view, setView] = useState('list');
  const [filter, setFilter] = useState({ location_id: '', musician_id: '', status: '', from: '', to: '' });
  const [form, setForm] = useState({ start_at: '', end_at: '', musician_id: '', location_id: '', title: '', description: '', cost: '', category: 'Live Music', status: 'draft', image_url: '' });

  const onPhoto = async (file) => {
    if (!file) return;
    setUploading(true); setErr('');
    try { const { url } = await uploadEventImage(file); setForm((f) => ({ ...f, image_url: url })); }
    catch (x) { setErr(x.message); } finally { setUploading(false); }
  };

  const load = useCallback(async () => {
    try {
      const [e, m, l, u] = await Promise.all([getEvents('all'), getMusicians(), getLocations(), getAssignableUsers()]);
      setEvents(Array.isArray(e) ? e : []); setMusicians(Array.isArray(m) ? m : []);
      setLocations(Array.isArray(l) ? l : (l?.locations || [])); setUsers(Array.isArray(u) ? u : []);
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
      setForm({ start_at: '', end_at: '', musician_id: '', location_id: '', title: '', description: '', cost: '', category: 'Live Music', status: 'draft', image_url: '' });
      await load();
    } catch (x) { setErr(x.message); } finally { setSaving(false); }
  };

  const remove = async (id) => { if (window.confirm('Delete this event?')) { await deleteEvent(id); load(); } };

  if (selected) return <EventDetail ev={selected} users={users} musicians={musicians} locations={locations} onBack={() => { setSelected(null); load(); }} />;

  const applyF = (list) => list.filter((e) => {
    if (filter.location_id && e.location_id !== filter.location_id) return false;
    if (filter.musician_id && e.musician_id !== filter.musician_id) return false;
    if (filter.status && e.status !== filter.status) return false;
    if (filter.from && new Date(e.start_at) < new Date(filter.from + 'T00:00:00')) return false;
    if (filter.to && new Date(e.start_at) > new Date(filter.to + 'T23:59:59')) return false;
    return true;
  });
  const filtered = applyF(events);
  const upcoming = [...filtered].filter((e) => new Date(e.start_at) >= Date.now() - 864e5).sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  const anyFilter = filter.location_id || filter.musician_id || filter.status || filter.from || filter.to;
  const fsel = { padding: '5px 7px', borderRadius: 8, border: '1px solid var(--border,#ccc)', fontSize: 13, background: 'transparent', color: 'inherit' };

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
          <div style={{ gridColumn: '1 / -1' }}><HtmlDesc value={form.description} onChange={(v) => set('description', v)} /></div>
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

      <div style={{ display: 'flex', gap: 8, margin: '4px 0 14px' }}>
        {[['list', 'List'], ['grid', 'Spreadsheet'], ['calendar', 'Calendar']].map(([k, l]) => (
          <button key={k} onClick={() => setView(k)} style={{ ...btn(view === k), borderRadius: 16, padding: '5px 12px', fontSize: 13 }}>{l}</button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        <select style={fsel} value={filter.location_id} onChange={(e) => setFilter({ ...filter, location_id: e.target.value })}>
          <option value="">All locations</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select style={fsel} value={filter.musician_id} onChange={(e) => setFilter({ ...filter, musician_id: e.target.value })}>
          <option value="">All musicians</option>
          {musicians.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <select style={fsel} value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
          <option value="">Any status</option>
          <option value="published">Published</option>
          <option value="draft">Draft</option>
        </select>
        <label style={{ fontSize: 12, opacity: 0.6 }}>from <input type="date" style={fsel} value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} /></label>
        <label style={{ fontSize: 12, opacity: 0.6 }}>to <input type="date" style={fsel} value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} /></label>
        {anyFilter && <button style={{ ...btn(false), padding: '4px 10px', fontSize: 12 }} onClick={() => setFilter({ location_id: '', musician_id: '', status: '', from: '', to: '' })}>Clear</button>}
        <span style={{ fontSize: 12, opacity: 0.5 }}>{filtered.length} event{filtered.length === 1 ? '' : 's'}</span>
      </div>

      {view === 'list' && <>
        <h3 style={{ marginTop: 0 }}>{anyFilter ? 'Filtered' : 'Upcoming'} ({upcoming.length})</h3>
        {upcoming.length === 0 && <p style={{ opacity: 0.6 }}>No upcoming events.</p>}
        {upcoming.map((e) => (
          <div key={e.id} style={{ ...card, marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <div onClick={() => setSelected(e)} style={{ cursor: 'pointer', flex: 1 }}>
              <div style={{ fontWeight: 700 }}>{e.title} {e.status === 'published' ? <span style={{ fontSize: 11, color: '#137a2f' }}>● live</span> : <span style={{ fontSize: 11, opacity: 0.5 }}>draft</span>}</div>
              <div style={{ fontSize: 13, opacity: 0.75 }}>{fmtDT(e.start_at)}{e.location_name ? ` · ${e.location_name}` : ''}{e.musician_name ? ` · 🎵 ${e.musician_name}${e.lift_pct != null ? ` (+${e.lift_pct}%)` : ''}` : ''}{e.cost != null ? ` · ${money(e.cost)}` : ''}</div>
            </div>
            <button style={{ ...btn(false), padding: '5px 10px' }} onClick={() => remove(e.id)}>Delete</button>
          </div>
        ))}
      </>}
      {view === 'grid' && <SpreadsheetView events={filtered} musicians={musicians} locations={locations} onOpen={setSelected} onChanged={load} />}
      {view === 'calendar' && <CalendarView events={filtered} onOpen={setSelected} />}
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

function RemindersTab() {
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { getSchedulingSettings().then(setS).catch((e) => setErr(e.message)); }, []);
  if (err) return <p style={{ color: 'crimson' }}>{err}</p>;
  if (!s) return <p>Loading…</p>;
  const save = async (patch) => {
    try { const n = await updateSchedulingSettings(patch); setS(n); setSaved(true); setTimeout(() => setSaved(false), 1500); }
    catch (e) { setErr(e.message); }
  };
  const tpl = (key, label) => (
    <div style={{ marginBottom: 16 }}>
      <label style={lbl}>{label}</label>
      <textarea rows={3} style={inp} defaultValue={s[key] || ''} onBlur={(e) => save({ [key]: e.target.value })} />
    </div>
  );
  return (
    <div style={{ ...card, maxWidth: 640 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <input type="checkbox" defaultChecked={s.talent_reminders_enabled} onChange={(e) => save({ talent_reminders_enabled: e.target.checked })} />
        <span style={{ fontWeight: 600 }}>Send talent reminders automatically</span>
        <span style={{ opacity: 0.6, fontSize: 12 }}>({s.talent_reminders_enabled ? 'ON — texts go out' : 'OFF — nothing sends'})</span>
      </label>
      <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 16, background: 'var(--card-bg,#f6f6f6)', border: '1px solid var(--border,#eee)', padding: 10, borderRadius: 8 }}>
        Reminders text the talent at each mark before their event. Placeholders you can use:&nbsp;
        <code>{'{talent}'}</code> <code>{'{event}'}</code> <code>{'{date}'}</code> <code>{'{time}'}</code> <code>{'{location}'}</code>. Changes save on blur.
      </div>
      {tpl('reminder_msg_month', '1 month before')}
      {tpl('reminder_msg_week', '1 week before')}
      {tpl('reminder_msg_day', '1 day before')}
      {saved && <span style={{ color: '#137a2f', fontWeight: 600 }}>✓ saved</span>}
    </div>
  );
}

function EventDetail({ ev, users, musicians, locations, onBack }) {
  const [notes, setNotes] = useState(ev.internal_notes || '');
  const [tasks, setTasks] = useState([]);
  const [nt, setNt] = useState({ checklist: 'Final Checklist', title: '', assignee_user_id: '' });
  const [savedNotes, setSavedNotes] = useState(false);
  const toLocal = (iso) => { if (!iso) return ''; const d = new Date(iso); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  const [f, setF] = useState({
    title: ev.title || '', description: ev.description || '', musician_id: ev.musician_id || '', location_id: ev.location_id || '',
    start_at: toLocal(ev.start_at), end_at: toLocal(ev.end_at), cost: ev.cost ?? '', category: ev.category || '', status: ev.status || 'draft', image_url: ev.image_url || '',
  });
  const [savedD, setSavedD] = useState(false);
  const [uploading, setUploading] = useState(false);
  const setField = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const saveDetails = async () => {
    const body = {};
    for (const k of ['title', 'description', 'musician_id', 'location_id', 'start_at', 'end_at', 'cost', 'category', 'status', 'image_url']) body[k] = f[k] === '' ? null : f[k];
    await updateEvent(ev.id, body); setSavedD(true); setTimeout(() => setSavedD(false), 1200);
  };
  const onPhoto = async (file) => { if (!file) return; setUploading(true); try { const { url } = await uploadEventImage(file); setField('image_url', url); await updateEvent(ev.id, { image_url: url }); } catch (e) { /* noop */ } finally { setUploading(false); } };
  const loadTasks = () => getEventTasks(ev.id).then((t) => setTasks(Array.isArray(t) ? t : [])).catch(() => {});
  useEffect(() => { loadTasks(); }, [ev.id]);

  const saveNotes = async () => { await updateEvent(ev.id, { internal_notes: notes }); setSavedNotes(true); setTimeout(() => setSavedNotes(false), 1200); };
  const addTask = async () => { if (!nt.title.trim()) return; await createEventTask(ev.id, nt); setNt({ ...nt, title: '' }); loadTasks(); };
  const toggle = async (t) => { await updateEventTask(t.id, { done: !t.done }); loadTasks(); };
  const assign = async (t, uid) => { await updateEventTask(t.id, { assignee_user_id: uid || null }); loadTasks(); };
  const del = async (t) => { await deleteEventTask(t.id); loadTasks(); };

  const groups = {};
  for (const t of tasks) (groups[t.checklist] ??= []).push(t);
  const checklistNames = [...new Set([...Object.keys(groups), 'Final Checklist', 'Setup', 'Day-of'])];

  return (
    <div>
      <button style={{ ...btn(false), marginBottom: 12 }} onClick={onBack}>← Back to events</button>
      <div style={{ ...card, marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Event details</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 12 }}>
          <div style={{ gridColumn: '1 / -1' }}><label style={lbl}>Title</label><input style={inp} value={f.title} onChange={(e) => setField('title', e.target.value)} /></div>
          <div><label style={lbl}>Starts</label><input type="datetime-local" style={inp} value={f.start_at} onChange={(e) => setField('start_at', e.target.value)} /></div>
          <div><label style={lbl}>Ends</label><input type="datetime-local" style={inp} value={f.end_at} onChange={(e) => setField('end_at', e.target.value)} /></div>
          <div><label style={lbl}>Musician</label>
            <select style={inp} value={f.musician_id || ''} onChange={(e) => setField('musician_id', e.target.value)}>
              <option value="">— none —</option>
              {(musicians || []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div><label style={lbl}>Location</label>
            <select style={inp} value={f.location_id || ''} onChange={(e) => setField('location_id', e.target.value)}>
              <option value="">— select —</option>
              {(locations || []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div><label style={lbl}>Category</label><input style={inp} value={f.category} onChange={(e) => setField('category', e.target.value)} /></div>
          <div><label style={lbl}>Cost</label><input type="number" style={inp} value={f.cost} onChange={(e) => setField('cost', e.target.value)} /></div>
          <div><label style={lbl}>Status</label>
            <select style={inp} value={f.status} onChange={(e) => setField('status', e.target.value)}>
              <option value="draft">Draft (not on website)</option>
              <option value="published">Published (to website)</option>
            </select>
          </div>
          <div style={{ gridColumn: '1 / -1' }}><HtmlDesc value={f.description} onChange={(v) => setField('description', v)} /></div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={lbl}>Photo</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              {f.image_url && <img src={f.image_url} alt="" style={{ height: 70, borderRadius: 8, objectFit: 'cover' }} />}
              <input type="file" accept="image/*" onChange={(e) => onPhoto(e.target.files[0])} />
              {uploading && <span style={{ opacity: 0.6 }}>uploading…</span>}
              {f.image_url && <button style={{ ...btn(false), padding: '4px 10px' }} onClick={() => { setField('image_url', ''); updateEvent(ev.id, { image_url: null }); }}>Remove</button>}
            </div>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <button style={btn(true)} onClick={saveDetails}>Save details</button>
          {savedD && <span style={{ marginLeft: 10, color: '#137a2f', fontWeight: 600 }}>✓ saved</span>}
        </div>
      </div>

      <div style={{ ...card, marginBottom: 16 }}>
        <label style={lbl}>Internal notes <span style={{ opacity: 0.5, fontWeight: 400 }}>(stays in TeamHub — never sent to the website)</span></label>
        <textarea rows={3} style={inp} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={saveNotes} />
        {savedNotes && <span style={{ color: '#137a2f', fontSize: 12 }}>✓ saved</span>}
      </div>

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Checklists &amp; tasks <span style={{ opacity: 0.5, fontSize: 12, fontWeight: 400 }}>(internal)</span></h3>
        {Object.keys(groups).length === 0 && <p style={{ opacity: 0.6 }}>No items yet — add one below.</p>}
        {Object.entries(groups).map(([name, items]) => (
          <div key={name} style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 13, opacity: 0.85, marginBottom: 4 }}>{name} <span style={{ fontWeight: 400, opacity: 0.6 }}>({items.filter((i) => i.done).length}/{items.length})</span></div>
            {items.map((t) => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                <input type="checkbox" checked={t.done} onChange={() => toggle(t)} />
                <span style={{ flex: 1, textDecoration: t.done ? 'line-through' : 'none', opacity: t.done ? 0.55 : 1 }}>{t.title}</span>
                <select value={t.assignee_user_id || ''} onChange={(e) => assign(t, e.target.value)} style={{ ...inp, width: 'auto', padding: '3px 6px', fontSize: 12 }}>
                  <option value="">unassigned</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
                </select>
                <button style={{ ...btn(false), padding: '2px 8px' }} onClick={() => del(t)}>✕</button>
              </div>
            ))}
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div><label style={lbl}>Checklist</label>
            <input list="checklist-names" style={{ ...inp, width: 150 }} value={nt.checklist} onChange={(e) => setNt({ ...nt, checklist: e.target.value })} />
            <datalist id="checklist-names">{checklistNames.map((n) => <option key={n} value={n} />)}</datalist>
          </div>
          <div style={{ flex: 1, minWidth: 160 }}><label style={lbl}>New item</label>
            <input style={inp} value={nt.title} onChange={(e) => setNt({ ...nt, title: e.target.value })} placeholder="e.g. Musician contacted? Tickets added?" onKeyDown={(e) => { if (e.key === 'Enter') addTask(); }} />
          </div>
          <div><label style={lbl}>Assign</label>
            <select style={{ ...inp, width: 140 }} value={nt.assignee_user_id} onChange={(e) => setNt({ ...nt, assignee_user_id: e.target.value })}>
              <option value="">unassigned</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
            </select>
          </div>
          <button style={btn(true)} onClick={addTask} disabled={!nt.title.trim()}>Add</button>
        </div>
      </div>
    </div>
  );
}

function SpreadsheetView({ events, musicians, locations, onOpen, onChanged }) {
  const sorted = [...events].sort((a, b) => new Date(b.start_at) - new Date(a.start_at));
  const save = async (id, patch) => { await updateEvent(id, patch); onChanged && onChanged(); };
  const th = { padding: '4px 6px', borderBottom: '2px solid var(--border,#ddd)', fontSize: 12, opacity: 0.6, textAlign: 'left' };
  const td = { padding: '2px 6px', borderBottom: '1px solid var(--border,#eee)', fontSize: 13 };
  const ci = { border: '1px solid transparent', background: 'transparent', fontSize: 13, padding: 3, color: 'inherit', width: '100%' };
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820 }}>
        <thead><tr><th style={th}>Date/time</th><th style={th}>Title</th><th style={th}>Musician</th><th style={th}>Location</th><th style={th}>Status</th><th style={th}>Internal notes</th><th style={th}></th></tr></thead>
        <tbody>
          {sorted.map((e) => (
            <tr key={e.id}>
              <td style={td}><input type="datetime-local" style={{ ...ci, width: 170 }} defaultValue={toLocalInput(e.start_at)} onBlur={(ev) => ev.target.value && save(e.id, { start_at: ev.target.value })} /></td>
              <td style={td}><input style={{ ...ci, minWidth: 160 }} defaultValue={e.title} onBlur={(ev) => save(e.id, { title: ev.target.value })} /></td>
              <td style={td}><select style={ci} defaultValue={e.musician_id || ''} onChange={(ev) => save(e.id, { musician_id: ev.target.value || null })}><option value="">—</option>{musicians.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></td>
              <td style={td}><select style={ci} defaultValue={e.location_id || ''} onChange={(ev) => save(e.id, { location_id: ev.target.value || null })}><option value="">—</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></td>
              <td style={td}><select style={{ ...ci, color: e.status === 'published' ? '#137a2f' : 'inherit' }} defaultValue={e.status} onChange={(ev) => save(e.id, { status: ev.target.value })}><option value="draft">draft</option><option value="published">live</option></select></td>
              <td style={td}><input style={{ ...ci, minWidth: 140 }} defaultValue={e.internal_notes || ''} placeholder="…" onBlur={(ev) => save(e.id, { internal_notes: ev.target.value })} /></td>
              <td style={td}><button style={{ ...btn(false), padding: '2px 8px', fontSize: 12 }} onClick={() => onOpen(e)}>Open ›</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CalendarView({ events, onOpen }) {
  const [month, setMonth] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const first = new Date(month.y, month.m, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(month.y, month.m + 1, 0).getDate();
  const byDay = {};
  for (const e of events) { const d = new Date(e.start_at); const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; (byDay[key] ??= []).push(e); }
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const prev = () => setMonth((m) => (m.m - 1 < 0 ? { y: m.y - 1, m: 11 } : { y: m.y, m: m.m - 1 }));
  const next = () => setMonth((m) => (m.m + 1 > 11 ? { y: m.y + 1, m: 0 } : { y: m.y, m: m.m + 1 }));
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <button style={{ ...btn(false), padding: '4px 10px' }} onClick={prev}>←</button>
        <strong>{first.toLocaleString(undefined, { month: 'long', year: 'numeric' })}</strong>
        <button style={{ ...btn(false), padding: '4px 10px' }} onClick={next}>→</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} style={{ fontSize: 11, opacity: 0.6, textAlign: 'center' }}>{d}</div>)}
        {cells.map((d, i) => {
          if (d === null) return <div key={'e' + i} />;
          const key = `${month.y}-${String(month.m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          const evs = byDay[key] || [];
          return (
            <div key={i} style={{ minHeight: 80, border: '1px solid var(--border,#eee)', borderRadius: 6, padding: 4, fontSize: 11 }}>
              <div style={{ opacity: 0.5, textAlign: 'right' }}>{d}</div>
              {evs.slice(0, 3).map((e) => <div key={e.id} onClick={() => onOpen(e)} title={e.title} style={{ cursor: 'pointer', background: e.status === 'published' ? '#e2f7e6' : '#eef0f4', color: '#333', borderRadius: 4, padding: '1px 4px', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.musician_name || e.title}</div>)}
              {evs.length > 3 && <div style={{ opacity: 0.5, marginTop: 2 }}>+{evs.length - 3} more</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HtmlDesc({ value, onChange }) {
  const ref = useRef(null);
  const [source, setSource] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.innerHTML !== (value || '')) el.innerHTML = value || '';
  }, [value, source]);
  const exec = (cmd, arg) => { document.execCommand(cmd, false, arg); if (ref.current) { ref.current.focus(); onChange(ref.current.innerHTML); } };
  const link = () => { const url = window.prompt('Link URL (https://…):'); if (url) exec('createLink', url); };
  const tbBtn = { border: '1px solid var(--border,#ddd)', background: 'transparent', color: 'inherit', borderRadius: 6, padding: '3px 8px', cursor: 'pointer', fontSize: 13, minWidth: 30 };
  const tbSel = { border: '1px solid var(--border,#ddd)', borderRadius: 6, padding: '3px 4px', fontSize: 12, background: 'transparent', color: 'inherit' };
  const B = ({ cmd, arg, title, onClick, children }) => (
    <button type="button" title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick || (() => exec(cmd, arg))} style={tbBtn}>{children}</button>
  );
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <label style={lbl}>Description <span style={{ opacity: 0.5, fontWeight: 400 }}>(shows on the website)</span></label>
        <button type="button" style={{ ...btn(false), padding: '2px 10px', fontSize: 11 }} onClick={() => setSource((s) => !s)}>{source ? '‹ Editor' : '</> HTML'}</button>
      </div>
      {source ? (
        <textarea rows={6} style={{ ...inp, fontFamily: 'monospace', fontSize: 13 }} value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder="<p>Join us…</p>" />
      ) : (
        <div style={{ border: '1px solid var(--border,#ccc)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: 6, borderBottom: '1px solid var(--border,#eee)', background: 'var(--card-bg,#fafafa)' }}>
            <B cmd="bold" title="Bold"><b>B</b></B>
            <B cmd="italic" title="Italic"><i>I</i></B>
            <B cmd="underline" title="Underline"><u>U</u></B>
            <select title="Text style" onMouseDown={(e) => e.preventDefault()} onChange={(e) => { exec('formatBlock', e.target.value); e.target.selectedIndex = 0; }} style={tbSel}>
              <option value="">Style…</option><option value="P">Normal</option><option value="H2">Heading</option><option value="H3">Subheading</option>
            </select>
            <select title="Size" onMouseDown={(e) => e.preventDefault()} onChange={(e) => { exec('fontSize', e.target.value); e.target.selectedIndex = 0; }} style={tbSel}>
              <option value="">Size…</option><option value="2">Small</option><option value="3">Normal</option><option value="5">Large</option><option value="6">X-Large</option>
            </select>
            <B cmd="insertUnorderedList" title="Bullet list">• List</B>
            <B cmd="insertOrderedList" title="Numbered list">1. List</B>
            <B title="Add link" onClick={link}>🔗 Link</B>
            <B cmd="unlink" title="Remove link">Unlink</B>
            <B cmd="removeFormat" title="Clear formatting">Clear</B>
          </div>
          <div ref={ref} contentEditable suppressContentEditableWarning onInput={() => onChange(ref.current.innerHTML)}
            style={{ minHeight: 120, padding: 10, fontSize: 15, outline: 'none', lineHeight: 1.5 }} />
        </div>
      )}
    </div>
  );
}
