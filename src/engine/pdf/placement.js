'use strict';

// Works out how large (in inches) each image is actually drawn on the page, so downsampling
// can target an effective DPI instead of guessing. We only need q / Q / cm / Do, so this is a
// small content-stream scanner rather than a full interpreter.

const { PDFName, PDFDict, PDFArray, PDFRef, PDFNumber, PDFRawStream } = require('@cantoo/pdf-lib');
const { N, nameOf, peelFilters } = require('./streams');

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const ch of '()<>[]{}/%') DELIM[ch.charCodeAt(0)] = 1;

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const IDENTITY = [1, 0, 0, 1, 0, 0];

function multiply(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

/**
 * Calls onOp(operator, operands) for q, Q, cm and Do only.
 * Operands are numbers, '/Name' strings, or null for anything else.
 */
function scanContent(bytes, onOp) {
  const n = bytes.length;
  let i = 0;
  let operands = [];
  while (i < n) {
    const c = bytes[i];
    if (WS[c]) {
      i++;
    } else if (c === 0x25) {
      while (i < n && bytes[i] !== 10 && bytes[i] !== 13) i++;
    } else if (c === 0x28) {
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const ch = bytes[i];
        if (ch === 0x5c) i++;
        else if (ch === 0x28) depth++;
        else if (ch === 0x29) depth--;
        i++;
      }
      operands.push(null);
    } else if (c === 0x3c && bytes[i + 1] !== 0x3c) {
      while (i < n && bytes[i] !== 0x3e) i++;
      i++;
      operands.push(null);
    } else if (c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x29) {
      // dict/array/proc delimiters: their contents just become (ignored) operands
      i += (c === 0x3c || c === 0x3e) && bytes[i + 1] === c ? 2 : 1;
    } else if (c === 0x2f) {
      let j = i + 1;
      while (j < n && !WS[bytes[j]] && !DELIM[bytes[j]]) j++;
      operands.push(bytes.toString('latin1', i, j));
      i = j;
    } else {
      let j = i;
      while (j < n && !WS[bytes[j]] && !DELIM[bytes[j]]) j++;
      const tok = bytes.toString('latin1', i, j);
      i = j;
      if (NUMBER.test(tok)) {
        operands.push(parseFloat(tok));
        continue;
      }
      if (tok === 'BI') {
        // inline image: skip dictionary and binary data up to EI
        let k = i;
        while (k < n - 1 && !(WS[bytes[k]] && bytes[k + 1] === 0x49 && bytes[k + 2] === 0x44 && (WS[bytes[k + 3]] || k + 3 >= n))) k++;
        k += 4;
        while (k < n - 1 && !(WS[bytes[k]] && bytes[k + 1] === 0x45 && bytes[k + 2] === 0x49 && (k + 3 >= n || WS[bytes[k + 3]] || DELIM[bytes[k + 3]]))) k++;
        i = k + 3;
      } else if (tok === 'q' || tok === 'Q' || tok === 'cm' || tok === 'Do') {
        onOp(tok, operands);
      }
      operands = [];
    }
  }
}

function contentBytes(context, streamOrArray) {
  const parts = [];
  const add = (obj) => {
    const s = obj instanceof PDFRef ? context.lookup(obj) : obj;
    if (s instanceof PDFRawStream) {
      const p = peelFilters(context, s, { decodePredictors: true });
      if (p && p.rest.length === 0) parts.push(p.data, Buffer.from('\n'));
    } else if (s instanceof PDFArray) {
      for (let i = 0; i < s.size(); i++) add(s.get(i));
    }
  };
  add(streamOrArray);
  return Buffer.concat(parts);
}

/**
 * Map of image object number -> { w, h } with the largest size in inches it is drawn at.
 * Never throws: unreadable pages simply contribute nothing.
 */
function findPlacements(doc) {
  const context = doc.context;
  const placements = new Map();
  let budget = 200000; // operators we are willing to look at across the whole document

  const record = (objNum, ctm) => {
    const w = Math.hypot(ctm[0], ctm[1]) / 72;
    const h = Math.hypot(ctm[2], ctm[3]) / 72;
    if (!(w > 0 && h > 0)) return;
    const prev = placements.get(objNum);
    if (!prev) placements.set(objNum, { w, h });
    else {
      prev.w = Math.max(prev.w, w);
      prev.h = Math.max(prev.h, h);
    }
  };

  const walk = (bytes, resources, ctm0, depth, seenForms) => {
    const xobjects = resources && resources.lookupMaybe(N('XObject'), PDFDict);
    let ctm = ctm0;
    const stack = [];
    scanContent(bytes, (op, operands) => {
      if (--budget < 0) return;
      if (op === 'q') {
        if (stack.length < 64) stack.push(ctm);
      } else if (op === 'Q') {
        if (stack.length) ctm = stack.pop();
      } else if (op === 'cm') {
        const m = operands.slice(-6);
        if (m.length === 6 && m.every((v) => typeof v === 'number')) ctm = multiply(m, ctm);
      } else if (op === 'Do' && xobjects) {
        const name = operands[operands.length - 1];
        if (typeof name !== 'string') return;
        const ref = xobjects.get(N(name.slice(1)));
        const obj = ref instanceof PDFRef ? context.lookup(ref) : ref;
        if (!(obj instanceof PDFRawStream)) return;
        const sub = nameOf(obj.dict.lookup(N('Subtype')));
        if (sub === 'Image' && ref instanceof PDFRef) {
          record(ref.objectNumber, ctm);
        } else if (sub === 'Form' && ref instanceof PDFRef && depth < 6 && !seenForms.has(ref.objectNumber)) {
          const matrix = obj.dict.lookupMaybe(N('Matrix'), PDFArray);
          const m = matrix ? matrix.asArray().map((v) => (v instanceof PDFNumber ? v.asNumber() : 0)) : IDENTITY;
          const body = contentBytes(context, obj);
          const nextSeen = new Set(seenForms).add(ref.objectNumber);
          walk(body, obj.dict.lookupMaybe(N('Resources'), PDFDict) || resources, m.length === 6 ? multiply(m, ctm) : ctm, depth + 1, nextSeen);
        }
      }
    });
  };

  for (const page of doc.getPages()) {
    try {
      const node = page.node;
      const contents = node.get(N('Contents'));
      if (!contents) continue;
      walk(contentBytes(context, contents), node.Resources(), IDENTITY, 0, new Set());
    } catch {
      // ignore unreadable page; its images fall back to the default DPI assumption
    }
  }
  return placements;
}

module.exports = { findPlacements, scanContent, multiply };
