import { useCallback, useEffect, useMemo, useState } from 'react';
import { previewFor } from '../lib/menuPreview';

/** "Floor", "Floor and Cellar", "Floor, Cellar and Admin". */
const listOf = (xs) =>
  xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
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
 *
 * Beside the checkboxes is the menu they would produce. It is built by handing
 * the UNSAVED draft to `visibleApps`, the very function the shell calls to draw
 * the real sidebar -- so it cannot drift from what the person will actually get,
 * and asking "what would Elaine lose?" no longer means saving it to her live
 * account and going to look. See docs/APPS.md.
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
      // Only send a role the server still recognises. Migration 825 moved the
      // last holders of `inventory`, `schedule` and `gc` to `member`, so in
      // practice nobody is on a retired role any more -- but sending one back
      // would 400, so a drifted row still saves its boxes and leaves the role
      // alone until someone deliberately picks one.
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

  // What the draft would produce. Delegated to lib/menuPreview, which calls the
  // shell's own `visibleApps` -- so this panel cannot drift from the real
  // sidebar, and the same code is exercised against production grants by
  // server/scripts/audit-menu-preview.mjs.
  const preview = useMemo(() => {
    if (!draft || !openId || !catalog) return null;
    const saved = users.find((u) => u.id === openId);
    return saved ? previewFor(saved, draft.role, draft.capabilities) : null;
  }, [draft, openId, users, catalog]);

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

                {preview && (
                  <section className="pm-preview" aria-live="polite">
                    <header className="pm-preview-head">
                      <h4>What they would see</h4>
                      <span className="pm-preview-note">
                        Their menu, built from the boxes below as they stand — nothing is saved yet.
                      </span>
                    </header>

                    {preview.apps.length === 0 ? (
                      <p className="pm-preview-empty">
                        Nothing at all. They would land on “Nothing is set up for you yet” and be
                        unable to go anywhere.
                      </p>
                    ) : (
                      <div className="pm-preview-apps">
                        {preview.apps.map(({ app, nav }) => (
                          <div
                            key={app.id}
                            className="pm-preview-app"
                            style={{ '--pm-a-light': app.color[0], '--pm-a-dark': app.color[1] }}
                          >
                            <span className="pm-preview-app-name">{app.name}</span>
                            <ul className="pm-preview-nav">
                              {nav.map((i) => <li key={i.to}>{i.label}</li>)}
                            </ul>
                          </div>
                        ))}
                      </div>
                    )}

                    {(preview.lost.length > 0 || preview.gained.length > 0) && (
                      <div className="pm-preview-diff">
                        {preview.lost.length > 0 && (
                          <p className="pm-diff pm-diff-lost">
                            <strong>Loses {preview.lost.length}:</strong>{' '}
                            {preview.lost.map((v) => `${v.label} (${v.app})`).join(', ')}
                            {preview.appsLost.length > 0 && (
                              <em> — and {listOf(preview.appsLost)} disappear{preview.appsLost.length === 1 ? 's' : ''} entirely.</em>
                            )}
                          </p>
                        )}
                        {preview.gained.length > 0 && (
                          <p className="pm-diff pm-diff-gained">
                            <strong>Gains {preview.gained.length}:</strong>{' '}
                            {preview.gained.map((v) => `${v.label} (${v.app})`).join(', ')}
                            {preview.appsGained.length > 0 && (
                              <em> — {listOf(preview.appsGained)} {preview.appsGained.length === 1 ? 'is' : 'are'} new to them.</em>
                            )}
                          </p>
                        )}
                      </div>
                    )}

                    <p className="pm-preview-caveat">
                      This is the menu. A few screens still vary their own tabs by role rather than
                      by permission, so check those with “View as” in your account menu after saving.
                    </p>
                  </section>
                )}

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
                  <span className="pm-count">
                    {preview && (preview.lost.length > 0 || preview.gained.length > 0) ? (
                      <>
                        {preview.lost.length > 0 && (
                          <span className="pm-count-lost">−{preview.lost.length} menu item{preview.lost.length === 1 ? '' : 's'}</span>
                        )}
                        {preview.gained.length > 0 && (
                          <span className="pm-count-gained">+{preview.gained.length} menu item{preview.gained.length === 1 ? '' : 's'}</span>
                        )}
                      </>
                    ) : null}
                    <span>{draft.capabilities.size} selected</span>
                  </span>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
