import React, { useState, useEffect, useCallback } from 'react';
import {
  getKindredMembers, getKindredSettings, saveKindredSettings,
  getNotificationGroups, saveNotificationGroup, getNotificationSends,
  createNotificationGroup, deleteNotificationGroup, cancelNotificationSend, getLocations,
} from '../api';
import KindredCompose from './KindredCompose';
import './KindredApp.css';

const TABS = [
  { key: 'members',       label: 'Members' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'settings',      label: 'Settings' },
];

// The default view answers "who haven't we reached", not "who's using it".
const FILTERS = [
  { key: 'all',           label: 'Everyone' },
  { key: 'no_app',        label: 'No app yet' },
  { key: 'club_no_app',   label: 'Club members without the app' },
  { key: 'non_club',      label: 'Not in a club' },
  { key: 'lapsed',        label: 'Former club members' },
  { key: 'lapsed_no_app', label: 'Former members without the app' },
  { key: 'never_club',    label: 'Never joined a club' },
  { key: 'has_app',       label: 'Has the app' },
  { key: 'installed',     label: 'Opened it installed' },
  { key: 'notifications', label: 'Notifications on' },
  { key: 'app_converted', label: 'Joined after installing' },
];

const SOURCE_LABEL = {
  manual:       { tag: 'Broadcast',   hint: 'Compose a message and pick a time.' },
  event:        { tag: 'From events', hint: 'Built from an event; links straight to the reservation screen.' },
  club_release: { tag: 'Automatic',   hint: 'Fires off the Commerce7 release dates. No composing.' },
};

const d = (x) => (x ? new Date(x).toLocaleDateString() : '—');

function Funnel({ f }) {
  if (!f) return null;
  const steps = [
    ['Customers',        f.customers],
    ['Club members',     f.club_members],
    ['Former members',   f.lapsed_members],
    ['Have the app',     f.app_accounts],
    ['Opened installed', f.installed],
    ['Notifications on', f.notifications_on],
    ['Tapped one',       f.tapped],
    ['Reserved',         f.reserved],
  ];
  const max = Math.max(...steps.map(([, n]) => Number(n) || 0), 1);
  return (
    <div className="ka-funnel">
      {steps.map(([label, n]) => (
        <div className="ka-funnel-step" key={label}>
          <div className="ka-funnel-n">{Number(n || 0).toLocaleString()}</div>
          <div className="ka-funnel-bar"><span style={{ width: `${((n || 0) / max) * 100}%` }} /></div>
          <div className="ka-funnel-label">{label}</div>
        </div>
      ))}
    </div>
  );
}

function Members() {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    getKindredMembers({ filter, search })
      .then(setData).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [filter, search]);

  useEffect(() => { const t = setTimeout(load, search ? 300 : 0); return () => clearTimeout(t); }, [load, search]);

  return (
    <>
      <Funnel f={data?.funnel} />
      {data?.caveat && <p className="ka-caveat">{data.caveat}</p>}

      <div className="ka-toolbar">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          {FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        <input type="search" placeholder="Search name or email"
               value={search} onChange={(e) => setSearch(e.target.value)} />
        {data && <span className="ka-count">{data.total.toLocaleString()} people</span>}
      </div>

      {error && <p className="ka-error">{error}</p>}
      {loading ? <p className="ka-muted">Loading…</p> : (
        <div className="ka-table-wrap">
          <table className="ka-table">
            <thead>
              <tr>
                <th>Name</th><th>Email</th><th>Club</th><th>App</th>
                <th>Notifications</th><th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {data?.members?.map((m) => (
                <tr key={m.id}>
                  <td>{[m.first_name, m.last_name].filter(Boolean).join(' ') || '—'}</td>
                  <td className="ka-dim">{m.emails?.[0]?.email || '—'}</td>
                  <td>{m.club_active
                    ? <span className="ka-pill ka-pill-club">Member</span>
                    : m.club_lapsed
                      ? <span className="ka-pill ka-pill-lapsed" title={m.club_left_at ? `Left ${d(m.club_left_at)}` : ''}>
                          Left {m.club_left_at ? new Date(m.club_left_at).getFullYear() : ''}
                        </span>
                      : <span className="ka-dim">—</span>}</td>
                  <td>{m.account_id
                    ? (m.installed ? <span className="ka-pill ka-pill-on">Installed</span>
                                   : <span className="ka-pill">Browser</span>)
                    : <span className="ka-dim">—</span>}</td>
                  <td>{m.devices > 0 ? `${m.devices} device${m.devices > 1 ? 's' : ''}` : <span className="ka-dim">off</span>}</td>
                  <td className="ka-dim">{d(m.last_seen)}</td>
                </tr>
              ))}
              {!data?.members?.length && (
                <tr><td colSpan={6} className="ka-muted">Nobody matches that filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const BLANK_GROUP = {
  key: '', name: '', description: '', icon: '', source: 'manual',
  locationId: '', defaultEnabled: true, memberToggleable: true, defaultUrl: '',
};

function Notifications() {
  const [groups, setGroups] = useState([]);
  const [warning, setWarning] = useState(null);
  const [sends, setSends] = useState([]);
  const [locations, setLocations] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);
  const [composing, setComposing] = useState(false);
  const [newGroup, setNewGroup] = useState(null);   // null = form closed

  const load = useCallback(() => {
    getNotificationGroups().then((r) => { setGroups(r.groups || []); setWarning(r.warning); }).catch((e) => setError(e.message));
    getNotificationSends().then((r) => setSends(r.sends || [])).catch(() => {});
    getLocations().then((d) => setLocations(d.locations || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  // The key is what senders reference, so it's derived once from the name and
  // then left alone — renaming a lane must not silently orphan its sends.
  const setName = (name) => setNewGroup((g) => ({
    ...g, name,
    key: g.keyTouched ? g.key : name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
  }));

  async function createGroup() {
    setBusy('new');
    try {
      const r = await createNotificationGroup(newGroup);
      setNewGroup(null); setWarning(r.warning); load();
    } catch (e) { setError(e.message); }
    finally { setBusy(null); }
  }

  async function removeGroup(g) {
    if (!window.confirm(`Delete "${g.name}"? Members who chose it lose that choice.`)) return;
    setBusy(g.id);
    try { await deleteNotificationGroup(g.id); load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(null); }
  }

  const toggle = async (g, field) => {
    setBusy(g.id);
    try {
      const r = await saveNotificationGroup(g.id, { [field]: !g[field] });
      setGroups((prev) => prev.map((x) => x.id === g.id ? r.group : x));
      setWarning(r.warning);
    } catch (e) { setError(e.message); }
    finally { setBusy(null); }
  };

  return (
    <>
      {warning && <div className="ka-warn">{warning}</div>}
      {error && <p className="ka-error">{error}</p>}

      {composing ? (
        <KindredCompose groups={groups} onClose={() => { setComposing(false); load(); }} onSent={load} />
      ) : (
        <div className="ka-bar">
          <button className="ka-save" onClick={() => setComposing(true)}>Send a notification</button>
          <button className="ka-tab" onClick={() => setNewGroup({ ...BLANK_GROUP })}>+ New lane</button>
        </div>
      )}

      {newGroup && (
        <div className="kc">
          <div className="kc-head">
            <h3>New lane</h3>
            <button className="ka-tab" onClick={() => setNewGroup(null)}>Cancel</button>
          </div>
          <label className="kc-fld">
            <span>Name</span>
            <input type="text" value={newGroup.name} onChange={(e) => setName(e.target.value)}
                   placeholder="Creek events" />
          </label>
          <label className="kc-fld">
            <span>What it is</span>
            <input type="text" value={newGroup.description}
                   onChange={(e) => setNewGroup({ ...newGroup, description: e.target.value })}
                   placeholder="Live music and dinners downtown" />
          </label>
          <div className="kc-row">
            <label className="kc-fld">
              <span>Icon</span>
              <input type="text" value={newGroup.icon} maxLength={2}
                     onChange={(e) => setNewGroup({ ...newGroup, icon: e.target.value })} placeholder="♪" />
            </label>
            <label className="kc-fld">
              <span>Kind</span>
              <select value={newGroup.source}
                      onChange={(e) => setNewGroup({ ...newGroup, source: e.target.value })}>
                <option value="manual">Broadcast — you write each one</option>
                <option value="event">From events — built from an event</option>
              </select>
            </label>
          </div>
          {newGroup.source === 'event' && (
            <label className="kc-fld">
              <span>Venue <em>(optional)</em></span>
              <select value={newGroup.locationId}
                      onChange={(e) => setNewGroup({ ...newGroup, locationId: e.target.value })}>
                <option value="">Any venue</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <small>
                Scope it and events at that venue route here automatically — so someone can
                follow the Creek without hearing about the Winery.
              </small>
            </label>
          )}
          <div className="ka-switches">
            <label>
              <input type="checkbox" checked={newGroup.defaultEnabled}
                     onChange={(e) => setNewGroup({ ...newGroup, defaultEnabled: e.target.checked })} />
              On by default for new members
            </label>
            <label>
              <input type="checkbox" checked={newGroup.memberToggleable}
                     onChange={(e) => setNewGroup({ ...newGroup, memberToggleable: e.target.checked })} />
              Members can turn it off
            </label>
          </div>
          <p className="ka-note">Reference key: <code>{newGroup.key || '—'}</code> — fixed once created.</p>
          <div className="ka-actions">
            <button className="ka-save" onClick={createGroup}
                    disabled={busy === 'new' || !newGroup.name.trim()}>
              {busy === 'new' ? 'Creating…' : 'Create lane'}
            </button>
          </div>
        </div>
      )}

      <div className="ka-groups">
        {groups.map((g) => {
          const s = SOURCE_LABEL[g.source] || SOURCE_LABEL.manual;
          return (
            <div className={`ka-group${g.active ? '' : ' inactive'}`} key={g.id}>
              <div className="ka-group-head">
                <span className="ka-group-icon">{g.icon || '•'}</span>
                <div>
                  <div className="ka-group-name">
                    {g.name}
                    <span className="ka-tag">{s.tag}</span>
                    {g.location_name && <span className="ka-tag">{g.location_name}</span>}
                    {g.is_system && <span className="ka-tag ka-tag-sys">Built in</span>}
                  </div>
                  <div className="ka-group-desc">{g.description}</div>
                </div>
                <div className="ka-group-count">{g.opted_in} opted in</div>
              </div>

              <p className="ka-group-hint">{s.hint}</p>

              <div className="ka-switches">
                <label>
                  <input type="checkbox" checked={g.default_enabled} disabled={busy === g.id}
                         onChange={() => toggle(g, 'default_enabled')} />
                  On by default
                </label>
                <label>
                  <input type="checkbox" checked={g.member_toggleable} disabled={busy === g.id}
                         onChange={() => toggle(g, 'member_toggleable')} />
                  Members can turn it off
                </label>
              </div>
              {!g.is_system && (
                <button className="ka-del" onClick={() => removeGroup(g)} disabled={busy === g.id}>
                  Delete lane
                </button>
              )}
              {!g.member_toggleable && (
                <p className="ka-note">
                  Mandatory — enforced on the server, not just hidden in the app. It still can't
                  reach someone who never installed or who denied notifications at the OS level.
                </p>
              )}
            </div>
          );
        })}
      </div>

      <h3 className="ka-h3">Recent sends</h3>
      <div className="ka-table-wrap">
        <table className="ka-table">
          <thead><tr><th>When</th><th>Group</th><th>Message</th><th>Status</th><th>Delivered</th></tr></thead>
          <tbody>
            {sends.map((s) => (
              <tr key={s.id}>
                <td className="ka-dim">{d(s.sent_at || s.scheduled_for)}</td>
                <td>{s.group_name}</td>
                <td>{s.title}</td>
                <td><span className={`ka-pill ka-pill-${s.status}`}>{s.status}</span></td>
                <td className="ka-dim">
                  {s.status === 'sent' ? `${s.delivered}/${s.recipients}${s.pruned ? ` · ${s.pruned} dead` : ''}` : '—'}
                </td>
              </tr>
            ))}
            {!sends.length && <tr><td colSpan={5} className="ka-muted">Nothing sent yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Settings() {
  const [s, setS] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => { getKindredSettings().then((r) => setS(r.settings)).catch((e) => setError(e.message)); }, []);
  const set = (k, v) => { setS((p) => ({ ...p, [k]: v })); setSaved(false); };

  const save = async () => {
    setSaving(true); setError('');
    try { const r = await saveKindredSettings(s); setS(r.settings); setSaved(true); }
    catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  if (!s) return <p className="ka-muted">{error || 'Loading…'}</p>;

  return (
    <div className="ka-settings">
      {error && <p className="ka-error">{error}</p>}

      <section>
        <h3 className="ka-h3">Send window</h3>
        <p className="ka-muted">
          Notifications send at their scheduled time, clamped into this window. Winery-local
          ({s.send_timezone}), not the member's timezone.
        </p>
        <div className="ka-row">
          <label>After
            <input type="number" min="0" max="23" value={s.send_window_start_hour}
                   onChange={(e) => set('send_window_start_hour', Number(e.target.value))} />
          </label>
          <label>Before
            <input type="number" min="1" max="24" value={s.send_window_end_hour}
                   onChange={(e) => set('send_window_end_hour', Number(e.target.value))} />
          </label>
        </div>
        {s.send_window_start_hour > 8 && (
          <p className="ka-note">
            Commerce7 emails its release notices at 8am Mountain — earlier than this window, so a
            release push always lands at {s.send_window_start_hour}:00, an hour or more after the
            email. That's usually what you want: the email at breakfast, the push as a second touch.
          </p>
        )}
      </section>

      <section>
        <h3 className="ka-h3">Frequency cap</h3>
        <p className="ka-muted">
          How many optional notifications one person can get. Wine releases and events bypass it;
          specials and volunteer requests queue behind it.
        </p>
        <div className="ka-row">
          <label>Max
            <input type="number" min="1" max="20" value={s.frequency_cap_count}
                   onChange={(e) => set('frequency_cap_count', Number(e.target.value))} />
          </label>
          <label>per (days)
            <input type="number" min="1" max="90" value={s.frequency_cap_days}
                   onChange={(e) => set('frequency_cap_days', Number(e.target.value))} />
          </label>
        </div>
      </section>

      <section>
        <h3 className="ka-h3">Events</h3>
        <div className="ka-row">
          <label>Notify this many days before
            <input type="number" min="0" max="60" value={s.event_lead_days}
                   onChange={(e) => set('event_lead_days', Number(e.target.value))} />
          </label>
        </div>
        <label className="ka-check">
          <input type="checkbox" checked={s.event_notify_default}
                 onChange={(e) => set('event_notify_default', e.target.checked)} />
          Notify by default for events your team creates
        </label>
        <label className="ka-check">
          <input type="checkbox" checked={s.imported_notify_default}
                 onChange={(e) => set('imported_notify_default', e.target.checked)} />
          Notify by default for events imported from WordPress
        </label>
        {s.imported_notify_default && (
          <p className="ka-note ka-note-warn">
            Most events arrive through the WordPress sync. With this on, one sync can queue a
            notification for every imported event at once.
          </p>
        )}
      </section>

      <section>
        <h3 className="ka-h3">Wine release messages</h3>
        <p className="ka-muted">
          Sent automatically on the Commerce7 release dates. Variables: <code>{'{{club}}'}</code>,{' '}
          <code>{'{{processDate}}'}</code>, <code>{'{{cutoff}}'}</code>, <code>{'{{bottleCount}}'}</code>.
        </p>
        {[['Two weeks out', 'release_2wk_title', 'release_2wk_body'],
          ['Two days out',  'release_2day_title', 'release_2day_body']].map(([label, tk, bk]) => (
          <div className="ka-template" key={tk}>
            <h4>{label}</h4>
            <input type="text" value={s[tk] || ''} maxLength={80} placeholder="Title"
                   onChange={(e) => set(tk, e.target.value)} />
            <span className={`ka-len${(s[tk] || '').length > 40 ? ' over' : ''}`}>{(s[tk] || '').length}/40</span>
            <textarea value={s[bk] || ''} maxLength={200} placeholder="Body"
                      onChange={(e) => set(bk, e.target.value)} />
            <span className={`ka-len${(s[bk] || '').length > 120 ? ' over' : ''}`}>{(s[bk] || '').length}/120</span>
          </div>
        ))}
        <p className="ka-note">
          Phones truncate titles around 40 characters and collapse bodies to about 120 until
          expanded. Over that isn't blocked — just cut off on the lock screen.
        </p>
      </section>

      <div className="ka-actions">
        <button className="ka-save" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        {saved && <span className="ka-saved">Saved</span>}
      </div>
    </div>
  );
}

export function KindredApp() {
  const [tab, setTab] = useState('members');
  return (
    <div className="ka-page">
      <h2 className="ka-title">Kindred App</h2>
      <p className="ka-sub">friend.kindredvineyards.com — a winery in your pocket.</p>

      <div className="ka-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`ka-tab${tab === t.key ? ' active' : ''}`}
                  onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

      {tab === 'members'       && <Members />}
      {tab === 'notifications' && <Notifications />}
      {tab === 'settings'      && <Settings />}
    </div>
  );
}
