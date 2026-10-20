'use strict';

// Renders build/icon.png and build/icon.ico (used by the window, installer and shortcuts)
// from one SVG. Run with `npm run icons`; the outputs are committed so CI doesn't need to.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6366f1"/>
      <stop offset="1" stop-color="#0ea5a4"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <path d="M164 84h140l76 76v256a28 28 0 0 1-28 28H164a28 28 0 0 1-28-28V112a28 28 0 0 1 28-28z" fill="#ffffff"/>
  <path d="M304 84v52a24 24 0 0 0 24 24h52z" fill="#c7d2fe"/>
  <rect x="176" y="196" width="104" height="14" rx="7" fill="#c7d2fe"/>
  <rect x="176" y="228" width="160" height="14" rx="7" fill="#e0e7ff"/>
  <path d="M168 258l78 46-78 46z" fill="#4f46e5" stroke="#4f46e5" stroke-width="12" stroke-linejoin="round"/>
  <path d="M344 258l-78 46 78 46z" fill="#4f46e5" stroke="#4f46e5" stroke-width="12" stroke-linejoin="round"/>
</svg>`;

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  const out = path.join(__dirname, '..', 'build');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'icon.svg'), SVG);
  const svg = Buffer.from(SVG);
  await sharp(svg, { density: 384 }).resize(512, 512).png().toFile(path.join(out, 'icon.png'));

  await sharp(svg, { density: 384 }).resize(112, 112).png({ compressionLevel: 9 }).toFile(path.join(__dirname, '..', 'src', 'renderer', 'logo.png'));

  // ICO container holding PNG-compressed images (supported since Windows Vista).
  const images = [];
  for (const size of ICO_SIZES) {
    images.push({ size, data: await sharp(svg, { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer() });
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size === 256 ? 0 : size, 0);
    e.writeUInt8(size === 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
  console.log('wrote build/icon.png, build/icon.ico, build/icon.svg');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
