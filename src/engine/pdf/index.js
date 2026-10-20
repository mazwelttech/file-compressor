'use strict';

const fs = require('fs');
const path = require('path');
const {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFRef,
  PDFStream,
  PDFRawStream,
  EncryptedPDFError,
} = require('@cantoo/pdf-lib');
const { UserError, throwIfAborted, searchAggression, tempName } = require('../common');
const { N, nameOf, getFilters, inflate, peelFilters, rewriteStream, deflate } = require('./streams');
const { findPlacements } = require('./placement');
const { optimizeImage } = require('./images');

/**
 * Settings for the "quality preserved" passes, mildest first. The last one is the most we are
 * willing to do without calling it a compromise: JPEG quality 85 and images kept at >= 300 DPI
 * (print quality). Photos stored losslessly (Flate) may become JPEG at these levels, but only
 * when they are unmistakably photographic (`strictPhotos`), so screenshots and line art stay exact.
 */
const PRESERVE_LEVELS = [
  { jpegQuality: null, maxDpi: Infinity, flateToJpeg: false, label: 'lossless' },
  { jpegQuality: 92, maxDpi: 600, flateToJpeg: true, strictPhotos: true, label: 'JPEG quality 92, up to 600 DPI' },
  { jpegQuality: 88, maxDpi: 450, flateToJpeg: true, strictPhotos: true, label: 'JPEG quality 88, up to 450 DPI' },
  { jpegQuality: 85, maxDpi: 300, flateToJpeg: true, strictPhotos: true, label: 'JPEG quality 85, up to 300 DPI' },
];

/** t in (0, 1]: 0 = end of the preserved range, 1 = as small as we are willing to go. */
function compromiseParams(t) {
  const jpegQuality = Math.round(85 - 45 * t);
  const maxDpi = Math.round(300 * Math.pow(0.2, t));
  return { jpegQuality, maxDpi, flateToJpeg: true, strictPhotos: false, label: `JPEG quality ${jpegQuality}, up to ${maxDpi} DPI` };
}

async function loadDoc(bytes) {
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
  } catch (e) {
    if (e instanceof EncryptedPDFError || /encrypt/i.test(String(e && e.message))) {
      throw new UserError('This PDF is password-protected. Remove the password first, then compress it.', 'ENCRYPTED');
    }
    throw new UserError("Couldn't read this PDF. It may be damaged.", 'BAD_PDF');
  }
  if (doc.isEncrypted) {
    throw new UserError('This PDF is password-protected. Remove the password first, then compress it.', 'ENCRYPTED');
  }
  // Damaged files can "load" as an empty shell; make sure there is a real page tree.
  let pages = 0;
  try {
    pages = doc.getPageCount();
  } catch {
    pages = 0;
  }
  if (pages < 1) throw new UserError("Couldn't read this PDF. It may be damaged.", 'BAD_PDF');
  return doc;
}

function isImage(obj) {
  return obj instanceof PDFRawStream && nameOf(obj.dict.lookup(N('Subtype'))) === 'Image';
}

/** Facts about the document that don't change between passes. */
async function analyze(bytes) {
  const doc = await loadDoc(bytes);
  const context = doc.context;
  const placements = findPlacements(doc);
  const maskTargets = new Set();
  const images = [];
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (!isImage(obj)) continue;
    images.push(ref.objectNumber);
    for (const key of ['SMask', 'Mask']) {
      const target = obj.dict.get(N(key));
      if (target instanceof PDFRef) {
        maskTargets.add(target.objectNumber);
        // a mask is drawn exactly where its image is
        if (placements.has(ref.objectNumber) && !placements.has(target.objectNumber)) {
          placements.set(target.objectNumber, placements.get(ref.objectNumber));
        }
      }
    }
  }
  return { pageCount: doc.getPageCount(), placements, maskTargets, imageCount: images.length, cache: new Map() };
}

async function mapPool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

function isCleanFlate(stream) {
  const filters = getFilters(stream.dict);
  if (!filters || filters.length !== 1 || filters[0].name !== 'FlateDecode') return true; // not a bare Flate stream
  try {
    inflate(Buffer.from(stream.contents.buffer, stream.contents.byteOffset, stream.contents.length), true);
    return true;
  } catch {
    return false;
  }
}

const SKIP_TYPES = new Set(['ObjStm', 'XRef', 'Metadata', 'EmbeddedFile']);

/** Lossless: strip ASCII85/hex wrappers and (re)compress plain streams with the best Flate level. */
function recompressPlain(context, ref, stream) {
  const dict = stream.dict;
  if (SKIP_TYPES.has(nameOf(dict.lookup(N('Type'))))) return;
  if (isImage(stream)) return;
  const original = stream.contents.length;
  if (original < 64) return;
  const peeled = peelFilters(context, stream, { decodePredictors: false });
  if (!peeled) return;
  if (peeled.rest.length > 0) {
    // something we keep as-is (a codec or a predictor); only take the wrapper off
    if (peeled.data.length < original) rewriteStream(context, ref, stream, peeled.data, peeled.rest);
    return;
  }
  if (peeled.data.length < 128) return;
  const z = deflate(peeled.data);
  // Also rewrite Flate streams that were never properly terminated; strict readers warn about them.
  if (z.length < original * 0.99 || !isCleanFlate(stream)) {
    rewriteStream(context, ref, stream, z, [{ name: 'FlateDecode' }]);
  }
}

/** Remove objects nothing points to (old revisions, thumbnails, orphaned images). */
function dropUnreachable(doc) {
  const context = doc.context;
  const seen = new Set();
  const stack = [];
  const visit = (obj) => {
    if (obj instanceof PDFRef) {
      if (!seen.has(obj.tag)) {
        seen.add(obj.tag);
        visit(context.lookup(obj));
      }
    } else if (obj instanceof PDFDict) stack.push(obj);
    else if (obj instanceof PDFArray) stack.push(obj);
    else if (obj instanceof PDFStream) stack.push(obj.dict);
  };
  const info = context.trailerInfo;
  visit(info.Root);
  visit(info.Info);
  visit(info.Encrypt);
  while (stack.length) {
    const obj = stack.pop();
    if (obj instanceof PDFDict) for (const [, v] of obj.entries()) visit(v);
    else for (let i = 0; i < obj.size(); i++) visit(obj.get(i));
  }
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!seen.has(ref.tag)) context.delete(ref);
  }
}

/**
 * One full optimisation pass over the original file with the given parameters.
 * Returns { bytes, size, images }.
 */
async function runPass(original, analysis, params, { signal, onImage } = {}) {
  const doc = await loadDoc(original);
  const context = doc.context;
  const entries = context.enumerateIndirectObjects();

  const imageJobs = [];
  for (const [ref, obj] of entries) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (isImage(obj)) {
      imageJobs.push({
        context,
        ref,
        stream: obj,
        params,
        cache: analysis.cache,
        placement: analysis.placements.get(ref.objectNumber),
        isMaskTarget: analysis.maskTargets.has(ref.objectNumber),
      });
    } else {
      try {
        recompressPlain(context, ref, obj);
      } catch {
        // leave this stream as it was
      }
    }
  }

  // biggest first so the progress bar front-loads the slow work
  imageJobs.sort((a, b) => b.stream.contents.length - a.stream.contents.length);
  let done = 0;
  let touched = 0;
  await mapPool(imageJobs, 3, async (job) => {
    throwIfAborted(signal);
    const r = await optimizeImage(job);
    if (r.after < r.before) touched++;
    done++;
    if (onImage) onImage(done, imageJobs.length);
  });
  throwIfAborted(signal);

  for (const page of doc.getPages()) page.node.delete(N('Thumb'));
  dropUnreachable(doc);

  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
  return { bytes, size: bytes.length, images: imageJobs.length, imagesOptimized: touched };
}

/** Parse the result again; a PDF we can't read back must never be handed to the user. */
async function verify(bytes, pageCount) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  if (doc.getPageCount() !== pageCount) throw new Error('page count changed');
}

async function compressPdf(inputPath, opts) {
  const { targetBytes, mode, tempDir, signal, onProgress } = opts;
  const original = await fs.promises.readFile(inputPath);
  const originalSize = original.length;
  const base = { kind: 'pdf', originalSize };

  if (originalSize <= targetBytes && mode === 'preserve') {
    return { ...base, status: 'already-small', preserved: true, size: originalSize, tempPath: null, notes: [] };
  }

  const analysis = await analyze(original);
  const estimatedPasses = mode === 'preserve' ? 3 : 5;
  let passNo = 0;
  const pass = async (params) => {
    const startedAt = passNo++;
    const label =
      params.label === 'lossless'
        ? 'Re-packing PDF…'
        : `Optimising ${analysis.imageCount} image${analysis.imageCount === 1 ? '' : 's'} (${params.label})…`;
    if (onProgress) onProgress({ label, fraction: Math.min(0.95, startedAt / estimatedPasses) });
    const r = await runPass(original, analysis, params, {
      signal,
      onImage: (done, total) => {
        if (onProgress) onProgress({ label, fraction: Math.min(0.95, (startedAt + done / total) / estimatedPasses) });
      },
    });
    return { ...r, params };
  };

  const finish = async (r, status, preserved) => {
    const notes = [];
    if (r.params.label !== 'lossless' && analysis.imageCount) notes.push(r.params.label);
    // The smaller of the two, always: an "optimised" file that grew is never worth keeping.
    if (r.size >= originalSize) {
      return { ...base, status, preserved, size: originalSize, tempPath: null, notes: [] };
    }
    await verify(r.bytes, analysis.pageCount);
    const tempPath = tempName(tempDir, path.basename(inputPath, path.extname(inputPath)), '.pdf');
    await fs.promises.writeFile(tempPath, r.bytes);
    return { ...base, status, preserved, size: r.size, tempPath, notes, pages: analysis.pageCount };
  };

  if (mode === 'preserve') {
    const strongest = PRESERVE_LEVELS[PRESERVE_LEVELS.length - 1];
    const best = await pass(strongest);
    throwIfAborted(signal);
    if (best.size > targetBytes) {
      return finish(best, 'needs-compromise', true);
    }
    // it fits; use the mildest settings that still do
    for (const level of PRESERVE_LEVELS.slice(0, -1)) {
      const r = await pass(level);
      throwIfAborted(signal);
      if (r.size <= targetBytes) return finish(r, 'done', true);
    }
    return finish(best, 'done', true);
  }

  const found = await searchAggression(targetBytes, async (t) => pass(compromiseParams(t)), {
    maxPasses: 6,
    signal,
  });
  return finish(found.result, found.fits ? 'done' : 'cannot-reach', false);
}

module.exports = { compressPdf, analyze, runPass, PRESERVE_LEVELS, compromiseParams };
