'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { searchLargestInt, searchSmallestInt, searchAggression, psnr, formatBytes } = require('../src/engine/common');

test('searchLargestInt finds the boundary for any width', async () => {
  for (const width of [1, 2, 3, 5]) {
    for (const boundary of [30, 31, 47, 94, 95, 200]) {
      const r = await searchLargestInt(30, 95, async (x) => ({ ok: x <= boundary }), { width });
      assert.equal(r.x, Math.min(boundary, 95), `width ${width}, boundary ${boundary}`);
    }
    const none = await searchLargestInt(30, 95, async (x) => ({ ok: x <= 29 }), { width });
    assert.equal(none, null, `width ${width}: nothing fits`);
  }
});

test('searchLargestInt returns null when nothing is ok', async () => {
  assert.equal(await searchLargestInt(10, 20, async () => ({ ok: false })), null);
});

test('searchSmallestInt finds the lowest ok value', async () => {
  const r = await searchSmallestInt(30, 85, async (x) => ({ ok: x >= 61 }));
  assert.equal(r.x, 61);
});

test('searchAggression lands just under the target', async () => {
  // size shrinks smoothly from 1000 (t=0) to 100 (t=1)
  const size = (t) => 1000 * Math.pow(0.1, t);
  const calls = [];
  const r = await searchAggression(400, async (t) => (calls.push(t), { size: size(t) }));
  assert.ok(r.fits);
  assert.ok(r.result.size <= 400 && r.result.size >= 360, `size ${r.result.size}`);
  assert.ok(calls.length <= 7);
});

test('searchAggression reports when even the strongest setting is too big', async () => {
  const r = await searchAggression(50, async () => ({ size: 100 }));
  assert.equal(r.fits, false);
  assert.equal(r.t, 1);
});

test('psnr', () => {
  const a = Buffer.from([10, 20, 30, 40]);
  assert.equal(psnr(a, a), Infinity);
  assert.ok(Math.abs(psnr(a, Buffer.from([11, 21, 31, 41])) - 48.13) < 0.01);
});

test('formatBytes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(40 * 1024), '40 KB');
  assert.equal(formatBytes(1.57 * 1024 * 1024), '1.57 MB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5 MB');
});
