'use strict';

const fs = require('fs');
const path = require('path');
const { fileKind } = require('../engine');

const MAX_FILES = 1000;
const MAX_DEPTH = 6;

/**
 * Expand dropped/selected paths into supported files (folders are searched recursively).
 * Returns [{ path, name, size, kind }] without duplicates.
 */
async function collectFiles(paths) {
  const out = [];
  const seen = new Set();

  async function visit(p, depth) {
    if (out.length >= MAX_FILES) return;
    let st;
    try {
      st = await fs.promises.stat(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      if (depth >= MAX_DEPTH) return;
      let names;
      try {
        names = await fs.promises.readdir(p);
      } catch {
        return;
      }
      names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      for (const n of names) {
        if (!n.startsWith('.')) await visit(path.join(p, n), depth + 1);
      }
    } else if (st.isFile()) {
      const kind = fileKind(p);
      const key = path.resolve(p).toLowerCase();
      if (kind && !seen.has(key)) {
        seen.add(key);
        out.push({ path: p, name: path.basename(p), size: st.size, kind });
      }
    }
  }

  for (const p of paths) await visit(p, 0);
  return out;
}

/** "<name>-compressed.<ext>" next to the original (or in outDir), never overwriting anything. */
async function copyToOutput(tempPath, srcPath, outDir) {
  const dir = outDir || path.dirname(srcPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const ext = path.extname(srcPath);
  const base = path.basename(srcPath, ext);
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? `${base}-compressed${ext}` : `${base}-compressed (${n})${ext}`;
    const target = path.join(dir, name);
    try {
      await fs.promises.copyFile(tempPath, target, fs.constants.COPYFILE_EXCL);
      return target;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('Too many existing output files.');
}

module.exports = { collectFiles, copyToOutput };
