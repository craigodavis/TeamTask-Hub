/**
 * Shrink a photographed receipt before it is read and stored.
 *
 * Phone photos arrive at 3–4.5MB. Those bytes were being kept in the database
 * and sent to vision at full size, which made receipts slow to open, bloated
 * the table, and cost more per extraction than it needed to. Four photos from
 * one email came to 16MB.
 *
 * A receipt is text on paper. What matters is that the characters stay sharp
 * enough to read, not that the image is 4000px wide — so the long edge is
 * capped and the JPEG is re-encoded. Typical result is 4MB -> ~300KB, a 90%+
 * saving, with the text visibly unchanged.
 *
 * The same buffer is used for extraction and for storage, so this also makes
 * every vision call smaller and faster.
 *
 * Deliberately NOT applied to PDFs — those are already compact, are parsed as
 * text rather than pixels, and re-encoding one would destroy it.
 */
import sharp from 'sharp';

/** Long edge, in pixels. Receipt text stays legible well below this. */
const MAX_EDGE = 2200;

/** Anything already this small is left alone rather than re-encoded. */
const SKIP_UNDER_BYTES = 400 * 1024;

/**
 * @param {Buffer} buffer
 * @param {string} contentType
 * @returns {Promise<{buffer: Buffer, contentType: string, note: string}>}
 */
export async function compressReceiptImage(buffer, contentType = '') {
  if (!contentType.startsWith('image/')) {
    return { buffer, contentType, note: 'not an image — untouched' };
  }

  try {
    const meta = await sharp(buffer).metadata();
    const longEdge = Math.max(meta.width || 0, meta.height || 0);

    if (buffer.length < SKIP_UNDER_BYTES && longEdge <= MAX_EDGE) {
      return { buffer, contentType, note: `already small (${kb(buffer.length)})` };
    }

    const out = await sharp(buffer)
      // Bake in EXIF orientation. sharp drops metadata on output, so without
      // this a photo taken sideways would be stored — and read — rotated.
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();

    // If the re-encode came out bigger, keep what we were given.
    if (out.length >= buffer.length) {
      return { buffer, contentType, note: `re-encode not smaller, kept original (${kb(buffer.length)})` };
    }

    const saved = Math.round((1 - out.length / buffer.length) * 100);
    return {
      buffer: out,
      contentType: 'image/jpeg',
      note: `${kb(buffer.length)} -> ${kb(out.length)} (${saved}% smaller, ${longEdge}px -> ${Math.min(longEdge, MAX_EDGE)}px)`,
    };
  } catch (err) {
    // A receipt that cannot be re-encoded is still a receipt. Store it as-is
    // rather than losing it to an image-processing failure.
    return { buffer, contentType, note: `compression failed, kept original — ${err.message}` };
  }
}

const kb = (n) => `${Math.round(n / 1024)}KB`;
