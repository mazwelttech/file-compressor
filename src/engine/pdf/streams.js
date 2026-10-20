'use strict';

// Low-level helpers for reading and rewriting PDF streams.
// pdf-lib's own Flate decoder ignores /Predictor, so we use Node's zlib and undo predictors here.

const zlib = require('zlib');
const { PDFName, PDFDict, PDFArray, PDFNumber, PDFRawStream, decodePDFRawStream } = require('@cantoo/pdf-lib');

const N = (s) => PDFName.of(s);

/** Wrapper filters we can strip and re-apply without changing what the stream means. */
const UNWRAPPABLE = new Set(['ASCII85Decode', 'ASCIIHexDecode', 'RunLengthDecode', 'LZWDecode', 'FlateDecode']);

function nameOf(obj) {
  return obj instanceof PDFName ? obj.asString().slice(1) : null;
}

/** [{ name, parms }] for a stream dict, normalising single-vs-array forms. */
function getFilters(dict) {
  const f = dict.lookup(N('Filter')) || dict.lookup(N('F'));
  const p = dict.lookup(N('DecodeParms')) || dict.lookup(N('DP'));
  if (!f) return [];
  if (f instanceof PDFName) {
    const parms = p instanceof PDFDict ? p : p instanceof PDFArray ? p.lookupMaybe(0, PDFDict) : undefined;
    return [{ name: nameOf(f), parms }];
  }
  if (f instanceof PDFArray) {
    const out = [];
    for (let i = 0; i < f.size(); i++) {
      const parms = p instanceof PDFArray ? p.lookupMaybe(i, PDFDict) : i === 0 && p instanceof PDFDict ? p : undefined;
      out.push({ name: nameOf(f.lookup(i)), parms });
    }
    return out;
  }
  return null;
}

function num(parms, key, dflt) {
  const v = parms && parms.lookup(N(key));
  return v instanceof PDFNumber ? v.asNumber() : dflt;
}

function hasPredictor(parms) {
  return num(parms, 'Predictor', 1) > 1;
}

/**
 * Undo PNG predictors (Predictor 10-15) on already-inflated data.
 * Returns null for predictors we don't handle (TIFF predictor 2).
 */
function unpredict(data, parms) {
  const predictor = num(parms, 'Predictor', 1);
  if (predictor <= 1) return data;
  if (predictor < 10) return null;
  const colors = num(parms, 'Colors', 1);
  const bpc = num(parms, 'BitsPerComponent', 8);
  const columns = num(parms, 'Columns', 1);
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const stride = rowBytes + 1;
  const rows = Math.floor(data.length / stride);
  const out = Buffer.alloc(rows * rowBytes);
  for (let r = 0; r < rows; r++) {
    const type = data[r * stride];
    const src = r * stride + 1;
    const dst = r * rowBytes;
    const up = dst - rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = data[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = r > 0 ? out[up + i] : 0;
      let v;
      switch (type) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4: {
          const c = i >= bpp && r > 0 ? out[up + i - bpp] : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          return null;
      }
      out[dst + i] = v & 255;
    }
  }
  return out;
}

function inflate(buf, strict = false) {
  // By default Z_SYNC_FLUSH makes zlib return what it has for truncated streams instead of throwing.
  return strict ? zlib.inflateSync(buf) : zlib.inflateSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
}

function deflate(buf) {
  return zlib.deflateSync(buf, { level: 9, memLevel: 9 });
}

/** Run one of pdf-lib's simple decoders (ASCII85, ASCIIHex, LZW, RunLength) on `data`. */
function decodeWithPdfLib(context, name, parms, data) {
  const dict = context.obj({ Filter: name });
  if (parms) dict.set(N('DecodeParms'), parms);
  return Buffer.from(decodePDFRawStream(PDFRawStream.of(dict, data)).getBytes());
}

/**
 * Peel wrapper filters off a stream.
 *   stopAtPredictor: stop before a Flate/LZW filter that carries a predictor (non-image streams
 *                    keep their predictor encoding rather than being decoded).
 *   decodePredictors: undo PNG predictors (images need real pixels).
 * Returns { data, rest } where `rest` are filters left undecoded (e.g. DCTDecode), or
 * null when something couldn't be decoded.
 */
function peelFilters(context, stream, { decodePredictors = false } = {}) {
  const filters = getFilters(stream.dict);
  if (!filters) return null;
  let data = Buffer.from(stream.contents.buffer, stream.contents.byteOffset, stream.contents.length);
  for (let i = 0; i < filters.length; i++) {
    const { name, parms } = filters[i];
    if (!UNWRAPPABLE.has(name)) return { data, rest: filters.slice(i) };
    const predicted = hasPredictor(parms);
    if (predicted && !decodePredictors) return { data, rest: filters.slice(i) };
    try {
      if (name === 'FlateDecode') data = inflate(data);
      else data = decodeWithPdfLib(context, name, parms, data);
    } catch {
      return null;
    }
    if (predicted) {
      data = unpredict(data, parms);
      if (!data) return null;
    }
  }
  return { data, rest: [] };
}

/** Replace a stream's contents and filter list. `rest` entries are { name, parms }. */
function rewriteStream(context, ref, stream, data, rest, extra = {}) {
  const dict = stream.dict;
  dict.delete(N('Filter'));
  dict.delete(N('DecodeParms'));
  dict.delete(N('F'));
  dict.delete(N('DP'));
  if (rest.length === 1) {
    dict.set(N('Filter'), N(rest[0].name));
    if (rest[0].parms) dict.set(N('DecodeParms'), rest[0].parms);
  } else if (rest.length > 1) {
    dict.set(N('Filter'), context.obj(rest.map((r) => r.name)));
    if (rest.some((r) => r.parms)) {
      dict.set(N('DecodeParms'), context.obj(rest.map((r) => r.parms || null)));
    }
  }
  for (const [k, v] of Object.entries(extra)) dict.set(N(k), v);
  context.assign(ref, PDFRawStream.of(dict, data));
}

module.exports = { N, nameOf, getFilters, num, hasPredictor, unpredict, inflate, deflate, peelFilters, rewriteStream };
