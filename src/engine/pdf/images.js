'use strict';

const sharp = require('sharp');
const { PDFName, PDFDict, PDFArray, PDFBool, PDFRawStream } = require('@cantoo/pdf-lib');
const { N, nameOf, num, peelFilters, rewriteStream } = require('./streams');

sharp.cache(false);

/** Don't bother with tiny images: nothing to gain and every re-encode costs a little. */
const MIN_LOSSY_BYTES = 8 * 1024;
const MIN_LOSSLESS_BYTES = 2 * 1024;
/** Only resample when it removes at least this much linear resolution. */
const MIN_SCALE_STEP = 0.85;
/** A lossy re-encode must be at least this much smaller than what we have to be worth the generation loss. */
const MIN_LOSSY_GAIN = 0.97;

function colorInfo(dict) {
  const cs = dict.lookup(N('ColorSpace'));
  if (cs instanceof PDFName) {
    const n = nameOf(cs);
    if (n === 'DeviceRGB' || n === 'CalRGB') return { kind: 'rgb', channels: 3 };
    if (n === 'DeviceGray' || n === 'CalGray') return { kind: 'gray', channels: 1 };
    if (n === 'DeviceCMYK') return { kind: 'cmyk', channels: 4 };
    return { kind: 'other', channels: 0 };
  }
  if (cs instanceof PDFArray && cs.size() > 0) {
    const n = nameOf(cs.lookup(0));
    if (n === 'ICCBased') {
      const prof = cs.lookup(1);
      const c = prof && prof.dict ? num(prof.dict, 'N', 0) : 0;
      if (c === 3) return { kind: 'rgb', channels: 3 };
      if (c === 1) return { kind: 'gray', channels: 1 };
      if (c === 4) return { kind: 'cmyk', channels: 4 };
    }
    if (n === 'CalRGB') return { kind: 'rgb', channels: 3 };
    if (n === 'CalGray') return { kind: 'gray', channels: 1 };
    if (n === 'Indexed' || n === 'I') return { kind: 'indexed', channels: 1 };
  }
  return { kind: 'other', channels: 0 };
}

function effectiveDpi(placement, w, h) {
  if (placement) return Math.max(w / placement.w, h / placement.h);
  return Math.max(w, h) / 8; // never seen on a page: assume it spans about 8 inches
}

function chooseScale(params, placement, w, h) {
  const s = params.maxDpi / effectiveDpi(placement, w, h);
  return s <= MIN_SCALE_STEP ? Math.max(s, 16 / Math.max(w, h)) : 1;
}

/**
 * Heuristic: does this raw 8-bit image look like a photo or scan (many colours, little flat area)
 * rather than flat graphics where JPEG would smear edges? `strict` is used where the result must
 * count as quality-preserving, so only unmistakable photos qualify.
 */
function looksPhotographic(pixels, channels, width, strict) {
  const px = pixels.length / channels;
  const step = Math.max(1, Math.floor(px / 40000));
  const seen = new Set();
  for (let i = 0; i < px; i += step) {
    const o = i * channels;
    seen.add(channels === 1 ? pixels[o] : (pixels[o] << 16) | (pixels[o + 1] << 8) | pixels[o + 2]);
  }
  if (channels === 1 ? seen.size < 32 : seen.size < 800) return false;

  // share of pixels identical to their left neighbour: high for graphics, low for photos
  let pairs = 0;
  let equal = 0;
  const stride = Math.max(1, Math.floor(px / 200000));
  for (let i = 1; i < px; i += stride) {
    if (i % width === 0) continue;
    const o = i * channels;
    let same = true;
    for (let c = 0; c < channels; c++) if (pixels[o + c] !== pixels[o + c - channels]) same = false;
    pairs++;
    if (same) equal++;
  }
  return pairs > 0 && equal / pairs < (strict ? 0.3 : 0.6);
}

/** Zlib stream of PNG-filtered rows: exactly what /FlateDecode with Predictor 15 expects. */
async function predictorFlate(pixels, width, height, channels) {
  const png = await sharp(pixels, { raw: { width, height, channels } })
    .png({ compressionLevel: 9, adaptiveFiltering: true, effort: width * height > 4e6 ? 5 : 8, palette: false })
    .toBuffer();
  const bitDepth = png[24];
  const colorType = png[25];
  const interlace = png[28];
  if (bitDepth !== 8 || interlace !== 0 || colorType !== (channels === 1 ? 0 : 2)) return null;
  const parts = [];
  for (let pos = 8; pos + 8 <= png.length; ) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('latin1', pos + 4, pos + 8);
    if (type === 'IDAT') parts.push(png.subarray(pos + 8, pos + 8 + len));
    if (type === 'IEND') break;
    pos += 12 + len;
  }
  return Buffer.concat(parts);
}

/** libjpeg's standard luminance quantisation table (Annex K), the baseline its "quality" scales. */
const STD_LUMA_QTABLE = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

/** Approximate libjpeg quality (1-100) of an existing JPEG from its first quantisation table; null if unknown. */
function estimateJpegQuality(buf) {
  for (let i = 2; i + 4 < buf.length; ) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (marker === 0xdb) {
      const precision = buf[i + 4] >> 4;
      const id = buf[i + 4] & 15;
      if (id === 0 && precision === 0 && len >= 67) {
        let ratio = 0;
        for (let k = 0; k < 64; k++) ratio += (buf[i + 5 + k] / STD_LUMA_QTABLE[ZIGZAG[k]]) * 100;
        const scale = ratio / 64;
        const q = scale > 100 ? 5000 / scale : (200 - scale) / 2;
        return Math.max(1, Math.min(100, Math.round(q)));
      }
    }
    if (marker === 0xda) return null; // start of scan: no table found
    i += 2 + len;
  }
  return null;
}

/** sharp widens 1-channel input to sRGB on output unless told to stay grey. */
function asChannels(img, channels) {
  return channels === 1 ? img.toColourspace('b-w') : img;
}

/** Encode, then confirm the result really has the channel count the PDF colour space promises. */
async function encodeJpeg(img, channels, q) {
  const out = await asChannels(img, channels).jpeg(jpegOptions(q)).toBuffer();
  const meta = await sharp(out).metadata();
  return meta.channels === channels ? out : null;
}

function jpegOptions(q) {
  return {
    quality: q,
    // Baseline (not progressive): the most widely supported flavour inside PDFs.
    progressive: false,
    trellisQuantisation: true,
    overshootDeringing: true,
    optimiseCoding: true,
    quantisationTable: 3,
    chromaSubsampling: q >= 90 ? '4:4:4' : '4:2:0',
  };
}

/**
 * Optimise one image XObject in place.
 *   job: { context, ref, stream, placement, isMaskTarget, params, cache }
 * Returns { before, after } byte counts of the stream (after === before when untouched).
 * Never throws for problems with a particular image: it is simply left as it was.
 */
async function optimizeImage(job) {
  const { stream } = job;
  const before = stream.contents.length;
  try {
    const after = await optimize(job);
    return { before, after: after == null ? before : after };
  } catch {
    return { before, after: before };
  }
}

async function optimize(job) {
  const { context, ref, stream, params, isMaskTarget } = job;
  const dict = stream.dict;
  const imageMask = dict.lookup(N('ImageMask'));
  if (imageMask instanceof PDFBool && imageMask.asBoolean()) return null;
  if (dict.lookup(N('Mask')) instanceof PDFArray) return null; // colour-key masking needs exact pixel values
  const smask = dict.lookup(N('SMask'));
  if (smask instanceof PDFRawStream && smask.dict.has(N('Matte'))) return null;

  const w = num(dict, 'Width', 0);
  const h = num(dict, 'Height', 0);
  const bpc = num(dict, 'BitsPerComponent', 8);
  if (!w || !h) return null;

  const peeled = peelFilters(context, stream, { decodePredictors: true });
  if (!peeled) return null;
  const cs = colorInfo(dict);
  const placement = job.placement;
  const original = stream.contents.length;

  // ---- JPEG ----------------------------------------------------------------------------
  if (peeled.rest.length === 1 && peeled.rest[0].name === 'DCTDecode') {
    if (cs.kind !== 'rgb' && cs.kind !== 'gray') {
      return null; // CMYK/other: leave exactly as is
    }
    let best = { data: peeled.data, w, h };
    let changed = peeled.data.length < original; // only the wrapper (ASCII85, ...) came off
    if (params.jpegQuality && !isMaskTarget && original >= MIN_LOSSY_BYTES) {
      const meta = await sharp(peeled.data, { failOn: 'none' }).metadata();
      if (meta.channels === cs.channels && meta.width === w && meta.height === h && meta.depth === 'uchar') {
        const scale = chooseScale(params, placement, w, h);
        let img = sharp(peeled.data, { failOn: 'none' });
        if (meta.icc) img = img.keepIccProfile();
        let nw = w;
        let nh = h;
        if (scale < 1) {
          nw = Math.max(1, Math.round(w * scale));
          nh = Math.max(1, Math.round(h * scale));
          img = img.resize({ width: nw, height: nh, fit: 'fill', kernel: 'lanczos3' });
        }
        // Never encode above the source's own quality: that only adds bytes, not detail.
        const srcQ = estimateJpegQuality(peeled.data);
        const q = srcQ ? Math.min(params.jpegQuality, srcQ + 5) : params.jpegQuality;
        const out = await encodeJpeg(img, cs.channels, q);
        if (out && (out.length < best.data.length * MIN_LOSSY_GAIN || (scale < 1 && out.length < best.data.length))) {
          best = { data: out, w: nw, h: nh };
          changed = true;
        }
      }
    }
    if (!changed) return null;
    rewriteStream(context, ref, stream, best.data, [{ name: 'DCTDecode', parms: peeled.rest[0].parms }], {
      Width: context.obj(best.w),
      Height: context.obj(best.h),
    });
    return best.data.length;
  }

  // ---- raw pixels (Flate, LZW, ...) -----------------------------------------------------
  if (peeled.rest.length === 0 && bpc === 8 && cs.channels > 0 && cs.kind !== 'cmyk') {
    const channels = cs.channels;
    if (peeled.data.length !== w * h * channels) return null;
    if (original < MIN_LOSSLESS_BYTES) return null;

    let scale = cs.kind === 'indexed' ? 1 : chooseScale(params, placement, w, h);
    let pixels = peeled.data;
    let nw = w;
    let nh = h;
    if (scale < 1) {
      nw = Math.max(1, Math.round(w * scale));
      nh = Math.max(1, Math.round(h * scale));
      pixels = await sharp(pixels, { raw: { width: w, height: h, channels } })
        .resize({ width: nw, height: nh, fit: 'fill', kernel: 'lanczos3' })
        .raw()
        .toBuffer();
    }

    // lossless candidate (exact pixels, better filtering than most producers use)
    const cacheKey = `${ref.objectNumber}:${nw}x${nh}`;
    let lossless = job.cache && job.cache.get(cacheKey);
    if (lossless === undefined) {
      lossless = await predictorFlate(pixels, nw, nh, channels);
      if (job.cache) job.cache.set(cacheKey, lossless);
    }
    let best = lossless ? { data: lossless, kind: 'flate' } : null;

    // lossy candidate for photographic content when the caller allows it
    const lossyOk =
      params.flateToJpeg && params.jpegQuality && !isMaskTarget && cs.kind !== 'indexed' && original >= MIN_LOSSY_BYTES;
    if (lossyOk && looksPhotographic(pixels, channels, nw, params.strictPhotos)) {
      const out = await encodeJpeg(sharp(pixels, { raw: { width: nw, height: nh, channels } }), channels, params.jpegQuality);
      if (out && (!best || out.length < best.data.length * MIN_LOSSY_GAIN)) best = { data: out, kind: 'jpeg' };
    }

    if (!best || best.data.length >= original) return null;
    const extra = { Width: context.obj(nw), Height: context.obj(nh) };
    if (best.kind === 'jpeg') {
      rewriteStream(context, ref, stream, best.data, [{ name: 'DCTDecode' }], extra);
    } else {
      const parms = context.obj({ Predictor: 15, Colors: channels, BitsPerComponent: 8, Columns: nw });
      rewriteStream(context, ref, stream, best.data, [{ name: 'FlateDecode', parms }], extra);
    }
    return best.data.length;
  }
  return null;
}

module.exports = { optimizeImage, colorInfo, effectiveDpi, looksPhotographic, estimateJpegQuality };
