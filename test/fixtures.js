'use strict';
// Synthetic-but-photo-like test images and PDFs. Everything is generated at test time
// so the suite runs anywhere (including the Windows CI runner) without binary fixtures.

const sharp = require('sharp');

// Small deterministic PRNG so runs are repeatable.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noiseLayer(width, height, cell, rand) {
  const w = Math.max(2, Math.ceil(width / cell));
  const h = Math.max(2, Math.ceil(height / cell));
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(rand() * 256);
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .resize(width, height, { kernel: 'cubic' })
    .raw()
    .toBuffer();
}

/**
 * RGB "photograph": several octaves of smooth noise, a few hard-edged shapes and film grain.
 * `grain` is the amplitude of the per-pixel noise (0 = clean, 12 = grainy).
 */
async function photoRaw(width, height, { seed = 1, grain = 6 } = {}) {
  const rand = rng(seed);
  const layers = [
    [width / 3, 0.55],
    [width / 12, 0.28],
    [width / 48, 0.12],
  ];
  const out = new Float32Array(width * height * 3);
  for (const [cell, weight] of layers) {
    const l = await noiseLayer(width, height, Math.max(2, cell), rand);
    for (let i = 0; i < out.length; i++) out[i] += l[i] * weight;
  }
  const buf = Buffer.alloc(out.length);
  for (let i = 0; i < out.length; i++) {
    const g = (rand() - 0.5) * 2 * grain;
    buf[i] = Math.max(0, Math.min(255, Math.round(out[i] * 0.9 + 12 + g)));
  }
  // hard edges: a few filled rectangles
  for (let n = 0; n < 6; n++) {
    const x0 = Math.floor(rand() * width * 0.7);
    const y0 = Math.floor(rand() * height * 0.7);
    const rw = Math.floor(width * (0.05 + rand() * 0.2));
    const rh = Math.floor(height * (0.05 + rand() * 0.2));
    const c = [rand() * 255, rand() * 255, rand() * 255];
    for (let y = y0; y < Math.min(height, y0 + rh); y++) {
      for (let x = x0; x < Math.min(width, x0 + rw); x++) {
        const i = (y * width + x) * 3;
        buf[i] = c[0];
        buf[i + 1] = c[1];
        buf[i + 2] = c[2];
      }
    }
  }
  return buf;
}

async function photoJpeg(width, height, { quality = 92, seed = 1, grain = 6, extra } = {}) {
  const raw = await photoRaw(width, height, { seed, grain });
  let img = sharp(raw, { raw: { width, height, channels: 3 } });
  if (extra) img = extra(img);
  return img.jpeg({ quality }).toBuffer();
}

async function photoPng(width, height, opts = {}) {
  const raw = await photoRaw(width, height, opts);
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 1 })
    .toBuffer();
}

/** Flat UI-style screenshot: few colours, text-ish stripes. Lossless palette friendly. */
async function screenshotPng(width, height) {
  const buf = Buffer.alloc(width * height * 3);
  const palette = [
    [255, 255, 255],
    [32, 33, 36],
    [26, 115, 232],
    [241, 243, 244],
    [217, 48, 37],
  ];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let c = palette[0];
      if (y < 60) c = palette[2];
      else if (x < 180) c = palette[3];
      else if (y % 24 < 10 && (x * 7 + y * 3) % 97 < 70) c = palette[1];
      else if ((x >> 6) % 5 === 0 && y > 200) c = palette[4];
      const i = (y * width + x) * 3;
      buf[i] = c[0];
      buf[i + 1] = c[1];
      buf[i + 2] = c[2];
    }
  }
  return sharp(buf, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer();
}

module.exports = { rng, photoRaw, photoJpeg, photoPng, screenshotPng };
