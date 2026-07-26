import React, { useState, useEffect, useCallback, useRef } from 'react';
import { listMedia, uploadMedia, updateMedia, deleteMedia, startWordpressImport, getImportStatus } from '../api';
import './MediaLibrary.css';

const FOLDERS = ['all', 'library', 'needs-review', 'hero', 'wines'];
const EDITABLE_FOLDERS = ['library', 'needs-review', 'hero', 'wines'];

// Smallest webp variant for a fast thumbnail; fall back to the original.
const thumbOf = (m) => m?.variants?.webp?.[0]?.url || m?.url;

export function MediaLibrary() {
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({});
  const [folder, setFolder] = useState('all');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [drag, setDrag] = useState(false);
  const [selected, setSelected] = useState(null);
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

  // Folder counts (independent of the active filter), refreshed on demand.
  const loadCounts = useCallback(async () => {
    try {
      const next = {};
      const all = await listMedia({ limit: 1 });
      next.all = all.total;
      for (const f of EDITABLE_FOLDERS) {
        const r = await listMedia({ folder: f, limit: 1 });
        next[f] = r.total;
      }
      setCounts(next);
    } catch { /* counts are best-effort */ }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadCounts(); }, [loadCounts]);

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
      await loadCounts();
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
        await loadCounts();
      }
    };
    tick();
  }, [load, loadCounts]);

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
    loadCounts();
  };
  const onDeleted = (id) => {
    setItems((prev) => prev.filter((m) => m.id !== id));
    setSelected(null);
    loadCounts();
  };

  const reviewCount = counts['needs-review'] || 0;

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
          {FOLDERS.map((f) => (
            <button key={f} className={folder === f ? 'on' : ''} onClick={() => setFolder(f)}>
              {f.replace('-', ' ')}
              {counts[f] != null && <span className="count">{counts[f]}</span>}
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
        <button className="btn btn-ghost" onClick={runImport} disabled={importing}>
          {importing ? 'Importing…' : 'Import from WordPress'}
        </button>
      </div>

      {(importing || importReport || importError) && (
        <div className={`import-status${importError ? ' import-status-error' : ''}`}>
          {importing ? 'Importing from WordPress…' : 'Last import: '}
          {importReport && (
            <span>
              {' '}found {importReport.total} · imported {importReport.imported} · needs review {importReport.needsReview} · skipped AI {importReport.skippedAI} · already had {importReport.alreadyHave}
              {importReport.failed ? ` · failed ${importReport.failed}` : ''}{importReport.dryRun ? ' (dry run)' : ''}
            </span>
          )}
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

      {selected && <MediaDetail item={selected} onClose={() => setSelected(null)} onSaved={onSaved} onDeleted={onDeleted} />}
    </div>
  );
}

function MediaDetail({ item, onClose, onSaved, onDeleted }) {
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
                {EDITABLE_FOLDERS.map((f) => <option key={f} value={f}>{f.replace('-', ' ')}</option>)}
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
