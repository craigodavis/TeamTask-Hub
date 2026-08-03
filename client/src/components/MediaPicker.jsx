import React, { useEffect, useState, useCallback, useRef } from 'react';
import { listMedia, listMediaFolders, uploadMedia } from '../api';

/**
 * Pick an image out of the Website Media library (Marketing → Website → Media)
 * instead of re-uploading the same artwork for every event. Anything uploaded
 * from here lands in the library too, so it's pickable next time rather than
 * becoming another one-off file.
 */

const backdrop = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16,
};
const panel = {
  background: 'var(--card,#fff)', color: 'var(--text,inherit)', borderRadius: 12,
  width: 'min(920px, 100%)', maxHeight: '85vh', display: 'flex', flexDirection: 'column',
  boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
};
const head = { padding: '14px 18px', borderBottom: '1px solid var(--border,#ddd)', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' };
const body = { padding: 16, overflowY: 'auto' };
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 };
const inp = { padding: 8, borderRadius: 8, border: '1px solid var(--border,#ccc)', fontSize: 14, boxSizing: 'border-box' };
const btn = (primary) => ({
  padding: '8px 14px', borderRadius: 8, border: primary ? 'none' : '1px solid var(--border,#ccc)',
  cursor: 'pointer', fontWeight: 600, background: primary ? '#7c2d3a' : 'transparent', color: primary ? '#fff' : 'inherit',
});

export function MediaPicker({ open, onClose, onPick, defaultFolder = '' }) {
  const [folders, setFolders] = useState([]);
  const [folder, setFolder] = useState(defaultFolder);
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { media } = await listMedia({ folder: folder || undefined, q: q || undefined, limit: 300 });
      setItems(media || []);
    } catch (e) { setError(e.message); setItems([]); }
    finally { setLoading(false); }
  }, [folder, q]);

  useEffect(() => { if (open) load(); }, [open, load]);
  useEffect(() => {
    if (!open) return;
    listMediaFolders().then((r) => setFolders(r.folders || [])).catch(() => {});
  }, [open]);

  // Escape closes, matching the rest of the app's overlays.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const onUpload = async (file) => {
    if (!file) return;
    setUploading(true); setError('');
    try {
      // Into the library (folder defaults to "library"), not a one-off events file.
      const m = await uploadMedia(file, { folder: folder || 'library' });
      const url = m?.url || m?.media?.url;
      if (url) { onPick(url); onClose(); } else { await load(); }
    } catch (e) { setError(e.message); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  return (
    <div style={backdrop} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={head}>
          <strong style={{ fontSize: 16 }}>Choose an image</strong>
          <select style={{ ...inp, width: 180 }} value={folder} onChange={(e) => setFolder(e.target.value)}>
            <option value="">All folders</option>
            {folders.map((f) => <option key={f.folder} value={f.folder}>{f.folder} ({f.n})</option>)}
          </select>
          <input
            style={{ ...inp, flex: 1, minWidth: 160 }}
            placeholder="Search name, alt text, caption…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button style={btn(false)} onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? 'Uploading…' : 'Upload new'}
          </button>
          <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
                 onChange={(e) => onUpload(e.target.files[0])} />
          <button style={btn(false)} onClick={onClose}>Close</button>
        </div>

        <div style={body}>
          {error && <p style={{ color: '#b00', marginTop: 0 }}>{error}</p>}
          {loading ? <p style={{ opacity: 0.6 }}>Loading…</p>
            : items.length === 0 ? <p style={{ opacity: 0.6 }}>No images match.</p>
            : (
              <div style={grid}>
                {items.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => { onPick(m.url); onClose(); }}
                    title={m.original_name || m.filename}
                    style={{
                      padding: 0, border: '1px solid var(--border,#ddd)', borderRadius: 10,
                      background: 'var(--bg,#fafafa)', cursor: 'pointer', overflow: 'hidden', textAlign: 'left',
                    }}
                  >
                    <img
                      src={m.url} alt={m.alt_text || ''} loading="lazy"
                      style={{ width: '100%', height: 110, objectFit: 'cover', display: 'block' }}
                    />
                    <div style={{ padding: '6px 8px', fontSize: 11, lineHeight: 1.3 }}>
                      <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {m.original_name || m.filename}
                      </div>
                      <div style={{ opacity: 0.55 }}>{m.folder}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

/**
 * The image row used on event forms: preview + "Choose image" + Remove.
 */
export function ImageField({ value, onChange, defaultFolder = '' }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      {value
        ? <img src={value} alt="" style={{ height: 70, borderRadius: 8, objectFit: 'cover' }} />
        : <div style={{
            height: 70, width: 100, borderRadius: 8, border: '1px dashed var(--border,#ccc)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, opacity: 0.5,
          }}>No image</div>}
      <button type="button" style={btn(false)} onClick={() => setOpen(true)}>
        {value ? 'Change image' : 'Choose image'}
      </button>
      {value && (
        <button type="button" style={{ ...btn(false), padding: '4px 10px' }} onClick={() => onChange('')}>
          Remove
        </button>
      )}
      <MediaPicker open={open} onClose={() => setOpen(false)} onPick={onChange} defaultFolder={defaultFolder} />
    </div>
  );
}
