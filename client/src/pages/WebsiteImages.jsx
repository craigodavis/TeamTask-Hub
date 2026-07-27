import React, { useState, useEffect, useCallback } from 'react';
import { getPageImages, setPageImage, clearPageImage, listMedia, listMediaFolders } from '../api';
import './WebsiteImages.css';

const thumbOf = (m) => m?.variants?.webp?.[0]?.url || m?.url;

export function WebsiteImages() {
  const [catalog, setCatalog] = useState([]);
  const [assignments, setAssignments] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(null); // slot object being replaced

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { catalog, assignments } = await getPageImages();
      setCatalog(catalog);
      setAssignments(assignments);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const choose = async (slotKey, media) => {
    setPicking(null);
    setError('');
    try {
      await setPageImage(slotKey, media.id);
      await load();
    } catch (e) { setError(e.message); }
  };

  const clear = async (slotKey) => {
    if (!window.confirm('Clear this image? The site falls back to its placeholder.')) return;
    try { await clearPageImage(slotKey); await load(); } catch (e) { setError(e.message); }
  };

  if (loading) return <div className="web-images"><h1>Website Images</h1><p className="hint">Loading…</p></div>;

  return (
    <div className="web-images">
      <h1>Website Images</h1>
      <p className="subtitle">Marketing → Website. Click Replace to drop a media-library image into any spot on the site. Responsive sizes are used automatically; empty slots show the site's placeholder.</p>
      {error && <div className="wi-error">{error}</div>}

      {catalog.map((group) => (
        <div className="wi-group" key={group.group}>
          <h2>{group.group}</h2>
          <div className="wi-slots">
            {group.slots.map((slot) => {
              const a = assignments[slot.key];
              return (
                <div className="wi-slot" key={slot.key}>
                  <div className="wi-preview" style={{ aspectRatio: slot.ratio }}>
                    {a ? (
                      <img src={thumbOf(a)} alt={a.alt_text || ''} />
                    ) : (
                      <span className="wi-empty">Not set</span>
                    )}
                  </div>
                  <div className="wi-meta">
                    <div className="wi-label">{slot.label}</div>
                    {slot.hint && <div className="wi-hint">{slot.hint}</div>}
                    {a && !a.alt_text && <div className="wi-warn">Image has no alt text</div>}
                  </div>
                  <div className="wi-actions">
                    <button className="btn btn-primary" onClick={() => setPicking(slot)}>{a ? 'Replace' : 'Choose'}</button>
                    {a && <button className="btn btn-ghost" onClick={() => clear(slot.key)}>Clear</button>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {picking && (
        <MediaPicker
          slot={picking}
          onPick={(media) => choose(picking.key, media)}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}

function MediaPicker({ slot, onPick, onClose }) {
  const [items, setItems] = useState([]);
  const [folders, setFolders] = useState([]);
  const [folder, setFolder] = useState('all');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { limit: 500 };
      if (folder !== 'all') params.folder = folder;
      if (q.trim()) params.q = q.trim();
      const { media } = await listMedia(params);
      setItems(media);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [folder, q]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { listMediaFolders().then((r) => setFolders(r.folders)).catch(() => {}); }, []);

  return (
    <div className="wi-modal-backdrop" onClick={onClose}>
      <div className="wi-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wi-modal-head">
          <h3>Choose image for “{slot.label}”</h3>
          <button className="wi-close" onClick={onClose}>✕</button>
        </div>
        <div className="wi-picker-tools">
          <select value={folder} onChange={(e) => setFolder(e.target.value)}>
            <option value="all">All folders</option>
            {folders.map((f) => <option key={f.folder} value={f.folder}>{f.folder} ({f.n})</option>)}
          </select>
          <input type="search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="wi-picker-grid">
          {loading ? (
            <div className="hint" style={{ padding: 30 }}>Loading…</div>
          ) : items.length === 0 ? (
            <div className="hint" style={{ padding: 30 }}>No images.</div>
          ) : (
            items.map((m) => (
              <button className="wi-pick" key={m.id} onClick={() => onPick(m)} title={m.original_name || m.filename}>
                <img src={thumbOf(m)} alt={m.alt_text || ''} loading="lazy" />
                {!m.alt_text && <span className="wi-pick-warn">no alt</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
