import { useCallback, useEffect, useRef, useState } from 'react';
import { listMedia, uploadMedia } from '../api';
import './VideoPicker.css';

/**
 * Pick a video from the media library, or upload one on the spot.
 *
 * Exposed as a hook returning [pick, modal]: `pick()` resolves with
 * { url, poster } when a video is chosen and null when the picker is
 * dismissed, so the caller can `await` it inline. Uploading from here rather
 * than sending people to Marketing → Media means a video can be added while
 * writing the announcement it belongs to.
 */
export function useVideoPicker() {
  const [open, setOpen] = useState(false);
  const resolver = useRef(null);

  const pick = useCallback(() => {
    setOpen(true);
    return new Promise((resolve) => { resolver.current = resolve; });
  }, []);

  const finish = useCallback((value) => {
    setOpen(false);
    resolver.current?.(value);
    resolver.current = null;
  }, []);

  const modal = open ? <VideoPickerModal onPick={finish} /> : null;
  return [pick, modal];
}

function VideoPickerModal({ onPick }) {
  const [videos, setVideos] = useState(null);
  const [err, setErr] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef(null);

  const load = useCallback(async () => {
    try {
      // The list endpoint has no mime filter, so ask for a generous page and
      // narrow here. There are far fewer videos than images.
      const { media } = await listMedia({ limit: 200 });
      setVideos((media || []).filter((m) => (m.mime || '').startsWith('video/')));
    } catch (e) { setErr(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Escape closes, matching every other modal in the app.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onPick(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onPick]);

  const doUpload = async (file) => {
    if (!file) return;
    setUploading(true);
    setErr('');
    try {
      const created = await uploadMedia(file, { folder: 'library' });
      onPick({ url: created.url, poster: created.variants?.poster || null });
    } catch (e) {
      setErr(e.message);
      setUploading(false);
    }
  };

  return (
    <div className="vp-backdrop" onClick={() => onPick(null)}>
      <div className="vp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="vp-head">
          <h2>Insert a video</h2>
          <button type="button" className="vp-close" onClick={() => onPick(null)} aria-label="Close">×</button>
        </div>

        {err && <div className="vp-error">{err}</div>}

        <div className="vp-actions">
          <button type="button" onClick={() => fileInput.current?.click()} disabled={uploading}>
            {uploading ? 'Uploading…' : 'Upload a video'}
          </button>
          <span className="vp-hint">MP4 plays everywhere. Up to 500MB.</span>
          <input
            ref={fileInput}
            type="file"
            accept="video/*"
            hidden
            onChange={(e) => doUpload(e.target.files?.[0])}
          />
        </div>

        {videos === null && <p className="vp-empty">Loading…</p>}
        {videos?.length === 0 && (
          <p className="vp-empty">No videos in the library yet. Upload one above.</p>
        )}

        {videos?.length > 0 && (
          <div className="vp-grid">
            {videos.map((v) => (
              <button
                type="button"
                key={v.id}
                className="vp-card"
                onClick={() => onPick({ url: v.url, poster: v.variants?.poster || null })}
              >
                <span
                  className="vp-thumb"
                  style={v.variants?.poster ? { backgroundImage: `url(${v.variants.poster})` } : undefined}
                >
                  {!v.variants?.poster && <span className="vp-noposter">▶</span>}
                </span>
                <span className="vp-name">{v.original_name || v.filename}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
