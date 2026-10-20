'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const {
  UserError,
  throwIfAborted,
  searchLargestInt,
  searchSmallestInt,
  searchAggression,
  psnr,
  buffersEqual,
  tempName,
} = require('./common');

// Files are read into memory and sharp's own cache would only hold file handles open
// (which blocks deleting/overwriting files on Windows).
sharp.cache(false);

/**
 * "Quality preserved" means one of: encoder quality of at least Q_PRESERVE (indistinguishable at
 * normal viewing sizes), or an output within PSNR_PRESERVE dB of the source pixels (which is how
 * we recognise that an already-compressed JPEG can shrink further without visible change).
 */
const Q_PRESERVE = 85;
const PSNR_PRESERVE = 42;
/** Quality range explored by the searches. */
const Q_MAX = 95;
const Q_MIN_PRESERVE = 30;
/** In compromise mode we lower quality down to here before we start shrinking the pixels. */
const Q_BEFORE_RESIZE = 60;
const Q_MIN_COMPROMISE = 35;
/** Never shrink the long edge below this many pixels. */
const MIN_LONG_EDGE = 160;

const SUPPORTED = new Set(['jpeg', 'png', 'webp']);

function isLosslessWebp(buf) {
  if (buf.length < 16 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return false;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const type = buf.toString('ascii', pos, pos + 4);
    if (type === 'VP8L') return true;
    if (type === 'VP8 ') return false;
    pos += 8 + buf.readUInt32LE(pos + 4) + (buf.readUInt32LE(pos + 4) & 1);
  }
  return false;
}

/** Everything a single compression job needs, with a few cached decodes. */
class ImageJob {
  constructor(input, meta, opts) {
    this.input = input;
    this.meta = meta;
    this.opts = opts;
    this.format = meta.format;
    this.originalSize = input.length;
    // after auto-orientation the width/height swap for rotated EXIF orientations
    const swap = meta.orientation && meta.orientation >= 5;
    this.width = swap ? meta.height : meta.width;
    this.height = swap ? meta.width : meta.height;
    this.hasAlpha = !!meta.hasAlpha;
    this._ref = null;
  }

  /** Decoder pipeline with orientation baked in, optional resize, and metadata policy applied. */
  pipeline(scale = 1) {
    let img = sharp(this.input, { failOn: 'none' }).rotate();
    if (scale < 0.999) {
      const w = Math.max(1, Math.round(this.width * scale));
      img = img.resize({ width: w, kernel: 'lanczos3' });
    }
    // sharp widens greyscale to sRGB on output unless told otherwise
    if (this.meta.space === 'b-w') img = img.toColourspace('b-w');
    if (this.opts.keepMetadata) img = img.keepMetadata();
    else if (this.meta.icc) img = img.keepIccProfile(); // keep colours exact; EXIF/XMP/GPS still dropped
    return img;
  }

  /** Smallest scale allowed by MIN_LONG_EDGE. */
  get minScale() {
    return Math.min(1, MIN_LONG_EDGE / Math.max(this.width, this.height));
  }

  /** Reference pixels (sRGB, oriented) for fidelity checks. */
  async reference() {
    if (!this._ref) {
      this._ref = await sharp(this.input, { failOn: 'none' }).rotate().toColourspace('srgb').raw().toBuffer();
    }
    return this._ref;
  }

  async fidelity(encoded) {
    const [ref, got] = await Promise.all([
      this.reference(),
      sharp(encoded, { failOn: 'none' }).toColourspace('srgb').raw().toBuffer(),
    ]);
    return psnr(ref, got);
  }

  progress(label, fraction) {
    if (this.opts.onProgress) this.opts.onProgress({ label, fraction });
  }
}

/* ------------------------------------------------------------------------------------------
 * JPEG and lossy WebP: one quality dial plus an optional resize.
 * ---------------------------------------------------------------------------------------- */

function encoderFor(job, lossyKind) {
  if (lossyKind === 'jpeg') {
    return (scale, q) =>
      job
        .pipeline(scale)
        .jpeg({ quality: q, mozjpeg: true, chromaSubsampling: q >= 90 ? '4:4:4' : '4:2:0' })
        .toBuffer();
  }
  return (scale, q) => job.pipeline(scale).webp({ quality: q, effort: 4, smartSubsample: true }).toBuffer();
}

async function lossyDial(job, lossyKind) {
  const { targetBytes, signal } = job.opts;
  const encode = encoderFor(job, lossyKind);
  const label = lossyKind === 'jpeg' ? 'JPEG' : 'WebP';

  // Encodes are memoised: the searches below revisit the same (scale, quality) points.
  const memo = new Map();
  const enc = (scale, q) => {
    const key = `${scale.toFixed(4)}:${q}`;
    if (!memo.has(key)) {
      job.progress(`Trying ${label} quality ${q}${scale < 1 ? ` at ${Math.round(scale * 100)}% size` : ''}…`);
      memo.set(key, encode(scale, q).then((buf) => ({ size: buf.length, buf, q, scale })));
    }
    return memo.get(key);
  };
  const fits = (scale) => async (q) => {
    const r = await enc(scale, q);
    return { ok: r.size <= targetBytes, ...r };
  };

  if (job.opts.mode === 'preserve') {
    job.progress('Looking for the best quality that fits…');
    const found = await searchLargestInt(Q_MIN_PRESERVE, Q_MAX, fits(1), { signal });
    if (found) {
      const { buf } = found.result;
      if (found.x >= Q_PRESERVE || (await job.fidelity(buf)) >= PSNR_PRESERVE) {
        return { status: 'done', preserved: true, buf, notes: [`${label} quality ${found.x}`, 'visually identical'] };
      }
    }
    // The target needs visible loss. Find the smallest output that is still indistinguishable
    // so the user can decide whether to keep it or compromise.
    job.progress('Checking how small it can get without visible loss…');
    const lowest = found ? found.x + 1 : Q_MIN_PRESERVE;
    const best = await searchSmallestInt(
      lowest,
      Q_PRESERVE,
      async (q) => {
        const r = await enc(1, q);
        return { ok: q >= Q_PRESERVE || (await job.fidelity(r.buf)) >= PSNR_PRESERVE, ...r };
      },
      { signal },
    );
    const r = best.result;
    if (r.size < job.originalSize) {
      return { status: 'needs-compromise', preserved: true, buf: r.buf, notes: [`${label} quality ${r.q}`] };
    }
    return { status: 'needs-compromise', preserved: true, buf: null, notes: [] };
  }

  // compromise: lower quality first, then shrink pixels
  job.progress('Reducing quality to fit…');
  const atFull = await searchLargestInt(Q_MIN_COMPROMISE, Q_MAX, fits(1), { signal });
  if (atFull && atFull.x >= Q_BEFORE_RESIZE) {
    const { buf } = atFull.result;
    return { status: 'done', preserved: atFull.x >= Q_PRESERVE, buf, notes: [`${label} quality ${atFull.x}`] };
  }

  const minScale = job.minScale;
  const resized = await searchAggression(
    targetBytes,
    async (t) => {
      const scale = 1 - t * (1 - minScale);
      job.progress(`Resizing to ${Math.round(scale * 100)}%…`);
      return enc(scale, Q_BEFORE_RESIZE);
    },
    { signal },
  );
  const { scale } = resized.result;
  let chosen = resized.result;
  if (resized.fits) {
    // spend any slack on quality at the chosen size
    const up = await searchLargestInt(Q_BEFORE_RESIZE + 1, 90, fits(scale), { signal });
    if (up) chosen = up.result;
  } else {
    // even the smallest size at Q_BEFORE_RESIZE is too big: squeeze quality at the smallest size
    const squeeze = await searchLargestInt(Q_MIN_COMPROMISE, Q_BEFORE_RESIZE, fits(scale), { signal });
    chosen = squeeze ? squeeze.result : await enc(scale, Q_MIN_COMPROMISE);
  }
  const notes = [`${label} quality ${chosen.q}`];
  if (scale < 0.999) notes.push(`resized to ${Math.round(scale * 100)}%`);
  return {
    status: chosen.size <= targetBytes ? 'done' : 'cannot-reach',
    preserved: false,
    buf: chosen.buf,
    notes,
    scale,
  };
}

/* ------------------------------------------------------------------------------------------
 * PNG
 * ---------------------------------------------------------------------------------------- */

/** True when the image uses at most 256 distinct RGBA values (so a palette PNG is lossless). */
async function fitsInPalette(job) {
  const raw = await sharp(job.input, { failOn: 'none' }).rotate().ensureAlpha().raw().toBuffer();
  const px = new Uint32Array(raw.buffer, raw.byteOffset, raw.length >> 2);
  const seen = new Set();
  for (let i = 0; i < px.length; i++) {
    seen.add(px[i]);
    if (seen.size > 256) return false;
  }
  return true;
}

async function rawRgba(buf) {
  return sharp(buf, { failOn: 'none' }).ensureAlpha().raw().toBuffer();
}

async function pngLossless(job) {
  job.progress('Re-packing PNG…');
  const plain = await job
    .pipeline(1)
    .png({ compressionLevel: 9, adaptiveFiltering: true, effort: 10, palette: false })
    .toBuffer();
  let best = { buf: plain, note: 'optimised PNG encoding' };

  if (job.meta.depth === 'uchar' && (await fitsInPalette(job))) {
    job.progress('Trying an exact palette…');
    const pal = await job
      .pipeline(1)
      .png({ palette: true, quality: 100, colours: 256, dither: 0, effort: 10, compressionLevel: 9 })
      .toBuffer();
    if (pal.length < best.buf.length) {
      // palette quantisers are allowed to approximate, so prove it's pixel-identical
      const [a, b] = await Promise.all([rawRgba(plain), rawRgba(pal)]);
      if (buffersEqual(a, b)) best = { buf: pal, note: 'exact colour palette' };
    }
  }
  return best;
}

async function pngCompromise(job) {
  const { targetBytes, signal } = job.opts;
  const encode = (scale) =>
    job
      .pipeline(scale)
      .png({ palette: true, quality: 100, colours: 256, dither: 1, effort: 3, compressionLevel: 9 })
      .toBuffer();

  job.progress('Reducing to 256 colours…');
  const full = await encode(1);
  if (full.length <= targetBytes) {
    return { status: 'done', preserved: false, buf: full, notes: ['256-colour palette'] };
  }
  const minScale = job.minScale;
  const res = await searchAggression(
    targetBytes,
    async (t) => {
      const scale = 1 - t * (1 - minScale);
      job.progress(`Resizing to ${Math.round(scale * 100)}%…`);
      const buf = await encode(scale);
      return { size: buf.length, buf, scale };
    },
    { signal },
  );
  return {
    status: res.fits ? 'done' : 'cannot-reach',
    preserved: false,
    buf: res.result.buf,
    notes: ['256-colour palette', `resized to ${Math.round(res.result.scale * 100)}%`],
    scale: res.result.scale,
  };
}

/* ------------------------------------------------------------------------------------------
 * Entry point
 * ---------------------------------------------------------------------------------------- */

async function compressImage(inputPath, opts) {
  const { targetBytes, tempDir, signal } = opts;
  const input = await fs.promises.readFile(inputPath);
  let meta;
  try {
    meta = await sharp(input, { failOn: 'none' }).metadata();
  } catch {
    throw new UserError("This file doesn't look like a valid image.", 'BAD_IMAGE');
  }
  if (!SUPPORTED.has(meta.format)) {
    throw new UserError(`Unsupported image format (${meta.format || 'unknown'}). Use JPG, PNG or WebP.`, 'UNSUPPORTED');
  }
  if ((meta.pages || 1) > 1) {
    throw new UserError('Animated images are not supported.', 'UNSUPPORTED');
  }

  const job = new ImageJob(input, meta, opts);
  const originalSize = input.length;
  const ext = path.extname(inputPath) || `.${meta.format === 'jpeg' ? 'jpg' : meta.format}`;

  if (originalSize <= targetBytes && opts.mode === 'preserve') {
    return { kind: 'image', status: 'already-small', preserved: true, originalSize, size: originalSize, tempPath: null, notes: [] };
  }

  let out;
  if (meta.format === 'png' || (meta.format === 'webp' && isLosslessWebp(input))) {
    out = await compressLosslessSource(job);
  } else {
    out = await lossyDial(job, meta.format === 'jpeg' ? 'jpeg' : 'webp');
  }
  throwIfAborted(signal);

  let { buf } = out;
  // Never hand back something bigger than what we were given.
  if (buf && buf.length >= originalSize) {
    buf = null;
    out = { ...out, notes: [] };
  }

  const base = {
    kind: 'image',
    status: out.status,
    preserved: out.preserved,
    originalSize,
    notes: out.notes,
  };
  if (!buf) {
    return { ...base, size: originalSize, tempPath: null };
  }
  const tempPath = tempName(tempDir, path.basename(inputPath, path.extname(inputPath)), ext);
  await fs.promises.writeFile(tempPath, buf);
  const info = await sharp(buf, { failOn: 'none' }).metadata();
  return { ...base, size: buf.length, tempPath, width: info.width, height: info.height };
}

/** PNG and lossless WebP: lossless repack first, then (compromise) palette + resize. */
async function compressLosslessSource(job) {
  const { targetBytes, mode } = job.opts;
  const isPng = job.format === 'png';
  if (mode === 'preserve') {
    let packed;
    if (isPng) {
      packed = await pngLossless(job);
    } else {
      job.progress('Re-packing WebP…');
      packed = {
        buf: await job.pipeline(1).webp({ lossless: true, effort: 6, exact: true }).toBuffer(),
        note: 'optimised lossless WebP',
      };
    }
    if (packed.buf.length <= targetBytes) {
      return { status: 'done', preserved: true, buf: packed.buf, notes: [packed.note, 'pixel-identical'] };
    }
    return {
      status: 'needs-compromise',
      preserved: true,
      buf: packed.buf.length < job.originalSize ? packed.buf : null,
      notes: [packed.note, 'pixel-identical'],
    };
  }
  if (isPng) return pngCompromise(job);
  // lossless WebP → lossy WebP (keeps the file type and any transparency)
  return lossyDial(job, 'webp');
}

module.exports = { compressImage, Q_PRESERVE, PSNR_PRESERVE, SUPPORTED_FORMATS: SUPPORTED, isLosslessWebp };
