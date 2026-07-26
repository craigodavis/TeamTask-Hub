import React, { useState, useEffect, useCallback, useRef } from 'react';
import { listMedia, uploadMedia, updateMedia, deleteMedia, startWordpressImport, getImportStatus, listMediaFolders, addMediaFolder, removeMediaFolder } from '../api';
import './MediaLibrary.css';

// Suggested folders when none exist yet (e.g. before the WordPress import).
const DEFAULT_FOLDERS = ['library', 'needs-review', 'hero', 'wines'];
const prettyFolder = (f) => (f === 'all' ? 'all' : f.replace(/-/g, ' '));

// Smallest webp variant for a fast thumbnail; fall back to the original.
const thumbOf = (m) => m?.variants?.webp?.[0]?.url || m?.url;

export function MediaLibrary() {
  const [items, setItems] = useState([]);
  const [folders, setFolders] = useState([]); // [{ folder, n }] mirrored from the library
  const [total, setTotal] = useState(0);
  const [folder, setFolder] = useState('all');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [drag, setDrag] = useState(false);
  const [selected, setSelected] = useState(null);
  const [managingFolders, setManagingFolders] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importReport, setImportReport] = useState(null);
  const [importError, setImportError] = useState(null);
  const fileInput = useRef(null);
  const pollingRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { limit: 500 };
      if (folder !== 'all') params.folder = folder;
      if (q.trim()) params.q = q.trim();
      const { media } = await listMedia(params);
      setItems(media);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [folder, q]);

  // Folder tree + counts, mirrored from the actual library. Refreshed on demand.
  const loadFolders = useCallback(async () => {
    try {
      const { folders } = await listMediaFolders();
      setFolders(folders);
      setTotal(folders.reduce((s, f) => s + f.n, 0));
    } catch { /* best-effort */ }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadFolders(); }, [loadFolders]);

  const doUpload = async (files) => {
    if (!files || !files.length) return;
    setUploading(true);
    setError('');
    try {
      // Upload sequentially so a big drop doesn't hammer the server.
      for (const file of Array.from(files)) {
        if (!file.type.startsWith('image/')) continue;
        await uploadMedia(file, { folder: folder === 'all' || folder === 'needs-review' ? 'library' : folder });
      }
      await load();
      await loadFolders();
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDrag(false);
    doUpload(e.dataTransfer.files);
  };

  // Poll the background WordPress import until it finishes, then refresh.
  const startPolling = useCallback(() => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    const tick = async () => {
      const s = await getImportStatus().catch(() => null);
      if (s) { setImportReport(s.report); setImporting(s.running); setImportError(s.error || null); }
      if (s && s.running) {
        setTimeout(tick, 2000);
      } else {
        pollingRef.current = false;
        await load();
        await loadFolders();
      }
    };
    tick();
  }, [load, loadFolders]);

  // Resume progress display if an import is already running (e.g. after a refresh).
  useEffect(() => {
    getImportStatus()
      .then((s) => {
        if (s?.running) { setImporting(true); startPolling(); }
        else if (s?.report) setImportReport(s.report);
        if (s?.error) setImportError(s.error);
      })
      .catch(() => {});
  }, [startPolling]);

  const runImport = async () => {
    if (!window.confirm('Import images from the current WordPress site?\n\nAI-generated images are skipped; anything uncertain goes to “needs-review” for you to check. Safe to run more than once.')) return;
    setError('');
    setImportError(null);
    setImportReport(null);
    try {
      setImporting(true);
      await startWordpressImport();
      startPolling();
    } catch (e) {
      setError(e.message);
      setImporting(false);
    }
  };

  const onSaved = (updated) => {
    setItems((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
    setSelected(null);
    loadFolders();
  };
  const onDeleted = (id) => {
    setItems((prev) => prev.filter((m) => m.id !== id));
    setSelected(null);
    loadFolders();
  };

  const reviewCount = folders.find((f) => f.folder === 'needs-review')?.n || 0;
  const knownFolders = folders.map((f) => f.folder);

  return (
    <div className="media-lib">
      <h1>Website Media</h1>
      <p className="subtitle">Marketing → Website. Images here are published to kindredvineyards.com. Add alt text and a photo credit for every image.</p>

      {error && <div className="media-error">{error}</div>}

      {reviewCount > 0 && folder !== 'needs-review' && (
        <div className="review-banner">
          {reviewCount} imported image{reviewCount === 1 ? '' : 's'} need review before use.{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); setFolder('needs-review'); }}>Review now →</a>
        </div>
      )}

      <div className="media-toolbar">
        <div className="media-folders">
          <button className={folder === 'all' ? 'on' : ''} onClick={() => setFolder('all')}>
            all<span className="count">{total}</span>
          </button>
          {folders.map((f) => (
            <button key={f.folder} className={folder === f.folder ? 'on' : ''} onClick={() => setFolder(f.folder)} title={f.folder}>
              {prettyFolder(f.folder)}<span className="count">{f.n}</span>
            </button>
          ))}
        </div>
        <div className="media-search">
          <input
            type="search"
            placeholder="Search alt text, filename, caption…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <button className="btn btn-ghost" onClick={() => setManagingFolders(true)}>Manage folders</button>
        <button className="btn btn-ghost" onClick={runImport} disabled={importing}>
          {importing ? 'Importing…' : 'Import from WordPress'}
        </button>
      </div>

      {(importing || importReport || importError) && (
        <div className={`import-status${importError ? ' import-status-error' : ''}`}>
          {importing ? 'Importing from WordPress…' : 'Last import: '}
          {importReport && (
            <span>
              {' '}found {importReport.total} · imported {importReport.imported} · foldered {importReport.foldered ?? 0} · refiled {importReport.refiled ?? 0} · needs review {importReport.needsReview} · skipped AI {importReport.skippedAI} · already had {importReport.alreadyHave}
              {importReport.failed ? ` · failed ${importReport.failed}` : ''}{importReport.dryRun ? ' (dry run)' : ''}
            </span>
          )}
          {importReport?.folderNote && <div className="import-detail">Folders — {importReport.folderNote}</div>}
          {importReport?.firstError && <div className="import-detail">First failure — {importReport.firstError}</div>}
          {importError && <div className="import-detail">Error: {importError}</div>}
        </div>
      )}

      <div
        className={`dropzone${drag ? ' drag' : ''}`}
        onClick={() => fileInput.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
      >
        {uploading ? (
          <span>Uploading…</span>
        ) : (
          <span><strong>Drop images here</strong> or click to upload — responsive webp/avif versions are generated automatically.</span>
        )}
        <input ref={fileInput} type="file" accept="image/*" multiple onChange={(e) => doUpload(e.target.files)} />
      </div>

      {loading ? (
        <div className="media-empty">Loading…</div>
      ) : items.length === 0 ? (
        <div className="media-empty">No images{folder !== 'all' ? ` in “${folder.replace('-', ' ')}”` : ''} yet.</div>
      ) : (
        <div className="media-grid">
          {items.map((m) => (
            <div key={m.id} className="media-card" onClick={() => setSelected(m)}>
              <div className="media-thumb" style={{ backgroundImage: `url(${thumbOf(m)})` }}>
                <div className="media-badges">
                  {m.folder === 'needs-review' && <span className="badge review">Review</span>}
                  {m.source === 'imported' && <span className="badge imported">Imported</span>}
                  {!m.alt_text && <span className="badge noalt">No alt</span>}
                </div>
              </div>
              <div className="media-meta">
                <div className="media-name" title={m.original_name || m.filename}>{m.original_name || m.filename}</div>
                <div className="media-dim">{m.width && m.height ? `${m.width}×${m.height}` : '—'}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {selected && <MediaDetail item={selected} folders={knownFolders} onClose={() => setSelected(null)} onSaved={onSaved} onDeleted={onDeleted} />}

      {managingFolders && (
        <FolderManager
          folders={folders}
          onClose={() => setManagingFolders(false)}
          onChanged={() => { loadFolders(); load(); }}
        />
      )}
    </div>
  );
}

function FolderManager({ folders, onClose, onChanged }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const add = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true); setErr('');
    try {
      await addMediaFolder(n);
      setName('');
      onChanged();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const remove = async (f) => {
    if (!window.confirm(`Remove folder “${f.folder}”?${f.n ? `\n\nIts ${f.n} image${f.n === 1 ? '' : 's'} will move to “library”.` : ''}`)) return;
    setBusy(true); setErr('');
    try {
      await removeMediaFolder(f.folder, 'library');
      onChanged();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="media-modal-backdrop" onClick={onClose}>
      <div className="folder-mgr" onClick={(e) => e.stopPropagation()}>
        <h2>Manage folders</h2>
        {err && <div className="media-error">{err}</div>}
        <div className="add-folder">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
            placeholder="New folder — e.g. Wines/Estate Reds"
          />
          <button className="btn btn-primary" onClick={add} disabled={busy || !name.trim()}>Add</button>
        </div>
        <ul className="folder-list">
          {folders.map((f) => (
            <li key={f.folder}>
              <span className="fname">{f.folder}</span>
              <span className="fcount">{f.n}</span>
              {f.protected ? (
                <span className="fprotected">default</span>
              ) : (
                <button className="fremove" onClick={() => remove(f)} disabled={busy} title="Remove folder">✕</button>
              )}
            </li>
          ))}
        </ul>
        <div className="actions">
          <button className="btn btn-ghost" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function MediaDetail({ item, folders = [], onClose, onSaved, onDeleted }) {
  const [alt, setAlt] = useState(item.alt_text || '');
  const [caption, setCaption] = useState(item.caption || '');
  const [credit, setCredit] = useState(item.credit || '');
  const [folder, setFolder] = useState(item.folder || 'library');
  const [tags, setTags] = useState((item.tags || []).join(', '));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);

  const fullUrl = `${window.location.origin}${item.url}`;

  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      const updated = await updateMedia(item.id, { alt_text: alt, caption, credit, folder, tags });
      onSaved(updated);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm('Delete this image and all its generated sizes? This cannot be undone.')) return;
    setBusy(true);
    setErr('');
    try {
      await deleteMedia(item.id);
      onDeleted(item.id);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };

  const copy = () => {
    navigator.clipboard?.writeText(fullUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="media-modal-backdrop" onClick={onClose}>
      <div className="media-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preview" style={{ backgroundImage: `url(${item.url})` }} />
        <div className="form">
          <h2>{item.original_name || item.filename}</h2>
          {err && <div className="media-error">{err}</div>}

          <label>Alt text {!alt && <span className="alt-warn">(required for accessibility &amp; SEO)</span>}</label>
          <textarea value={alt} onChange={(e) => setAlt(e.target.value)} placeholder="Describe the image for screen readers and search engines" />

          <label>Caption</label>
          <textarea value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Optional caption shown on the site" />

          <div className="row">
            <div>
              <label>Photo credit</label>
              <input value={credit} onChange={(e) => setCredit(e.target.value)} placeholder="e.g. Ed Hoffman" />
            </div>
            <div>
              <label>Folder</label>
              <select value={folder} onChange={(e) => setFolder(e.target.value)}>
                {[...new Set([...DEFAULT_FOLDERS, ...folders, folder])].filter(Boolean).sort((a, b) => a.localeCompare(b)).map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </div>
          </div>

          <label>Tags (comma-separated)</label>
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="hero, vineyard, people" />

          <label>URL</label>
          <div className="copy-url" onClick={copy} title="Click to copy">{copied ? 'Copied!' : fullUrl}</div>
          <div className="hint">{item.width}×{item.height} · {item.source} · {item.variants ? 'responsive variants ready' : 'original only'}</div>

          <div className="actions">
            <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <span className="spacer" />
            <button className="btn btn-danger" onClick={remove} disabled={busy}>Delete</button>
          </div>
        </div>
      </div>
    </div>
  );
}
