'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

class AbortError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'AbortError';
    this.code = 'ABORTED';
  }
}

/** Throws AbortError if the caller cancelled the job. */
function throwIfAborted(signal) {
  if (signal && signal.aborted) throw new AbortError();
}

/** An error whose message is safe and useful to show to the user as-is. */
class UserError extends Error {
  constructor(message, code = 'USER_ERROR') {
    super(message);
    this.name = 'UserError';
    this.code = code;
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1')} ${units[i]}`;
}

/**
 * Largest integer x in [lo, hi] for which `test(x)` reports ok, assuming ok is true for small x
 * and false for large x. `test` returns { ok, ...anything } so callers can keep the encoded
 * buffer. Probes up to `width` values at once per round (encoders are single-threaded, so this
 * turns spare CPU cores into fewer rounds). Returns { x, result } or null if even `lo` fails.
 */
async function searchLargestInt(lo, hi, test, { width = 3, signal } = {}) {
  let best = null;
  let a = lo;
  let b = hi;
  while (a <= b) {
    throwIfAborted(signal);
    const span = b - a + 1;
    const n = Math.min(width, span);
    const probes = [];
    for (let i = 1; i <= n; i++) probes.push(a + Math.floor((span * i) / (n + 1)));
    const results = await Promise.all(probes.map((x) => test(x)));
    throwIfAborted(signal);
    let firstFail = -1;
    for (let i = 0; i < n; i++) {
      if (!results[i].ok) {
        firstFail = i;
        break;
      }
    }
    const lastOk = (firstFail === -1 ? n : firstFail) - 1;
    if (lastOk >= 0) best = { x: probes[lastOk], result: results[lastOk] };
    if (lastOk >= 0) a = probes[lastOk] + 1;
    if (firstFail !== -1) b = probes[firstFail] - 1;
  }
  return best;
}

/** Smallest integer x in [lo, hi] for which `test(x)` is ok, assuming ok flips from false to true. */
async function searchSmallestInt(lo, hi, test, opts) {
  const r = await searchLargestInt(-hi, -lo, async (negX) => test(-negX), opts);
  return r && { x: -r.x, result: r.result };
}

/**
 * Finds the smallest t in (0, 1] whose output fits `target`, where size(t) is
 * non-increasing in t (bigger t = more aggressive). Uses false position on log-size
 * so a handful of (slow) passes lands close to the target instead of far below it.
 * Returns { t, result, fits }. When nothing fits, `fits` is false and the most
 * aggressive attempt is returned.
 */
async function searchAggression(target, run, { maxPasses = 7, tolerance = 0.9, signal, onPass } = {}) {
  const last = await run(1);
  throwIfAborted(signal);
  if (onPass) onPass(1);
  if (last.size > target) return { t: 1, result: last, fits: false };

  let lo = { t: 0, size: null }; // known (or assumed) not to fit
  let hi = { t: 1, result: last }; // known to fit
  for (let pass = 1; pass < maxPasses; pass++) {
    if (hi.result.size >= target * tolerance) break;
    let t;
    if (lo.size == null) {
      t = hi.t / 2;
    } else {
      // interpolate in log space, aiming slightly under the target
      const goal = Math.log(target * 0.97);
      const f = (goal - Math.log(lo.size)) / (Math.log(hi.result.size) - Math.log(lo.size));
      t = lo.t + (hi.t - lo.t) * (Number.isFinite(f) ? f : 0.5);
    }
    const span = hi.t - lo.t;
    t = Math.min(hi.t - span * 0.08, Math.max(lo.t + span * 0.08, t));
    if (hi.t - lo.t < 0.02) break;
    const r = await run(t);
    throwIfAborted(signal);
    if (onPass) onPass(t);
    if (r.size <= target) hi = { t, result: r };
    else lo = { t, size: r.size };
  }
  return { t: hi.t, result: hi.result, fits: true };
}

/** Peak signal-to-noise ratio between two equally sized 8-bit buffers. */
function psnr(a, b) {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  if (sum === 0) return Infinity;
  const mse = sum / a.length;
  return 10 * Math.log10((255 * 255) / mse);
}

function buffersEqual(a, b) {
  return a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.length), Buffer.from(b.buffer, b.byteOffset, b.length)) === 0;
}

async function makeTempDir(prefix = 'filecompressor-') {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

function tempName(dir, base, ext) {
  const safe = base.replace(/[^\w.-]+/g, '_').slice(0, 40);
  return path.join(dir, `${safe}-${crypto.randomBytes(4).toString('hex')}${ext}`);
}

module.exports = {
  AbortError,
  UserError,
  throwIfAborted,
  formatBytes,
  searchLargestInt,
  searchSmallestInt,
  searchAggression,
  psnr,
  buffersEqual,
  makeTempDir,
  tempName,
};
