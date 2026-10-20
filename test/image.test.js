'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');
const { compressFile } = require('../src/engine');
const { photoJpeg, photoPng, photoRaw, screenshotPng } = require('./fixtures');

let dir;
test.before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-img-'));
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(name, buf) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}
const run = (file, targetBytes, mode = 'preserve', extra = {}) =>
  compressFile(file, { targetBytes, mode, tempDir: dir, ...extra });
const rawOf = (buf) => sharp(buf).ensureAlpha().raw().toBuffer();

test('JPEG: a modest target is met at high quality and counts as preserved', async () => {
  const f = write('a.jpg', await photoJpeg(1600, 1200, { quality: 95, grain: 6 }));
  const orig = fs.statSync(f).size;
  const r = await run(f, Math.round(orig * 0.7));
  assert.equal(r.status, 'done');
  assert.equal(r.preserved, true);
  assert.ok(r.size <= orig * 0.7, `${r.size} > ${orig * 0.7}`);
  assert.ok(fs.existsSync(r.tempPath));
  const meta = await sharp(r.tempPath).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 1600);
  assert.equal(meta.height, 1200);
});

test('JPEG: an aggressive target asks for a compromise instead of silently degrading', async () => {
  const f = write('b.jpg', await photoJpeg(1600, 1200, { quality: 95, grain: 8 }));
  const orig = fs.statSync(f).size;
  const r = await run(f, Math.round(orig * 0.02));
  assert.equal(r.status, 'needs-compromise');
  assert.equal(r.preserved, true);
  // the best quality-preserving file is still offered, and is no worse than the original
  assert.ok(r.size <= orig);
});

test('JPEG: compromise mode reaches the target', async () => {
  const f = write('c.jpg', await photoJpeg(2000, 1500, { quality: 95, grain: 8 }));
  const orig = fs.statSync(f).size;
  const target = Math.round(orig * 0.05);
  const r = await run(f, target, 'compromise');
  assert.equal(r.status, 'done');
  assert.equal(r.preserved, false);
  assert.ok(r.size <= target, `${r.size} > ${target}`);
});

test('JPEG: an impossible target returns the smallest result and says so', async () => {
  const f = write('d.jpg', await photoJpeg(1200, 900, { quality: 95, grain: 8 }));
  const r = await run(f, 300, 'compromise');
  assert.equal(r.status, 'cannot-reach');
  assert.ok(r.size < fs.statSync(f).size);
  assert.ok(r.width >= 100 && r.height >= 70, 'never shrinks to nothing');
});

test('already under the target: nothing to do', async () => {
  const f = write('e.jpg', await photoJpeg(400, 300, { quality: 80 }));
  const r = await run(f, 10 * 1024 * 1024);
  assert.equal(r.status, 'already-small');
  assert.equal(r.tempPath, null);
});

test('greyscale JPEG stays greyscale', async () => {
  const raw = await photoRaw(900, 600, { grain: 4 });
  const src = await sharp(raw, { raw: { width: 900, height: 600, channels: 3 } }).greyscale().toColourspace('b-w').jpeg({ quality: 95 }).toBuffer();
  assert.equal((await sharp(src).metadata()).channels, 1);
  const f = write('grey.jpg', src);
  const r = await run(f, Math.round(src.length * 0.6));
  assert.equal(r.status, 'done');
  assert.equal((await sharp(r.tempPath).metadata()).channels, 1);
});

test('EXIF orientation is applied to the pixels, never lost', async () => {
  // 600x300 landscape tagged "rotate 90° CW": should come out portrait 300x600
  const src = await photoJpeg(600, 300, { quality: 95, grain: 5, extra: (i) => i.withMetadata({ orientation: 6 }) });
  assert.equal((await sharp(src).metadata()).orientation, 6);
  const f = write('rot.jpg', src);
  const r = await run(f, Math.round(src.length * 0.7), 'preserve', { keepMetadata: true });
  const out = await sharp(r.tempPath).metadata();
  assert.equal(out.width, 300);
  assert.equal(out.height, 600);
  assert.ok(!out.orientation || out.orientation === 1, `orientation ${out.orientation}`);
});

test('metadata is dropped by default and kept on request', async () => {
  const src = await photoJpeg(800, 600, { quality: 95, grain: 5, extra: (i) => i.withExif({ IFD0: { Copyright: 'Test Suite' } }) });
  const f = write('exif.jpg', src);
  const target = Math.round(src.length * 0.7);
  const stripped = await run(f, target);
  assert.equal((await sharp(stripped.tempPath).metadata()).exif, undefined);
  const kept = await run(f, target, 'preserve', { keepMetadata: true });
  assert.ok((await sharp(kept.tempPath).metadata()).exif);
});

test('PNG: lossless result is pixel-identical', async () => {
  const src = await photoPng(900, 600, { grain: 3 });
  const f = write('p.png', src);
  const r = await run(f, src.length - 1000);
  assert.ok(['done', 'needs-compromise'].includes(r.status));
  assert.equal(r.preserved, true);
  assert.ok(r.tempPath);
  assert.deepEqual(await rawOf(r.tempPath), await rawOf(src));
});

test('PNG: flat graphics collapse to an exact palette', async () => {
  const src = await screenshotPng(1000, 600);
  const f = write('s.png', src);
  const r = await run(f, Math.round(src.length * 0.5));
  assert.equal(r.status, 'done');
  assert.equal(r.preserved, true);
  assert.ok(r.size < src.length * 0.5);
  assert.deepEqual(await rawOf(r.tempPath), await rawOf(src));
});

test('PNG: transparency survives lossless and compromise modes', async () => {
  const raw = await photoRaw(700, 500, { grain: 3 });
  const alpha = Buffer.alloc(700 * 500, 255);
  for (let y = 0; y < 100; y++) alpha.fill(0, y * 700, y * 700 + 350);
  const src = await sharp(raw, { raw: { width: 700, height: 500, channels: 3 } })
    .joinChannel(alpha, { raw: { width: 700, height: 500, channels: 1 } })
    .png()
    .toBuffer();
  const f = write('alpha.png', src);
  for (const mode of ['preserve', 'compromise']) {
    const r = await run(f, Math.round(src.length * 0.4), mode);
    assert.ok(r.tempPath, mode);
    const meta = await sharp(r.tempPath).metadata();
    assert.equal(meta.hasAlpha, true, mode);
    const px = await sharp(r.tempPath).ensureAlpha().raw().toBuffer();
    assert.equal(px[3], 0, `${mode}: transparent corner stays transparent`);
  }
});

test('PNG: compromise reaches a small target', async () => {
  const src = await photoPng(1200, 800, { grain: 6 });
  const f = write('big.png', src);
  const target = Math.round(src.length * 0.1);
  const r = await run(f, target, 'compromise');
  assert.equal(r.status, 'done');
  assert.ok(r.size <= target);
  assert.equal((await sharp(r.tempPath).metadata()).format, 'png');
});

test('WebP: lossy and lossless inputs stay WebP', async () => {
  const raw = await photoRaw(900, 600, { grain: 4 });
  const lossy = await sharp(raw, { raw: { width: 900, height: 600, channels: 3 } }).webp({ quality: 95 }).toBuffer();
  const lossless = await sharp(raw, { raw: { width: 900, height: 600, channels: 3 } }).webp({ lossless: true, effort: 0 }).toBuffer();
  for (const [name, src] of [['lossy.webp', lossy], ['lossless.webp', lossless]]) {
    const f = write(name, src);
    const r = await run(f, Math.round(src.length * 0.6), 'compromise');
    assert.ok(r.tempPath, name);
    assert.equal((await sharp(r.tempPath).metadata()).format, 'webp', name);
    assert.ok(r.size <= src.length * 0.6, name);
  }
  const f = write('lossless2.webp', lossless);
  const r = await run(f, lossless.length, 'preserve'); // equal to the original: already small
  assert.equal(r.status, 'already-small');
  const smaller = await run(f, lossless.length - 1, 'preserve');
  if (smaller.tempPath) assert.deepEqual(await rawOf(smaller.tempPath), await rawOf(lossless));
});

test('errors are friendly', async () => {
  const bad = write('bad.jpg', Buffer.from('this is not an image'));
  await assert.rejects(run(bad, 1000), /valid image/);
  const gif = write('anim.gif', await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).gif().toBuffer());
  await assert.rejects(run(gif, 10), /Only JPG|Unsupported/);
  await assert.rejects(run(path.join(dir, 'nope.jpg'), 1000), /could not be found/);
  await assert.rejects(run(write('x.jpg', await photoJpeg(100, 100)), 0), /target size/);
});

test('cancelling stops the job', async () => {
  const f = write('cancel.jpg', await photoJpeg(2400, 1800, { quality: 95, grain: 8 }));
  const ac = new AbortController();
  const p = run(f, 20000, 'compromise', { signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(p, (e) => e.code === 'ABORTED');
});
