/**
 * A performer's own photo, uploaded from a phone over a public 24-hour link.
 *
 * This is the only place in the app where an anonymous stranger writes a file
 * to our disk, so the handling is deliberately narrow:
 *
 *   - the bytes never touch disk until they have been decoded (memory storage),
 *     so a rejected upload leaves nothing behind to be served by accident
 *   - the format is decided by DECODING the image, never by its extension or
 *     the Content-Type the client claimed; both are attacker-chosen
 *   - every accepted image is RE-ENCODED rather than stored as sent. That is
 *     what strips EXIF — which on a phone photo carries the GPS coordinates of
 *     wherever it was taken, usually somebody's house — and it also means any
 *     payload smuggled in a comment block or trailing bytes does not survive
 *   - no SVG. It is a document, not a picture: it can carry script, and it is
 *     served from our origin
 *
 * The result lands in the media library's needs-review folder. A performer
 * cannot publish to the website; they can only put something in front of us.
 */
import path from 'path';
import sharp from 'sharp';
import { MEDIA_DIR, generateVariants, safeBase, publicUrl } from './mediaVariants.js';

/** 10MB. A phone photo is 2–5MB; this is roomy without being a free disk. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** How many a single link may send. Enough for "oops, wrong one" twice. */
export const MAX_PHOTOS_PER_LINK = 3;

/**
 * What we will decode. heif covers iPhone HEIC, which is the single most
 * likely thing to arrive here and would be baffling to reject.
 */
export const ACCEPTED = ['jpeg', 'png', 'webp', 'heif', 'gif'];

/** For the file picker's filter — a convenience, never a check. */
export const ACCEPT_ATTR = 'image/jpeg,image/png,image/webp,image/heic,image/heif,image/gif';

export const FORMATS_HUMAN = 'JPEG, PNG, WebP or HEIC';

/**
 * Beyond this we do not even attempt a decode.
 *
 * sharp's own default ceiling is ~268 megapixels, which at 4 bytes a pixel is
 * a gigabyte of resident memory from one request on a server that also runs
 * everything else. 80MP is above every phone and camera anyone will use here
 * (a 48MP iPhone shot is 48MP) and small enough that the decode is survivable.
 */
const MAX_INPUT_PIXELS = 80_000_000;

/** Longest edge we keep. A performer card shows 110px; the site hero shows ~1200. */
const MAX_EDGE = 1600;

/**
 * Decode, downscale and re-encode to JPEG, then build the responsive variants.
 *
 * Throws an Error whose message is safe to show a performer — they are the only
 * person who will ever see it, and "Invalid input" would leave them stuck.
 */
export async function processPhoto(buffer, { nameHint } = {}) {
  if (!buffer?.length) throw new Error('That file came through empty.');

  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw new Error(`We could not read that as an image. Please send a ${FORMATS_HUMAN} photo.`);
  }

  if (!ACCEPTED.includes(meta.format)) {
    throw new Error(`We can't use ${meta.format ? meta.format.toUpperCase() : 'that format'} — please send a ${FORMATS_HUMAN} photo.`);
  }
  if (!meta.width || !meta.height) throw new Error('That image has no size we can read.');
  if (meta.width < 200 || meta.height < 200) {
    throw new Error('That photo is very small — please send one at least 200 pixels wide.');
  }

  const filename = `${safeBase(nameHint || 'performer')}-${Date.now()}.jpg`;
  const abs = path.join(MEDIA_DIR, filename);

  // .rotate() with no argument applies the EXIF orientation and then forgets
  // it, which is the only way to honour a sideways phone photo while still
  // dropping the metadata. sharp writes no metadata unless asked, so the GPS
  // tag goes with it.
  const out = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(abs);

  const v = await generateVariants(abs, filename);

  return {
    filename,
    url: publicUrl(filename),
    mime: 'image/jpeg',
    width: out.width,
    height: out.height,
    size_bytes: out.size,
    variants: v.variants,
    source_format: meta.format,
  };
}
