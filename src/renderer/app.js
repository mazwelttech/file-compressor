'use strict';

(() => {
  const api = window.api;
  const $ = (id) => document.getElementById(id);

  const UNIT_BYTES = { KB: 1024, MB: 1024 * 1024 };
  const PRESETS = [
    { v: 100, u: 'KB' },
    { v: 250, u: 'KB' },
    { v: 500, u: 'KB' },
    { v: 1, u: 'MB' },
    { v: 2, u: 'MB' },
    { v: 5, u: 'MB' },
  ];

  const state = {
    files: [],
    nextId: 1,
    unit: 'KB',
    outputMode: 'beside',
    outputDir: null,
    keepMetadata: false,
    busy: false,
    stopRequested: false,
    currentJob: null,
  };

  /* ------------------------------------------------------------------ helpers */

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function fmt(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    const digits = i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
    return `${v.toFixed(digits).replace(/\.?0+$/, (m) => (m.startsWith('.') ? '' : m))} ${units[i]}`;
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const pct = (before, after) => `−${Math.max(0, Math.round((1 - after / before) * 100))}%`;
  const sentence = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function save() {
    try {
      localStorage.setItem(
        'fc.settings',
        JSON.stringify({
          value: $('size').value,
          unit: state.unit,
          outputMode: state.outputMode,
          outputDir: state.outputDir,
          keepMetadata: state.keepMetadata,
        }),
      );
    } catch {
      /* storage can be unavailable; settings just won't persist */
    }
  }

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem('fc.settings') || 'null');
      if (!s) return;
      if (s.value) $('size').value = s.value;
      if (UNIT_BYTES[s.unit]) state.unit = s.unit;
      if (s.outputMode === 'folder' || s.outputMode === 'beside') state.outputMode = s.outputMode;
      if (typeof s.outputDir === 'string') state.outputDir = s.outputDir;
      state.keepMetadata = !!s.keepMetadata;
    } catch {
      /* ignore corrupt settings */
    }
  }

  /* ------------------------------------------------------------------ settings UI */

  function targetBytes() {
    const v = Number($('size').value);
    if (!Number.isFinite(v) || v <= 0) return null;
    const bytes = Math.round(v * UNIT_BYTES[state.unit]);
    return bytes >= 1024 && bytes <= 50 * 1024 * 1024 * 1024 ? bytes : null;
  }

  function renderSettings() {
    for (const b of $('unit').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.unit === state.unit));
    for (const b of $('save-mode').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === state.outputMode));
    const fb = $('folder-btn');
    fb.hidden = state.outputMode !== 'folder';
    fb.textContent = state.outputDir || 'Choose folder…';
    fb.title = state.outputDir || '';
    $('keep-meta').checked = state.keepMetadata;

    const bytes = targetBytes();
    const err = $('size-error');
    const invalid = $('size').value !== '' && bytes == null;
    $('size').setAttribute('aria-invalid', String(invalid));
    err.hidden = !invalid;
    err.textContent = invalid ? 'Enter a size of at least 1 KB.' : '';

    const chips = $('chips');
    if (!chips.children.length) {
      for (const p of PRESETS) {
        chips.append(
          h('button', {
            type: 'button',
            class: 'chip',
            text: `${p.v} ${p.u}`,
            'data-v': p.v,
            'data-u': p.u,
            onclick: () => {
              $('size').value = p.v;
              state.unit = p.u;
              onTargetChanged();
            },
          }),
        );
      }
    }
    for (const c of chips.children) {
      c.classList.toggle('active', bytes != null && Number(c.dataset.v) * UNIT_BYTES[c.dataset.u] === bytes);
    }
  }

  function onTargetChanged() {
    renderSettings();
    renderFooter();
    save();
  }

  /* ------------------------------------------------------------------ files */

  async function addFiles(infos) {
    let added = 0;
    for (const info of infos) {
      if (state.files.some((f) => f.path.toLowerCase() === info.path.toLowerCase())) continue;
      const f = { ...info, id: state.nextId++, status: 'queued', attempt: 0, thumb: null };
      state.files.push(f);
      added++;
      if (f.kind === 'image') {
        api.thumbnail(f.path).then((url) => {
          if (url && state.files.includes(f)) {
            f.thumb = url;
            renderRow(f);
          }
        });
      }
    }
    if (added) renderList();
    return added;
  }

  async function removeFile(f) {
    if (f.status === 'working') return;
    if (f.jobId) api.discard(f.jobId);
    state.files = state.files.filter((x) => x !== f);
    renderList();
  }

  function clearAll() {
    if (state.busy) return;
    for (const f of state.files) if (f.jobId) api.discard(f.jobId);
    state.files = [];
    renderList();
  }

  /* ------------------------------------------------------------------ rendering */

  function renderList() {
    const list = $('list');
    const has = state.files.length > 0;
    $('empty').hidden = has;
    list.hidden = !has;
    $('stage').classList.toggle('has-files', has);
    list.replaceChildren(...state.files.map(buildRow));
    renderFooter();
  }

  function renderRow(f) {
    const old = f.el;
    if (!old || !old.isConnected) return;
    old.replaceWith(buildRow(f)); // buildRow points f.el at the new element
    renderFooter();
  }

  function statusPill(f) {
    switch (f.status) {
      case 'queued':
        return h('span', { class: 'pill', text: 'Ready' });
      case 'working':
        return h('span', { class: 'pill info', text: f.mode === 'compromise' ? 'Reducing quality…' : 'Working…' });
      case 'decision':
        return h('span', { class: 'pill warn', text: 'Needs your call' });
      case 'skipped':
        return h('span', { class: 'pill', text: 'Already small' });
      case 'error':
        return h('span', { class: 'pill err', text: 'Failed' });
      case 'done':
        if (!f.reachedTarget) return h('span', { class: 'pill warn', text: 'Target not reached' });
        return f.preserved
          ? h('span', { class: 'pill ok', text: '✓ Quality preserved' })
          : h('span', { class: 'pill warn', text: 'Quality reduced' });
      default:
        return null;
    }
  }

  function buildRow(f) {
    const target = f.targetUsed;
    const thumb = h('div', {
      class: `thumb ${f.kind === 'pdf' ? 'pdf' : 'img'}`,
      text: f.thumb ? '' : f.kind === 'pdf' ? 'PDF' : 'IMG',
    });
    if (f.thumb) thumb.style.backgroundImage = `url("${f.thumb}")`;

    const meta = h('div', { class: 'meta' });
    if (f.status === 'done' && f.savedSize != null) {
      meta.append(h('strong', { text: fmt(f.size) }), h('span', { class: 'arrow', text: '→' }), h('strong', { text: fmt(f.savedSize) }));
      meta.append(h('span', { class: 'saving', text: pct(f.size, f.savedSize) }));
    } else {
      meta.append(h('span', { text: fmt(f.size) }), h('span', { text: f.kind === 'pdf' ? 'PDF' : f.name.split('.').pop().toUpperCase() }));
    }
    const pill = statusPill(f);
    if (pill) meta.append(pill);

    const actions = h('div', { class: 'row-actions' });
    if (f.status === 'working') {
      actions.append(h('button', { type: 'button', class: 'btn small', text: 'Cancel', onclick: () => api.cancel(f.jobId) }));
    } else {
      actions.append(h('button', { type: 'button', class: 'icon-btn', title: 'Remove', 'aria-label': `Remove ${f.name}`, text: '×', onclick: () => removeFile(f) }));
    }

    const row = h('li', { class: 'row' }, thumb, h('div', { class: 'name', title: f.path, text: f.name }), actions, meta);
    const detail = buildDetail(f, target);
    if (detail) row.append(detail);
    f.el = row;
    return row;
  }

  function buildDetail(f, target) {
    if (f.status === 'working') {
      const p = f.progress || {};
      const bar = h('div', { class: `progress${p.fraction == null ? ' indeterminate' : ''}`, role: 'progressbar', 'aria-label': 'Progress' }, h('span'));
      if (p.fraction != null) bar.firstChild.style.width = `${Math.round(p.fraction * 100)}%`;
      return h('div', { class: 'detail' }, bar, h('div', { class: 'progress-label', text: p.label || 'Starting…' }));
    }

    if (f.status === 'error') {
      return h('div', { class: 'detail' }, h('div', { class: 'callout err', text: f.error || 'Something went wrong.' }));
    }

    if (f.status === 'skipped') {
      return h('div', { class: 'detail' }, h('div', { class: 'callout info', text: `Already under ${fmt(target)}, so there's nothing to do for this file.` }));
    }

    if (f.status === 'decision') {
      const best = f.result && f.result.tempPath ? f.result.size : null;
      const msg = h('div', { class: 'callout warn' });
      msg.append(h('b', { text: `${fmt(target)} isn't possible without losing quality. ` }));
      msg.append(
        best != null
          ? `The smallest version that still looks identical is ${fmt(best)}.`
          : `This file is already as small as it can get while looking identical.`,
      );
      const btns = h('div', { class: 'btns' });
      if (best != null) {
        btns.append(h('button', { type: 'button', class: 'btn small', text: `Save the ${fmt(best)} version`, onclick: () => saveBest(f) }));
      }
      btns.append(h('button', { type: 'button', class: 'btn small primary', text: `Reduce quality to reach ${fmt(target)}`, onclick: () => compromiseOne(f) }));
      msg.append(btns);
      return h('div', { class: 'detail' }, msg);
    }

    if (f.status === 'done') {
      const wrap = h('div', { class: 'detail' });
      if (!f.reachedTarget) {
        wrap.append(
          h('div', {
            class: 'callout warn',
            text: `Couldn't reach ${fmt(target)}: this is the smallest we could make it (${fmt(f.savedSize)}). The rest is mostly text, fonts or tiny images that can't shrink further.`,
          }),
        );
      }
      const notes = (f.result && f.result.notes ? f.result.notes : []).filter(Boolean);
      if (notes.length) wrap.append(h('div', { class: 'notes', text: sentence(notes.join(' · ')) }));
      const acts = h('div', { class: 'detail-actions' });
      acts.append(h('button', { type: 'button', class: 'btn ghost', text: 'Show in folder', onclick: () => api.reveal(f.savedPath) }));
      if (f.kind === 'image') acts.append(h('button', { type: 'button', class: 'btn ghost', text: 'Compare', onclick: () => openCompare(f) }));
      wrap.append(acts);
      return wrap;
    }
    return null;
  }

  function renderFooter() {
    const n = state.files.length;
    $('clear').disabled = state.busy || n === 0;

    const eligible = eligibleFiles();
    const go = $('go');
    go.classList.toggle('stop', state.busy);
    go.classList.toggle('primary', !state.busy);
    if (state.busy) {
      go.textContent = 'Stop';
      go.disabled = false;
    } else {
      go.textContent = eligible.length ? `Compress ${plural(eligible.length, 'file')}` : 'Compress';
      go.disabled = eligible.length === 0 || targetBytes() == null;
    }

    const pending = state.files.filter((f) => f.status === 'decision');
    const ca = $('compromise-all');
    ca.hidden = state.busy || pending.length === 0;
    ca.textContent = `Reduce quality for ${plural(pending.length, 'file')}`;

    const done = state.files.filter((f) => f.status === 'done' && f.savedSize != null);
    const sum = $('summary');
    sum.replaceChildren();
    if (done.length) {
      const before = done.reduce((a, f) => a + f.size, 0);
      const after = done.reduce((a, f) => a + f.savedSize, 0);
      sum.append(`${plural(done.length, 'file')} compressed: `, h('b', { text: `${fmt(before)} → ${fmt(after)}` }), ` (${pct(before, after)})`);
    } else if (n) {
      sum.append(plural(n, 'file'));
    }
  }

  function eligibleFiles() {
    const target = targetBytes();
    return state.files.filter((f) => f.status === 'queued' || f.status === 'error' || (f.status !== 'working' && f.targetUsed !== target));
  }

  /* ------------------------------------------------------------------ running jobs */

  function outDir() {
    return state.outputMode === 'folder' ? state.outputDir : null;
  }

  async function ensureOutputFolder() {
    if (state.outputMode !== 'folder' || state.outputDir) return true;
    const dir = await api.chooseFolder();
    if (!dir) return false;
    state.outputDir = dir;
    renderSettings();
    save();
    return true;
  }

  async function saveResult(f, size) {
    const r = await api.save({ id: f.jobId, srcPath: f.path, outDir: outDir() });
    if (!r.ok) {
      f.status = 'error';
      f.error = r.message;
      return false;
    }
    f.savedPath = r.outPath;
    f.savedSize = r.size != null ? r.size : size;
    return true;
  }

  async function runJob(f, mode) {
    const target = targetBytes();
    if (target == null) return;
    if (f.jobId) api.discard(f.jobId);
    f.jobId = `f${f.id}-${++f.attempt}`;
    f.mode = mode;
    f.status = 'working';
    f.progress = { label: 'Starting…', fraction: null };
    f.error = null;
    f.savedPath = null;
    f.savedSize = null;
    f.result = null;
    f.targetUsed = target;
    renderRow(f);
    state.currentJob = f.jobId;

    const res = await api.compress({ id: f.jobId, path: f.path, targetBytes: target, mode, keepMetadata: state.keepMetadata });
    state.currentJob = null;

    if (!res.ok) {
      f.jobId = null;
      if (res.aborted) {
        f.status = 'queued';
        f.targetUsed = null;
      } else {
        f.status = 'error';
        f.error = res.message + (res.detail ? ` (${res.detail})` : '');
      }
      renderRow(f);
      return;
    }

    const r = res.result;
    f.result = r;
    f.reachedTarget = r.status !== 'cannot-reach';
    f.preserved = !!r.preserved;
    switch (r.status) {
      case 'already-small':
        f.status = 'skipped';
        break;
      case 'needs-compromise':
        f.status = 'decision';
        break;
      case 'done':
      case 'cannot-reach':
        if (!r.tempPath) {
          f.status = 'error';
          f.error = "This file can't be made any smaller.";
        } else if (await saveResult(f, r.size)) {
          f.status = 'done';
        }
        break;
      default:
        f.status = 'error';
        f.error = 'Unexpected result.';
    }
    renderRow(f);
  }

  async function runQueue(files, mode) {
    if (state.busy || !files.length) return;
    if (!(await ensureOutputFolder())) return;
    state.busy = true;
    state.stopRequested = false;
    renderFooter();
    for (const f of files) {
      if (state.stopRequested) break;
      if (!state.files.includes(f)) continue;
      await runJob(f, mode);
    }
    state.busy = false;
    renderFooter();
  }

  function compromiseOne(f) {
    return runQueue([f], 'compromise');
  }

  function compromiseAll() {
    return runQueue(state.files.filter((f) => f.status === 'decision'), 'compromise');
  }

  async function saveBest(f) {
    if (!(await ensureOutputFolder())) return;
    if (await saveResult(f, f.result.size)) {
      f.status = 'done';
      f.reachedTarget = false;
      f.preserved = true;
    }
    renderRow(f);
  }

  /* ------------------------------------------------------------------ compare dialog */

  function openCompare(f) {
    const dlg = $('compare');
    $('cmp-before').src = api.fileUrl(f.path);
    $('cmp-after').src = api.fileUrl(f.savedPath);
    $('cmp-tag-before').textContent = `Original · ${fmt(f.size)}`;
    $('cmp-tag-after').textContent = `Compressed · ${fmt(f.savedSize)}`;
    $('cmp-range').value = 50;
    setSlider(50);
    dlg.showModal();
  }

  function setSlider(v) {
    $('cmp-before').style.clipPath = `inset(0 ${100 - v}% 0 0)`;
    $('cmp-handle').style.left = `${v}%`;
  }

  /* ------------------------------------------------------------------ wiring */

  async function pick() {
    addFiles(await api.pickFiles());
  }

  function wire() {
    $('size').addEventListener('input', onTargetChanged);
    $('size').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !$('go').disabled) $('go').click();
    });
    $('unit').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      state.unit = b.dataset.unit;
      onTargetChanged();
    });
    $('save-mode').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      state.outputMode = b.dataset.mode;
      renderSettings();
      save();
      if (state.outputMode === 'folder' && !state.outputDir) $('folder-btn').click();
    });
    $('folder-btn').addEventListener('click', async () => {
      const dir = await api.chooseFolder();
      if (dir) {
        state.outputDir = dir;
      } else if (!state.outputDir) {
        state.outputMode = 'beside';
      }
      renderSettings();
      save();
    });
    $('keep-meta').addEventListener('change', (e) => {
      state.keepMetadata = e.target.checked;
      for (const f of state.files) if (f.status === 'done' || f.status === 'decision' || f.status === 'skipped') f.targetUsed = null; // redo with the new setting
      renderFooter();
      save();
    });

    $('pick-empty').addEventListener('click', pick);
    $('add').addEventListener('click', pick);
    $('clear').addEventListener('click', clearAll);
    $('go').addEventListener('click', () => {
      if (state.busy) {
        state.stopRequested = true;
        if (state.currentJob) api.cancel(state.currentJob);
        return;
      }
      runQueue(eligibleFiles(), 'preserve');
    });
    $('compromise-all').addEventListener('click', compromiseAll);

    // drag & drop
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      $('overlay').hidden = false;
    });
    window.addEventListener('dragover', (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) $('overlay').hidden = true;
    });
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      $('overlay').hidden = true;
      if (!hasFiles(e)) return;
      const paths = api.pathsForFiles(e.dataTransfer.files);
      if (paths.length) addFiles(await api.inspectPaths(paths));
    });

    // compare dialog
    $('cmp-range').addEventListener('input', (e) => setSlider(Number(e.target.value)));
    $('compare-close').addEventListener('click', () => $('compare').close());
    $('compare').addEventListener('click', (e) => {
      if (e.target === $('compare')) $('compare').close();
    });

    api.onProgress((p) => {
      const f = state.files.find((x) => x.jobId === p.id);
      if (!f || f.status !== 'working') return;
      f.progress = { label: p.label, fraction: p.fraction == null ? f.progress && f.progress.fraction : p.fraction };
      const bar = f.el && f.el.querySelector('.progress');
      if (!bar) return;
      if (f.progress.fraction != null) {
        bar.classList.remove('indeterminate');
        bar.firstChild.style.width = `${Math.round(f.progress.fraction * 100)}%`;
      }
      const label = f.el.querySelector('.progress-label');
      if (label && p.label) label.textContent = p.label;
    });
  }

  load();
  wire();
  renderSettings();
  renderList();
  api.appInfo().then((i) => {
    $('version').textContent = `v${i.version}`;
  });
})();
