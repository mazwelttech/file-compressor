# File Compressor

A Windows desktop app that shrinks **images (JPG, PNG, WebP)** and **PDFs** to a size you choose.

It always tries to hit your target **without losing quality first**. If that isn't possible, it stops and
tells you what the best quality-preserving result is, then lets you press **Reduce quality** to go further.
Nothing is ever degraded behind your back, and your originals are never overwritten.

## Install

1. Open the [**Releases** page](../../releases) and download `FileCompressor-Setup-<version>.exe`.
   (Every build is also attached to its run under the **Actions** tab as `FileCompressor-Windows-Installer`.)
2. Run it and follow the installer. It adds a Start menu entry and a desktop shortcut.
3. The installer isn't code-signed, so Windows SmartScreen may say **"Windows protected your PC"**.
   Click **More info → Run anyway**.

## Using it

1. Set **Make each file smaller than** (e.g. `500 KB`, or use a quick-pick chip).
2. Drop images / PDFs (or whole folders) onto the window, or press **Choose files…**.
3. Press **Compress**. For every file you get one of:
   - **✓ Quality preserved**: target reached with no visible change.
   - **Needs your call**: the target can't be met without a visible loss. You see the smallest size that still
     looks identical and can either **save that** or **Reduce quality to reach the target**.
   - **Quality reduced**: you chose to compromise; the row says exactly what changed
     (e.g. "JPEG quality 62 · resized to 71%"). **Compare** shows a before/after slider for images.
   - **Already small**: the file is already under the target, so nothing is written.
4. Results are saved as `<name>-compressed.<ext>` next to the original (or in a folder you pick). Existing files are
   never overwritten.

## What "without losing quality" means here

| File | Quality-preserving steps (tried first) | Only after you press *Reduce quality* |
| --- | --- | --- |
| **JPG / WebP (lossy)** | Re-encoding with a better encoder (mozjpeg) at quality ≥ 85, or any quality whose result stays within 42 dB PSNR of the original (this is how already-compressed files are recognised). | Lower quality (down to 60), then smaller dimensions (never below 160 px on the long edge), and quality 35 only as a last resort. |
| **PNG / lossless WebP** | Optimal lossless re-packing, and an exact colour palette when the image has ≤ 256 colours. Pixel-identical, verified. Transparency kept. | 256-colour palette, then smaller dimensions. |
| **PDF** | Text, fonts and vector art are never touched. Streams are re-compressed losslessly (ASCII85 wrappers removed, better Flate). Photos stay at ≥ 300 DPI and JPEG quality ≥ 85. PNG-style photos may become JPEG at quality ≥ 85; screenshots and line art stay lossless. Unused objects and thumbnails are dropped. | Images go down to ~60 DPI and JPEG quality 40 as needed, using only as much as the target requires. |

Notes and limits:

- If a target is below what's possible (for example a text-only PDF, where fonts dominate), the app says so and saves
  the smallest version it could make instead of pretending.
- Password-protected PDFs and animated images are not supported. A **digitally signed** PDF loses its signature
  when rewritten (any change invalidates it).
- Photo details (camera info, GPS) are removed by default to save space; tick **Keep photo details** to keep them.
  Orientation is always applied to the pixels, so photos never end up sideways, and colour profiles are kept.
- Files are processed locally. Nothing is uploaded anywhere.

## Development

```bash
npm install
npm start          # run the app
npm test           # engine tests (images, PDFs, search logic); no display needed
npm run e2e        # drive the real Electron app with Playwright (needs a display, e.g. xvfb-run)
npm run icons      # regenerate build/icon.* and the in-app logo from the SVG in scripts/make-icons.js
npm run dist       # build the Windows installer (run on Windows) into dist/
```

Layout:

- `src/engine/`: the compression engine (no Electron). `image.js` handles JPG/PNG/WebP with `sharp`;
  `pdf/` rewrites PDFs with `@cantoo/pdf-lib` (stream filters, image placement/DPI detection, image recompression).
- `src/main/`: Electron main process, preload bridge, and `--self-test` mode used by CI.
- `src/renderer/`: the UI (plain HTML/CSS/JS, strict CSP, sandboxed).

## Building the installer on GitHub

`.github/workflows/build-windows.yml` runs on every push:

1. installs dependencies and runs the test suite on a Windows runner,
2. builds the NSIS installer with electron-builder,
3. self-tests the unpacked app, then **silently installs the real installer and self-tests the installed app**,
4. uploads the installer as a build artifact.

To publish a downloadable Release, either push a tag (`git tag v1.0.0 && git push origin v1.0.0`) or run the workflow
manually from the **Actions** tab with **Publish a GitHub Release** ticked. The Release is named after the version in
`package.json`.

## License

MIT
