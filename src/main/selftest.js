'use strict';

// `File Compressor.exe --self-test=<result.json>` exercises the real packaged engine (native
// image library included) without opening a window. CI runs it against the built app so a
// broken installer is caught before anyone downloads it.

const fs = require('fs');
const os = require('os');
const path = require('path');

async function runSelfTest(outFile) {
  const report = { ok: false, steps: [] };
  const step = (name, detail) => report.steps.push({ name, ...detail });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-selftest-'));
  try {
    const sharp = require('sharp');
    const { PDFDocument } = require('@cantoo/pdf-lib');
    const { compressFile } = require('../engine');

    const w = 1400;
    const h = 1000;
    const raw = Buffer.alloc(w * h * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = ((i * 2654435761) >>> 24) ^ ((i / 3) | 0) & 255;
    const jpg = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    const jpgPath = path.join(dir, 'sample.jpg');
    fs.writeFileSync(jpgPath, jpg);

    const png = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
    const pngPath = path.join(dir, 'sample.png');
    fs.writeFileSync(pngPath, png);

    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.drawImage(await doc.embedJpg(jpg), { x: 40, y: 200, width: 500, height: 357 });
    const pdfPath = path.join(dir, 'sample.pdf');
    fs.writeFileSync(pdfPath, await doc.save());

    const cases = [
      ['jpeg-preserve', jpgPath, 'preserve', 0.8],
      ['jpeg-compromise', jpgPath, 'compromise', 0.1],
      ['png-compromise', pngPath, 'compromise', 0.2],
      ['pdf-preserve', pdfPath, 'preserve', 0.9],
      ['pdf-compromise', pdfPath, 'compromise', 0.2],
    ];
    for (const [name, file, mode, frac] of cases) {
      const original = fs.statSync(file).size;
      const target = Math.round(original * frac);
      const r = await compressFile(file, { targetBytes: target, mode, tempDir: dir });
      const good = r.tempPath && fs.existsSync(r.tempPath) && r.size <= target;
      step(name, { status: r.status, original, target, size: r.size, pass: !!good });
      if (!good) throw new Error(`${name} did not reach its target (${r.status}, ${r.size} > ${target})`);
    }
    report.ok = true;
  } catch (e) {
    report.error = String((e && e.stack) || e);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  }
  return report.ok;
}

module.exports = { runSelfTest };
