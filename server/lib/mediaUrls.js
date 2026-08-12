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
// Read per call, not once at import. ES modules evaluate every import before the
// importing module's body, so anything captured at module scope here would be
// read BEFORE index.js gets to dotenv.config(). It happens to work today because
// cPanel puts APP_BASE_URL into the process environment before node starts — but
// if that ever stopped being true the only symptom would be every image on the
// site quietly going relative again, which is the bug this file exists to fix.
const origin = () => (process.env.APP_BASE_URL || '').replace(/\/+$/, '');

const FIELDS = ['url', 'image_url', 'social_image_url', 'fb_image_url', 'musician_photo', 'media_url', 'thumbnail_url', 'photo_url'];

export const absUrl = (u) => (typeof u === 'string' && u.startsWith('/') ? origin() + u : u);

/** Rewrites known URL fields in place, plus the srcset `variants` blob. */
export function absMedia(row) {
  if (!row || typeof row !== 'object') return row;
  for (const f of FIELDS) if (f in row) row[f] = absUrl(row[f]);
  // variants is { webp: [{url,w},…], avif: [...] } — the picker reads webp[0].
  // A video's variants is { poster: "/api/uploads/…" } instead: a bare string,
  // not an array. Missing that left the poster relative while the video's own
  // url was absolute, so an announcement embedded cross-origin showed a player
  // with no still frame.
  if (row.variants && typeof row.variants === 'object') {
    for (const fmt of Object.keys(row.variants)) {
      const v = row.variants[fmt];
      if (Array.isArray(v)) {
        row.variants[fmt] = v.map((x) => (x && x.url ? { ...x, url: absUrl(x.url) } : x));
      } else if (typeof v === 'string') {
        row.variants[fmt] = absUrl(v);
      }
    }
  }
  return row;
}

export const absMediaAll = (rows) => (Array.isArray(rows) ? rows.map(absMedia) : rows);
