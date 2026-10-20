'use strict';

// End-to-end check of the real Electron app (needs a display; use xvfb-run on Linux CI).
//   node test/e2e/run.js [screenshotDir]
// Drives the UI with Playwright, stubbing only the native file dialogs.

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright-core');
const sharp = require('sharp');
const { photoJpeg, photoPng } = require('../fixtures');

const root = path.join(__dirname, '..', '..');
const shots = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (shots) fs.mkdirSync(shots, { recursive: true });

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-e2e-'));
  const photo = path.join(work, 'holiday photo.jpg');
  fs.writeFileSync(photo, await photoJpeg(3000, 2000, { quality: 95, grain: 8 }));
  const png = path.join(work, 'diagram.png');
  fs.writeFileSync(png, await photoPng(1200, 800, { grain: 6 }));
  const bad = path.join(work, 'broken.pdf');
  fs.writeFileSync(bad, '%PDF-1.4\n' + 'not really a pdf '.repeat(150000));
  const orig = fs.statSync(photo).size;

  const app = await electron.launch({
    executablePath: process.env.ELECTRON_PATH || require('electron'),
    args: [root, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && console.error(`[page ${m.type()}]`, m.text()));
  await page.setViewportSize({ width: 980, height: 720 }).catch(() => {});
  const shot = async (name) => shots && (await page.screenshot({ path: path.join(shots, `${name}.png`) }));
  const queueFiles = (files) =>
    app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: f });
    }, files);

  try {
    await page.waitForSelector('#empty');
    await shot('01-empty');

    await queueFiles([photo, png, bad]);
    await page.click('#pick-empty');
    await page.waitForSelector('.row >> nth=2');
    assert.equal(await page.locator('.row').count(), 3);

    // 70% of the photo's size: should be met without losing quality
    const kb = Math.round((orig * 0.7) / 1024);
    await page.fill('#size', String(kb));
    await shot('02-files-added');
    await page.click('#go');
    await page.waitForFunction(() => document.querySelectorAll('.row .pill.ok, .row .pill.err, .row .pill.warn').length >= 3, null, { timeout: 60000 });
    await shot('03-first-run');

    const rows = page.locator('.row');
    const photoRow = rows.nth(0);
    assert.match(await photoRow.innerText(), /Quality preserved/);
    assert.match(await rows.nth(2).innerText(), /Couldn't read this PDF/);
    assert.ok(fs.existsSync(path.join(work, 'holiday photo-compressed.jpg')), 'output written next to the original');
    assert.ok(fs.statSync(path.join(work, 'holiday photo-compressed.jpg')).size <= kb * 1024);

    // now ask for something far smaller: the app must stop and ask first
    await page.fill('#size', '40');
    await page.click('#go');
    await page.waitForFunction(() => document.getElementById('go').textContent === 'Stop');
    await page.waitForFunction(() => document.getElementById('go').textContent !== 'Stop', null, { timeout: 120000 });
    await shot('04-needs-decision');
    assert.match(await page.locator('.callout.warn').first().innerText(), /isn't possible without losing quality/);
    assert.ok(!fs.existsSync(path.join(work, 'holiday photo-compressed (2).jpg')), 'nothing silently degraded');

    await page.locator('.callout.warn .btn.primary').first().click();
    await page.waitForFunction(() => document.getElementById('go').textContent !== 'Stop' && /Quality reduced|Target not reached/.test(document.body.innerText), null, { timeout: 120000 });
    await shot('05-compromised');
    const out2 = path.join(work, 'holiday photo-compressed (2).jpg');
    assert.ok(fs.existsSync(out2), 'compromise output saved');
    assert.ok(fs.statSync(out2).size <= 40 * 1024);
    const meta = await sharp(out2).metadata();
    assert.equal(meta.format, 'jpeg');

    // compare dialog opens for images
    await page.locator('.row', { hasText: 'holiday photo.jpg' }).getByText('Compare').first().click();
    await page.waitForSelector('dialog[open]');
    await shot('06-compare');
    await page.click('#compare-close');

    console.log('E2E OK');
  } catch (e) {
    await shot('failure');
    console.error('Page text at failure:\n' + (await page.locator('body').innerText().catch(() => '?')));
    throw e;
  } finally {
    await app.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error('E2E FAILED:', e);
  process.exit(1);
});
