'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const sharp = require('sharp');
const { PDFDocument, PDFName, PDFRawStream, PDFRef, StandardFonts } = require('@cantoo/pdf-lib');
const { compressFile } = require('../src/engine');
const { scanContent, multiply, findPlacements } = require('../src/engine/pdf/placement');
const { unpredict, peelFilters, N } = require('../src/engine/pdf/streams');
const { photoJpeg, photoPng, photoRaw, screenshotPng } = require('./fixtures');

let dir;
test.before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-pdf-'));
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = (file, targetBytes, mode = 'preserve', extra = {}) =>
  compressFile(file, { targetBytes, mode, tempDir: dir, ...extra });

/** images: [{ kind: 'jpg'|'png', bytes, x, y, w, h }] in points. */
async function makePdf(name, images, { pages = 1, text = 'Hello compressor' } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const embedded = [];
  for (const im of images) embedded.push(im.kind === 'jpg' ? await doc.embedJpg(im.bytes) : await doc.embedPng(im.bytes));
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`${text} (page ${p + 1})`, { x: 50, y: 750, size: 14, font });
    images.forEach((im, i) => page.drawImage(embedded[i], { x: im.x ?? 50, y: im.y ?? 300, width: im.w, height: im.h }));
  }
  const out = path.join(dir, name);
  fs.writeFileSync(out, await doc.save({ useObjectStreams: false }));
  return out;
}

async function imageInfos(file) {
  const doc = await PDFDocument.load(fs.readFileSync(file), { updateMetadata: false });
  const out = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.lookup(N('Subtype')) === N('Image')) {
      const width = obj.dict.lookup(N('Width')).asNumber();
      const height = obj.dict.lookup(N('Height')).asNumber();
      const filter = String(obj.dict.lookup(N('Filter')) || '');
      out.push({ ref, width, height, filter, bytes: obj.contents.length, hasSMask: obj.dict.has(N('SMask')) });
    }
  }
  return out;
}

test('unpredict reverses PNG row filters (all five types)', async () => {
  const raw = await photoRaw(97, 64, { grain: 9 });
  const png = await sharp(raw, { raw: { width: 97, height: 64, channels: 3 } }).png({ adaptiveFiltering: true, compressionLevel: 9 }).toBuffer();
  const idat = [];
  for (let pos = 8; pos + 8 <= png.length; ) {
    const len = png.readUInt32BE(pos);
    if (png.toString('latin1', pos + 4, pos + 8) === 'IDAT') idat.push(png.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  const filtered = zlib.inflateSync(Buffer.concat(idat));
  const types = new Set();
  for (let r = 0; r < 64; r++) types.add(filtered[r * (97 * 3 + 1)]);
  assert.ok(types.size >= 3, `exercised filter types ${[...types]}`);
  const parms = { lookup: (k) => ({ Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: 97 })[k.asString().slice(1)] && { asNumber: () => ({ Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: 97 })[k.asString().slice(1)] } };
  const { PDFNumber } = require('@cantoo/pdf-lib');
  const fake = { lookup: (k) => { const v = { Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: 97 }[k.asString().slice(1)]; return v === undefined ? undefined : PDFNumber.of(v); } };
  assert.deepEqual(unpredict(filtered, fake), raw);
});

test('content scanner tracks the CTM through q/Q/cm and inline images', async () => {
  const ops = [];
  const body = Buffer.from(
    'q 100 0 0 50 10 20 cm /Im1 Do Q\n' +
      'q 0.5 0 0 0.5 0 0 cm 2 0 0 2 5 5 cm /Im2 Do Q\n' +
      '(a string with \\) and Do inside) Tj [ (x) -20 (y) ] TJ BT /F1 12 Tf ET\n' +
      'BI /W 2 /H 2 /BPC 8 /CS /G ID \x00\x01 Q Do EI\n' +
      '% comment Do\n/Im3 Do',
    'latin1',
  );
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  scanContent(body, (op, operands) => {
    if (op === 'q') stack.push(ctm);
    else if (op === 'Q') ctm = stack.pop();
    else if (op === 'cm') ctm = multiply(operands.slice(-6), ctm);
    else if (op === 'Do') ops.push([operands.at(-1), Math.hypot(ctm[0], ctm[1])]);
  });
  assert.deepEqual(ops, [['/Im1', 100], ['/Im2', 1], ['/Im3', 1]]);
});

test('placement: effective DPI comes from how large the image is drawn', async () => {
  const bytes = await photoJpeg(1200, 900, { quality: 90 });
  const f = await makePdf('place.pdf', [{ kind: 'jpg', bytes, w: 288, h: 216 }]); // 4in x 3in => 300 DPI
  const doc = await PDFDocument.load(fs.readFileSync(f));
  const placements = findPlacements(doc);
  const [info] = await imageInfos(f);
  const p = placements.get(info.ref.objectNumber);
  assert.ok(p, 'image found');
  assert.ok(Math.abs(p.w - 4) < 0.01 && Math.abs(p.h - 3) < 0.01, JSON.stringify(p));
});

test('PDF: high-DPI JPEG is downsampled to <=300 DPI when that fits the target (preserve mode)', async () => {
  const bytes = await photoJpeg(3000, 2000, { quality: 95, grain: 6 });
  const f = await makePdf('hi.pdf', [{ kind: 'jpg', bytes, w: 360, h: 240 }]); // 5in => 600 DPI
  const orig = fs.statSync(f).size;
  const r = await run(f, Math.round(orig * 0.4));
  assert.equal(r.status, 'done');
  assert.equal(r.preserved, true);
  assert.ok(r.size <= orig * 0.4);
  const [img] = await imageInfos(r.tempPath);
  assert.ok(img.width >= 1500 && img.width < 3000, `width ${img.width} (>=300 DPI at 5in)`);
  assert.equal(img.filter, '/DCTDecode');
});

test('PDF: text content is left byte-for-byte equivalent', async () => {
  const bytes = await photoJpeg(1500, 1000, { quality: 95, grain: 6 });
  const f = await makePdf('text.pdf', [{ kind: 'jpg', bytes, w: 360, h: 240 }], { pages: 3, text: 'Keep this text exactly' });
  const orig = fs.statSync(f).size;
  const r = await run(f, Math.round(orig * 0.5), 'compromise');
  const contents = async (file) => {
    const doc = await PDFDocument.load(fs.readFileSync(file));
    return doc.getPages().map((p) => {
      const c = doc.context.lookup(p.node.get(N('Contents')));
      const streams = c instanceof PDFRawStream ? [c] : c.asArray().map((r) => doc.context.lookup(r));
      return streams.map((s) => peelFilters(doc.context, s, { decodePredictors: true }).data.toString('latin1')).join('\n');
    });
  };
  assert.deepEqual(await contents(r.tempPath), await contents(f));
  assert.equal((await PDFDocument.load(fs.readFileSync(r.tempPath))).getPageCount(), 3);
});

test('PDF: a PNG photo becomes a JPEG without touching a flat screenshot (preserve mode)', async () => {
  const photo = await photoPng(1200, 800, { grain: 5 });
  const shot = await screenshotPng(800, 500);
  const f = await makePdf('mix.pdf', [
    { kind: 'png', bytes: photo, x: 50, y: 400, w: 400, h: 267 },
    { kind: 'png', bytes: shot, x: 50, y: 50, w: 300, h: 188 },
  ]);
  const before = await imageInfos(f);
  const orig = fs.statSync(f).size;
  const r = await run(f, Math.round(orig * 0.5));
  assert.equal(r.status, 'done');
  const after = await imageInfos(r.tempPath);
  const byWidth = (list, w) => list.find((i) => i.width === w);
  assert.equal(byWidth(after, 1200).filter, '/DCTDecode', 'photo turned into JPEG');
  assert.equal(byWidth(after, 800).filter, '/FlateDecode', 'screenshot stays lossless');
  // the screenshot's pixels are exactly the same
  const decode = async (file, w) => {
    const doc = await PDFDocument.load(fs.readFileSync(file));
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream && obj.dict.lookup(N('Width'))?.asNumber() === w && obj.dict.lookup(N('Subtype')) === N('Image')) {
        return peelFilters(doc.context, obj, { decodePredictors: true }).data;
      }
    }
  };
  assert.deepEqual(await decode(r.tempPath, 800), await decode(f, 800));
  assert.ok(before.length === after.length);
});

test('PDF: alpha (SMask) images keep their mask', async () => {
  const raw = await photoRaw(900, 600, { grain: 4 });
  const alpha = Buffer.alloc(900 * 600, 255);
  alpha.fill(40, 0, 900 * 100);
  const png = await sharp(raw, { raw: { width: 900, height: 600, channels: 3 } }).joinChannel(alpha, { raw: { width: 900, height: 600, channels: 1 } }).png().toBuffer();
  const f = await makePdf('alpha.pdf', [{ kind: 'png', bytes: png, w: 300, h: 200 }]);
  const orig = fs.statSync(f).size;
  const r = await run(f, Math.round(orig * 0.3), 'compromise');
  assert.equal(r.status, 'done');
  const imgs = await imageInfos(r.tempPath);
  assert.ok(imgs.some((i) => i.hasSMask), 'base image still references an SMask');
  assert.equal(imgs.length, 2);
});

test('PDF: compromise mode meets the target and lowers quality', async () => {
  const a = await photoJpeg(2400, 1600, { quality: 95, grain: 8, seed: 3 });
  const b = await photoJpeg(2400, 1600, { quality: 95, grain: 8, seed: 4 });
  const f = await makePdf('big.pdf', [
    { kind: 'jpg', bytes: a, x: 50, y: 450, w: 400, h: 267 },
    { kind: 'jpg', bytes: b, x: 50, y: 100, w: 400, h: 267 },
  ]);
  const orig = fs.statSync(f).size;
  const target = Math.round(orig * 0.08);
  const r = await run(f, target, 'compromise');
  assert.equal(r.status, 'done');
  assert.equal(r.preserved, false);
  assert.ok(r.size <= target, `${r.size} > ${target}`);
  assert.ok(r.size >= target * 0.5, `not absurdly far under the target (${r.size} vs ${target})`);
});

test('PDF: needs-compromise offers the best preserved file; unreachable target is reported', async () => {
  const a = await photoJpeg(2400, 1600, { quality: 95, grain: 8, seed: 5 });
  const f = await makePdf('tight.pdf', [{ kind: 'jpg', bytes: a, w: 400, h: 267 }]);
  const orig = fs.statSync(f).size;
  const tight = await run(f, Math.round(orig * 0.02));
  assert.equal(tight.status, 'needs-compromise');
  assert.ok(tight.size <= orig);
  const impossible = await run(f, 500, 'compromise');
  assert.equal(impossible.status, 'cannot-reach');
  assert.ok(impossible.size < orig);
  assert.equal((await PDFDocument.load(fs.readFileSync(impossible.tempPath))).getPageCount(), 1);
});

test('PDF: ASCII85-wrapped streams are unwrapped losslessly', async () => {
  // build a PDF whose image stream is [/ASCII85Decode /DCTDecode] like many older producers write
  const jpg = await photoJpeg(1000, 700, { quality: 90, grain: 4 });
  const base = await makePdf('a85.pdf', [{ kind: 'jpg', bytes: jpg, w: 300, h: 210 }]);
  const doc = await PDFDocument.load(fs.readFileSync(base));
  const ctx = doc.context;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.lookup(N('Subtype')) === N('Image')) {
      const enc = ascii85(obj.contents);
      obj.dict.set(N('Filter'), ctx.obj(['ASCII85Decode', 'DCTDecode']));
      ctx.assign(ref, PDFRawStream.of(obj.dict, enc));
    }
  }
  const wrapped = path.join(dir, 'a85-wrapped.pdf');
  fs.writeFileSync(wrapped, await doc.save({ useObjectStreams: false }));
  const orig = fs.statSync(wrapped).size;
  const r = await run(wrapped, Math.round(orig * 0.9));
  assert.equal(r.status, 'done');
  assert.equal(r.preserved, true);
  const [img] = await imageInfos(r.tempPath);
  assert.equal(img.filter, '/DCTDecode');
  assert.ok(r.size < orig * 0.85, `${r.size} vs ${orig}`);
});

function ascii85(buf) {
  let out = '';
  for (let i = 0; i < buf.length; i += 4) {
    const chunk = buf.subarray(i, i + 4);
    const n = chunk.length;
    let v = 0;
    for (let k = 0; k < 4; k++) v = v * 256 + (k < n ? chunk[k] : 0);
    if (v === 0 && n === 4) {
      out += 'z';
      continue;
    }
    const digits = [];
    for (let k = 0; k < 5; k++) {
      digits.unshift(String.fromCharCode((v % 85) + 33));
      v = Math.floor(v / 85);
    }
    out += digits.slice(0, n + 1).join('');
  }
  return Buffer.from(out + '~>', 'latin1');
}

test('PDF: password-protected and damaged files give clear errors', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]).drawText('secret', { x: 20, y: 100 });
  await doc.encrypt({ userPassword: 'pw', ownerPassword: 'pw' });
  const enc = path.join(dir, 'enc.pdf');
  fs.writeFileSync(enc, await doc.save());
  await assert.rejects(run(enc, 100, 'preserve'), /password/i);

  const bad = path.join(dir, 'bad.pdf');
  fs.writeFileSync(bad, Buffer.from('%PDF-1.4\nthis is not really a pdf'));
  await assert.rejects(run(bad, 10), /Couldn't read this PDF/);
});

test('PDF: text-only file that is already small', async () => {
  const f = await makePdf('tiny.pdf', []);
  const r = await run(f, 10 * 1024 * 1024);
  assert.equal(r.status, 'already-small');
});

test('PDF: never returns a bigger file than the original', async () => {
  const f = await makePdf('small.pdf', [], { pages: 2 });
  const orig = fs.statSync(f).size;
  const r = await run(f, 1, 'compromise');
  assert.ok(r.size <= orig);
  if (r.tempPath) assert.ok(fs.statSync(r.tempPath).size <= orig);
});
