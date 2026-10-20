'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// More libuv threads let several mozjpeg encodes run side by side (set before any async work).
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || String(Math.min(8, Math.max(4, os.cpus().length)));

const selfTestArg = process.argv.find((a) => a.startsWith('--self-test='));

if (selfTestArg) {
  app.whenReady().then(async () => {
    const ok = await require('./selftest').runSelfTest(selfTestArg.slice('--self-test='.length));
    app.exit(ok ? 0 : 1);
  });
} else {
  startApp();
}

function startApp() {
  const { compressFile, SUPPORTED_EXTS, UserError, AbortError } = require('../engine');
  const { collectFiles, copyToOutput } = require('./files');

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  let win = null;
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'FileCompressor-'));
  /** jobId -> { abort: AbortController, tempPath: string|null } */
  const jobs = new Map();

  function createWindow() {
    win = new BrowserWindow({
      width: 980,
      height: 720,
      minWidth: 820,
      minHeight: 620,
      show: false,
      title: 'File Compressor',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#14161a' : '#f5f6f8',
      icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    win.once('ready-to-show', () => win.show());
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    // Never let the app window navigate away or open new windows (dropped files, stray links).
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.on('closed', () => {
      win = null;
    });
  }

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    for (const j of jobs.values()) j.abort.abort();
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  /* ---------------------------------------------------------------- IPC */

  ipcMain.handle('files:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose images or PDFs',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images and PDFs', extensions: SUPPORTED_EXTS.map((e) => e.slice(1)) },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return r.canceled ? [] : collectFiles(r.filePaths);
  });

  ipcMain.handle('files:inspect', (_e, paths) => collectFiles(Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : []));

  ipcMain.handle('folder:choose', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Save compressed files to…', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('job:start', async (event, req) => {
    const { id, path: file, targetBytes, mode, keepMetadata } = req || {};
    if (typeof id !== 'string' || typeof file !== 'string') return { ok: false, message: 'Invalid request.' };
    const abort = new AbortController();
    const entry = { abort, tempPath: null };
    jobs.set(id, entry);
    try {
      const result = await compressFile(file, {
        targetBytes: Number(targetBytes),
        mode: mode === 'compromise' ? 'compromise' : 'preserve',
        keepMetadata: !!keepMetadata,
        tempDir: sessionDir,
        signal: abort.signal,
        onProgress: (p) => {
          if (!event.sender.isDestroyed()) event.sender.send('job:progress', { id, ...p });
        },
      });
      entry.tempPath = result.tempPath || null;
      return { ok: true, result };
    } catch (err) {
      jobs.delete(id);
      if (err instanceof AbortError) return { ok: false, aborted: true, message: 'Cancelled' };
      if (err instanceof UserError) return { ok: false, code: err.code, message: err.message };
      console.error('compress failed', file, err);
      return { ok: false, code: 'UNEXPECTED', message: 'Something went wrong while compressing this file.', detail: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('job:cancel', (_e, id) => {
    const j = jobs.get(id);
    if (j) j.abort.abort();
  });

  ipcMain.handle('job:save', async (_e, { id, srcPath, outDir }) => {
    const j = jobs.get(id);
    if (!j || !j.tempPath) return { ok: false, message: 'Nothing to save.' };
    try {
      const outPath = await copyToOutput(j.tempPath, srcPath, outDir || null);
      const size = (await fs.promises.stat(outPath)).size;
      return { ok: true, outPath, size };
    } catch (err) {
      const denied = err && (err.code === 'EACCES' || err.code === 'EPERM');
      return { ok: false, message: denied ? "Couldn't save there (permission denied). Choose another folder." : `Couldn't save the file: ${err.message}` };
    }
  });

  ipcMain.handle('job:discard', async (_e, id) => {
    const j = jobs.get(id);
    jobs.delete(id);
    if (j && j.tempPath) fs.promises.rm(j.tempPath, { force: true }).catch(() => {});
  });

  ipcMain.handle('shell:reveal', (_e, p) => {
    if (typeof p === 'string') shell.showItemInFolder(p);
  });

  ipcMain.handle('thumb:get', async (_e, p) => {
    try {
      const sharp = require('sharp');
      const buf = await sharp(p, { failOn: 'none' }).rotate().resize(96, 96, { fit: 'cover' }).jpeg({ quality: 70 }).toBuffer();
      return `data:image/jpeg;base64,${buf.toString('base64')}`;
    } catch {
      return null;
    }
  });

  ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }));
}
