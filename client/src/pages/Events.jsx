import { useState, useEffect, useCallback, useRef } from 'react';
import { getEvents, createEvent, updateEvent, deleteEvent, getMusicians, createMusician, updateMusician, getLocations, getSchedulingSettings, updateSchedulingSettings, getAssignableUsers, getEventTasks, createEventTask, updateEventTask, deleteEventTask, getPromoTasks, createPromoTask, updatePromoTask, deletePromoTask, getContacts, createContact, updateContact, deleteContact, getTemplates, createTemplate, updateTemplate, deleteTemplate, getEventEmails, createEventEmail, deleteEventEmail, sendEventEmailNow, getPromoOverview, duplicateEvent, getEventDistribution, announceEvent, scheduleEventAnnounce, markEventChannelPost, setEventChannelEnabled, getEventMessageContext, sendEventMessage, submitEventForReview, approveEvent, requestEventChanges, publishEvent, withdrawEvent, verifyEventWithdrawn, getPromoScore, refreshPromoScore, getChannelConfig, updateChannelConfig, getEventActivity } from '../api';
import { ImageField } from '../components/MediaPicker';

const card = { background: 'var(--card-bg,#fff)', border: '1px solid var(--border,#e3e3e3)', borderRadius: 10, padding: 16 };
const inp = { width: '100%', padding: 9, borderRadius: 8, border: '1px solid var(--border,#ccc)', fontSize: 15, boxSizing: 'border-box' };
const lbl = { fontSize: 12, opacity: 0.7, fontWeight: 600, display: 'block', marginBottom: 4 };
const btn = (primary) => ({ padding: '9px 16px', borderRadius: 8, border: primary ? 'none' : '1px solid var(--border,#ccc)', cursor: 'pointer', fontWeight: 600, background: primary ? '#7c2d3a' : 'transparent', color: primary ? '#fff' : 'inherit' });
const money = (n) => (n == null ? '' : '$' + Number(n).toLocaleString());
// timeZone: 'UTC' for the same reason as toLocalInput below — the stored time IS
// the wall clock, so rendering it in the viewer's zone would show a manager in
// Boise 12:30 PM for an event that starts at 6:30.
const fmtDT = (s) => (s ? new Date(s).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }) : '');
// Event times are stored as WALL CLOCK labelled UTC: 18:30Z means "6:30 PM", not
// 6:30 PM Boise. The whole stack agrees on this — the public site formats these
// in UTC on purpose (website/src/lib/events.js) so what was typed is what shows.
// So the datetime-local input wants the stored string verbatim. Converting to
// browser-local here shifted it 6 hours west, and since save posts the field back
// untouched, EVERY edit moved the event 6 hours earlier: a 6:30 PM Thursdays at
// the Creek came back as 12:30 PM after one unrelated change to its title.
const toLocalInput = (iso) => (iso ? String(iso).slice(0, 16) : '');

export default function Events() {
  const [tab, setTab] = useState('events');
  return (
    <div style={{ padding: 20, maxWidth: 1000, margin: '0 auto' }}>
      <h1 style={{ margin: '0 0 4px' }}>🎪 Events</h1>
      <p style={{ marginTop: 0, opacity: 0.7 }}>Plan events in TeamHub. Publishing pushes them to the website. Musician lift helps you book with staffing in mind.</p>
      <div style={{ display: 'flex', gap: 8, margin: '14px 0 18px' }}>
        {[['events', 'Events'], ['musicians', 'Musician/Talent'], ['reminders', 'Reminders'], ['promo', 'Promotion']].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{ ...btn(tab === k), borderRadius: 20 }}>{l}</button>
        ))}
      </div>
      {tab === 'events' ? <EventsTab /> : tab === 'musicians' ? <MusiciansTab /> : tab === 'reminders' ? <RemindersTab /> : <PromoTab />}
    </div>
  );
}

function EventsTab() {
  const [events, setEvents] = useState([]);
  const [musicians, setMusicians] = useState([]);
  const [locations, setLocations] = useState([]);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState(null);
  const [users, setUsers] = useState([]);
  const [view, setView] = useState('calendar');
  const [segment, setSegment] = useState('upcoming');
  const [venueOff, setVenueOff] = useState({});
  const [showNew, setShowNew] = useState(false);
  const [filter, setFilter] = useState({ location_id: '', musician_id: '', status: '', from: '', to: '' });
  const [form, setForm] = useState({ start_at: '', end_at: '', musician_id: '', location_id: '', title: '', description: '', cost: '', category: 'Live Music', status: 'draft', image_url: '' });

  const load = useCallback(async () => {
    try {
      const [e, m, l, u] = await Promise.all([getEvents('all'), getMusicians(), getLocations(), getAssignableUsers()]);
      const evs = Array.isArray(e) ? e : [];
      setEvents(evs); setMusicians(Array.isArray(m) ? m : []);
      setLocations(Array.isArray(l) ? l : (l?.locations || [])); setUsers(Array.isArray(u) ? u : []);
      const openId = new URLSearchParams(window.location.search).get('open');
      if (openId) { const found = evs.find((x) => x.id === openId); if (found) { setSelected(found); window.history.replaceState({}, '', '/events'); } }
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

  const duplicate = async (id) => {
    try {
      const { id: newId } = await duplicateEvent(id);
      const evs = await getEvents('all');
      const arr = Array.isArray(evs) ? evs : [];
      setEvents(arr);
      const found = arr.find((x) => x.id === newId);
      if (found) setSelected(found); // open the copy so the user can set its new date
    } catch (x) { setErr(x.message); }
  };

  const closeCockpit = () => { setSelected(null); load(); };

  const applyF = (list) => list.filter((e) => {
    if (filter.location_id && e.location_id !== filter.location_id) return false;
    if (filter.musician_id && e.musician_id !== filter.musician_id) return false;
    if (filter.status && e.status !== filter.status) return false;
    if (filter.from && new Date(e.start_at) < new Date(filter.from + 'T00:00:00')) return false;
    if (filter.to && new Date(e.start_at) > new Date(filter.to + 'T23:59:59')) return false;
    return true;
  });
  const shown = events.filter((e) => (SEGMENTS.find((s) => s.key === segment) || SEGMENTS[0]).test(e) && !venueOff[e.location_id])
    .sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  const fsel = { padding: '5px 7px', borderRadius: 8, border: '1px solid var(--border,#ccc)', fontSize: 13, background: 'transparent', color: 'inherit' };
  const segStyle = (on) => ({ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 9, border: 'none', cursor: 'pointer', fontWeight: on ? 700 : 500, fontSize: 13.5, background: on ? 'var(--accent-soft,#f4e4e5)' : 'transparent', color: on ? '#7c2d3a' : 'inherit' });

  return (
    <>
    <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      {/* Left rail */}
      <aside style={{ flex: '0 0 210px', minWidth: 180, position: 'sticky', top: 12 }}>
        <button style={{ ...btn(true), width: '100%', borderRadius: 10, marginBottom: 14 }} onClick={() => setShowNew((v) => !v)}>
          {showNew ? '× Close' : '＋ New event'}
        </button>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', opacity: 0.5, margin: '0 4px 6px' }}>Views</div>
        {SEGMENTS.map((s) => {
          const n = events.filter((e) => s.test(e) && !venueOff[e.location_id]).length;
          return (
            <button key={s.key} style={segStyle(segment === s.key)} onClick={() => setSegment(s.key)}>
              {s.label}<span style={{ marginLeft: 'auto', opacity: 0.55, fontSize: 12, fontWeight: 600 }}>{n}</span>
            </button>
          );
        })}
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', opacity: 0.5, margin: '16px 4px 6px' }}>Venues</div>
        {locations.map((l) => {
          const on = !venueOff[l.id];
          return (
            <div key={l.id} onClick={() => setVenueOff((v) => ({ ...v, [l.id]: on }))}
                 style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 10px', borderRadius: 9, cursor: 'pointer', fontSize: 13.5, opacity: on ? 1 : 0.5 }}>
              <span style={{ width: 11, height: 11, borderRadius: 3, background: venueColor(l.name), opacity: on ? 1 : 0.3 }} />
              {l.name}<span style={{ marginLeft: 'auto', color: '#3f8f5b', visibility: on ? 'visible' : 'hidden' }}>✓</span>
            </div>
          );
        })}
      </aside>

      {/* Main */}
      <div style={{ flex: 1, minWidth: 0 }}>
      {showNew && (
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
            <ImageField value={form.image_url} onChange={(url) => set('image_url', url)} />
            <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6, lineHeight: 1.5 }}>
                Best at <b>2400 × 1000</b> (2.4:1 cinematic), JPG or PNG, under 8 MB. The event page
                shows the full 2.4:1 frame; the home-page tile crops to a 3:2 centre — so keep the
                subject centred and important detail away from the far edges.
              </div>
          </div>
        </div>
        {err && <p style={{ color: 'crimson' }}>{err}</p>}
        <div style={{ marginTop: 14 }}>
          <button style={btn(true)} disabled={saving || !form.start_at || !form.title} onClick={save}>{saving ? 'Saving…' : 'Add event'}</button>
          <span style={{ marginLeft: 10, opacity: 0.6, fontSize: 12 }}>Website publishing goes live in the next step; for now events are saved in TeamHub.</span>
        </div>
      </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>{(SEGMENTS.find((s) => s.key === segment) || SEGMENTS[0]).label}
          <span style={{ fontWeight: 400, opacity: 0.5, fontSize: 13, marginLeft: 8 }}>{shown.length} event{shown.length === 1 ? '' : 's'}</span></h3>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, background: 'var(--surface-3,#f0eeeb)', borderRadius: 9, padding: 3 }}>
          {[['calendar', 'Calendar'], ['list', 'List'], ['grid', 'Table']].map(([k, l]) => (
            <button key={k} onClick={() => setView(k)} style={{ border: 'none', padding: '6px 13px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer', background: view === k ? 'var(--card-bg,#fff)' : 'transparent', color: view === k ? 'inherit' : 'var(--muted,#888)', boxShadow: view === k ? '0 1px 3px rgba(0,0,0,.1)' : 'none' }}>{l}</button>
          ))}
        </div>
      </div>
      {err && <p style={{ color: 'crimson' }}>{err}</p>}

      {view === 'list' && (
        <div>
          {shown.length === 0 && <p style={{ opacity: 0.6 }}>No events in this view.</p>}
          {shown.map((e) => <EventRow key={e.id} e={e} onOpen={() => setSelected(e)} onCopy={() => duplicate(e.id)} onDelete={() => remove(e.id)} />)}
        </div>
      )}
      {view === 'grid' && <SpreadsheetView events={shown} musicians={musicians} locations={locations} onOpen={setSelected} onChanged={load} />}
      {view === 'calendar' && <CalendarView events={shown} onOpen={setSelected} />}
      </div>
    </div>

    {selected && (
      <>
        <div onClick={closeCockpit} style={{ position: 'fixed', inset: 0, background: 'rgba(30,18,20,.36)', zIndex: 60, animation: 'ckfade .18s ease' }} />
        <div role="dialog" aria-label="Event details" style={{ position: 'fixed', top: 0, right: 0, height: '100%', width: 'min(620px,100%)', background: 'var(--bg,#f6f2f0)', boxShadow: '-10px 0 48px rgba(0,0,0,.28)', zIndex: 61, overflowY: 'auto', padding: 20, animation: 'ckslide .26s cubic-bezier(.4,0,.2,1)' }}>
          <EventDetail ev={selected} users={users} musicians={musicians} locations={locations} onBack={closeCockpit} />
        </div>
        <style>{`@keyframes ckslide{from{transform:translateX(100%)}to{transform:none}}@keyframes ckfade{from{opacity:0}to{opacity:1}}`}</style>
      </>
    )}
    </>
  );
}

// Venue accent: the Creek runs teal, the estate/winery burgundy.
function venueColor(name) {
  if (!name) return '#9a8f88';
  return /creek/i.test(name) ? '#2c7671' : '#7c2d3a';
}
function stageOf(e) { return e.stage || (e.status === 'published' ? 'published' : 'draft'); }
const SEGMENTS = [
  { key: 'upcoming', label: 'Upcoming', test: (e) => new Date(e.start_at) >= Date.now() - 864e5 },
  { key: 'week', label: 'This week', test: (e) => { const d = new Date(e.start_at); return d >= Date.now() - 864e5 && d <= Date.now() + 7 * 864e5; } },
  { key: 'all', label: 'All events', test: () => true },
  { key: 'draft', label: 'Drafts', test: (e) => stageOf(e) === 'draft' },
  { key: 'review', label: 'In review', test: (e) => stageOf(e) === 'review' },
  { key: 'approved', label: 'Approved', test: (e) => stageOf(e) === 'approved' },
  { key: 'published', label: 'Live', test: (e) => stageOf(e) === 'published' },
];

function EventRow({ e, onOpen, onCopy, onDelete }) {
  const st = STAGE_META[stageOf(e)] || STAGE_META.draft;
  const vc = venueColor(e.location_name);
  const d = new Date(e.start_at);
  return (
    <div style={{ ...card, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 14, borderLeft: `4px solid ${vc}` }}>
      <div style={{ textAlign: 'center', flex: '0 0 44px' }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', color: vc }}>{isNaN(d) ? '' : d.toLocaleString(undefined, { month: 'short' })}</div>
        <div style={{ fontSize: 21, fontWeight: 700, lineHeight: 1 }}>{isNaN(d) ? '—' : d.getDate()}</div>
        <div style={{ fontSize: 10.5, opacity: 0.5 }}>{isNaN(d) ? '' : d.toLocaleString(undefined, { weekday: 'short' })}</div>
      </div>
      <div onClick={onOpen} style={{ cursor: 'pointer', flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.title}</div>
        <div style={{ fontSize: 12.5, opacity: 0.75, marginTop: 3, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, padding: '1px 9px', borderRadius: 20, background: st.bg, color: st.fg }}>{st.label}</span>
          {e.location_name && <span>{e.location_name}</span>}
          {e.musician_name && <span>· 🎵 {e.musician_name}{e.lift_pct != null ? ` (+${e.lift_pct}%)` : ''}</span>}
          {!isNaN(d) && <span>· {fmtDT(e.start_at)}</span>}
        </div>
      </div>
      <button style={{ ...btn(false), padding: '5px 10px' }} onClick={onCopy}>Copy</button>
      <button style={{ ...btn(false), padding: '5px 10px' }} onClick={onDelete}>Delete</button>
    </div>
  );
}

function MusiciansTab() {
  const [list, setList] = useState([]);
  const [err, setErr] = useState('');
  const [form, setForm] = useState(null);
  const load = useCallback(async () => { try { setList(await getMusicians()); } catch (x) { setErr(x.message); } }, []);
  useEffect(() => { load(); }, [load]);

  const blank = { name: '', type: 'musician', website_url: '', photo_url: '', rate_amount: '', rate_unit: 'event', phone: '', email: '', main_contact: '', write_check_to: '', address: '', notes: '', active: true };
  const [filter, setFilter] = useState({ status: 'all', phone: 'all' });
  const toggleActive = async (m) => { await updateMusician(m.id, { active: !m.active }); load(); };
  const mfsel = { padding: '5px 7px', borderRadius: 8, border: '1px solid var(--border,#ccc)', fontSize: 13, background: 'transparent', color: 'inherit' };
  const filtered = list.filter((m) => {
    if (filter.status === 'active' && !m.active) return false;
    if (filter.status === 'inactive' && m.active) return false;
    if (filter.phone === 'has' && !m.phone) return false;
    if (filter.phone === 'no' && m.phone) return false;
    return true;
  });
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
            <div><label style={lbl}>Main contact</label><input style={inp} value={form.main_contact || ''} onChange={(e) => setForm({ ...form, main_contact: e.target.value, write_check_to: (!form.write_check_to || form.write_check_to === form.main_contact) ? e.target.value : form.write_check_to })} /></div>
            <div><label style={lbl}>Write check to <span style={{ opacity: 0.5, fontWeight: 400 }}>(defaults to main contact)</span></label><input style={inp} value={form.write_check_to || ''} onChange={(e) => setForm({ ...form, write_check_to: e.target.value })} placeholder={form.main_contact || ''} /></div>
            <div style={{ gridColumn: '1 / -1' }}><label style={lbl}>Address</label><textarea rows={2} style={inp} value={form.address || ''} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
            <div style={{ gridColumn: '1 / -1' }}><label style={lbl}>Notes</label><textarea rows={2} style={inp} value={form.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
            <label style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={form.active !== false} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
              <span style={{ fontWeight: 600, fontSize: 13 }}>Active</span>
            </label>
          </div>
          {err && <p style={{ color: 'crimson' }}>{err}</p>}
          <div style={{ marginTop: 12 }}>
            <button style={btn(true)} disabled={!form.name || !form.phone?.trim()} onClick={save}>Save</button>
            <button style={{ ...btn(false), marginLeft: 8 }} onClick={() => setForm(null)}>Cancel</button>
            {!form.phone?.trim() && <span style={{ marginLeft: 10, fontSize: 12, color: '#c0392b' }}>Phone required</span>}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <select style={mfsel} value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
          <option value="all">All statuses</option><option value="active">Active only</option><option value="inactive">Inactive only</option>
        </select>
        <select style={mfsel} value={filter.phone} onChange={(e) => setFilter({ ...filter, phone: e.target.value })}>
          <option value="all">Any phone</option><option value="has">Has phone</option><option value="no">No phone</option>
        </select>
        <span style={{ fontSize: 12, opacity: 0.5 }}>{filtered.length} talent</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 10 }}>
        {filtered.map((m) => (
          <div key={m.id} style={{ ...card, opacity: m.active ? 1 : 0.6 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              {m.photo_url ? <img src={m.photo_url} alt="" style={{ width: 44, height: 44, borderRadius: 22, objectFit: 'cover' }} /> : <div style={{ width: 44, height: 44, borderRadius: 22, background: '#eee', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>🎵</div>}
              <div onClick={() => setForm({ ...m, rate_amount: m.rate_amount ?? '' })} style={{ cursor: 'pointer', flex: 1 }}>
                <div style={{ fontWeight: 700 }}>{m.name}{m.type && m.type !== 'musician' ? <span style={{ fontSize: 11, opacity: 0.6, fontWeight: 400 }}> · {m.type}</span> : ''}{!m.phone ? <span style={{ fontSize: 11, color: '#c0392b' }}> · no phone</span> : ''}</div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>{m.rate_amount != null ? `${money(m.rate_amount)}/${m.rate_unit || 'event'}` : (m.phone || m.email || '—')}</div>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: m.active ? '#e2f7e6' : '#eee', color: m.active ? '#137a2f' : '#777' }}>{m.active ? 'Active' : 'Inactive'}</span>
              <button style={{ ...btn(false), padding: '2px 8px', fontSize: 11 }} onClick={() => toggleActive(m)}>{m.active ? 'Deactivate' : 'Activate'}</button>
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
  const [staff, setStaff] = useState([]);
  useEffect(() => { getSchedulingSettings().then(setS).catch((e) => setErr(e.message)); }, []);
  useEffect(() => { getAssignableUsers().then((u) => setStaff(u || [])).catch(() => {}); }, []);
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

      <div style={{ marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--border,#eee)' }}>
        <h3 style={{ margin: '0 0 10px' }}>Event approval</h3>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <input type="checkbox" defaultChecked={s.event_approval_required} onChange={(e) => save({ event_approval_required: e.target.checked })} />
          <span style={{ fontWeight: 600 }}>Require approval before an event can be published</span>
        </label>
        <label style={lbl}>Approver</label>
        <select style={{ ...inp, maxWidth: 320 }} defaultValue={s.event_approver_id || ''} onChange={(e) => save({ event_approver_id: e.target.value || null })}>
          <option value="">— choose who approves —</option>
          {staff.map((u) => <option key={u.id} value={u.id}>{u.display_name || u.email}</option>)}
        </select>
        <div style={{ fontSize: 12, opacity: 0.75, marginTop: 10, background: 'var(--card-bg,#f6f6f6)', border: '1px solid var(--border,#eee)', padding: 10, borderRadius: 8 }}>
          When on, a new draft goes to the approver for review. They're texted until they approve or request changes; once approved, the creator is texted until they publish.
        </div>
      </div>
      {saved && <span style={{ color: '#137a2f', fontWeight: 600, display: 'inline-block', marginTop: 12 }}>✓ saved</span>}
      <ChannelsSettings />
    </div>
  );
}

function ChannelsSettings() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { getChannelConfig().then((d) => setRows(d.channels)).catch((e) => setErr(e.message)); }, []);
  const patch = async (key, p) => {
    setRows((rs) => rs.map((c) => c.key === key ? { ...c, ...p } : c));
    try { await updateChannelConfig(key, p); } catch (e) { setErr(e.message); }
  };
  if (err) return <p style={{ color: 'crimson' }}>{err}</p>;
  if (!rows) return null;
  const MODES = [['on_publish', '⚡ On publish'], ['scheduled', '🕒 Days before'], ['manual', '✋ Manual']];
  return (
    <div style={{ marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--border,#eee)' }}>
      <h3 style={{ margin: '0 0 4px' }}>Distribution channels</h3>
      <p style={{ fontSize: 12.5, color: 'var(--muted,#777)', margin: '0 0 12px' }}>
        How each channel fires. <b>On publish</b> = the moment an event goes live · <b>Days before</b> = auto, on its own lead · <b>Manual</b> = only when you hit “Push manual now.”
      </p>
      {rows.map((c) => (
        <div key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--border,#eee)' }}>
          <input type="checkbox" checked={c.enabled} onChange={(e) => patch(c.key, { enabled: e.target.checked })} />
          <span style={{ fontWeight: 600, flex: 1, minWidth: 0, opacity: c.enabled ? 1 : 0.5 }}>{c.name}</span>
          <select value={c.push_mode} onChange={(e) => patch(c.key, { push_mode: e.target.value })} style={{ ...inp, width: 'auto', padding: '6px 8px', fontSize: 13 }}>
            {MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {c.push_mode === 'scheduled' && (
            <span style={{ fontSize: 12.5, color: 'var(--muted,#777)', whiteSpace: 'nowrap' }}>
              <input type="number" min="0" max="365" value={c.lead_days ?? 0} onChange={(e) => patch(c.key, { lead_days: e.target.value })}
                     style={{ ...inp, width: 56, padding: '5px 6px', display: 'inline-block' }} /> d before
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Where this event has been announced, one row per channel.
 *
 * Nothing here posts anything — stage 1 tracks state and prepares copy. The
 * tier tells you why: `auto` channels will be API-driven once wired, `assisted`
 * ones can never be (Facebook removed event creation from their API; Bandsintown
 * listings come from the artist), and `outreach` goes out as email.
 */
const ACT_ICON = { created: '＋', edited: '✎', published: '●', unpublished: '○', announced: '◎', scheduled: '🕒',
  task_added: '☑', task_deleted: '🗑', task_restored: '↩', deleted: '🗑', restored: '↩', duplicated: '⧉',
  submitted: '➤', approved: '✓', changes_requested: '⚠' };
function ActivityCard({ eventId }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { getEventActivity(eventId).then((d) => setRows(d.activity || [])).catch(() => setRows([])); }, [eventId]);
  if (!rows) return null;
  return (
    <div style={{ ...card, marginTop: 16 }}>
      <h3 style={{ margin: '0 0 6px' }}>Activity &amp; audit log</h3>
      {rows.length === 0 && <p style={{ opacity: 0.6, fontSize: 13 }}>No activity yet.</p>}
      {rows.map((a) => (
        <div key={a.id} style={{ display: 'flex', gap: 11, padding: '9px 0', borderTop: '1px solid var(--border,#eee)' }}>
          <span style={{ width: 26, height: 26, borderRadius: 8, background: a.action.includes('delet') ? '#f6ddd7' : 'var(--surface-3,#f0eeeb)', display: 'grid', placeItems: 'center', fontSize: 13, flex: '0 0 auto' }}>{ACT_ICON[a.action] || '•'}</span>
          <div style={{ flex: 1, minWidth: 0, fontSize: 13.5 }}>
            <div><b>{a.actor_name || 'System'}</b> {a.action.replace(/_/g, ' ')}{a.detail ? <span style={{ opacity: 0.7 }}> — {a.detail}</span> : ''}</div>
            <div style={{ fontSize: 11.5, opacity: 0.5, marginTop: 2 }}>{fmtDT(a.created_at)}</div>
          </div>
        </div>
      ))}
      <div style={{ fontSize: 11.5, opacity: 0.55, marginTop: 10 }}>Every edit, publish, push, reminder and deletion is recorded. Deletions stay logged even after the item is restored.</div>
    </div>
  );
}

function PromoScoreCard({ eventId }) {
  const [sc, setSc] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { getPromoScore(eventId).then(setSc).catch((e) => setErr(e.message)); }, [eventId]);

  const rescore = async () => {
    setBusy(true); setErr('');
    try { setSc(await refreshPromoScore(eventId)); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  if (err) return <div style={{ ...card, marginTop: 16, color: '#b00' }}>{err}</div>;
  if (!sc) return <div style={{ ...card, marginTop: 16, opacity: 0.7 }}>Loading promotion score…</div>;

  const col = (v) => v == null ? '#9a8f88' : v >= 80 ? '#3f8f5b' : v >= 60 ? '#b0631f' : '#b83a2b';
  const compC = col(sc.composite);
  const FLAGC = { gold: '#3f8f5b', ok: '#b0631f', red: '#b83a2b' }[sc.coverage?.flag];
  const chUsed = sc.coverage ? (sc.coverage.basicHit + sc.coverage.premiumHit) : null;
  const chTotal = sc.coverage ? (sc.coverage.basicTot + sc.coverage.premiumTot) : null;
  const dim = (label, v, note) => (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
        <b>{label}</b><span style={{ fontWeight: 800, color: col(v) }}>{v == null ? '—' : v}</span>
      </div>
      <div style={{ height: 6, borderRadius: 4, background: 'var(--surface-3,#eee)', marginTop: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${v || 0}%`, background: col(v), borderRadius: 4 }} />
      </div>
      {note && <div style={{ fontSize: 11.5, color: 'var(--muted,#777)', marginTop: 3 }}>{note}</div>}
    </div>
  );

  return (
    <div style={{ ...card, marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>AI Promotion Score</h3>
        {chTotal != null && <span style={{ fontSize: 12.5, fontWeight: 700, color: FLAGC }}>{chUsed} of {chTotal} channels</span>}
        <span style={{ flex: 1 }} />
        <button style={{ ...btn(false), padding: '6px 12px', fontSize: 13 }} disabled={busy} onClick={rescore}>
          {busy ? 'Scoring…' : sc.ai_scored ? 'Re-score with AI' : 'Score with AI'}
        </button>
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <div style={{ flex: '0 0 108px', borderRadius: 10, background: compC, color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '14px 8px' }}>
          <div style={{ fontSize: 38, fontWeight: 800, lineHeight: 1 }}>{sc.composite}</div>
          <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.85, marginTop: 2 }}>/ 100</div>
          <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', opacity: 0.85, marginTop: 5 }}>Promo score</div>
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          {dim('Reach', sc.reach, `${sc.coverage?.basicHit}/${sc.coverage?.basicTot} basic · ${sc.coverage?.premiumHit}/${sc.coverage?.premiumTot} premium`)}
          {dim('Timing', sc.timing, sc.timing_note)}
          {dim('Image', sc.image, sc.image_note)}
          {dim('Message', sc.message, sc.message_note)}
        </div>
      </div>
      {!sc.ai_scored && <div style={{ fontSize: 12, color: 'var(--muted,#777)', marginTop: 8 }}>Image & Message are AI-judged — click “Score with AI” to fill them in.</div>}
    </div>
  );
}

function MessageTalentCard({ eventId }) {
  const [ctx, setCtx] = useState(null);
  const [body, setBody] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    getEventMessageContext(eventId)
      .then((d) => { setCtx(d); setTo(d.talent?.phone || ''); })
      .catch((e) => setErr(e.message));
  }, [eventId]);

  const send = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await sendEventMessage(eventId, body, to || undefined);
      setMsg(`Sent ✓${r.sid ? ` (${r.sid.slice(0, 10)}…)` : ''}`);
      setBody('');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const sendAllReminders = async () => {
    const tpls = ['month', 'week', 'day'].map((k) => ctx?.templates?.[k]).filter(Boolean);
    if (!tpls.length || !to.trim()) return;
    if (!window.confirm(`Send all ${tpls.length} reminder texts now to ${to}?`)) return;
    setBusy(true); setErr(''); setMsg('');
    let n = 0;
    try {
      for (const t of tpls) { await sendEventMessage(eventId, t, to || undefined); n++; }
      setMsg(`Sent ${n} reminder text${n === 1 ? '' : 's'} ✓`);
    } catch (e) { setErr(`Sent ${n} of ${tpls.length}. ${e.message}`); } finally { setBusy(false); }
  };

  const TPL = [['month', '1 month'], ['week', '1 week'], ['day', 'Day-before']];

  return (
    <div style={{ ...card, marginTop: 16 }}>
      <h3 style={{ margin: '0 0 4px' }}>Message talent <span style={{ opacity: 0.5, fontSize: 12, fontWeight: 400 }}>(send a text now)</span></h3>
      {ctx && !ctx.talent && <p style={{ fontSize: 13, color: '#b06000' }}>No talent assigned. You can still type a number below.</p>}
      {ctx?.talent && (
        <p style={{ fontSize: 13, opacity: 0.75, margin: '4px 0 8px' }}>
          To: <strong>{ctx.talent.name}</strong>{ctx.talent.phone ? ` · ${ctx.talent.phone}` : ' · (no phone on file)'}
        </p>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 12, opacity: 0.6, alignSelf: 'center' }}>Prefill a reminder:</span>
        {TPL.map(([k, label]) => (
          <button key={k} style={{ ...btn(false), padding: '4px 10px', fontSize: 12 }}
                  disabled={!ctx?.templates?.[k]} onClick={() => setBody(ctx.templates[k])}>{label}</button>
        ))}
        <button style={{ ...btn(false), padding: '4px 10px', fontSize: 12, borderColor: '#7c2d3a', color: '#7c2d3a' }}
                disabled={busy || !to.trim() || !ctx?.templates?.month} onClick={sendAllReminders}>
          Send all 3 now →
        </button>
      </div>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4}
                placeholder="Type a message, or prefill a reminder above…"
                style={{ ...inp, fontFamily: 'inherit', fontSize: 14 }} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12, opacity: 0.7 }}>Send to</label>
        <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="(208) 555-1234"
               style={{ ...inp, width: 180, padding: 7 }} />
        <button style={btn(true)} disabled={busy || !body.trim() || !to.trim()} onClick={send}>
          {busy ? 'Sending…' : 'Send text'}
        </button>
        {msg && <span style={{ color: '#137333', fontSize: 13 }}>{msg}</span>}
        {err && <span style={{ color: '#b00', fontSize: 13 }}>{err}</span>}
      </div>
    </div>
  );
}

function DistributionCard({ eventId, card }) {
  const [dist, setDist] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState(null);
  const [lead, setLead] = useState(21);

  const load = useCallback(() => {
    getEventDistribution(eventId)
      .then((d) => { setDist(d); if (d.announce_lead_days != null) setLead(d.announce_lead_days); })
      .catch((e) => setErr(e.message));
  }, [eventId]);
  useEffect(() => { load(); }, [load]);

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 4000); };
  const doAnnounce = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await announceEvent(eventId);
      const posted = (r.touched || []).filter((t) => t.action === 'posted').length;
      flash(posted ? `Pushed ${posted} channel${posted === 1 ? '' : 's'} now.` : 'No manual channels were pending to push.');
      load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const doSchedule = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await scheduleEventAnnounce(eventId, Number(lead));
      const n = (r.scheduled || []).length;
      flash(n ? `Scheduled ${n} auto channel${n === 1 ? '' : 's'} for ${lead} day${Number(lead) === 1 ? '' : 's'} before the event.` : 'No scheduled-mode channels to schedule (set channel modes in the settings tab).');
      load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const mark = async (postId, status, url) => {
    setBusy(true); setErr('');
    try { await markEventChannelPost(postId, { status, external_url: url }); load(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const toggleChannel = async (key, enabled) => {
    setErr('');
    // Optimistic — flip locally, then persist.
    setDist((d) => d && ({ ...d, channels: d.channels.map((c) => c.key === key ? { ...c, enabled } : c) }));
    try { await setEventChannelEnabled(eventId, key, enabled); }
    catch (e) { setErr(e.message); load(); }
  };
  const setAllChannels = async (enabled) => {
    if (!dist) return;
    const keys = dist.channels.filter((c) => !!c.enabled !== enabled).map((c) => c.key);
    if (!keys.length) return;
    setErr('');
    setDist((d) => d && ({ ...d, channels: d.channels.map((c) => ({ ...c, enabled })) }));
    try { await Promise.all(keys.map((k) => setEventChannelEnabled(eventId, k, enabled))); }
    catch (e) { setErr(e.message); } finally { load(); }
  };

  if (!dist) return null;

  const PILL = {
    posted:      { bg: '#e6f4ea', fg: '#137333', label: 'Posted' },
    scheduled:   { bg: '#e8f0fe', fg: '#1967d2', label: 'Scheduled' },
    queued:      { bg: '#fef7e0', fg: '#b06000', label: 'To do' },
    needs_human: { bg: '#fef7e0', fg: '#b06000', label: 'Needs setup' },
    stale:       { bg: '#fce8e6', fg: '#c5221f', label: 'Event changed' },
    failed:      { bg: '#fce8e6', fg: '#c5221f', label: 'Failed' },
    skipped:     { bg: '#f1f3f4', fg: '#5f6368', label: 'Skipped' },
    pending:     { bg: '#f1f3f4', fg: '#5f6368', label: 'Not started' },
  };
  const TIER = { auto: 'automatic', assisted: 'needs a person', outreach: 'email' };
  const MODE = { on_publish: '⚡ on publish', scheduled: '🕒 scheduled', manual: '✋ manual' };

  return (
    <div style={{ ...card, marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Distribution <span style={{ opacity: 0.5, fontSize: 12, fontWeight: 400 }}>(where this event has been announced)</span></h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, opacity: 0.7 }}>
            <input type="number" min="0" max="365" value={lead}
                   onChange={(e) => setLead(e.target.value)}
                   style={{ ...inp, width: 62, padding: 5, marginRight: 6 }} />
            days before
          </label>
          <button style={{ ...btn(false), padding: '6px 12px', fontSize: 13 }} onClick={doSchedule} disabled={busy}
                  title="Queues the 🕒 scheduled-mode channels to fire this many days before the event">
            Schedule 🕒
          </button>
          <button style={{ ...btn(true), padding: '6px 12px', fontSize: 13 }} onClick={doAnnounce} disabled={busy}>
            {busy ? 'Working…' : 'Push manual now'}
          </button>
        </div>
      </div>
      {err && <p style={{ color: '#b00', fontSize: 13 }}>{err}</p>}
      {msg && <p style={{ color: '#137a2f', fontSize: 13, fontWeight: 600, margin: '6px 0 0' }}>{msg}</p>}
      <p style={{ fontSize: 12, opacity: 0.6, margin: '6px 0 0' }}>
        <b>Push manual now</b> fires the ✋ manual channels immediately. <b>Schedule 🕒</b> queues the
        🕒 scheduled-mode channels to auto-fire the set number of days before the event. ⚡ on-publish
        channels fire on their own when the event goes live. Uncheck a channel to skip it for this
        event (remembered); set each channel’s mode in the settings tab.
      </p>

      <div style={{ display: 'flex', gap: 12, marginTop: 10, fontSize: 12 }}>
        <button type="button" onClick={() => setAllChannels(true)}
                style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', padding: 0, fontWeight: 600 }}>
          Select all
        </button>
        <button type="button" onClick={() => setAllChannels(false)}
                style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', padding: 0, fontWeight: 600 }}>
          Unselect all
        </button>
      </div>

      <div style={{ marginTop: 10 }}>
        {dist.channels.map((c) => {
          const p = PILL[c.status] ?? PILL.pending;
          return (
            <div key={c.key} style={{ borderTop: '1px solid var(--border,#eee)', padding: '10px 0', opacity: c.enabled ? 1 : 0.5 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <input type="checkbox" checked={!!c.enabled} onChange={(e) => toggleChannel(c.key, e.target.checked)}
                       title={c.enabled ? 'On for this event — uncheck to skip it' : 'Skipped for this event — check to include'}
                       style={{ cursor: 'pointer' }} />
                <span style={{ fontWeight: 600, minWidth: 140 }}>{c.name}</span>
                <span style={{ background: p.bg, color: p.fg, borderRadius: 20, padding: '2px 10px', fontSize: 12, fontWeight: 600 }}>{p.label}</span>
                <span style={{ fontSize: 12, opacity: 0.55 }}>{MODE[c.mode] || TIER[c.tier]}</span>
                {c.status === 'scheduled' && c.scheduled_at && (
                  <span style={{ fontSize: 12, opacity: 0.7 }}>
                    {fmtDT(c.scheduled_at)} · {c.lead_days}d before
                  </span>
                )}
                {c.external_url && <a href={c.external_url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>view ↗</a>}
                <span style={{ flex: 1 }} />
                {c.link && <a href={c.link} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>open ↗</a>}
                {c.copy && (
                  <button style={{ ...btn(false), padding: '3px 9px', fontSize: 12 }}
                          onClick={() => setOpen(open === c.key ? null : c.key)}>
                    {open === c.key ? 'Hide copy' : 'Copy text'}
                  </button>
                )}
                {c.post_id && c.status !== 'posted' && (
                  <button style={{ ...btn(false), padding: '3px 9px', fontSize: 12 }}
                          onClick={() => mark(c.post_id, 'posted', window.prompt('Link to the post (optional):') || null)}>
                    Mark posted
                  </button>
                )}
                {c.post_id && c.status === 'posted' && (
                  <button style={{ ...btn(false), padding: '3px 9px', fontSize: 12 }}
                          onClick={() => mark(c.post_id, 'queued')}>Undo</button>
                )}
              </div>
              {c.note && <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>{c.note}</div>}
              {c.status === 'stale' && (
                <div style={{ fontSize: 12, color: '#c5221f', marginTop: 4 }}>
                  The event changed after this was posted — update it there, then Announce again.
                </div>
              )}
              {open === c.key && c.copy && (
                <textarea readOnly value={c.copy} rows={6}
                          style={{ ...inp, marginTop: 8, fontFamily: 'inherit', fontSize: 13 }}
                          onFocus={(e) => e.target.select()} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const STAGE_META = {
  draft:     { label: 'Draft',     bg: '#eceae7', fg: '#6b625d' },
  review:    { label: 'In review', bg: '#f6e7d6', fg: '#a5631f' },
  approved:  { label: 'Approved',  bg: '#dcefec', fg: '#1f5b56' },
  published: { label: 'Live',      bg: '#e0f0e4', fg: '#2c6b42' },
};
const STAGE_ORDER = ['draft', 'review', 'approved', 'published'];

function WithdrawButton({ ev }) {
  const [phase, setPhase] = useState('idle'); // idle | working | verifying | done | timeout
  const [report, setReport] = useState(null);
  const [verify, setVerify] = useState(null);
  const [checks, setChecks] = useState(0);
  const [err, setErr] = useState('');

  const poll = async (n) => {
    try {
      const v = await verifyEventWithdrawn(ev.id);
      setVerify(v); setChecks(n + 1);
      if (v.confirmed) { setPhase('done'); return; }
      if (n < 7) setTimeout(() => poll(n + 1), 15000); else setPhase('timeout');
    } catch { if (n < 7) setTimeout(() => poll(n + 1), 15000); else setPhase('timeout'); }
  };
  const run = async () => {
    if (!window.confirm('Withdraw this event from the website, Google Business, Eventbrite and any pending push? It unpublishes the event and pulls down what was posted.')) return;
    setPhase('working'); setErr(''); setVerify(null); setChecks(0);
    try {
      const r = await withdrawEvent(ev.id);
      setReport(r.report); ev.stage = 'draft'; ev.status = 'draft';
      setPhase('verifying'); poll(0);
    } catch (e) { setErr(e.message); setPhase('idle'); }
  };

  const line = (label, val) => val ? <div key={label} style={{ fontSize: 12.5, padding: '2px 0' }}>• {val}</div> : null;
  return (
    <div style={{ ...card, marginBottom: 16, borderLeft: '4px solid #b83a2b' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <b>Withdraw / cancel event</b>
          <div style={{ fontSize: 12, color: 'var(--muted,#777)' }}>Pulls it from the website, Google, Eventbrite &amp; pending push, then confirms it's gone.</div>
        </div>
        <button onClick={run} disabled={phase === 'working' || phase === 'verifying'}
          style={{ padding: '9px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 700, background: '#b83a2b', color: '#fff' }}>
          {phase === 'working' ? 'Withdrawing…' : 'Withdraw everywhere'}
        </button>
      </div>
      {err && <p style={{ color: '#b00', fontSize: 13, margin: '8px 0 0' }}>{err}</p>}
      {report && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border,#eee)' }}>
          {['website', 'google', 'eventbrite', 'app_push', 'scheduled_channels', 'rebuild'].map((k) => line(k, report[k]))}
          <div style={{ marginTop: 8, fontWeight: 700, fontSize: 13 }}>
            {phase === 'verifying' && <span style={{ color: '#b0631f' }}>Verifying the live page is down… (check {checks || 1})</span>}
            {phase === 'done' && <span style={{ color: '#137a2f' }}>✓ Confirmed off the live site — the public page returns 404.</span>}
            {phase === 'timeout' && <span style={{ color: '#b0631f' }}>⚠ Live page still returns {verify?.live_status ?? '—'} after several checks — the static site may still be rebuilding or cached.{' '}
              <button onClick={() => { setPhase('verifying'); poll(0); }} style={{ ...btn(false), padding: '2px 8px', fontSize: 12 }}>Re-check</button></span>}
          </div>
          {verify?.url && <div style={{ fontSize: 11.5, marginTop: 4 }}><a href={verify.url} target="_blank" rel="noreferrer" style={{ color: 'var(--primary)' }}>open the public page ↗</a></div>}
        </div>
      )}
    </div>
  );
}

function ReadinessStrip({ ev }) {
  const [tasks, setTasks] = useState(null);
  const [score, setScore] = useState(null);
  useEffect(() => {
    getEventTasks(ev.id).then((t) => setTasks(Array.isArray(t) ? t : [])).catch(() => setTasks([]));
    getPromoScore(ev.id).then(setScore).catch(() => {});
  }, [ev.id]);

  const st = STAGE_META[stageOf(ev)] || STAGE_META.draft;
  const done = (tasks || []).filter((t) => t.done).length;
  const total = (tasks || []).length;
  const FLAG = { gold: { t: '★ Full reach', c: '#3f8f5b', bg: '#e0f0e4' }, ok: { t: '✓ Baseline', c: '#b0631f', bg: '#f6e7d6' }, red: { t: '🚩 Under-promoted', c: '#b83a2b', bg: '#f6ddd7' } };
  const gcol = (s) => s == null ? '#9a8f88' : s >= 80 ? '#3f8f5b' : s >= 60 ? '#b0631f' : '#b83a2b';

  const pill = (k, val, colBg, colFg) => (
    <div style={{ flex: '0 0 auto', border: '1px solid var(--border,#e3e3e3)', borderRadius: 10, padding: '7px 11px', display: 'flex', flexDirection: 'column', gap: 1, background: 'var(--card-bg,#fff)' }}>
      <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', opacity: 0.5 }}>{k}</span>
      <span style={{ fontSize: 12.5, fontWeight: 700, color: colFg }}>{val}</span>
    </div>
  );
  const flag = score?.coverage?.flag ? FLAG[score.coverage.flag] : null;
  const cov = score?.coverage;
  const chUsed = cov ? (cov.basicHit + cov.premiumHit) : null;
  const chTotal = cov ? (cov.basicTot + cov.premiumTot) : null;

  return (
    <div style={{ display: 'flex', gap: 8, overflowX: 'auto', marginBottom: 16, paddingBottom: 4 }}>
      {pill('Stage', st.label, null, st.fg)}
      {pill('Image', ev.image_url ? 'Set ✓' : 'Missing', null, ev.image_url ? '#3f8f5b' : '#b83a2b')}
      {pill('Talent', ev.musician_name || 'None', null, ev.musician_name ? '#3f8f5b' : '#847771')}
      {pill('Tasks', total ? `${done}/${total}` : '—', null, total && done === total ? '#3f8f5b' : total ? '#b0631f' : '#847771')}
      {pill('Reach', cov ? `${chUsed} of ${chTotal} channels` : '—', null, flag ? flag.c : '#847771')}
    </div>
  );
}

function ApprovalBar({ ev }) {
  const [stage, setStage] = useState(ev.stage || (ev.status === 'published' ? 'published' : 'draft'));
  const [reviewNotes, setReviewNotes] = useState(ev.review_notes || '');
  const [reqApproval, setReqApproval] = useState(true);
  const [compose, setCompose] = useState(null); // 'approve' | 'changes'
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { getSchedulingSettings().then((s) => setReqApproval(!!s.event_approval_required)).catch(() => {}); }, []);

  const run = async (fn, newStage, newNotes) => {
    setBusy(true); setErr('');
    try {
      await fn();
      setStage(newStage); ev.stage = newStage;
      if (newNotes !== undefined) { setReviewNotes(newNotes); ev.review_notes = newNotes; }
      if (newStage === 'published') ev.status = 'published';
      setCompose(null); setNotes('');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const idx = STAGE_ORDER.indexOf(stage);
  const stepBtn = { padding: '9px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 700, background: '#7c2d3a', color: '#fff' };
  const ghost = { padding: '9px 16px', borderRadius: 8, border: '1px solid var(--border,#ccc)', cursor: 'pointer', fontWeight: 600, background: 'transparent' };

  return (
    <div style={{ ...card, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {STAGE_ORDER.map((s, i) => {
          const m = STAGE_META[s]; const on = i <= idx;
          return (
            <span key={s} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, padding: '3px 11px', borderRadius: 20,
                background: on ? m.bg : 'transparent', color: on ? m.fg : 'var(--faint,#aaa)',
                border: i === idx ? `1.5px solid ${m.fg}` : '1px solid var(--border,#e3e3e3)' }}>{m.label}</span>
              {i < STAGE_ORDER.length - 1 && <span style={{ color: 'var(--faint,#bbb)' }}>→</span>}
            </span>
          );
        })}
        <span style={{ flex: 1 }} />
        {stage === 'draft' && (reqApproval
          ? <button style={stepBtn} disabled={busy} onClick={() => run(() => submitEventForReview(ev.id), 'review')}>Submit for review</button>
          : <button style={stepBtn} disabled={busy} onClick={() => run(() => publishEvent(ev.id), 'published')}>Publish</button>)}
        {stage === 'review' && <>
          <button style={ghost} disabled={busy} onClick={() => setCompose(compose === 'changes' ? null : 'changes')}>Request changes</button>
          <button style={stepBtn} disabled={busy} onClick={() => setCompose(compose === 'approve' ? null : 'approve')}>Approve</button>
        </>}
        {stage === 'approved' && <button style={stepBtn} disabled={busy} onClick={() => run(() => publishEvent(ev.id), 'published')}>Publish now</button>}
        {stage === 'published' && <span style={{ fontSize: 13, color: '#2c6b42', fontWeight: 700 }}>● Live on the website</span>}
      </div>

      {compose && (
        <div style={{ marginTop: 12 }}>
          <textarea style={{ ...inp, minHeight: 64 }} placeholder={compose === 'approve' ? 'Optional notes for the creator…' : 'What needs to change? (sent to the creator)'} value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            {compose === 'approve'
              ? <button style={stepBtn} disabled={busy} onClick={() => run(() => approveEvent(ev.id, notes), 'approved', notes || '')}>Approve event</button>
              : <button style={{ ...stepBtn, background: '#a5631f' }} disabled={busy || !notes.trim()} onClick={() => run(() => requestEventChanges(ev.id, notes), 'draft', notes || '')}>Send back with changes</button>}
            <button style={ghost} onClick={() => { setCompose(null); setNotes(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {reviewNotes && stage !== 'review' && (
        <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: 'var(--surface-2,#faf6f3)', border: '1px solid var(--border,#e3e3e3)', fontSize: 13 }}>
          <b>Reviewer notes:</b> {reviewNotes}
        </div>
      )}
      {err && <p style={{ color: '#b00', fontSize: 13, marginBottom: 0 }}>{err}</p>}
    </div>
  );
}

function EventDetail({ ev, users, musicians, locations, onBack }) {
  const [tab, setTab] = useState('overview');
  const [notes, setNotes] = useState(ev.internal_notes || '');
  const [tasks, setTasks] = useState([]);
  const [nt, setNt] = useState({ checklist: 'Final Checklist', title: '', assignee_user_id: '', due_date: '', reminder_date: '' });
  const [editTask, setEditTask] = useState(null); // { id, title } — inline task rename
  const [editList, setEditList] = useState(null); // { old, name } — inline checklist rename
  const [savedNotes, setSavedNotes] = useState(false);
  const [promo, setPromo] = useState([]);
  const [np, setNp] = useState({ title: 'Post to Facebook Events', channel: 'facebook_event', assignee_user_id: '', escalate_to: [] });
  const [emails, setEmails] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [ne, setNe] = useState({ contact_id: '', template_id: '', send_at: '' });
  const [pkg, setPkg] = useState(false);
  const toLocal = toLocalInput; // see the note on toLocalInput — stored time is wall clock
  const [f, setF] = useState({
    title: ev.title || '', description: ev.description || '', musician_id: ev.musician_id || '', location_id: ev.location_id || '',
    start_at: toLocal(ev.start_at), end_at: toLocal(ev.end_at), cost: ev.cost ?? '', category: ev.category || '', status: ev.status || 'draft', image_url: ev.image_url || '', social_image_url: ev.social_image_url || '', fb_image_url: ev.fb_image_url || '',
  });
  const [savedD, setSavedD] = useState(false);
  const setField = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const saveDetails = async () => {
    const body = {};
    for (const k of ['title', 'description', 'musician_id', 'location_id', 'start_at', 'end_at', 'cost', 'category', 'status', 'image_url', 'social_image_url', 'fb_image_url']) body[k] = f[k] === '' ? null : f[k];
    await updateEvent(ev.id, body); setSavedD(true); setTimeout(() => setSavedD(false), 1200);
  };
  const loadTasks = () => getEventTasks(ev.id).then((t) => setTasks(Array.isArray(t) ? t : [])).catch(() => {});
  const loadPromo = () => getPromoTasks(ev.id).then((p) => setPromo(Array.isArray(p) ? p : [])).catch(() => {});
  const loadEmails = () => getEventEmails(ev.id).then((x) => setEmails(Array.isArray(x) ? x : [])).catch(() => {});
  useEffect(() => { loadTasks(); loadPromo(); loadEmails(); }, [ev.id]);
  useEffect(() => { getContacts().then((c) => setContacts(Array.isArray(c) ? c : [])).catch(() => {}); getTemplates().then((t) => setTemplates(Array.isArray(t) ? t : [])).catch(() => {}); }, []);
  const addEmail = async () => { if (!ne.contact_id || !ne.send_at) return; await createEventEmail(ev.id, ne); setNe({ contact_id: '', template_id: '', send_at: '' }); loadEmails(); };
  const delEmail = async (id) => { await deleteEventEmail(id); loadEmails(); };
  const sendNow = async (id) => { await sendEventEmailNow(id); loadEmails(); };
  const addPromo = async () => { if (!np.title.trim()) return; await createPromoTask(ev.id, np); setNp({ ...np, title: '' }); loadPromo(); };
  const togglePromo = async (t) => { await updatePromoTask(t.id, { done: !t.done }); loadPromo(); };
  const delPromo = async (t) => { await deletePromoTask(t.id); loadPromo(); };
  const toggleEsc = (uid) => setNp((n) => ({ ...n, escalate_to: n.escalate_to.includes(uid) ? n.escalate_to.filter((x) => x !== uid) : [...n.escalate_to, uid] }));

  const saveNotes = async () => { await updateEvent(ev.id, { internal_notes: notes }); setSavedNotes(true); setTimeout(() => setSavedNotes(false), 1200); };
  const addTask = async () => { if (!nt.title.trim()) return; await createEventTask(ev.id, { ...nt, due_date: nt.due_date || null, reminder_date: nt.reminder_date || null }); setNt({ ...nt, title: '', due_date: '', reminder_date: '' }); loadTasks(); };
  const toggle = async (t) => { await updateEventTask(t.id, { done: !t.done }); loadTasks(); };
  const assign = async (t, uid) => { await updateEventTask(t.id, { assignee_user_id: uid || null }); loadTasks(); };
  const del = async (t) => { if (window.confirm(`Delete “${t.title}”?`)) { await deleteEventTask(t.id); loadTasks(); } };
  const startEdit = (t) => setEditTask({ id: t.id, title: t.title, due_date: t.due_date ? t.due_date.slice(0, 10) : '', reminder_date: t.reminder_date ? t.reminder_date.slice(0, 10) : '' });
  const saveTaskEdit = async () => {
    if (!editTask || !editTask.title.trim()) return;
    await updateEventTask(editTask.id, { title: editTask.title.trim(), due_date: editTask.due_date || null, reminder_date: editTask.reminder_date || null });
    setEditTask(null); loadTasks();
  };
  const renameList = async () => {
    if (!editList) { return; }
    const name = editList.name.trim();
    if (name && name !== editList.old) {
      await Promise.all(tasks.filter((t) => t.checklist === editList.old).map((t) => updateEventTask(t.id, { checklist: name })));
    }
    setEditList(null); loadTasks();
  };
  const deleteList = async (name) => {
    const items = tasks.filter((t) => t.checklist === name);
    if (!window.confirm(`Delete the “${name}” checklist and its ${items.length} item${items.length === 1 ? '' : 's'}?`)) return;
    await Promise.all(items.map((t) => deleteEventTask(t.id)));
    loadTasks();
  };
  const fmtDue = (d) => { if (!d) return ''; const dt = new Date(d.slice(0, 10) + 'T00:00'); return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
  // Reorder siblings by rewriting sort_order to match the new positions.
  const reorder = async (siblings, from, to) => {
    if (to < 0 || to >= siblings.length) return;
    const arr = siblings.slice();
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    await Promise.all(arr.map((t, i) => (t.sort_order !== i ? updateEventTask(t.id, { sort_order: i }) : null)).filter(Boolean));
    loadTasks();
  };
  const addSub = async (parent) => {
    const r = await createEventTask(ev.id, { checklist: parent.checklist, title: 'New subtask', parent_task_id: parent.id });
    await loadTasks();
    if (r?.id) setEditTask({ id: r.id, title: 'New subtask', due_date: '', reminder_date: '' });
  };
  const renderRow = (t, siblings, index, isChild) => (
    <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', flexWrap: 'wrap', marginLeft: isChild ? 26 : 0 }}>
      <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 0.7 }}>
        <button title="Move up" style={{ ...btn(false), padding: '0 5px', fontSize: 10, opacity: index === 0 ? 0.3 : 1 }} onClick={() => reorder(siblings, index, index - 1)}>▲</button>
        <button title="Move down" style={{ ...btn(false), padding: '0 5px', fontSize: 10, opacity: index === siblings.length - 1 ? 0.3 : 1 }} onClick={() => reorder(siblings, index, index + 1)}>▼</button>
      </span>
      <input type="checkbox" checked={t.done} onChange={() => toggle(t)} />
      {editTask && editTask.id === t.id ? (
        <>
          <input autoFocus style={{ ...inp, flex: 1, minWidth: 140, padding: '3px 6px', fontSize: 13 }} value={editTask.title}
            onChange={(e) => setEditTask({ ...editTask, title: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') saveTaskEdit(); if (e.key === 'Escape') setEditTask(null); }} />
          <label style={{ fontSize: 11, opacity: 0.6 }}>Due <input type="date" style={{ ...inp, width: 'auto', padding: '3px 6px', fontSize: 12 }} value={editTask.due_date} onChange={(e) => setEditTask({ ...editTask, due_date: e.target.value })} /></label>
          <label style={{ fontSize: 11, opacity: 0.6 }}>Remind from <input type="date" style={{ ...inp, width: 'auto', padding: '3px 6px', fontSize: 12 }} value={editTask.reminder_date} onChange={(e) => setEditTask({ ...editTask, reminder_date: e.target.value })} /></label>
          <button style={{ ...btn(true), padding: '2px 8px', fontSize: 12 }} onClick={saveTaskEdit}>Save</button>
          <button style={{ ...btn(false), padding: '2px 8px', fontSize: 12 }} onClick={() => setEditTask(null)}>Cancel</button>
        </>
      ) : (
        <>
          <span style={{ flex: 1, minWidth: 120, textDecoration: t.done ? 'line-through' : 'none', opacity: t.done ? 0.55 : 1 }}>
            {t.title}
            {t.due_date && <span style={{ fontSize: 11, opacity: 0.7, marginLeft: 6 }}>· due {fmtDue(t.due_date)}</span>}
            {t.reminder_date && !t.done && <span title={`Texts the assignee daily from ${fmtDue(t.reminder_date)} until checked off`} style={{ fontSize: 11, opacity: 0.7, marginLeft: 6 }}>🔔</span>}
          </span>
          {!isChild && <button title="Add subtask" style={{ ...btn(false), padding: '2px 8px', fontSize: 12 }} onClick={() => addSub(t)}>+ sub</button>}
          <button title="Edit item" style={{ ...btn(false), padding: '2px 8px' }} onClick={() => startEdit(t)}>✎</button>
          <select value={t.assignee_user_id || ''} onChange={(e) => assign(t, e.target.value)} style={{ ...inp, width: 'auto', padding: '3px 6px', fontSize: 12 }}>
            <option value="">unassigned</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
          </select>
          <button title="Delete item" style={{ ...btn(false), padding: '2px 8px' }} onClick={() => del(t)}>✕</button>
        </>
      )}
    </div>
  );

  const groups = {};
  for (const t of tasks) (groups[t.checklist] ??= []).push(t);
  const checklistNames = [...new Set([...Object.keys(groups), 'Final Checklist', 'Setup', 'Day-of'])];

  return (
    <div>
      <button style={{ ...btn(false), marginBottom: 12 }} onClick={onBack}>✕ Close</button>
      <ReadinessStrip ev={ev} />
      <ApprovalBar ev={ev} />
      {stageOf(ev) === 'published' && <WithdrawButton ev={ev} />}

      <div style={{ display: 'flex', gap: 2, marginBottom: 16, borderBottom: '1px solid var(--border,#e3e3e3)', overflowX: 'auto' }}>
        {[['overview', 'Overview'], ['prep', `Prep${tasks.length ? ` (${tasks.filter((t) => t.done).length}/${tasks.length})` : ''}`], ['promote', 'Promote'], ['talent', 'Talent'], ['activity', 'Activity']].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{ border: 'none', background: 'transparent', padding: '10px 14px', fontWeight: 600, fontSize: 14, cursor: 'pointer', whiteSpace: 'nowrap', color: tab === k ? '#7c2d3a' : 'var(--muted,#888)', borderBottom: tab === k ? '2.5px solid #7c2d3a' : '2.5px solid transparent', marginBottom: -1 }}>{l}</button>
        ))}
      </div>

      {tab === 'overview' && (
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
            <ImageField
              value={f.image_url}
              onChange={(url) => { setField('image_url', url); updateEvent(ev.id, { image_url: url || null }); }}
            />
            <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6, lineHeight: 1.5 }}>
                Best at <b>2400 × 1000</b> (2.4:1 cinematic), JPG or PNG, under 8 MB. The event page
                shows the full 2.4:1 frame; the home-page tile crops to a 3:2 centre — so keep the
                subject centred and important detail away from the far edges.
              </div>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={lbl}>Email &amp; Google image <span style={{ opacity: 0.5, fontWeight: 400 }}>(landscape 1200×900 for Google Business, Facebook &amp; marketing emails)</span></label>
            <ImageField
              value={f.social_image_url}
              onChange={(url) => { setField('social_image_url', url); updateEvent(ev.id, { social_image_url: url || null }); }}
            />
            <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6, lineHeight: 1.5 }}>
              Best at <b>1200 × 900</b> (4:3 landscape), JPG or PNG, under 8 MB. Used for Google
              Business posts, Facebook, and marketing emails — these formats want landscape. This
              does <b>not</b> change the website; the event page keeps using the Photo above.
            </div>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={lbl}>Facebook cover &amp; share image <span style={{ opacity: 0.5, fontWeight: 400 }}>(1920×1005 for the Facebook event cover &amp; link preview)</span></label>
            <ImageField
              value={f.fb_image_url}
              onChange={(url) => { setField('fb_image_url', url); updateEvent(ev.id, { fb_image_url: url || null }); }}
            />
            <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6, lineHeight: 1.5 }}>
              Best at <b>1920 × 1005</b> (Facebook event cover), JPG or PNG, under 8 MB. Also used as
              the link-share preview whenever the event URL is posted (Facebook, iMessage, etc.); it
              is resized automatically for that — no separate upload needed.
            </div>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <button style={btn(true)} onClick={saveDetails}>Save details</button>
          {savedD && <span style={{ marginLeft: 10, color: '#137a2f', fontWeight: 600 }}>✓ saved</span>}
        </div>
      </div>
      )}

      {tab === 'prep' && (<>
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Checklists &amp; tasks <span style={{ opacity: 0.5, fontSize: 12, fontWeight: 400 }}>(internal)</span></h3>
        {Object.keys(groups).length === 0 && <p style={{ opacity: 0.6 }}>No items yet — add one below.</p>}
        {Object.entries(groups).map(([name, items]) => (
          <div key={name} style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              {editList && editList.old === name ? (
                <>
                  <input autoFocus style={{ ...inp, width: 180, padding: '3px 6px', fontSize: 13 }} value={editList.name}
                    onChange={(e) => setEditList({ ...editList, name: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') renameList(); if (e.key === 'Escape') setEditList(null); }} />
                  <button style={{ ...btn(true), padding: '2px 8px', fontSize: 12 }} onClick={renameList}>Save</button>
                  <button style={{ ...btn(false), padding: '2px 8px', fontSize: 12 }} onClick={() => setEditList(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <span style={{ fontWeight: 700, fontSize: 13, opacity: 0.85 }}>{name} <span style={{ fontWeight: 400, opacity: 0.6 }}>({items.filter((i) => i.done).length}/{items.length})</span></span>
                  <button title="Rename checklist" style={{ ...btn(false), padding: '1px 7px', fontSize: 12 }} onClick={() => setEditList({ old: name, name })}>✎</button>
                  <button title="Delete checklist" style={{ ...btn(false), padding: '1px 7px', fontSize: 12 }} onClick={() => deleteList(name)}>🗑</button>
                </>
              )}
            </div>
            {items.filter((t) => !t.parent_task_id).map((top, ti, tops) => (
              <div key={top.id}>
                {renderRow(top, tops, ti, false)}
                {items.filter((c) => c.parent_task_id === top.id).map((ch, ci, kids) => renderRow(ch, kids, ci, true))}
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
          <div><label style={lbl}>Due</label>
            <input type="date" style={{ ...inp, width: 150 }} value={nt.due_date} onChange={(e) => setNt({ ...nt, due_date: e.target.value })} />
          </div>
          <div><label style={lbl}>Remind from</label>
            <input type="date" style={{ ...inp, width: 150 }} value={nt.reminder_date} onChange={(e) => setNt({ ...nt, reminder_date: e.target.value })} />
          </div>
          <div><label style={lbl}>Assign</label>
            <select style={{ ...inp, width: 140 }} value={nt.assignee_user_id} onChange={(e) => setNt({ ...nt, assignee_user_id: e.target.value })}>
              <option value="">unassigned</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
            </select>
          </div>
          <button style={btn(true)} onClick={addTask} disabled={!nt.title.trim()}>Add</button>
        </div>
        <p style={{ fontSize: 11, opacity: 0.6, marginTop: 8 }}>Set a <b>Remind from</b> date and an assignee, and they get a text every day from that date until the item is checked off.</p>
      </div>

      <div style={{ ...card, marginTop: 16 }}>
        <HtmlDesc value={notes} onChange={setNotes} label="Internal notes" hint="stays in TeamHub — never sent to the website" />
        <div style={{ marginTop: 8 }}>
          <button style={btn(true)} onClick={saveNotes}>Save notes</button>
          {savedNotes && <span style={{ color: '#137a2f', fontSize: 12, marginLeft: 10 }}>✓ saved</span>}
        </div>
      </div>
      </>)}

      {tab === 'talent' && <MessageTalentCard eventId={ev.id} />}

      {tab === 'promote' && (<>
      <DistributionCard eventId={ev.id} card={card} />

      <PromoScoreCard eventId={ev.id} />

      <div style={{ ...card, marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>Promotion <span style={{ opacity: 0.5, fontSize: 12, fontWeight: 400 }}>(escalating reminders)</span></h3>
          <button style={{ ...btn(false), padding: '4px 10px', fontSize: 12 }} onClick={() => setPkg((p) => !p)}>📦 {pkg ? 'Hide package' : 'Package for posting'}</button>
        </div>
        {pkg && <PostPackage ev={ev} />}
        <p style={{ fontSize: 12, opacity: 0.65, marginTop: 12 }}>The assignee is texted at <b>1 month / 3 weeks / 2 weeks / 1 week</b> before the event until they mark it done. From <b>2 weeks</b> out, an incomplete task also texts the escalation group + managers.</p>
        {promo.length === 0 && <p style={{ opacity: 0.6 }}>No promotion tasks yet — add one below (e.g. "Post to Facebook Events").</p>}
        {promo.map((t) => (
          <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid var(--border,#eee)' }}>
            <input type="checkbox" checked={t.done} onChange={() => togglePromo(t)} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, textDecoration: t.done ? 'line-through' : 'none', opacity: t.done ? 0.55 : 1 }}>{t.title}</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>{t.assignee_name ? `→ ${t.assignee_name}` : 'unassigned'}{t.done ? ' · done ✓' : ((t.reminders_sent || []).length ? ` · ${(t.reminders_sent || []).length} reminder(s) sent` : ' · reminders scheduled')}</div>
            </div>
            <button style={{ ...btn(false), padding: '2px 8px' }} onClick={() => delPromo(t)}>✕</button>
          </div>
        ))}
        <div style={{ marginTop: 12, borderTop: '1px solid var(--border,#eee)', paddingTop: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 10 }}>
            <div><label style={lbl}>Task</label>
              <input list="promo-presets" style={inp} value={np.title} onChange={(e) => setNp({ ...np, title: e.target.value })} />
              <datalist id="promo-presets"><option value="Post to Facebook Events" /><option value="Post to Instagram" /><option value="Post to TikTok" /><option value="Email Destination Caldwell" /><option value="Submit to Idaho Press calendar" /><option value="Update Bandsintown" /><option value="Submit to Eventbrite" /></datalist>
            </div>
            <div><label style={lbl}>Assignee (marketing)</label>
              <select style={inp} value={np.assignee_user_id} onChange={(e) => setNp({ ...np, assignee_user_id: e.target.value })}>
                <option value="">— select —</option>{users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
              </select>
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <label style={lbl}>Escalation group <span style={{ opacity: 0.5, fontWeight: 400 }}>(also texted from 2 weeks out; managers always included)</span></label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 4 }}>
              {users.map((u) => (
                <label key={u.id} style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input type="checkbox" checked={np.escalate_to.includes(u.id)} onChange={() => toggleEsc(u.id)} />{u.display_name}
                </label>
              ))}
            </div>
          </div>
          <button style={{ ...btn(true), marginTop: 12 }} disabled={!np.title.trim()} onClick={addPromo}>Add promotion task</button>
        </div>

        <div style={{ marginTop: 18, borderTop: '2px solid var(--border,#eee)', paddingTop: 14 }}>
          <h4 style={{ margin: '0 0 4px' }}>Scheduled emails <span style={{ opacity: 0.5, fontSize: 12, fontWeight: 400 }}>(auto-sent to contacts)</span></h4>
          <p style={{ fontSize: 12, opacity: 0.65, marginTop: 0 }}>Emails a contact from a template on the chosen date (e.g. schedule Sep 9 for a Nov 9 event). Manage contacts &amp; templates on the Promotion tab.</p>
          {emails.length === 0 && <p style={{ opacity: 0.6, fontSize: 13 }}>None scheduled.</p>}
          {emails.map((m) => (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: '1px solid var(--border,#eee)', fontSize: 13 }}>
              <div style={{ flex: 1 }}>
                <b>{m.contact_name}</b>{m.org ? ` (${m.org})` : ''} · {m.template_name || 'no template'}
                <div style={{ opacity: 0.7, fontSize: 12 }}>{new Date(m.send_at).toLocaleDateString()} · <span style={{ color: m.status === 'sent' ? '#137a2f' : m.status === 'failed' ? '#c0392b' : '#999' }}>{m.status}{m.error ? `: ${m.error}` : ''}</span></div>
              </div>
              {m.status !== 'sent' && <button style={{ ...btn(false), padding: '2px 8px', fontSize: 12 }} onClick={() => sendNow(m.id)}>Send now</button>}
              <button style={{ ...btn(false), padding: '2px 8px' }} onClick={() => delEmail(m.id)}>✕</button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 10 }}>
            <div><label style={lbl}>Contact</label>
              <select style={{ ...inp, minWidth: 160 }} value={ne.contact_id} onChange={(e) => setNe({ ...ne, contact_id: e.target.value })}>
                <option value="">— select —</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}{c.org ? ` (${c.org})` : ''}</option>)}
              </select>
            </div>
            <div><label style={lbl}>Template</label>
              <select style={{ ...inp, minWidth: 150 }} value={ne.template_id} onChange={(e) => setNe({ ...ne, template_id: e.target.value })}>
                <option value="">— none —</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div><label style={lbl}>Send date</label><input type="date" style={inp} value={ne.send_at} onChange={(e) => setNe({ ...ne, send_at: e.target.value })} /></div>
            <button style={btn(true)} disabled={!ne.contact_id || !ne.send_at} onClick={addEmail}>Schedule</button>
          </div>
        </div>
      </div>
      </>)}

      {tab === 'activity' && <ActivityCard eventId={ev.id} />}
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
              {evs.slice(0, 4).map((e) => {
                const vc = venueColor(e.location_name); const live = stageOf(e) === 'published';
                return <div key={e.id} onClick={() => onOpen(e)} title={e.title} style={{ cursor: 'pointer', borderLeft: `3px solid ${vc}`, background: live ? `${vc}22` : 'var(--surface-3,#eef0f4)', color: 'inherit', opacity: live ? 1 : 0.72, borderRadius: 4, padding: '1px 5px', marginTop: 2, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.musician_name || e.title}</div>;
              })}
              {evs.length > 4 && <div style={{ opacity: 0.5, marginTop: 2 }}>+{evs.length - 4} more</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HtmlDesc({ value, onChange, label = 'Description', hint = 'shows on the website' }) {
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
        <label style={lbl}>{label} <span style={{ opacity: 0.5, fontWeight: 400 }}>({hint})</span></label>
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

function PromoTab() {
  const [sub, setSub] = useState('overview');
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {[['overview', 'Overview'], ['contacts', 'Contacts'], ['templates', 'Email templates']].map(([k, l]) => (
          <button key={k} onClick={() => setSub(k)} style={{ ...btn(sub === k), borderRadius: 16, padding: '5px 12px', fontSize: 13 }}>{l}</button>
        ))}
      </div>
      {sub === 'overview' ? <OverviewSub /> : sub === 'contacts' ? <ContactsSub /> : <TemplatesSub />}
    </div>
  );
}

function OverviewSub() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { getPromoOverview().then(setData).catch((e) => setErr(e.message)); }, []);
  if (err) return <p style={{ color: 'crimson' }}>{err}</p>;
  if (!data) return <p>Loading…</p>;
  const evName = { month: 'numeric', day: 'numeric' };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 16 }}>
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Scheduled emails <span style={{ opacity: 0.5, fontSize: 12, fontWeight: 400 }}>({data.emails.length})</span></h3>
        {data.emails.length === 0 && <p style={{ opacity: 0.6, fontSize: 13 }}>None scheduled across upcoming events.</p>}
        {data.emails.map((m) => (
          <div key={m.id} style={{ padding: '6px 0', borderTop: '1px solid var(--border,#eee)', fontSize: 13 }}>
            <div><b>{new Date(m.send_at).toLocaleDateString(undefined, evName)}</b> → {m.contact_name}{m.org ? ` (${m.org})` : ''} <span style={{ color: m.status === 'sent' ? '#137a2f' : m.status === 'failed' ? '#c0392b' : '#999', fontSize: 11 }}>[{m.status}]</span></div>
            <div style={{ opacity: 0.7, fontSize: 12 }}>{m.event_title} · {new Date(m.start_at).toLocaleDateString(undefined, evName)}{m.template_name ? ` · ${m.template_name}` : ''}</div>
          </div>
        ))}
      </div>
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Open promotion tasks <span style={{ opacity: 0.5, fontSize: 12, fontWeight: 400 }}>({data.tasks.length})</span></h3>
        {data.tasks.length === 0 && <p style={{ opacity: 0.6, fontSize: 13 }}>Nothing outstanding.</p>}
        {data.tasks.map((t) => (
          <div key={t.id} style={{ padding: '6px 0', borderTop: '1px solid var(--border,#eee)', fontSize: 13 }}>
            <div><b>{t.title}</b>{t.assignee_name ? ` → ${t.assignee_name}` : ' (unassigned)'}{(t.reminders_sent || []).length ? <span style={{ opacity: 0.6, fontSize: 11 }}> · {(t.reminders_sent || []).length} reminder(s) sent</span> : ''}</div>
            <div style={{ opacity: 0.7, fontSize: 12 }}>{t.event_title} · {new Date(t.start_at).toLocaleDateString(undefined, evName)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ContactsSub() {
  const [list, setList] = useState([]);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState('');
  const load = () => getContacts().then((c) => setList(Array.isArray(c) ? c : [])).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const blank = { name: '', org: '', email: '', phone: '', website: '', role: '', notes: '' };
  const save = async () => { try { if (form.id) await updateContact(form.id, form); else await createContact(form); setForm(null); load(); } catch (e) { setErr(e.message); } };
  const del = async (id) => { if (window.confirm('Delete contact?')) { await deleteContact(id); load(); } };
  return (
    <div>
      {!form && <button style={btn(true)} onClick={() => setForm({ ...blank })}>+ Add contact</button>}
      {err && <p style={{ color: 'crimson' }}>{err}</p>}
      {form && (
        <div style={{ ...card, margin: '12px 0' }}>
          <h3 style={{ marginTop: 0 }}>{form.id ? 'Edit' : 'New'} contact</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 10 }}>
            {[['name', 'Name'], ['org', 'Organization'], ['email', 'Email'], ['phone', 'Phone'], ['website', 'Website'], ['role', 'Role / title']].map(([k, l]) => (
              <div key={k}><label style={lbl}>{l}</label><input style={inp} value={form[k] || ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></div>
            ))}
            <div style={{ gridColumn: '1 / -1' }}><label style={lbl}>Notes</label><textarea rows={2} style={inp} value={form.notes || ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
          </div>
          <div style={{ marginTop: 10 }}><button style={btn(true)} disabled={!form.name} onClick={save}>Save</button><button style={{ ...btn(false), marginLeft: 8 }} onClick={() => setForm(null)}>Cancel</button></div>
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        {list.length === 0 && <p style={{ opacity: 0.6 }}>No contacts yet — add orgs you notify (e.g. Mary Smith @ Destination Caldwell).</p>}
        {list.map((c) => (
          <div key={c.id} style={{ ...card, marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div onClick={() => setForm({ ...c })} style={{ cursor: 'pointer', flex: 1 }}>
              <div style={{ fontWeight: 700 }}>{c.name}{c.org ? ` · ${c.org}` : ''}</div>
              <div style={{ fontSize: 13, opacity: 0.7 }}>{c.email || 'no email'}{c.role ? ` · ${c.role}` : ''}</div>
            </div>
            <button style={{ ...btn(false), padding: '4px 10px' }} onClick={() => del(c.id)}>Delete</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function TemplatesSub() {
  const [list, setList] = useState([]);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState('');
  const load = () => getTemplates().then((t) => setList(Array.isArray(t) ? t : [])).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const blank = { name: '', subject: '', body_html: '' };
  const save = async () => { try { if (form.id) await updateTemplate(form.id, form); else await createTemplate(form); setForm(null); load(); } catch (e) { setErr(e.message); } };
  const del = async (id) => { if (window.confirm('Delete template?')) { await deleteTemplate(id); load(); } };
  return (
    <div>
      {!form && <button style={btn(true)} onClick={() => setForm({ ...blank })}>+ New template</button>}
      {err && <p style={{ color: 'crimson' }}>{err}</p>}
      {form && (
        <div style={{ ...card, margin: '12px 0' }}>
          <h3 style={{ marginTop: 0 }}>{form.id ? 'Edit' : 'New'} email template</h3>
          <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 10, background: 'var(--card-bg,#f6f6f6)', border: '1px solid var(--border,#eee)', padding: 8, borderRadius: 8 }}>
            Tags: <code>{'{contact}'}</code> <code>{'{org}'}</code> <code>{'{event}'}</code> <code>{'{date}'}</code> <code>{'{time}'}</code> <code>{'{location}'}</code> <code>{'{description}'}</code> <code>{'{link}'}</code> <code>{'{image}'}</code>
          </div>
          <div><label style={lbl}>Template name</label><input style={inp} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div style={{ marginTop: 10 }}><label style={lbl}>Subject</label><input style={inp} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="Kindred event: {event} on {date}" /></div>
          <div style={{ marginTop: 10 }}><HtmlDesc value={form.body_html} onChange={(v) => setForm({ ...form, body_html: v })} label="Email body" hint="tags allowed" /></div>
          <div style={{ marginTop: 10 }}><button style={btn(true)} disabled={!form.name || !form.subject} onClick={save}>Save</button><button style={{ ...btn(false), marginLeft: 8 }} onClick={() => setForm(null)}>Cancel</button></div>
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        {list.length === 0 && <p style={{ opacity: 0.6 }}>No email templates yet.</p>}
        {list.map((t) => (
          <div key={t.id} style={{ ...card, marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div onClick={() => setForm({ ...t })} style={{ cursor: 'pointer', flex: 1 }}>
              <div style={{ fontWeight: 700 }}>{t.name}</div>
              <div style={{ fontSize: 13, opacity: 0.7 }}>{t.subject}</div>
            </div>
            <button style={{ ...btn(false), padding: '4px 10px' }} onClick={() => del(t.id)}>Delete</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function PostPackage({ ev }) {
  const [copied, setCopied] = useState('');
  const plain = (ev.description || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
  const when = fmtDT(ev.start_at);
  const where = ev.location_name || '';
  const caption = `${ev.title}\n${when}${where ? ` · ${where}` : ''}${ev.cost != null ? ` · $${ev.cost}` : ''}\n\n${plain}`;
  const gImg = ev.social_image_url || ev.image_url;
  const copy = (t, k) => { navigator.clipboard?.writeText(t || ''); setCopied(k); setTimeout(() => setCopied(''), 1200); };
  const Row = ({ k, label, val }) => (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 0', borderTop: '1px solid var(--border,#eee)' }}>
      <div style={{ width: 84, fontSize: 12, opacity: 0.6, flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1, fontSize: 13, whiteSpace: 'pre-wrap' }}>{val || '—'}</div>
      <button style={{ ...btn(false), padding: '2px 8px', fontSize: 11, flexShrink: 0 }} onClick={() => copy(val, k)}>{copied === k ? '✓' : 'Copy'}</button>
    </div>
  );
  const lnk = { ...btn(false), textDecoration: 'none', fontSize: 12, padding: '5px 10px' };
  return (
    <div style={{ marginTop: 12, background: 'var(--card-bg,#fafafa)', border: '1px solid var(--border,#eee)', borderRadius: 8, padding: 12 }}>
      <p style={{ fontSize: 12, opacity: 0.7, marginTop: 0 }}>Copy-ready bundle for manual posting (Facebook Event, Google Business, web forms). Facebook Events must be created by hand — this makes it ~30 seconds.</p>
      <Row k="t" label="Title" val={ev.title} />
      <Row k="w" label="When" val={when} />
      <Row k="l" label="Where" val={where} />
      <Row k="d" label="Description" val={plain} />
      <Row k="c" label="Full caption" val={caption} />
      {gImg && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderTop: '1px solid var(--border,#eee)' }}>
          <div style={{ width: 84, fontSize: 12, opacity: 0.6 }}>Image{ev.social_image_url ? '' : ' (photo)'}</div>
          <img src={gImg} alt="" style={{ height: 44, borderRadius: 6 }} />
          <a href={gImg} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>open / download</a>
          <button style={{ ...btn(false), padding: '2px 8px', fontSize: 11 }} onClick={() => copy(gImg, 'img')}>{copied === 'img' ? '✓' : 'Copy URL'}</button>
        </div>
      )}
      <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8, background: 'var(--card-bg,#fff)', border: '1px solid var(--border,#eee)', borderRadius: 6, padding: 8, lineHeight: 1.5 }}>
        <b>Google Business post check:</b><br />
        Title {ev.title.length}/58 {ev.title.length > 58 ? '⚠ trim it' : '✓'} · Caption {caption.length}/1500 {caption.length > 1500 ? '⚠ shorten' : '✓'} <span style={{ opacity: 0.6 }}>(first ~100 chars show before "Read more" — front-load the hook)</span><br />
        Image: {ev.social_image_url ? '✓ landscape image set' : (ev.image_url ? '⚠ using the square/portrait Photo — add a 1200×900 “Email & Google image” above for a cleaner post' : 'none set')} · Suggested button: “Learn more” → event page.
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <a href="https://www.facebook.com/events/create/" target="_blank" rel="noreferrer" style={lnk}>Create Facebook Event ↗</a>
        <a href="https://business.google.com/posts" target="_blank" rel="noreferrer" style={lnk}>Google Business post ↗</a>
        <a href="https://www.eventbrite.com/create" target="_blank" rel="noreferrer" style={lnk}>Eventbrite ↗</a>
        <a href="https://www.bandsintown.com/artist-signup" target="_blank" rel="noreferrer" style={lnk}>Bandsintown ↗</a>
      </div>
    </div>
  );
}
