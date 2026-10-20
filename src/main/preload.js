'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// The sandboxed preload only gets a stripped-down `url` module, so build file:// URLs by hand.
function fileUrl(p) {
  const slashed = String(p).replace(/\\/g, '/');
  const encoded = encodeURI(slashed).replace(/[?#]/g, encodeURIComponent);
  if (slashed.startsWith('//')) return `file:${encoded}`; // UNC share: \\server\share\file
  return `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`;
}

contextBridge.exposeInMainWorld('api', {
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  inspectPaths: (paths) => ipcRenderer.invoke('files:inspect', paths),
  /** Real file-system paths for files dropped onto the window. */
  pathsForFiles: (files) => Array.from(files || []).map((f) => webUtils.getPathForFile(f)).filter(Boolean),
  chooseFolder: () => ipcRenderer.invoke('folder:choose'),
  compress: (req) => ipcRenderer.invoke('job:start', req),
  cancel: (id) => ipcRenderer.invoke('job:cancel', id),
  save: (req) => ipcRenderer.invoke('job:save', req),
  discard: (id) => ipcRenderer.invoke('job:discard', id),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  thumbnail: (p) => ipcRenderer.invoke('thumb:get', p),
  fileUrl,
  appInfo: () => ipcRenderer.invoke('app:info'),
  onProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('job:progress', handler);
    return () => ipcRenderer.removeListener('job:progress', handler);
  },
});
