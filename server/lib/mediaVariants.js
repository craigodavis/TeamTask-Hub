/**
 * Media manager helpers — shared by the media route and the WordPress importer.
 *
 * Responsive derivatives: on ingest we generate webp + avif at several widths
 * (never upscaling past the original) so the website serves the right-sized,
 * modern-format image to each device. Originals are kept as the fallback.
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Stored alongside the other uploads, served at /api/uploads/media/<file>.
export const MEDIA_DIR = path.join(__dirname, '..', 'uploads', 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

export const PUBLIC_BASE = '/api/uploads/media';
export const WIDTHS = [400, 800, 1200, 1600];
export const FORMATS = ['webp', 'avif'];

export const publicUrl = (filename) => `${PUBLIC_BASE}/${filename}`;

/** A filesystem-safe, readable base name derived from an original filename. */
export function safeBase(originalName) {
  const base = path
    .basename(originalName || '', path.extname(originalName || ''))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'image';
}

// Filenames that signal AI-generated origin — excluded from the WordPress import.
const AI_RE = /(chatgpt|dall[\W_]?e|midjourney|stable[\W_]?diffusion|firefly|\bai[\W_]?gen|generated[\W_]?image|\bsora\b)/i;
export const isLikelyAI = (name = '') => AI_RE.test(name);

/**
 * Generate responsive variants for an already-saved image file.
 * Returns { original, variants, width, height }. Degrades gracefully: if sharp
 * can't read the file (e.g. SVG/exotic format), returns the original only.
 */
/**
 * Above this, don't attempt to resize.
 *
 * Uploads are capped at 500MB, and sharp decodes to raw pixels: every variant
 * pass allocates roughly width x height x 4 bytes, and there are eight passes
 * (four widths, two formats). A 200-megapixel scan is ~800MB per pass, which
 * does not fail the upload -- it exhausts memory and takes the whole process
 * down. 100MP is far beyond any camera anyone here shoots with, so anything
 * past it is a scan or a stitched panorama and is stored as-is: the original
 * still works, it just has no generated sizes.
 */
const MAX_RESIZE_PIXELS = 100_000_000;

export async function generateVariants(absPath, filename) {
  const base = filename.replace(/\.[^.]+$/, '');
  let meta;
  try {
    meta = await sharp(absPath).metadata();
  } catch {
    return { original: { url: publicUrl(filename), w: null, h: null }, variants: null, width: null, height: null };
  }
  const ow = meta.width || null;
  const oh = meta.height || null;

  if (ow && oh && ow * oh > MAX_RESIZE_PIXELS) {
    console.warn(`[media] ${filename} is ${ow}x${oh} (${Math.round(ow * oh / 1e6)}MP) — storing original, skipping variants`);
    return { original: { url: publicUrl(filename), w: ow, h: oh }, variants: null, width: ow, height: oh };
  }

  const variants = { webp: [], avif: [] };

  for (const w of WIDTHS) {
    if (ow && w > ow) continue; // never upscale
    for (const fmt of FORMATS) {
      const out = `${base}-${w}.${fmt}`;
      try {
        await sharp(absPath)
          .resize({ width: w })
          .toFormat(fmt, { quality: fmt === 'avif' ? 50 : 72 })
          .toFile(path.join(MEDIA_DIR, out));
        variants[fmt].push({ w, url: publicUrl(out) });
      } catch {
        /* skip this one variant, keep going */
      }
    }
  }
  return { original: { url: publicUrl(filename), w: ow, h: oh }, variants, width: ow, height: oh };
}

/** Every on-disk file (original + variants) for a media row, for cleanup on delete. */
export function filesFor(row) {
  const files = [row.filename];
  const v = row.variants || {};
  for (const key of Object.keys(v)) {
    const val = v[key];
    if (Array.isArray(val)) {
      // Image sizes: [{ w, url }, …]
      for (const item of val) if (item?.url) files.push(path.basename(item.url));
    } else if (typeof val === 'string') {
      // Video extras: { poster: "…", web: "…" }. Iterating these as arrays
      // walked the URL character by character, so deleting a video left its
      // poster and its 720p copy behind on disk.
      files.push(path.basename(val));
    }
  }
  return files;
}
