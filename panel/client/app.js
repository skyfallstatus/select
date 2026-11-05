// Select panel: DOM, table, scan flow and the explicit project writes. Logic lives in core.js.
(function () {
  'use strict';
  var C = window.SelectCore, N = window.SelectNative;
  var ROW_H = 40, OVERSCAN = 6, FLUSH_MS = 66, RESORT_EVERY_MS = 200, IMPORT_BIN = 'SELECT IMPORTS';
  var ISSUES_URL = 'https://github.com/skyfallstatus/select/issues/new';
  var THEME_EVENT = 'com.adobe.csxs.events.ThemeColorChanged';
  // The grid: tiles about 165 px wide filling the row (core.gridLayout), 16:9 pictures, one line under each.
  var TILE_GAP = C.TILE.gap, TILE_ROW_GAP = 16, TILE_CAPTION = 20, TILE_TOP = 12, HEAD_H = 24;
  // The panel's one margin, left and right, which the toolbar, the band, the bar and the list keep too (--side). The
  // scrollbar (11 px, style.css), always there in both views, sits inside the right one, so the last tile and the
  // list's last column end where the last pill does.
  var SIDE = 14, SCROLLBAR = 11, TILE_RIGHT = SIDE - SCROLLBAR;

  var REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (id) { return document.getElementById(id); };
  var plural = C.plural, fmtInt = C.fmtInt;
  var S = {
    store: C.createStore(),
    view: { show: null, sort: [], families: [] },
    history: [],
    order: [],
    hasGroups: false,
    groupCount: 0,
    breaks: [],          // where each group starts in `order`
    mode: 'list',        // list or grid: the same rows, sort, filter, selection and writes
    query: '',
    tokens: [],
    searchMs: null,
    L: { cols: 1, pitch: ROW_H, top: 0, ys: null, xs: null, heads: [], height: 0, tileW: 0, picH: 0, fit: null },
    tiles: [],
    heads: [],
    paintKey: 0,
    selected: new Set(),
    anchor: null,
    project: null,
    connected: false,
    listing: false,
    listed: 0,           // video files found so far while listing a folder
    listWalk: null,      // the folder walk while it runs, for Stop
    busy: null,          // what a write in progress is doing, in words. Read by the updater too: no update mid-write
    write: null,         // {kind: write or undo, verb, unit, done, total, stopping} while a write or an Undo runs
    hostLate: 0,         // host calls that passed their deadline and have not answered yet
    hostLog: [],         // the last host calls: {fn, ms inside Premiere, wall ms here, ok, code}, newest last
    undo: null,          // {path, count, top}: the Undo records of the project in front, read from disk
    memoryUndo: null,    // a record that could not be saved, so Undo still reaches it until the panel reloads
    activeRecord: null,  // the id of the record a running write is filling, never cleared as empty on the way
    scan: null,          // {handle, startedAt, endedAt, stopping, state, source, failure}
    outcome: null,       // the last write's result, in the foot until the view moves on (a plain success goes by itself)
    sortMs: null,
    sortRows: 0,
    columns: [],
    shownColumns: {},    // key -> true or false, the switches in the Columns sheet
    // Column drag, hover scrub and search suggestions.
    columnOrder: [],     // the movable columns' keys in the editor's order, kept as select.columnOrder
    drag: null,          // the column header pressed, then dragged: {key, cell, x0, y0, on, x, after}
    scrub: null,         // the picture the pointer rests on, then slides through: {slot, row, x, y, timer, asked, strip}
    strips: new Map(),   // clip path -> its strip ({file, frames, ready, url}) or {error}, for the session
    suggest: null,       // the open suggestions: {list, hot}
    labelColor: C.DEFAULT_LABEL,
    pool: [],
    lastComputed: 0,
    modalOpen: false,
    // Package A: the scan target, the project the results belong to, last results, the right-click menu.
    target: null,        // what Scan would read now: the host's last `target` answer
    targetKey: null,     // the project path and selection signature that answer was for
    others: 0,           // clips the target holds that the results don't: a grey Scan offers them
    whole: null,         // {path, n}: the whole project's clip count, from the last answer that read it
    calling: 0,          // host calls under way
    from: null,          // {project: {path, name} or null for a folder, words: where the scan came from, target}
    restoring: false,    // last results coming back from the cache
    lastAt: null,        // when the last results on screen were scanned, until the view changes or a scan
    scannedAt: null,     // when the results on screen were scanned, kept in their record
    ctx: null,           // the open right-click menu: {el, sub, rows, ids}
    sheetChoice: null,   // what a choice pressed in the open sheet does (Other, in the bins sheet)
    watchSig: undefined, // the Project panel selection's signature in the last watch, and with the project, its key
    watchKey: undefined,
    polls: 0,            // watch polls this session, and the items they handed Premiere's script engine (their counts)
    pollItems: 0,
    notice: null,        // the note in the band: {text, kind}, until the editor moves on
    // The panel changing size.
    sized: { w: -1, h: -1 },   // the grid's size the layout was made for
    tileW: 0,            // the tiles' size now in --tw and --ph
    picH: 0,
    keep: null,          // the clip kept at the top while the size changes: {at, rowId, off, pitch, top, order, mode}
    tileStore: null      // the results the tiles' clips belong to
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

  // How long the panel waits for one host call, in ms. A batch of 100 is the longest; listing a big project comes close,
  // and so does a sequence of 2,000 clips.
  var TIMEOUT = { status: 20000, watch: 20000, target: 300000, collect: 300000, find: 300000, sequence: 300000, reveal: 120000, other: 120000, load: 20000 };
  // Not a host call: how long last results may take to come back from the cache.
  TIMEOUT.lastResults = 20000;
  // Not a host call either: how long a write that worked stays in the status before the view's words come back.
  TIMEOUT.settle = 6000;
  var HOST_PROTOCOL = 3;
  var HOST_LOG = 100;
  var LATE = 'Waiting for Premiere\'s last answer.';

  function waitWords(ms) {
    return ms >= 60000 ? plural(Math.round(ms / 60000), 'minute') : plural(Math.round(ms / 1000), 'second');
  }

  function parseHost(text) {
    try {
      var res = JSON.parse(text);
      if (res && typeof res === 'object') { return res; }
    } catch (e) {}
    return { ok: false, code: 'host-error', message: 'Premiere answered: ' + String(text).slice(0, 200) };
  }

  // Every call has a deadline, so the panel never waits on Premiere for ever. An answer that comes after it still
  // counts: `late` gets it, so a batch that landed late still goes into its Undo record.
  function hostOnce(fn, args, late) {
    var ms = TIMEOUT[fn] || TIMEOUT.other, t0 = performance.now();
    S.calling++;
    return new Promise(function (resolve) {
      var over = false, timer = setTimeout(function () {
        over = true;
        S.hostLate++;
        S.calling = Math.max(0, S.calling - 1);
        logHost(fn, { ok: false, code: 'timeout' }, t0);
        resolve({ ok: false, code: 'timeout', message: 'Premiere didn\'t answer within ' + waitWords(ms) + '.' });
      }, ms);
      rawEval(C.hostCall(fn, args)).then(function (text) {
        var res = parseHost(text);
        logHost(fn, res, t0);
        if (!over) { clearTimeout(timer); S.calling = Math.max(0, S.calling - 1); resolve(res); watchWaiting(); return; }
        S.hostLate = Math.max(0, S.hostLate - 1);
        if (late) { late(res); }
        renderFoot();
        watchWaiting();
      });
    });
  }

  // The time each call took inside Premiere (`ms`, from the host) and here, for the DevTools port and the tests.
  function logHost(fn, res, t0) {
    S.hostLog.push({ fn: fn, ms: typeof res.ms === 'number' ? res.ms : null, wall: Math.round(performance.now() - t0), ok: !!res.ok, code: res.ok ? null : res.code || null });
    if (S.hostLog.length > HOST_LOG) { S.hostLog.splice(0, S.hostLog.length - HOST_LOG); }
  }

  // Calls wait until the host in Premiere is this page's own (ensureHost), so a page reloaded after an update never
  // calls a function only the new host has. A host that still doesn't know the call is loaded again from disk once, and
  // the call sent again: an unknown call changed nothing.
  var hostReady = null;
  function host(fn, args, late) {
    if (!window.__adobe_cep__) {
      return Promise.resolve({ ok: false, code: 'no-host', message: 'Premiere is not connected.' });
    }
    return (hostReady || Promise.resolve()).then(function () { return hostOnce(fn, args, late); }).then(function (res) {
      if (res.code !== 'unknown-call') { return res; }
      return ensureHost(true).then(function () { return hostOnce(fn, args, late); });
    });
  }

  // rawEval with a deadline: undefined when Premiere does not answer in time.
  function rawEvalWithin(script, ms) {
    return Promise.race([rawEval(script), new Promise(function (resolve) { setTimeout(resolve, ms); })]);
  }

  // ScriptPath loads the host with the panel. Load it by hand if it did not, or if another one is loaded: Premiere keeps
  // the host of the version before an update until it restarts, and every panel shares one script engine. force: load
  // it whatever is there.
  function ensureHost(force) {
    return rawEvalWithin('typeof SELECT_HOST_PROTOCOL === "number" ? String(SELECT_HOST_PROTOCOL) : typeof slCall', TIMEOUT.load).then(function (t) {
      if (t === null || t === undefined || (t === String(HOST_PROTOCOL) && !force)) { return; }
      return rawEvalWithin('$.evalFile(' + JSON.stringify(extensionRoot() + '/host/select.jsx') + ')', TIMEOUT.load);
    });
  }

  function refreshProject() {
    return host('status').then(function (r) {
      setProject(r.ok ? r.project : null);
      S.connected = r.code !== 'no-host';
      renderHeader();
      renderFoot();
      return r;
    });
  }

  // ---------------------------------------------------------------- the scan target, live

  // What Scan would read, kept up to date without asking Premiere for much. Every project item Premiere hands a script
  // stays in its script engine and slows every later call, so `watch` (the project and a signature of the Project panel
  // selection, one item per clip selected) runs when the editor comes to the panel: the pointer entering it, focus, the
  // panel showing again, after Select's own writes, imports and scans, and once at load; and, a few times only, once
  // the pointer has left (the watch poll, below). At most once a second, never while a scan, a write or another host
  // call runs (one waits for after). `target`, which reads the clips, runs only when the project or the selection
  // changed.
  var WATCH_GAP = 1000, watchAt = 0, watchWants = false, watchLater = null, pollAsked = false;
  // The clock the watch and its poll keep time by; the tests put their own in its place.
  var TIME = {
    now: function () { return Date.now(); },
    setTimeout: function (fn, ms) { return setTimeout(fn, ms); },
    clearTimeout: function (id) { clearTimeout(id); }
  };

  function watchBlocked() {
    return !!(scanRunning() || S.listing || S.restoring || S.busy || S.hostLate || S.calling);
  }

  function askWatch() {
    if (!window.__adobe_cep__) { return; }
    watchWants = true;
    if (watchBlocked() || watchLater) { return; }
    var wait = WATCH_GAP - (TIME.now() - watchAt);
    if (wait > 0) {
      watchLater = TIME.setTimeout(function () { watchLater = null; if (watchWants) { askWatch(); } }, wait);
      return;
    }
    watchWants = false;
    watchAt = TIME.now();
    // A poll asked for this one: what it hands out is counted, and a new selection starts the poll's times again.
    var byPoll = pollAsked;
    pollAsked = false;
    host('watch').then(function (res) {
      var before = S.watchKey, now = res.ok ? keyOf(res.project, res.sig) : before;
      if (byPoll && res.ok) { var n = C.sigCount(res.sig); S.pollItems += n; poll.items.push([TIME.now(), n]); }
      onWatch(res);
      if (byPoll && before !== undefined && now !== before && poll.out) { pollBegin(); }
    });
  }

  // A watch asked for while something else talked to Premiere goes once that ends.
  function watchWaiting() {
    if (watchWants && !watchLater && !watchBlocked()) { setTimeout(function () { if (watchWants) { askWatch(); } }, 0); }
  }

  // ---- the watch poll. Once the pointer has left Select, the band follows the Project panel selection without the
  // pointer coming back: `watch` runs at 1, 2, 4, 6, 10, 18, 33, 48, 63, 78 and 93 s after it left (core.nextPoll), then not
  // again until the pointer has come back and left again. A poll that sees the selection change starts the times again
  // from that moment; a selection of more than 3 items is looked at no more than every 10 s; and there are at most 300
  // polls in any hour. Only while Premiere is the app in front (when CEP says so), the panel shows, a project is open
  // and nothing else talks to Premiere. A poll is askWatch, so target still runs only when something changed.
  var poll = { out: false, active: true, start: 0, at: 0, next: 0, timer: null, stamps: [], items: [] };

  function pollCan() {
    return poll.out && poll.active && !document.hidden && !!S.project;
  }

  function pollStop() {
    if (poll.timer !== null) { TIME.clearTimeout(poll.timer); poll.timer = null; }
  }

  // The times start again from now.
  function pollBegin() {
    poll.start = TIME.now();
    poll.at = 0;
    pollArm();
  }

  function pollArm() {
    pollStop();
    if (!pollCan()) { return; }
    var next = C.nextPoll(poll.at, C.sigCount(S.watchSig));
    if (next === null) { return; }
    poll.next = next;
    poll.timer = TIME.setTimeout(pollTick, Math.max(0, poll.start + next * 1000 - TIME.now()));
  }

  // A poll that falls while something else talks to Premiere, or past the hour's 300, is let go; the times go on.
  function pollTick() {
    poll.timer = null;
    if (!pollCan()) { return; }
    poll.at = poll.next;
    var now = TIME.now();
    if (!watchBlocked() && C.pollRoom(poll.stamps, now) && C.pollItemRoom(poll.items, now)) {
      poll.stamps.push(now);
      S.polls++;
      pollAsked = true;
      askWatch();
    }
    pollArm();
  }

  // The pointer leaving starts it, coming back stops it (the hover path takes over); Premiere going to the back or the
  // panel hiding stops it, and coming back to the front or showing again, with the pointer still away, starts it again.
  function wirePoll() {
    var root = document.documentElement;
    root.addEventListener('mouseleave', function () { poll.out = true; pollBegin(); });
    root.addEventListener('mouseenter', function (e) { poll.out = false; pollStop(); back.until = TIME.now() + BACK_FOR; back.y = e.clientY; });
    root.addEventListener('mousemove', function (e) { back.y = e.clientY; if (poll.out) { poll.out = false; pollStop(); } }, { passive: true });
    document.addEventListener('visibilitychange', function () { if (document.hidden) { pollStop(); } else if (poll.out) { pollBegin(); } });
    var cep = window.__adobe_cep__;
    if (cep && cep.addEventListener) {
      cep.addEventListener('com.adobe.csxs.events.ApplicationActivate', function () { poll.active = true; if (poll.out) { pollBegin(); } });
      cep.addEventListener('com.adobe.csxs.events.ApplicationDeactivate', function () { poll.active = false; pollStop(); });
    }
  }

  function keyOf(project, sig) {
    return (project ? project.path : '') + '|' + (sig || '');
  }

  // A failed call keeps the last words.
  function onWatch(res) {
    if (!res.ok) {
      if (res.code === 'no-host') { S.connected = false; renderFoot(); }
      return;
    }
    S.connected = true;
    S.watchSig = res.sig || '';
    S.watchKey = keyOf(res.project, res.sig);
    setProject(res.project || null);
    restoreLast();
    var asked = keyOf(S.project, res.sig) !== S.targetKey ? askTarget() : null;
    if (!asked) { renderFoot(); }
    Promise.resolve(asked).then(function () { watched = true; runPending(); });
  }

  function askTarget() {
    if (!S.project) {
      S.target = null;
      S.targetKey = keyOf(null, '');
      refreshOthers();
      renderFoot();
      return Promise.resolve(null);
    }
    return host('target', { exts: C.VIDEO_EXTS }).then(function (t) {
      if (t.ok) { setTarget(t); } else if (t.code === 'no-project') { S.project = null; S.target = null; renderFoot(); }
      return t;
    });
  }

  function setTarget(t) {
    S.target = t;
    S.targetKey = keyOf(t.project, t.sig);
    if (t.kind === 'project') { S.whole = { path: t.project.path, n: C.targetCount(t) }; }
    refreshOthers();
    renderFoot();
  }

  // After a scan, the clips the band offers to Scan (core.scanOthers): a Project panel selection's clips the results
  // don't hold, or, when the results are this whole project, the clips imported since. Worked out when either changes.
  function refreshOthers() {
    S.others = S.store.rows.length && !scanRunning() && !S.restoring ? C.scanOthers(S.target, S.store, S.from, S.project) : 0;
  }

  // The project in front, from any answer that says it. An open menu says the new name at once.
  function setProject(project) {
    var before = S.project ? S.project.path : null;
    S.project = project;
    if ((project ? project.path : null) !== before) {
      renderHeader();
      if (!$('menu').hidden) { openMenu(); }
    }
  }

  // ---------------------------------------------------------------- header

  function projectTitle(project) {
    return project.name.replace(/\.prproj$/i, '');
  }

  // The project's name is Premiere's to show. Here it heads the ··· menu, and the status's tooltip says it.
  function renderHeader() {
    var name = S.project ? projectTitle(S.project) : (S.connected ? 'No project open' : 'Not connected to Premiere');
    var rows = S.store.rows.length;
    $('project-name').textContent = name;
    $('search').placeholder = rows ? 'Search ' + plural(rows, 'clip') : 'Search';
  }

  // ---------------------------------------------------------------- notes and the foot

  // A note (a refusal, a failure, a fact) takes the band's one row by its rank (core.bandShow). #status-note holds it.
  // It is one line, so it ends as a verdict does, with no full stop.
  function note(text, kind) {
    var el = $('status-note');
    text = text ? String(text).replace(/([^.])\.$/, '$1') : '';
    S.notice = text ? { text: text, kind: kind || '' } : null;
    el.textContent = text || '';
    el.className = kind || '';
    if (text) { tuck(false); }
    renderFoot();
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

  // The project the results belong to, when another one is in front: its title. A folder's results belong to none.
  function foreignTitle() {
    var from = S.from && S.from.project;
    if (!from || !S.store.rows.length || (S.project && samePath(from.path, S.project.path))) { return ''; }
    return projectTitle(from);
  }

  function footFacts() {
    var sc = S.scan;
    return {
      project: S.project,
      connected: S.connected,
      title: S.project ? projectTitle(S.project) : '',
      target: S.target,
      others: S.others,
      foreign: foreignTitle(),
      restoring: S.restoring,
      notRead: S.store.notRead,
      lastAt: S.lastAt,
      listing: S.listing,
      listed: S.listed,
      listStop: !!S.listWalk,
      busy: S.busy,
      write: S.write,
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
      status: C.dataStatus(S.store.rows, S.view.show, scanRunning()),
      skipped: sc && sc.skipped || 0,
      bad: S.store.bad
    };
  }

  // The band's buttons, and the bar's. Each write keeps its place in the bar and is off, with its reason, when it can't run.
  var ACTIONS = { scan: 'scan', stop: 'stop', undo: 'undo-write', details: 'foot-details' };
  var WRITES = { sequence: { id: 'do-sequence', tip: 'Selected clips, or every clip shown, in this order' }, bins: { id: 'do-bins', tip: 'New bins from this view' } };

  // A new sentence fades in. A running count, in either stage of a scan, changes in place, and reduced motion means no fade at all.
  function setFootWords(id, text, kind) {
    var el = $(id);
    if (el.textContent === text) { return; }
    el.textContent = text;
    if (kind !== 'scanning' && kind !== 'understanding' && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 50, easing: 'ease-out', fill: 'backwards' });
    }
  }

  // The band's icon, from the set, in the colour of its tone. Drawn again only when it changes.
  function setMark(icon, tone) {
    var m = $('foot-mark');
    if (m.dataset.kind !== icon || !m.firstChild) { m.dataset.kind = icon; m.innerHTML = C.iconSvg(icon); }
    if ((m.dataset.tone || '') !== tone) { m.dataset.tone = tone; }
  }

  // Everything the band and the bar show comes from core (footState, bandRow, barState), so this only puts it on the page.
  var lastFoot = null, lastBand = null;
  function renderFoot() {
    var x = footFacts(), f = C.footState(x), row = C.bandShow(C.bandRow(f, x), S.notice), bar = C.barState(f, x), foot = $('foot');
    lastFoot = f;
    lastBand = row;
    foot.className = f.kind + (f.green ? ' green' : '') + (S.tucked ? ' tucked' : '');
    renderTable();
    // A count that ticks while a scan or a write runs isn't read aloud; what it ends on is.
    foot.setAttribute('aria-live', /^(scanning|understanding|listing|writing|restoring)$/.test(f.kind) ? 'off' : 'polite');
    // No row: no words left behind it either.
    $('foot-top').hidden = !row;
    if (row) { setMark(row.icon, row.tone); }
    setFootWords('foot-verdict', row ? row.verdict : '', f.kind);
    setFootWords('foot-sentence', row ? row.sentence : '', f.kind);
    Object.keys(ACTIONS).forEach(function (a) {
      var b = $(ACTIONS[a]), on = !!row && row.actions.indexOf(a) >= 0;
      b.hidden = !on;
      b.className = 'action' + (row && row.primary === a ? ' primary' : '');
    });
    $('scan').title = f.scanTip || '';
    var u = undoState();
    $('undo-write').title = u.top ? C.undoWords(u.top) : '';
    renderBar(bar);
    fitFoot();
    settleLater();
    if (S.ctx) { ctxStillShown(); }
    S.calm = (f.kind === 'finished' || f.kind === 'stopped') && !S.outcome && !S.busy;
    if (!S.calm) { tuck(false); }
    fitBand();
    renderHeader();
  }

  // The bar: there once there are results, its writes in their places, the one blue on Sort into Bins while it can act.
  function renderBar(bar) {
    $('bottom').hidden = !bar.shown;
    if (!bar.shown) { return; }
    var count = $('count');
    if (count.textContent !== bar.count) { count.textContent = bar.count; }
    count.title = bar.countTip;
    Object.keys(WRITES).forEach(function (w) {
      var b = $(WRITES[w].id), why = bar[w];
      b.disabled = !!why || bar.empty;
      b.title = why || WRITES[w].tip;
      b.className = 'action' + (bar.primary === w ? ' primary' : '');
    });
  }

  // One line: the sentence gives way first and goes when under 48 px, then the verdict ellipsizes. Whatever is cut, the
  // tooltip says whole, with the facts the band keeps out of the line (the project).
  function fitFoot() {
    var row = lastBand, words = $('foot-words'), verdict = $('foot-verdict'), sentence = $('foot-sentence');
    if (!row) { words.title = ''; return; }
    sentence.hidden = false;
    // Only a sentence squeezed: a short one that fits whole stays.
    if (row.sentence && sentence.scrollWidth > sentence.clientWidth + 1 && sentence.getBoundingClientRect().width < 48) { sentence.hidden = true; }
    // Under 400 px Details goes before the verdict is cut: the sheet after Undo and the tooltip still hold the list.
    var details = $('foot-details');
    if (row.actions.indexOf('details') >= 0) {
      details.hidden = false;
      if (innerWidth < 400 && verdict.scrollWidth > verdict.clientWidth + 1) { details.hidden = true; }
    }
    var whole = row.verdict + (row.sentence ? ' \u00b7 ' + row.sentence : '');
    var cut = sentence.hidden || verdict.scrollWidth > verdict.clientWidth + 1 || sentence.scrollWidth > sentence.clientWidth + 1;
    words.title = row.tip ? (cut ? whole + '\n' : '') + row.tip : whole;
  }

  // The band opens only with something to say and closes once it has said it: its height and opacity over 150 ms, none
  // with reduced motion. One row at a time: the status row, else update.js's update line, which waits hidden behind
  // it. While the clips scroll a calm band tucks away. The grid under it keeps its top clip (onGridResize), so nothing
  // jumps.
  // The pointer coming back in: a new selection's row that would open the band then waits 300 ms, so a click aimed at
  // a tile lands before the tiles move; not when the pointer is already in the toolbar's or the band's height.
  var BACK_WAIT = 300, BACK_FOR = 1500, TOP_ZONE = 76, back = { until: 0, y: 0, timer: null };
  function fitBand() {
    var band = $('foot'), which = !$('foot-top').hidden ? 'status' : !$('update-line').hidden ? 'update' : '';
    if ((band.dataset.row || '') !== which) { band.dataset.row = which; }
    var open = !!which && !S.tucked;
    if (open && band.dataset.open !== 'true' && which === 'status' && lastBand && lastBand.rank === 4 && !lastBand.note && S.store.rows.length &&
        TIME.now() < back.until && back.y >= TOP_ZONE) {
      if (back.timer === null) { back.timer = TIME.setTimeout(function () { back.timer = null; back.until = 0; fitBand(); }, BACK_WAIT); }
      open = false;
    }
    var h = open ? $('band-in').offsetHeight : 0;
    if (band.style.height !== h + 'px') { band.style.height = h + 'px'; }
    if (band.dataset.open !== String(open)) { band.dataset.open = String(open); }
  }

  // ---------------------------------------------------------------- a write that worked goes by itself

  // A plain success (a write proved, an Undo that left nothing alone) closes the band TIMEOUT.settle ms after the
  // editor has left Select, and Undo stays in the ··· menu. While the pointer is anywhere in the panel, or the panel has
  // focus, the wait doesn't run, so the clips never move under the editor and Undo never goes from under the cursor;
  // it is gone when he comes back from the Timeline. The next scan, write, sort, Show, colour or search closes it at
  // once (moveOn). Anything to read, such as a sentence after a green verdict, stays until the editor moves on. The
  // page only: no host call.
  var settle = { outcome: null, timer: null };
  function settleLater() {
    var o = S.outcome;
    if (!o || S.busy || !(o.green || o.kind === 'undone') || o.sentence) { clearTimeout(settle.timer); settle.timer = null; settle.outcome = null; return; }
    if (settle.outcome === o) { return; }
    settle.outcome = o;
    settleStart();
  }
  function settleStart() {
    clearTimeout(settle.timer);
    settle.timer = settle.outcome && settle.outcome === S.outcome && !footHeld() ? setTimeout(settleNow, TIMEOUT.settle) : null;
  }
  function settleNow() {
    settle.timer = null;
    if (!settle.outcome || settle.outcome !== S.outcome || footHeld()) { return; }
    // Never behind a sheet: it waits for the sheet to close.
    if (S.modalOpen) { settleStart(); return; }
    moveOn();
    renderFoot();
  }
  var inPanel = { pointer: false, focus: document.hasFocus() };
  function footHeld() {
    return inPanel.pointer || inPanel.focus;
  }

  // ---------------------------------------------------------------- the status tucks away while the clips scroll

  var lastTop = 0, tuckedAt = 0, tuckLater = null, deepest = 0, heldFrom = 0;
  function tuck(on) {
    if (!!S.tucked === on) { return; }
    S.tucked = on;
    $('foot').classList.toggle('tucked', on);
    tuckedAt = performance.now();
    deepest = $('grid').scrollTop;
    fitBand();
  }

  // Down through the clips tucks a calm status away; any way up brings it back. Nothing tucks while a scan or a write
  // has something to say, and a short list never tucks, so the grid's own resize can't bounce it.
  function onScrollTuck() {
    var grid = $('grid'), top = grid.scrollTop, delta = top - lastTop, since = performance.now() - tuckedAt;
    // The grid keeping its place while the panel changes size: not the editor scrolling.
    if (keptScroll()) { lastTop = top; deepest = top; return; }
    lastTop = top;
    // Too soon after the last change, which also lets the grid's own resize settle. A quick flick back to the top
    // would leave the status away with no scroll left to bring it back, so the top is looked at again after the wait.
    if (since < 320) {
      if (tuckLater === null) { heldFrom = top - delta; }
      clearTimeout(tuckLater);
      tuckLater = setTimeout(function () {
        var g = $('grid'), now = g.scrollTop, long = g.scrollHeight - g.clientHeight > 240;
        tuckLater = null;
        if (now < 8) { tuck(false); } else if (!S.tucked && S.calm && now - heldFrom > 48 && now > 48 && long) { tuck(true); }
      }, 320 - since);
      return;
    }
    // Up by a flick or by many small steps, both count: the way back is measured from the deepest point reached. At the
    // end of the list the grid growing pulls the scroll back on its own, which is not the editor going up.
    var atEnd = top >= grid.scrollHeight - grid.clientHeight - 2;
    if (S.tucked) { deepest = atEnd ? top : Math.max(deepest, top); }
    if (top < 8 || (!atEnd && (delta < -6 || (S.tucked && deepest - top > 24)))) { tuck(false); return; }
    if (S.calm && delta > 4 && top > 48 && grid.scrollHeight - grid.clientHeight > 240) { tuck(true); }
  }

  // The bar says the view in words: what is shown, how it is sorted, and which colour, if any.
  function renderView() {
    var v = S.view, show = v.show ? C.SHOW[v.show] : null, sort = v.sort[0] || null;
    setPick('show', show ? show.label : 'Everything', !!show);
    setPick('sort', sort ? C.sortWords(sort) : 'As listed', !!sort);
    $('flip').hidden = !sort;
    $('flip').title = sort ? 'Reverse to ' + C.sortWords({ key: sort.key, dir: -sort.dir }) : '';
    var counts = C.familyCounts(S.store.rows), colours = C.viewFamilies(v);
    Array.prototype.forEach.call(document.querySelectorAll('#families button'), function (b) {
      var f = C.FAMILY[b.dataset.family], n = counts[f.id] || 0;
      b.classList.toggle('on', colours.indexOf(f.id) >= 0);
      b.classList.toggle('empty', !n);
      b.title = n ? f.word + ': ' + plural(n, 'clip') : f.word + ': none yet';
    });
    $('families').classList.toggle('chosen', colours.length > 0);
    $('families').classList.toggle('several', colours.length > 1);
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
    if (S.query) { $('search-box').classList.add('open'); $('toolbar').classList.add('searching'); }
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

  // A switched-off column still shows while the view sorts by it, so a sort never hides its own reason. In the order the
  // editor dragged them to, but under 400 px the column the view sorts by comes right after Name, so it reads in the
  // first screen.
  var NARROW_LIST = 400;
  function visibleColumns() {
    var sorting = {}, first = S.view.sort.length ? S.view.sort[0].key : null;
    S.view.sort.forEach(function (s) { sorting[s.key] = true; });
    var list = C.orderColumns(C.COLUMNS, S.columnOrder).filter(function (c) {
      return !c.onlyWithGroups && (columnOn(c) || sorting[c.key]);     // groups head their own rows, so they need no column
    });
    S.narrowList = innerWidth < NARROW_LIST;
    if (S.narrowList && first && first !== 'name') {
      var at = list.map(function (c) { return c.key; }).indexOf(first), name = list.map(function (c) { return c.key; }).indexOf('name');
      if (at > name + 1 && name >= 0) { list.splice(name + 1, 0, list.splice(at, 1)[0]); }
    }
    return list;
  }

  function totalWidth() {
    return S.columns.reduce(function (a, c, i) { return a + c.width + (airy(i) ? AIR : 0); }, 0) + TILE_RIGHT;
  }

  // Words right after a right-aligned figure get more air, whatever order the columns were dragged into.
  var AIR = 10;
  function airy(i) {
    return i > 0 && S.columns[i - 1].kind === 'number' && S.columns[i].kind !== 'number';
  }

  function placeCell(el, col, i) {
    el.style.width = col.width + (airy(i) ? AIR : 0) + (i === S.columns.length - 1 ? TILE_RIGHT : 0) + 'px';
    if (col.grow) { el.classList.add('grow'); }
    if (airy(i)) { el.classList.add('air'); }
  }

  function buildHead() {
    var head = $('head');
    if (S.drag) { endDrag(false); }
    head.textContent = '';
    head.style.minWidth = totalWidth() + 'px';
    S.columns.forEach(function (c, i) {
      var h = document.createElement('div');
      h.className = 'h' + (c.kind === 'number' ? ' num' : '') + (c.sortable === false ? '' : ' sortable');
      placeCell(h, c, i);
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
    while (S.pool.length) { S.pool.pop().el.remove(); }
    addSlots(poolSize());
  }

  // The panel changing height: rows are added or taken off the end, and the others keep what they show.
  function fitPool() {
    var need = poolSize();
    while (S.pool.length > need) { S.pool.pop().el.remove(); }
    if (S.pool.length < need) { addSlots(need - S.pool.length); }
  }

  function addSlots(count) {
    var body = $('body'), moving = S.drag && S.drag.on ? S.columns.map(function (c) { return c.key; }).indexOf(S.drag.key) : -1;
    for (var p = 0; p < count; p++) {
      var el = document.createElement('div');
      el.className = 'r';
      var cells = [], thumb = null, nameText = null, why = null;
      for (var i = 0; i < S.columns.length; i++) {
        var col = S.columns[i], cell = document.createElement('div');
        cell.className = 'c c-' + col.key + (col.kind === 'number' ? ' num' : '') + (col.kind === 'color' ? ' pal' : '') + (col.kind === 'date' || (col.kind === 'text' && col.key !== 'name') ? ' quiet' : '');
        placeCell(cell, col, i);
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
        if (i === moving) { cell.classList.add('moving'); }
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
        slot.cells[i].title = [row.path, row.reason || row.lookReason, row.colorNote].filter(Boolean).join('\n');
        continue;
      }
      var cell = slot.cells[i], text = C.cellText(row, col);
      if (col.kind === 'color') {
        paintPalette(cell.children, row);
        cell.title = text;
        continue;
      }
      if (cell.textContent !== text) { cell.textContent = text; }
      if (col.kind === 'date') { cell.title = C.dateNote(row); }
    }
    setThumb(slot, slot.thumb, row);
  }

  // Where everything sits, for both views. Plain views are arithmetic; a view with groups measures once per change.
  // w, h: the grid's size when the caller has just read it.
  function buildLayout(w, h) {
    var L = S.L, grid = S.mode === 'grid', n = S.order.length;
    if (grid) {
      var room = Math.max(w === undefined ? $('grid').clientWidth : w, 200) - SIDE - TILE_RIGHT, high = h === undefined ? $('grid').clientHeight : h;
      var fit = C.gridLayout(room);
      L.cols = fit.cols;
      L.tileW = fit.tileW;
      L.picH = fit.picH;
      L.fit = fit;
      L.pitch = L.picH + TILE_CAPTION + TILE_ROW_GAP;
      L.top = TILE_TOP;
      // Tiles for every row in view and three more; a ring of them, sized together by two variables. It also holds what
      // one more column would show, so a panel made wider finds those pictures loaded.
      var wider = Math.round(Math.floor((room - L.cols * TILE_GAP) / (L.cols + 1)) * 9 / 16) + TILE_CAPTION + TILE_ROW_GAP;
      L.ring = Math.max(L.cols * (Math.ceil(high / L.pitch) + 3), L.cols + (L.cols + 1) * (Math.ceil(high / wider) + 2));
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
      var y = 0, col = 0, shelf = 0, colX = function (c) { return grid ? C.gridColumnX(L.fit, c) : 0; };
      S.breaks.forEach(function (b) {
        if (!grid || col + b.count > L.cols) {
          y += shelf;
          col = 0;
          shelf = 0;
        }
        var rows = Math.ceil(b.count / L.cols), span = Math.min(b.count, L.cols);
        L.heads.push({ y: y, x: colX(col), width: colX(col + span - 1) + L.tileW - colX(col), text: 'Group ' + b.number + ' · ' + plural(b.count, 'clip') });
        for (var k = 0; k < b.count; k++) {
          L.ys[b.at + k] = y + HEAD_H + Math.floor(k / L.cols) * L.pitch;
          L.xs[b.at + k] = colX(col + k % L.cols);
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
    if (grid) { sizeTiles(); }
    buildHeads(box, h);
  }

  function yOf(at) {
    var L = S.L;
    return L.ys ? L.ys[at] : L.top + Math.floor(at / L.cols) * L.pitch;
  }

  function xOf(at) {
    var L = S.L;
    return L.xs ? L.xs[at] : C.gridColumnX(L.fit, at % L.cols);
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

  function buildHeads(box, height) {
    var need = S.L.heads.length ? Math.ceil((height === undefined ? $('grid').clientHeight : height) / HEAD_H) + 2 : 0;
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
        el.style.left = SIDE + heads[i].x + 'px';
        el.style.width = heads[i].width + 'px';
      } else {
        el.style.left = el.style.width = '';
      }
      if (el.textContent !== heads[i].text) { el.textContent = heads[i].text; }
      el.hidden = false;
    }
    for (; used < S.heads.length; used++) { S.heads[used].hidden = true; }
  }

  // top: as renderTiles.
  function renderRows(top) {
    var grid = $('grid'), rows = S.store.rows, order = S.order;
    if (top === undefined) { top = grid.scrollTop; }
    var first = Math.max(0, firstAt(top) - OVERSCAN);
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
    renderHeads(top, top + (S.sized.h > 0 ? S.sized.h : grid.clientHeight));
  }

  // Dragging a header moves its column. Past 4 px the header lifts and follows the pointer along the header row, its
  // column fades, and a line marks the gap it lands in. Release puts it there and keeps the order; Esc, or a release
  // away from the table, puts it back. A drag never sorts. The picture, the name and the group stay where they are.
  var DRAG_FROM = 4, DRAG_EDGE = 24, DRAG_STEP = 8, dragged = false, dragFrame = 0;

  function wireDrag() {
    try {
      var saved = JSON.parse(localStorage.getItem('select.columnOrder') || '[]');
      S.columnOrder = Array.isArray(saved) ? saved.filter(function (k) { return typeof k === 'string'; }) : [];
    } catch (e) {}
    $('head').addEventListener('mousedown', function (e) {
      var h = e.button === 0 && e.target.closest('.h'), c = h && C.COLUMN[h.dataset.key];
      dragged = false;
      if (c && !c.fixed) { S.drag = { key: c.key, cell: h, x0: e.clientX, y0: e.clientY, on: false, x: e.clientX, after: null }; }
    });
    // The click that ends a drag doesn't sort.
    $('head').addEventListener('click', function (e) { if (dragged) { dragged = false; e.stopPropagation(); } }, true);
    document.addEventListener('mousemove', dragMove, true);
    document.addEventListener('mouseup', function (e) {
      var d = S.drag;
      if (!d) { return; }
      if (!d.on) { S.drag = null; return; }
      var g = $('grid').getBoundingClientRect();
      endDrag(e.clientX >= g.left && e.clientX <= g.right && e.clientY >= g.top && e.clientY <= g.bottom);
    }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && S.drag && S.drag.on) { e.preventDefault(); e.stopPropagation(); endDrag(false); }
    }, true);
    window.addEventListener('blur', function () { if (S.drag) { endDrag(false); } });
  }

  function dragMove(e) {
    var d = S.drag;
    if (!d) { return; }
    // The button came up outside the panel.
    if (!(e.buttons & 1)) { endDrag(false); return; }
    d.x = e.clientX;
    if (!d.on) {
      if (Math.max(Math.abs(e.clientX - d.x0), Math.abs(e.clientY - d.y0)) < DRAG_FROM) { return; }
      liftColumn(d);
    }
    e.preventDefault();
    placeDrag(d);
    edgeScroll();
  }

  function liftColumn(d) {
    d.on = true;
    d.cell.classList.add('from');
    var at = S.columns.map(function (c) { return c.key; }).indexOf(d.key);
    S.pool.forEach(function (slot) { slot.cells[at].classList.add('moving'); });
    var pill = document.createElement('div'), line = document.createElement('div');
    pill.className = 'lifted';
    pill.textContent = C.COLUMN[d.key].label;
    line.className = 'drop';
    $('app').appendChild(pill);
    $('app').appendChild(line);
    d.pill = pill;
    d.line = line;
  }

  // The pill under the pointer, kept over the table, and the line at the gap nearest the pill's centre: before each
  // column that moves, or after the last.
  function placeDrag(d) {
    var app = $('app').getBoundingClientRect(), head = $('head').getBoundingClientRect(), g = $('grid').getBoundingClientRect();
    var w = d.pill.offsetWidth, left = Math.max(g.left, Math.min(d.x - w / 2, g.right - w)), mid = left + w / 2;
    d.pill.style.left = left - app.left + 'px';
    d.pill.style.top = head.top - app.top + 1 + 'px';
    var cells = $('head').children, best = null, i, r;
    for (i = 0; i < cells.length; i++) {
      if (C.COLUMN[cells[i].dataset.key].fixed) { continue; }
      r = cells[i].getBoundingClientRect();
      var gap = { x: r.left + parseFloat(getComputedStyle(cells[i]).paddingLeft) / 2, after: null };
      for (var j = i - 1; j >= 0 && gap.after === null; j--) { if (!C.COLUMN[cells[j].dataset.key].fixed) { gap.after = cells[j].dataset.key; } }
      if (!best || Math.abs(gap.x - mid) < Math.abs(best.x - mid)) { best = gap; }
    }
    var lastCell = cells[cells.length - 1];
    r = lastCell.getBoundingClientRect();
    var end = { x: r.right - parseFloat(getComputedStyle(lastCell).paddingRight) / 2, after: lastCell.dataset.key };
    if (!best || Math.abs(end.x - mid) < Math.abs(best.x - mid)) { best = end; }
    d.after = best.after;
    d.line.style.left = Math.max(g.left, Math.min(best.x, g.right - 2)) - app.left + 'px';
    d.line.style.top = head.top - app.top + 5 + 'px';
  }

  // Near the table's left or right edge the table scrolls sideways under the pill, a step a frame.
  function edgeScroll() {
    if (dragFrame) { return; }
    var d = S.drag, grid = $('grid'), g = grid.getBoundingClientRect();
    if (!d || !d.on) { return; }
    var by = d.x < g.left + DRAG_EDGE ? -DRAG_STEP : d.x > g.left + grid.clientWidth - DRAG_EDGE ? DRAG_STEP : 0;
    if (!by || grid.scrollWidth <= grid.clientWidth) { return; }
    dragFrame = requestAnimationFrame(function () {
      dragFrame = 0;
      if (S.drag !== d) { return; }
      var was = grid.scrollLeft;
      grid.scrollLeft = was + by;
      if (grid.scrollLeft !== was) { placeDrag(d); edgeScroll(); }
    });
  }

  // keep: put the column where the line is, and remember the order.
  function endDrag(keep) {
    var d = S.drag;
    S.drag = null;
    if (!d || !d.on) { return; }
    dragged = true;
    if (dragFrame) { cancelAnimationFrame(dragFrame); dragFrame = 0; }
    d.pill.remove();
    d.line.remove();
    d.cell.classList.remove('from');
    Array.prototype.forEach.call(document.querySelectorAll('#body .c.moving'), function (c) { c.classList.remove('moving'); });
    if (!keep) { return; }
    var keys = C.orderColumns(C.COLUMNS, S.columnOrder).filter(function (c) { return !c.fixed; }).map(function (c) { return c.key; });
    var next = C.moveColumn(keys, d.key, d.after);
    if (next.join() === keys.join()) { return; }
    S.columnOrder = next;
    try { localStorage.setItem('select.columnOrder', JSON.stringify(next)); } catch (e) {}
    syncColumns();
    $('body').style.minWidth = totalWidth() + 'px';
    renderSortColumn();
    renderItems();
  }

  // ---------------------------------------------------------------- the grid

  // A ring of tiles: a clip keeps its tile, and its picture, while it stays in range, so scrolling paints only what is
  // new and a change of size paints nothing again. The tiles take their size from two variables on the grid, so a new
  // size is one change of style, never new tiles. The ring grows when the view needs more tiles and keeps them when it
  // needs fewer: the spare ones wait hidden with their clips, so a panel dragged back and forth makes nothing twice.
  function sizeTiles() {
    var L = S.L, box = $('tiles');
    if (S.tileW !== L.tileW) { box.style.setProperty('--tw', L.tileW + 'px'); S.tileW = L.tileW; }
    if (S.picH !== L.picH) { box.style.setProperty('--ph', L.picH + 'px'); S.picH = L.picH; }
    if (S.tiles.length < L.ring) { addTiles(L.ring - S.tiles.length); }
  }

  function addTiles(count) {
    var box = $('tiles');
    for (var i = 0; i < count; i++) {
      var el = document.createElement('div');
      el.className = 't';
      el.style.display = 'none';
      var pic = document.createElement('div');
      pic.className = 'pic';
      var img = document.createElement('img');
      img.draggable = false;
      img.alt = '';
      img.hidden = true;
      img.decoding = 'async';
      pic.appendChild(img);
      // The hover scrub: the clip's frames over the picture, and a thin line under it for where the pointer is.
      var scrub = document.createElement('div'), pos = document.createElement('div');
      scrub.className = 'scrub';
      scrub.hidden = true;
      pic.appendChild(scrub);
      pos.className = 'pos';
      pos.hidden = true;
      pos.appendChild(document.createElement('i'));
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
      el.appendChild(pos);
      el.appendChild(cap);
      box.appendChild(el);
      S.tiles.push({ el: el, pic: pic, img: img, scrub: scrub, pos: pos, name: name, fact: fact, chips: chips, key: '', thumbPath: null, x: -1, y: -2, cls: '', rowId: -1, at: -1, mark: 0 });
    }
  }

  function paintTile(slot, row) {
    if (S.scrub && S.scrub.slot === slot) { stopScrub(); }
    slot.rowId = row.rowId;
    var colour = S.view.sort.length && S.view.sort[0].key === 'colorName' && !!row.palette && !S.tokens.length;
    if (slot.name.textContent !== row.name) { slot.name.textContent = row.name; }
    var fact = colour ? '' : C.tileFact(row, S.view, S.tokens);
    if (slot.fact.textContent !== fact) { slot.fact.textContent = fact; }
    slot.fact.hidden = colour;
    slot.fact.classList.toggle('hit', !!S.tokens.length);
    slot.chips.hidden = !colour;
    if (colour) { paintPalette(slot.chips.children, row); }
    // A tile that shows its date says where the date came from, as the Date cell does.
    var dated = fact && !S.tokens.length && S.view.sort.length && S.view.sort[0].key === 'createdAt' ? C.dateNote(row) : '';
    var why = [row.error ? C.unreadableReason(row) : row.reason || row.lookReason, row.colorNote, dated].filter(Boolean).join('\n');
    slot.el.title = why ? row.path + '\n' + why : row.path;
    // The clip's own colour holds the place until its picture is decoded, so a fast scroll reads as the footage.
    slot.pic.style.background = row.palette && row.palette[0] ? row.palette[0] : '';
    setThumb(slot, slot.img, row);
  }

  // top: the grid's scroll when the caller has just set it, so it isn't read back.
  var tileStamp = 0;
  function renderTiles(top) {
    var grid = $('grid'), L = S.L, rows = S.store.rows, order = S.order, tiles = S.tiles, n = order.length, s, slot, at;
    if (!tiles.length) { return; }
    if (top === undefined) { top = grid.scrollTop; }
    // New results reuse the row numbers: no tile keeps a clip from the results before.
    if (S.tileStore !== S.store) {
      for (s = 0; s < tiles.length; s++) { tiles[s].rowId = -1; tiles[s].key = ''; }
      S.tileStore = S.store;
    }
    var first = firstAt(top - L.pitch);
    first -= first % L.cols;
    var end = Math.min(n, first + Math.min(L.ring || tiles.length, tiles.length)), stamp = ++tileStamp, byRow = new Map(), want = [];
    for (s = 0; s < tiles.length; s++) {
      if (tiles[s].rowId >= 0 && !byRow.has(tiles[s].rowId)) { byRow.set(tiles[s].rowId, tiles[s]); }
    }
    // A clip still in range keeps its tile. The clips that came into range take the tiles left over, those that just
    // went out of range first; a hidden tile keeps its clip and picture in case that clip comes back.
    for (at = first; at < end; at++) {
      slot = byRow.get(order[at]);
      if (slot) { slot.mark = stamp; }
      want.push(slot || null);
    }
    var free = [];
    for (s = 0; s < tiles.length; s++) { if (tiles[s].mark !== stamp && tiles[s].y === -2) { free.push(tiles[s]); } }
    for (s = 0; s < tiles.length; s++) { if (tiles[s].mark !== stamp && tiles[s].y !== -2) { free.push(tiles[s]); } }
    for (at = first; at < end; at++) {
      slot = want[at - first] || free.pop();
      slot.mark = stamp;
      var row = rows[order[at]], x = SIDE + xOf(at), y = yOf(at);
      if (slot.y !== y || slot.x !== x) {
        if (slot.y === -2) { slot.el.style.display = ''; }
        slot.el.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
        slot.x = x;
        slot.y = y;
      }
      if (slot.at !== at) { slot.at = at; slot.el.dataset.at = at; }
      var key = row.rowId + ':' + (row.version || 0) + ':' + S.paintKey;
      if (slot.key !== key) {
        paintTile(slot, row);
        slot.key = key;
      }
      var cls = 't' + (row.tier === 1 || row.error ? '' : ' pending') + (S.selected.has(row.rowId) ? ' sel' : '');
      if (slot.cls !== cls) { slot.el.className = cls; slot.cls = cls; }
    }
    for (s = 0; s < free.length; s++) {
      slot = free[s];
      if (slot.y === -2) { continue; }
      if (S.scrub && S.scrub.slot === slot) { stopScrub(); }
      slot.el.style.display = 'none';
      slot.y = -2;
      slot.img.classList.remove('arrive');
    }
    var h = S.sized.h > 0 ? S.sized.h : grid.clientHeight;
    renderHeads(top - L.pitch, top + h + L.pitch);
  }

  // ---------------------------------------------------------------- the panel changing size

  // Once a frame while the panel changes size: the ResizeObserver runs after layout and before paint, so what it moves
  // is painted in the same frame. A menu that would sit off the panel closes, a lifted column follows, the list's rows
  // and the grid's ring fit the new height, the tiles take their new size in place, and the clip at the top stays at
  // the top. Nothing is built again and no picture loads again; everything is read before anything is written.
  function onGridResize() {
    var grid = $('grid'), w = grid.clientWidth, h = grid.clientHeight;
    if (w === S.sized.w && h === S.sized.h) { return; }
    // New widths move the tiles from under a drag's corner: it ends with what it picked.
    if (mq && mq.on && w !== S.sized.w) { marqueeEnd(false); }
    // Across 400 px the sorted column moves next to Name, or back.
    if ((innerWidth < NARROW_LIST) !== !!S.narrowList) { syncColumns(); $('body').style.minWidth = totalWidth() + 'px'; renderSortColumn(); }
    S.sized.w = w;
    S.sized.h = h;
    stopScrub();
    ctxStillFits();
    if (S.drag && S.drag.on) { placeDrag(S.drag); }
    var top = grid.scrollTop, k = S.mode === 'grid' && S.order.length ? keptPlace(top) : null;
    if (poolSize() !== S.pool.length) { fitPool(); renderSortColumn(); }
    buildLayout(w, h);
    if (k) { top = placeKept(k); }
    if (S.mode === 'grid') { renderTiles(top); } else { renderRows(top); }
  }

  // The clip at the top, the first whose picture is at least half in view, and where the view starts from its row.
  // Kept for as long as the size changes and the editor doesn't scroll, so a long drag back and forth comes back to the
  // same place.
  function keptPlace(top) {
    var k = S.keep, L = S.L;
    if (k && k.top === top && k.order === S.order && k.mode === S.mode && S.order[k.at] === k.rowId) { return k; }
    var at = Math.min(firstAt(top + L.pitch - L.picH / 2), S.order.length - 1);
    k = S.keep = { at: at, rowId: S.order[at], off: top - yOf(at), pitch: L.pitch, top: top, order: S.order, mode: S.mode };
    return k;
  }

  // The same clip on the top row of the new layout, the view starting as far from its row as before, in proportion.
  // At the very top the grid stays at the top.
  function placeKept(k) {
    var grid = $('grid');
    grid.scrollTop = k.top <= 0 ? 0 : Math.max(0, Math.round(yOf(k.at) + k.off * S.L.pitch / k.pitch));
    k.top = grid.scrollTop;
    return k.top;
  }

  // The grid's own scroll that keeps the place, which is not the editor scrolling.
  function keptScroll() {
    return !!S.keep && $('grid').scrollTop === S.keep.top;
  }

  // The right-click menu stays where it is while it still fits in the panel.
  function ctxStillFits() {
    var c = S.ctx;
    if (!c) { return; }
    var box = $('app').getBoundingClientRect();
    var off = [c.el, c.sub].some(function (m) {
      var r = m && m.getBoundingClientRect();
      return !!r && (r.left < box.left || r.top < box.top || r.right > box.right || r.bottom > box.bottom);
    });
    if (off) { closeCtx(); }
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
    renderTable();
    $('tiles').hidden = !grid;
    $('grid').classList.toggle('tiled', grid);
    S.paintKey++;
    applyView();
    $('grid').scrollTop = at ? yOf(Math.min(at, S.order.length - 1)) : 0;
    renderItems();
  }

  // The list's header and table come with its first rows: before a scan the list is as bare as the grid, with no
  // header and nothing to scroll sideways. While the header is there, it draws the status's hairline itself.
  function renderTable() {
    var on = S.mode === 'list' && S.store.rows.length > 0;
    $('head').hidden = $('body').hidden = !on;
    $('app').classList.toggle('is-list', on);
  }

  // Blank table, plain words. Waiting and nothing-there read differently, because they mean different things.
  function emptyText() {
    if (!S.store.rows.length || S.order.length) { return ''; }
    var show = S.view.show ? C.SHOW[S.view.show] : null, status = C.dataStatus(S.store.rows, S.view.show, scanRunning());
    if (S.tokens.length) { return 'Nothing matches ' + C.quoted(S.query.trim()) + (scanRunning() ? ' yet.' : '.'); }
    if (status === 'waiting') { return (show && show.waiting) || 'Still looking at these clips.'; }
    if (status === 'none') { return show.none; }
    if (C.viewFamilies(S.view).length) { return 'No ' + C.familyWords(S.view, 'or').toLowerCase() + ' clips' + (show ? ' among ' + show.label.toLowerCase() : '') + '.'; }
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
    viewMoved();
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
    changeView({ show: id, sort: S.view.sort, families: S.view.families });
  }

  // Picking the sort that is already on turns it round.
  function pressSort(key) {
    closePicker();
    var now = S.view.sort[0];
    var sort = key === null ? [] : now && now.key === key && S.view.sort.length === 1 ? [{ key: key, dir: -now.dir }] : [{ key: key, dir: C.naturalDir(key) }];
    changeView({ show: S.view.show, sort: sort, families: S.view.families });
  }

  function flipSort() {
    if (!S.view.sort.length) { return; }
    changeView({ show: S.view.show, sort: S.view.sort.map(function (s, i) { return i ? s : { key: s.key, dir: -s.dir }; }), families: S.view.families });
  }

  // A colour narrows whatever is on screen: a click shows that colour alone, or none when it was the only one on. Shift- or
  // Cmd-click adds it to the colours on, or takes it off. With no sort yet the rainbow comes with it, so the colours sit
  // together, in the dots' order.
  function pressFamily(id, add) {
    var on = C.viewFamilies(S.view), had = on.indexOf(id) >= 0, next;
    if (add) { next = had ? on.filter(function (x) { return x !== id; }) : C.viewFamilies({ families: on.concat(id) }); } else { next = had && on.length === 1 ? [] : [id]; }
    changeView({ show: S.view.show, sort: next.length && !S.view.sort.length ? [{ key: 'colorName', dir: 1 }] : S.view.sort, families: next });
  }

  function headerClick(key, shift) {
    changeView({ show: S.view.show, sort: C.nextSort(S.view.sort, key, shift), families: S.view.families });
  }

  // ---------------------------------------------------------------- hover scrub

  // The pointer rests on a picture for a second (small moves allowed), then the engine makes that one clip's strip of
  // frames, and moving across the picture slides through them. One strip is made at a time; a clip's strip, or the
  // reason it has none, is kept for the session. Nothing while a scan or a write runs, or without the engine.
  var SCRUB_REST = 1000, SCRUB_STILL = 6, stripRun = null, stripNext = null;

  function wireScrub() {
    $('tiles').addEventListener('mousemove', onScrubMove);
    $('tiles').addEventListener('mouseleave', stopScrub);
    $('tiles').addEventListener('mousedown', function () { if (S.scrub && !S.scrub.strip) { stopScrub(); } });
    $('grid').addEventListener('scroll', stopScrub, { passive: true });
    window.addEventListener('blur', stopScrub);
    window.addEventListener('pagehide', function () { if (stripRun) { stripRun.handle.stop(); } });
  }

  function engineBinary() {
    return extensionRoot() + '/bin/select-engine';
  }

  function scrubbable(row) {
    return !!row && row.tier === 1 && !!row.thumb && !row.error && S.mode === 'grid' && N.available && !scanRunning() && !S.listing && !S.busy;
  }

  function onScrubMove(e) {
    if (mq && mq.on) { return; }
    var pic = e.target.closest('.pic'), tile = pic && pic.parentNode, slot = null, i;
    for (i = 0; tile && i < S.tiles.length && !slot; i++) { if (S.tiles[i].el === tile) { slot = S.tiles[i]; } }
    var row = slot && slot.rowId >= 0 ? S.store.rows[slot.rowId] : null, sc = S.scrub;
    if (!scrubbable(row)) { stopScrub(); return; }
    if (!sc || sc.slot !== slot || sc.row !== row) {
      stopScrub();
      sc = S.scrub = { slot: slot, row: row, x: e.clientX, y: e.clientY, px: e.clientX, timer: null, asked: false, strip: null };
      sc.timer = setTimeout(function () { restOver(sc); }, SCRUB_REST);
      return;
    }
    sc.px = e.clientX;
    if (sc.strip) { showFrame(sc); return; }
    // Still resting: a move past a few pixels starts the second again.
    if (!sc.asked && Math.max(Math.abs(e.clientX - sc.x), Math.abs(e.clientY - sc.y)) > SCRUB_STILL) {
      sc.x = e.clientX;
      sc.y = e.clientY;
      clearTimeout(sc.timer);
      sc.timer = setTimeout(function () { restOver(sc); }, SCRUB_REST);
    }
  }

  function restOver(sc) {
    if (S.scrub !== sc || !scrubbable(sc.row)) { return; }
    sc.asked = true;
    var known = S.strips.get(sc.row.path);
    if (known) {
      if (known.ready) { loadStrip(sc.row.path, known, true); }
      return;
    }
    askStrip(sc.row.path);
  }

  function askStrip(path) {
    if (N.engineProblem(engineBinary())) { return; }
    stripNext = path;
    nextStrip();
  }

  // The one strip request at a time. A clip asked for while another is made waits; a newer one takes its turn.
  function nextStrip() {
    if (stripRun || !stripNext) { return; }
    var path = stripNext;
    stripNext = null;
    if (S.strips.has(path) || scanRunning()) { return; }
    stripRun = { path: path, handle: null };
    stripRun.handle = N.runStrip(engineBinary(), path, function (err, msg) {
      stripRun = null;
      if (err || !(msg.frames > 1) || !(msg.distinct > 1)) {
        S.strips.set(path, { error: err ? err.message : 'One frame' });
        nextStrip();
        return;
      }
      var entry = { file: msg.file, frames: msg.frames, ready: false, url: '' };
      S.strips.set(path, entry);
      loadStrip(path, entry, false);
      nextStrip();
    });
  }

  // A strip's picture is loaded before it shows, so the swap is instant, and the picture itself isn't kept. Each time
  // under an address of its own, so the file is read and not the page's memory of it: a scan may have removed the file.
  // kept: the strip is from earlier in the session, so if its picture has gone it is dropped and asked for once more.
  // A strip just made that doesn't load stays an error for the session.
  var stripLoads = 0;
  function loadStrip(path, entry, kept) {
    var img = new Image(), url = C.fileUrl(entry.file) + '?' + (++stripLoads);
    var resting = function () { var sc = S.scrub; return sc && sc.asked && sc.row.path === path && scrubbable(sc.row) ? sc : null; };
    img.onload = function () {
      if (S.strips.get(path) !== entry) { return; }
      entry.ready = true;
      entry.url = url;
      var sc = resting();
      if (sc) { startScrub(sc, entry); }
    };
    img.onerror = function () {
      if (S.strips.get(path) !== entry) { return; }
      if (!kept) { S.strips.set(path, { error: 'The strip didn\'t load' }); return; }
      S.strips.delete(path);
      if (resting()) { askStrip(path); }
    };
    img.src = url;
  }

  // The tile's tooltip (its path) would sit over the frames, so it waits until the scrub ends.
  function startScrub(sc, entry) {
    var el = sc.slot.scrub;
    sc.strip = entry;
    sc.frame = -1;
    sc.title = sc.slot.el.title;
    sc.slot.el.title = '';
    el.style.backgroundImage = 'url("' + entry.url + '")';
    el.style.backgroundSize = entry.frames * 100 + '% 100%';
    showFrame(sc);
    el.hidden = false;
    sc.slot.pos.hidden = false;
  }

  // The frame under the pointer, floor(x / width × frames), and the line filled to the pointer.
  function showFrame(sc) {
    var r = sc.slot.pic.getBoundingClientRect(), f = Math.max(0, Math.min(0.9999, (sc.px - r.left) / r.width));
    var n = sc.strip.frames, at = Math.floor(f * n);
    if (at !== sc.frame) {
      sc.frame = at;
      sc.slot.scrub.style.backgroundPosition = at / (n - 1) * 100 + '% 0';
    }
    sc.slot.pos.firstChild.style.width = f * 100 + '%';
  }

  // Back to the clip's own picture at once. Package A's right-click menu calls it too.
  function stopScrub() {
    var sc = S.scrub;
    if (!sc) { return; }
    S.scrub = null;
    clearTimeout(sc.timer);
    if (stripNext === sc.row.path) { stripNext = null; }
    sc.slot.scrub.hidden = true;
    sc.slot.scrub.style.backgroundImage = '';
    sc.slot.pos.hidden = true;
    if (sc.strip) { sc.slot.el.title = sc.title; }
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

  // The glass opens into a field, and closes again when it's left empty.
  function openSearch(select) {
    $('search-box').classList.add('open');
    $('toolbar').classList.add('searching');
    $('search').focus();
    if (select) { $('search').select(); }
  }

  // A closed field that kept the focus would take the next key unseen, the caret before it, so the focus goes with it.
  function closeSearchIfEmpty() {
    if (S.query) { return; }
    $('search-box').classList.remove('open');
    $('toolbar').classList.remove('searching');
    if (document.activeElement === $('search')) { $('search').blur(); }
  }

  // Closing the search brings the toolbar's small words back and moves its buttons, so it waits for a press to end: the
  // click that closes it still lands on what was under the pointer when it went down.
  var pressing = false, closeAfterPress = false;
  function closeSearchSoon() {
    if (pressing) { closeAfterPress = true; } else { closeSearchIfEmpty(); }
  }

  function clearSearch() {
    closeSuggest();
    $('search').value = '';
    onSearch();
    $('search').focus();
  }

  // Under the open search box: ways to finish the last word typed, from what this scan's clips hold, each with how many
  // clips hold it. Up and down move, Enter or a click takes one, Esc closes the list and a second Esc clears. Tab moves
  // on, as anywhere: it never fills the search.
  function wireSuggest() {
    var field = $('search'), list = $('suggest');
    field.addEventListener('input', renderSuggest);
    field.addEventListener('blur', closeSuggest);
    field.addEventListener('keydown', function (e) {
      var sg = S.suggest, n = sg ? sg.list.length : 0;
      if (!sg) { return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var by = e.key === 'ArrowDown' ? 1 : -1;
        paintHot(sg.hot < 0 ? (by > 0 ? 0 : n - 1) : (sg.hot + by + n) % n);
      } else if (e.key === 'Enter' && sg.hot >= 0) {
        e.preventDefault();
        takeSuggest(sg.hot);
      } else if (e.key === 'Enter') {
        closeSuggest();
      }
    });
    // A press on the list keeps the field focused, so the list is still there for the click.
    list.addEventListener('mousedown', function (e) { e.preventDefault(); });
    list.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (b) { takeSuggest(Number(b.dataset.at)); }
    });
    // The box grows as it opens; the list follows it.
    $('search-box').addEventListener('transitionend', function () { if (S.suggest) { placeSuggest(); } });
    window.addEventListener('resize', function () { if (S.suggest) { placeSuggest(); } });
  }

  function renderSuggest() {
    var field = $('search'), box = $('suggest');
    var list = S.store.rows.length && document.activeElement === field ? C.suggestions(S.store.rows, field.value, 6, S.view) : [];
    if (!list.length) { closeSuggest(); return; }
    box.textContent = '';
    list.forEach(function (s, i) {
      var b = document.createElement('button'), word = document.createElement('span'), n = document.createElement('span');
      b.setAttribute('role', 'option');
      b.tabIndex = -1;
      b.dataset.at = i;
      word.className = 'w';
      word.textContent = s.word;
      n.className = 'n';
      n.textContent = fmtInt(s.count);
      b.appendChild(word);
      b.appendChild(n);
      box.appendChild(b);
    });
    S.suggest = { list: list, hot: -1 };
    box.hidden = false;
    placeSuggest();
  }

  // Its width is the box's, at least 200 px, and it stays inside the panel.
  function placeSuggest() {
    var box = $('suggest'), r = $('search-box').getBoundingClientRect(), app = $('app').getBoundingClientRect();
    var w = Math.min(Math.max(200, r.width), app.width - 16);
    box.style.width = w + 'px';
    box.style.left = Math.max(8, Math.min(r.left - app.left, app.width - w - 8)) + 'px';
    box.style.top = r.bottom - app.top + 4 + 'px';
  }

  function paintHot(at) {
    S.suggest.hot = at;
    Array.prototype.forEach.call($('suggest').children, function (b, i) {
      b.classList.toggle('hot', i === at);
      b.setAttribute('aria-selected', i === at ? 'true' : 'false');
    });
  }

  // The search with that word in it, searched at once.
  function takeSuggest(at) {
    var s = S.suggest && S.suggest.list[at], field = $('search');
    closeSuggest();
    if (!s) { return; }
    field.value = s.query;
    onSearch();
    field.setSelectionRange(s.query.length, s.query.length);
  }

  // Says whether it was open.
  function closeSuggest() {
    if (!S.suggest) { return false; }
    S.suggest = null;
    $('suggest').hidden = true;
    return true;
  }

  // ---------------------------------------------------------------- Show and Sort

  function closePicker() {
    $('picker').hidden = true;
    if (S.picker) { $(S.picker).setAttribute('aria-expanded', 'false'); }
    S.picker = null;
  }

  // A count while there is something to count, a quiet ellipsis while the engine is still on it, a dash once it won't come.
  // A count still climbing ends in an ellipsis too. counts: core.showCounts, made once for the whole menu.
  function showHint(id, counts) {
    var rows = S.store.rows;
    if (!rows.length) { return ''; }
    if (id === null) { return fmtInt(rows.length); }
    var c = counts[id];
    if (!c.known) { return scanRunning() ? '\u2026' : '\u2013'; }
    // A count that can still grow says so, so a 0 mid-scan never reads as an answer.
    var growing = scanRunning() && (C.SHOW[id].needs || C.SHOW[id].group) && !C.understandingShare(S.store).landed;
    return fmtInt(c.n) + (growing ? '\u2026' : '');
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

  function pickerItem(menu, it) {
    var b = document.createElement('button'), h = document.createElement('span');
    b.dataset.id = it.id;
    b.setAttribute('role', 'menuitemradio');
    b.textContent = it.label;
    b.appendChild(h);
    setPickerItem(b, it);
    menu.appendChild(b);
    return b;
  }

  function setPickerItem(b, it) {
    var h = b.lastChild;
    if (b.className !== (it.on ? 'on' : '')) { b.className = it.on ? 'on' : ''; }
    b.setAttribute('aria-checked', it.on ? 'true' : 'false');
    if (b.title !== (it.tip || '')) { b.title = it.tip || ''; }
    if (h.textContent !== it.hint) { h.textContent = it.hint; }
    b.onclick = it.act;
  }

  // The menu's items from the data, so its counts climb while a scan runs. The same items as on screen change their
  // words and ticks in place, so the one under the pointer keeps its plate and its focus from frame to frame.
  function fillPicker(which) {
    var menu = $('picker'), list = [];
    var add = function (id, label, hint, on, tip, act) { list.push({ id: id, label: label, hint: hint, on: on, tip: tip, act: act }); };
    if (which === 'show') {
      var counts = C.showCounts(S.store.rows);
      add('everything', 'Everything', showHint(null, counts), !S.view.show, 'Every clip in the scan.', function () { pressShow(null); });
      var section = null;
      C.SHOWS.forEach(function (s) {
        if (s.section !== section) { list.push('-'); section = s.section; }
        add(s.id, s.label, showHint(s.id, counts), S.view.show === s.id, s.tip, function () { pressShow(s.id); });
      });
    } else {
      var now = S.view.sort[0];
      add('listed', 'As listed', '', !now, 'The order the clips came in, from the project or the folder.', function () { pressSort(null); });
      list.push('-');
      C.SORTS.forEach(function (e) {
        add(e.key, e.label, sortHint(e), !!now && now.key === e.key, C.COLUMN[e.key].tip, function () { pressSort(e.key); });
      });
    }
    var kids = menu.children, same = menu.dataset.which === which && kids.length === list.length && list.every(function (it, i) {
      return it === '-' ? kids[i].tagName === 'HR' : kids[i].dataset.id === it.id;
    });
    if (same) {
      list.forEach(function (it, i) { if (it !== '-') { setPickerItem(kids[i], it); } });
      return;
    }
    var focused = document.activeElement && document.activeElement.parentNode === menu ? Array.prototype.indexOf.call(kids, document.activeElement) : -1;
    menu.textContent = '';
    menu.dataset.which = which;
    list.forEach(function (it) { if (it === '-') { menu.appendChild(document.createElement('hr')); } else { pickerItem(menu, it); } });
    if (focused >= 0 && menu.children[focused]) { menu.children[focused].focus(); }
  }

  function openPicker(which, mouse) {
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
    if (!mouse) { pickerFocus(which); }
  }

  // Show, Sort and ··· open their menus on the press, as Premiere's own menus do, so the menu is there the frame the
  // button goes down, and a second press closes it. A click from the keyboard (Space, Enter) opens and closes as before,
  // with the focus in the menu at once. Opened by the pointer, the menu takes the focus on the click that ends the
  // press, once the press has given it to the button, so the browser draws no keyboard highlight on the item it lands on.
  // fn(mouse) opens or closes; focusIn() puts the focus in the menu if it is open.
  function onPress(button, fn, focusIn) {
    button.addEventListener('mousedown', function (e) {
      if (e.button !== 0 || e.ctrlKey) { return; }
      fn(true);
    });
    button.addEventListener('click', function (e) {
      e.stopPropagation();
      if (e.detail === 0) { fn(false); } else { focusIn(); }
    });
  }

  // The item a menu's focus goes to: the one that is on, or the first.
  function pickerFocus(which) {
    var menu = $('picker');
    if (S.picker !== which || menu.hidden) { return; }
    var on = menu.querySelector('.on') || menu.querySelector('button');
    if (on && !menu.contains(document.activeElement)) { on.focus(); }
  }

  function buildBar() {
    onPress($('show'), function (mouse) { openPicker('show', mouse); }, function () { pickerFocus('show'); });
    onPress($('sort'), function (mouse) { openPicker('sort', mouse); }, function () { pickerFocus('sort'); });
    $('flip').onclick = flipSort;
    var dots = $('families');
    C.FAMILIES.forEach(function (f, n) {
      var b = document.createElement('button'), i = document.createElement('i');
      b.dataset.family = f.id;
      b.setAttribute('aria-label', f.word);
      b.tabIndex = n ? -1 : 0;
      i.style.background = f.dot;
      b.appendChild(i);
      b.onclick = function (e) {
        Array.prototype.forEach.call(dots.children, function (x) { x.tabIndex = x === b ? 0 : -1; });
        pressFamily(f.id, e.shiftKey || e.metaKey);
      };
      dots.appendChild(b);
    });
    // The nine dots are one stop for Tab: Left and Right move between them, Space or Enter picks one alone, and with
    // Shift adds it or takes it off, as a Shift-click does.
    dots.addEventListener('keydown', function (e) {
      var all = Array.prototype.slice.call(dots.querySelectorAll('button')), at = all.indexOf(document.activeElement);
      if (at < 0) { return; }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        var next = all[(at + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length];
        all.forEach(function (x) { x.tabIndex = x === next ? 0 : -1; });
        next.focus();
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        pressFamily(all[at].dataset.family, e.shiftKey || e.metaKey);
      }
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

  // ---------------------------------------------------------------- drag select

  // Press anywhere in the results (a tile, a row or the space between) and drag: a rectangle, and every clip it touches
  // is picked, live, as in the Finder and Premiere's Project panel. Under 4 px a press stays a click. A plain drag picks
  // what the rectangle holds; Shift adds it to the clips picked when the drag began; Cmd turns each clip it touches the
  // other way, as the Finder does. A Shift- or Cmd-press on a clip waits for the release to be a click, so a drag from
  // it never shows that click first. Near the top or bottom edge the clips scroll by themselves, faster the closer the
  // pointer, and the rectangle keeps its corner where the press was in the clips. Hits come from the layout, once a
  // frame, so clips scrolled away from the tiles count too. Escape puts the picks back as they were; a release anywhere,
  // or the panel losing focus, ends it. While it runs nothing else reacts: no scrub, no tooltips, no hover.
  var MARQUEE_FROM = 4, MARQUEE_EDGE = 32, MARQUEE_STEP = 16, MARQUEE_MOST = 48, mq = null, mqLast = null, mqClick = false;

  function wireMarquee() {
    document.addEventListener('mousedown', marqueeDown, true);
    document.addEventListener('mousemove', marqueeMove, true);
    document.addEventListener('mouseup', marqueeUp, true);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && mq && mq.on) { e.preventDefault(); e.stopPropagation(); marqueeEnd(true); }
    }, true);
    document.addEventListener('selectstart', function (e) { if (mq) { e.preventDefault(); } });
    // The click a drag ends with is the drag's.
    window.addEventListener('click', function (e) { if (mqClick) { mqClick = false; e.stopPropagation(); e.preventDefault(); } }, true);
    window.addEventListener('blur', function () { if (mq) { marqueeEnd(false); } });
  }

  // The press, before the grid's own handler picks a clip with it. Not on the list's header (its columns drag), the
  // scrollbars, the empty view, or a second press of a double-click.
  function marqueeDown(e) {
    if (mq) { marqueeEnd(false); }
    var grid = $('grid');
    if (e.button !== 0 || e.ctrlKey || e.detail > 1 || S.modalOpen || !S.order.length || !grid.contains(e.target) || e.target.closest('#head, #empty')) { return; }
    var g = grid.getBoundingClientRect();
    if (e.clientX >= g.left + grid.clientWidth || e.clientY >= g.top + grid.clientHeight) { return; }
    var at = rowAt(e.target), id = at >= 0 ? S.order[at] : null;
    mq = { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, cx: e.clientX - g.left + grid.scrollLeft, cy: e.clientY - g.top + grid.scrollTop,
      before: new Set(S.selected), anchor: S.anchor, pressed: id, how: e.metaKey ? 'flip' : e.shiftKey ? 'add' : 'only',
      click: id !== null && (e.shiftKey || e.metaKey) ? { shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: false } : null,
      mode: S.mode, store: S.store, on: false, frame: 0, el: null, hits: [], ticks: 0, worst: 0, box: '' };
  }

  // A Shift- or Cmd-press on a clip is the drag's until it is a click (the grid's mousedown leaves it).
  function marqueeHolds() {
    return !!(mq && mq.click);
  }

  function marqueeMove(e) {
    if (!mq) { return; }
    // The button came up where the page didn't hear it.
    if (!(e.buttons & 1)) { marqueeEnd(false); return; }
    mq.x = e.clientX;
    mq.y = e.clientY;
    if (!mq.on) {
      if (Math.max(Math.abs(mq.x - mq.x0), Math.abs(mq.y - mq.y0)) < MARQUEE_FROM) { return; }
      marqueeBegin();
    }
    e.preventDefault();
    marqueeSoon();
  }

  function marqueeUp(e) {
    if (!mq || e.button !== 0) { return; }
    var m = mq;
    if (m.on) { mqClick = true; setTimeout(function () { mqClick = false; }, 0); marqueeEnd(false); return; }
    mq = null;
    // Less than 4 px: the click the press held back, on the clip it was on.
    var at = m.click ? S.order.indexOf(m.pressed) : -1;
    if (at >= 0) { clickRow(at, m.click); }
  }

  function marqueeBegin() {
    var m = mq, grid = $('grid');
    m.on = true;
    stopScrub();
    closeCtx();
    m.top = S.mode === 'grid' ? $('tiles').offsetTop : $('body').offsetTop;
    grid.classList.add('marqueeing');
    // One element over the clips' view, its rectangle drawn by its background: a 1 px line in the accent and a fill of
    // it at 12 %. A move sets where its layers sit, which repaints it and lays nothing out.
    var ring = getComputedStyle(document.documentElement).getPropertyValue('--focus-ring').trim() || '#4A82EB';
    var line = 'linear-gradient(' + ring + ',' + ring + ')', fill = 'linear-gradient(' + tint(ring, 0.12) + ',' + tint(ring, 0.12) + ')';
    var el = m.el = document.createElement('div');
    el.id = 'marquee';
    el.style.backgroundImage = [line, line, line, line, fill].join(',');
    $('app').appendChild(el);
    // As a click does: the last write's result and any note give way.
    moveOn();
    note('');
    marqueeTick();
  }

  // A colour token at an alpha, for the rectangle's fill: #rgb, #rrggbb or rgb().
  function tint(color, alpha) {
    var c = String(color).trim(), m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c), v;
    if (m) {
      var h = m[1].length === 3 ? m[1].replace(/(.)/g, '$1$1') : m[1];
      v = [0, 2, 4].map(function (i) { return parseInt(h.slice(i, i + 2), 16); });
    } else {
      v = (c.match(/[\d.]+/g) || [74, 130, 235]).slice(0, 3).map(Number);
    }
    return 'rgba(' + v.join(',') + ',' + alpha + ')';
  }

  function marqueeSoon() {
    if (mq && mq.on && !mq.frame) { mq.frame = requestAnimationFrame(marqueeTick); }
  }

  // Once a frame: the scroll at an edge, the clips the rectangle touches, the picks, the rectangle.
  function marqueeTick() {
    var m = mq;
    if (!m || !m.on) { return; }
    m.frame = 0;
    // The view changed under it (a new scan, the other view): the drag ends with what it picked.
    if (S.mode !== m.mode || S.store !== m.store) { marqueeEnd(false); return; }
    var t0 = performance.now(), grid = $('grid'), g = grid.getBoundingClientRect(), app = $('app').getBoundingClientRect();
    var lid = S.mode === 'list' ? m.top : 0;
    var top = g.top + lid, bottom = g.top + grid.clientHeight, scroll = grid.scrollTop;
    // At the top or bottom edge, or past it, the clips scroll: a step a frame, growing with the square of the depth.
    var d = m.y < top + MARQUEE_EDGE ? m.y - (top + MARQUEE_EDGE) : m.y > bottom - MARQUEE_EDGE ? m.y - (bottom - MARQUEE_EDGE) : 0;
    var by = d ? (d < 0 ? -1 : 1) * Math.min(MARQUEE_MOST, Math.max(1, Math.round(MARQUEE_STEP * d * d / (MARQUEE_EDGE * MARQUEE_EDGE)))) : 0;
    var moved = false;
    if (by) {
      var next = Math.max(0, Math.min(grid.scrollHeight - grid.clientHeight, scroll + by));
      if (next !== scroll) { grid.scrollTop = next; scroll = grid.scrollTop; moved = true; }
    }
    // The rectangle in the clips' own coordinates, from the press to the pointer, inside the content.
    var px = Math.max(0, Math.min(grid.scrollWidth, m.x - g.left + grid.scrollLeft)), py = Math.max(0, Math.min(grid.scrollHeight, m.y - g.top + scroll));
    var r = { x0: Math.min(m.cx, px), x1: Math.max(m.cx, px), y0: Math.min(m.cy, py), y1: Math.max(m.cy, py) };
    m.hits = marqueeHits(r, m.top);
    var want = m.how === 'only' ? new Set(m.hits) : new Set(m.before);
    m.hits.forEach(function (id) { if (m.how === 'flip' && m.before.has(id)) { want.delete(id); } else { want.add(id); } });
    var same = want.size === S.selected.size;
    if (same) { want.forEach(function (id) { if (!S.selected.has(id)) { same = false; } }); }
    if (!same) {
      S.selected.clear();
      want.forEach(function (id) { S.selected.add(id); });
      footSoon();
    }
    if (!same || moved) { if (S.mode === 'grid') { renderTiles(scroll); } else { renderRows(scroll); } }
    // Over the clips' view, under the list's header; it moves only when the grid does.
    var el = m.el, box = (g.left - app.left) + ',' + (g.top - app.top + lid) + ',' + grid.clientWidth + ',' + Math.max(0, grid.clientHeight - lid);
    if (box !== m.box) {
      var b = box.split(',');
      el.style.left = b[0] + 'px';
      el.style.top = b[1] + 'px';
      el.style.width = b[2] + 'px';
      el.style.height = b[3] + 'px';
      m.box = box;
    }
    var x = Math.round(r.x0 - grid.scrollLeft), y = Math.round(r.y0 - scroll - lid);
    var w = Math.max(1, Math.round(r.x1 - grid.scrollLeft) - x), h = Math.max(1, Math.round(r.y1 - scroll - lid) - y);
    el.style.backgroundPosition = x + 'px ' + y + 'px,' + x + 'px ' + (y + h - 1) + 'px,' + x + 'px ' + y + 'px,' + (x + w - 1) + 'px ' + y + 'px,' + x + 'px ' + y + 'px';
    el.style.backgroundSize = w + 'px 1px,' + w + 'px 1px,1px ' + h + 'px,1px ' + h + 'px,' + w + 'px ' + h + 'px';
    m.ticks++;
    m.worst = Math.max(m.worst, performance.now() - t0);
    // While the edge scrolls, the frames go on without the pointer moving.
    if (moved) { marqueeSoon(); }
  }

  // The clips a rectangle touches, in view order, from the layout: a tile's picture and name, or a list row's height.
  // top: where the tiles or the rows start in the grid's content.
  function marqueeHits(r, top) {
    var L = S.L, n = S.order.length, out = [], grid = S.mode === 'grid', h = grid ? L.picH + TILE_CAPTION : ROW_H;
    var y0 = r.y0 - top, y1 = r.y1 - top;
    if (y1 < 0 || !n) { return out; }
    for (var at = firstAt(Math.max(0, y0)); at < n; at++) {
      var y = yOf(at);
      if (y > y1) { break; }
      if (y + h < y0) { continue; }
      if (grid) {
        var x = SIDE + xOf(at);
        if (x > r.x1 || x + L.tileW < r.x0) { continue; }
      }
      out.push(S.order[at]);
    }
    return out;
  }

  // cancel: Escape, the picks as they were before the press. Otherwise the picks stay, and a later Shift-click reaches
  // from the clip the drag started on, or from the first clip it picked.
  function marqueeEnd(cancel) {
    var m = mq;
    mq = null;
    if (!m || !m.on) { return; }
    if (m.frame) { cancelAnimationFrame(m.frame); }
    if (m.el) { m.el.remove(); }
    $('grid').classList.remove('marqueeing');
    if (cancel) {
      S.selected.clear();
      m.before.forEach(function (id) { S.selected.add(id); });
      S.anchor = m.anchor;
    } else if (m.pressed !== null) {
      S.anchor = m.pressed;
    } else if (m.hits.length) {
      S.anchor = m.hits[0];
    } else if (m.how === 'only') {
      S.anchor = null;
    }
    mqLast = { ticks: m.ticks, worst: Math.round(m.worst * 100) / 100, cancel: !!cancel, hits: m.hits.length };
    renderItems();
    renderFoot();
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

  // The foot at most ten times a second, for counts that climb fast.
  var footTimer = null;
  function footSoon() {
    if (footTimer !== null) { return; }
    footTimer = setTimeout(function () { footTimer = null; renderFoot(); }, 100);
  }

  // What a scan reads: o.folder, a folder on disk; o.same, the clips on screen again; else the Project panel's target
  // (o.whole: the whole project, whatever is selected). Resolves {ok, items, project, words} or {ok: false, message}.
  function listClips(o) {
    if (o.folder) {
      var folder = o.folder;
      return new Promise(function (resolve) {
        S.listed = 0;
        S.listWalk = N.walkFolder(folder, function (err, paths, info) {
          S.listWalk = null;
          if (info && info.stopped) { resolve({ ok: false, quiet: true, message: '' }); return; }
          if (info && info.capped) { resolve({ ok: false, message: 'This folder holds more than ' + fmtInt(N.MOST_FILES) + ' video files, so it wasn\'t scanned. Choose a folder inside it.' }); return; }
          if (err) { resolve({ ok: false, message: 'Cannot read ' + folder + ': ' + err.code }); return; }
          resolve({ ok: true, items: paths.map(function (p) { return { path: p }; }), project: null, words: folder.slice(folder.lastIndexOf('/') + 1) || folder });
        }, { onCount: function (n) { S.listed = n; footSoon(); } });
        renderFoot();
      });
    }
    if (o.same) {
      var items = [];
      S.store.rows.forEach(function (r) { items = items.concat(rowItems(r.path, r.ids, r.binPaths)); });
      var from = S.from || { project: null, words: '', target: null };
      // The same clips keep what they were: picked or not, their ids this session's or a record's.
      return Promise.resolve({ ok: true, items: items, project: from.project, words: from.words, target: from.target,
        source: S.scan ? S.scan.source : 'project', oldIds: S.store.rows.some(function (r) { return r.oldIds; }) });
    }
    // A press reads the project as it is now: fresh walks it again, where a watch may use the host's last walk.
    return host('target', { whole: !!o.whole, fresh: true, exts: C.VIDEO_EXTS }).then(function (t) {
      if (!t.ok) { return t; }
      if (!o.whole) { setTarget(t); }
      if (t.kind === 'several') { return { ok: false, quiet: true, message: '' }; }
      setProject(t.project);
      var where = t.kind === 'project' ? '' : C.placeWords(t.places, t.more);
      return { ok: true, items: t.items, project: t.project, words: where || projectTitle(t.project), noPath: t.noPath,
        target: { kind: t.kind, places: t.places, more: t.more, sig: t.sig, whole: !!o.whole } };
    });
  }

  // o: {whole, folder, same}, as listClips takes it. {}: what the Project panel has selected. Nothing at all, as
  // update.js calls it after its Restart: the scan noted before the restart, if any.
  function startScan(o) {
    if (o === undefined) {
      scanAfterRestart(takeIntent() || 'scan');
      return;
    }
    o = o || {};
    if (S.listing || S.restoring || (S.scan && S.scan.handle)) { return; }
    if (!N.available) { note('This panel can\'t start Node, so it can\'t scan. Reinstall Select.', 'bad'); return; }
    note('');
    moveOn();
    S.listing = true;
    renderFoot();
    return listClips(o).then(function (got) {
      S.listing = false;
      if (!got.ok) { if (got.message) { note(got.message, 'warn'); } renderFoot(); watchWaiting(); return; }
      var filtered = C.videoItems(got.items);
      if (!filtered.items.length) { note('No video clips here.', 'warn'); renderFoot(); watchWaiting(); return; }
      resetStore();
      C.addItems(S.store, filtered.items);
      if (got.oldIds) { S.store.rows.forEach(function (r) { r.oldIds = true; }); }
      S.from = { project: got.project ? { path: got.project.path, name: got.project.name } : null, words: got.words || '', target: got.target || null };
      S.scannedAt = new Date().toISOString();
      S.lastAt = null;
      // A scan of a selection is a promise about which items were picked (see resolveIds).
      var picked = got.target && (got.target.kind === 'clips' || got.target.kind === 'bins');
      S.scan = { state: 'Scanning', startedAt: performance.now(), endedAt: 0, handle: null, source: got.source || (o.folder ? 'folder' : picked ? 'selection' : 'project'), failure: null, stopping: false, heard: 0 };
      refreshOthers();
      applyView();
      // What the scan left out (not video) is said in the bar's count tooltip, not in the band.
      S.scan.skipped = filtered.skipped;
      note('');
      runScan([]);
    });
  }

  // The engine over the rows in the store. args: more of its arguments, such as --cached-only.
  function runScan(args) {
    var binary = extensionRoot() + '/bin/select-engine';
    var problem = N.engineProblem(binary);
    if (problem) {
      S.scan.state = 'Not scanned';
      S.scan.endedAt = performance.now();
      S.scan.failure = C.engineFailure({ errorCode: problem }, 0);
      endRestore(false);
      renderFoot();
      return;
    }
    // An engine the panel has let go (last results stopped, or past their deadline) is heard no more.
    var paths = S.store.rows.map(function (r) { return r.path; }), sc = S.scan;
    S.scan.handle = N.runEngine(binary, paths, {
      onMessage: function (msg) { if (S.scan === sc) { onEngineLine(msg); } },
      onBad: function () { if (S.scan === sc) { S.store.bad++; S.scan.heard++; scheduleFlush(); } },
      onExit: function (info) { if (S.scan === sc) { onEngineExit(info); } }
    }, args);
    renderFoot();
  }

  // A row as the items a scan starts from: its path, each id it had, each Premiere bin it sits in.
  function rowItems(path, ids, bins) {
    ids = Array.isArray(ids) ? ids.filter(Boolean).map(String) : [];
    bins = Array.isArray(bins) ? bins.filter(function (b) { return typeof b === 'string'; }) : [];
    var out = [{ path: path, id: ids[0] || null, bin: bins[0] || null }];
    ids.slice(1).forEach(function (id) { out.push({ path: path, id: id }); });
    bins.slice(1).forEach(function (b) { out.push({ path: path, bin: b }); });
    return out;
  }

  // ---- a scan asked for just before an update's Restart. Once an update is installed, update.js catches a press of Scan
  // or Rescan, reloads the page, and the new page calls startScan() with nothing. So every press of a scan first notes
  // which one it asks for (select.scanIntent, good for a minute), and startScan() with nothing follows that note once
  // the page knows the project in front and its last results are back. Scan Whole Project and Scan a Folder… go through
  // Scan, so the same catch sees them.
  var INTENT = 'select.scanIntent', INTENT_MS = 60000, KINDS = { scan: 1, same: 1, whole: 1, folder: 1 };
  var pendingScan = null, watched = false, routing = false, routedKind = null;

  function noteIntent(kind) {
    try { localStorage.setItem(INTENT, JSON.stringify({ at: Date.now(), scan: kind })); } catch (e) {}
  }

  // The kind noted in the last minute, or null. Read once: the note goes.
  function takeIntent() {
    var o = null;
    try { o = JSON.parse(localStorage.getItem(INTENT) || 'null'); localStorage.removeItem(INTENT); } catch (e) {}
    return o && typeof o.at === 'number' && Date.now() - o.at < INTENT_MS && KINDS[o.scan] === 1 ? o.scan : null;
  }

  // Runs before update.js's own catch, which listens on the document.
  function wireScanIntent() {
    window.addEventListener('click', function (e) {
      if (routing) { return; }
      var t = e.target && e.target.closest && e.target.closest('#scan, #menu [data-menu="rescan"], #menu [data-menu="scan-whole"], #menu [data-menu="scan-folder"]');
      if (t && !t.disabled) { noteIntent(scanAsked(t)); }
    }, true);
  }

  // Scan Whole Project and Scan a Folder…: noted, then through Scan. On this page Scan's own handler runs that kind.
  function routeScan(kind) {
    noteIntent(kind);
    routedKind = kind;
    routing = true;
    try { $('scan').click(); } finally { routing = false; routedKind = null; }
  }

  function pressScanButton() {
    var kind = routedKind;
    routedKind = null;
    takeIntent();
    if (kind) { runKind(kind); return; }
    startScan(lastFoot && lastFoot.scanWhat === 'same' ? { same: true } : {});
  }

  function runKind(kind) {
    if (kind === 'folder') { scanFolder(); return; }
    startScan(kind === 'whole' ? { whole: true } : kind === 'same' && S.store.rows.length ? { same: true } : {});
  }

  // The kind of scan a press asks for: scan (what the Project panel holds), same (the clips on screen again), whole or
  // folder. A folder's clips aren't kept between pages, so asking for them again opens its dialog again.
  function scanAsked(el) {
    var item = el && el.getAttribute ? el.getAttribute('data-menu') : null;
    if (item === 'scan-whole') { return 'whole'; }
    if (item === 'scan-folder') { return 'folder'; }
    if (item !== 'rescan' && !(lastFoot && lastFoot.scanWhat === 'same')) { return 'scan'; }
    return S.from && !S.from.project ? 'folder' : 'same';
  }

  function scanAfterRestart(kind) {
    pendingScan = kind || 'scan';
    runPending();
  }

  function runPending() {
    if (!pendingScan || !watched || S.restoring || S.listing || S.busy || scanRunning()) { return; }
    var kind = pendingScan;
    pendingScan = null;
    runKind(kind);
  }

  // ---- last results: a project's last scan comes back from the cache when the panel opens on it again

  // Saved at the end of a scan of a project, and a second after the view changes, with the clips' ids and bins and the
  // view. Never for a folder. The search isn't kept.
  var saveLater = null;
  function saveLast() {
    clearTimeout(saveLater);
    saveLater = null;
    var from = S.from;
    if (!N.available || !N.lastResults || !from || !from.project || !S.store.rows.length || S.restoring || scanRunning()) { return; }
    var rows = S.store.rows;
    N.lastResults.save(from.project.path, {
      name: from.project.name, at: S.scannedAt, words: from.words, target: from.target,
      paths: rows.map(function (r) { return r.path; }),
      ids: rows.map(function (r) { return r.ids.slice(0, 8); }),
      binPaths: rows.map(function (r) { return r.binPaths || null; }),
      view: { show: S.view.show, sort: S.view.sort, families: S.view.families }
    });
  }

  // The view moved on: the last results' "Scanned yesterday" goes, and the record keeps the new view.
  function viewMoved() {
    S.lastAt = null;
    clearTimeout(saveLater);
    saveLater = setTimeout(saveLast, 1000);
  }


  // Once per project in front, when nothing on screen belongs to it: its last results, read from the cache only, so
  // nothing is decoded. Clips the cache can't answer say Not read.
  var restoredFor = null;
  function restoreLast() {
    var p = S.project;
    if (!p || !N.available || !N.lastResults || samePath(restoredFor, p.path)) { return; }
    if (scanRunning() || S.listing || S.busy || S.restoring || S.modalOpen) { return; }
    restoredFor = p.path;
    var mine = S.from && (!S.from.project || samePath(S.from.project.path, p.path));
    if (S.store.rows.length && mine) { return; }
    var rec = N.lastResults.load(p.path);
    if (!rec || !rec.paths.length) { return; }
    resetStore();
    // Ids from another session are hints: an open or a write checks each against its path, or looks it up again.
    rec.paths.forEach(function (path, i) {
      if (typeof path !== 'string') { return; }
      C.addItems(S.store, rowItems(path, (rec.ids || [])[i], (rec.binPaths || [])[i]));
    });
    S.store.rows.forEach(function (r) { r.oldIds = true; });
    S.view = C.knownView(rec.view);
    S.history = [];
    S.query = $('search').value = '';
    S.from = { project: { path: rec.project, name: rec.name || p.name }, words: rec.words || '', target: rec.target || null };
    S.scannedAt = rec.at || null;
    S.lastAt = null;
    S.restoring = true;
    // A scan of a selection keeps that promise when it comes back (resolveIds); one of the whole project reaches every copy.
    var t = rec.target, picked = !!(t && !t.whole && (t.kind === 'clips' || t.kind === 'bins'));
    S.scan = { state: 'Scanning', startedAt: performance.now(), endedAt: 0, handle: null, source: picked ? 'selection' : 'project', failure: null, stopping: false, heard: 0, cachedOnly: true };
    applyView();
    runScan(['--cached-only']);
    // A cache on a volume that no longer answers must not hold the panel: past the deadline, as a failed restore.
    restoreLate = setTimeout(stopRestore, TIMEOUT.lastResults);
  }

  // Stop, or the deadline: the cache's answer is dropped at once, and the engine is told to go.
  var restoreLate = null;
  function stopRestore() {
    if (!S.restoring || !S.scan) { return; }
    var h = S.scan.handle;
    S.scan.handle = null;
    endRestore(false);
    if (h) { h.stop(); }
    applyView();
    askWatch();
    runPending();
  }

  // ok: the cache answered, so the results stand, with when they were scanned in the tooltip. Otherwise they go quietly.
  function endRestore(ok) {
    if (!S.restoring) { return; }
    clearTimeout(restoreLate);
    S.restoring = false;
    if (ok) { S.lastAt = S.scannedAt; return; }
    S.store = C.createStore();
    S.scan = null;
    S.from = null;
    S.lastAt = null;
    S.view = { show: null, sort: [], families: [] };
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
    var grew = S.order.length !== S.store.rows.length && !v.show && !v.families.length && !S.tokens.length;
    if (grew || ((v.sort.length || v.show || v.families.length || S.tokens.length) && due)) {
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
      sc.failure = { verdict: 'The scan stopped early', sentence: 'The engine quit before the last clip.' };
    } else {
      sc.state = 'Done';
    }
    if (S.restoring) {
      endRestore(sc.state === 'Done' && st.tier0 + st.notRead + st.errors > 0);
    } else if (st.rows.length && sc.state !== 'Failed' && sc.state !== 'Not scanned') {
      saveLast();
    }
    refreshOthers();
    applyView();
    warmSearch();
    askWatch();
    runPending();
  }

  // The search text for every clip, built while the panel is idle after a scan, so the first keystroke is quick.
  function warmSearch() {
    var rows = S.store.rows, at = 0;
    var idle = window.requestIdleCallback || function (fn) { return setTimeout(function () { var t0 = performance.now(); fn({ timeRemaining: function () { return Math.max(0, 8 - (performance.now() - t0)); } }); }, 50); };
    idle(function step(deadline) {
      if (rows !== S.store.rows || scanRunning()) { return; }
      at = C.warmSearch(rows, at, function () { return deadline.timeRemaining() > 2; });
      // Then the words the suggestions come from, once.
      if (at < rows.length) { idle(step); } else { C.suggestions(rows, ''); }
    });
  }

  // One Stop in the foot: it ends what is running, a write first, then a folder listing, then the scan.
  function pressStop() {
    if (S.write) { S.write.stopping = true; renderFoot(); return; }
    if (S.restoring) { stopRestore(); return; }
    if (S.listWalk) { S.listWalk.stop(); return; }
    stopScan();
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

  // opts: {okTip: the OK button's tooltip, choice: called with a [data-choice] button pressed in the sheet}. A sheet with
  // a name field opens on it, the name selected, and Enter in it is OK.
  function dialog(title, html, okText, cancelText, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      closeMenu();
      closeCtx();
      $('dialog-title').textContent = title;
      $('dialog-body').innerHTML = html;
      var ok = $('dialog-ok'), cancel = $('dialog-cancel'), field = $('dialog-body').querySelector('.field input');
      ok.textContent = okText || 'OK';
      ok.title = opts.okTip || '';
      ok.hidden = okText === null;
      cancel.textContent = cancelText || 'Cancel';
      cancel.hidden = cancelText === null;
      $('modal').hidden = false;
      S.modalOpen = true;
      S.sheetChoice = opts.choice || null;
      if (field) { field.focus(); field.select(); } else { (cancelText === null || opts.okFocus ? ok : cancel).focus(); }
      function done(answer) {
        ok.onclick = cancel.onclick = null;
        ok.hidden = cancel.hidden = false;
        ok.title = '';
        S.sheetChoice = null;
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
      if (p.modal) { return { ok: false, message: 'A Premiere dialog is open.' }; }
      if (p.modal === null) { return { ok: false, message: 'Premiere didn\'t answer. Nothing was written.' }; }
      if (p.program === true || p.source === true) { return { ok: false, message: 'Playback is running.' }; }
      if (p.program !== false || p.source !== false) { return { ok: false, message: 'Premiere didn\'t answer. Nothing was written.' }; }
      return { ok: true, project: r.project };
    });
  }

  // Paths are the identity, not ids. An id is a small counter that means nothing outside the project it came from, so
  // every write and open asks the project in front for its items and matches rows by path. Each row then carries
  // items, [[id, path]] with the path exactly as Premiere gave it, and the host writes an item only while that id still
  // has that path. Rows not found have no items.
  function resolveIds(targets) {
    var paths = [], seen = {};
    targets.forEach(function (t) {
      [t.row.path, t.row.path.normalize('NFC'), t.row.path.normalize('NFD')].forEach(function (p) {
        if (!seen['p' + p]) { seen['p' + p] = true; paths.push(p); }
      });
    });
    return host('find', { paths: paths }).then(function (r) {
      if (!r.ok) { return r; }
      var byKey = new Map();
      r.items.forEach(function (it) {
        var k = C.pathKey(it.path);
        if (!byKey.has(k)) { byKey.set(k, []); }
        byKey.get(k).push({ pair: [String(it.id), it.path], bin: typeof it.bin === 'string' ? it.bin : null });
      });
      // A Selection scan is a promise about which items were picked: a second copy of the media elsewhere stays put,
      // and a picked item that has gone is skipped, never swapped for another copy. Last results carry ids from another
      // session, which may name other items now, so their copies are the ones in the bins the scan found them in (a
      // clip at the top of the project sits in none). Once found, their ids are this session's.
      var picked = S.scan && S.scan.source === 'selection';
      targets.forEach(function (t) {
        var all = byKey.get(t.row.key) || [], found;
        if (!picked) {
          found = all;
        } else if (t.row.oldIds) {
          var bins = t.row.binPaths && t.row.binPaths.length ? t.row.binPaths : [''];
          found = all.filter(function (x) { return x.bin !== null && bins.indexOf(x.bin) !== -1; });
        } else {
          if (!t.row.scanIds) { t.row.scanIds = t.row.ids.map(String); }
          found = all.filter(function (x) { return t.row.scanIds.indexOf(x.pair[0]) !== -1; });
        }
        var pairs = found.map(function (x) { return x.pair; });
        if (picked && t.row.oldIds) { t.row.scanIds = pairs.map(function (p) { return p[0]; }); }
        t.row.oldIds = false;
        t.row.items = pairs;
        t.row.ids = pairs.map(function (p) { return p[0]; });
        t.copies = picked && !pairs.length && all.length > 0;
      });
      return r;
    });
  }

  function failureList(failed) {
    if (!failed || !failed.length) { return ''; }
    var byId = new Map();
    S.store.rows.forEach(function (r) { r.ids.forEach(function (id) { byId.set(String(id), r.name); }); });
    var shown = failed.slice(0, 8).map(function (f) {
      return '<li>' + esc(f.name || byId.get(String(f.id)) || f.id || 'bin') + ': ' + esc(f.error) + '</li>';
    }).join('');
    return '<ul class="fails">' + shown + '</ul>' + (failed.length > 8 ? '<p class="quiet">And ' + fmtInt(failed.length - 8) + ' more.</p>' : '');
  }

  // Measured on 26.5.2: Premiere records at least one undo step per item and reaches only the last 50
  // (BE.Prefs.Undo.MaxLevels), so a batch cannot be taken back with Cmd+Z and it pushes older edits out of History.
  var UNDO_LEVELS = 50;

  // Said only when it matters: a write too big for Cmd+Z.
  function undoText(steps) {
    return steps > UNDO_LEVELS ? '<p class="warn">Too big for Cmd+Z. Undo takes it back.</p>' : '';
  }

  // A write that needs Tier 2 waits for it. Asked twice: when pressed, and again after the sheet, in case the view moved.
  function heldBack(kind) {
    var f = C.footState(footFacts());
    return f.held && f.held.indexOf(kind) >= 0 ? f.wait : '';
  }

  function tier2Landed() {
    return !scanRunning() || C.understandingShare(S.store).landed;
  }

  // ---------------------------------------------------------------- Undo records

  // The records of the project in front, read once per project and again after every write or Undo.
  function undoState() {
    var path = S.project ? S.project.path : null;
    if (!S.undo || !samePath(S.undo.path, path)) { S.undo = loadUndo(path); }
    return S.undo;
  }

  // Project paths compared the way their records' folders are named: macOS may give one path in either Unicode form.
  function samePath(a, b) {
    return a === b || (typeof a === 'string' && typeof b === 'string' && C.pathKey(a) === C.pathKey(b));
  }

  function forgetUndo() { S.undo = null; }

  // The newest record with something left to put back: N.topUndo says which, and what it clears or leaves on disk.
  function loadUndo(path) {
    var mem = S.memoryUndo && samePath(S.memoryUndo.project, path) ? S.memoryUndo : null;
    var found = path && N.available ? N.topUndo(path, S.activeRecord) : { ids: [], top: null };
    var ids = found.ids, top = found.top;
    if (mem && (!top || mem.id > top.id)) { return { path: path, count: ids.length + 1, top: mem }; }
    return { path: path, count: ids.length, top: top };
  }

  // Saves a record, or keeps it in memory when the disk says no. Returns the error, or ''. Older records past
  // C.UNDO_KEEP go once this one has something in it.
  function keepUndo(entry) {
    var keep = entry.restore.items.length ? C.UNDO_KEEP : 0;
    var saved = N.available ? N.saveUndo(entry.project, entry, keep) : { ok: false, error: 'no Node' };
    if (S.memoryUndo && S.memoryUndo.id === entry.id) { S.memoryUndo = saved.ok ? null : entry; } else if (!saved.ok) { S.memoryUndo = entry; }
    forgetUndo();
    return saved.ok ? '' : saved.error;
  }

  function dropRecord(entry) {
    if (S.memoryUndo && S.memoryUndo.id === entry.id) { S.memoryUndo = null; }
    if (N.available) { N.dropUndo(entry.project, entry.id); }
    forgetUndo();
  }

  // ---------------------------------------------------------------- writes

  // Shared route of the writes: preflight, targets, confirmation, lock again, an Undo record on disk, then the
  // host calls in batches of C.BATCH, each one saved to the record as it lands, then the read-back and the foot.
  // spec: {kind, plan(inProject, project), sheet: false skips only the confirmation}. plan.lookup(): more rows the write
  // needs once OK is pressed (an Other bin's), looked up then and only then.
  function runWrite(spec) {
    if (S.busy) { return Promise.resolve(); }
    if (S.hostLate) { note(LATE, 'warn'); return Promise.resolve(); }
    var ready = null, waiting = heldBack(spec.kind);
    if (waiting) { note(waiting, 'warn'); return Promise.resolve(); }
    note('');
    return preflight().then(function (r) {
      if (!r.ok) { note(r.message, 'warn'); return null; }
      // Results are tied to the project they were scanned in: in another one only a fresh scan goes.
      var away = foreignTitle();
      if (away) { note('From ' + away + '.', 'warn'); renderFoot(); return null; }
      ready = r;
      var targets = targetRows();
      return resolveIds(targets).then(function (found) {
        if (found.ok) { return targets; }
        note(found.message, 'warn');
        return null;
      });
    }).then(function (targets) {
      if (!targets) { return; }
      var inProject = targets.filter(function (t) { return t.row.items.length; });
      var gone = targets.filter(function (t) { return !t.row.items.length; });
      if (!inProject.length) { note('None of these clips are in this project.', 'warn'); return; }
      var plan = spec.plan(inProject, ready.project);
      if (!plan) { return; }
      // The title says how many and what; the sheet adds its name field, what is skipped, and the plan.
      var body = (plan.field || '') + (gone.length ? '<p class="warn">' + C.goneLine(gone.length) + '</p>' : '') + plan.html;
      return (spec.sheet === false ? Promise.resolve(true) : dialog(plan.title, body, plan.ok, undefined, plan.sheet)).then(function (yes) {
        if (!yes) { return; }
        var refused = lockRefusal() || heldBack(spec.kind) || (S.busy ? 'Another write is running.' : '') || (S.hostLate ? LATE : '');
        if (refused) { note(refused, 'warn'); return; }
        var more = plan.lookup ? plan.lookup() : [];
        return (more.length ? resolveIds(more.map(function (row) { return { row: row }; })) : Promise.resolve({ ok: true })).then(function (found) {
          if (!found.ok) { note(found.message, 'warn'); return; }
          return writeNow(plan, ready, gone.length);
        });
      });
    });
  }

  // After the sheet: the Undo record on disk, then the batches, then the read-back. gone: picked clips the project doesn't
  // hold, left out; the outcome says so too, as a right-click Label has no sheet to say it.
  function writeNow(plan, ready, gone) {
    if (S.busy) { note('Another write is running.', 'warn'); return; }
    if (plan.confirm) { plan.confirm(); }
    var project = ready.project.path;
    var entry = { v: 1, id: N.available ? N.newUndoId() : String(Date.now()) + '-0000', project: project, at: new Date().toISOString(), kind: plan.fn, meta: plan.meta ? plan.meta() : {}, restore: plan.head() };
    // No write without a way back: the record is on disk before Premiere is asked for anything.
    S.activeRecord = entry.id;
    var unsaved = keepUndo(entry);
    if (unsaved) { S.activeRecord = null; dropRecord(entry); note('Select couldn\'t save its Undo record (' + unsaved + '), so nothing was written.', 'bad'); return; }
    moveOn();
    return writeBatches(plan, entry).then(function (acc) {
      S.activeRecord = null;
      if (!acc.anyOk && acc.error && !acc.landed) {
        dropRecord(entry);
        note(plan.fn === 'sequence' ? C.refusalWords(acc.error) : acc.error, 'bad');
        renderFoot();
        askWatch();
        return;
      }
      S.outcome = C.writeOutcome(plan.fn, plan.sent, acc, plan.word && plan.word());
      if (gone) { S.outcome.sentence = [S.outcome.sentence, C.goneLine(gone)].filter(Boolean).join(' '); }
      if (acc.unsavedUndo) { S.outcome.sentence += ' Undo record not saved: Undo reaches it until the panel reloads.'; }
      renderFoot();
      askWatch();
    });
  }

  // Sends plan.list in batches. Stop takes effect between batches. A refusal or a missed deadline ends the write there,
  // and a batch that answers after its deadline is still added to the record.
  // plan.whole: one call for the whole list, as Make Sequence is.
  function writeBatches(plan, entry) {
    var parts = plan.whole ? [plan.list] : C.batches(plan.list, C.BATCH), acc = C.writeAcc(plan.fn), i = 0;
    S.write = { kind: 'write', verb: plan.verb, unit: 'clip', done: 0, total: plan.list.length, stopping: false, whole: !!plan.whole };
    S.busy = plan.busy;
    renderFoot();
    function land(res) {
      C.addBatch(plan.fn, acc, res);
      var r = res.restore;
      if (r && r.items && r.items.length) {
        entry.restore.items = entry.restore.items.concat(r.items);
        if (r.top) { entry.restore.top = r.top; }
        acc.landed = true;
      }
      var error = keepUndo(entry);
      if (error) { acc.unsavedUndo = true; }
      return error;
    }
    function rest(from) {
      return parts.slice(from).reduce(function (n, p) { return n + p.length; }, 0);
    }
    // write: one id for every batch, so Premiere looks the project up once per write, not once per batch. final: the last
    // batch, after which it lets that go.
    function args(part) {
      var a = plan.args(part, acc, entry.project);
      a.write = entry.id;
      a.final = i === parts.length;
      return a;
    }
    function next() {
      if (i >= parts.length) { return Promise.resolve(); }
      if (S.write.stopping) { acc.unsent = rest(i); return Promise.resolve(); }
      var part = parts[i++];
      return host(plan.fn, args(part), function (late) {
        if (!late.ok) { return; }
        land(late);
        note('Premiere answered late. Undo covers it.', 'warn');
      }).then(function (res) {
        if (!res.ok) { acc.error = res.message; acc.unsent = rest(i - 1); return; }
        acc.anyOk = true;
        var unsaved = land(res);
        S.write.done += part.length;
        renderFoot();
        if (unsaved && i < parts.length) { acc.error = 'Select couldn\'t save its Undo record (' + unsaved + '), so it stopped there.'; acc.unsent = rest(i); return; }
        return next();
      });
    }
    return next().then(function () {
      return plan.finish ? plan.finish(acc, entry.project) : null;
    }).then(function () {
      S.write = null;
      S.busy = null;
      if (!entry.restore.items.length) { dropRecord(entry); }
      return acc;
    });
  }

  // opts: {color, sheet: false}, from the right-click Label: that colour, and no sheet. Everything else stays.
  function doLabel(opts) {
    opts = opts || {};
    var fixed = typeof opts.color === 'number' ? opts.color : null, color = fixed === null ? S.labelColor : fixed;
    function labelName() { return C.LABELS[color][0]; }
    return runWrite({
      kind: 'label',
      sheet: opts.sheet,
      plan: function (targets) {
        var items = [];
        color = fixed === null ? S.labelColor : fixed;
        targets.forEach(function (t) { items = items.concat(t.row.items); });
        var swatches = C.LABELS.map(function (l, i) {
          return '<button data-color="' + i + '" title="' + esc(l[0]) + '" aria-label="' + esc(l[0]) + '"' + (i === color ? ' class="on"' : '') + '><i style="background:' + l[1] + '"></i></button>';
        }).join('');
        return {
          fn: 'label',
          list: items,
          sent: { items: items },
          title: 'Label ' + plural(targets.length, 'clip') + '?',
          html: '<div class="swatches">' + swatches + '</div><p>Label: <b id="label-name">' + esc(labelName()) + '</b></p>' + undoText(items.length),
          ok: 'Label ' + fmtInt(targets.length),
          busy: 'Labelling ' + plural(items.length, 'clip'),
          verb: 'Labelling',
          confirm: function () { if (fixed === null) { color = S.labelColor; } },
          args: function (part, acc, project) { return { project: project, items: part, color: color }; },
          head: function () { return { kind: 'label', color: color, items: [] }; },
          meta: function () { return { label: labelName() }; },
          word: labelName
        };
      }
    });
  }

  // The name field a sheet opens on, its text selected.
  function nameField(value) {
    return '<div class="field"><input id="sheet-name" type="text" spellcheck="false" autocomplete="off" aria-label="Name" value="' + esc(value) + '"></div>';
  }

  function fieldName(fallback) {
    var f = $('sheet-name'), v = f ? f.value.trim() : '';
    return v || fallback;
  }

  function otherOn() {
    try { return localStorage.getItem('select.binsOther') === 'true'; } catch (e) { return false; }
  }

  // Sort into Bins follows the view: several bins (colours, days, fifths, values, similar shots) under one named bin, or
  // one bin for a Show, a colour, a search or picked clips. Other, when the view leaves clips out and nothing is picked,
  // adds a last bin for those clips; its last state is remembered.
  function doBins() {
    var picked = selectedInView(), query = S.query.trim(), kind = C.binsPlan(S.view, query, picked);
    if (!kind) { return Promise.resolve(); }
    var shown = new Set(S.order), offer = !picked && S.order.length < S.store.rows.length;
    // The clips the view leaves out, for Other. Premiere is asked for them only once OK is pressed with Other on.
    var outside = offer ? S.store.rows.filter(function (r) { return !shown.has(r.rowId); }) : [];
    return runWrite({
      kind: 'bins',
      plan: function (targets) {
        var rows = targets.map(function (t) { return t.row; });
        var several = kind === 'several' ? C.bucketize(rows, S.view) : null;
        if (kind === 'several' && !several && !query && !picked) { note('Too many values for bins.', 'warn'); return null; }
        var what = C.viewWhat(S.view, query, picked, S.from && S.from.words), root = 'SELECT ' + C.localDate(new Date()) + ' ' + what;
        var other = offer && outside.length > 0, on = other && otherOn();
        var bucketsFor = function (withOther) {
          var list = several ? several.slice() : [{ name: withOther ? '01 ' + what : root, rows: rows }];
          if (withOther) { list.push({ name: (list.length < 9 ? '0' : '') + (list.length + 1) + ' Other', rows: outside.filter(function (r) { return r.items && r.items.length; }) }); }
          return list;
        };
        var count = function () { return rows.length + (on ? outside.length : 0); };
        var steps = function () { var b = bucketsFor(on); return count() + 2 * (b.length + 1); };
        var words = function () {
          return several || on ? { title: 'Sort ' + plural(count(), 'clip') + ' into bins?', ok: 'Sort into Bins' } : { title: 'Move ' + plural(count(), 'clip') + ' into a bin?', ok: 'Move into Bin' };
        };
        var listed = '';
        if (several) {
          listed = '<ul>' + several.slice(0, 10).map(function (b) { return '<li><span>' + esc(b.name) + '</span><span>' + fmtInt(b.rows.length) + '</span></li>'; }).join('') + '</ul>' +
            (several.length > 10 ? '<p class="quiet">and ' + fmtInt(several.length - 10) + ' more</p>' : '');
        }
        var choice = other ? '<div class="choice"><button type="button" data-choice="other" title="The clips this view leaves out" aria-pressed="' + on + '"' + (on ? ' class="on"' : '') + '>Other bin<span>' + fmtInt(outside.length) + '</span></button></div>' : '';
        var plan = {
          fn: 'bins',
          title: words().title,
          field: nameField(root),
          html: listed + choice + '<div id="bins-undo">' + undoText(steps()) + '</div>',
          ok: words().ok,
          sheet: {
            choice: function (button) {
              on = !on;
              try { localStorage.setItem('select.binsOther', on ? 'true' : 'false'); } catch (e) {}
              button.classList.toggle('on', on);
              button.setAttribute('aria-pressed', on ? 'true' : 'false');
              $('dialog-title').textContent = words().title;
              $('dialog-ok').textContent = words().ok;
              $('bins-undo').innerHTML = undoText(steps());
            }
          },
          verb: 'Moving',
          lookup: function () { return on ? outside : []; },
          // The name and Other as they are when OK is pressed. Without sub-bins, the one bin is the top bin itself.
          confirm: function () {
            root = fieldName(root);
            var buckets = bucketsFor(on), single = !several && !on, list = [];
            if (single) { buckets[0].name = root; }
            var sent = buckets.map(function (b) {
              var items = [];
              b.rows.forEach(function (r) { items = items.concat(r.items); });
              items.forEach(function (pair) { list.push({ name: b.name, pair: pair }); });
              return { name: b.name, items: items };
            });
            plan.list = list;
            plan.sent = { buckets: sent, single: single };
            plan.single = single;
            plan.busy = 'Moving ' + plural(list.length, 'clip');
          },
          args: function (part, acc, project) {
            var a = { project: project, root: root, buckets: C.groupMoves(part) };
            if (plan.single) { a.single = true; }
            if (acc.top) { a.top = acc.top; }
            return a;
          },
          // Read back once, at the end: what each bin holds now. With nothing moved, the empty bins go.
          finish: function (acc, project) {
            if (!acc.top) { return null; }
            var a = { project: project, top: acc.top, clear: !acc.moved };
            if (plan.single) { a.single = true; a.name = root; }
            return host('binsCheck', a).then(function (res) {
              if (res.ok) { acc.buckets = res.buckets; acc.binRemoved = res.binRemoved; }
            });
          },
          head: function () { return { kind: 'bins', top: null, items: [] }; },
          meta: function () { return { root: root }; }
        };
        return plan;
      }
    });
  }

  // Make Sequence: the clips picked on screen, else every clip on screen, in the order shown, as one new sequence at the
  // top of the project, opened in the Timeline. Premiere takes its settings from the first clip.
  var MOST_SEQUENCE = 2000;

  function settingsWords(row) {
    var size = row.width && row.height ? row.width + '\u00d7' + row.height : '', fps = typeof row.fps === 'number' && row.fps > 0 ? Number(row.fps.toFixed(2)) + ' fps' : '';
    return [size, fps].filter(Boolean).concat('from the first clip').join(', ');
  }

  function doSequence() {
    if (targetRows().length > MOST_SEQUENCE) { note('At most ' + fmtInt(MOST_SEQUENCE) + ' clips in a sequence.', 'warn'); return Promise.resolve(); }
    var name = C.sequenceName(S.view, S.query, selectedInView(), S.from && S.from.words);
    return runWrite({
      kind: 'sequence',
      plan: function (targets) {
        // One master clip per row, the first the project has for its file.
        var items = targets.map(function (t) { return t.row.items[0]; });
        return {
          fn: 'sequence',
          whole: true,
          list: items,
          sent: { items: items },
          title: 'Make a sequence of ' + plural(targets.length, 'clip') + '?',
          field: nameField(name),
          html: '',
          ok: 'Make Sequence',
          sheet: { okTip: settingsWords(targets[0].row) },
          busy: 'Making a sequence of ' + plural(items.length, 'clip'),
          verb: 'Making a sequence of',
          confirm: function () { name = fieldName(name); },
          args: function (part, acc, project) { return { project: project, name: name, items: part, open: true }; },
          head: function () { return { kind: 'sequence', items: [] }; },
          meta: function () { return { name: name }; }
        };
      }
    });
  }

  // ---------------------------------------------------------------- Undo

  // Reverses the newest record of the project in front, with the same read-back as the write had, in batches too.
  function doUndoWrite() {
    if (S.busy) { return Promise.resolve(); }
    if (S.hostLate) { note(LATE, 'warn'); return Promise.resolve(); }
    note('');
    return preflight().then(function (r) {
      if (!r.ok) { note(r.message, 'warn'); return; }
      var u = undoState(), entry = u.top;
      if (!entry) { note('Nothing to undo in this project.'); return; }
      // When it was made, only when that wasn't today.
      var when = C.isToday(entry.at) ? '' : '<p class="quiet">' + esc(C.whenLine(entry.at, undefined, 'Made')) + '.</p>';
      // The editor pressed Undo to get here: Enter confirms it, Escape cancels.
      return dialog('Undo?', '<p>' + esc(C.undoWords(entry)) + '</p>' + when, 'Undo', undefined, { okFocus: true }).then(function (yes) {
        if (!yes) { return; }
        var refused = lockRefusal() || (S.busy ? 'Another write is running.' : '') || (S.hostLate ? LATE : '');
        if (refused) { note(refused, 'warn'); return; }
        S.outcome = null;
        return undoBatches(entry, r.project.path).then(function (acc) {
          var gaveUp = false;
          if (!acc.left.length) {
            dropRecord(entry);
          } else if (!acc.restored && !acc.unsent && !acc.error) {
            // Everything tried failed: keeping it would block every write before it.
            dropRecord(entry);
            gaveUp = true;
          } else {
            entry.restore.items = acc.left;
            keepUndo(entry);
          }
          var after = undoState();
          S.outcome = C.undoOutcome(acc, entry.kind);
          if (gaveUp) { S.outcome.sentence += after.top ? ' Undo moves on to the write before.' : ''; }
          renderFoot();
          askWatch();
        });
      });
    });
  }

  // project: the path Premiere gives for the project in front now. It's the record's project, maybe in the other Unicode
  // form, and Premiere's own check compares the text.
  function undoBatches(entry, project) {
    var r = entry.restore, parts = C.batches(r.items, C.BATCH), i = 0;
    var acc = { restored: 0, skipped: 0, failed: [], left: [], unsent: 0, error: '', binRemoved: null };
    S.write = { kind: 'undo', verb: 'Putting back', unit: 'item', done: 0, total: r.items.length, stopping: false };
    S.busy = 'Putting back ' + plural(r.items.length, 'item');
    renderFoot();
    function head(items) {
      var o = { kind: r.kind, items: items };
      if (r.color !== undefined) { o.color = r.color; }
      // A record left by Add Columns in 0.2 or 0.3 names its fields.
      if (r.fields) { o.fields = r.fields; }
      if (r.top) { o.top = r.top; }
      if (r.bin) { o.bin = r.bin; }
      return o;
    }
    function waiting(from) {
      return parts.slice(from).reduce(function (all, p) { return all.concat(p); }, []);
    }
    // What is left goes back to disk after every batch, so a reload part way never puts anything back twice.
    function record(from) {
      entry.restore.items = acc.left.concat(waiting(from));
      keepUndo(entry);
    }
    function next() {
      if (i >= parts.length) { return Promise.resolve(); }
      if (S.write.stopping) {
        var rest = waiting(i);
        acc.unsent = rest.length;
        acc.left = acc.left.concat(rest);
        return Promise.resolve();
      }
      var part = parts[i++];
      return host('restore', { project: project || entry.project, restore: head(part), final: i === parts.length, write: 'undo-' + entry.id }).then(function (res) {
        if (!res.ok) {
          var rest = waiting(i - 1);
          acc.error = res.message;
          acc.unsent = rest.length;
          acc.left = acc.left.concat(rest);
          return;
        }
        acc.restored += res.restored || 0;
        acc.skipped += res.skipped || 0;
        if (res.note && !acc.note) { acc.note = String(res.note); }
        acc.failed = acc.failed.concat(res.failed || []);
        if (res.remaining) { acc.left = acc.left.concat(res.remaining.items); }
        if (res.binRemoved !== null && res.binRemoved !== undefined) { acc.binRemoved = res.binRemoved; }
        S.write.done += part.length;
        if (i < parts.length) { record(i); }
        renderFoot();
        return next();
      });
    }
    return next().then(function () {
      S.write = null;
      S.busy = null;
      return acc;
    });
  }

  function showDetails() {
    var o = S.outcome;
    if (!o) { return Promise.resolve(); }
    return dialog('What didn\'t land', '<p>' + esc(o.sentence) + '</p>' + failureList(o.failed), 'OK', null);
  }

  // ---------------------------------------------------------------- open in the Source Monitor

  // Why a clip can't be opened or revealed in the project now, or ''.
  function openRefusal() {
    return lockRefusal() || (S.busy ? 'A write is running.' : '') || (S.hostLate ? LATE : '') || tieRefusal();
  }

  // Results belong to the project they were scanned in. Asked again once Premiere has said which project is in front:
  // the watch that would have told the panel may still be on its way.
  function tieRefusal() {
    var away = foreignTitle();
    return away ? 'From ' + away + '.' : '';
  }

  // The project in front after refreshProject, or null once the reason has been said.
  function frontProject(st) {
    if (!st.ok || !st.project) { note(st.message || 'No project is open.', 'warn'); return null; }
    var tie = tieRefusal();
    if (tie) { note(tie, 'warn'); return null; }
    return st.project;
  }

  // By the id the scan gave first: Premiere looks for that one path, not the whole project. Only when that clip has gone
  // does the panel look again, in both Unicode forms, and offer to import it. Nothing is said when it opens: the Source
  // Monitor shows it.
  function openRow(row) {
    var refused = openRefusal();
    if (refused) { note(refused, 'warn'); return Promise.resolve(); }
    return refreshProject().then(function (st) {
      if (!frontProject(st)) { return; }
      var known = knownPair(row);
      return (known ? openId(known, st.project, true) : Promise.resolve(null)).then(function (res) {
        if (res && (res.ok || res.code !== 'not-found')) { return; }
        return resolveIds([{ row: row }]).then(function (found) {
          if (!found.ok) { note(found.message, 'warn'); return; }
          if (row.items.length) { return openId(row.items[0], st.project); }
          return offerImport(row, st.project);
        });
      });
    });
  }

  function knownPair(row) {
    return row.items && row.items.length ? row.items[0] : row.ids.length ? [row.ids[0], row.path] : null;
  }

  // pair: [id, path]. Says only what went wrong, and not a clip not found when quietMissing: openRow looks for it again.
  function openId(pair, project, quietMissing) {
    return host('open', { project: project.path, id: pair[0], path: pair[1] }).then(function (res) {
      if (!res.ok && (res.code !== 'not-found' || !quietMissing)) { note(res.message, 'warn'); }
      return res;
    });
  }

  // Several clips: the first 20, opened last to first so the first on screen ends in front. Those whose ids have gone are
  // looked up again in one call; one not in the project is said, not offered for import.
  var MOST_OPEN = 20;
  function openRows(rows) {
    if (rows.length === 1) { return openRow(rows[0]); }
    var refused = openRefusal();
    if (refused) { note(refused, 'warn'); return Promise.resolve(); }
    rows = rows.slice(0, MOST_OPEN);
    return refreshProject().then(function (st) {
      if (!frontProject(st)) { return; }
      var missing = [];
      var openAll = function (list, quiet) {
        return list.slice().reverse().reduce(function (p, row) {
          return p.then(function () {
            var pair = knownPair(row);
            if (!pair) { missing.push(row); return null; }
            return host('open', { project: st.project.path, id: pair[0], path: pair[1] }).then(function (res) {
              if (res.ok) { return; }
              if (res.code === 'not-found' && quiet) { missing.push(row); return; }
              note(res.message, 'warn');
            });
          });
        }, Promise.resolve());
      };
      return openAll(rows, true).then(function () {
        if (!missing.length) { return; }
        var again = missing.slice();
        missing = [];
        return resolveIds(again.map(function (row) { return { row: row }; })).then(function (found) {
          if (!found.ok) { note(found.message, 'warn'); return; }
          var back = again.filter(function (row) { return row.items.length; }), lost = again.filter(function (row) { return !row.items.length; });
          // Opened again, the first on screen goes last so it stays in front.
          var order = back.concat(back.length && back.indexOf(rows[0]) === -1 && rows[0].items && rows[0].items.length ? [rows[0]] : []);
          return openAll(order, false).then(function () {
            if (lost.length) { note(lost.length === 1 ? lost[0].name + ' isn\'t in this project.' : plural(lost.length, 'clip') + ' aren\'t in this project.', 'warn'); }
          });
        });
      });
    });
  }

  function offerImport(row, project) {
    return dialog('Import ' + row.name + '?', '', 'Import and Open', undefined, { okTip: 'Into the bin ' + IMPORT_BIN }).then(function (yes) {
      if (!yes) { return; }
      var refused = lockRefusal();
      if (refused) { note(refused, 'warn'); return; }
      return host('importClips', { project: project.path, paths: [row.path], bin: IMPORT_BIN }).then(function (res) {
        if (!res.ok) { note(res.message, 'bad'); return; }
        var hit = res.items.filter(function (it) { return C.pathKey(it.path) === row.key; })[0];
        if (!hit) { note('Premiere did not import ' + row.name + '.', 'bad'); return; }
        row.ids = [String(hit.id)];
        row.items = [[String(hit.id), hit.path]];
        if (row.scanIds) { row.scanIds.push(String(hit.id)); }
        askWatch();
        return openId(row.items[0], project);
      });
    });
  }

  // Selects the clips in the Project panel. Rows this session hasn't looked up yet are, in one call. At most 50: any
  // panel bound to Premiere's selection event is called back once per clip with the selection so far, so the cost grows
  // with the square of the count (40 clips took 5 s, 500 took 13 minutes). Above that the menu item is off.
  var MOST_REVEAL = 50;
  function revealRows(rows) {
    var refused = openRefusal();
    if (refused) { note(refused, 'warn'); return Promise.resolve(); }
    return refreshProject().then(function (st) {
      if (!frontProject(st)) { return; }
      // Ids from this session's scan are Premiere's own; the host checks each against its path anyway.
      var unknown = rows.filter(function (r) { return !(r.items && r.items.length) && (r.oldIds || !r.ids.length); });
      return (unknown.length ? resolveIds(unknown.map(function (r) { return { row: r }; })) : Promise.resolve({ ok: true })).then(function (found) {
        if (!found.ok) { note(found.message, 'warn'); return; }
        var items = [];
        rows.forEach(function (r) {
          if (r.items && r.items.length) { items.push(r.items[0]); } else if (!r.oldIds && r.ids.length) { items.push([r.ids[0], r.path]); }
        });
        if (!items.length) { note(rows.length === 1 ? rows[0].name + ' isn\'t in this project.' : 'None of these clips are in this project.', 'warn'); return; }
        return host('reveal', { project: st.project.path, items: items.slice(0, MOST_REVEAL) }).then(function (res) {
          if (!res.ok) { note(res.message, 'warn'); }
          askWatch();
        });
      });
    });
  }

  // In the Finder, every one selected: the first 20 on disk.
  function finderRows(rows) {
    var paths = rows.map(function (r) { return r.path; });
    if (!N.available || !N.revealInFinder) { return; }
    N.revealInFinder(engineBinary(), paths, function (err, shown) {
      if (err) { note('The Finder didn\'t answer: ' + err.message, 'warn'); return; }
      if (!shown) { note(rows.length === 1 ? rows[0].name + ' is missing or offline.' : 'These clips are missing or offline.', 'warn'); }
    });
  }

  // ---------------------------------------------------------------- wiring

  // ··· › Scan a Folder…: the folder dialog, then a scan of it. Nothing about it is kept.
  function scanFolder() {
    if (!N.available) { note('No folder dialog here.', 'warn'); return; }
    N.pickFolder('Choose a folder to scan', '', function (err, path) {
      if (err) { note('The folder dialog failed: ' + err.message, 'warn'); return; }
      if (path) { startScan({ folder: path }); }
    });
  }

  // Follows Premiere's brightness: dark tokens when dark, light tokens when set bright.
  function applyHostTheme() {
    if (!window.__adobe_cep__) { return; }
    try {
      var skin = JSON.parse(window.__adobe_cep__.getHostEnvironment()).appSkinInfo, color = skin.panelBackgroundColor.color;
      var root = document.documentElement, t = C.skinTokens(color);
      root.dataset.theme = C.themeFor(color);
      // The panel's ground is Premiere's own grey, whatever brightness the editor chose.
      ['surface', 'foot', 'disc', 'track', 'ring', 'ink2', 'bad', 'ink3', 'focus-ring', 'safe-ink', 'band', 'edge', 'sel', 'warn'].forEach(function (k) { if (t) { root.style.setProperty('--' + k, t[k]); } else { root.style.removeProperty('--' + k); } });
    } catch (e) {}
  }

  // ---------------------------------------------------------------- the panel's look: Premiere's font, one set of icons

  // Every icon on the page from the one set: inline in each [data-icon] element, and as --icon-<name> for the masks the
  // stylesheet draws before a note or a menu item.
  function paintIcons() {
    var root = document.documentElement;
    Object.keys(C.ICONS).forEach(function (name) { root.style.setProperty('--icon-' + name, C.iconUrl(name)); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-icon]'), function (el) { el.innerHTML = C.iconSvg(el.dataset.icon); });
  }

  // Premiere's own font, which it ships in its own folder and names in the skin (Adobe Clean, 12 px), loaded from there
  // at each start: nothing of it ships with Select. Node reads the files and FontFace takes the bytes, as @font-face
  // would, so no file:// rule of CEP's Chromium stands in the way. Missing or unreadable, the page keeps the Mac's own
  // font. html[data-font] says which one is in use.
  var FONT_FACES = [['Regular', '400', 'normal'], ['Bold', '700', 'normal'], ['It', '400', 'italic'], ['BoldIt', '700', 'italic']];
  function hostFontDir() {
    var cep = window.__adobe_cep__;
    if (!cep || !cep.getSystemPath) { return null; }
    try {
      var at = decodeURI(String(cep.getSystemPath('hostApplication') || '')).replace(/^file:\/\//, '');
      var m = /^(\/.*\.app\/Contents)\/MacOS\/[^/]+$/.exec(at);
      return m ? m[1] + '/Resources/ttf/' : null;
    } catch (e) { return null; }
  }

  function hostFontStem() {
    try {
      var family = JSON.parse(window.__adobe_cep__.getHostEnvironment()).appSkinInfo.baseFontFamily;
      var m = /^([A-Za-z0-9]+)-Regular$/.exec(String(family || ''));
      return m ? m[1] : 'AdobeClean';
    } catch (e) { return 'AdobeClean'; }
  }

  function loadHostFont() {
    var root = document.documentElement, dir = hostFontDir();
    root.dataset.font = 'system';
    if (!dir || !N.available || !N.readFile || !window.FontFace || !document.fonts) { return Promise.resolve(false); }
    var stem = hostFontStem();
    var read = function (file) {
      return new Promise(function (resolve) {
        try { N.readFile(dir + file, function (err, buf) { resolve(err || !buf || !buf.length ? null : buf); }); } catch (e) { resolve(null); }
      });
    };
    return Promise.all(FONT_FACES.map(function (f) { return read(stem + '-' + f[0] + '.ttf'); })).then(function (bufs) {
      // Regular and Bold are what the panel uses; without both, none.
      if (!bufs[0] || !bufs[1]) { return false; }
      var faces = [];
      bufs.forEach(function (buf, i) {
        if (!buf) { return; }
        var bytes = new Uint8Array(buf.byteLength);
        bytes.set(buf);
        try { faces.push(new FontFace('SelectUI', bytes.buffer, { weight: FONT_FACES[i][1], style: FONT_FACES[i][2] })); } catch (e) {}
      });
      return Promise.all(faces.map(function (face) { return face.load().then(function () { return face; }, function () { return null; }); }));
    }).then(function (loaded) {
      if (!loaded || !loaded[0] || !loaded[1]) { return false; }
      loaded.forEach(function (face) { if (face) { document.fonts.add(face); } });
      root.dataset.font = 'host';
      // New widths: the one-line rules measure again.
      fitFoot();
      fitBand();
      return true;
    }, function () { return false; });
  }

  // ---------------------------------------------------------------- the menu

  function closeMenu() {
    $('menu').hidden = true;
    $('more').setAttribute('aria-expanded', 'false');
  }

  // While a write or an Undo runs, nothing here may start another, or reach for the record being written. Each
  // item shows only where it applies: Stop Scan while a write's result hides the band's Stop; Rescan with results; Scan Whole Project unless Scan already offers the whole
  // project (nothing selected, and no results yet, another project's, or this whole project's); Columns… in the list.
  function openMenu(mouse) {
    var scanning = !!(S.listing || S.restoring || (S.scan && S.scan.handle)), busy = !!S.busy, u = undoState(), rows = S.store.rows.length;
    var item = function (id) { return document.querySelector('#menu [data-menu="' + id + '"]'); };
    var title = $('menu-title'), t = S.target;
    title.textContent = S.project ? projectTitle(S.project) : 'No project open';
    title.title = S.project ? S.project.path : '';
    // Stop Scan only while a scan runs that the band's Stop doesn't reach: a write's result has the band meanwhile.
    item('stop-scan').hidden = !scanning || busy || !!(lastBand && lastBand.actions.indexOf('stop') >= 0);
    item('rescan').hidden = !rows;
    item('rescan').disabled = scanning || busy;
    item('rescan').title = rows ? 'The same ' + plural(rows, 'clip') : '';
    item('scan-whole').hidden = !S.project || !t || (t.kind === 'project' && (!rows || !!foreignTitle() || C.wholeResults(S.from, S.project)));
    item('scan-whole').disabled = scanning || busy;
    item('scan-whole').title = S.whole && S.project && samePath(S.whole.path, S.project.path) ? plural(S.whole.n, 'clip') : '';
    item('scan-folder').disabled = scanning || busy;
    item('columns').hidden = S.mode !== 'list';
    item('undo-view').hidden = !S.history.length;
    item('undo').hidden = !u.top;
    item('undo').disabled = scanning || busy;
    item('undo').title = u.top ? C.undoWords(u.top) : '';
    item('clear').hidden = !rows;
    item('clear').disabled = scanning || busy;
    var mid = ['columns', 'undo-view', 'undo', 'clear'].some(function (id) { return !item(id).hidden; });
    document.querySelector('#menu hr[data-mid]').hidden = !mid;
    $('menu').hidden = false;
    $('more').setAttribute('aria-expanded', 'true');
    var first = menuItems()[0];
    if (first && !mouse) { first.focus(); }
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
    S.from = null;
    S.lastAt = null;
    S.others = 0;
    S.outcome = null;
    S.view = { show: null, sort: [], families: [] };
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
    var version = S.runningVersion;
    return dialog('About Select', '<p>' + (version ? 'Version ' + esc(version) : 'Version unknown') + '</p><p class="quiet">Everything runs on this Mac. Once a day Select asks GitHub for a new version.</p>', 'Done', null);
  }

  var MENU = {
    'stop-scan': pressStop,
    rescan: function () { takeIntent(); startScan({ same: true }); },
    'scan-whole': function () { routeScan('whole'); },
    'scan-folder': function () { routeScan('folder'); },
    columns: showColumns, 'undo-view': undoView, undo: doUndoWrite, clear: clearResults, bug: reportBug, about: showAbout
  };

  // ---------------------------------------------------------------- right-click menu

  // On a clip, a menu of what acts on it, or on every picked clip when it is one of them: as on macOS, a right-click on a
  // clip not picked picks it alone first. Anywhere else no menu, so Chromium's own (Reload, View Page Source, Print)
  // never shows. Text fields keep theirs, for Cut, Copy and Paste.
  var CHEV = '<i class="sub">' + C.iconSvg('chevron-right') + '</i>';
  // Above this many clips the right-click Label opens the Label sheet, which says when a write is too big for Cmd+Z.
  var LABEL_SHEET_FROM = 50, SUB_OPEN_MS = 120, SUB_CLOSE_MS = 300;

  function isTextField(el) {
    return !!(el && el.closest && el.closest('input, textarea, [contenteditable="true"]'));
  }

  function onContextMenu(e) {
    if (isTextField(e.target)) { return; }
    e.preventDefault();
    if (mq && mq.on) { return; }
    var at = e.target && e.target.closest && e.target.closest('#grid') ? rowAt(e.target) : -1;
    if (at < 0 || S.modalOpen) { closeCtx(); return; }
    if (typeof stopScrub === 'function') { stopScrub(); }
    var id = S.order[at];
    if (!S.selected.has(id)) {
      S.selected.clear();
      S.selected.add(id);
      S.anchor = id;
      moveOn();
      note('');
      renderItems();
      renderFoot();
    }
    openCtx(e.clientX, e.clientY);
  }

  // items: '-', or {id, label, off: why it is disabled, sub, sw: a swatch colour}. No title: the menu starts with what
  // it does, on the clips just picked.
  function ctxMenu(items, cls) {
    var m = document.createElement('div');
    m.className = 'ctx' + (cls ? ' ' + cls : '');
    m.setAttribute('role', 'menu');
    items.forEach(function (it) {
      if (it === '-') { m.appendChild(document.createElement('hr')); return; }
      var b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      b.dataset.ctx = it.id;
      if (it.off) { b.disabled = true; b.title = it.off; }
      if (it.sub) { b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false'); }
      b.innerHTML = (it.sw ? '<i class="sw" style="background:' + it.sw + '"></i>' : '') + '<span>' + esc(it.label) + '</span>' + (it.sub ? CHEV : '');
      m.appendChild(b);
    });
    $('app').appendChild(m);
    return m;
  }

  // Its corner at the pointer, turned to stay 6 px inside the panel.
  function placeAt(m, x, y) {
    var box = $('app').getBoundingClientRect(), own = m.getBoundingClientRect(), w = Math.ceil(own.width), h = Math.ceil(own.height);
    var left = x - box.left + 1, top = y - box.top + 1;
    if (left + w > box.width - 6) { left = Math.max(6, x - box.left - w - 1); }
    if (top + h > box.height - 6) { top = Math.max(6, box.height - 6 - h); }
    m.style.left = left + 'px';
    m.style.top = top + 'px';
  }

  function openCtx(x, y) {
    closeCtx();
    var rows = targetRows().map(function (t) { return t.row; });
    if (!rows.length) { return; }
    var f = lastFoot || {}, away = foreignTitle();
    var off = S.busy ? 'A write is running' : !S.project ? 'No project open' : away ? 'From ' + away : '';
    var held = off || ((f.held || []).length ? 'Waits for looking closer' : '');
    var many = function (most) { return rows.length > most ? 'At most ' + fmtInt(most) + ' clips' : ''; };
    var m = ctxMenu([
      { id: 'open', label: 'Open in Source Monitor', off: off },
      { id: 'reveal', label: 'Reveal in Project', off: off || many(MOST_REVEAL) },
      { id: 'finder', label: 'Reveal in Finder', off: N.available && N.onDisk && N.onDisk(rows.map(function (r) { return r.path; })).length ? '' : 'Missing or offline' },
      '-',
      { id: 'label', label: 'Label', sub: true, off: held },
      '-',
      { id: 'sequence', label: 'Make Sequence…', off: held || many(MOST_SEQUENCE) }
    ]);
    placeAt(m, x, y);
    S.ctx = { el: m, sub: null, rows: rows, ids: rows.map(function (r) { return r.rowId; }), openSoon: null, closeSoon: null };
    m.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || b.disabled) { return; }
      if (b.dataset.ctx === 'label') { openSub(); return; }
      ctxDo(b.dataset.ctx);
    });
    m.addEventListener('mouseover', function (e) {
      var b = e.target.closest('button'), c = S.ctx;
      if (!c || !b) { return; }
      clearTimeout(c.openSoon);
      clearTimeout(c.closeSoon);
      // Resting on Label opens its colours; resting on another item closes them.
      if (b.dataset.ctx === 'label' && !b.disabled) { c.openSoon = setTimeout(openSub, SUB_OPEN_MS); } else if (c.sub) { c.openSoon = setTimeout(closeSub, SUB_OPEN_MS); }
    });
    m.addEventListener('mouseleave', leftCtx);
  }

  // The colours stay while the pointer travels to them, and go a moment after it has left both menus.
  function leftCtx() {
    var c = S.ctx;
    if (!c || !c.sub) { return; }
    clearTimeout(c.closeSoon);
    c.closeSoon = setTimeout(closeSub, SUB_CLOSE_MS);
  }

  // Label's colours: two columns of 8, Premiere's order down each, 4 px beside the menu. With no room on either side,
  // over the menu's right part, inside the panel.
  function openSub(focus) {
    var c = S.ctx;
    if (!c) { return; }
    var label = c.el.querySelector('[data-ctx="label"]');
    if (!label || label.disabled) { return; }
    if (!c.sub) {
      var sub = ctxMenu(C.LABELS.map(function (l, i) { return { id: 'color-' + i, label: l[0], sw: l[1] }; }), 'labels two');
      var box = $('app').getBoundingClientRect(), r = c.el.getBoundingClientRect(), row = label.getBoundingClientRect(), own = sub.getBoundingClientRect(), w = Math.ceil(own.width), h = Math.ceil(own.height);
      var left = r.right - box.left + 4, top = row.top - box.top - 5;
      if (left + w > box.width - 6) { left = r.left - box.left - w - 4; }
      if (left < 6) { left = Math.max(6, box.width - 6 - w); }
      if (top + h > box.height - 6) { top = Math.max(6, box.height - 6 - h); }
      sub.style.left = left + 'px';
      sub.style.top = top + 'px';
      sub.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (b) { labelFromCtx(Number(b.dataset.ctx.slice(6))); }
      });
      sub.addEventListener('mouseover', function () { clearTimeout(c.closeSoon); clearTimeout(c.openSoon); });
      sub.addEventListener('mouseleave', leftCtx);
      c.sub = sub;
      label.setAttribute('aria-expanded', 'true');
    }
    if (focus) { c.sub.querySelector('button').focus(); }
  }

  function closeSub() {
    var c = S.ctx;
    if (!c || !c.sub) { return; }
    c.sub.remove();
    c.sub = null;
    var label = c.el.querySelector('[data-ctx="label"]');
    if (label) { label.setAttribute('aria-expanded', 'false'); }
  }

  function closeCtx() {
    var c = S.ctx;
    if (!c) { return; }
    clearTimeout(c.openSoon);
    clearTimeout(c.closeSoon);
    closeSub();
    c.el.remove();
    S.ctx = null;
  }

  // A colour labels the clips at once, with everything a write keeps but the sheet. Past 50 clips the sheet opens on it.
  function labelFromCtx(color) {
    var n = S.ctx ? S.ctx.rows.length : 0;
    closeCtx();
    if (n > LABEL_SHEET_FROM) { S.labelColor = color; return doLabel(); }
    return doLabel({ color: color, sheet: false });
  }

  function ctxDo(id) {
    var rows = S.ctx ? S.ctx.rows : [];
    closeCtx();
    if (id === 'open') { return openRows(rows); }
    if (id === 'reveal') { return revealRows(rows); }
    if (id === 'finder') { return finderRows(rows); }
    if (id === 'sequence') { return doSequence(); }
  }

  // The menu goes when its clips leave the view.
  function ctxStillShown() {
    var c = S.ctx;
    if (!c) { return; }
    var shown = new Set(S.order);
    if (!c.ids.every(function (id) { return shown.has(id); })) { closeCtx(); }
  }

  // Keys: up and down, right opens Label's colours, left closes them, Enter, and Escape (the colours, then the menu).
  function ctxKey(e) {
    var c = S.ctx;
    if (!c) { return false; }
    var inSub = !!(c.sub && c.sub.contains(document.activeElement)), menu = inSub ? c.sub : c.el;
    var items = Array.prototype.filter.call(menu.querySelectorAll('button'), function (b) { return !b.disabled; }), at = items.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      if (c.sub) { closeSub(); var l = c.el.querySelector('[data-ctx="label"]'); if (l) { l.focus(); } } else { closeCtx(); }
      return true;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) { items[(at + (e.key === 'ArrowDown' ? 1 : (at < 0 ? 0 : -1)) + items.length) % items.length].focus(); }
      return true;
    }
    if (e.key === 'ArrowRight' && !inSub && document.activeElement && document.activeElement.dataset.ctx === 'label') { e.preventDefault(); openSub(true); return true; }
    if (e.key === 'ArrowLeft' && inSub) { e.preventDefault(); closeSub(); var back = c.el.querySelector('[data-ctx="label"]'); if (back) { back.focus(); } return true; }
    if (e.key === 'Enter' && at >= 0) {
      e.preventDefault();
      var b = items[at];
      if (inSub) { labelFromCtx(Number(b.dataset.ctx.slice(6))); } else if (b.dataset.ctx === 'label') { openSub(true); } else { ctxDo(b.dataset.ctx); }
      return true;
    }
    return true;
  }

  function wireContext() {
    document.addEventListener('contextmenu', onContextMenu);
    $('grid').addEventListener('scroll', function () { if (!keptScroll()) { closeCtx(); } }, { passive: true });
    window.addEventListener('blur', closeCtx);
  }

  function init() {
    // The version this page was loaded from. An update can put a newer one on disk before Restart, and About must say what runs.
    S.runningVersion = N.available ? N.manifestVersion(extensionRoot()) : null;
    applyHostTheme();
    paintIcons();
    loadHostFont();
    buildBar();

    var mode = null;
    try {
      // 0.3 remembered where the last scan came from. Nothing about the source is kept now.
      localStorage.removeItem('select.source');
      localStorage.removeItem('select.folder');
      mode = localStorage.getItem('select.mode');
      S.shownColumns = JSON.parse(localStorage.getItem('select.columns') || '{}') || {};
    } catch (e) {}

    // Scan reads what the status says: the Project panel's target, or the clips on screen again.
    $('scan').onclick = pressScanButton;
    $('stop').onclick = pressStop;
    $('mode-list').onclick = function () { setMode('list'); };
    $('mode-grid').onclick = function () { setMode('grid'); };
    $('search').addEventListener('input', onSearch);
    $('search').addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && closeSuggest()) { e.stopPropagation(); return; }
      if (e.key === 'Escape' && S.query) { e.stopPropagation(); clearSearch(); }
    });
    $('search-clear').onclick = function (e) { e.preventDefault(); clearSearch(); $('search').focus(); };
    // A press on the clear button keeps the field focused, so it stays open for the next word.
    $('search-clear').addEventListener('mousedown', function (e) { e.preventDefault(); });
    $('search-box').addEventListener('mousedown', function (e) {
      if (!$('search-box').classList.contains('open')) { e.preventDefault(); openSearch(false); }
    });
    $('search').addEventListener('focus', function () { if (!$('search-box').classList.contains('open')) { openSearch(false); } });
    $('search').addEventListener('blur', function () { setTimeout(closeSearchSoon, 120); });
    document.addEventListener('mousedown', function () { pressing = true; }, true);
    document.addEventListener('mouseup', function () {
      pressing = false;
      if (closeAfterPress) { closeAfterPress = false; setTimeout(closeSearchIfEmpty, 0); }
    }, true);
    $('empty-clear').onclick = clearSearch;
    $('do-sequence').onclick = function () { doSequence(); };
    $('do-bins').onclick = function () { doBins(); };
    $('undo-write').onclick = doUndoWrite;
    $('foot-details').onclick = showDetails;

    onPress($('more'), function (mouse) { if ($('menu').hidden) { openMenu(mouse); } else { closeMenu(); } }, function () {
      var first = menuItems()[0];
      if (!$('menu').hidden && first && !$('menu').contains(document.activeElement)) { first.focus(); }
    });
    $('menu').onclick = function (e) {
      var b = e.target.closest('button');
      if (b && !b.disabled) {
        closeMenu();
        MENU[b.dataset.menu]();
      }
    };
    document.addEventListener('mousedown', function (e) {
      if (S.ctx && !e.target.closest('.ctx')) { closeCtx(); }
      if (!$('menu').hidden && !e.target.closest('#menu') && !e.target.closest('#more')) { closeMenu(); }
      if (!$('picker').hidden && !e.target.closest('#picker') && !e.target.closest('.pick')) { closePicker(); }
      if (!e.target.closest('#search-box')) { closeSearchSoon(); }
      if (!e.target.closest('#suggest') && !e.target.closest('#search-box')) { closeSuggest(); }
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
    // A click can change the status above the clips by a line (a note goes, a green result gives way), which moves the
    // clips under the pointer. So the second press of a double-click keeps the clip the first one picked, and opens it.
    var pressed = null;
    $('grid').addEventListener('mousedown', function (e) {
      // A right-click, or a Control-click on the Mac, is the clip menu's (wireContext): it keeps the selection it is on.
      if (e.button !== 0 || e.ctrlKey) { return; }
      if (e.detail > 1 && pressed !== null && !e.metaKey && !e.shiftKey) { return; }
      var at = rowAt(e.target);
      pressed = at >= 0 ? S.order[at] : null;
      if (at >= 0 && !marqueeHolds()) { clickRow(at, e); }
    });
    $('grid').addEventListener('dblclick', function (e) {
      if (e.ctrlKey) { return; }
      var at = rowAt(e.target), id = pressed !== null ? pressed : (at >= 0 ? S.order[at] : null);
      if (id !== null && id !== undefined) { openRow(S.store.rows[id]); }
    });
    $('grid').addEventListener('scroll', scheduleRows, { passive: true });
    $('grid').addEventListener('scroll', onScrollTuck, { passive: true });
    new ResizeObserver(onGridResize).observe($('grid'));

    document.addEventListener('keydown', function (e) {
      if (S.ctx && ctxKey(e)) { return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); openSearch(true); return; }
      if (e.key === 'Escape' && closeSuggest()) { return; }
      var typing = e.target && (e.target.tagName === 'INPUT' || e.target.isContentEditable);
      var free = !typing && !S.modalOpen && !S.picker && $('menu').hidden;
      // Over the clips: Cmd-A takes every clip on screen, Escape lets them go, and typing a letter starts a search.
      if (free && (e.metaKey || e.ctrlKey) && e.key === 'a' && S.order.length) {
        e.preventDefault();
        S.order.forEach(function (id) { S.selected.add(id); });
        renderItems();
        renderFoot();
        return;
      }
      if (free && e.key === 'Escape' && S.selected.size) { S.selected.clear(); S.anchor = null; renderItems(); renderFoot(); return; }
      if (free && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1 && /\S/.test(e.key) && S.store.rows.length) { openSearch(false); return; }
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

    wireDrag();
    wireMarquee();
    wireScrub();
    wireSuggest();
    S.columns = visibleColumns();
    buildHead();
    buildPool();
    applyView();
    if (mode === 'grid') { setMode('grid'); }
    wireTarget();
    wirePoll();
    wireScanIntent();
    wireContext();
    wireSheets();
    wireFoot();
    // The band opens and closes with a transition from the first change on, never on the first paint.
    requestAnimationFrame(function () { requestAnimationFrame(function () { $('app').classList.add('settled'); }); });
  }

  // The scan target: once at load, when the host is this page's own and the project is known (its last results come
  // back then), and after that only when the editor comes to the panel.
  function wireTarget() {
    hostReady = ensureHost();
    hostReady.then(refreshProject).then(askWatch);
    document.documentElement.addEventListener('mouseenter', askWatch);
    window.addEventListener('focus', askWatch);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { askWatch(); } });
  }

  // A sheet's own choices (Other), and Enter in its name field.
  function wireSheets() {
    $('dialog-body').addEventListener('click', function (e) {
      var choice = e.target.closest('[data-choice]');
      if (choice && S.sheetChoice) { S.sheetChoice(choice); }
    });
    $('dialog-body').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.closest('.field')) { e.preventDefault(); $('dialog-ok').click(); }
    });
  }

  // The band's one line is fitted again when the panel changes width, and its height follows its rows: the update line
  // is update.js's, so its showing and hiding are watched.
  function wireFoot() {
    new ResizeObserver(fitFoot).observe($('foot-top'));
    new ResizeObserver(fitBand).observe($('band-in'));
    new MutationObserver(fitBand).observe($('update-line'), { attributes: true, attributeFilter: ['hidden'] });
    var root = document.documentElement, hold = function (what) { return function () { inPanel[what] = true; clearTimeout(settle.timer); settle.timer = null; }; };
    var free = function (what) { return function () { inPanel[what] = false; setTimeout(settleStart, 0); }; };
    root.addEventListener('mouseenter', hold('pointer'));
    root.addEventListener('mousemove', function () { if (!inPanel.pointer) { hold('pointer')(); } }, { passive: true });
    root.addEventListener('mouseleave', free('pointer'));
    window.addEventListener('focus', hold('focus'));
    window.addEventListener('blur', free('focus'));
  }

  // For the tests and for the integration pass, through the DevTools port.
  window.SelectApp = {
    state: S,
    reveal: function () { tuck(false); },
    timeouts: TIMEOUT,
    startScan: startScan,
    askTarget: function () { S.targetKey = null; return askTarget(); },
    askWatch: askWatch,
    time: TIME,
    poll: poll,
    stopScan: stopScan,
    applyView: applyView,
    setMode: setMode,
    stopScrub: stopScrub,
    marquee: function () { return { on: !!(mq && mq.on), last: mqLast }; },
    extensionRoot: extensionRoot,
    foot: function () { return C.footState(footFacts()); }
  };

  init();
})();
