/**
 * Absolute URLs for anything served out of Team's own uploads directory.
 *
 * Media uploaded here is stored as a host-relative path ("/api/uploads/media/x.png"),
 * which resolves against whoever is asking. That is fine for Team's own client and
 * wrong for everybody else — and Team has two cross-origin consumers: the public
 * website API, and the website's in-page image editor, which runs on
 * preview.kindredvineyards.com and asks Team for the media list. A relative path
 * there points the browser at the website's own origin, where the file does not
 * exist, so the picker fills with broken-image icons.
 *
 * Absolute URLs are correct for every caller, including same-origin ones, so this
 * is applied on the way out of any endpoint that hands back media — not just the
 * public ones.
 *
 * With APP_BASE_URL unset this is a no-op: same behaviour as before, still wrong
 * for remote callers, but not newly wrong in some other way.
 */
const ORIGIN = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');

const FIELDS = ['url', 'image_url', 'social_image_url', 'musician_photo', 'media_url', 'thumbnail_url', 'photo_url'];

export const absUrl = (u) => (typeof u === 'string' && u.startsWith('/') ? ORIGIN + u : u);

/** Rewrites known URL fields in place, plus the srcset `variants` blob. */
export function absMedia(row) {
  if (!row || typeof row !== 'object') return row;
  for (const f of FIELDS) if (f in row) row[f] = absUrl(row[f]);
  // variants is { webp: [{url,w},…], avif: [...] } — the picker reads webp[0].
  if (row.variants && typeof row.variants === 'object') {
    for (const fmt of Object.keys(row.variants)) {
      if (Array.isArray(row.variants[fmt])) {
        row.variants[fmt] = row.variants[fmt].map((v) => (v && v.url ? { ...v, url: absUrl(v.url) } : v));
      }
    }
  }
  return row;
}

export const absMediaAll = (rows) => (Array.isArray(rows) ? rows.map(absMedia) : rows);
