// Select panel: DOM, table, scan flow and the explicit project writes. Logic lives in core.js.
(function () {
  'use strict';
  var C = window.SelectCore, N = window.SelectNative;
  var ROW_H = 40, OVERSCAN = 6, FLUSH_MS = 66, RESORT_EVERY_MS = 200, IMPORT_BIN = 'SELECT IMPORTS';
  var ISSUES_URL = 'https://github.com/skyfallstatus/select/issues/new';
  var THEME_EVENT = 'com.adobe.csxs.events.ThemeColorChanged';
  var SOURCE_NAMES = { selection: 'Selection', project: 'Project', folder: 'Folder' };
  // The grid: tiles at least this wide, as many as fit, 16:9 pictures, one line under each.
  var TILE_MIN = 130, TILE_GAP = 10, TILE_ROW_GAP = 12, TILE_CAPTION = 21, TILE_TOP = 12, HEAD_H = 24;

  var BINS_FIRST = 'Choose what to show, or a sort, first. Bins are made from them.';
  var REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (id) { return document.getElementById(id); };
  var plural = C.plural, fmtInt = C.fmtInt;
  var S = {
    store: C.createStore(),
    view: { show: null, sort: [], family: null },
    history: [],
    order: [],
    hasGroups: false,
    groupCount: 0,
    breaks: [],          // where each group starts in `order`
    mode: 'list',        // list or grid: the same rows, sort, filter, selection and writes
    query: '',
    tokens: [],
    searchMs: null,
    L: { cols: 1, pitch: ROW_H, top: 0, ys: null, xs: null, heads: [], height: 0, tileW: 0, picH: 0 },
    tiles: [],
    heads: [],
    paintKey: 0,
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

  function scanRunning() {
    return !!(S.scan && S.scan.handle);
  }

  // A selection only counts for what is on screen: a filter or a search can hide selected clips.
  function selectedInView() {
    if (!S.selected.size) { return 0; }
    var n = 0;
    for (var i = 0; i < S.order.length; i++) { if (S.selected.has(S.order[i])) { n++; } }
    return n;
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
      selected: selectedInView(),
      view: S.view,
      groupCount: S.groupCount,
      query: S.query.trim(),
      needsTier2: C.viewNeedsTier2(S.view, S.tokens),
      status: C.dataStatus(S.store.rows, S.view.show, scanRunning())
    };
  }

  var ACTIONS = { scan: 'scan', stop: 'stop', label: 'do-label', columns: 'do-columns', bins: 'do-bins', undo: 'undo-write', details: 'foot-details' };

  // A new sentence fades in. A running count, in either stage of a scan, changes in place, and reduced motion means no fade at all.
  function setFootWords(id, text, kind) {
    var el = $(id);
    if (el.textContent === text) { return; }
    el.textContent = text;
    if (kind !== 'scanning' && kind !== 'understanding' && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
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
    var held = f.held || [];
    $('do-bins').disabled = !!f.binsOff || !S.order.length || held.indexOf('bins') >= 0;
    $('do-bins').title = held.length ? f.wait : f.binsOff ? BINS_FIRST : 'Moves these clips into new bins in the Project panel, made from what is shown and how it is sorted. Files on disk stay where they are.';
    $('do-label').disabled = !S.order.length || held.indexOf('label') >= 0;
    $('do-columns').disabled = !S.order.length || held.indexOf('columns') >= 0;
    $('do-label').title = held.length ? f.wait : 'Set a colour label on the selected clips, or on the current view';
    $('do-columns').title = held.length ? f.wait : 'Write the scores to project metadata, so the Project panel can sort by them';
    $('undo-write').title = S.lastWrite ? 'Puts back: ' + S.lastWrite.title : '';
    var tail = S.scan && f.kind !== 'scanning' && !f.green ? [f.wait || '', statusLine()].filter(Boolean).join(' ') : '';
    $('status-unread').textContent = tail;
    $('status-unread').hidden = !tail;
    renderHeader();
  }

  // Clips that could not be read, and why, in one plain sentence.
  function statusLine() {
    var line = [C.unreadableSummary(S.store.rows), C.notUnderstoodSummary(S.store)].filter(Boolean).join(' '), bad = S.store.bad;
    if (bad) { line += (line ? ' ' : '') + plural(bad, 'engine line') + ' could not be understood.'; }
    return line;
  }

  // The bar says the view in words: what is shown, how it is sorted, and which colour, if any.
  function renderView() {
    var v = S.view, show = v.show ? C.SHOW[v.show] : null, sort = v.sort[0] || null;
    setPick('show', show ? show.label : 'Everything', !!show);
    setPick('sort', sort ? C.sortWords(sort) : 'As listed', !!sort);
    $('flip').hidden = !sort;
    $('flip').title = sort ? 'Reverse to ' + C.sortWords({ key: sort.key, dir: -sort.dir }) : '';
    var counts = C.familyCounts(S.store.rows);
    Array.prototype.forEach.call(document.querySelectorAll('#families button'), function (b) {
      var f = C.FAMILY[b.dataset.family], n = counts[f.id] || 0;
      b.classList.toggle('on', v.family === f.id);
      b.classList.toggle('empty', !n);
      b.title = n ? f.word + ': ' + plural(n, 'clip') : f.word + ': none yet';
    });
    $('mode-list').classList.toggle('on', S.mode === 'list');
    $('mode-grid').classList.toggle('on', S.mode === 'grid');
    if (S.picker) { fillPicker(S.picker); }
    renderSearch();
  }

  function setPick(id, text, on) {
    var b = $(id), value = b.querySelector('.v');
    if (value.textContent !== text) { value.textContent = text; }
    b.classList.toggle('on', on);
  }

  function renderSearch() {
    var on = !!S.query.trim();
    $('search-count').hidden = !on;
    $('search-clear').hidden = !S.query;
    if (on) { $('search-count').textContent = fmtInt(S.order.length) + ' of ' + fmtInt(S.store.rows.length); }
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
      return !c.onlyWithGroups && (columnOn(c) || sorting[c.key]);     // groups head their own rows, so they need no column
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
      for (var j = 0; j < sort.length; j++) { if (sort[j].key === c.key && !S.hasGroups) { at = j; } }
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
        cell.className = 'c c-' + col.key + (col.kind === 'number' ? ' num' : '') + (col.kind === 'color' ? ' pal' : '') + (col.kind === 'date' || (col.kind === 'text' && col.key !== 'name') ? ' quiet' : '');
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
        } else if (col.kind === 'color') {
          for (var k = 0; k < 5; k++) { cell.appendChild(document.createElement('i')); }
        }
        el.appendChild(cell);
        cells.push(cell);
      }
      body.appendChild(el);
      S.pool.push({ el: el, cells: cells, thumb: thumb, nameText: nameText, why: why, thumbPath: null, rowId: -1, version: -1, y: -1, cls: '' });
    }
  }

  function paintPalette(chips, row) {
    var colours = row.palette || [];
    for (var i = 0; i < chips.length; i++) { chips[i].style.background = colours[i] || 'transparent'; }
  }

  // A picture that arrives while the scan runs fades in once. One that was already there, or comes back into view, doesn't.
  function setThumb(slot, img, row) {
    var want = row.thumb || null;
    if (want === slot.thumbPath) { return; }
    slot.thumbPath = want;
    img.hidden = !want;
    img.classList.remove('arrive');
    if (!want) { img.removeAttribute('src'); return; }
    if (!row.thumbSeen && scanRunning() && !REDUCED) { img.classList.add('arrive'); }
    row.thumbSeen = true;
    img.src = C.fileUrl(want);
  }

  function paintRow(slot, row) {
    for (var i = 0; i < S.columns.length; i++) {
      var col = S.columns[i];
      if (col.kind === 'thumb') { continue; }
      if (col.key === 'name') {
        var hit = C.matchedWord(row, S.tokens);
        var reason = row.error ? C.unreadableReason(row) : hit || C.noPictureWords(row);
        if (slot.nameText.textContent !== row.name) { slot.nameText.textContent = row.name; }
        if (slot.why.textContent !== reason) { slot.why.textContent = reason; }
        slot.why.classList.toggle('hit', !!hit && !row.error);
        slot.cells[i].title = row.reason || row.lookReason ? row.path + '\n' + (row.reason || row.lookReason) : row.path;
        continue;
      }
      var cell = slot.cells[i], text = C.cellText(row, col);
      if (col.kind === 'color') {
        paintPalette(cell.children, row);
        cell.title = text;
        continue;
      }
      if (cell.textContent !== text) { cell.textContent = text; }
    }
    setThumb(slot, slot.thumb, row);
  }

  // Where everything sits, for both views. Plain views are arithmetic; a view with groups measures once per change.
  function buildLayout() {
    var L = S.L, grid = S.mode === 'grid', n = S.order.length;
    if (grid) {
      var width = Math.max($('grid').clientWidth, 200) - 32;
      L.cols = Math.max(2, Math.floor((width + TILE_GAP) / (TILE_MIN + TILE_GAP)));
      L.tileW = Math.floor((width - (L.cols - 1) * TILE_GAP) / L.cols);
      L.picH = Math.round(L.tileW * 9 / 16);
      L.pitch = L.picH + TILE_CAPTION + TILE_ROW_GAP;
      L.top = TILE_TOP;
    } else {
      L.cols = 1;
      L.pitch = ROW_H;
      L.top = 0;
    }
    L.ys = L.xs = null;
    L.heads = [];
    if (S.breaks.length) {
      L.ys = new Int32Array(n);
      L.xs = new Int32Array(n);
      // Groups pack along shelves in the grid, as prints on a sheet do, so a run of small groups leaves no holes.
      var y = 0, col = 0, shelf = 0, unit = L.tileW + TILE_GAP;
      S.breaks.forEach(function (b) {
        if (!grid || col + b.count > L.cols) {
          y += shelf;
          col = 0;
          shelf = 0;
        }
        var rows = Math.ceil(b.count / L.cols), span = Math.min(b.count, L.cols);
        L.heads.push({ y: y, x: col * unit, width: span * unit - TILE_GAP, text: 'Group ' + b.number + ' · ' + plural(b.count, 'clip') });
        for (var k = 0; k < b.count; k++) {
          L.ys[b.at + k] = y + HEAD_H + Math.floor(k / L.cols) * L.pitch;
          L.xs[b.at + k] = (col + k % L.cols) * unit;
        }
        shelf = Math.max(shelf, HEAD_H + rows * L.pitch);
        col = rows > 1 ? L.cols : col + span;
      });
      L.height = y + shelf;
    } else {
      L.height = L.top + Math.ceil(n / L.cols) * L.pitch;
    }
    var box = grid ? $('tiles') : $('body');
    box.style.height = L.height + 'px';
    if (grid) { buildTiles(); }
    buildHeads(box);
  }

  function yOf(at) {
    var L = S.L;
    return L.ys ? L.ys[at] : L.top + Math.floor(at / L.cols) * L.pitch;
  }

  function xOf(at) {
    var L = S.L;
    return L.xs ? L.xs[at] : (at % L.cols) * (L.tileW + TILE_GAP);
  }

  // The first clip whose row reaches past `top`.
  function firstAt(top) {
    var L = S.L, n = S.order.length;
    if (top <= 0 || !n) { return 0; }
    if (!L.ys) { return Math.max(0, Math.floor((top - L.top) / L.pitch)) * L.cols; }
    var lo = 0, hi = n - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (L.ys[mid] + L.pitch <= top) { lo = mid + 1; } else { hi = mid; }
    }
    return lo;
  }

  function buildHeads(box) {
    var need = S.L.heads.length ? Math.ceil($('grid').clientHeight / HEAD_H) + 2 : 0;
    while (S.heads.length > need) { S.heads.pop().remove(); }
    while (S.heads.length < need) {
      var h = document.createElement('div');
      h.className = 'gh';
      S.heads.push(h);
    }
    S.heads.forEach(function (h) { if (h.parentNode !== box) { box.appendChild(h); } });
  }

  function renderHeads(top, bottom) {
    var heads = S.L.heads, used = 0;
    for (var i = 0; i < heads.length && used < S.heads.length; i++) {
      if (heads[i].y + HEAD_H < top || heads[i].y > bottom) { continue; }
      var el = S.heads[used++];
      el.style.top = heads[i].y + 'px';
      if (S.mode === 'grid') {
        el.style.left = 16 + heads[i].x + 'px';
        el.style.width = heads[i].width + 'px';
      } else {
        el.style.left = el.style.width = '';
      }
      if (el.textContent !== heads[i].text) { el.textContent = heads[i].text; }
      el.hidden = false;
    }
    for (; used < S.heads.length; used++) { S.heads[used].hidden = true; }
  }

  function renderRows() {
    var grid = $('grid'), rows = S.store.rows, order = S.order;
    var first = Math.max(0, firstAt(grid.scrollTop) - OVERSCAN);
    for (var p = 0; p < S.pool.length; p++) {
      var slot = S.pool[p], at = first + p;
      if (at >= order.length) {
        // A hidden slot loses its fade: shown again with the same picture, it would play it again.
        if (slot.y !== -2) { slot.el.style.display = 'none'; slot.y = -2; slot.rowId = -1; slot.thumb.classList.remove('arrive'); }
        continue;
      }
      var row = rows[order[at]], y = yOf(at);
      if (slot.y !== y) {
        if (slot.y === -2) { slot.el.style.display = ''; }
        slot.el.style.transform = 'translate3d(0,' + y + 'px,0)';
        slot.y = y;
      }
      slot.el.dataset.at = at;
      var version = (row.version || 0) + S.paintKey * 1e6;
      if (slot.rowId !== row.rowId || slot.version !== version) {
        paintRow(slot, row);
        slot.rowId = row.rowId;
        slot.version = version;
      }
      var cls = 'r' + (row.tier === 1 || row.error ? '' : ' pending') + (row.error ? ' err' : '') + (row.error || row.reason || row.lookReason || (slot.why.textContent && slot.why.classList.contains('hit')) ? ' two' : '') + (S.selected.has(row.rowId) ? ' sel' : '');
      if (slot.cls !== cls) { slot.el.className = cls; slot.cls = cls; }
    }
    renderHeads(grid.scrollTop, grid.scrollTop + grid.clientHeight);
  }

  // ---------------------------------------------------------------- the grid

  // A ring of tiles: a clip always lands in the same tile while it stays in range, so scrolling paints only what is new.
  function buildTiles() {
    var L = S.L, box = $('tiles');
    var need = L.cols * (Math.ceil($('grid').clientHeight / L.pitch) + 3), size = L.tileW + 'x' + L.picH;
    if (S.tiles.length === need && S.tileSize === size) { return; }
    S.tileSize = size;
    while (S.tiles.length) { S.tiles.pop().el.remove(); }
    for (var i = 0; i < need; i++) {
      var el = document.createElement('div');
      el.className = 't';
      el.style.width = L.tileW + 'px';
      el.style.height = L.picH + TILE_CAPTION + 'px';
      var pic = document.createElement('div');
      pic.className = 'pic';
      pic.style.height = L.picH + 'px';
      var img = document.createElement('img');
      img.draggable = false;
      img.alt = '';
      img.hidden = true;
      img.decoding = 'async';
      pic.appendChild(img);
      var cap = document.createElement('div');
      cap.className = 'cap';
      var name = document.createElement('span');
      name.className = 'n';
      var fact = document.createElement('span');
      fact.className = 'f';
      var chips = document.createElement('span');
      chips.className = 'p';
      chips.hidden = true;
      for (var k = 0; k < 5; k++) { chips.appendChild(document.createElement('i')); }
      cap.appendChild(name);
      cap.appendChild(fact);
      cap.appendChild(chips);
      el.appendChild(pic);
      el.appendChild(cap);
      box.appendChild(el);
      S.tiles.push({ el: el, pic: pic, img: img, name: name, fact: fact, chips: chips, key: '', thumbPath: null, x: -1, y: -1, cls: '' });
    }
  }

  function paintTile(slot, row) {
    var colour = S.view.sort.length && S.view.sort[0].key === 'colorName' && !!row.palette && !S.tokens.length;
    if (slot.name.textContent !== row.name) { slot.name.textContent = row.name; }
    var fact = colour ? '' : C.tileFact(row, S.view, S.tokens);
    if (slot.fact.textContent !== fact) { slot.fact.textContent = fact; }
    slot.fact.hidden = colour;
    slot.fact.classList.toggle('hit', !!S.tokens.length);
    slot.chips.hidden = !colour;
    if (colour) { paintPalette(slot.chips.children, row); }
    var why = row.error ? C.unreadableReason(row) : row.reason || row.lookReason;
    slot.el.title = why ? row.path + '\n' + why : row.path;
    // The clip's own colour holds the place until its picture is decoded, so a fast scroll reads as the footage.
    slot.pic.style.background = row.palette && row.palette[0] ? row.palette[0] : '';
    setThumb(slot, slot.img, row);
  }

  function renderTiles() {
    var grid = $('grid'), L = S.L, rows = S.store.rows, order = S.order, size = S.tiles.length, n = order.length;
    if (!size) { return; }
    var first = firstAt(grid.scrollTop - L.pitch);
    first -= first % L.cols;
    for (var s = 0; s < size; s++) {
      var at = first + ((s - first % size) + size) % size, slot = S.tiles[s];
      if (at >= n) {
        if (slot.y !== -2) { slot.el.style.display = 'none'; slot.y = -2; slot.key = ''; slot.img.classList.remove('arrive'); }
        continue;
      }
      var row = rows[order[at]], x = 16 + xOf(at), y = yOf(at);
      if (slot.y !== y || slot.x !== x) {
        if (slot.y === -2) { slot.el.style.display = ''; }
        slot.el.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
        slot.x = x;
        slot.y = y;
      }
      slot.el.dataset.at = at;
      var key = row.rowId + ':' + (row.version || 0) + ':' + S.paintKey;
      if (slot.key !== key) {
        paintTile(slot, row);
        slot.key = key;
      }
      var cls = 't' + (row.tier === 1 || row.error ? '' : ' pending') + (S.selected.has(row.rowId) ? ' sel' : '');
      if (slot.cls !== cls) { slot.el.className = cls; slot.cls = cls; }
    }
    renderHeads(grid.scrollTop - L.pitch, grid.scrollTop + grid.clientHeight + L.pitch);
  }

  function renderItems() {
    if (S.mode === 'grid') { renderTiles(); } else { renderRows(); }
  }

  var rafPending = false;
  function scheduleRows() {
    if (rafPending) { return; }
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      renderItems();
    });
  }

  function setMode(mode) {
    if (mode === S.mode) { return; }
    var at = firstAt($('grid').scrollTop);
    S.mode = mode;
    try { localStorage.setItem('select.mode', mode); } catch (e) {}
    var grid = mode === 'grid';
    $('body').hidden = $('head').hidden = grid;
    $('tiles').hidden = !grid;
    $('grid').classList.toggle('tiled', grid);
    S.paintKey++;
    applyView();
    $('grid').scrollTop = at ? yOf(Math.min(at, S.order.length - 1)) : 0;
    renderItems();
  }

  // Blank table, plain words. Waiting and nothing-there read differently, because they mean different things.
  function emptyText() {
    if (!S.store.rows.length || S.order.length) { return ''; }
    var show = S.view.show ? C.SHOW[S.view.show] : null, status = C.dataStatus(S.store.rows, S.view.show, scanRunning());
    if (S.tokens.length) { return 'Nothing matches ' + C.quoted(S.query.trim()) + '.' + (scanRunning() ? ' Still looking at clips, so more may come.' : ''); }
    if (status === 'waiting') { return (show && show.waiting) || 'Still looking at these clips. They appear here as they are done.'; }
    if (status === 'none') { return show.none; }
    if (S.view.family) { return 'No ' + C.FAMILY[S.view.family].word.toLowerCase() + ' clips' + (show ? ' among ' + show.label.toLowerCase() : '') + '.'; }
    if (show && show.group) { return show.none; }
    if (show) { return 'No ' + show.label.toLowerCase() + ' in this scan.'; }
    return 'No clip matches this view.';
  }

  function renderEmpty() {
    var text = emptyText();
    $('empty').hidden = !text;
    $('empty-words').textContent = text;
    $('empty-clear').hidden = !S.tokens.length;
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
    var t0 = performance.now(), tokens = C.searchTokens(S.query);
    if (tokens.join(' ') !== S.tokens.join(' ')) { S.paintKey++; }
    S.tokens = tokens;
    var res = C.computeView(S.store.rows, S.view, function () { return performance.now(); }, { tokens: tokens });
    S.order = res.order;
    S.groupCount = res.groupCount;
    S.hasGroups = res.hasGroups;
    S.breaks = res.breaks;
    syncColumns();
    $('body').style.minWidth = totalWidth() + 'px';
    buildLayout();
    renderHead();
    renderSortColumn();
    renderItems();
    renderView();
    renderFoot();
    renderEmpty();
    S.lastComputed = performance.now();
    return S.lastComputed - t0;
  }

  // A user action on the view: measured and shown in the status line.
  function changeView(next) {
    S.history.push(S.view);
    if (S.history.length > 50) { S.history.shift(); }
    S.view = next;
    measuredApply();
  }

  function measuredApply() {
    moveOn();
    note('');
    S.paintKey++;
    S.sortMs = applyView();
    S.sortRows = S.store.rows.length;
  }

  function undoView() {
    var prev = S.history.pop();
    if (!prev) { return; }
    S.view = prev;
    measuredApply();
  }

  // Show and Sort are separate: changing one keeps the other, and a colour dot stays through both.
  function pressShow(id) {
    closePicker();
    if (S.view.show === id) { return; }
    changeView({ show: id, sort: S.view.sort, family: S.view.family });
  }

  // Picking the sort that is already on turns it round.
  function pressSort(key) {
    closePicker();
    var now = S.view.sort[0];
    var sort = key === null ? [] : now && now.key === key && S.view.sort.length === 1 ? [{ key: key, dir: -now.dir }] : [{ key: key, dir: C.naturalDir(key) }];
    changeView({ show: S.view.show, sort: sort, family: S.view.family });
  }

  function flipSort() {
    if (!S.view.sort.length) { return; }
    changeView({ show: S.view.show, sort: S.view.sort.map(function (s, i) { return i ? s : { key: s.key, dir: -s.dir }; }), family: S.view.family });
  }

  // A colour narrows whatever is on screen. With no sort yet it brings the rainbow, so the colours sit together.
  function pressFamily(id) {
    var same = S.view.family === id;
    changeView({ show: S.view.show, sort: !same && !S.view.sort.length ? [{ key: 'colorName', dir: 1 }] : S.view.sort, family: same ? null : id });
  }

  function headerClick(key, shift) {
    changeView({ show: S.view.show, sort: C.nextSort(S.view.sort, key, shift), family: S.view.family });
  }

  // ---------------------------------------------------------------- search

  function onSearch() {
    S.query = $('search').value;
    $('grid').scrollTop = 0;
    moveOn();
    note('');
    var t0 = performance.now();
    applyView();
    S.searchMs = performance.now() - t0;
  }

  function clearSearch() {
    $('search').value = '';
    onSearch();
    $('search').focus();
  }

  // ---------------------------------------------------------------- Show and Sort

  function closePicker() {
    $('picker').hidden = true;
    if (S.picker) { $(S.picker).setAttribute('aria-expanded', 'false'); }
    S.picker = null;
  }

  // A count while there is something to count, a quiet ellipsis while the engine is still on it, a dash once it won't come.
  // A count still climbing ends in an ellipsis too.
  function showHint(id) {
    var rows = S.store.rows;
    if (!rows.length) { return ''; }
    if (id === null) { return fmtInt(rows.length); }
    var status = C.dataStatus(rows, id, scanRunning());
    if (status === 'waiting') { return '\u2026'; }
    if (status === 'none') { return '\u2013'; }
    // A count that can still grow says so, so a 0 mid-scan never reads as an answer.
    var growing = scanRunning() && (C.SHOW[id].needs || C.SHOW[id].group) && !C.understandingShare(S.store).landed;
    return fmtInt(C.showCount(rows, id)) + (growing ? '\u2026' : '');
  }

  function sortHint(entry) {
    var rows = S.store.rows, now = S.view.sort[0];
    if (rows.length && C.TIER2_SORT[entry.key]) {
      var status = C.sortStatus(rows, entry.key, scanRunning());
      if (status === 'waiting') { return '\u2026'; }
      if (status === 'none') { return 'no data'; }
    }
    var on = now && now.key === entry.key;
    var way = entry.ways[on && now.dir !== entry.dir ? 1 : 0];
    return /^[A-Z] /.test(way) ? way : way.toLowerCase();
  }

  function pickerItem(menu, id, label, hint, on, tip, act) {
    var b = document.createElement('button'), h = document.createElement('span');
    b.dataset.id = id;
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.className = on ? 'on' : '';
    b.textContent = label;
    if (tip) { b.title = tip; }
    h.textContent = hint;
    b.appendChild(h);
    b.onclick = act;
    menu.appendChild(b);
    return b;
  }

  // The menu is rebuilt from the data each time, so its counts climb while a scan runs.
  function fillPicker(which) {
    var menu = $('picker'), focused = document.activeElement && document.activeElement.parentNode === menu ? Array.prototype.indexOf.call(menu.children, document.activeElement) : -1;
    menu.textContent = '';
    if (which === 'show') {
      pickerItem(menu, 'everything', 'Everything', showHint(null), !S.view.show, 'Every clip in the scan.', function () { pressShow(null); });
      var section = null;
      C.SHOWS.forEach(function (s) {
        if (s.section !== section) { menu.appendChild(document.createElement('hr')); section = s.section; }
        pickerItem(menu, s.id, s.label, showHint(s.id), S.view.show === s.id, s.tip, function () { pressShow(s.id); });
      });
    } else {
      var now = S.view.sort[0];
      pickerItem(menu, 'listed', 'As listed', '', !now, 'The order the clips came in, from the project or the folder.', function () { pressSort(null); });
      menu.appendChild(document.createElement('hr'));
      C.SORTS.forEach(function (e) {
        pickerItem(menu, e.key, e.label, sortHint(e), !!now && now.key === e.key, C.COLUMN[e.key].tip, function () { pressSort(e.key); });
      });
    }
    if (focused >= 0 && menu.children[focused]) { menu.children[focused].focus(); }
  }

  function openPicker(which) {
    if (S.picker === which) { closePicker(); return; }
    closePicker();
    var button = $(which), menu = $('picker');
    S.picker = which;
    fillPicker(which);
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    var rect = button.getBoundingClientRect(), box = $('app').getBoundingClientRect();
    menu.style.top = rect.bottom - box.top + 4 + 'px';
    menu.style.left = Math.max(8, Math.min(rect.left - box.left - 4, box.width - menu.offsetWidth - 8)) + 'px';
    var on = menu.querySelector('.on') || menu.querySelector('button');
    if (on) { on.focus(); }
  }

  function buildBar() {
    $('show').onclick = function (e) { e.stopPropagation(); openPicker('show'); };
    $('sort').onclick = function (e) { e.stopPropagation(); openPicker('sort'); };
    $('flip').onclick = flipSort;
    var dots = $('families');
    C.FAMILIES.forEach(function (f) {
      var b = document.createElement('button'), i = document.createElement('i');
      b.dataset.family = f.id;
      b.setAttribute('aria-label', f.word);
      i.style.background = f.dot;
      b.appendChild(i);
      b.onclick = function () { pressFamily(f.id); };
      dots.appendChild(b);
    });
  }

  // ---------------------------------------------------------------- selection

  function rowAt(el) {
    var r = el.closest('.r, .t');
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
    renderItems();
    renderFoot();
  }

  // Selected rows on screen when there are any, else the current view. Always in view order.
  function targetRows() {
    var rows = S.store.rows, out = [], any = selectedInView() > 0;
    for (var i = 0; i < S.order.length; i++) {
      var id = S.order[i];
      if (!any || S.selected.has(id)) { out.push({ row: rows[id], rank: i + 1 }); }
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
    var grew = S.order.length !== S.store.rows.length && !v.show && !v.family && !S.tokens.length;
    if (grew || ((v.sort.length || v.show || v.family || S.tokens.length) && due)) {
      applyView();
    } else {
      renderItems();
      renderView();
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

  // A write that needs Tier 2 waits for it. Asked twice: when pressed, and again after the sheet, in case the view moved.
  function heldBack(kind) {
    var f = C.footState(footFacts());
    return f.held && f.held.indexOf(kind) >= 0 ? f.wait : '';
  }

  function tier2Landed() {
    return !scanRunning() || C.understandingShare(S.store).landed;
  }

  // Shared route of the three writes: preflight, targets, confirmation, lock again, one host call, read-back, foot.
  function runWrite(spec) {
    var ready = null, waiting = heldBack(spec.kind);
    if (waiting) { note(waiting, 'warn'); return Promise.resolve(); }
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
      var scope = selectedInView() ? 'the selected clips' : 'the current view';
      var body = '<p><b>' + plural(inProject.length, 'clip') + '</b>' + (items !== inProject.length ? ' (' + plural(items, 'project item') + ')' : '') + ' in ' + esc(projectTitle(ready.project)) + ', from ' + scope + '.</p>' +
        (missing ? '<p class="warn">' + plural(missing, 'clip') + ' not in this project will be skipped.</p>' : '') + plan.html;
      return dialog(plan.title, body, plan.ok).then(function (yes) {
        if (!yes) { note('Cancelled. Nothing was written.'); return; }
        var refused = lockRefusal() || heldBack(spec.kind);
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
      kind: 'label',
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
      kind: 'columns',
      plan: function (targets) {
        // Tier 2's fields are written only once every clip has them, so no column gets a blank for a value on its way.
        var fields = C.columnFields(tier2Landed()), later = C.FIELDS.length - fields.length;
        var width = String(S.order.length).length, rows = targets.map(function (t) {
          var all = C.columnValues(t.row, t.rank, Math.max(4, width)), values = {};
          fields.forEach(function (f) { values[f.name] = all[f.name]; });
          return { ids: t.row.ids, values: values };
        });
        return {
          fn: 'columns',
          args: { fields: fields, rows: rows },
          title: 'Add columns to ' + plural(targets.length, 'clip') + '?',
          html: '<p>Adds ' + fields.length + ' columns to the project metadata: ' + fields.map(function (f) { return esc(f.label.replace(/^Select /, '')); }).join(', ') + '. Their names start with Select. Writes the values and shows the columns in the Project panel. Empty scores stay empty. Rank is the place in the current view.</p>' +
            (later ? '<p class="warn">The other ' + later + ', such as People and Colour, come from looking closer, which is still running. Add Columns again when it is done to write them.</p>' : '') +
            undoText(rows.reduce(function (n, r) { return n + r.ids.length; }, 0) * fields.length) +
            '<p class="quiet">Undo does not cover the fields or the layout: they stay in this project, and the columns stay shown, because Premiere saves them in the workspace. Hide them with Metadata Display in the Project panel menu.</p>',
          ok: 'Add Columns',
          busy: 'Adding columns'
        };
      }
    });
  }

  function doBins() {
    var name = C.viewName(S.view);
    if (!C.binKind(S.view)) { note(BINS_FIRST, 'warn'); return Promise.resolve(); }
    return runWrite({
      kind: 'bins',
      plan: function (targets) {
        var buckets = C.bucketize(targets.map(function (t) { return t.row; }), S.view);
        if (!buckets) { note('Too many different values to make bins from. Choose what to show, or another sort.', 'warn'); return null; }
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
    S.view = { show: null, sort: [], family: null };
    S.history = [];
    S.query = $('search').value = '';
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
    renderItems();
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
    return dialog('About Select', '<p>' + (version ? 'Version ' + esc(version) : 'Version unknown') + '</p><p class="quiet">' + esc(C.FORMATS_NOTE) + '</p><p class="quiet">Everything runs on this Mac: reading, looking closer, sorting and search. No network, no accounts, and the panel sends nothing.</p><p class="quiet">Every result is a suggestion. People and faces are counts, never who someone is.</p>' + timing, 'Done', null);
  }

  var MENU = { rescan: startScan, columns: showColumns, 'undo-view': undoView, undo: doUndoWrite, clear: clearResults, bug: reportBug, about: showAbout };

  function init() {
    applyHostTheme();
    buildBar();

    var saved = null, folder = null, mode = null;
    try {
      saved = localStorage.getItem('select.source');
      folder = localStorage.getItem('select.folder');
      mode = localStorage.getItem('select.mode');
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
    $('mode-list').onclick = function () { setMode('list'); };
    $('mode-grid').onclick = function () { setMode('grid'); };
    $('search').addEventListener('input', onSearch);
    $('search').addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && S.query) { e.stopPropagation(); clearSearch(); }
    });
    $('search-clear').onclick = function (e) { e.preventDefault(); clearSearch(); };
    $('empty-clear').onclick = clearSearch;
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
      if (!$('picker').hidden && !e.target.closest('#picker') && !e.target.closest('.pick')) { closePicker(); }
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
    $('grid').addEventListener('mousedown', function (e) {
      var at = rowAt(e.target);
      if (at >= 0) { clickRow(at, e); }
    });
    $('grid').addEventListener('dblclick', function (e) {
      var at = rowAt(e.target);
      if (at >= 0) { openRow(S.store.rows[S.order[at]]); }
    });
    $('grid').addEventListener('scroll', scheduleRows, { passive: true });
    new ResizeObserver(function () {
      if (poolSize() !== S.pool.length) { buildPool(); renderSortColumn(); }
      buildLayout();
      S.paintKey++;
      renderItems();
    }).observe($('grid'));

    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); $('search').focus(); $('search').select(); return; }
      if (e.key === 'Escape' && S.picker) { var from = S.picker; closePicker(); $(from).focus(); return; }
      if (S.picker && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        var inMenu = Array.prototype.slice.call($('picker').querySelectorAll('button')), now = inMenu.indexOf(document.activeElement);
        inMenu[(now + (e.key === 'ArrowDown' ? 1 : -1) + inMenu.length) % inMenu.length].focus();
        return;
      }
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
    if (mode === 'grid') { setMode('grid'); }
    ensureHost().then(refreshProject);
  }

  // For the tests and for the integration pass, through the DevTools port.
  window.SelectApp = {
    state: S,
    startScan: startScan,
    stopScan: stopScan,
    applyView: applyView,
    setMode: setMode,
    extensionRoot: extensionRoot,
    foot: function () { return C.footState(footFacts()); }
  };

  init();
})();
