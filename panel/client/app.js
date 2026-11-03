// Select panel: DOM, table, scan flow and the explicit project writes. Logic lives in core.js.
(function () {
  'use strict';
  var C = window.SelectCore, N = window.SelectNative;
  var ROW_H = 40, OVERSCAN = 6, FLUSH_MS = 66, RESORT_EVERY_MS = 200, IMPORT_BIN = 'SELECT IMPORTS';
  var ISSUES_URL = 'https://github.com/skyfallstatus/select/issues/new';
  var THEME_EVENT = 'com.adobe.csxs.events.ThemeColorChanged';
  var SOURCE_NAMES = { selection: 'Selection', project: 'Project', folder: 'Folder' };

  var $ = function (id) { return document.getElementById(id); };
  var plural = C.plural, fmtInt = C.fmtInt;
  var S = {
    store: C.createStore(),
    view: { sort: [], preset: null },
    history: [],
    order: [],
    hasGroups: false,
    groupCount: 0,
    selected: new Set(),
    anchor: null,
    source: 'selection',
    project: null,
    connected: false,
    listing: false,
    busy: null,          // what a write in progress is doing, for the foot
    scan: null,          // {handle, startedAt, endedAt, stopping, state, source, failure}
    lastWrite: null,     // {title, restore, project}
    outcome: null,       // the last write's result, in the foot until the view moves on
    sortMs: null,
    sortRows: 0,
    columns: [],
    shownColumns: {},    // key -> true or false, the switches in the Columns sheet
    labelColor: C.DEFAULT_LABEL,
    pool: [],
    lastComputed: 0,
    beforePreset: null,
    modalOpen: false
  };

  // ---------------------------------------------------------------- host

  function extensionRoot() {
    var p = decodeURIComponent(location.pathname);
    return p.slice(0, p.lastIndexOf('/client/'));
  }

  function rawEval(script) {
    return new Promise(function (resolve) {
      if (!window.__adobe_cep__) { resolve(null); return; }
      window.__adobe_cep__.evalScript(script, resolve);
    });
  }

  function host(fn, args) {
    if (!window.__adobe_cep__) {
      return Promise.resolve({ ok: false, code: 'no-host', message: 'Premiere is not connected.' });
    }
    return rawEval(C.hostCall(fn, args)).then(function (text) {
      try {
        return JSON.parse(text);
      } catch (e) {
        return { ok: false, code: 'host-error', message: 'Premiere answered: ' + String(text).slice(0, 200) };
      }
    });
  }

  // ScriptPath loads the host with the panel. Load it by hand if it did not.
  function ensureHost() {
    return rawEval('typeof slCall').then(function (t) {
      if (t === 'function' || t === null) { return; }
      return rawEval('$.evalFile(' + JSON.stringify(extensionRoot() + '/host/select.jsx') + ')');
    });
  }

  function refreshProject() {
    return host('status').then(function (r) {
      S.project = r.ok ? r.project : null;
      S.connected = r.code !== 'no-host';
      renderHeader();
      renderFoot();
      return r;
    });
  }

  // ---------------------------------------------------------------- header

  function projectTitle(project) {
    return project.name.replace(/\.prproj$/i, '');
  }

  function renderHeader() {
    var name = S.project ? projectTitle(S.project) : (S.connected ? 'No project open' : 'Not connected to Premiere');
    var rows = S.store.rows.length, source = SOURCE_NAMES[S.scan ? S.scan.source : S.source];
    $('project-name').textContent = name;
    $('project-name').title = name;
    $('subtitle').textContent = rows ? plural(rows, 'clip') + ' · ' + source : source;
  }

  // ---------------------------------------------------------------- notes and the foot

  function note(text, kind) {
    var el = $('status-note');
    el.textContent = text || '';
    el.className = kind || '';
    el.title = text || '';
    el.hidden = !text;
  }

  function scanSeconds() {
    var sc = S.scan;
    return sc ? ((sc.endedAt || performance.now()) - sc.startedAt) / 1000 : 0;
  }

  function footFacts() {
    var sc = S.scan;
    return {
      source: S.source,
      rescan: !!(sc && sc.state !== 'Scanning' && (sc.source !== S.source || (S.source === 'folder' && sc.folder !== $('folder').value.trim()))),
      project: S.project,
      connected: S.connected,
      listing: S.listing,
      busy: S.busy,
      outcome: S.outcome,
      scan: sc ? { state: sc.state, failure: sc.failure, seconds: scanSeconds(), stopping: sc.stopping } : null,
      store: S.store,
      rows: S.store.rows.length,
      shown: S.order.length,
      selected: S.selected.size,
      view: S.view,
      groupCount: S.groupCount
    };
  }

  var ACTIONS = { scan: 'scan', stop: 'stop', label: 'do-label', columns: 'do-columns', bins: 'do-bins', undo: 'undo-write', details: 'foot-details' };

  // A new sentence fades in. A running count changes in place, and reduced motion means no fade at all.
  function setFootWords(id, text, kind) {
    var el = $(id);
    if (el.textContent === text) { return; }
    el.textContent = text;
    if (kind !== 'scanning' && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 50, easing: 'ease-out', fill: 'backwards' });
    }
  }

  // Everything the foot shows comes from core.footState, so this only puts it on the page.
  function renderFoot() {
    var f = C.footState(footFacts()), foot = $('foot');
    foot.className = f.kind + (f.green ? ' green' : '');
    $('foot-mark').dataset.kind = f.mark;
    setFootWords('foot-verdict', f.verdict, f.kind);
    setFootWords('foot-sentence', f.sentence, f.kind);
    var meter = typeof f.meter === 'number';
    $('foot-meter').hidden = !meter;
    if (meter) {
      $('foot-meter-fill').style.width = (f.meter * 100).toFixed(1) + '%';
      $('foot-meter').setAttribute('aria-valuenow', Math.round(f.meter * 100));
    }
    Object.keys(ACTIONS).forEach(function (a) {
      var b = $(ACTIONS[a]), on = f.actions.indexOf(a) >= 0;
      b.hidden = !on;
      b.className = 'action' + (f.primary === a ? ' primary' : '') + (f.green ? ' on-safe' : '');
    });
    $('do-bins').disabled = !!f.binsOff || !S.order.length;
    $('do-bins').title = f.binsOff ? 'Pick a sort first. Bins are built from it.' : 'Move project items into new numbered bins by the active sort. Files on disk stay where they are';
    $('do-label').disabled = $('do-columns').disabled = !S.order.length;
    $('undo-write').title = S.lastWrite ? 'Puts back: ' + S.lastWrite.title : '';
    var tail = S.scan && f.kind !== 'scanning' && !f.green ? statusLine() : '';
    $('status-unread').textContent = tail;
    $('status-unread').hidden = !tail;
    renderHeader();
  }

  // Clips that could not be read, and why, in one plain sentence.
  function statusLine() {
    var line = C.unreadableSummary(S.store.rows), bad = S.store.bad;
    if (bad) { line += (line ? ' ' : '') + plural(bad, 'engine line') + ' could not be understood.'; }
    return line;
  }

  function renderView() {
    var v = S.view, buttons = document.querySelectorAll('#presets button');
    $('clear-view').classList.toggle('off', !v.sort.length && !v.preset);     // keeps its place, so the row never reflows
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].dataset.id === v.preset;
      buttons[i].classList.toggle('on', on);
      buttons[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  // A row or view change moves on from the last write's result. Undo stays in the menu.
  function moveOn() {
    if (S.outcome) { S.outcome = null; }
  }

  // ---------------------------------------------------------------- table

  function columnOn(c) {
    var saved = S.shownColumns[c.key];
    return c.fixed || (saved === undefined ? !c.hidden : saved);
  }

  // A switched-off column still shows while the view sorts by it, so a sort never hides its own reason.
  function visibleColumns() {
    var sorting = {};
    S.view.sort.forEach(function (s) { sorting[s.key] = true; });
    return C.COLUMNS.filter(function (c) {
      return c.onlyWithGroups ? S.hasGroups : columnOn(c) || sorting[c.key];
    });
  }

  function totalWidth() {
    return S.columns.reduce(function (a, c) { return a + c.width; }, 0) + 16;
  }

  function placeCell(el, col, last) {
    el.style.width = col.width + (last ? 16 : 0) + 'px';
    if (col.grow) { el.classList.add('grow'); }
  }

  function buildHead() {
    var head = $('head');
    head.textContent = '';
    head.style.minWidth = totalWidth() + 'px';
    S.columns.forEach(function (c, i) {
      var h = document.createElement('div');
      h.className = 'h' + (c.kind === 'number' ? ' num' : '') + (c.sortable === false ? '' : ' sortable');
      placeCell(h, c, i === S.columns.length - 1);
      h.dataset.key = c.key;
      if (c.tip) { h.title = c.tip; }
      head.appendChild(h);
    });
    renderHead();
  }

  function renderHead() {
    var cells = $('head').children, sort = S.view.sort;
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i], c = C.COLUMN[cell.dataset.key], at = -1;
      for (var j = 0; j < sort.length; j++) { if (sort[j].key === c.key) { at = j; } }
      cell.textContent = c.label;
      cell.classList.toggle('sorted', at >= 0);
      if (at >= 0) {
        var m = document.createElement('span');
        m.className = 'mark ' + (sort[at].dir > 0 ? 'asc' : 'desc');
        if (sort.length > 1) { m.textContent = String(at + 1); }
        if (c.kind === 'number') { cell.insertBefore(m, cell.firstChild); } else { cell.appendChild(m); }    // a number's title stays over its figures
      }
    }
  }

  // Marks the column the view sorts by. Runs on the row pool, so its cost does not grow with the clips.
  function renderSortColumn() {
    var key = S.view.sort.length ? S.view.sort[0].key : null;
    $('body').classList.toggle('sorting', !!key);
    S.pool.forEach(function (slot) {
      for (var i = 0; i < S.columns.length; i++) { slot.cells[i].classList.toggle('by', S.columns[i].key === key); }
    });
  }

  function poolSize() {
    return Math.ceil($('grid').clientHeight / ROW_H) + OVERSCAN * 2;
  }

  function buildPool() {
    var body = $('body'), need = poolSize();
    while (S.pool.length) { S.pool.pop().el.remove(); }
    for (var p = 0; p < need; p++) {
      var el = document.createElement('div');
      el.className = 'r';
      var cells = [], thumb = null, nameText = null, why = null;
      for (var i = 0; i < S.columns.length; i++) {
        var col = S.columns[i], cell = document.createElement('div');
        cell.className = 'c c-' + col.key + (col.kind === 'number' ? ' num' : '') + (col.kind === 'date' || col.key === 'camera' || col.key === 'lens' || col.key === 'codec' ? ' quiet' : '');
        placeCell(cell, col, i === S.columns.length - 1);
        if (col.kind === 'thumb') {
          thumb = document.createElement('img');
          thumb.draggable = false;
          thumb.hidden = true;
          thumb.alt = '';
          cell.appendChild(thumb);
        } else if (col.key === 'name') {
          nameText = document.createElement('span');
          nameText.className = 'n';
          why = document.createElement('span');
          why.className = 'why';
          cell.appendChild(nameText);
          cell.appendChild(why);
        }
        el.appendChild(cell);
        cells.push(cell);
      }
      body.appendChild(el);
      S.pool.push({ el: el, cells: cells, thumb: thumb, nameText: nameText, why: why, thumbPath: null, rowId: -1, version: -1, y: -1, cls: '' });
    }
  }

  function paintRow(slot, row) {
    for (var i = 0; i < S.columns.length; i++) {
      var col = S.columns[i];
      if (col.kind === 'thumb') { continue; }
      if (col.key === 'name') {
        var reason = row.error ? C.unreadableReason(row) : C.noPictureWords(row);
        if (slot.nameText.textContent !== row.name) { slot.nameText.textContent = row.name; }
        if (slot.why.textContent !== reason) { slot.why.textContent = reason; }
        slot.cells[i].title = row.reason ? row.path + '\n' + row.reason : row.path;
        continue;
      }
      var cell = slot.cells[i], text = C.cellText(row, col);
      if (cell.textContent !== text) { cell.textContent = text; }
    }
    var want = row.thumb || null;
    if (want !== slot.thumbPath) {
      slot.thumbPath = want;
      slot.thumb.hidden = !want;
      if (want) { slot.thumb.src = C.fileUrl(want); } else { slot.thumb.removeAttribute('src'); }
    }
  }

  function renderRows() {
    var grid = $('grid'), rows = S.store.rows, order = S.order;
    var first = Math.max(0, Math.floor(grid.scrollTop / ROW_H) - OVERSCAN);
    for (var p = 0; p < S.pool.length; p++) {
      var slot = S.pool[p], at = first + p;
      if (at >= order.length) {
        if (slot.y !== -2) { slot.el.style.display = 'none'; slot.y = -2; slot.rowId = -1; }
        continue;
      }
      var row = rows[order[at]], y = at * ROW_H;
      if (slot.y !== y) {
        if (slot.y === -2) { slot.el.style.display = ''; }
        slot.el.style.transform = 'translate3d(0,' + y + 'px,0)';
        slot.y = y;
      }
      slot.el.dataset.at = at;
      if (slot.rowId !== row.rowId || slot.version !== (row.version || 0)) {
        paintRow(slot, row);
        slot.rowId = row.rowId;
        slot.version = row.version || 0;
      }
      var cls = 'r' + (row.tier === 1 || row.error ? '' : ' pending') + (row.error ? ' err' : '') + (row.error || row.reason ? ' two' : '') + (S.selected.has(row.rowId) ? ' sel' : '');
      if (slot.cls !== cls) { slot.el.className = cls; slot.cls = cls; }
    }
  }

  var rafPending = false;
  function scheduleRows() {
    if (rafPending) { return; }
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      renderRows();
    });
  }

  function emptyText() {
    if (S.store.rows.length && !S.order.length) {
      return S.hasGroups ? 'No clips within ' + C.NEAR_DUP_BITS + ' bits of each other in this scan.' : 'No clip matches this view.';
    }
    return '';
  }

  function sameColumns(a, b) {
    if (a.length !== b.length) { return false; }
    for (var i = 0; i < a.length; i++) { if (a[i] !== b[i]) { return false; } }
    return true;
  }

  function syncColumns() {
    var next = visibleColumns();
    if (sameColumns(next, S.columns)) { return; }
    S.columns = next;
    buildHead();
    buildPool();
  }

  // Recompute order from the current view. Returns milliseconds spent in sort and DOM.
  function applyView() {
    var t0 = performance.now();
    var res = C.computeView(S.store.rows, S.view, function () { return performance.now(); });
    S.order = res.order;
    S.groupCount = res.groupCount;
    S.hasGroups = res.hasGroups;
    syncColumns();
    $('body').style.height = S.order.length * ROW_H + 'px';
    $('body').style.minWidth = totalWidth() + 'px';
    renderHead();
    renderSortColumn();
    renderRows();
    renderView();
    renderFoot();
    $('empty').textContent = emptyText();
    S.lastComputed = performance.now();
    return S.lastComputed - t0;
  }

  // A user action on the view: measured and shown in the status line.
  function changeView(next) {
    S.history.push({ sort: S.view.sort, preset: S.view.preset });
    if (S.history.length > 50) { S.history.shift(); }
    S.view = next;
    measuredApply();
  }

  function measuredApply() {
    moveOn();
    note('');
    S.sortMs = applyView();
    S.sortRows = S.store.rows.length;
  }

  function undoView() {
    var prev = S.history.pop();
    if (!prev) { return; }
    S.view = prev;
    measuredApply();
  }

  function clearView() {
    changeView({ sort: [], preset: null });
  }

  // Pressing the active preset again puts back the view from before it.
  function pressPreset(id) {
    if (S.view.preset === id) {
      changeView(S.beforePreset || { sort: [], preset: null });
      S.beforePreset = null;
      return;
    }
    if (!S.view.preset) { S.beforePreset = S.view; }
    changeView({ sort: C.PRESET[id].sort.slice(), preset: id });
  }

  function headerClick(key, shift) {
    var p = S.view.preset ? C.PRESET[S.view.preset] : null;
    var keepPreset = p && (p.filter || p.group) ? S.view.preset : null;
    changeView({ sort: C.nextSort(S.view.sort, key, shift), preset: keepPreset });
  }

  // ---------------------------------------------------------------- selection

  function rowAt(el) {
    var r = el.closest('.r');
    return r ? Number(r.dataset.at) : -1;
  }

  function clickRow(at, e) {
    var id = S.order[at];
    if (e.shiftKey && S.anchor !== null) {
      var from = S.order.indexOf(S.anchor);
      if (from < 0) { from = at; }
      if (!e.metaKey && !e.ctrlKey) { S.selected.clear(); }
      for (var i = Math.min(from, at); i <= Math.max(from, at); i++) { S.selected.add(S.order[i]); }
    } else if (e.metaKey || e.ctrlKey) {
      if (S.selected.has(id)) { S.selected.delete(id); } else { S.selected.add(id); }
      S.anchor = id;
    } else {
      S.selected.clear();
      S.selected.add(id);
      S.anchor = id;
    }
    moveOn();
    note('');
    renderRows();
    renderFoot();
  }

  // Selected rows when there are any, else the current view. Always in view order.
  function targetRows() {
    var rows = S.store.rows, out = [];
    for (var i = 0; i < S.order.length; i++) {
      var id = S.order[i];
      if (!S.selected.size || S.selected.has(id)) { out.push({ row: rows[id], rank: i + 1 }); }
    }
    return out;
  }

  // ---------------------------------------------------------------- scan

  function resetStore() {
    S.store = C.createStore();
    S.selected.clear();
    S.anchor = null;
    S.outcome = null;
    S.lastComputed = 0;
    $('grid').scrollTop = 0;
  }

  function collectItems() {
    if (S.source === 'folder') {
      var folder = $('folder').value.trim();
      if (!folder) { return Promise.resolve({ ok: false, message: 'Enter or choose a folder.' }); }
      return new Promise(function (resolve) {
        N.walkFolder(folder, function (err, paths) {
          if (err) { resolve({ ok: false, message: 'Cannot read ' + folder + ': ' + err.code }); return; }
          resolve({ ok: true, items: paths.map(function (p) { return { path: p }; }), noPath: 0, sequences: 0 });
        });
      });
    }
    return host('collect', { mode: S.source });
  }

  function startScan() {
    if (S.listing || (S.scan && S.scan.handle)) { return; }
    if (!N.available) { note('This panel can\'t start Node, so it can\'t scan. Reinstall Select.', 'bad'); return; }
    note('');
    moveOn();
    S.listing = true;
    renderFoot();
    return collectItems().then(function (got) {
      S.listing = false;
      if (!got.ok) { note(got.message, 'warn'); renderFoot(); return; }
      if (got.project) { S.project = got.project; }     // the project may have changed since the panel opened
      var filtered = C.videoItems(got.items);
      if (!filtered.items.length) { note('No video clips in that source.', 'warn'); renderFoot(); return; }
      resetStore();
      C.addItems(S.store, filtered.items);
      S.scan = { state: 'Scanning', startedAt: performance.now(), endedAt: 0, handle: null, source: S.source, folder: $('folder').value.trim(), failure: null, stopping: false, heard: 0 };
      applyView();
      if (filtered.skipped) { note(plural(filtered.skipped, 'item') + ' skipped: not video.'); }
      var binary = extensionRoot() + '/bin/select-engine';
      var problem = N.engineProblem(binary);
      if (problem) {
        S.scan.state = 'Not scanned';
        S.scan.endedAt = performance.now();
        S.scan.failure = C.engineFailure({ errorCode: problem }, 0);
        renderFoot();
        return;
      }
      var paths = S.store.rows.map(function (r) { return r.path; });
      S.scan.handle = N.runEngine(binary, paths, {
        onMessage: onEngineLine,
        onBad: function () { S.store.bad++; S.scan.heard++; scheduleFlush(); },
        onExit: onEngineExit
      });
      renderFoot();
    });
  }

  function onEngineLine(msg) {
    if (S.scan) { S.scan.heard++; }
    if (C.ingest(S.store, msg)) { scheduleFlush(); }
  }

  // A timer, not requestAnimationFrame: the scan must keep landing when no frame is being drawn.
  var flushTimer = null;
  function scheduleFlush() {
    if (flushTimer !== null) { return; }
    flushTimer = setTimeout(function () {
      flushTimer = null;
      flushNow();
    }, FLUSH_MS);
  }

  function flushNow() {
    var v = S.view, due = performance.now() - S.lastComputed >= RESORT_EVERY_MS;
    var grew = S.order.length !== S.store.rows.length && !v.preset;
    if (grew || ((v.sort.length || v.preset) && due)) {
      applyView();
    } else {
      renderRows();
      renderFoot();
    }
  }

  function onEngineExit(info) {
    var sc = S.scan;
    if (!sc) { return; }
    sc.handle = null;
    sc.endedAt = performance.now();
    var st = S.store;
    if (info.stopped) {
      sc.state = 'Stopped';
    } else if (info.error || info.code !== 0) {
      sc.state = 'Failed';
      sc.failure = C.engineFailure(info, sc.heard);
      $('foot-sentence').title = info.stderr || '';
    } else if (!st.done) {
      sc.state = 'Incomplete';
      sc.failure = { verdict: 'The scan stopped early', sentence: 'The engine quit before the last clip. What was read stays. Rescan, or report a bug.' };
    } else {
      sc.state = 'Done';
    }
    applyView();
  }

  function stopScan() {
    if (S.scan && S.scan.handle) {
      S.scan.stopping = true;
      S.scan.handle.stop();
      renderFoot();
    }
  }

  function killEngine() {
    if (S.scan && S.scan.handle) { S.scan.handle.kill(); }
  }

  // ---------------------------------------------------------------- dialogs

  function dialog(title, html, okText, cancelText) {
    return new Promise(function (resolve) {
      closeMenu();
      $('dialog-title').textContent = title;
      $('dialog-body').innerHTML = html;
      var ok = $('dialog-ok'), cancel = $('dialog-cancel');
      ok.textContent = okText || 'OK';
      ok.hidden = okText === null;
      cancel.textContent = cancelText || 'Cancel';
      cancel.hidden = cancelText === null;
      $('modal').hidden = false;
      S.modalOpen = true;
      (cancelText === null ? ok : cancel).focus();
      function done(answer) {
        ok.onclick = cancel.onclick = null;
        ok.hidden = cancel.hidden = false;
        $('modal').hidden = true;
        S.modalOpen = false;
        resolve(answer);
      }
      ok.onclick = function () { done(true); };
      cancel.onclick = function () { done(false); };
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  // ---------------------------------------------------------------- write safety

  function lockRefusal() {
    if (!N.available) { return 'This panel can\'t start Node, so nothing was written.'; }
    var l = N.writeLock();
    if (!l.held) { return null; }
    if (l.unreadable) { return 'The write lock is held: its file can\'t be read. Nothing was written.'; }
    return 'The write lock is held' + (l.who ? ' by ' + l.who : '') + (l.op ? ' (' + l.op + ')' : '') + '. Nothing was written.';
  }

  // Checks that cost nothing and refuse before the dialog. The host checks playback again in the write call itself.
  function preflight() {
    var refused = lockRefusal();
    if (refused) { return Promise.resolve({ ok: false, message: refused }); }
    return refreshProject().then(function (r) {
      if (!r.ok) { return { ok: false, message: r.message }; }
      if (!r.project) { return { ok: false, message: 'No project is open.' }; }
      var p = r.playback;
      if (p.modal) { return { ok: false, message: 'A Premiere dialog is open. Close it first.' }; }
      if (p.modal === null) { return { ok: false, message: 'Premiere did not confirm that no dialog is open, so nothing was written.' }; }
      if (p.program === true || p.source === true) { return { ok: false, message: 'Playback is running. Stop it and try again.' }; }
      if (p.program !== false || p.source !== false) { return { ok: false, message: 'Premiere did not confirm that playback is stopped, so nothing was written.' }; }
      return { ok: true, project: r.project };
    });
  }

  // Paths are the identity, not ids. An id is a small counter that means nothing outside the project it came from, so
  // every write and open asks the project in front for its items and matches rows by path. Rows not found have no ids.
  function resolveIds(targets) {
    return host('collect', { mode: 'project' }).then(function (r) {
      if (!r.ok) { return r; }
      var byKey = new Map();
      r.items.forEach(function (it) {
        var k = C.pathKey(it.path);
        if (!byKey.has(k)) { byKey.set(k, []); }
        byKey.get(k).push(it.id);
      });
      // A Selection scan is a promise about which items were picked, so a second copy of the media elsewhere stays put.
      var picked = S.scan && S.scan.source === 'selection';
      targets.forEach(function (t) {
        var all = byKey.get(t.row.key) || [];
        if (picked && !t.row.scanIds) { t.row.scanIds = t.row.ids.slice(); }
        var kept = picked ? all.filter(function (id) { return t.row.scanIds.indexOf(id) !== -1; }) : [];
        t.row.ids = kept.length ? kept : all;
      });
      return r;
    });
  }

  function failureList(failed) {
    if (!failed || !failed.length) { return ''; }
    var byId = new Map();
    S.store.rows.forEach(function (r) { r.ids.forEach(function (id) { byId.set(id, r.name); }); });
    var shown = failed.slice(0, 8).map(function (f) {
      return '<li>' + esc(f.name || byId.get(f.id) || f.id || 'bin') + ': ' + esc(f.error) + '</li>';
    }).join('');
    return '<ul class="fails">' + shown + '</ul>' + (failed.length > 8 ? '<p class="quiet">And ' + fmtInt(failed.length - 8) + ' more.</p>' : '');
  }

  // Measured on 26.5.2: Premiere records at least one undo step per item and reaches only the last 50
  // (BE.Prefs.Undo.MaxLevels), so a batch cannot be taken back with Cmd+Z and it pushes older edits out of History.
  var UNDO_LEVELS = 50;

  function undoText(steps) {
    if (steps <= UNDO_LEVELS) {
      return '<p class="quiet">Cmd+Z takes it back one step at a time, about ' + plural(steps, 'step') + '. Undo here works too.</p>';
    }
    return '<p class="warn">About ' + fmtInt(steps) + ' undo steps. Premiere keeps only the last ' + UNDO_LEVELS + ', so Cmd+Z can\'t take this back, and older edits leave History. Undo here puts the earlier values back, until the panel is reloaded.</p>';
  }

  // Shared route of the three writes: preflight, targets, confirmation, lock again, one host call, read-back, foot.
  function runWrite(spec) {
    var ready = null;
    note('');
    return preflight().then(function (r) {
      if (!r.ok) { note(r.message, 'warn'); return null; }
      ready = r;
      var targets = targetRows();
      return resolveIds(targets).then(function (found) {
        if (found.ok) { return targets; }
        note(found.message, 'warn');
        return null;
      });
    }).then(function (targets) {
      if (!targets) { return; }
      var inProject = targets.filter(function (t) { return t.row.ids.length; });
      var missing = targets.length - inProject.length;
      if (!inProject.length) { note('None of these clips are in the project.', 'warn'); return; }
      var plan = spec.plan(inProject, ready.project);
      if (!plan) { return; }
      var items = inProject.reduce(function (n, t) { return n + t.row.ids.length; }, 0);
      var scope = S.selected.size ? 'the selected rows' : 'the current view';
      var body = '<p><b>' + plural(inProject.length, 'clip') + '</b>' + (items !== inProject.length ? ' (' + plural(items, 'project item') + ')' : '') + ' in ' + esc(projectTitle(ready.project)) + ', from ' + scope + '.</p>' +
        (missing ? '<p class="warn">' + plural(missing, 'clip') + ' not in this project will be skipped.</p>' : '') + plan.html;
      return dialog(plan.title, body, plan.ok).then(function (yes) {
        if (!yes) { note('Cancelled. Nothing was written.'); return; }
        var refused = lockRefusal();
        if (refused) { note(refused, 'warn'); return; }
        if (plan.confirm) { plan.confirm(); }
        plan.args.project = ready.project.path;
        moveOn();
        S.busy = plan.busy;
        renderFoot();
        return host(plan.fn, plan.args).then(function (res) {
          S.busy = null;
          if (!res.ok) { note(res.message, 'bad'); renderFoot(); return; }
          var count = res.changed !== undefined ? res.changed : res.moved;
          S.outcome = C.writeOutcome(plan.fn, plan.args, res, plan.word && plan.word());
          if (count) { S.lastWrite = { title: S.outcome.verdict, restore: res.restore, project: ready.project.path }; }
          renderFoot();
        });
      });
    });
  }

  function doLabel() {
    function labelName() { return C.LABELS[S.labelColor][0]; }
    return runWrite({
      plan: function (targets) {
        var ids = [];
        targets.forEach(function (t) { ids = ids.concat(t.row.ids); });
        var swatches = C.LABELS.map(function (l, i) {
          return '<button data-color="' + i + '" title="' + esc(l[0]) + '" aria-label="' + esc(l[0]) + '"' + (i === S.labelColor ? ' class="on"' : '') + '><i style="background:' + l[1] + '"></i></button>';
        }).join('');
        var args = { ids: ids, color: S.labelColor };
        return {
          fn: 'label',
          args: args,
          title: 'Label ' + plural(targets.length, 'clip') + '?',
          html: '<div class="swatches">' + swatches + '</div><p>Sets the label <b id="label-name">' + esc(labelName()) + '</b> on these project items. Clips and files keep their names.</p>' + undoText(ids.length),
          ok: 'Label ' + fmtInt(targets.length),
          busy: 'Labelling ' + plural(ids.length, 'clip'),
          confirm: function () { args.color = S.labelColor; },
          word: labelName
        };
      }
    });
  }

  function doColumns() {
    return runWrite({
      plan: function (targets) {
        var width = String(S.order.length).length, rows = targets.map(function (t) {
          return { ids: t.row.ids, values: C.columnValues(t.row, t.rank, Math.max(4, width)) };
        });
        return {
          fn: 'columns',
          args: { fields: C.FIELDS, rows: rows },
          title: 'Add columns to ' + plural(targets.length, 'clip') + '?',
          html: '<p>Adds six columns to the project metadata: ' + C.FIELDS.map(function (f) { return esc(f.label.replace(/^Select /, '')); }).join(', ') + '. Their names start with Select. Writes the values and shows the columns in the Project panel. Empty scores stay empty. Rank is the place in the current view.</p>' +
            undoText(rows.reduce(function (n, r) { return n + r.ids.length; }, 0) * C.FIELDS.length) +
            '<p class="quiet">Undo does not cover the fields or the layout: they stay in this project, and the columns stay shown, because Premiere saves them in the workspace. Hide them with Metadata Display in the Project panel menu.</p>',
          ok: 'Add Columns',
          busy: 'Adding columns'
        };
      }
    });
  }

  function doBins() {
    var name = C.sortName(S.view);
    if (!name) { note('Pick a sort first. Bins are built from it.', 'warn'); return Promise.resolve(); }
    return runWrite({
      plan: function (targets) {
        var buckets = C.bucketize(targets.map(function (t) { return t.row; }), S.view);
        if (!buckets) { note('Pick a sort first. Bins are built from it.', 'warn'); return null; }
        var root = 'SELECT ' + C.localDate(new Date()) + ' ' + name;
        var count = targets.length;
        var listed = buckets.map(function (b) { return '<li><span>' + esc(b.name) + '</span><span>' + fmtInt(b.rows.length) + '</span></li>'; }).join('');
        return {
          fn: 'bins',
          args: {
            root: root,
            buckets: buckets.map(function (b) {
              var ids = [];
              b.rows.forEach(function (r) { ids = ids.concat(r.ids); });
              return { name: b.name, ids: ids };
            })
          },
          title: 'Sort ' + plural(count, 'clip') + ' into bins?',
          html: '<p>Creates the bin <b>' + esc(root) + '</b> with:</p><ul>' + listed + '</ul>' +
            '<p>This moves items in the Project panel, not files on disk.</p>' + undoText(count + 2 * (buckets.length + 1)),
          ok: 'Sort into Bins',
          busy: 'Moving ' + plural(count, 'clip')
        };
      }
    });
  }

  function doUndoWrite() {
    var w = S.lastWrite;
    if (!w) { return Promise.resolve(); }
    note('');
    return preflight().then(function (r) {
      if (!r.ok) { note(r.message, 'warn'); return; }
      return dialog('Undo this write?', '<p>Puts back: ' + esc(w.title) + '.</p><p class="quiet">The earlier values go back, item by item. An item changed by anything else since is left alone.</p>', 'Undo').then(function (yes) {
        if (!yes) { return; }
        var refused = lockRefusal();
        if (refused) { note(refused, 'warn'); return; }
        S.outcome = null;
        S.busy = 'Putting things back';
        renderFoot();
        return host('restore', { project: w.project, restore: w.restore }).then(function (res) {
          S.busy = null;
          if (!res.ok) { note(res.message, 'warn'); renderFoot(); return; }
          S.lastWrite = res.remaining ? { title: w.title, restore: res.remaining, project: w.project } : null;
          S.outcome = C.undoOutcome(res);
          renderFoot();
        });
      });
    });
  }

  function showDetails() {
    var o = S.outcome;
    if (!o) { return Promise.resolve(); }
    return dialog('What didn\'t land', '<p>' + esc(o.sentence) + '</p>' + failureList(o.failed), 'OK', null);
  }

  // ---------------------------------------------------------------- open in the Source Monitor

  function openRow(row) {
    var refused = lockRefusal();
    if (refused) { note(refused, 'warn'); return Promise.resolve(); }
    return refreshProject().then(function (st) {
      if (!st.ok || !st.project) { note(st.message || 'No project is open.', 'warn'); return; }
      return resolveIds([{ row: row }]).then(function (found) {
        if (!found.ok) { note(found.message, 'warn'); return; }
        if (row.ids.length) { return openId(row, st.project); }
        return offerImport(row, st.project);
      });
    });
  }

  function openId(row, project) {
    return host('open', { project: project.path, id: row.ids[0] }).then(function (res) {
      note(res.ok ? 'Opened ' + res.name + ' in the Source Monitor.' : res.message, res.ok ? '' : 'warn');
    });
  }

  function offerImport(row, project) {
    return dialog('Not in the project', '<p><b>' + esc(row.name) + '</b> is not in ' + esc(projectTitle(project)) + '.</p><p class="quiet">Import it by reference into the bin ' + IMPORT_BIN + ' and open it in the Source Monitor? The file stays where it is.</p>', 'Import and Open').then(function (yes) {
      if (!yes) { return; }
      var refused = lockRefusal();
      if (refused) { note(refused, 'warn'); return; }
      return host('importClips', { project: project.path, paths: [row.path], bin: IMPORT_BIN }).then(function (res) {
        if (!res.ok) { note(res.message, 'bad'); return; }
        var hit = res.items.filter(function (it) { return C.pathKey(it.path) === row.key; })[0];
        if (!hit) { note('Premiere did not import ' + row.name + '.', 'bad'); return; }
        row.ids = [hit.id];
        return openId(row, project);
      });
    });
  }

  // ---------------------------------------------------------------- wiring

  function setSource(src) {
    S.source = src;
    var buttons = $('source').children;
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].dataset.src === src;
      buttons[i].classList.toggle('on', on);
      buttons[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    $('folder-box').hidden = src !== 'folder';
    try { localStorage.setItem('select.source', src); } catch (e) {}
    renderFoot();
  }

  function chooseFolder() {
    var native = window.SelectNative;
    if (!native || !native.available) { note('No folder dialog here: type the path.', 'warn'); return; }
    var button = $('choose');
    button.disabled = true;
    native.pickFolder('Choose a folder to scan', $('folder').value.trim(), function (err, path) {
      button.disabled = false;
      if (err) { note('The folder dialog failed: type the path. ' + err.message, 'warn'); return; }
      if (!path) { return; }
      $('folder').value = path;
      renderFoot();
      try { localStorage.setItem('select.folder', path); } catch (e) {}
    });
  }

  // Follows Premiere's brightness: dark tokens when dark, light tokens when set bright.
  function applyHostTheme() {
    if (!window.__adobe_cep__) { return; }
    try {
      var skin = JSON.parse(window.__adobe_cep__.getHostEnvironment()).appSkinInfo;
      document.documentElement.dataset.theme = C.themeFor(skin.panelBackgroundColor.color);
    } catch (e) {}
  }

  // ---------------------------------------------------------------- the menu

  function closeMenu() {
    $('menu').hidden = true;
    $('more').setAttribute('aria-expanded', 'false');
  }

  function openMenu() {
    var scanning = !!(S.listing || (S.scan && S.scan.handle));
    var item = function (id) { return document.querySelector('#menu [data-menu="' + id + '"]'); };
    item('rescan').disabled = scanning;
    item('rescan').textContent = S.scan ? 'Rescan' : 'Scan';
    item('clear').disabled = scanning || !S.store.rows.length;
    item('undo-view').hidden = !S.history.length;
    item('undo').hidden = !S.lastWrite;
    item('undo').disabled = scanning;
    $('menu').hidden = false;
    $('more').setAttribute('aria-expanded', 'true');
    item('rescan').focus();
  }

  function menuItems() {
    return Array.prototype.filter.call($('menu').querySelectorAll('button'), function (b) { return !b.hidden && !b.disabled; });
  }

  function stepMenu(by) {
    var items = menuItems(), at = items.indexOf(document.activeElement);
    if (items.length) { items[(at + by + items.length) % items.length].focus(); }
  }

  function clearResults() {
    S.store = C.createStore();
    S.scan = null;
    S.outcome = null;
    S.view = { sort: [], preset: null };
    S.history = [];
    S.beforePreset = null;
    S.selected.clear();
    S.anchor = null;
    S.sortMs = null;
    $('grid').scrollTop = 0;
    note('');
    applyView();
  }

  function saveColumns() {
    try { localStorage.setItem('select.columns', JSON.stringify(S.shownColumns)); } catch (e) {}
  }

  function showColumns() {
    var list = C.COLUMNS.filter(function (c) { return !c.fixed; }).map(function (c) {
      return '<button data-column="' + c.key + '" aria-pressed="' + columnOn(c) + '"' + (columnOn(c) ? ' class="on"' : '') + '>' + esc(c.label) + '</button>';
    }).join('');
    return dialog('Columns', '<div class="col-list">' + list + '</div>', 'Done', null);
  }

  function toggleColumn(button) {
    var c = C.COLUMN[button.dataset.column], on = !columnOn(c);
    S.shownColumns[c.key] = on;
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    saveColumns();
    syncColumns();
    $('body').style.minWidth = totalWidth() + 'px';
    renderSortColumn();
    renderRows();
  }

  function reportBug() {
    var util = window.cep && window.cep.util;
    if (util && util.openURLInDefaultBrowser) {
      util.openURLInDefaultBrowser(ISSUES_URL);
    } else {
      note('Report bugs at ' + ISSUES_URL, 'warn');
    }
  }

  function showAbout() {
    var version = N.available ? N.manifestVersion(extensionRoot()) : null;
    var timing = S.sortMs === null ? '' : '<p class="quiet">Last re-sort: ' + S.sortMs.toFixed(1) + ' ms, ' + fmtInt(S.sortRows) + ' rows.</p>';
    return dialog('About Select', '<p>' + (version ? 'Version ' + esc(version) : 'Version unknown') + '</p><p class="quiet">' + esc(C.FORMATS_NOTE) + '</p><p class="quiet">Scans run on this Mac. The panel sends nothing.</p>' + timing, 'Done', null);
  }

  var MENU = { rescan: startScan, columns: showColumns, 'undo-view': undoView, undo: doUndoWrite, clear: clearResults, bug: reportBug, about: showAbout };

  function init() {
    applyHostTheme();
    C.PRESETS.forEach(function (p) {
      var b = document.createElement('button');
      b.className = 'word';
      b.textContent = p.label;
      b.title = p.tip;
      b.dataset.id = p.id;
      b.dataset.label = p.label;
      b.onclick = function () { pressPreset(p.id); };
      $('presets').appendChild(b);
    });

    var saved = null, folder = null;
    try {
      saved = localStorage.getItem('select.source');
      folder = localStorage.getItem('select.folder');
      S.shownColumns = JSON.parse(localStorage.getItem('select.columns') || '{}') || {};
    } catch (e) {}
    S.source = SOURCE_NAMES[saved] ? saved : 'selection';
    if (folder) { $('folder').value = folder; }

    $('source').onclick = function (e) {
      var b = e.target.closest('button');
      if (b) { setSource(b.dataset.src); }
    };
    $('choose').onclick = chooseFolder;
    $('folder').addEventListener('input', renderFoot);
    $('scan').onclick = startScan;
    $('stop').onclick = stopScan;
    $('clear-view').onclick = clearView;
    $('do-label').onclick = doLabel;
    $('do-columns').onclick = doColumns;
    $('do-bins').onclick = doBins;
    $('undo-write').onclick = doUndoWrite;
    $('foot-details').onclick = showDetails;

    $('more').onclick = function (e) {
      e.stopPropagation();
      if ($('menu').hidden) { openMenu(); } else { closeMenu(); }
    };
    $('menu').onclick = function (e) {
      var b = e.target.closest('button');
      if (b && !b.disabled) {
        closeMenu();
        MENU[b.dataset.menu]();
      }
    };
    document.addEventListener('mousedown', function (e) {
      if (!$('menu').hidden && !e.target.closest('#menu') && !e.target.closest('#more')) { closeMenu(); }
    });
    $('dialog-body').addEventListener('click', function (e) {
      var swatch = e.target.closest('[data-color]'), column = e.target.closest('[data-column]');
      if (column) { toggleColumn(column); }
      if (swatch) {
        S.labelColor = Number(swatch.dataset.color);
        var all = $('dialog-body').querySelectorAll('[data-color]');
        for (var i = 0; i < all.length; i++) { all[i].classList.toggle('on', all[i] === swatch); }
        $('label-name').textContent = C.LABELS[S.labelColor][0];
      }
    });

    $('head').onclick = function (e) {
      var h = e.target.closest('.h');
      if (h && C.COLUMN[h.dataset.key].sortable !== false) { headerClick(h.dataset.key, e.shiftKey); }
    };
    $('body').addEventListener('mousedown', function (e) {
      var at = rowAt(e.target);
      if (at >= 0) { clickRow(at, e); }
    });
    $('body').addEventListener('dblclick', function (e) {
      var at = rowAt(e.target);
      if (at >= 0) { openRow(S.store.rows[S.order[at]]); }
    });
    $('grid').addEventListener('scroll', scheduleRows, { passive: true });
    new ResizeObserver(function () {
      if (poolSize() !== S.pool.length) { buildPool(); renderSortColumn(); }
      renderRows();
    }).observe($('grid'));

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('menu').hidden) { closeMenu(); $('more').focus(); return; }
      if (S.modalOpen && e.key === 'Escape') { ($('dialog-cancel').hidden ? $('dialog-ok') : $('dialog-cancel')).click(); return; }
      if (!$('menu').hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        stepMenu(e.key === 'ArrowDown' ? 1 : -1);
      }
    });
    window.addEventListener('beforeunload', killEngine);
    window.addEventListener('pagehide', killEngine);
    if (window.__adobe_cep__ && window.__adobe_cep__.addEventListener) {
      window.__adobe_cep__.addEventListener('com.adobe.csxs.events.ApplicationBeforeQuit', killEngine);
      window.__adobe_cep__.addEventListener(THEME_EVENT, applyHostTheme);
    }

    S.columns = visibleColumns();
    buildHead();
    buildPool();
    setSource(S.source);
    applyView();
    ensureHost().then(refreshProject);
  }

  // For the tests and for the integration pass, through the DevTools port.
  window.SelectApp = {
    state: S,
    startScan: startScan,
    stopScan: stopScan,
    applyView: applyView,
    extensionRoot: extensionRoot,
    foot: function () { return C.footState(footFacts()); }
  };

  init();
})();
