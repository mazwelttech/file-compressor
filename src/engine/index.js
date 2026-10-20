'use strict';

const path = require('path');
const { UserError, AbortError, makeTempDir, formatBytes } = require('./common');
const { compressImage } = require('./image');
const { compressPdf } = require('./pdf');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const PDF_EXTS = new Set(['.pdf']);
const SUPPORTED_EXTS = [...IMAGE_EXTS, ...PDF_EXTS];

function fileKind(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (PDF_EXTS.has(ext)) return 'pdf';
  return null;
}

/**
 * Compress one file towards `targetBytes`.
 *
 * mode 'preserve'   - only do things that keep the quality (lossless repacking, visually
 *                     identical re-encodes). Resolves with status:
 *                       'already-small'     the file is already under the target
 *                       'done'              target reached, quality preserved
 *                       'needs-compromise'  target can't be reached without losing quality;
 *                                           `tempPath` (if any) holds the best quality-preserving file
 * mode 'compromise' - trade quality for size until the target is met. Resolves with
 *                       'done' or 'cannot-reach' (smallest we could make).
 *
 * Output is written under `tempDir`; the caller decides where it finally goes.
 */
async function compressFile(file, opts) {
  const kind = fileKind(file);
  if (!kind) throw new UserError('Only JPG, PNG, WebP and PDF files are supported.', 'UNSUPPORTED');
  if (!(opts.targetBytes > 0)) throw new UserError('Choose a target size first.', 'NO_TARGET');
  const tempDir = opts.tempDir || (await makeTempDir());
  const full = { mode: 'preserve', keepMetadata: false, ...opts, tempDir };
  try {
    return kind === 'image' ? await compressImage(file, full) : await compressPdf(file, full);
  } catch (err) {
    if (err instanceof UserError || err instanceof AbortError) throw err;
    if (err && err.code === 'ENOENT') throw new UserError('That file could not be found.', 'MISSING');
    if (err && (err.code === 'EACCES' || err.code === 'EPERM')) throw new UserError("Couldn't open that file (permission denied).", 'DENIED');
    throw err;
  }
}

module.exports = { compressFile, fileKind, SUPPORTED_EXTS, formatBytes, UserError, AbortError };
