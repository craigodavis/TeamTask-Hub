/**
 * Turn an uploaded video into something a phone can actually stream.
 *
 * A clip straight off a phone is 4K and can be hundreds of megabytes. Served
 * as-is, every person who plays it downloads the whole thing at full
 * resolution to watch it in a 560px-wide player -- on tasting-room wifi that
 * buffers badly and burns their data. This produces a 720p H.264 version and
 * the player prefers it, keeping the original on disk untouched.
 *
 * ffmpeg comes from the `ffmpeg-static` npm package rather than the system,
 * because the host is shared cPanel with no root: the package ships a
 * prebuilt binary and `npm install` on deploy puts it in place with no server
 * work. Nothing here shells out to a system ffmpeg, so there is no dependency
 * on the box having one.
 *
 * Transcoding runs AFTER the upload responds. It is minutes of CPU on a large
 * file, and holding the HTTP request open for it would time out the browser
 * and leave the person staring at a stalled progress bar. The row is written
 * immediately with the original playable, and the web version is attached
 * when it is ready.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import ffmpegPath from 'ffmpeg-static';
import { query } from '../db.js';
import { MEDIA_DIR, publicUrl } from './mediaVariants.js';

/** Long edge of the transcoded version. 720p is the sweet spot for a phone. */
const TARGET_HEIGHT = 720;

/** Give up rather than pin a shared CPU forever on a pathological file. */
const TIMEOUT_MS = 20 * 60 * 1000;

const run = (args, timeout = TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).slice(-500))) : resolve(stderr || '')
    );
  });

/**
 * Probe with ffmpeg itself rather than ffprobe: ffmpeg-static ships only the
 * one binary. Decoding a single frame to null is enough, and the dimensions
 * come out of the stream line on stderr.
 *
 * ffmpeg writes that line to stderr and still exits 0, so both branches have
 * to parse it -- reading it only on failure (as this first did) meant the
 * dimensions were always null for a file that decoded fine.
 */
export async function videoDimensions(absPath) {
  const parse = (text) => {
    // "Stream #0:0(und): Video: h264 …, yuv420p, 3840x2160 [SAR 1:1 …" — anchor
    // on the Video stream line so an unrelated WxH elsewhere can't match.
    const line = String(text).split('\n').find((l) => /Stream #.*Video:/.test(l)) || '';
    const m = /(\d{2,5})x(\d{2,5})/.exec(line);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  };
  try {
    return parse(await run(['-i', absPath, '-frames:v', '1', '-f', 'null', '-'], 60_000));
  } catch (e) {
    return parse(e.message);
  }
}

/**
 * Transcode to a 720p MP4 and record it on the media row as `variants.web`.
 *
 * Deliberately not awaited by the upload handler. Failure is logged and left
 * alone: the original is already stored and playable, so a failed transcode
 * degrades to what we had before rather than losing the upload.
 */
export async function transcodeToWeb(mediaId, filename) {
  const src = path.join(MEDIA_DIR, filename);
  const base = filename.replace(/\.[^.]+$/, '');
  const outName = `${base}-720.mp4`;
  const out = path.join(MEDIA_DIR, outName);

  try {
    const started = Date.now();
    await run([
      '-i', src,
      // Scale to 720 on the short edge, keep aspect, and force even dimensions
      // -- H.264 rejects odd ones, which is the usual failure on phone footage.
      '-vf', `scale=-2:'min(${TARGET_HEIGHT},ih)'`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',   // shared CPU: speed matters more than the last few %
      '-crf', '26',            // visually fine at 720p, roughly a tenth the size
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', // metadata first, so playback starts before full download
      '-y', out,
    ]);

    const srcSize = fs.statSync(src).size;
    const outSize = fs.statSync(out).size;

    // If the "web" version came out bigger, the original was already small or
    // well-compressed. Keep the original and throw the transcode away.
    if (outSize >= srcSize) {
      fs.rmSync(out, { force: true });
      console.log(`[video] ${filename}: transcode not smaller (${outSize} >= ${srcSize}), keeping original`);
      return null;
    }

    await query(
      `UPDATE kindred_web.media
          SET variants = COALESCE(variants, '{}'::jsonb) || jsonb_build_object('web', $2::text),
              updated_at = NOW()
        WHERE id = $1`,
      [mediaId, publicUrl(outName)]
    );
    console.log(
      `[video] ${filename}: ${Math.round(srcSize / 1e6)}MB -> ${Math.round(outSize / 1e6)}MB `
      + `(${Math.round((1 - outSize / srcSize) * 100)}% smaller) in ${Math.round((Date.now() - started) / 1000)}s`
    );
    return publicUrl(outName);
  } catch (e) {
    // Leave the original in place; it still plays.
    fs.rmSync(out, { force: true });
    console.error(`[video] ${filename}: transcode failed — ${e.message}`);
    return null;
  }
}
