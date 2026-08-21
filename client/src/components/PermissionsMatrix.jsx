import { useCallback, useEffect, useMemo, useState } from 'react';
import './PermissionsMatrix.css';

/**
 * Who may do what.
 *
 * A role stamps a preset of checkboxes; the checkboxes are then the truth and
 * can be edited individually. Editing a role definition later does not reach
 * back and change anyone, so what is on screen is always what the person
 * actually holds — and a person who has drifted from their preset is badged
 * Customized rather than silently misdescribed by a role name.
 *
 * The catalogue comes from the server rather than being duplicated here, so
 * the checkboxes cannot drift from what the API enforces.
 */
export function PermissionsMatrix({ authFetch, currentUserId, onError, onMessage }) {
  const [catalog, setCatalog] = useState(null);
  const [users, setUsers] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [draft, setDraft] = useState(null);   // { role, capabilities:Set }
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, u] = await Promise.all([
        authFetch('/api/permissions/catalog').then((r) => r.json()),
        authFetch('/api/permissions/users').then((r) => r.json()),
      ]);
      if (c.capabilities) setCatalog(c);
      if (u.users) setUsers(u.users);
    } catch (e) { onError?.(e.message); }
  }, [authFetch, onError]);

  useEffect(() => { load(); }, [load]);

  // Grouped for display: containers first with their children, then the
  // top-level items. Mirrors the sidebar so the checkboxes read like the menu
  // they control.
  const groups = useMemo(() => {
    if (!catalog) return [];
    const byContainer = {};
    const loose = [];
    for (const c of catalog.capabilities) {
      if (c.container) (byContainer[c.container] ||= []).push(c);
      else loose.push(c);
    }
    return [
      { key: '_top', label: 'Menu', items: loose },
      ...Object.entries(byContainer).map(([key, items]) => ({
        key, label: catalog.containers[key]?.label || key, items,
      })),
    ];
  }, [catalog]);

  const open = (u) => {
    setOpenId(u.id);
    setDraft({ role: u.role, capabilities: new Set(u.capabilities) });
  };

  const pickRole = (role) => {
    // Stamp the preset. Anything already ticked is replaced, because the point
    // of choosing a role is to get that role's set.
    const preset = catalog.presets[role] || [];
    setDraft({ role, capabilities: new Set(preset) });
  };

  const toggle = (key) => {
    setDraft((d) => {
      const next = new Set(d.capabilities);
      next.has(key) ? next.delete(key) : next.add(key);
      return { ...d, capabilities: next };
    });
  };

  const toggleGroup = (items, on) => {
    setDraft((d) => {
      const next = new Set(d.capabilities);
      for (const i of items) on ? next.add(i.key) : next.delete(i.key);
      return { ...d, capabilities: next };
    });
  };

  const save = async (userId) => {
    setSaving(true);
    onError?.(''); onMessage?.('');
    try {
      // Only send a role the server still recognises. Tristan and Zoë are on
      // the retired `inventory` role, and sending that back would 400 -- so
      // ticking a box for them saves the boxes and leaves their role alone
      // until someone deliberately picks one of the five.
      const body = { capabilities: [...draft.capabilities] };
      if (catalog.roles.includes(draft.role)) body.role = draft.role;

      const r = await authFetch(`/api/permissions/users/${userId}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Save failed');
      onMessage?.('Permissions saved.');
      setOpenId(null); setDraft(null);
      await load();
    } catch (e) { onError?.(e.message); }
    finally { setSaving(false); }
  };

  const presetOf = (role) => new Set(catalog?.presets[role] || []);
  const differsFromPreset = draft && catalog
    ? (() => {
        const p = presetOf(draft.role);
        if (p.size !== draft.capabilities.size) return true;
        for (const k of p) if (!draft.capabilities.has(k)) return true;
        return false;
      })()
    : false;

  if (!catalog) return <p className="hint">Loading permissions…</p>;

  return (
    <div className="pm">
      <ul className="pm-users">
        {users.map((u) => (
          <li key={u.id} className={`pm-user${openId === u.id ? ' open' : ''}`}>
            <div className="pm-user-head">
              <span className="pm-user-name">
                {u.display_name || u.email}
                {u.id === currentUserId && <span className="pm-you"> (you)</span>}
              </span>
              <span className="pm-user-role">{u.role}</span>
              {u.customized && <span className="pm-badge" title="Edited away from this role's preset">Customized</span>}
              <span className="pm-user-count">{u.capabilities.length} of {catalog.capabilities.length}</span>
              <button
                type="button"
                className="pm-edit"
                onClick={() => (openId === u.id ? (setOpenId(null), setDraft(null)) : open(u))}
              >
                {openId === u.id ? 'Close' : 'Edit'}
              </button>
            </div>

            {openId === u.id && draft && (
              <div className="pm-editor">
                <div className="pm-role-row">
                  <label htmlFor={`pm-role-${u.id}`}>Role</label>
                  <select
                    id={`pm-role-${u.id}`}
                    value={catalog.roles.includes(draft.role) ? draft.role : ''}
                    onChange={(e) => pickRole(e.target.value)}
                  >
                    {!catalog.roles.includes(draft.role) && (
                      <option value="">{draft.role} (retired)</option>
                    )}
                    {catalog.roles.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <span className="pm-role-hint">
                    {differsFromPreset
                      ? 'Edited — the boxes below are what they get, not the role.'
                      : 'Matches the role exactly. Tick anything below to customise.'}
                  </span>
                </div>

                {groups.map((g) => {
                  const all = g.items.every((i) => draft.capabilities.has(i.key));
                  const some = !all && g.items.some((i) => draft.capabilities.has(i.key));
                  return (
                    <fieldset key={g.key} className="pm-group">
                      <legend>
                        <label className="pm-group-toggle">
                          <input
                            type="checkbox"
                            checked={all}
                            ref={(el) => { if (el) el.indeterminate = some; }}
                            onChange={(e) => toggleGroup(g.items, e.target.checked)}
                          />
                          {g.label}
                        </label>
                      </legend>
                      <div className="pm-items">
                        {g.items.map((i) => (
                          <label key={i.key} className="pm-item">
                            <input
                              type="checkbox"
                              checked={draft.capabilities.has(i.key)}
                              onChange={() => toggle(i.key)}
                            />
                            <span className="pm-item-label">{i.label}</span>
                            <code className="pm-item-key">{i.key}</code>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  );
                })}

                <div className="pm-actions">
                  <button type="button" className="pm-save" disabled={saving} onClick={() => save(u.id)}>
                    {saving ? 'Saving…' : 'Save permissions'}
                  </button>
                  <button type="button" onClick={() => { setOpenId(null); setDraft(null); }}>Cancel</button>
                  <span className="pm-count">{draft.capabilities.size} selected</span>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
