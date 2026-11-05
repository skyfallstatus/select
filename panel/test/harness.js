#!/usr/bin/env node
// Loads the real panel page in headless Chromium and drives it with real mouse events over the DevTools protocol.
// The page gets a stand-in for CEP's Node (child_process goes to a real fake-engine process here) and for
// __adobe_cep__.evalScript (calls are recorded and answered by a mock). No npm dependencies.
'use strict';
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ensureThumbs } = require('./build_fixture.js');

const CHROME = process.env.CHROME || path.join(os.homedir(), 'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const PAGE = 'file://' + encodeURI(path.join(__dirname, '../client/index.html'));
const FAKE = path.join(__dirname, 'fake-engine.js');
const OUT = path.join(__dirname, 'out');
const MANIFEST = path.join(__dirname, '../CSXS/manifest.xml');
const DEADLINE_MS = 480000;    // every browser file of the harness, the fifth round's included
const ROW_H = 40;
const PROJECT = { path: '/Volumes/Field SSD/Projects/lantern-spring.prproj', name: 'lantern-spring.prproj' };
// Premiere on this Mac, when it is installed: the page loads Adobe Clean from it, as it does inside Premiere. Elsewhere,
// or with __mock.app pointed somewhere else, the page keeps the Mac's own font.
const PREMIERE_APP = '/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/MacOS/Adobe Premiere Pro 2026';
fs.mkdirSync(OUT, { recursive: true });

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/clips.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const unreadable = fixture.filter(r => r.error).length;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' : ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- the page's stand-ins

const SHIM = String.raw`
(function () {
  function emitter() {
    var h = {};
    return { on: function (n, f) { (h[n] = h[n] || []).push(f); return this; }, emit: function (n) {
      var a = Array.prototype.slice.call(arguments, 1); (h[n] || []).forEach(function (f) { f.apply(null, a); }); } };
  }
  var kids = {};
  window.__mock = { accessError: null, spawnError: null, lockFile: null, config: null, manifest: null, playback: { program: false, source: false, modal: '' }, project: __PROJECT__,
    items: [], calls: [], partial: false, misplaced: 0, unconfirmed: false, hidden: false, hostFail: null, folderFiles: [], projectItemsForFolder: [], skin: { red: 35, green: 35, blue: 35 }, listeners: {}, urls: [],
    slow: {}, restoreSkip: 0, picked: null, readdirMs: 0, diskFull: false, binSeq: 0, subs: {}, openMissing: false,
    // The Project panel: selection null (nothing selected) or {kind, items, places, more, name, sig}; several: two panels.
    selection: null, several: false, seqN: 0, seqShort: 0, seqOrder: false, noView: false, execs: [], pickedFolder: null, missing: [], revealFail: false,
    // Where Premiere runs from, as getSystemPath('hostApplication') says it: a file URL. Read before the page's scripts.
    app: stored('__hostApp', __APP__), fontReads: [],
    // The host Premiere holds: its protocol, and calls it doesn't know yet. A page may start with an older one loaded, as
    // after an update and Restart (set through localStorage, which outlives the reload).
    protocol: stored('__hostProtocol', '3'), stale: JSON.parse(stored('__hostStale', '[]')), loads: 0, events: [], loadMs: Number(stored('__hostLoadMs', '0')) };
  var M = window.__mock;
  // localStorage, where a document may read it (not every document the browser opens can).
  function stored(key, otherwise) { try { return localStorage.getItem(key) || otherwise; } catch (e) { return otherwise; } }
  // Undo records go to a disk that outlives a reload of the page, as ~/Library does.
  var FS_KEY = '__fakefs';
  function disk() { try { return JSON.parse(localStorage.getItem(FS_KEY) || '{}'); } catch (e) { return {}; } }
  function keep(d) { localStorage.setItem(FS_KEY, JSON.stringify(d)); }
  function onDisk(p) { return /\/(undo|last)(\/|$)/.test(p); }
  function nofile(code) { var e = new Error(code); e.code = code; return e; }
  window.__disk = { files: function () { return disk(); }, clear: function () { localStorage.removeItem(FS_KEY); } };
  window.__host = {
    feed: function (id, stream, b64) {
      var bin = atob(b64), u = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) { u[i] = bin.charCodeAt(i); }
      u.toString = function () { return new TextDecoder().decode(u); };
      kids[id][stream].emit('data', u);
    },
    close: function (id, code, signal) { kids[id].emit('close', code, signal); }
  };
  window.cep = { util: { openURLInDefaultBrowser: function (url) { M.urls.push(url); } } };
  var seq = 0;
  var shims = {
    child_process: { spawn: function (bin, args) {
      var id = ++seq, c = emitter();
      c.stdout = emitter(); c.stderr = emitter();
      if (M.spawnError) {
        c.stdin = { on: function () {}, end: function () {} };
        c.kill = function () {};
        var err = new Error('spawn ' + M.spawnError); err.code = M.spawnError;
        setTimeout(function () { c.emit('error', err); }, 0);
        return c;
      }
      c.pid = 1000 + id;
      c.stdin = { on: function () {}, end: function (text) { slNative(JSON.stringify({ op: 'spawn', id: id, bin: bin, args: args, text: text })); } };
      c.kill = function (sig) { slNative(JSON.stringify({ op: 'kill', id: id, sig: sig })); };
      kids[id] = c;
      return c;
    }, execFile: function (bin, args, opts, cb) {
      M.execs.push({ bin: bin, args: args });
      // The engine's reveal: every file shown, or, with revealFail, an engine that ends badly.
      if (args[0] === 'reveal') {
        var fail = M.revealFail;
        setTimeout(function () { if (fail) { cb(new Error('exit 1'), '', ''); } else { cb(null, JSON.stringify({ type: 'reveal', shown: args.length - 1, missing: 0, ms: 1 }) + '\n', ''); } }, 0);
        return;
      }
      var picked = /osascript$/.test(bin) ? M.pickedFolder : '';
      setTimeout(function () { if (picked === null) { var e = new Error('cancelled'); cb(e, '', 'User canceled. (-128)'); } else { cb(null, picked ? picked + '\n' : '', ''); } }, 0);
    } },
    fs: { constants: { X_OK: 1 },
      existsSync: function (p) { return M.missing.indexOf(p) === -1; },
      accessSync: function () { if (M.accessError) { var e = new Error(M.accessError); e.code = M.accessError; throw e; } },
      mkdirSync: function () { if (M.diskFull) { throw nofile('ENOSPC'); } },
      writeFileSync: function (file, text) { if (M.diskFull) { throw nofile('ENOSPC'); } var d = disk(); d[file] = String(text); keep(d); },
      renameSync: function (a, b) { var d = disk(); if (!(a in d)) { throw nofile('ENOENT'); } d[b] = d[a]; delete d[a]; keep(d); },
      unlinkSync: function (file) { var d = disk(); if (!(file in d)) { throw nofile('ENOENT'); } delete d[file]; keep(d); },
      readdirSync: function (dir) {
        var d = disk(), out = [];
        Object.keys(d).forEach(function (k) { if (k.indexOf(dir + '/') === 0 && k.slice(dir.length + 1).indexOf('/') === -1) { out.push(k.slice(dir.length + 1)); } });
        if (!out.length) { throw nofile('ENOENT'); }
        return out;
      },
      readFileSync: function (file) {
        if (onDisk(file)) { var d = disk(); if (!(file in d)) { throw nofile('ENOENT'); } return d[file]; }
        var text = /manifest\.xml$/.test(file) ? M.manifest : /config\.json$/.test(file) ? M.config : M.lockFile;
        if (text === null) { var e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
        return text;
      },
      readdir: function (dir, o, cb) { setTimeout(function () { cb(null, M.folderFiles.map(function (f) { return { name: f, isDirectory: function () { return false; }, isFile: function () { return true; } }; })); }, M.readdirMs); },
      // Real bytes of a real file, as Node gives them: here only Premiere's font is read this way.
      readFile: function (file, cb) {
        M.fontReads.push(file);
        var x = new XMLHttpRequest();
        x.open('GET', 'file://' + encodeURI(file));
        x.responseType = 'arraybuffer';
        x.onload = function () { if (x.response && x.response.byteLength) { cb(null, new Uint8Array(x.response)); } else { cb(nofile('ENOENT')); } };
        x.onerror = function () { cb(nofile('ENOENT')); };
        x.send();
      } },
    os: { homedir: function () { return '/home/editor'; } },
    path: { join: function () { return Array.prototype.join.call(arguments, '/'); } },
    string_decoder: { StringDecoder: function () { var d = new TextDecoder('utf-8'); this.write = function (u) { return d.decode(u, { stream: true }); }; this.end = function () { return d.decode(); }; } }
  };
  window.require = function (n) { return shims[n]; };
  window.process = { env: {}, kill: function () { return true; } };
  // The project in front decides, as in the host: an item is written only while its id still has its path.
  function sorted(pairs, skipped) {
    return pairs.filter(function (p) {
      var ok = M.items.some(function (it) { return String(it.id) === String(p[0]) && it.path === p[1]; });
      if (!ok) { skipped.push({ id: p[0], error: 'now a different clip' }); }
      return ok;
    });
  }
  // Count, first and last id, as the host signs a selection.
  function sigOf() {
    if (M.several) { return 'several:2'; }
    var sel = M.selection;
    if (!sel) { return ''; }
    if (sel.sig) { return sel.sig; }
    var list = sel.items || M.items;
    return list.length ? list.length + ':' + list[0].id + ':' + list[list.length - 1].id : '0';
  }
  function answer(fn, a) {
    M.calls.push({ fn: fn, args: a });
    if (M.hostFail && M.hostFail.fn === fn) { return M.hostFail.reply; }
    var bad = M.partial ? [{ id: 'x', name: 'C0001.MP4', error: 'simulated failure' }] : [], skipped = [], ok, miss;
    if (M.stale.indexOf(fn) !== -1) { return { ok: false, code: 'unknown-call', message: 'Unknown host call: ' + fn }; }
    if (fn === 'label' || fn === 'bins') { M.partial = false; }    // one failure per write, not per batch
    switch (fn) {
      case 'status': return { ok: true, version: 't', premiere: '26', project: M.project, playback: M.playback };
      case 'watch': return { ok: true, project: M.project, sig: M.project ? sigOf() : '', ms: 1 };
      case 'target': {
        if (!M.project) { return { ok: false, code: 'no-project', message: 'No project is open.' }; }
        var base = { ok: true, project: M.project, sig: a.whole ? '' : sigOf(), kind: 'project', name: null, places: [], more: 0, items: M.items, sequences: 1, noPath: 0, ms: 3 };
        if (M.several && !a.whole) { base.kind = 'several'; base.several = 2; base.items = []; return base; }
        var sel = a.whole ? null : M.selection;
        if (sel && sel.kind !== 'project') { base.kind = sel.kind || 'clips'; base.name = sel.name || null; base.places = sel.places || []; base.more = sel.more || 0; base.items = sel.items || M.items; }
        return base;
      }
      case 'reveal':
        if (M.noView) { return { ok: false, code: 'no-view', message: 'No Project panel shows this project.' }; }
        ok = sorted(a.items, skipped);
        return { ok: true, selected: ok.length, asked: a.items.length, skipped: skipped, ms: 5 };
      case 'sequence': {
        if (M.seqFail) { return { ok: false, code: 'failed', message: 'Premiere didn\'t make the sequence. Nothing was changed.' }; }
        ok = sorted(a.items, skipped);
        var placed = Math.max(0, ok.length - M.seqShort), sid = 'seq' + (++M.seqN);
        return { ok: true, sequenceID: sid, id: 'sq' + M.seqN, name: a.name, clips: placed, inOrder: !M.seqOrder, settings: { width: 3840, height: 2160, fps: 25, par: '1:1' }, opened: true, steps: {}, othersKept: true, skipped: skipped, ms: 900,
          restore: { kind: 'sequence', items: [[sid, 'sq' + M.seqN, a.name, placed, '254016000000000']] } };
      }
      case 'collect':
        if (!M.project) { return { ok: false, code: 'no-project', message: 'No project is open.' }; }
        return { ok: true, project: M.project, mode: a.mode, items: M.items, sequences: 1, noPath: 0, ms: 3, picked: a.mode === 'selection' ? (M.picked || { clips: M.items.length, where: ['Day 2'] }) : null };
      case 'find':
        if (!M.project) { return { ok: false, code: 'no-project', message: 'No project is open.' }; }
        return { ok: true, project: M.project, items: M.items.filter(function (it) { return a.paths.indexOf(it.path) !== -1; }), ms: 3 };
      case 'label':
        ok = sorted(a.items, skipped);
        return { ok: true, changed: ok.length - bad.length, failed: bad, skipped: skipped, ms: 300, restore: { kind: 'label', color: a.color, items: ok.map(function (p) { return [p[0], 1, p[1]]; }) } };
      case 'bins': {
        if (!a.top) { M.binSeq++; M.subs = {}; }
        var top = a.top || 't' + M.binSeq, moved = 0, items = [];
        var report = a.buckets.map(function (b) {
          var here = sorted(b.items, skipped).map(function (p) { items.push([p[0], 'r', 's', p[1]]); return String(p[0]); });
          M.subs[b.name] = (M.subs[b.name] || []).concat(here);
          moved += here.length;
          return { name: b.name, moved: here };
        });
        return { ok: true, root: a.root, top: top, moved: moved - bad.length, buckets: report, failed: bad, skipped: skipped, ms: 400, restore: { kind: 'bins', top: top, items: items } };
      }
      case 'binsCheck':
        return { ok: true, binRemoved: a.clear ? true : null, buckets: Object.keys(M.subs).map(function (name, i) {
          var out = { name: name };
          if (!M.unconfirmed) { out.ids = M.subs[name].slice(0, i === 0 ? Math.max(0, M.subs[name].length - M.misplaced) : undefined); }
          return out;
        }) };
      case 'restore': {
        var skip = Math.min(M.restoreSkip, a.restore.items.length);
        M.restoreSkip -= skip;
        return { ok: true, restored: a.restore.items.length - skip, skipped: skip, failed: [], remaining: null, binRemoved: a.restore.kind === 'bins' && a.final !== false ? true : null, ms: 100 };
      }
      case 'open':
        if (M.openMissing) { return { ok: false, code: 'not-found', message: 'That clip is no longer in the project.', ms: 4 }; }
        return { ok: true, name: 'clip', id: a.id, by: 'id', ms: 4 };
      case 'importClips': return { ok: true, imported: true, items: a.paths.map(function (p, i) { return { id: 'new' + i, path: p, name: p }; }), bin: a.bin, ms: 200 };
      default: return { ok: false, code: 'unknown-call', message: fn };
    }
  }
  // Zero-delay steps in call order. ExtendScript answers calls in the order they come; nested zero timers would not keep
  // it, as Chromium holds a deeply nested one back 4 ms, and an answer to an older call could land after a newer one.
  var steps = [], port = new MessageChannel();
  port.port1.onmessage = function () { steps.shift()(); };
  function soon(fn) { steps.push(fn); port.port2.postMessage(0); }
  window.__adobe_cep__ = {
    // The work happens when the call arrives; M.slow[fn] holds back only the answer, as a busy Premiere would.
    evalScript: function (script, cb) {
      soon(function () {
        if (/SELECT_HOST_PROTOCOL/.test(script)) { M.events.push('check ' + M.protocol); cb(M.protocol); return; }
        if (/\$\.evalFile\(/.test(script)) {
          M.events.push('load');
          setTimeout(function () { M.loads++; M.protocol = '3'; M.stale = []; M.events.push('loaded'); cb('undefined'); }, M.loadMs);
          return;
        }
        var out = null, fn = null;
        new Function('slCall', script)(function (name, json) { fn = name; M.events.push(name); out = JSON.stringify(answer(name, JSON.parse(json))); });
        if (fn && M.slow[fn]) { setTimeout(function () { cb(out); }, M.slow[fn]); } else { soon(function () { cb(out); }); }
      });
    },
    getHostEnvironment: function () { return JSON.stringify({ appSkinInfo: { panelBackgroundColor: { color: M.skin }, baseFontFamily: 'AdobeClean-Regular', baseFontSize: 12 } }); },
    getSystemPath: function (kind) { return kind === 'hostApplication' ? 'file://' + encodeURI(M.app) : ''; },
    addEventListener: function (type, fn) { (M.listeners[type] = M.listeners[type] || []).push(fn); }
  };
})();
`;

// ---------------------------------------------------------------- DevTools

class Page {
  constructor(ws, session) { this.ws = ws; this.session = session; }
}

// Everything a run starts, so the deadline and every exit can stop all of it.
const started = new Set();
function stopEverything() {
  for (const child of started) { try { child.kill('SIGKILL'); } catch (e) {} }
  started.clear();
}
process.on('exit', stopEverything);

function setDeadline(ms) {
  const timer = setTimeout(() => {
    console.log(`FAIL deadline: stopped after ${ms} ms`);
    stopEverything();
    process.exit(1);
  }, ms);
  timer.unref();
}

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-chrome-'));
  const chrome = cp.spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--disable-gpu',
    '--allow-file-access-from-files', '--window-size=900,640', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  started.add(chrome);
  const url = await new Promise((resolve, reject) => {
    let buf = '';
    chrome.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\S+)/); if (m) { resolve(m[1]); } });
    chrome.on('exit', c => reject(new Error('chrome exited ' + c + ' ' + buf)));
  });
  const ws = new WebSocket(url);
  await new Promise(r => { ws.onopen = r; });
  let nextId = 0;
  const waiting = new Map();
  const listeners = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id) { const w = waiting.get(m.id); waiting.delete(m.id); if (m.error) { w.reject(new Error(JSON.stringify(m.error))); } else { w.resolve(m.result); } } else { listeners.forEach(l => l(m)); }
  };
  const send = (method, params, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const P = (m, p) => send(m, p, sessionId);
  await P('Runtime.enable'); await P('Page.enable'); await P('Log.enable'); await P('Network.enable');
  await P('Emulation.setDeviceMetricsOverride', { width: 900, height: 620, deviceScaleFactor: 2, mobile: false });
  await P('Runtime.addBinding', { name: 'slNative' });
  const manifest = fs.existsSync(MANIFEST) ? fs.readFileSync(MANIFEST, 'utf8') : '';
  await P('Page.addScriptToEvaluateOnNewDocument', { source: SHIM.replace('__PROJECT__', JSON.stringify(PROJECT)).replace('__APP__', JSON.stringify(PREMIERE_APP)) + `\nwindow.__mock.manifest=${JSON.stringify(manifest)};` });
  const problems = [];
  const requests = [];
  const engines = new Map();
  const engineEnv = {};
  const engineLog = { spawned: 0, exited: [] };
  listeners.push(m => {
    if (m.method === 'Network.requestWillBeSent') { requests.push(m.params.request.url); }
    if (m.method === 'Runtime.exceptionThrown') { problems.push(m.params.exceptionDetails.text + ' ' + JSON.stringify(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description)); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') { problems.push('console.error ' + JSON.stringify(m.params.args.map(a => a.value))); }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon/.test(m.params.entry.url || '')) { problems.push('log ' + m.params.entry.text + ' ' + (m.params.entry.url || '')); }
    if (m.method === 'Runtime.bindingCalled' && m.params.name === 'slNative') {
      const q = JSON.parse(m.params.payload);
      if (q.op === 'spawn') {
        engineLog.spawned++;
        engineLog.lastBin = q.bin; engineLog.lastArgs = q.args;
        const child = cp.spawn(process.execPath, [FAKE, ...q.args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...engineEnv } });
        started.add(child);
        child.on('exit', () => started.delete(child));
        engines.set(q.id, child);
        child.stdin.on('error', () => {});
        child.stdin.end(q.text);
        const pipe = name => child[name].on('data', d => { P('Runtime.evaluate', { expression: `__host.feed(${q.id},${JSON.stringify(name)},${JSON.stringify(d.toString('base64'))})` }).catch(() => {}); });
        pipe('stdout'); pipe('stderr');
        child.on('close', (code, signal) => {
          engineLog.exited.push({ id: q.id, code, signal });
          P('Runtime.evaluate', { expression: `__host.close(${q.id},${code},${JSON.stringify(signal)})` }).catch(() => {});
        });
      } else if (q.op === 'kill') {
        const child = engines.get(q.id);
        if (child) { child.kill(q.sig); }
      }
    }
  });
  async function evalIn(expression) {
    const r = await P('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) { throw new Error('eval: ' + r.exceptionDetails.text + ' in ' + expression + ' ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description)); }
    return r.result.value;
  }
  async function open() {
    await P('Page.navigate', { url: PAGE });
    await waitFor('document.readyState === "complete" && !!window.SelectApp', 'page load');
  }
  async function waitFor(expr, what, ms) {
    const end = Date.now() + (ms || 15000);
    while (Date.now() < end) {
      if (await evalIn(`!!(${expr})`)) { return true; }
      await sleep(10);
    }
    throw new Error('timed out waiting for ' + (what || expr));
  }
  async function mouse(x, y, opts) {
    const o = opts || {};
    const modifiers = (o.shift ? 8 : 0) | (o.meta ? 4 : 0);
    await P('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
    const count = o.count || 1;
    for (let i = 1; i <= count; i++) {
      await P('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: i, modifiers });
      await P('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: i, modifiers });
    }
  }
  // A click lands where the element is drawn. Headless Chromium moves a transition on only with the frames it draws, so
  // an element still sliding in (the band's buttons) is waited for, a frame at a time, until it is the one at the point.
  async function click(selector, opts) {
    const at = `(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e){return null;}e.scrollIntoView({block:'nearest',inline:'nearest'});var b=e.getBoundingClientRect(),x=b.left+b.width/2,y=b.top+b.height/2,hit=document.elementFromPoint(x,y);return {x:x,y:y,hit:!!hit&&(hit===e||e.contains(hit))};})()`;
    let r = await evalIn(at);
    for (let i = 0; r && !r.hit && i < 30; i++) {
      await evalIn(`new Promise(function(done){requestAnimationFrame(function(){done(true);});})`);
      r = await evalIn(at);
    }
    if (!r) { throw new Error('no element ' + selector); }
    await mouse(r.x, r.y, opts);
  }
  async function shot(name) {
    await sleep(260);
    const r = await P('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  const close = async () => { chrome.kill('SIGKILL'); started.delete(chrome); await sleep(100); fs.rmSync(profile, { recursive: true, force: true }); };
  async function size(width, height) {
    await P('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
    await sleep(120);
  }
  // SIGSTOP and SIGCONT to the fake engines, so a check can hold a scan exactly where it is.
  function signalEngines(sig) {
    for (const child of engines.values()) { if (child.exitCode === null && child.signalCode === null) { try { child.kill(sig); } catch (e) {} } }
  }
  const listen = fn => listeners.push(fn);
  return { evalIn, open, waitFor, click, mouse, shot, close, size, problems, requests, engineEnv, engineLog, signalEngines, listen, send: P };
}

// ---------------------------------------------------------------- helpers in the page

const text = id => `document.getElementById(${JSON.stringify(id)}).textContent`;
const domRows = `Array.from(document.querySelectorAll('#body .r')).filter(function(r){return r.style.display!=='none';}).map(function(r){return {at:Number(r.dataset.at),cls:r.className,cells:Array.from(r.children).map(function(c){return c.textContent;})};}).sort(function(a,b){return a.at-b.at;})`;
const colIndex = key => `SelectApp.state.columns.map(function(c){return c.key;}).indexOf(${JSON.stringify(key)})`;
const ids = `SelectApp.state.order.map(function(i){return SelectApp.state.store.rows[i];})`;
// The bar's count of clips, without what it adds after a scan about clips not read whole (· 9 not read).
const clipsCount = `document.getElementById('count').textContent.replace(/ \u00b7 [\\d,]+ not read$/,'')`;
// The band and the bar as the editor sees them. mark and tone: the band's icon and its colour, '' when the band has no
// status row. actions: the band's buttons; bar: the bar's buttons that are on (null while the bar is hidden); a * marks
// the blue. green: a proved write, the green on the icon only and the words in ink.
const foot = `(function(){var f=document.getElementById('foot'),top=document.getElementById('foot-top'),m=document.getElementById('foot-mark'),v=document.getElementById('foot-verdict'),bt=document.getElementById('bottom');
  var star=function(b){return b.id+(b.classList.contains('primary')?'*':'');},root=getComputedStyle(document.documentElement),probe=function(c){var d=document.createElement('i');d.style.color=c;document.body.appendChild(d);var o=getComputedStyle(d).color;d.remove();return o;};
  return {kind:f.className,open:f.dataset.open==='true',mark:top.hidden?'':m.dataset.kind,tone:top.hidden?'':(m.dataset.tone||''),verdict:v.textContent,sentence:document.getElementById('foot-sentence').textContent,
  actions:Array.from(document.querySelectorAll('#foot-actions button')).filter(function(b){return !b.hidden;}).map(star),
  bar:bt.hidden?null:Array.from(bt.querySelectorAll('#bottom-actions button')).filter(function(b){return !b.disabled;}).map(star),count:bt.hidden?'':${clipsCount},notRead:bt.hidden?'':(/ \u00b7 ([\\d,]+ not read)$/.exec(document.getElementById('count').textContent)||[])[1]||'',countTip:document.getElementById('count').title,
  close:!!document.getElementById('foot-close'),background:getComputedStyle(f).backgroundColor,color:getComputedStyle(v).color,
  green:f.classList.contains('green')&&m.dataset.tone==='safe'&&getComputedStyle(m).color===probe(root.getPropertyValue('--safe-ink'))&&getComputedStyle(v).color===probe(root.getPropertyValue('--ink'))};})()`;

function clips(n) {
  const list = [];
  for (let i = 0; i < n; i++) {
    const r = fixture[i % fixture.length];
    list.push({ id: 'id' + i, path: i < fixture.length ? r.path : `${r.path}.${i}.mp4`, name: path.basename(r.path) });
  }
  return list;
}

// Show and Sort are menus under their words. Real clicks: open the menu, then press the item.
async function pickShow(b, id) {
  await b.click('#show');
  await b.click(`#picker button[data-id="${id || 'everything'}"]`);
}
async function pickSort(b, key) {
  await b.click('#sort');
  await b.click(`#picker button[data-id="${key || 'listed'}"]`);
}

// Back to every clip, as listed, no colour: the view a fresh scan starts with. Real clicks, only on what is on.
async function resetView(b) {
  const v = await b.evalIn(`SelectApp.state.view`);
  if (v.show) { await pickShow(b, null); }
  if (v.sort.length) { await pickSort(b, null); }
  for (const f of v.families || []) { await b.click(`#families [data-family="${f}"]`, { shift: true }); }
}

const KEYS = { Escape: 27, ArrowDown: 40, ArrowUp: 38, Enter: 13 };
async function press(b, key) {
  const k = { key, code: key, windowsVirtualKeyCode: KEYS[key] };
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k, ...(key === 'Enter' ? { text: '\r' } : {}) });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
}

async function rightClick(b, selector) {
  const r = await b.evalIn(`(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e){return null;}e.scrollIntoView({block:'nearest',inline:'nearest'});var q=e.getBoundingClientRect();return {x:q.left+Math.min(30,q.width/2),y:q.top+q.height/2};})()`);
  if (!r) { throw new Error('no element ' + selector); }
  await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'right', clickCount: 1 });
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'right', clickCount: 1 });
}

// Cmd-A over the clips: every clip on screen.
async function selectAll(b) {
  const k = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 };
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k });
  await b.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
}

// Label is in the right-click menu only: right-click a picked clip, Label, a colour. With nothing picked, Cmd-A first, as
// the editor would. Up to 50 clips the colour labels at once; past 50 it opens the Label sheet.
async function labelFromMenu(b, color) {
  if (!(await b.evalIn(`SelectApp.state.selected.size`))) { await selectAll(b); }
  const where = `(function(){var S=SelectApp.state,list=document.getElementById('app').classList.contains('is-list');for(var i=0;i<S.order.length;i++){if(S.selected.has(S.order[i])){return {at:i,list:list,n:S.order.length};}}return null;})()`;
  const w = await b.evalIn(where);
  if (!w) { throw new Error('no clip picked'); }
  const sel = w.list ? `#body .r[data-at="${w.at}"] .c-name` : `#tiles .t[data-at="${w.at}"] .pic`;
  if (!(await b.evalIn(`!!document.querySelector(${JSON.stringify(sel)})`))) {
    await b.evalIn(`(function(){var g=document.getElementById('grid');g.scrollTop=Math.max(0,g.scrollHeight*${w.at}/${w.n}-80);})()`);
    await b.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, 'the picked clip on screen', 2000);
  }
  await rightClick(b, sel);
  await b.waitFor(`!!document.querySelector('.ctx [data-ctx="label"]')`, 'the right-click menu', 2000);
  await b.click('.ctx [data-ctx="label"]');
  await b.waitFor(`!!document.querySelector('.ctx.labels')`, 'the colours', 2000);
  await b.click(`.ctx.labels [data-ctx="color-${color === undefined ? 7 : color}"]`);
}

// The open picker as [id, label, hint, on].
const pickerItems = `Array.from(document.querySelectorAll('#picker button')).map(function(x){var h=x.querySelector('span');return [x.dataset.id,x.firstChild.textContent,h.textContent,x.classList.contains('on')&&x.getAttribute('aria-checked')==='true'];})`;
// The two words of the toolbar's Show and Sort.
const barNow = `({show:document.querySelector('#show .v').textContent,showOn:document.getElementById('show').classList.contains('on'),sort:document.querySelector('#sort .v').textContent,sortOn:document.getElementById('sort').classList.contains('on'),flip:!document.getElementById('flip').hidden,picker:!document.getElementById('picker').hidden})`;

async function setItems(b, n) { await b.evalIn(`__mock.items=${JSON.stringify(clips(n))}`); }

// Scan reads what the Project panel holds now: the status's Scan before any results, the Premiere target afterwards
// (with results on screen the status's Scan may read the same clips again, and Rescan always does).
async function pressScan(b) {
  if (!(await b.evalIn(`document.getElementById('scan').hidden`)) && (await b.evalIn(`SelectApp.foot().scanWhat`)) === 'target') {
    await b.click('#scan');
  } else {
    await b.evalIn(`SelectApp.startScan()`);
  }
}

async function scanAndWait(b) {
  const n = b.engineLog.exited.length;
  await pressScan(b);
  const end = Date.now() + 60000;
  while (b.engineLog.exited.length === n && Date.now() < end) { await sleep(10); }
  await b.waitFor(`SelectApp.state.scan && !SelectApp.state.scan.handle && SelectApp.state.scan.state!=='Scanning'`, 'scan end', 60000);
}

// An rgba() token laid over a #rrggbb ground, as #rrggbb.
function over(rgba, ground) {
  const [r, g, bl, a] = rgba.match(/[\d.]+/g).map(Number);
  return '#' + [r, g, bl].map((v, i) => Math.round(v * a + parseInt(ground.slice(1 + 2 * i, 3 + 2 * i), 16) * (1 - a)).toString(16).padStart(2, '0')).join('').toUpperCase();
}

// WCAG contrast of two #rrggbb colours.
function contrast(a, b) {
  const lum = hex => {
    const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// ---------------------------------------------------------------- the tests

// The real page fed with a real engine's lines. node harness.js --replay engine-output.jsonl
async function replay(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const paths = [...new Set(lines.filter(l => l.path).map(l => l.path))];
  const b = await launch();
  b.engineEnv.FAKE_REPLAY = file;
  await b.open();
  await b.evalIn(`__mock.items=${JSON.stringify(paths.map((p, i) => ({ id: 'r' + i, path: p, name: path.basename(p) })))}`);
  await scanAndWait(b);
  console.log(await b.evalIn(foot));
  await sleep(600);
  await b.shot('20-real-done');
  const report = {};
  const views = [['sort', 'sharpness'], ['flip', 'sharpness'], ['sort', 'luma'], ['flip', 'luma'], ['sort', 'clipHighPct'], ['sort', 'motionProxy'], ['flip', 'motionProxy'], ['sort', 'shake'],
    ['sort', 'createdAt'], ['sort', 'colorName'], ['show', 'silent'], ['show', 'interviews'], ['show', 'people'], ['show', 'speech'], ['show', 'onscreen'], ['show', 'similar']];
  for (const [kind, id] of views) {
    if (kind === 'show') { await pickShow(b, id); } else { await pickSort(b, id); }
    if (kind === 'flip') { await b.click('#flip'); }
    await sleep(250);
    const name = kind + '-' + id;
    report[name] = await b.evalIn(`({verdict:document.getElementById('foot-verdict').textContent,says:document.getElementById('foot-sentence').textContent,top:${ids}.slice(0,3).map(function(r){return r.name;})})`);
    await b.shot('21-real-' + name);
    await resetView(b);
  }
  console.log(JSON.stringify(report, null, 1));
  const empties = await b.evalIn(`(function(){var o={},rows=SelectApp.state.store.rows;SelectCore.COLUMNS.forEach(function(c){if(c.sortable===false){return;}o[c.key]=rows.filter(function(r){return SelectCore.cellText(r,c)==='';}).length;});return o;})()`);
  console.log('empty cells per column of ' + paths.length + ':', JSON.stringify(empties));
  console.log('script problems:', JSON.stringify(b.problems));
  await b.close();
  process.exit(0);
}

async function main() {
  setDeadline(DEADLINE_MS);
  if (process.argv[2] === '--replay') { return replay(process.argv[3]); }
  const b = await launch();
  b.engineEnv.FAKE_THUMBS = ensureThumbs();
  const dialogText = () => b.evalIn(`document.getElementById('dialog').innerText`);
  const modalOpen = () => b.evalIn(`!document.getElementById('modal').hidden`);
  const waitModal = () => b.waitFor(`!document.getElementById('modal').hidden`);
  const calls = name => b.evalIn(`__mock.calls.filter(function(c){return c.fn===${JSON.stringify(name)};})`);
  const noteText = () => b.evalIn(text('status-note'));
  const footNow = () => b.evalIn(foot);
  // Calls the panel makes on its own when the editor comes to it, which a check about a write or an open leaves out.
  const own = fn => fn !== 'status' && fn !== 'watch' && fn !== 'target';
  try {
    await b.open();
    check('page loads with no script errors', b.problems.length === 0, b.problems);
    const row = await b.evalIn(`({kids:Array.from(document.getElementById('toolbar').children).filter(function(x){return !x.hidden&&x.id;}).map(function(x){return x.id;}).join(),
      shows:SelectCore.SHOWS.length,showTips:SelectCore.SHOWS.filter(function(s){return s.tip.length>40;}).length,sorts:SelectCore.SORTS.length,sortTips:SelectCore.SORTS.filter(function(s){return (SelectCore.COLUMN[s.key].tip||'').length>4;}).length,
      dots:document.querySelectorAll('#families button').length,dotTips:Array.from(document.querySelectorAll('#families button')).filter(function(x){return x.title.length>4;}).length,
      words:[document.querySelector('#show .k').textContent,document.querySelector('#show .v').textContent,document.querySelector('#sort .k').textContent,document.querySelector('#sort .v').textContent].join('|'),
      titles:document.getElementById('show').title.length>4&&document.getElementById('sort').title.length>4,old:!!document.querySelector('#presets,#clear-view,#sort-menu,[data-group],#bar,#title,#subtitle,#foot-under,#foot-meter,#source,#folder-box,#toolbar .rule'),
      status:document.getElementById('foot').parentNode.id})`);
    check('one toolbar: Show, Sort, nine dots, search and the menu (no From; the view switch is in the bar), every show, sort and dot with a tooltip, and the status under it', row.kids === 'show,sort,families,search-box,more' && row.words === 'Show|Everything|Sort|As listed' && row.shows === 10 && row.showTips === 10 && row.sorts === 11 && row.sortTips === 11 && row.dots === 9 && row.dotTips === 9 && row.titles && !row.old && row.status === 'top', row);
    await b.waitFor(`document.getElementById('project-name').textContent==='lantern-spring'`, 'project name');
    await b.click('#more');
    const menuTitle = await b.evalIn(`({text:document.getElementById('menu-title').textContent,tip:document.getElementById('menu-title').title})`);
    await press(b, 'Escape');
    check('project name comes from status, without the extension, and heads the ··· menu, its path in the tooltip', menuTitle.text === 'lantern-spring' && menuTitle.tip === PROJECT.path, menuTitle);

    // -------- the status before a scan: what Scan would read, live
    await b.waitFor(`SelectApp.state.target`, 'the first target');
    const emptyProject = await footNow();
    check('before a scan, a project with no clips says so, with no Scan', emptyProject.verdict === 'No video clips' && emptyProject.sentence === '' && emptyProject.actions.join() === '', emptyProject);
    await setItems(b, 400);
    await b.evalIn(`SelectApp.askTarget()`);
    await b.waitFor(`document.getElementById('foot-verdict').textContent==='Whole project'`, 'whole project');
    const before = await b.evalIn(`(function(){var f=${foot};f.scanTip=document.getElementById('scan').title;f.tip=document.getElementById('foot-words').title;return f;})()`);
    check('status before a scan: the band open, the bin icon (the project\'s root), Whole project and its clips, a cobalt Scan whose tooltip is what it reads, the project in the tooltip, and no bar', before.open && before.mark === 'bin' && before.verdict === 'Whole project' && before.sentence === '400 clips' && before.actions.join() === 'scan*' && !before.close && before.scanTip === 'Whole project \u00b7 400 clips' && before.tip === 'lantern-spring' && before.bar === null, before);
    check('the primary action is cobalt', (await b.evalIn(`getComputedStyle(document.getElementById('scan')).backgroundColor`)) === 'rgb(47, 111, 230)');
    await b.shot('00-empty');

    // -------- live scan, 400 clips
    await setItems(b, 400);
    b.engineEnv.FAKE_DELAY_MS = '1';
    await b.click('#scan');
    await b.waitFor(`SelectApp.state.store.rows.length===400`, 'rows');
    const early = await b.evalIn(`({rows:SelectApp.state.store.rows.length,t0:SelectApp.state.store.tier0,dom:${domRows}.length,stopOn:!document.getElementById('stop').hidden})`);
    check('rows appear before the engine has reported them', early.rows === 400 && early.dom > 5 && early.t0 < 400 && early.stopOn, early);
    await b.waitFor(`SelectApp.state.store.tier0>=100`, 'tier 0');
    await b.waitFor(`SelectApp.state.store.tier1>=50`, 'tier 1', 30000);
    await sleep(120);
    const mid = await footNow();
    const spin = await b.evalIn(`getComputedStyle(document.querySelector('#foot-mark .ic')).animationName`);
    check('status while scanning: one line, the spinner turning, a count of the total, Stop, no progress bar; the bar\'s writes wait for the scan', mid.mark === 'spinner' && spin === 'turn' && /^Reading [1-9]\d* of 400$/.test(mid.verdict) && mid.sentence === '' && mid.actions.join() === 'stop' && !(await b.evalIn(`!!document.querySelector('[role="progressbar"]')`)) &&
      mid.bar && mid.bar.join() === '' && (await b.evalIn(`document.getElementById('do-sequence').title`)) === 'Waits for the scan', { mid, spin });
    const filled = await b.evalIn(`(function(){var d=${domRows},i=${colIndex('sharpness')};return d.filter(function(r){return r.cells[i]!=='';}).length;})()`);
    check('columns fill in while the scan runs', filled > 0, filled);
    await b.shot('01-scanning');
    await b.waitFor(`SelectApp.state.scan && SelectApp.state.scan.state==='Done'`, 'done', 30000);
    const done = await b.evalIn(`({foot:${foot},t0:SelectApp.state.store.tier0,t1:SelectApp.state.store.tier1,errors:SelectApp.state.store.errors,blank:SelectApp.state.store.noPicture.clips,open:document.getElementById('foot').dataset.open})`);
    check('scan ends Done, both tiers landed: the band closes; the bar counts 400 clips and the clips not read whole, the why in its tooltip, the clips with no picture scores last', done.open === 'false' && done.foot.mark === '' && done.foot.verdict === '' && done.foot.count === '400 clips' && done.foot.notRead === `${unreadable + done.blank} not read` && done.blank > 0 &&
      /\n\d+ clips have no picture scores: this Mac has no decoder for them, and ffmpeg isn't installed\.\n400 clips \u00b7 \d+ not read$/.test(done.foot.countTip) && done.t0 === 400 - unreadable && done.t1 === 400 - unreadable && done.errors === unreadable, done);
    check('engine binary path is inside the extension, with scan arguments', /\/bin\/select-engine$/.test(b.engineLog.lastBin) && b.engineLog.lastArgs.join(' ') === 'scan --paths-file -', b.engineLog.lastBin);
    await b.waitFor(`document.querySelectorAll('#body img[src]').length>0`, 'thumbs');
    await sleep(200);
    const loaded = await b.evalIn(`Array.from(document.querySelectorAll('#body img[src]')).filter(function(i){return i.complete&&i.naturalWidth>0;}).length`);
    check('thumbnails load from file paths', loaded > 0, loaded);
    await b.shot('02-done');

    // -------- clips that could not be read
    const status = (await b.evalIn(`document.getElementById('count').title`)).split('\n')[0];
    check('the count\'s tooltip counts the unread clips and says why in one sentence', status.startsWith('8 clips could not be read: .braw and .r3d aren\'t supported yet, .mov and .mxf need ffmpeg, some files are missing or offline and some files may be damaged.'), status);
    const badRows = await b.evalIn(`(function(){var r=SelectApp.state.store.rows.filter(function(x){return x.error;});return r.map(function(x){return {name:x.name,reason:SelectCore.unreadableReason(x)};});})()`);
    check('an unreadable clip keeps its name and gets a quiet reason', badRows.length === unreadable && badRows.some(r => r.reason === '.r3d isn\'t supported yet') && badRows.some(r => r.reason === '.mxf needs ffmpeg') && badRows.every(r => r.name), badRows);
    await b.evalIn(`(function(){var o=SelectApp.state.order,rows=SelectApp.state.store.rows;for(var i=0;i<o.length;i++){if(rows[o[i]].error){document.getElementById('grid').scrollTop=i*${ROW_H};return;}}})()`);
    await sleep(120);
    const shownBad = await b.evalIn(`(function(){var e=document.querySelector('#body .r.err .why');return e?{text:e.textContent,color:getComputedStyle(e).color,name:e.parentNode.querySelector('.n').textContent,nameColor:getComputedStyle(e.parentNode.querySelector('.n')).color}:null;})()`);
    check('its row shows the reason in ink2, and no scary red', shownBad && shownBad.text.length > 5 && shownBad.color === 'rgb(173, 173, 177)' && shownBad.nameColor === 'rgb(237, 237, 238)', shownBad);
    await b.shot('02b-unreadable');
    await b.evalIn(`document.getElementById('grid').scrollTop=0`);

    // -------- clips with good file details and no picture
    const blanks = await b.evalIn(`(function(){var o=SelectApp.state.order,rows=SelectApp.state.store.rows;for(var i=0;i<o.length;i++){if(rows[o[i]].reason){document.getElementById('grid').scrollTop=i*${ROW_H};return {count:rows.filter(function(r){return r.reason;}).length,errors:rows.filter(function(r){return r.reason&&r.error;}).length};}}return null;})()`);
    await sleep(120);
    const blankRow = await b.evalIn(`(function(){var a=${domRows}.filter(function(r){return / two/.test(r.cls)&&!/ err/.test(r.cls);})[0],e=document.querySelector('#body .r.two:not(.err) .why');return a&&e?{cells:a.cells,why:e.textContent,color:getComputedStyle(e).color,shown:getComputedStyle(e).display,tip:e.parentNode.title}:null;})()`);
    const durationAt = await b.evalIn(colIndex('durationS')), sharpAt = await b.evalIn(colIndex('sharpness'));
    check('a clip with no picture is not an error: details stay, scores stay blank, a quiet reason sits under its name', blanks && blanks.count > 0 && blanks.errors === 0 && blankRow && /^This Mac has no decoder for H\.264 .*, and ffmpeg isn't installed\.$/.test(blankRow.why) && blankRow.color === 'rgb(173, 173, 177)' && blankRow.shown === 'block' && blankRow.cells[durationAt] !== '' && blankRow.cells[sharpAt] === '' && /picture scores are blank/.test(blankRow.tip), blankRow);
    await b.shot('02c-no-picture');
    await b.evalIn(`document.getElementById('grid').scrollTop=0`);

    // -------- nulls
    const nulls = await b.evalIn(`(function(){var rows=SelectApp.state.store.rows,c=SelectCore.COLUMN;var hit=rows.filter(function(r){return r.audioDb===null;})[0];var cam=rows.filter(function(r){return r.camera===null;})[0];var zero=rows.filter(function(r){return r.clipLowPct===0;})[0];return {audio:SelectCore.cellText(hit,c.audioDb),cam:SelectCore.cellText(cam,c.camera),zero:zero?SelectCore.cellText(zero,c.clipLowPct):null};})()`);
    check('null shows empty, real zero shows 0.00', nulls.audio === '' && nulls.cam === '' && (nulls.zero === null || nulls.zero === '0.00'), nulls);
    // The scrolls above tuck the status away and bring it back: the header moves while it slides, so the click waits.
    await b.waitFor(`!document.getElementById('foot').classList.contains('tucked')&&document.getElementById('foot').getAnimations().length===0`, 'the status settled', 5000).catch(() => {});
    await b.click(`#head .h[data-key="audioDb"]`);
    await b.waitFor(`SelectApp.state.view.sort.length&&SelectApp.state.view.sort[0].key==='audioDb'`, 'the Loudness sort', 3000).catch(() => {});
    const shown = await b.evalIn(`(function(){var d=${domRows},i=${colIndex('audioDb')};return d.map(function(r){return r.cells[i];});})()`);
    check('no zero appears in the Audio column where the value is null', !shown.some(v => v === '0' || v === '0.0'), shown.slice(0, 5));
    // The rows follow the scroll event, which headless Chromium sends only with its next frame, seconds late while the
    // status tucks away: so it is sent here.
    await b.evalIn(`(function(){var g=document.getElementById('grid');g.scrollTop=1e9;g.dispatchEvent(new Event('scroll'));})()`);
    await b.waitFor(`(function(){var d=${domRows};return d.length&&d[d.length-1].at>=SelectApp.state.order.length-1;})()`, 'rows at the end', 3000).catch(() => {});
    const tail = await b.evalIn(`(function(){var d=${domRows},i=${colIndex('audioDb')};return d.slice(-5).map(function(r){return r.cells[i];});})()`);
    check('nulls sort to the end of the table and stay empty', tail.every(v => v === ''), tail);
    const tucked = await b.waitFor(`document.getElementById('foot').classList.contains('tucked')`, 'status tucks', 1500).then(() => true, () => false);
    await b.evalIn(`document.getElementById('grid').scrollTop=0`);
    const back = await b.waitFor(`!document.getElementById('foot').classList.contains('tucked')`, 'status back', 1500).then(() => true, () => false);
    check('scrolling down the clips tucks the calm status away, and a quick return to the top brings it back', tucked && back, { tucked, back });

    // -------- Show and Sort
    await resetView(b);
    const orderOf = key => b.evalIn(`${ids}.map(function(r){return r[${JSON.stringify(key)}];})`);
    const sorted = (v, dir) => { const a = v.filter(x => x !== null && x !== undefined); return a.every((x, i) => !i || (dir > 0 ? a[i - 1] <= x : a[i - 1] >= x)); };
    const field = key => (key === 'createdAt' ? 'time' : key);
    const viewNow = () => b.evalIn(`SelectApp.state.view`);
    const barState = () => b.evalIn(barNow);
    const SORT = await b.evalIn(`SelectCore.SORT`);
    const readsAs = w => (/^[A-Z] /.test(w) ? w : w.toLowerCase());
    // The view in words, as Make Sequence and Sort into Bins name what they make. Calm results have no band: the toolbar
    // says the view and the bar counts it.
    const viewWords = () => b.evalIn(`SelectCore.viewName(SelectApp.state.view)`);
    const calm = f => f.mark === '' && f.verdict === '';
    for (const key of ['sharpness', 'luma', 'clipHighPct', 'motionProxy', 'durationS', 'audioDb', 'createdAt']) {
      const e = SORT[key];
      await pickSort(b, key);
      let v = await orderOf(field(key)), f = await footNow(), bar = await barState();
      const view = await viewNow();
      check(`Sort ${e.label} sorts ${e.ways[0].toLowerCase()} and says so`, sorted(v, e.dir) && JSON.stringify(view.sort) === JSON.stringify([{ key, dir: e.dir }]) && !view.show && (await viewWords()) === e.ways[0] && calm(f) && bar.sort === e.ways[0] && bar.sortOn && bar.flip && !bar.picker && f.count === '400 clips', { verdict: f.verdict, count: f.count, bar });
      await pickSort(b, key);
      v = await orderOf(field(key)); f = await footNow(); bar = await barState();
      check(`picking ${e.label} again flips it: ${e.ways[1].toLowerCase()}`, sorted(v, -e.dir) && (await viewNow()).sort[0].dir === -e.dir && (await viewWords()) === e.ways[1] && bar.sort === e.ways[1], { verdict: f.verdict, bar });
      await pickSort(b, null);
    }
    await pickSort(b, 'sharpness');
    const flipTip = await b.evalIn(`document.getElementById('flip').title`);
    await b.click('#flip');
    let flipped = { v: await orderOf('sharpness'), view: await viewNow(), f: await footNow(), bar: await barState(), tip: await b.evalIn(`document.getElementById('flip').title`) };
    check('the flip button reverses the sort, and its tooltip says which way it goes', sorted(flipped.v, 1) && flipped.view.sort[0].dir === 1 && (await viewWords()) === 'Softest first' && flipped.bar.sort === 'Softest first' && flipTip === 'Reverse to Softest first' && flipped.tip === 'Reverse to Sharpest first', { flipTip, tip: flipped.tip, bar: flipped.bar });
    await b.click('#flip');
    check('and flips it back', sorted(await orderOf('sharpness'), -1) && (await viewWords()) === 'Sharpest first' && (await barState()).sort === 'Sharpest first');

    // the Sort menu: every sort, how each will read, the active one ticked and focused
    await b.click('#sort');
    const sortMenu = await b.evalIn(`({items:${pickerItems},focus:document.activeElement.dataset.id,weights:Array.from(document.querySelectorAll('#picker button')).map(function(x){return getComputedStyle(x).fontWeight;}),tips:Array.from(document.querySelectorAll('#picker button')).every(function(x){return x.title.length>4;})})`);
    const wantSort = [['listed', 'As listed', '', false]].concat(Object.values(SORT).map(e => [e.key, e.label, readsAs(e.ways[0]), e.key === 'sharpness']));
    check('the Sort menu lists As listed and every sort, each hint how it will read, the active one ticked and focused', JSON.stringify(sortMenu.items) === JSON.stringify(wantSort) && sortMenu.focus === 'sharpness' && sortMenu.weights.filter(w => w === '700').length === 1 && sortMenu.weights[1 + Object.keys(SORT).indexOf('sharpness')] === '700' && sortMenu.tips, sortMenu);
    await press(b, 'Escape');
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 450, y: 360 });
    await sleep(60);
    const pickStyle = await b.evalIn(`(function(){var on=getComputedStyle(document.querySelector('#sort .v')),off=getComputedStyle(document.querySelector('#show .v')),bs=getComputedStyle(document.getElementById('sort')),bo=getComputedStyle(document.getElementById('show'));return {on:[on.color,on.fontWeight],off:[off.color,off.fontWeight],bg:[bs.backgroundColor,bo.backgroundColor],border:[bs.borderTopStyle,bo.borderTopStyle]};})()`);
    check('the active word is in ink and bold, the others in ink2, no pills', pickStyle.on[0] === 'rgb(237, 237, 238)' && pickStyle.on[1] === '700' && pickStyle.off[0] === 'rgb(173, 173, 177)' && pickStyle.off[1] === '400' && pickStyle.bg.every(x => x === 'rgba(0, 0, 0, 0)') && pickStyle.border.every(x => x === 'none'), pickStyle);
    await pickSort(b, null);
    const asListed = { listed: await b.evalIn(`SelectApp.state.order.length===400&&SelectApp.state.order.every(function(at,i){return at===i;})`), view: await viewNow(), f: await footNow(), bar: await barState() };
    check('As listed turns the sort off: the order clips came in, no flip button, the word plain', asListed.listed && !asListed.view.sort.length && !asListed.bar.sortOn && !asListed.bar.flip && asListed.bar.sort === 'As listed' && calm(asListed.f) && asListed.f.count === '400 clips', asListed);
    await pickSort(b, 'clipHighPct');
    check('a switched-off column shows while the view sorts by it', await b.evalIn(`!!document.querySelector('#head .h[data-key="clipHighPct"]')`));
    await pickSort(b, 'createdAt');
    await b.click('#more');
    await b.click('[data-menu="undo-view"]');
    check('a sort undoes with Undo View', JSON.stringify((await viewNow()).sort) === JSON.stringify([{ key: 'clipHighPct', dir: -1 }]) && (await barState()).sort === 'Most clipped first');
    await pickSort(b, null);

    // every Show: what it shows passes its test, as many as its count, named in the bar and the foot, and Undo View takes it back
    const showIds = await b.evalIn(`SelectCore.SHOWS.map(function(s){return s.id;})`);
    for (const id of showIds) {
      await pickShow(b, id);
      const info = await b.evalIn(`(function(){var S=SelectApp.state,C=SelectCore,s=C.SHOW[${JSON.stringify(id)}],rows=S.store.rows,ctx=s.prepare?s.prepare(rows):null;
        return {shown:S.order.length,count:C.showCount(rows,s.id),pass:S.order.every(function(i){return s.group?rows[i].dupGroup>0:s.filter(rows[i],ctx);}),label:s.label,groups:S.hasGroups,view:S.view};})()`);
      const f = await footNow(), bar = await barState();
      check(`Show ${info.label} shows only what it says, as many as its count, and names itself`, info.shown > 0 && info.shown < 400 && info.shown === info.count && info.pass && info.view.show === id && !info.view.sort.length && (await viewWords()) === info.label && calm(f) && f.count.startsWith(`${info.shown} of 400 clips`) && bar.show === info.label && bar.showOn && !bar.sortOn && !bar.flip && info.groups === (id === 'similar'), { shown: info.shown, count: info.count, pass: info.pass, verdict: f.verdict, bar: f.count, toolbar: bar });
      if (id === 'similar') {
        await b.shot('03-similar');
        const heads = await b.evalIn(`({first:(document.querySelector('#body .gh')||{}).textContent,dup:!!document.querySelector('#head .h[data-key="dupGroup"]'),groups:SelectApp.state.groupCount})`);
        check('similar shots show as groups, each under its own heading', /^Group 1 · \d+ clips$/.test(heads.first) && !heads.dup && heads.groups > 1 && f.count.endsWith(` \u00b7 ${heads.groups} groups`), { heads, count: f.count });
      }
      if (id === 'interviews') { await b.shot('04-interviews'); }
      await b.click('#more');
      await b.click('[data-menu="undo-view"]');
      const back = await barState();
      check(`Show ${info.label} undoes with Undo View`, (await b.evalIn(`SelectApp.state.view.show===null&&SelectApp.state.order.length===400`)) && back.show === 'Everything' && !back.showOn, back);
    }
    check('group headings leave after undo', await b.evalIn(`!SelectApp.state.L.heads.length&&Array.from(document.querySelectorAll('#body .gh')).length===0`));

    // Show and Sort are two separate questions: either can come first, changing one keeps the other, and a colour stays through both
    await pickShow(b, 'interviews');
    await pickSort(b, 'sharpness');
    const within = show => `(function(){var S=SelectApp.state,C=SelectCore,rows=S.store.rows,s=C.SHOW[${JSON.stringify(show)}],ctx=s.prepare?s.prepare(rows):null,r=S.order.map(function(i){return rows[i];});
      return {view:S.view,shown:r.length,count:C.showCount(rows,s.id),pass:r.every(function(x){return s.filter(x,ctx);}),sharp:r.map(function(x){return x.sharpness;}),long:r.map(function(x){return x.durationS;}),luma:r.map(function(x){return x.luma;}),motion:r.map(function(x){return x.motionProxy;}),colours:r.map(function(x){return x.colorName;})};})()`;
    let combo = await b.evalIn(within('interviews')), comboFoot = await footNow(), comboBar = await barState();
    check('Show, then Sort: the sort orders what the show shows, and the bar and foot name both', combo.view.show === 'interviews' && combo.view.sort[0].key === 'sharpness' && combo.shown === combo.count && combo.shown > 1 && combo.pass && sorted(combo.sharp, -1) && (await viewWords()) === 'Interviews, sharpest first' && comboFoot.count === `${combo.shown} of 400 clips` && comboBar.show === 'Interviews' && comboBar.sort === 'Sharpest first' && comboBar.showOn && comboBar.sortOn, { view: combo.view, count: comboFoot.count, bar: comboBar });
    await resetView(b);
    await pickSort(b, 'durationS');
    await pickShow(b, 'people');
    combo = await b.evalIn(within('people')); comboFoot = await footNow();
    check('Sort, then Show: the show keeps the sort', combo.view.show === 'people' && JSON.stringify(combo.view.sort) === '[{"key":"durationS","dir":-1}]' && combo.shown === combo.count && combo.pass && sorted(combo.long, -1) && (await viewWords()) === 'People, longest first' && calm(comboFoot), { view: combo.view, verdict: comboFoot.verdict });
    await pickShow(b, 'speech');
    const keptSort = await viewNow();
    await pickSort(b, 'luma');
    combo = await b.evalIn(within('speech')); comboFoot = await footNow();
    check('a new show keeps the sort, and a new sort keeps the show', keptSort.show === 'speech' && keptSort.sort[0].key === 'durationS' && combo.view.show === 'speech' && combo.view.sort[0].key === 'luma' && combo.pass && sorted(combo.luma, -1) && (await viewWords()) === 'Speech, brightest first' && calm(comboFoot), { keptSort, view: combo.view, verdict: comboFoot.verdict });
    await b.click('#head .h[data-key="motionProxy"]');
    combo = await b.evalIn(within('speech')); comboBar = await barState();
    check('a header click sets the sort and keeps the show', combo.view.show === 'speech' && JSON.stringify(combo.view.sort) === '[{"key":"motionProxy","dir":-1}]' && combo.pass && sorted(combo.motion, -1) && comboBar.sort === 'Most motion first' && comboBar.show === 'Speech', { view: combo.view, bar: comboBar });
    const fam = await b.evalIn(`(function(){var c=SelectCore.familyCounts(SelectApp.state.store.rows);return Object.keys(c).filter(function(k){return k!=='neutral';}).sort(function(x,y){return c[y]-c[x];})[0];})()`);
    await b.click(`#families [data-family="${fam}"]`);
    await pickShow(b, 'people');
    await pickSort(b, 'luma');
    combo = await b.evalIn(within('people')); comboFoot = await footNow();
    const famWord = await b.evalIn(`SelectCore.FAMILY[${JSON.stringify(fam)}].word`);
    check('a colour dot stays through a new show and a new sort, and the view\'s name names all three', combo.view.families.join() === fam && combo.view.show === 'people' && combo.view.sort[0].key === 'luma' && combo.shown > 0 && combo.pass && combo.colours.every(c => c === fam) && sorted(combo.luma, -1) && (await viewWords()) === `${famWord}, people, brightest first` && comboFoot.count === `${combo.shown} of 400 clips`, { view: combo.view, shown: combo.shown, count: comboFoot.count });
    await resetView(b);

    // Interviews: speech and a face, and long enough to be one
    await pickShow(b, 'interviews');
    const iv = await b.evalIn(`(function(){var S=SelectApp.state,rows=S.store.rows,shown=S.order.map(function(i){return rows[i];});var short=rows.filter(function(r){return r.speech===true&&r.faces>0&&r.durationS<SelectCore.INTERVIEW_MIN_S;});
      return {min:SelectCore.INTERVIEW_MIN_S,shown:shown.length,shortest:Math.min.apply(null,shown.map(function(r){return r.durationS;})),short:short.length,leaked:short.filter(function(r){return shown.indexOf(r)>=0;}).length};})()`);
    check('Interviews leaves out clips under 15 s, even with speech and a face', iv.min === 15 && iv.shown > 0 && iv.shortest >= 15 && iv.short > 0 && iv.leaked === 0, iv);
    await resetView(b);

    // the Show menu: its sections, its counts, and the keyboard
    await b.click('#show');
    const showMenu = await b.evalIn(`({items:${pickerItems},seq:Array.from(document.getElementById('picker').children).map(function(x){return x.tagName==='HR'?'|':x.dataset.id;}).join(' '),
      want:SelectCore.SHOWS.map(function(s){return [s.id,SelectCore.fmtInt(SelectCore.showCount(SelectApp.state.store.rows,s.id))];}),focus:document.activeElement.dataset.id,expanded:document.getElementById('show').getAttribute('aria-expanded'),
      tips:Array.from(document.querySelectorAll('#picker button')).every(function(x){return x.title.length>4;})})`);
    check('the Show menu: Everything, then people, sound and picture, each count from core.showCount', showMenu.seq === 'everything | interviews people nopeople mediums wides | speech music silent | onscreen similar' && JSON.stringify(showMenu.items[0]) === '["everything","Everything","400",true]' && showMenu.want.every(([id, n]) => showMenu.items.find(x => x[0] === id)[2] === n) && showMenu.items.filter(x => x[3]).length === 1 && showMenu.focus === 'everything' && showMenu.expanded === 'true' && showMenu.tips, showMenu);
    await press(b, 'ArrowDown');
    const down = await b.evalIn(`document.activeElement.dataset.id`);
    await press(b, 'ArrowUp');
    await press(b, 'ArrowUp');
    const wrapped = await b.evalIn(`document.activeElement.dataset.id`);
    await press(b, 'Escape');
    const escaped = await b.evalIn(`({hidden:document.getElementById('picker').hidden,focus:document.activeElement.id,expanded:document.getElementById('show').getAttribute('aria-expanded'),show:SelectApp.state.view.show})`);
    check('arrow keys move through the menu and wrap round; Escape closes it, changes nothing and gives focus back to Show', down === 'interviews' && wrapped === 'similar' && escaped.hidden && escaped.focus === 'show' && escaped.expanded === 'false' && escaped.show === null, { down, wrapped, escaped });
    await b.click('#show');
    await press(b, 'ArrowDown');
    await press(b, 'Enter');
    check('Enter picks the item in focus', (await viewNow()).show === 'interviews' && (await barState()).show === 'Interviews' && !(await barState()).picker);
    await resetView(b);
    await b.click('#show');
    await b.click('#count');
    check('a click outside closes the menu and changes nothing', (await b.evalIn(`document.getElementById('picker').hidden&&document.getElementById('show').getAttribute('aria-expanded')==='false'`)) && (await viewNow()).show === null && !(await viewNow()).sort.length);
    await b.click('#show');
    await b.click('#show');
    const againClosed = await b.evalIn(`document.getElementById('picker').hidden`);
    await b.click('#show');
    await b.click('#sort');
    const swapped = await b.evalIn(`({hidden:document.getElementById('picker').hidden,first:document.querySelector('#picker button').dataset.id,show:document.getElementById('show').getAttribute('aria-expanded'),sort:document.getElementById('sort').getAttribute('aria-expanded')})`);
    check('pressing Show again closes its menu, and pressing Sort swaps to the Sort menu', againClosed && !swapped.hidden && swapped.first === 'listed' && swapped.show === 'false' && swapped.sort === 'true', { againClosed, swapped });
    await press(b, 'Escape');

    // -------- sort at 1,000 rows: real clicks on every header
    await setItems(b, 1000);
    b.engineEnv.FAKE_DELAY_MS = '0';
    await scanAndWait(b);
    check('1,000 clips scanned', (await b.evalIn(`SelectApp.state.store.rows.length`)) === 1000);
    await b.evalIn(`SelectApp.state.history.length=0`);
    await resetView(b);
    await sleep(300);    // thumbnails landing are not part of a re-sort
    const times = [];
    const keys = await b.evalIn(`SelectApp.state.columns.filter(function(c){return c.sortable!==false&&!c.onlyWithGroups;}).map(function(c){return c.key;})`);
    for (const key of keys) {
      for (let i = 0; i < 2; i++) {
        await b.evalIn(`SelectApp.state.sortMs=null`);
        await b.click(`#head .h[data-key="${key}"]`);
        await b.waitFor(`SelectApp.state.sortMs!==null`);
        times.push({ key, ms: await b.evalIn('SelectApp.state.sortMs') });
      }
    }
    const worst = times.reduce((a, c) => (c.ms > a.ms ? c : a));
    const avg = times.reduce((a, c) => a + c.ms, 0) / times.length;
    check('re-sort plus repaint of 1,000 rows, every column both ways, 16 ms or less', worst.ms <= 16, `worst ${worst.ms.toFixed(1)} ms on ${worst.key}, mean ${avg.toFixed(1)} ms over ${times.length} clicks`);
    const laidOut = await b.evalIn(`(function(){var hs=document.querySelectorAll('#head .h.sortable'),worst=0,total=0,n=0;for(var k=0;k<2;k++){for(var i=0;i<hs.length;i++){var h=document.querySelector('#head .h[data-key="'+hs[i].dataset.key+'"]'),t=performance.now();h.click();document.body.offsetHeight;document.getElementById('body').getBoundingClientRect();var ms=performance.now()-t;worst=Math.max(worst,ms);total+=ms;n++;}}return {worst:worst,mean:total/n,n:n};})()`);
    check('the same, through forced layout, 16 ms or less', laidOut.worst <= 16, `worst ${laidOut.worst.toFixed(1)} ms, mean ${laidOut.mean.toFixed(1)} ms over ${laidOut.n} sorts`);
    await b.click('#more');
    await b.click('[data-menu="about"]');
    await waitModal();
    const about = await dialogText();
    check('About shows the version from the manifest, and one line on what leaves the Mac', new RegExp('Version ' + (/ExtensionBundleVersion="([^"]+)"/.exec(fs.readFileSync(MANIFEST, 'utf8'))[1]).replace(/\./g, '\\.')).test(about) && /Everything runs on this Mac\. Once a day Select asks GitHub for a new version\./.test(about), about);
    check('About says nothing more: no formats, no timings, no paragraphs', !/Reads \.mp4/.test(about) && !/Last re-sort/.test(about) && !/suggestion/.test(about) && about.trim().split('\n').filter(Boolean).length <= 4, about);
    await b.shot('11-about');
    await b.click('#dialog-ok');

    await b.click(`#head .h[data-key="camera"]`);
    await b.click(`#head .h[data-key="luma"]`, { shift: true });
    const multi = await b.evalIn(`({sort:SelectApp.state.view.sort,marks:document.querySelectorAll('#head .mark').length})`);
    check('shift-click adds a secondary sort, shown on both headers', multi.sort.length === 2 && multi.sort[1].key === 'luma' && multi.marks === 2, multi);
    const multiOk = await b.evalIn(`(function(){var r=${ids};for(var i=1;i<r.length;i++){if(r[i].camera===r[i-1].camera&&r[i].camera!==null&&r[i].luma>r[i-1].luma){return false;}}return true;})()`);
    check('secondary sort orders rows inside equal primary values', multiOk);

    // -------- scrolling
    const scroll = await b.evalIn(`new Promise(function(resolve){
      var g=document.getElementById('grid'),max=g.scrollHeight-g.clientHeight,n=0,last=performance.now(),gaps=[],maxNodes=0;
      function step(now){gaps.push(now-last);last=now;g.scrollTop=(n%2?max*(n/240):max*(1-n/240));
        maxNodes=Math.max(maxNodes,document.querySelectorAll('#body .r').length);
        if(++n<240){requestAnimationFrame(step);}else{gaps.shift();gaps.sort(function(a,b){return a-b;});
          resolve({frames:n,max:gaps[gaps.length-1],p99:gaps[Math.floor(gaps.length*.99)],median:gaps[gaps.length>>1],nodes:maxNodes,height:g.scrollHeight});}}
      requestAnimationFrame(step);})`);
    check('1,000 rows are virtualised', scroll.nodes < 60 && scroll.height > 39000, scroll);
    check('scrolling end to end every frame stays near 60 fps (headless, software)', scroll.p99 <= 34, scroll);
    await b.evalIn(`document.getElementById('grid').scrollTop=15000`);
    await sleep(100);
    const placed = await b.evalIn(`(function(){var d=${domRows},bad=0,i=${colIndex('name')};d.forEach(function(r){var row=SelectApp.state.store.rows[SelectApp.state.order[r.at]];if(r.cells[i].indexOf(row.name)!==0){bad++;}});return {bad:bad,n:d.length};})()`);
    check('after a long scroll every row shows the right clip', placed.bad === 0 && placed.n > 10, placed);
    await b.evalIn(`document.getElementById('grid').scrollTop=0`);

    // -------- selection and writes
    await setItems(b, 400);
    b.engineEnv.FAKE_DELAY_MS = '0';
    await scanAndWait(b);
    await resetView(b);
    await pickSort(b, 'sharpness');
    const finished = await footNow();
    const skippedLine = await b.evalIn(`document.getElementById('count').title`);
    check('when finished: no status row (the toolbar names the view), the bar counts the clips and holds Make Sequence and Sort into Bins (no Label, no Add Columns), Sort into Bins cobalt, no Scan; the clips with no picture scores said once, on the skipped line', finished.mark === '' && finished.verdict === '' && finished.count === '400 clips' && (skippedLine.match(/no picture scores/g) || []).length === 1 && finished.actions.join() === '' && finished.bar.join() === 'do-sequence,do-bins*' && !finished.close && !(await b.evalIn(`!!document.getElementById('do-label')`)), { finished, skippedLine });
    await b.click('#more');
    const menu = await b.evalIn(`Array.from(document.querySelectorAll('#menu button')).filter(function(x){return !x.hidden;}).map(function(x){return x.textContent;})`);
    check('the menu holds Rescan, Scan a Folder, Columns, Previous View, Clear Results, Report a Bug and About (no Scan Whole Project with nothing selected)', menu.join('|') === 'Rescan|Scan a Folder…|Columns…|Previous View|Clear Results|Report a Bug|About Select', menu);
    await b.shot('12-menu');
    await b.mouse(300, 300);
    check('a click elsewhere closes the menu', await b.evalIn(`document.getElementById('menu').hidden`));
    await b.evalIn(`SelectApp.state.selected.clear();SelectApp.state.anchor=null;SelectApp.applyView()`);
    const rowSel = n => `#body .r[data-at="${n}"]`;
    await b.click(rowSel(2));
    await b.click(rowSel(6), { shift: true });
    await b.click(rowSel(4), { meta: true });
    check('click, shift-click and cmd-click select rows, and the bar counts them', (await b.evalIn(`SelectApp.state.selected.size`)) === 4 && (await b.evalIn(clipsCount)) === '4 of 400 clips selected', await b.evalIn(text('count')));
    const selected = await b.evalIn(`(function(){var s=getComputedStyle(document.querySelector('#body .r.sel'),'::before');return {bg:s.backgroundColor,radius:s.borderRadius,left:s.left};})()`);
    check('selected rows sit on a soft plate, inset and rounded, never cobalt', selected.bg === 'rgba(255, 255, 255, 0.11)' && selected.radius === '4px' && selected.left === '8px', selected);
    const hierarchy = await b.evalIn(`(function(){var r=document.querySelector('#body .r:not(.err):not(.two)');return {by:getComputedStyle(r.querySelector('.c-sharpness')).color,weight:getComputedStyle(r.querySelector('.c-sharpness')).fontWeight,other:getComputedStyle(r.querySelector('.c-luma')).color};})()`);
    check('the sorted column keeps ink and the other figures step back', hierarchy.by === 'rgb(237, 237, 238)' && hierarchy.weight === '700' && hierarchy.other === 'rgb(173, 173, 177)', hierarchy);
    await b.shot('13-selected');

    // Label is in the right-click menu only. On 4 picked clips a colour labels them at once.
    await labelFromMenu(b, 7);
    await b.waitFor(`__mock.calls.some(function(c){return c.fn==='label';})`);
    const lab = (await calls('label'))[0].args, sheetless = !(await modalOpen());
    const want = await b.evalIn(`Array.from(SelectApp.state.selected).map(function(i){var r=SelectApp.state.store.rows[i];return [r.ids[0],r.path];})`);
    check('right-click, Label, Mango on 4 picked clips labels them at once, with no sheet: one batch, the selected rows only, each item with its path', sheetless && lab.items.length === 4 && lab.color === 7 && lab.project === PROJECT.path && want.every(w => lab.items.some(p => p[0] === w[0] && p[1] === w[1])), lab);
    await b.waitFor(`/Labelled/.test(${text('foot-verdict')})`);
    await sleep(320);
    const labelled = await footNow();
    const undoLook = await b.evalIn(`(function(){var u=getComputedStyle(document.getElementById('undo-write'));return {bg:u.backgroundColor,color:u.color,track:getComputedStyle(document.documentElement).getPropertyValue('--track').trim()};})()`);
    const band = await b.evalIn(`getComputedStyle(document.documentElement).getPropertyValue('--band').trim()`);
    check('labels read back: a green check, the words in ink on the band, an outlined Undo, and no ×', /green/.test(labelled.kind) && labelled.mark === 'check-circle' && labelled.tone === 'safe' && labelled.green && labelled.background === 'rgb(46, 46, 46)' && band === '#2E2E2E' && labelled.actions.join() === 'undo-write' && !labelled.close && labelled.sentence === '' && undoLook.color === 'rgb(237, 237, 238)' && undoLook.bg === 'rgba(0, 0, 0, 0)', { labelled, undoLook, band });

    await b.evalIn(`__mock.restoreSkip=1`);
    await b.click('#more');
    const undoNames = await b.evalIn(`({button:document.getElementById('undo-write').textContent,menu:document.querySelector('#menu [data-menu="undo"]').textContent})`);
    await press(b, 'Escape');
    await b.click('#undo-write');
    await waitModal();
    const undoSheet = await dialogText();
    undoNames.title = await b.evalIn(`document.getElementById('dialog-title').textContent`);
    undoNames.ok = await b.evalIn(`document.getElementById('dialog-ok').textContent`);
    undoNames.page = await b.evalIn(`/Undo Write/.test(document.documentElement.innerHTML)`);
    check('one name, Undo: the status button, the ··· menu item, the sheet\'s title and its button, and no Undo Write anywhere on the page', undoNames.button === 'Undo' && undoNames.menu === 'Undo' && undoNames.title === 'Undo?' && undoNames.ok === 'Undo' && !undoNames.page, undoNames);
    check('Undo says what it puts back, in plain words, and not when, for a write made today', /^Undo\?/.test(undoSheet) && /Takes Mango off 4 clips and puts back the labels they had before\./.test(undoSheet) && !/Made /.test(undoSheet), undoSheet);
    await b.click('#dialog-ok');
    await b.waitFor(`__mock.calls.some(function(c){return c.fn==='restore';})`);
    const rest = (await calls('restore'))[0].args;
    check('Undo takes the right-click label back: it sends back what the write replaced', rest.restore.kind === 'label' && rest.restore.items.length === 4 && rest.project === PROJECT.path);
    await b.waitFor(`/left alone/.test(${text('foot-sentence')})`);
    const undone = await footNow();
    check('a restore that skips an item says so, and is never green', !/green/.test(undone.kind) && /left alone/.test(undone.sentence), undone.sentence);

    // every clip on screen: Cmd-A, then right-click, Label, a colour. Past 50 clips the Label sheet asks first.
    await b.evalIn(`SelectApp.state.selected.clear();SelectApp.state.outcome=null;SelectApp.applyView();__mock.calls.length=0`);
    await labelFromMenu(b, 7);
    await waitModal();
    const wholeText = await dialogText(), allPicked = await b.evalIn(`SelectApp.state.selected.size`);
    check('Cmd-A then right-click, Label above 50 clips opens the Label sheet: 400 clips, Mango chosen, and the undo truth', allPicked === 400 && /^Label 400 clips\?/.test(wholeText) && /Label: Mango/.test(wholeText) && /Too big for Cmd\+Z\. Undo takes it back\./.test(wholeText) && !/lantern-spring/.test(wholeText), { allPicked, wholeText });
    await b.shot('05-label-dialog');
    await b.click('#dialog-cancel');
    check('cancel writes nothing, and closes the sheet', (await calls('label')).length === 0 && !(await modalOpen()) && !(await b.evalIn(`SelectApp.state.busy`)));
    await labelFromMenu(b, 7);
    await waitModal();
    await b.click('#dialog-ok');
    await b.waitFor(`/^Labelled 400 clips/.test(${text('foot-verdict')})&&!SelectApp.state.busy`);
    const wholeCalls = (await calls('label')).map(c => c.args), wholeIds = wholeCalls.flatMap(c => c.items.map(p => p[0]));
    const recordId = await b.evalIn(`(function(){var k=Object.keys(__disk.files()).filter(function(x){return x.indexOf('/undo/')>=0&&/[.]json$/.test(x);}).sort();return JSON.parse(__disk.files()[k[k.length-1]]).id;})()`);
    check('a long write goes in batches of 100, every clip once, all with one write id for Premiere, and the last batch says it is the last', wholeCalls.length === 4 && wholeCalls.every(c => c.items.length === 100) && new Set(wholeIds).size === 400 && new Set(wholeCalls.map(c => c.write)).size === 1 && wholeCalls[0].write === recordId && wholeCalls.map(c => c.final).join() === 'false,false,false,true', wholeCalls.map(c => [c.items.length, c.write, c.final]));
    await sleep(320);
    check('labels on the whole view read back: green', (await footNow()).green, (await footNow()).sentence);
    await press(b, 'Escape');
    const logged = await b.evalIn(`SelectApp.state.hostLog.filter(function(x){return x.fn==='label';}).slice(-4)`);
    check('each host call is logged with the time it took inside Premiere and in all', logged.length === 4 && logged.every(x => x.ms === 300 && typeof x.wall === 'number' && x.wall >= 0 && x.ok), logged);

    // -------- no ×: a write that worked goes by itself, 6 s after it shows (shortened here), and asks nothing of Premiere
    // The editor leaving Select for the Timeline: the pointer goes out of the panel, and the panel loses focus.
    const away = () => b.evalIn(`document.documentElement.dispatchEvent(new MouseEvent('mouseleave'));window.dispatchEvent(new Event('blur'));true`);
    const greenNow = `SelectApp.state.outcome&&SelectApp.state.outcome.green&&!SelectApp.state.busy`;
    await away();
    await b.evalIn(`SelectApp.timeouts.settle=1600`);
    await b.click(rowSel(1));
    await labelFromMenu(b);
    await b.waitFor(greenNow, 'green');
    const t0 = Date.now();
    await away();
    await sleep(320);
    const showing = await footNow();
    await sleep(830);    // the watch the write itself asks for lands first, as it always has
    const callsAt = await b.evalIn(`__mock.calls.length`), stillThere = await footNow();
    await b.waitFor(`!SelectApp.state.outcome`, 'goes by itself', 4000);
    const ms = Date.now() - t0;
    await sleep(400);
    const gone = { ms, foot: await footNow(), asked: await b.evalIn(`__mock.calls.slice(${callsAt}).map(function(c){return c.fn;})`) };
    await b.click('#more');
    const undoKept = await b.evalIn(`(function(){var u=document.querySelector('#menu [data-menu="undo"]');return {shown:!u.hidden,off:u.disabled,text:u.textContent,tip:u.title};})()`);
    await press(b, 'Escape');
    check('a write that worked shows green with Undo and no ×, then, once the editor has left Select, goes by itself after the wait; the bar counts as it did, its writes there', showing.green && !showing.close && showing.actions.join() === 'undo-write' && stillThere.green && gone.ms >= 1500 && !gone.foot.green && !gone.foot.close && gone.foot.verdict === '' && gone.foot.count === '1 of 400 clips selected' && gone.foot.bar.join() === 'do-sequence,do-bins*', { showing: showing.verdict, stillThere: stillThere.verdict, gone });
    // With the pointer away, the watch poll may look at the Project panel meanwhile; the closing itself asks nothing.
    check('after it goes, Undo is still in the ··· menu, and the closing asked nothing of Premiere', undoKept.shown && !undoKept.off && undoKept.text === 'Undo' && /^Takes Mango off 1 clip/.test(undoKept.tip) && gone.asked.filter(fn => fn !== 'watch').length === 0, { undoKept, asked: gone.asked });
    // the wait stops while the pointer is anywhere in Select, on the clips too, or Select has focus; it starts again,
    // whole, once the editor has left
    await b.evalIn(`SelectApp.timeouts.settle=500`);
    await labelFromMenu(b);
    await b.waitFor(greenNow, 'green again');
    const onClips = await b.evalIn(`(function(){var r=document.getElementById('grid').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: onClips.x, y: onClips.y });
    await sleep(1100);
    const held = await footNow();
    await away();
    await b.evalIn(`window.dispatchEvent(new Event('focus'));true`);
    await sleep(1100);
    const focused = await footNow();
    await away();
    const leftAt = Date.now();
    await b.waitFor(`!SelectApp.state.outcome`, 'goes once the editor leaves', 4000);
    const afterLeave = Date.now() - leftAt;
    check('while the pointer is anywhere in Select (here on the clips) or Select has focus the wait stops, so nothing moves under the editor; once he has left it starts again', held.green && held.actions.join() === 'undo-write' && focused.green && afterLeave >= 420, { held: held.verdict, focused: focused.verdict, afterLeave });
    await b.evalIn(`SelectApp.state.selected.clear();SelectApp.applyView()`);

    await b.click('#do-bins');
    await waitModal();
    const binText = await dialogText(), binName = await b.evalIn(`({value:document.getElementById('sheet-name').value,focus:document.activeElement.id,selected:document.activeElement.selectionEnd-document.activeElement.selectionStart})`);
    check('Sort into Bins confirmation names the top bin in its field, selected, and every bin with its count', /^Sort 400 clips into bins\?/.test(binText) && /^SELECT \d{4}-\d\d-\d\d Sharpest first$/.test(binName.value) && binName.focus === 'sheet-name' && binName.selected === binName.value.length && /01 Sharpest\s+\d+/.test(binText) && /05 Softest\s+\d+/.test(binText) && !/lantern-spring/.test(binText), { binText, binName });
    check('the sheet has the menus\' radius of 8, one cobalt button and the undo truth', (await b.evalIn(`getComputedStyle(document.getElementById('dialog')).borderRadius`)) === '8px' && (await b.evalIn(`Array.from(document.querySelectorAll('#dialog button')).filter(function(x){return getComputedStyle(x).backgroundColor==='rgb(47, 111, 230)';}).length`)) === 1 && /Too big for Cmd\+Z\. Undo takes it back\./.test(binText));
    await b.shot('07-bins-dialog');
    await b.click('#dialog-ok');
    await b.waitFor(`/Sorted into/.test(${text('foot-verdict')})`);
    const binCalls = (await calls('bins')).map(c => c.args), moves = binCalls.flatMap(c => c.buckets.flatMap(x => x.items.map(p => p[0])));
    check('Sort into Bins goes in batches of 100 into one top bin, every clip once, read back once', binCalls.length === 4 && !binCalls[0].top && new Set(binCalls.slice(1).map(c => c.top)).size === 1 && /^t\d+$/.test(binCalls[1].top) && moves.length === 400 && new Set(moves).size === 400 && (await calls('binsCheck')).length === 1, binCalls.map(c => [c.top || '-', c.buckets.map(x => x.items.length)]));
    await sleep(320);
    const sortedFoot = await b.evalIn(`(function(){var u=getComputedStyle(document.getElementById('undo-write'));return {f:${foot},undoBg:u.backgroundColor,undoColor:u.color,sentence:getComputedStyle(document.getElementById('foot-sentence')).color};})()`);
    check('bins read back: the green on the icon only, the verdict alone in ink, an outlined Undo', sortedFoot.f.green && /^Sorted into 6 bins$/.test(sortedFoot.f.verdict) && sortedFoot.f.sentence === '' && sortedFoot.undoBg === 'rgba(0, 0, 0, 0)' && sortedFoot.undoColor === 'rgb(237, 237, 238)' && sortedFoot.f.color === 'rgb(237, 237, 238)', sortedFoot);
    await b.shot('08-bins-green');
    await b.click('#flip');
    await sleep(320);
    check('a new view moves on from the green foot', !(await footNow()).green);
    await b.click('#flip');

    // -------- a read-back that does not match is never green
    await b.evalIn(`__mock.misplaced=3`);
    await b.click('#do-bins');
    await waitModal();
    await b.click('#dialog-ok');
    await b.waitFor(`/Moved 397 of 400/.test(${text('foot-verdict')})`);
    const partial = await footNow();
    check('partial read-back on bins: plain words, no green, an amber alert', !partial.green && !/green/.test(partial.kind) && partial.mark === 'alert' && partial.tone === 'warn' && /3 clips didn't land\./.test(partial.sentence) && partial.actions.includes('undo-write'), partial);
    await b.shot('14-bins-partial');
    await b.evalIn(`__mock.misplaced=0;__mock.unconfirmed=true;SelectApp.state.outcome=null;SelectApp.applyView()`);
    await b.click('#do-bins');
    await waitModal();
    await b.click('#dialog-ok');
    await b.waitFor(`/not confirmed/.test(${text('foot-verdict')})`);
    check('a write with no read-back at all is not green, whatever the host says', !(await footNow()).green, (await footNow()).sentence);
    await b.evalIn(`__mock.unconfirmed=false;__mock.misplaced=0;SelectApp.state.outcome=null;SelectApp.applyView()`);

    await b.evalIn(`__mock.partial=true;SelectApp.timeouts.settle=300`);
    await labelFromMenu(b);
    await waitModal();
    await b.click('#dialog-ok');
    await b.waitFor(`/Labelled 399 of 400/.test(${text('foot-verdict')})&&!SelectApp.state.busy`);
    check('partial failures: no green, and Details lists them', !(await footNow()).green && (await footNow()).actions.includes('foot-details'), (await footNow()).sentence);
    await sleep(900);
    const stays = await footNow();
    await b.evalIn(`SelectApp.timeouts.settle=6000`);
    check('a write that didn\'t all land stays, with no ×, long after a success would have gone', stays.verdict === 'Labelled 399 of 400 clips' && stays.actions.includes('foot-details') && stays.actions.includes('undo-write') && !stays.close, stays);
    await b.click('#foot-details');
    await waitModal();
    check('partial failures are listed', /simulated failure/.test(await dialogText()), await dialogText());
    await b.click('#dialog-ok');
    await b.evalIn(`__mock.partial=false;SelectApp.state.outcome=null;SelectApp.state.selected.clear();SelectApp.applyView()`);

    // -------- refusals
    const start = await b.evalIn(`__mock.calls.length`);
    await b.evalIn(`__mock.config='{"writeLockFile":"/tmp/some-tool.lock.json"}';__mock.lockFile=${JSON.stringify(JSON.stringify({ who: 'cutting tool', pid: 123, op: 'build cut', since: 'now' }))}`);
    await labelFromMenu(b);
    await b.waitFor(`/write lock is held by cutting tool/.test(${text('status-note')})`);
    await b.evalIn(`SelectApp.state.selected.clear();SelectApp.applyView()`);
    check('write refused while the configured lock is held, no dialog, no host write', !(await modalOpen()) && (await b.evalIn(`__mock.calls.slice(${start}).map(function(c){return c.fn;})`)).filter(own).length === 0, await noteText());
    await b.evalIn(`__mock.lockFile='{broken'`);
    await b.click('#do-bins');
    await b.waitFor(`/write lock is held/.test(${text('status-note')})`);
    check('unreadable lock file is refused too', !(await modalOpen()));
    await b.evalIn(`__mock.config=null;__mock.lockFile='{"pid":123}'`);
    await labelFromMenu(b);
    await waitModal();
    check('with no setting the lock file is not even looked at', true);
    await b.click('#dialog-cancel');
    await b.evalIn(`__mock.config='not json at all';__mock.lockFile='{"pid":123}'`);
    await labelFromMenu(b);
    await waitModal();
    check('a broken config file never breaks the panel, and means no check', b.problems.length === 0);
    await b.click('#dialog-cancel');
    await b.evalIn(`__mock.config=null;__mock.lockFile=null;__mock.playback={program:true,source:false,modal:''}`);
    await labelFromMenu(b);
    await b.waitFor(`/Playback is running/.test(${text('status-note')})`);
    check('write refused while the program plays', !(await modalOpen()));
    await b.evalIn(`SelectApp.state.selected.clear();SelectApp.applyView()`);
    await b.evalIn(`__mock.playback={program:null,source:false,modal:''}`);
    await b.click('#do-bins');
    await b.waitFor(`/didn't answer\. Nothing was written/.test(${text('status-note')})`);
    check('unknown playback state is refused', !(await modalOpen()), await noteText());
    await b.evalIn(`__mock.playback={program:false,source:false,modal:'dialog'}`);
    await labelFromMenu(b);
    await b.waitFor(`/dialog is open/.test(${text('status-note')})`);
    check('open dialog in Premiere is refused', !(await modalOpen()));
    await b.evalIn(`__mock.playback={program:false,source:false,modal:''}`);
    // lock taken while the sheet is up
    await b.evalIn(`__mock.config='{"writeLockFile":"/tmp/some-tool.lock.json"}'`);
    await labelFromMenu(b);
    await waitModal();
    await b.evalIn(`__mock.lockFile=${JSON.stringify(JSON.stringify({ who: 'tool y', pid: 123, op: 'x' }))}`);
    const n0 = (await calls('label')).length;
    await b.click('#dialog-ok');
    await b.waitFor(`/held by tool y/.test(${text('status-note')})`);
    check('lock checked again after the confirmation', (await calls('label')).length === n0);
    await b.evalIn(`__mock.lockFile=null;__mock.config=null;SelectApp.state.selected.clear();SelectApp.applyView()`);
    // the host's own refusal, in the write call, reaches the user
    await b.evalIn(`__mock.hostFail={fn:'bins',reply:{ok:false,code:'playing',message:'Playback is running. Stop it and try again. Nothing was written.'}}`);
    await b.evalIn(`document.getElementById('status-note').textContent=''`);
    await b.click('#do-bins');
    await waitModal();
    await b.click('#dialog-ok');
    await b.waitFor(`/Playback is running/.test(${text('status-note')})`);
    check('a refusal from the host write call is shown', !(await modalOpen()), await noteText());
    await b.evalIn(`__mock.hostFail=null`);
    await b.evalIn(`SelectApp.state.selected.clear();SelectApp.applyView()`);
    await sleep(40);

    // -------- double click
    await b.evalIn(`__mock.calls.length=0`);
    await b.click('#body .r[data-at="1"]', { count: 2 });
    await b.waitFor(`__mock.calls.some(function(c){return c.fn==='open';})`);
    await sleep(150);
    const op = (await calls('open'))[0].args, openFlow = await b.evalIn(`__mock.calls.map(function(x){return x.fn;})`), openNote = await noteText();
    const want1 = await b.evalIn(`(function(){var r=SelectApp.state.store.rows[SelectApp.state.order[1]];return [r.ids[0],r.path];})()`);
    check('double-click opens the clip by the id the scan gave, with its path, asks Premiere for nothing else first, and says nothing when it worked', op.id === want1[0] && op.path === want1[1] && op.project === PROJECT.path && openFlow.filter(own).join() === 'open' && openNote === '', { op, openFlow, openNote });
    await b.evalIn(`__mock.calls.length=0;__mock.openMissing=true;document.getElementById('status-note').textContent=''`);
    await b.click('#body .r[data-at="2"]', { count: 2 });
    await b.waitFor(`__mock.calls.filter(function(c){return c.fn==='open';}).length>=2||document.getElementById('modal')&&!document.getElementById('modal').hidden`, 'open falls back', 5000).catch(() => {});
    await sleep(120);
    const fallback = await b.evalIn(`__mock.calls.map(function(c){return c.fn;})`);
    check('a clip whose id has gone is looked for again by its path, in both Unicode forms, before anything is said', fallback.filter(own).join() === 'open,find,open', fallback);
    if (await modalOpen()) { await b.click('#dialog-cancel'); }
    await b.evalIn(`__mock.openMissing=false`);

    // -------- 0.2: a long write goes in batches, shows its progress, and Stop leaves a clean write that Undo takes back
    await b.evalIn(`SelectApp.state.selected.clear();SelectApp.state.outcome=null;SelectApp.applyView();__mock.calls.length=0;__mock.slow={label:700}`);
    await labelFromMenu(b);
    await waitModal();
    await b.click('#dialog-ok');
    await b.waitFor(`SelectApp.state.write&&SelectApp.state.write.done>=100`, 'first batch landed');
    const going = await b.evalIn(`({foot:${foot},busy:SelectApp.state.busy})`);
    check('a long write shows real progress in one line: how many of how many, and Stop', going.foot.verdict === 'Labelling 100 of 400 clips' && going.foot.sentence === '' && going.foot.mark === 'spinner' && going.foot.actions.join() === 'stop' && going.foot.bar.join() === '' && !going.foot.close && going.busy === 'Labelling 400 clips', going);
    await b.click('#more');
    const busyMenu = await b.evalIn(`(function(){var q=function(id){return document.querySelector('#menu [data-menu="'+id+'"]');};return {undo:q('undo').disabled,undoShown:!q('undo').hidden,rescan:q('rescan').disabled,clear:q('clear').disabled};})()`);
    await press(b, 'Escape');
    check('while a write runs, Undo, Rescan and Clear Results in the ··· menu are off', busyMenu.undo && busyMenu.undoShown && busyMenu.rescan && busyMenu.clear, busyMenu);
    await b.click('#stop');
    await b.waitFor(`!SelectApp.state.busy`, 'write stops', 10000);
    await sleep(80);
    const stoppedWrite = { foot: await footNow(), sent: (await calls('label')).map(c => c.args.items.length) };
    check('Stop ends the write after the batch in flight: what landed is said, never green, and Undo is offered', stoppedWrite.sent.join() === '100,100' && stoppedWrite.foot.verdict === 'Labelled 200 of 400 clips' && /Stopped: 200 weren't sent\./.test(stoppedWrite.foot.sentence) && !stoppedWrite.foot.green && stoppedWrite.foot.actions.includes('undo-write'), stoppedWrite);
    await b.evalIn(`__mock.slow={}`);
    await b.click('#undo-write');
    await waitModal();
    const partUndo = await dialogText();
    check('Undo offers exactly what the stopped write did, and says no time for a write made today', /Takes Mango off 200 clips and puts back/.test(partUndo) && !/Made /.test(partUndo), partUndo);
    await b.click('#dialog-ok');
    await b.waitFor(`SelectApp.state.outcome&&/Undone/.test(SelectApp.state.outcome.verdict)&&!SelectApp.state.busy`);
    const back200 = (await calls('restore')).map(c => c.args);
    check('and puts it back in batches, in the project it was written to', back200.length === 2 && back200.reduce((n, c) => n + c.restore.items.length, 0) === 200 && back200.every(c => c.restore.kind === 'label' && c.project === PROJECT.path), back200.map(c => c.restore.items.length));

    // -------- 0.2: Undo is a stack, newest first
    await b.evalIn(`SelectApp.state.outcome=null;SelectApp.state.selected.clear();SelectApp.applyView();__mock.calls.length=0`);
    await labelFromMenu(b);
    await waitModal();
    await b.click('#dialog-ok');
    await b.waitFor(`/^Labelled 400 clips/.test(${text('foot-verdict')})&&!SelectApp.state.busy`);
    await b.evalIn(`SelectApp.state.outcome=null;SelectApp.state.selected.clear();SelectApp.applyView()`);
    await b.click('#do-bins');
    await waitModal();
    await b.click('#dialog-ok');
    await b.waitFor(`/^Sorted into/.test(${text('foot-verdict')})&&!SelectApp.state.busy`);
    const records = await b.evalIn(`Object.keys(__disk.files()).filter(function(k){return k.indexOf('/undo/')>=0&&/[.]json$/.test(k);}).length`);
    await b.click('#undo-write');
    await waitModal();
    const firstUndo = await dialogText();
    await b.click('#dialog-ok');
    await b.waitFor(`SelectApp.state.outcome&&SelectApp.state.outcome.kind==='undone'&&!SelectApp.state.busy`);
    await b.click('#more');
    await b.click('[data-menu="undo"]');
    await waitModal();
    const secondUndo = await dialogText();
    await b.click('#dialog-ok');
    await b.waitFor(`SelectApp.state.outcome&&SelectApp.state.outcome.kind==='undone'&&!SelectApp.state.busy&&__mock.calls.some(function(c){return c.fn==='restore'&&c.args.restore.kind==='label';})`);
    const kinds = (await calls('restore')).map(c => c.args.restore.kind);
    check('Undo goes back one write at a time, newest first: the bins, then the labels before them', /^Undo\?\s*Moves 400 clips back to the bins they came from/.test(firstUndo) && /Takes Mango off 400 clips/.test(secondUndo) && kinds.includes('bins') && kinds.indexOf('label') > kinds.lastIndexOf('bins') && records >= 2 && records <= 10, { kinds, records, first: firstUndo.slice(0, 90), second: secondUndo.slice(0, 90) });

    // -------- 0.2: Undo outlives a reload of the panel. 0.4 has no Add Columns, but a record one left in 0.2 or 0.3
    // is still on testers' disks, written as 0.3 wrote it, and goes back.
    await b.evalIn(`SelectApp.state.outcome=null;SelectApp.applyView();__mock.calls.length=0`);
    const oldRecord = await b.evalIn(`(function(){var rows=SelectApp.state.store.rows.filter(function(r){return r.ids.length;}).slice(0,400);
      var entry={v:1,id:SelectNative.newUndoId(),project:${JSON.stringify(PROJECT.path)},at:new Date().toISOString(),kind:'columns',meta:{fields:13},
        restore:{kind:'columns',fields:['SelectRank','SelectSharpness'],items:rows.map(function(r){return {id:r.ids[0],wrote:{SelectRank:'0001'},was:{SelectRank:''},path:r.path};})}};
      return SelectNative.saveUndo(entry.project,entry,10).ok;})()`);
    await b.open();
    await b.waitFor(`document.getElementById('project-name').textContent==='lantern-spring'`, 'project after reload');
    await b.waitFor(`!SelectApp.state.restoring`, 'last results back');
    await b.click('#more');
    const afterReload = await b.evalIn(`(function(){var u=document.querySelector('#menu [data-menu="undo"]');return {shown:!u.hidden,off:u.disabled,tip:u.title};})()`);
    await b.click('[data-menu="undo"]');
    await waitModal();
    const reloadSheet = await dialogText();
    await b.click('#dialog-ok');
    await b.waitFor(`SelectApp.state.outcome&&!SelectApp.state.busy`);
    const reloadRestore = (await calls('restore')).map(c => c.args);
    check('after the panel reloads, Undo is still in the menu and puts back an Add Columns write from 0.3, fields and all', oldRecord && afterReload.shown && !afterReload.off && /Puts back what the Select columns held on 400 clips/.test(afterReload.tip) && /Puts back what the Select columns held on 400 clips before this write/.test(reloadSheet) && reloadRestore.length === 4 && reloadRestore.every(c => c.restore.kind === 'columns' && c.restore.fields.join() === 'SelectRank,SelectSharpness' && c.project === PROJECT.path && /^undo-/.test(c.write)) && reloadRestore.map(c => c.final).join() === 'false,false,false,true', { afterReload, n: reloadRestore.length });
    // -------- 0.4: Restart after an update reloads the page, and Premiere still holds the old host (protocol 2). The page
    // loads its own before its first call, so no call reaches a host without it.
    await b.evalIn(`localStorage.setItem('__hostProtocol','2');localStorage.setItem('__hostLoadMs','400')`);
    await b.open();
    await b.waitFor(`document.getElementById('project-name').textContent==='lantern-spring'`, 'project after Restart');
    const boot = await b.evalIn(`({events:__mock.events.slice(),loads:__mock.loads})`);
    await b.evalIn(`localStorage.removeItem('__hostProtocol');localStorage.removeItem('__hostLoadMs')`);
    check('after an update and Restart, the page loads its own host before any call, and only once', boot.loads === 1 && boot.events.slice(0, 3).join() === 'check 2,load,loaded' && boot.events.indexOf('load', 2) === -1 && boot.events.slice(3).length > 0, boot.events.slice(0, 8));
    // The page came back fresh: give it the scan the rest of the run expects.
    await setItems(b, 400);
    await scanAndWait(b);
    await pickSort(b, 'sharpness');
    // A host that still lacks a call (loaded by another panel meanwhile, say): the call is refused as unknown, the page
    // loads its host again, and sends the call once more.
    await b.evalIn(`__mock.stale=['open'];__mock.events.length=0;__mock.calls.length=0;document.getElementById('status-note').textContent=''`);
    await b.click('#body .r[data-at="3"]', { count: 2 });
    await b.waitFor(`__mock.events.filter(function(e){return e==='open';}).length>=2`, 'opened after loading the host again', 5000).catch(() => {});
    await sleep(100);
    const retried = await b.evalIn(`({events:__mock.events.slice(),note:document.getElementById('status-note').textContent})`);
    check('a call the host doesn\'t know loads the host again and is sent once more', retried.events.filter(own).join() === 'open,check 3,load,loaded,open' && retried.note === '', retried);

    // -------- S2: Premiere gives the project's path in the other Unicode form, and the newest files in its Undo folder
    // don't read as records: Undo still reaches the last write, asks Premiere by the path it gives now, and leaves
    // the files it couldn't read where they are.
    const CREME = { path: '/Volumes/Field SSD/Projects/Crème.prproj', name: 'Crème.prproj' };
    const cremeNfd = { path: CREME.path.normalize('NFD'), name: CREME.name.normalize('NFD') };
    // Results belong to the project they were scanned in, so Crème gets its own scan first.
    await b.evalIn(`__mock.project=${JSON.stringify(CREME)};SelectApp.state.outcome=null`);
    await scanAndWait(b);
    await b.evalIn(`SelectApp.state.selected.clear();SelectApp.state.anchor=null;SelectApp.applyView();__mock.calls.length=0`);
    await b.click(`#body .r[data-at="0"]`);
    await labelFromMenu(b);
    await b.waitFor(`/^Labelled 1 clip/.test(${text('foot-verdict')})&&!SelectApp.state.busy`);
    const oddRecords = { '1999999999999-0001': '{"v":1,"project":', '1999999999998-0001': JSON.stringify({ v: 2, project: CREME.path, restore: { kind: 'label', items: [['9', 0, '/v/x.mp4']] } }) };
    const undoFolder = await b.evalIn(`SelectNative.undoDir(${JSON.stringify(CREME.path)})`);
    await b.evalIn(`(function(){var fs=require('fs'),o=${JSON.stringify(oddRecords)};Object.keys(o).forEach(function(id){fs.writeFileSync(${JSON.stringify(undoFolder)}+'/'+id+'.json',o[id]);});})()`);
    await b.evalIn(`__mock.project=${JSON.stringify(cremeNfd)};SelectApp.state.outcome=null;SelectApp.applyView();__mock.calls.length=0`);
    await b.click('#more');
    await b.evalIn(`SelectApp.state.undo=null`);
    await b.click('[data-menu="undo"]');
    const nfdSheet = await b.waitFor(`!document.getElementById('modal').hidden`, 'the Undo sheet', 3000).then(() => dialogText(), () => noteText());
    if (await modalOpen()) { await b.click('#dialog-ok'); await b.waitFor(`SelectApp.state.outcome&&!SelectApp.state.busy`); }
    const nfdRestore = (await calls('restore')).map(c => c.args.project);
    const left = await b.evalIn(`Object.keys(__disk.files()).filter(function(k){return k.indexOf(${JSON.stringify(undoFolder + '/')})===0;}).map(function(k){return k.slice(${undoFolder.length + 1});}).sort()`);
    check('S2: with the project\'s path in the other Unicode form, Undo reaches the last write past records it can\'t read, asks Premiere by today\'s path, and keeps those files',
      /Takes Mango off 1 clip/.test(nfdSheet) && nfdRestore.length === 1 && nfdRestore[0] === cremeNfd.path && left.join() === Object.keys(oddRecords).map(id => id + '.json').sort().join(), { sheet: nfdSheet.slice(0, 80), nfdRestore, left });
    await b.evalIn(`__mock.project=${JSON.stringify(PROJECT)};SelectApp.state.undo=null;SelectApp.state.outcome=null;SelectApp.applyView();__mock.calls.length=0`);
    await scanAndWait(b);

    // -------- 0.2: a clip that changed in the project while the sheet was open is left alone
    await b.evalIn(`SelectApp.state.outcome=null;SelectApp.state.selected.clear();SelectApp.state.anchor=null;SelectApp.applyView();__mock.calls.length=0`);
    await labelFromMenu(b);
    await waitModal();
    await b.evalIn(`(function(){var id=SelectApp.state.store.rows[SelectApp.state.order[0]].ids[0];__mock.items=__mock.items.map(function(it){return it.id===id?{id:it.id,path:it.path+'.other.mp4',name:'other'}:it;});})()`);
    await b.click('#dialog-ok');
    await b.waitFor(`/^Labelled/.test(${text('foot-verdict')})&&!SelectApp.state.busy`);
    const changedSince = await footNow();
    check('a clip whose id changed while the sheet was open is left alone, and the foot says so', changedSince.verdict === 'Labelled 399 of 400 clips' && /1 clip changed since, left alone\./.test(changedSince.sentence) && !changedSince.green && changedSince.actions.includes('foot-details'), changedSince);
    await setItems(b, 400);
    await b.evalIn(`SelectApp.state.selected.clear();SelectApp.state.anchor=null;SelectApp.applyView()`);
    await b.click(rowSel(0));
    await b.click(rowSel(1), { shift: true });

    // -------- 0.2: a call Premiere doesn't answer in time frees the panel, and a late answer still reaches Undo
    await b.evalIn(`SelectApp.timeouts.other=1000;__mock.slow={label:2500};__mock.calls.length=0;SelectApp.state.outcome=null;SelectApp.applyView()`);
    await labelFromMenu(b);
    await b.waitFor(`/didn't answer within 1 second/.test(${text('status-note')})`, 'deadline', 6000);
    const lateBusy = await b.evalIn(`SelectApp.state.busy`);
    await labelFromMenu(b);
    await sleep(120);
    const refusedLate = { modal: await modalOpen(), note: await noteText() };
    check('a call past its deadline frees the panel and says so, and nothing new goes to Premiere until it answers', lateBusy === null && refusedLate.modal === false && refusedLate.note === 'Waiting for Premiere\'s last answer', refusedLate);
    await b.waitFor(`/answered late\. Undo covers it/.test(${text('status-note')})`, 'late answer', 8000);
    await b.click('#more');
    const lateTip = await b.evalIn(`document.querySelector('#menu [data-menu="undo"]').title`);
    await press(b, 'Escape');
    check('the late answer still goes into Undo', /Takes Mango off 2 clips/.test(lateTip), lateTip);
    await b.evalIn(`SelectApp.timeouts.other=120000;__mock.slow={};SelectApp.state.selected.clear();SelectApp.applyView()`);
    await b.evalIn(`__mock.diskFull=true;__mock.calls.length=0;SelectApp.state.outcome=null;SelectApp.applyView()`);
    await labelFromMenu(b);
    await waitModal();
    await b.click('#dialog-ok');
    await b.waitFor(`/couldn't save its Undo record/.test(${text('status-note')})`, 'refused for the disk');
    check('no write without a way back: when the Undo record can\'t be saved, nothing goes to Premiere', (await calls('label')).length === 0 && /\(ENOSPC\), so nothing was written/.test(await noteText()), await noteText());
    await b.evalIn(`__mock.diskFull=false;SelectApp.state.selected.clear();SelectApp.applyView()`);

    // -------- 0.2: a scan of a selection reads only the selection, and never swaps a picked clip for another copy
    await b.evalIn(`__mock.selection={kind:'clips',items:__mock.items.slice(0,2),places:['Day 2']}`);
    await pressScan(b);
    await b.waitFor(`SelectApp.state.scan&&SelectApp.state.scan.state==='Done'&&SelectApp.state.store.rows.length===2`, 'selection scan');
    const picked = { target: (await calls('target')).pop().args, source: await b.evalIn(`SelectApp.state.scan.source`), note: await noteText() };
    check('a scan with clips selected in the Project panel reads them alone, with no note', !picked.target.whole && picked.source === 'selection' && picked.note === '', picked);
    await b.evalIn(`__mock.items=[{id:'copy9',path:__mock.items[0].path,name:'copy'},__mock.items[1]];__mock.calls.length=0;SelectApp.state.selected.clear();SelectApp.state.outcome=null;SelectApp.applyView()`);
    await b.click('#do-sequence');
    await waitModal();
    const gonePick = await dialogText();
    await b.click('#dialog-ok');
    await b.waitFor(`__mock.calls.some(function(c){return c.fn==='sequence';})&&!SelectApp.state.busy`);
    const pickItems = (await calls('sequence'))[0].args.items;
    check('a picked clip that left the project is skipped, never replaced by another copy of its file', /1 clip isn't in this project\./.test(gonePick) && pickItems.length === 1 && pickItems[0][0] === 'id1', { gonePick, pickItems });
    await b.evalIn(`__mock.selection=null`);
    await setItems(b, 400);
    await scanAndWait(b);

    // -------- the menu's other doors
    await b.evalIn(`SelectApp.state.selected.clear();SelectApp.state.outcome=null;SelectApp.applyView()`);
    await b.click('#more');
    await b.click('[data-menu="bug"]');
    check('Report a Bug opens the issue page and sends nothing', (await b.evalIn(`__mock.urls.join()`)) === 'https://github.com/skyfallstatus/select/issues/new');
    await b.click('#more');
    await b.click('[data-menu="columns"]');
    await waitModal();
    await b.shot('15-columns-sheet');
    await b.click('[data-column="lens"]');
    await b.click('[data-column="camera"]');
    await b.click('#dialog-ok');
    const switched = await b.evalIn(`({lens:!!document.querySelector('#head .h[data-key="lens"]'),camera:!!document.querySelector('#head .h[data-key="camera"]'),saved:localStorage.getItem('select.columns')})`);
    check('Columns switches a column on and off, and remembers', switched.lens && !switched.camera && /"lens":true/.test(switched.saved), switched);
    await b.evalIn(`localStorage.removeItem('select.columns')`);
    await b.evalIn(`SelectApp.state.shownColumns={};SelectApp.applyView()`);
    const heads = await b.evalIn(`Array.from(document.querySelectorAll('#head .h')).map(function(h){return h.dataset.key;}).filter(function(k){return k!=='thumb';}).join()`);
    check('default columns are name, duration, sharpness, brightness, motion, audio, date, camera, plus the sort', /^name,durationS,sharpness,luma,motionProxy,audioDb,createdAt,camera/.test(heads), heads);
    await b.click('#more');
    await b.click('[data-menu="clear"]');
    const cleared = await footNow();
    const clearedView = await b.evalIn(`({sort:SelectApp.state.view.sort.length,show:SelectApp.state.view.show,families:SelectApp.state.view.families.length,on:document.querySelectorAll('#show.on,#sort.on,#families button.on').length,words:document.querySelector('#show .v').textContent+'|'+document.querySelector('#sort .v').textContent,flip:!document.getElementById('flip').hidden,marks:document.querySelectorAll('#head .mark').length})`);
    check('Clear Results goes back to the first band and the first view, the bar gone, and writes nothing', cleared.mark === 'bin' && cleared.actions.join() === 'scan*' && cleared.bar === null && (await b.evalIn(`SelectApp.state.store.rows.length`)) === 0 && !clearedView.sort && !clearedView.show && !clearedView.families && !clearedView.on && clearedView.words === 'Everything|As listed' && !clearedView.flip && !clearedView.marks, { cleared, clearedView });

    // -------- folder source, not in the project
    await b.evalIn(`__mock.folderFiles=['A0001.MP4','._A0001.MP4','A0001M01.XML','B0002.mov'];__mock.items=[{id:'p1',path:'/Volumes/Field SSD/f/A0001.MP4',name:'A0001.MP4'}];__mock.pickedFolder='/Volumes/Field SSD/f';__mock.execs.length=0`);
    await b.click('#more');
    await b.click('[data-menu="scan-folder"]');
    await b.waitFor(`SelectApp.state.scan && SelectApp.state.scan.state==='Done'&&SelectApp.state.store.rows.length===2`, 'folder scan');
    const picker = await b.evalIn(`__mock.execs.map(function(x){return x.bin;})`), kept = await b.evalIn(`[localStorage.getItem('select.source'),localStorage.getItem('select.folder')]`);
    check('Scan a Folder… opens the folder dialog and scans the folder, video only, and keeps nothing about it', picker.join() === '/usr/bin/osascript' && (await b.evalIn(`SelectApp.state.store.rows.map(function(r){return r.name;}).sort().join()`)) === 'A0001.MP4,B0002.mov' && kept.every(x => x === null), { picker, kept });
    await b.evalIn(`__mock.readdirMs=3000`);
    await b.click('#more');
    await b.click('[data-menu="scan-folder"]');
    await b.waitFor(`document.getElementById('foot').className==='listing'`, 'listing');
    const listing = await footNow();
    await b.click('#stop');
    await b.waitFor(`!SelectApp.state.listing`, 'listing stopped', 2000);
    await sleep(60);
    check('listing a folder offers Stop, and Stop ends it at once with nothing new scanned and nothing said', listing.verdict === 'Listing clips' && listing.actions.join() === 'stop' && (await b.evalIn(`SelectApp.state.store.rows.length`)) === 2 && (await noteText()) === '', listing);
    await b.evalIn(`__mock.readdirMs=0`);
    const atOf = await b.evalIn(`SelectApp.state.order.map(function(i){return SelectApp.state.store.rows[i].name;}).indexOf('B0002.mov')`);
    // The first press clears the note above the clips, so they move up a line before the second press: the
    // double-click still opens the clip the first press picked.
    await b.click(`#body .r[data-at="${atOf}"]`, { count: 2 });
    await waitModal();
    const offer = await dialogText(), offerTip = await b.evalIn(`document.getElementById('dialog-ok').title`);
    check('a clip outside the project is offered, not imported silently: its name as the question, no more words', /^Import B0002\.mov\?\s*Cancel\s*Import and Open$/.test(offer.trim()) && offerTip === 'Into the bin SELECT IMPORTS' && (await calls('importClips')).length === 0, { offer, offerTip });
    await b.shot('09-import-offer');
    await b.click('#dialog-ok');
    await b.waitFor(`__mock.calls.some(function(c){return c.fn==='importClips';})`);
    await b.waitFor(`__mock.calls.some(function(c){return c.fn==='open'&&c.args.id==='new0';})`);
    const imp = (await calls('importClips'))[0].args;
    const open2 = (await calls('open')).pop().args;
    check('import then open uses the new item', imp.paths[0] === '/Volumes/Field SSD/f/B0002.mov' && open2.id === 'new0', { imp, open2 });
    const atA = await b.evalIn(`SelectApp.state.order.map(function(i){return SelectApp.state.store.rows[i].name;}).indexOf('A0001.MP4')`);
    await b.click(`#body .r[data-at="${atA}"]`, { count: 2 });
    await sleep(200);
    check('a folder clip already in the project opens without an offer', (await calls('open')).pop().args.id === 'p1' && !(await modalOpen()));
    // one row in the project, one not: paths decide, whatever ids a row carried before
    await b.evalIn(`__mock.items=[{id:'p9',path:'/Volumes/Field SSD/f/A0001.MP4',name:'A0001.MP4'}];__mock.calls.length=0;SelectApp.state.selected.clear();SelectApp.state.store.rows.forEach(function(r){r.ids=['stale'];});SelectApp.applyView()`);
    await b.click('#do-sequence');
    await waitModal();
    const skipped = await dialogText();
    check('rows not in the project are counted as skipped', /1 clip isn't in this project\./.test(skipped), skipped);
    await b.click('#dialog-ok');
    await b.waitFor(`__mock.calls.some(function(c){return c.fn==='sequence';})&&!SelectApp.state.busy`);
    check('ids come from the project in front, never from an old scan', JSON.stringify((await calls('sequence'))[0].args.items) === '[["p9","/Volumes/Field SSD/f/A0001.MP4"]]', (await calls('sequence'))[0].args.items);
    const seqLeftOut = await footNow();
    check('Make Sequence\'s outcome says the clips it left out, in the sheet\'s words', seqLeftOut.verdict === 'Made a sequence of 1 clip' && seqLeftOut.sentence === '1 clip isn\'t in this project.', seqLeftOut);
    // Sort into Bins too: both rows picked, one of them not in the project
    await b.evalIn(`SelectApp.state.outcome=null;SelectApp.state.selected.clear();SelectApp.state.order.forEach(function(i){SelectApp.state.selected.add(i);});SelectApp.state.paintKey++;SelectApp.applyView();__mock.calls.length=0`);
    await b.click('#do-bins');
    await waitModal();
    const binSheet = await dialogText();
    await b.click('#dialog-ok');
    await b.waitFor(`SelectApp.state.outcome&&!SelectApp.state.busy`, 'one bin, one left out', 5000);
    const binLeftOut = { foot: await footNow(), sent: (await calls('bins')).map(c => c.args.buckets.map(x => x.items.length).join('+')) };
    check('Sort into Bins says the clip it left out in its sheet and in its outcome, in the same words', /1 clip isn't in this project\./.test(binSheet) && binLeftOut.sent.join() === '1' && binLeftOut.foot.verdict === 'Moved 1 clip into a bin' && binLeftOut.foot.sentence === '1 clip isn\'t in this project.', { binSheet, binLeftOut });
    await b.evalIn(`SelectApp.state.outcome=null;SelectApp.state.selected.clear();SelectApp.applyView()`);
    // another project in front, same clip path: the write lands on that project's item
    await b.evalIn(`__mock.project={path:'/Volumes/Field SSD/Projects/other.prproj',name:'other.prproj'};__mock.items=[{id:'q1',path:'/Volumes/Field SSD/f/A0001.MP4',name:'A0001.MP4'}];__mock.calls.length=0`);
    await b.click('#do-sequence');
    await waitModal();
    const named = await dialogText();
    check('a folder\'s results belong to no project: the sheet has no project line, and the write goes ahead in the project in front', !/\bother\b/.test(named) && !/lantern-spring/.test(named) && /^Make a sequence of 1 clip\?/.test(named), named);
    await b.click('#dialog-ok');
    await b.waitFor(`__mock.calls.some(function(c){return c.fn==='sequence';})&&!SelectApp.state.busy`);
    const inFront = (await calls('sequence'))[0].args;
    check('the write goes to the project in front, on its own item for the path', inFront.project === '/Volumes/Field SSD/Projects/other.prproj' && JSON.stringify(inFront.items) === '[["q1","/Volumes/Field SSD/f/A0001.MP4"]]', inFront);
    await b.evalIn(`__mock.project=${JSON.stringify(PROJECT)};SelectApp.state.outcome=null;SelectApp.applyView()`);

    // -------- failures of the engine
    await setItems(b, 400);
    b.engineEnv.FAKE_DELAY_MS = '5';
    await pressScan(b);
    await b.waitFor(`SelectApp.state.scan.handle&&SelectApp.state.store.tier0>3`);
    const spawnedBefore = b.engineLog.exited.length;
    await b.click('#stop');
    await b.waitFor(`SelectApp.state.scan.state==='Stopped'`);
    const stopped = await b.evalIn(`({rows:SelectApp.state.store.rows.length,t0:SelectApp.state.store.tier0,foot:${foot}})`);
    check('Stop ends the engine, rows stay, Scan is back', b.engineLog.exited.length === spawnedBefore + 1 && stopped.rows === 400 && stopped.t0 < 400 && stopped.foot.verdict === 'Stopped' && stopped.foot.mark === 'info' && /^\d+ of 400 clips read$/.test(stopped.foot.sentence) && stopped.foot.actions.includes('scan'), stopped);

    b.engineEnv.FAKE_DELAY_MS = '0';
    b.engineEnv.FAKE_MODE = 'crash';
    await b.click('#scan');
    await b.waitFor(`SelectApp.state.scan.state==='Failed'`);
    check('engine crash is reported in plain words; rows stay', /code 3/.test(await b.evalIn(text('foot-sentence'))) && /What was read stays/.test(await b.evalIn(text('foot-sentence'))) && (await b.evalIn(`SelectApp.state.store.rows.length`)) === 400 && (await b.evalIn(`document.getElementById('foot-sentence').title`)).includes('simulated crash'), await b.evalIn(text('foot-sentence')));
    b.engineEnv.FAKE_MODE = 'noend';
    await b.click('#scan');
    await b.waitFor(`SelectApp.state.scan.state==='Incomplete'`);
    check('engine that exits without done is reported', /before the last clip/.test(await b.evalIn(text('foot-sentence'))));
    b.engineEnv.FAKE_MODE = 'garbage';
    b.engineEnv.FAKE_ERRORS = '50';
    await b.click('#scan');
    await b.waitFor(`SelectApp.state.scan.state==='Done'`);
    const dirty = await b.evalIn(`document.getElementById('count').title.split('\\n').slice(0,-1).join(' ')`);
    check('junk lines and clip errors are counted, in the count\'s tooltip', /^16 clips could not be read: /.test(dirty) && /engine lines could not be understood/.test(dirty) && (await b.evalIn(`SelectApp.state.store.errors`)) === 16, dirty);
    await pickSort(b, 'createdAt');
    await pickSort(b, null);
    await b.shot('10-errors');
    b.engineEnv.FAKE_MODE = '';
    b.engineEnv.FAKE_ERRORS = '';
    await b.evalIn(`__mock.accessError='ENOENT'`);
    await pressScan(b);
    await b.waitFor(`/not installed/.test(${text('foot-sentence')})`);
    const noEngine = await footNow();
    check('missing engine: rows still list, and the band says what to do, with a red alert and Scan', (await b.evalIn(`SelectApp.state.store.rows.length`)) === 400 && noEngine.mark === 'alert' && noEngine.tone === 'bad' && /Reinstall Select/.test(noEngine.sentence) && noEngine.actions.includes('scan'), noEngine);
    await b.shot('17-no-engine');
    await b.evalIn(`__mock.accessError='EACCES'`);
    await b.click('#scan');
    await b.waitFor(`/macOS will not run/.test(${text('foot-sentence')})`);
    check('macOS refusing the engine says so, and where to go', /Privacy & Security/.test(await b.evalIn(text('foot-sentence'))), await b.evalIn(text('foot-sentence')));
    await b.evalIn(`__mock.accessError=null;__mock.spawnError='EPERM'`);
    await b.click('#scan');
    await b.waitFor(`SelectApp.state.scan&&SelectApp.state.scan.state==='Failed'&&/macOS will not run/.test(${text('foot-sentence')})`);
    check('a refused spawn reads the same as a refused check', true);
    await b.evalIn(`__mock.spawnError=null;__mock.project=null`);
    await b.evalIn(`SelectApp.startScan()`);
    await b.waitFor(`/No project is open/.test(${text('status-note')})`);
    await sleep(1100);
    await b.evalIn(`window.dispatchEvent(new Event('focus'))`);
    await b.waitFor(`SelectApp.state.project===null&&document.getElementById('scan').hidden`, 'no project seen', 5000);
    const noProject = await footNow(), fromTip = await b.evalIn(`document.getElementById('do-sequence').title`);
    // One row at a time: the refusal holds it; where the results are from is the bar's reason for its writes being off.
    check('no project open is a clear message, with nothing to scan or write, and the bar says where the results are from', noProject.verdict === 'No project is open' && noProject.tone === 'warn' && noProject.actions.join() === '' && noProject.bar.join() === '' && fromTip === 'From lantern-spring', { noProject, fromTip });
    await b.evalIn(`__mock.project={path:'/Volumes/Field SSD/Projects/north-pier.prproj',name:'north-pier.prproj'}`);
    await scanAndWait(b);
    check('a scan picks up the project in front, so the header is never stale', (await b.evalIn(text('project-name'))) === 'north-pier');
    await b.evalIn(`__mock.project=${JSON.stringify(PROJECT)}`);

    // -------- finished in Premiere's light theme
    b.engineEnv.FAKE_DELAY_MS = '0';
    await scanAndWait(b);
    await b.evalIn(`document.documentElement.dataset.theme`);
    const token = name => `getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify('--' + name)}).trim()`;
    const dark = await b.evalIn(`({theme:document.documentElement.dataset.theme,surface:${token('surface')},ink:${token('ink')}})`);
    check('Premiere dark: dark tokens, on Premiere\'s own panel grey', dark.theme === 'dark' && dark.surface === '#232323' && dark.ink === '#EDEDEE', dark);
    await b.evalIn(`__mock.skin={red:230,green:230,blue:230};__mock.listeners['com.adobe.csxs.events.ThemeColorChanged'].forEach(function(f){f();})`);
    const light = await b.evalIn(`({theme:document.documentElement.dataset.theme,surface:${token('surface')},ink:${token('ink')},bg:getComputedStyle(document.getElementById('grid')).backgroundColor})`);
    check('Premiere set bright: the theme-change event switches to the light tokens, on its new grey', light.theme === 'light' && light.surface === '#E6E6E6' && light.ink === '#1D1D1F' && light.bg === 'rgb(230, 230, 230)', light);
    await b.shot('18-light');
    // Ingest's tokens, but the ground and the greys around it are Premiere's own panel grey (230 and 35 here) moved by
    // Ingest's steps, and on the light grey ink2 and the red darken until they still read on every grey they sit on.
    const TOKENS = {
      light: { ink: '#1D1D1F', ink2: '#555659', ink3: '#5B5B5F', surface: '#E6E6E6', foot: '#DBDBDB', disc: '#CECECE', tick: '#3A3A3C', ring: '#B0B0B0', track: '#D0D0D0', meter: '#6E6E73', 'focus-ring': '#2563EB', cobalt: '#2563EB', bad: '#B92318', safe: '#15803D', 'plate-sel': 'rgba(0, 0, 0, .075)',
        band: '#DADADA', edge: '#AEAEAE', sel: '#CBCBCB', warn: '#B25B00' },
      dark: { ink: '#EDEDEE', ink2: '#ADADB1', ink3: '#98989D', surface: '#232323', foot: '#191919', disc: '#373737', tick: '#EDEDEE', ring: '#555555', track: '#373737', meter: '#A0A0A6', 'focus-ring': '#427DEA', cobalt: '#2F6FE6', bad: '#FF6A5F', safe: '#15803D', 'plate-sel': 'rgba(255, 255, 255, .11)',
        band: '#2E2E2E', edge: '#5D5D5D', sel: '#404040', warn: '#F5A524' }
    };
    const measured = [];
    for (const theme of ['light', 'dark']) {
      await b.evalIn(`__mock.skin=${theme === 'light' ? '{red:230,green:230,blue:230}' : '{red:35,green:35,blue:35}'};__mock.listeners['com.adobe.csxs.events.ThemeColorChanged'].forEach(function(f){f();})`);
      const got = await b.evalIn(`(function(){var o={};${JSON.stringify(Object.keys(TOKENS[theme]))}.forEach(function(k){o[k]=${token('X').replace('"--X"', "'--'+k")};});return o;})()`);
      check(`every ${theme} token is Ingest's, with the greys from Premiere's panel colour`, JSON.stringify(got) === JSON.stringify(TOKENS[theme]), got);
      const T = TOKENS[theme], sel = over(T['plate-sel'], T.surface);
      for (const [fg, bg, label] of [[T.ink, T.surface, 'ink on surface'], [T.ink2, T.surface, 'ink2 on surface'], [T.ink, T.foot, 'ink on foot'], [T.ink2, T.foot, 'ink2 on foot'], [T.ink, sel, 'ink on a selected row'], [T.ink2, sel, 'ink2 on a selected row'], [T.ink, T.disc, 'ink on a menu item under the pointer'], [T.ink2, T.disc, 'ink2 on a menu item under the pointer'], [T.ink, T.track, 'ink on a quiet button'], [T.bad, T.surface, 'bad on the status'], ['#FFFFFF', T.cobalt, 'white on cobalt'], ['#FFFFFF', T.safe, 'white on safe'], [T.safe, '#FFFFFF', 'safe on white'],
        [T.ink, T.band, 'ink on the band'], [T.ink2, T.band, 'ink2 on the band'], [T.ink, T.sel, 'ink on the view that is on']]) {
        measured.push({ theme, label, ratio: contrast(fg, bg) });
      }
    }
    const low = measured.filter(m => m.ratio < 4.5);
    check('every text colour measures at least 4.5:1 in both themes', low.length === 0, low.length ? low : `lowest ${Math.min(...measured.map(m => m.ratio)).toFixed(2)}:1 over ${measured.length} pairs`);

    // -------- 620 px, the panel's minimum
    await b.size(620, 420);
    // the longest words the toolbar can hold at once: the longest show and the longest sort, with its flip button, then a colour too
    await resetView(b);
    await pickShow(b, 'onscreen');
    await pickSort(b, 'clipHighPct');
    await sleep(120);
    const narrowNow = () => b.evalIn(`(function(){var d=document.documentElement,w=innerWidth,inside=function(sel){var r=document.querySelector(sel).getBoundingClientRect();return r.left>=0&&r.right<=w&&r.bottom<=innerHeight;};
      var words=['#show','#sort','#flip','#families','#search-box','#more'].map(function(sel){var r=document.querySelector(sel).getBoundingClientRect();return {sel:sel,mid:Math.round(r.top+r.height/2),l:r.left,r:r.right,shown:r.width>0};}),bar=document.getElementById('toolbar');
      var cut=Array.from(document.querySelectorAll('.pick .v')).filter(function(x){return x.scrollWidth>x.clientWidth;}).map(function(x){return x.textContent;});
      return {page:d.scrollWidth,lines:new Set(words.map(function(x){return x.mid;})).size,barOver:bar.scrollWidth-bar.clientWidth,cut:cut,said:document.querySelector('#show .v').textContent+'|'+document.querySelector('#sort .v').textContent,modes:inside('#mode-grid'),search:inside('#search-box'),wordsIn:words.every(function(x){return x.shown&&x.l>=0&&x.r<=w;}),bins:inside('#do-bins'),sequence:inside('#do-sequence'),more:inside('#more'),verdict:document.getElementById('foot-verdict').scrollWidth<=document.getElementById('foot-verdict').clientWidth,table:document.getElementById('grid').scrollWidth,grid:document.getElementById('grid').clientWidth,head:document.getElementById('top').scrollWidth};})()`);
    const narrow = await narrowNow();
    await b.click('#families [data-family="red"]');
    await sleep(120);
    const narrowRed = await narrowNow();
    check('at 620 px the toolbar stays one line with a show, a sort and a colour on, its words whole', narrowRed.lines === 1 && narrowRed.barOver <= 0 && !narrowRed.cut.length && narrowRed.wordsIn && narrowRed.modes && narrowRed.page <= 620, narrowRed);
    check('at 620 px nothing leaves the panel: the toolbar is one line with its words whole, the status and its actions stay whole', narrow.page <= 620 && narrow.lines === 1 && narrow.barOver <= 0 && !narrow.cut.length && narrow.said === 'Text on screen|Most clipped first' && narrow.modes && narrow.search && narrow.wordsIn && narrow.bins && narrow.sequence && narrow.more && narrow.verdict && narrow.head <= 620, narrow);
    check('at 620 px the table scrolls inside itself', narrow.table >= narrow.grid, narrow);
    await b.shot('19-620-light');
    await b.size(900, 620);
    await sleep(100);
    await resetView(b);

    // -------- motion
    await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const spinning = `(function(){var m=document.getElementById('foot-mark'),k=m.dataset.kind;m.dataset.kind='spinner';var a=getComputedStyle(m.querySelector('.ic')).animationName;m.dataset.kind=k;return a;})()`;
    const still = await b.evalIn(`({spin:${spinning},fade:getComputedStyle(document.getElementById('foot')).transitionDuration})`);
    check('prefers-reduced-motion: the spinner stands still and the band opens and closes with no transition', still.spin === 'none' && /^0s/.test(still.fade), still);
    // A row in the band (a result put there by hand) brings new words.
    const showRow = `SelectApp.state.outcome={kind:'undone',verdict:'Undone',sentence:'',undo:false,none:false,failed:[]};SelectApp.applyView()`;
    const verdictFades = () => b.evalIn(`document.getElementById('foot-verdict').getAnimations().length`);
    await b.waitFor(`document.getElementById('foot-verdict').getAnimations().length===0`, 'earlier fades to finish');
    await b.evalIn(showRow);
    const reducedFades = await verdictFades();
    check('prefers-reduced-motion: new words in the band arrive without a fade', reducedFades === 0 && (await b.evalIn(text('foot-verdict'))) === 'Undone', reducedFades);
    await b.evalIn(`SelectApp.state.outcome=null;SelectApp.applyView()`);
    await b.send('Emulation.setEmulatedMedia', { features: [] });
    const moving = await b.evalIn(`({spin:${spinning},fade:getComputedStyle(document.getElementById('foot')).transitionDuration})`);
    await b.evalIn(showRow);
    const fades = await verdictFades();
    check('new words in the band fade in, the spinner turns, and the band opens over 150 ms', fades === 1 && (await b.evalIn(text('foot-verdict'))) === 'Undone' && moving.spin === 'turn' && /^0\.15s/.test(moving.fade), { fades, moving });
    await b.evalIn(`SelectApp.state.outcome=null;SelectApp.applyView()`);
    await pickSort(b, 'createdAt');
    const box = await b.evalIn(`(function(){var r=document.getElementById('do-bins').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(140);
    const pressed = await b.evalIn(`(function(){var c=getComputedStyle(document.getElementById('do-bins'));return {transform:c.transform,filter:c.filter,bg:c.backgroundColor};})()`);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 300, y: box.y - 300, button: 'left', clickCount: 1 });
    check('a pressed pill darkens in place, and nothing scales', pressed.transform === 'none' && /brightness\(0\.92\)/.test(pressed.filter), pressed);
    const pill = await b.evalIn(`(function(){var c=getComputedStyle(document.getElementById('do-bins')),q=getComputedStyle(document.getElementById('do-sequence'));return {radius:c.borderRadius,h:document.getElementById('do-bins').offsetHeight,weight:c.fontWeight,size:c.fontSize,line:q.borderTopWidth+' '+q.borderTopStyle,qbg:q.backgroundColor};})()`);
    check('the buttons are pills: 24 px tall, fully rounded, 12 px bold, the secondary one an outline on no fill', pill.radius === '12px' && pill.h === 24 && pill.weight === '700' && pill.size === '12px' && pill.line === '1px solid' && pill.qbg === 'rgba(0, 0, 0, 0)', pill);

    // -------- colour discipline, on the finished panel and on the sheets
    // The pointer off the pill and its .12 s colour transition over, so the reading is the resting colour, not a blend.
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 300 });
    await sleep(250);
    const cobalts = await b.evalIn(`(function(){var c=[getComputedStyle(document.documentElement).getPropertyValue('--cobalt')],hits=[];document.querySelectorAll('body *').forEach(function(e){if(e.closest('[hidden]')){return;}var s=getComputedStyle(e);if(s.backgroundColor==='rgb(47, 111, 230)'||s.color==='rgb(47, 111, 230)'){hits.push(e.id||e.className);}});return hits;})()`);
    check('cobalt is on the primary action only', cobalts.join() === 'do-bins', cobalts);

    // -------- search, the three stages, the grid, colour, groups and failures of Tier 2
    await b.evalIn(`__mock.skin={red:35,green:35,blue:35};__mock.listeners['com.adobe.csxs.events.ThemeColorChanged'].forEach(function(f){f();});SelectApp.setMode('list')`);
    await resetView(b);
    await setItems(b, 400);

    // stage three, live: rows usable, writes usable, the foot calm
    b.engineEnv.FAKE_DELAY_MS = '3';
    await pressScan(b);
    // before any clip is looked at closely, what needs that waits with an ellipsis, and what doesn't keeps its count
    await b.waitFor(`SelectApp.state.scan.handle&&SelectApp.state.store.tier0>20&&SelectApp.state.store.tier2===0`, 'scan before stage three', 30000);
    const hintOf = (items, id) => (items.find(x => x[0] === id) || [])[2];
    await b.click('#show');
    const earlyShow = await b.evalIn(`({items:${pickerItems},tier2:SelectApp.state.store.tier2})`);
    await b.click('#sort');
    const earlySort = await b.evalIn(`({items:${pickerItems},tier2:SelectApp.state.store.tier2})`);
    await press(b, 'Escape');
    check('while the scan may still send it, the menus wait with an ellipsis: people, sound, text, similar shots, shake, colour', earlyShow.tier2 === 0 && earlySort.tier2 === 0 && ['interviews', 'people', 'nopeople', 'mediums', 'wides', 'speech', 'music', 'onscreen', 'similar'].every(id => hintOf(earlyShow.items, id) === '…') && hintOf(earlyShow.items, 'everything') === '400' && /^\d+$/.test(hintOf(earlyShow.items, 'silent')) && hintOf(earlySort.items, 'shake') === '…' && hintOf(earlySort.items, 'colorName') === '…' && hintOf(earlySort.items, 'sharpness') === 'sharpest first', { show: earlyShow.items.map(x => x[0] + ' ' + x[2]), sort: earlySort.items.map(x => x[0] + ' ' + x[2]) });
    await b.waitFor(`SelectApp.state.scan.handle&&document.getElementById('foot').className==='understanding'`, 'stage three', 30000);
    const stage = await footNow();
    await b.waitFor(`SelectApp.state.store.tier2>5`, 'some clips understood', 30000);
    await b.click('#show');
    const midShow = await b.evalIn(`({items:${pickerItems},running:!!SelectApp.state.scan.handle})`);
    await press(b, 'Escape');
    const legible = await b.evalIn(`(function(){var el=document.getElementById('foot-verdict');return {anims:el.getAnimations().length,opacity:getComputedStyle(el).opacity,w:el.getBoundingClientRect().width,text:el.textContent};})()`);
    check('the stage-three count changes in place, legible, with no fade restarting', legible.anims === 0 && legible.opacity === '1' && legible.w > 100 && /^Looking closer \d+ of 392$/.test(legible.text), legible);
    check('stage three: the band says it is looking closer, with a count of its own and Stop, and the bar\'s writes work (as listed: Make Sequence, and Sort into Bins off, so no blue)', /^Looking closer \d+ of 392$/.test(stage.verdict) && stage.sentence === '' && stage.mark === 'spinner' && stage.actions.join() === 'stop' && stage.bar.join() === 'do-sequence', stage);
    check('the Show menu counts what has landed so far, marks a count still climbing, and similar shots wait for the end', midShow.running && midShow.items.length === 11 && /^\d+…$/.test(hintOf(midShow.items, 'people')) && /^\d+$/.test(hintOf(midShow.items, 'silent')) && hintOf(midShow.items, 'similar') === '…', midShow.items.map(x => x[0] + ' ' + x[2]));
    await pickSort(b, 'colorName');
    await sleep(120);
    const holding = await b.evalIn(`({bins:document.getElementById('do-bins').disabled,label:(SelectApp.foot().held||[]).indexOf('label')>=0,shown:!document.getElementById('do-bins').hidden,why:document.getElementById('count').title.split('\\n').slice(1).join(' '),title:document.getElementById('do-bins').title,running:!!SelectApp.state.scan.handle})`);
    check('in stage three, a Colour write waits: visible, off, with a plain reason on the button; the right-click Label waits too', holding.running && holding.shown && holding.bins && holding.label && holding.title === 'Waits for looking closer' && holding.why === '', holding);
    await b.shot('35-stage-three-waiting');
    // Forced: the button turned on and pressed in one task. The foot redraws every 66 ms while lines arrive and turns it
    // off again, so turning it on in one call and clicking in later ones raced that redraw: a click on a button that was
    // off again did nothing, and the check failed about one run in three. The engine is paused meanwhile, so the write
    // is still held when it's pressed, however long the steps above took.
    b.signalEngines('SIGSTOP');
    let forced;
    try {
      await b.evalIn(`__mock.calls.length=0`);
      forced = await b.evalIn(`(function(){var held=SelectApp.foot().held||[],e=document.getElementById('do-bins');e.disabled=false;e.click();return {held:held.indexOf('bins')>=0,running:!!SelectApp.state.scan.handle};})()`);
      await sleep(80);
    } finally {
      b.signalEngines('SIGCONT');
    }
    const forcedAfter = { modal: await modalOpen(), calls: (await b.evalIn(`__mock.calls.map(function(c){return c.fn;})`)).filter(own), note: await noteText() };
    check('even forced, a held write refuses before any sheet or host call', forced.held && forced.running && !forcedAfter.modal && forcedAfter.calls.length === 0 && forcedAfter.note === 'Waits for looking closer', { forced, forcedAfter });
    await b.waitFor(`!document.getElementById('do-bins').disabled`, 'writes turn on by themselves', 30000);
    const turned = await b.evalIn(`({clicked:__mock.calls.length,landed:SelectCore.understandingShare(SelectApp.state.store).landed||!SelectApp.state.scan.handle})`);
    check('and turns on by itself once every clip has landed', turned.landed, turned);
    await b.waitFor(`SelectApp.state.scan.state==='Done'`, 'done', 30000);
    await b.click('#show');
    const lateShow = await b.evalIn(`({items:${pickerItems},want:SelectCore.SHOWS.map(function(s){return [s.id,SelectCore.fmtInt(SelectCore.showCount(SelectApp.state.store.rows,s.id))];})})`);
    await b.click('#sort');
    const lateSort = await b.evalIn(pickerItems);
    await press(b, 'Escape');
    check('once the scan is done the ellipses turn into counts, each from core.showCount, and shake reads how it sorts', lateShow.want.every(([id, n]) => hintOf(lateShow.items, id) === n) && /^[1-9]/.test(hintOf(lateShow.items, 'similar')) && hintOf(lateSort, 'shake') === 'steadiest first' && hintOf(lateSort, 'colorName') === 'rainbow order', { show: lateShow.items.map(x => x[0] + ' ' + x[2]), shake: hintOf(lateSort, 'shake') });
    await resetView(b);

    // a Tier 1 write in stage three works. Pictures fade in as they arrive.
    b.engineEnv.FAKE_DELAY_MS = '8';
    await pressScan(b);
    await b.waitFor(`SelectApp.state.scan.handle&&document.querySelectorAll('#body img.arrive').length>0`, 'pictures arriving', 30000).catch(() => {});
    const arriving = await b.evalIn(`(function(){var a=document.querySelectorAll('#body img.arrive');return {n:a.length,anim:a.length?getComputedStyle(a[0]).animationName:'',running:!!SelectApp.state.scan.handle};})()`);
    await b.waitFor(`SelectApp.state.scan.handle&&document.getElementById('foot').className==='understanding'`, 'stage three again', 30000);
    await b.evalIn(`document.getElementById('grid').scrollTop=1e9`);
    await sleep(120);
    await b.evalIn(`document.getElementById('grid').scrollTop=0`);
    await sleep(120);
    const scrolledBack = await b.evalIn(`(function(){var r=Array.from(document.querySelectorAll('#body .r')).filter(function(x){return x.style.display!=='none';});return {again:r.filter(function(x){return x.querySelector('img.arrive');}).length,pictures:r.filter(function(x){return x.querySelector('img[src]');}).length,running:!!SelectApp.state.scan.handle};})()`);
    check('a picture fades in once as it arrives during a scan, and not again when scrolled back into view', arriving.n > 0 && arriving.anim === 'arrive' && arriving.running && scrolledBack.running && scrolledBack.pictures > 5 && scrolledBack.again === 0, { arriving, scrolledBack });
    await pickSort(b, 'createdAt');
    await sleep(80);
    check('a Tier 1 sort writes during stage three', !(await b.evalIn(`document.getElementById('do-bins').disabled||(SelectApp.foot().held||[]).length>0`)));
    await b.evalIn(`__mock.calls.length=0;SelectApp.state.selected.clear();SelectApp.applyView()`);
    await b.click('#body .r[data-at="0"]');
    await labelFromMenu(b);
    await b.waitFor(`__mock.calls.some(function(c){return c.fn==='label';})`);
    await b.waitFor(`SelectApp.state.outcome&&!SelectApp.state.busy`, 'labels landed in stage three');
    const midWrite = await b.evalIn(`({running:!!SelectApp.state.scan.handle,foot:${foot}})`);
    check('a write made during stage three is its own row: Undo beside it, not the scan\'s Stop', midWrite.running && midWrite.foot.actions.indexOf('stop') < 0 && midWrite.foot.actions.indexOf('undo-write') >= 0 && /^Labelled/.test(midWrite.foot.verdict), midWrite);
    await b.click('#more');
    const stopItem = await b.evalIn(`(function(){var i=document.querySelector('#menu [data-menu="stop-scan"]');return {menu:!document.getElementById('menu').hidden,shown:!i.hidden,on:!i.disabled,first:Array.from(document.querySelectorAll('#menu button')).filter(function(x){return !x.hidden;})[0]===i};})()`);
    await press(b, 'Escape');
    check('meanwhile \u00b7\u00b7\u00b7 offers Stop Scan, first', stopItem.menu && stopItem.shown && stopItem.on && stopItem.first, stopItem);
    await b.evalIn(`SelectApp.state.outcome=null;SelectApp.applyView()`);
    const scanBack = await b.evalIn(`({running:!!SelectApp.state.scan.handle,foot:${foot}})`);
    check('once the result closes the scan\'s row is back with its Stop', !scanBack.running || scanBack.foot.actions[0] === 'stop', scanBack);
    b.engineEnv.FAKE_DELAY_MS = '3';
    await b.waitFor(`SelectApp.state.scan.state==='Done'`, 'done', 30000);
    await b.evalIn(`SelectApp.state.outcome=null;SelectApp.state.selected.clear();SelectApp.applyView()`);
    await resetView(b);

    // search, real keystrokes: the glass opens into a field on a click
    const shut = await b.evalIn(`!document.getElementById('search-box').classList.contains('open')`);
    await b.click('#search-box');
    await b.send('Input.insertText', { text: 'bread' });
    await b.waitFor(`SelectApp.state.query==='bread'`);
    const found = await b.evalIn(`({shown:SelectApp.state.order.length,count:document.getElementById('search-count').textContent,why:document.querySelector('#body .r .why').textContent,open:document.getElementById('search-box').classList.contains('open'),focus:document.activeElement.id})`);
    check('search opens on a click, narrows, says how many, and shows why a clip is there', shut && found.open && found.focus === 'search' && found.shown > 0 && found.shown < 400 && found.count === `${found.shown} of 400` && found.why === 'bread', { shut, found });
    await b.send('Input.insertText', { text: ' sony' });
    await b.waitFor(`SelectApp.state.query==='bread sony'`);
    check('a second word narrows further', (await b.evalIn(`SelectApp.state.order.length`)) < found.shown, await b.evalIn(`document.getElementById('search-count').textContent`));
    await b.send('Input.insertText', { text: ' zzz' });
    await b.waitFor(`/Nothing matches/.test(document.getElementById('empty-words').textContent)`);
    check('an empty search says so in plain words, with a way back', (await b.evalIn(text('empty-words'))) === 'Nothing matches “bread sony zzz”.' && !(await b.evalIn(`document.getElementById('empty-clear').hidden`)));
    await b.shot('30-search-empty');
    await b.click('#empty-clear');
    check('Clear search puts every clip back', (await b.evalIn(`SelectApp.state.order.length`)) === 400 && (await b.evalIn(`document.getElementById('search').value`)) === '');
    const closed = await b.waitFor(`!document.getElementById('search-box').classList.contains('open')&&!document.getElementById('toolbar').classList.contains('searching')`, 'search closes', 2000).then(() => true, () => false);
    check('an empty search left behind closes back to the glass', closed);
    await b.click('#search-box');
    const opened = await b.evalIn(`document.getElementById('toolbar').classList.contains('searching')`);
    await b.click('#sort');
    const firstClick = await b.evalIn(`({picker:!document.getElementById('picker').hidden,expanded:document.getElementById('sort').getAttribute('aria-expanded'),first:(document.querySelector('#picker button')||{dataset:{}}).dataset.id})`);
    firstClick.searching = !(await b.waitFor(`!document.getElementById('toolbar').classList.contains('searching')`, 'search closes', 1000).then(() => true, () => false));
    await press(b, 'Escape');
    check('with the search open and empty, the first click on Sort still opens its menu, and the search closes', opened && firstClick.picker && firstClick.expanded === 'true' && firstClick.first === 'listed' && !firstClick.searching, { opened, firstClick });

    // the grid
    await pickSort(b, 'sharpness');
    await b.click('#flip');
    await b.click('#mode-grid');
    await sleep(200);
    const tiles = await b.evalIn(`({shown:document.querySelectorAll('#tiles .t').length,head:document.getElementById('head').hidden,list:document.getElementById('body').hidden,on:document.getElementById('mode-grid').classList.contains('on'),rows:SelectApp.state.L.cols,name:document.querySelector('#tiles .t[data-at="0"] .n').textContent,fact:document.querySelector('#tiles .t[data-at="0"] .f').textContent,w:document.querySelector('#tiles .t').getBoundingClientRect().width,order:SelectApp.state.store.rows[SelectApp.state.order[0]]})`);
    check('the grid shows the same clips in the same order, with a name and one fact', tiles.head && tiles.list && tiles.on && tiles.rows >= 5 && tiles.name === tiles.order.name && tiles.fact === tiles.order.sharpness.toFixed(3) && tiles.w > 120, { cols: tiles.rows, shown: tiles.shown, fact: tiles.fact, w: tiles.w });
    await b.waitFor(`Array.from(document.querySelectorAll('#tiles img[src]')).some(function(i){return i.complete&&i.naturalWidth>0;})`, 'tile pictures');
    await b.shot('31-grid');
    await b.evalIn(`SelectApp.state.selected.clear();SelectApp.state.anchor=null;SelectApp.applyView()`);
    const tile = n => `#tiles .t[data-at="${n}"]`;
    await b.click(tile(1));
    await b.click(tile(3), { shift: true });
    await b.click(tile(7), { meta: true });
    await sleep(200);    // the plate fades in
    const sel = await b.evalIn(`(function(){var t=document.querySelector('#tiles .t.sel'),p=getComputedStyle(t,'::before');return {n:SelectApp.state.selected.size,cls:document.querySelectorAll('#tiles .t.sel').length,plate:p.backgroundColor,radius:p.borderRadius,ring:getComputedStyle(t.querySelector('.pic')).boxShadow,foot:${clipsCount}};})()`);
    check('click, shift-click and cmd-click select tiles, on a soft plate, no ring, never cobalt, and the bar counts them', sel.n === 4 && sel.cls === 4 && sel.plate === 'rgba(255, 255, 255, 0.11)' && sel.radius === '8px' && !/47, 111, 230/.test(sel.ring + sel.plate) && !/ 1\.5px| 3px/.test(sel.ring) && sel.foot === '4 of 400 clips selected', sel);
    await b.click('#mode-list');
    check('a selection made in the grid is the selection in the list', (await b.evalIn(`document.querySelectorAll('#body .r.sel').length`)) === 4);
    await b.click('#mode-grid');
    await b.evalIn(`__mock.calls.length=0`);
    await labelFromMenu(b);
    await b.waitFor(`/Labelled 4 clips/.test(${text('foot-verdict')})`);
    const fromGrid = (await calls('label'))[0].args;
    check('a write from the grid covers exactly the selected tiles', fromGrid.items.length === 4, fromGrid.items);
    await b.evalIn(`SelectApp.state.selected.clear();SelectApp.state.outcome=null;SelectApp.applyView();__mock.calls.length=0`);
    await b.click(tile(2), { count: 2 });
    await b.waitFor(`__mock.calls.some(function(c){return c.fn==='open';})`);
    check('double-clicking a tile opens the clip', /^id\d+$/.test((await calls('open'))[0].args.id));
    await b.evalIn(`SelectApp.state.selected.clear();SelectApp.applyView()`);

    // colour in the grid
    await pickSort(b, 'colorName');
    const rainbow = await b.evalIn(`(function(){var r=${ids},keys=r.map(function(x){return x.rainbow;}).filter(function(k){return typeof k==='number';}),up=keys.every(function(k,i){return !i||keys[i-1]<=k;}),first=r[0].colorName,lastHue=keys.filter(function(k){return k<800;}).length,neutral=r.filter(function(x){return x.colorName==='neutral';}).length;return {up:up,first:first,hued:lastHue,neutral:neutral,chips:!document.querySelector('#tiles .t[data-at="0"] .p').hidden,fact:document.querySelector('#tiles .t[data-at="0"] .f').hidden};})()`);
    check('Colour sorts by hue from red, neutrals after, blanks last, and tiles show their palette', rainbow.up && rainbow.first === 'red' && rainbow.hued > 200 && rainbow.neutral > 10 && rainbow.chips && rainbow.fact, rainbow);
    await b.click('#families [data-family="teal"]');
    const teal = await b.evalIn(`({n:SelectApp.state.order.length,all:${ids}.every(function(r){return r.colorName==='teal';}),verdict:SelectCore.viewName(SelectApp.state.view),count:${clipsCount},dot:document.querySelector('#families [data-family="teal"]').classList.contains('on')})`);
    check('a colour family filters, in the grid, with its dot on, named Teal and counted in the bar', teal.n > 5 && teal.all && teal.verdict === 'Teal' && teal.count === `${teal.n} of 400 clips` && teal.dot, teal);
    await b.evalIn(`__mock.calls.length=0`);
    await b.click('#do-bins');
    await waitModal();
    const tealSheet = await dialogText(), tealName = await b.evalIn(`document.getElementById('sheet-name').value`);
    await b.click('#dialog-ok');
    await b.waitFor(`/^Moved \\d+ clips into a bin$/.test(${text('foot-verdict')})`);
    await sleep(320);
    const tealBins = (await calls('bins'))[0].args;
    check('Sort into Bins on a colour: one bin, named in the field, reads back, and goes green', new RegExp('^Move ' + teal.n + ' clips into a bin\\?').test(tealSheet) && /^SELECT \d{4}-\d\d-\d\d Teal$/.test(tealName) && tealBins.single === true && tealBins.root === tealName && tealBins.buckets.length === 1 && tealBins.buckets[0].name === tealName && tealBins.buckets[0].items.length === teal.n && (await footNow()).green, { tealSheet, tealName, buckets: tealBins.buckets.map(x => x.name) });
    await b.click('#undo-write');
    await waitModal();
    await b.click('#dialog-ok');
    await b.waitFor(`SelectApp.state.outcome&&/Undone/.test(SelectApp.state.outcome.verdict)`);
    await b.click('#families [data-family="teal"]');
    await b.evalIn(`__mock.calls.length=0;__mock.misplaced=1`);
    await b.click('#do-bins');
    await waitModal();
    const rainbowSheet = await dialogText();
    await b.click('#dialog-ok');
    await b.waitFor(`/of 400 clips/.test(${text('foot-verdict')})`);
    await sleep(320);
    check('every family has its bin, in rainbow order, and a stray is not green', /01 Red[\s\S]*02 Orange[\s\S]*09 Neutral[\s\S]*10 No value/.test(rainbowSheet) && !(await footNow()).green, (await footNow()).verdict);
    await b.evalIn(`__mock.misplaced=0;SelectApp.state.outcome=null;SelectApp.applyView()`);

    // -------- colours combined: Shift-click adds a colour or takes it off, Cmd-click too, a plain click starts again
    await pickSort(b, null);
    const dotsNow = `(function(){var S=SelectApp.state;return {on:Array.from(document.querySelectorAll('#families button.on')).map(function(x){return x.dataset.family;}).join(),families:S.view.families.join(),n:S.order.length,
      colours:S.order.map(function(i){return S.store.rows[i].colorName;}),verdict:SelectCore.viewName(S.view),sentence:${clipsCount},sort:S.view.sort.map(function(s){return s.key;}).join(),
      counts:SelectCore.familyCounts(S.store.rows),tip:document.querySelector('#families [data-family="blue"]').title};})()`;
    const inColourOrder = (list, order) => { let at = 0; return list.every(c => { const k = order.indexOf(c); if (k < at) { return false; } at = k; return true; }); };
    const brief = d => ({ on: d.on, families: d.families, n: d.n, verdict: d.verdict, sentence: d.sentence, sort: d.sort });
    await b.click('#families [data-family="yellow"]');
    const yellowOnly = await b.evalIn(dotsNow);
    await b.click('#families [data-family="blue"]', { shift: true });
    const both = await b.evalIn(dotsNow);
    await b.shot('36-yellow-and-blue-grid');
    check('Shift-click adds a colour: Yellow and Blue, both dots on, the clips of either, every yellow then every blue with the rainbow the first dot brought, as many as the two dots count; a dot\'s tooltip is its count alone', yellowOnly.families === 'yellow' && yellowOnly.sort === 'colorName' && yellowOnly.n === both.counts.yellow && both.on === 'yellow,blue' && both.families === 'yellow,blue' && both.verdict === 'Yellow and Blue' && inColourOrder(both.colours, ['yellow', 'blue']) && both.colours[0] === 'yellow' && both.colours[both.n - 1] === 'blue' && both.n === both.counts.yellow + both.counts.blue && both.sentence.indexOf(`${both.n} of 400 clips`) === 0 && /^Blue: [\d,]+ clips?$/.test(both.tip), { yellowOnly: brief(yellowOnly), both: brief(both), tip: both.tip });
    await b.click('#mode-list');
    await sleep(150);
    const inList = await b.evalIn(`({on:Array.from(document.querySelectorAll('#families button.on')).map(function(x){return x.dataset.family;}).join(),rows:Array.from(document.querySelectorAll('#body .r')).filter(function(r){return r.style.display!=='none';}).length,n:SelectApp.state.order.length})`);
    await b.shot('37-yellow-and-blue-list');
    await b.click('#mode-grid');
    await b.click('#do-bins');
    await waitModal();
    const twoBins = { text: await dialogText(), name: await b.evalIn(`document.getElementById('sheet-name').value`) };
    await b.click('#dialog-cancel');
    check('two colours on make a bin for each, in the dots\' order, under one named Yellow and Blue; the list shows the same clips with both dots on', new RegExp('^Sort ' + both.n + ' clips into bins\\?').test(twoBins.text) && new RegExp('01 Yellow\\s+' + both.counts.yellow + '\\s+02 Blue\\s+' + both.counts.blue + '(\\s|$)').test(twoBins.text) && !/03 /.test(twoBins.text) && /^SELECT \d{4}-\d\d-\d\d Yellow and Blue$/.test(twoBins.name) && inList.on === 'yellow,blue' && inList.rows > 3 && inList.n === both.n, { twoBins, inList });
    await b.click('#families [data-family="blue"]', { shift: true });
    const blueOff = await b.evalIn(dotsNow);
    await b.click('#families [data-family="blue"]', { meta: true });
    await b.click('#families [data-family="red"]', { meta: true });
    const three = await b.evalIn(dotsNow);
    await b.click('#families [data-family="teal"]');
    const plain = await b.evalIn(dotsNow);
    await b.click('#families [data-family="teal"]');
    const noColour = await b.evalIn(dotsNow);
    await b.click('#families [data-family="green"]', { shift: true });
    const shiftFirst = await b.evalIn(dotsNow);
    await b.click('#families [data-family="green"]', { shift: true });
    const lastOff = await b.evalIn(dotsNow);
    check('Shift-click on a colour that is on takes it off', blueOff.families === 'yellow' && blueOff.on === 'yellow' && blueOff.verdict === 'Yellow' && blueOff.n === both.counts.yellow, brief(blueOff));
    check('Cmd-click adds as Shift-click does: Red, Yellow and Blue, each together in the dots\' order', three.families === 'red,yellow,blue' && three.on === 'red,yellow,blue' && three.verdict === 'Red, Yellow and Blue' && inColourOrder(three.colours, ['red', 'yellow', 'blue']) && three.n === three.counts.red + three.counts.yellow + three.counts.blue, brief(three));
    check('a plain click starts again with that colour alone, and on the only colour on turns it off; Shift-click adds to none, and off the last one leaves no colour on', plain.families === 'teal' && plain.on === 'teal' && plain.colours.every(c => c === 'teal') && noColour.families === '' && noColour.on === '' && noColour.n === 400 && shiftFirst.families === 'green' && lastOff.families === '' && lastOff.on === '' && lastOff.n === 400, { plain: brief(plain), noColour: brief(noColour), shiftFirst: brief(shiftFirst), lastOff: brief(lastOff) });
    // a suggestion's count is what picking it shows, inside the colours on
    await b.click('#families [data-family="yellow"]');
    await b.click('#families [data-family="blue"]', { shift: true });
    const letter = await b.evalIn(`'abcdefghijklmnopqrstuvwxyz'.split('').filter(function(l){return SelectCore.suggestions(SelectApp.state.store.rows,l,6,SelectApp.state.view).length;})[0]`);
    await b.click('#search-box');
    await b.send('Input.insertText', { text: letter });
    await b.waitFor(`!document.getElementById('suggest').hidden`, 'suggestions in two colours', 3000);
    const offered = await b.evalIn(`[document.querySelector('#suggest button .w').textContent,Number(document.querySelector('#suggest button .n').textContent.replace(/,/g,''))]`);
    await press(b, 'ArrowDown');
    await press(b, 'Enter');
    await b.waitFor(`SelectApp.state.query.trim().length>1`, 'a suggestion taken', 2000);
    const took = await b.evalIn(`({n:SelectApp.state.order.length,families:SelectApp.state.view.families.join(),query:SelectApp.state.query})`);
    check('inside Yellow and Blue, a suggestion\'s count is what taking it shows', took.families === 'yellow,blue' && took.n === offered[1] && took.n > 0, { letter, offered, took });
    await b.evalIn(`document.getElementById('search').value='';document.getElementById('search').dispatchEvent(new Event('input'));document.getElementById('search').blur()`);
    await sleep(200);
    await resetView(b);
    await pickSort(b, 'colorName');

    // the bins follow the view: a bin per day, a bin per value of a word column, one bin for a show, none for a name sort or nothing
    const binsSheet = async () => {
      await b.click('#do-bins');
      await waitModal();
      const got = await b.evalIn(`({root:document.getElementById('sheet-name').value,title:document.getElementById('dialog-title').textContent,more:(document.querySelector('#dialog-body p.quiet')||{}).textContent||'',bins:Array.from(document.querySelectorAll('#dialog-body li')).map(function(li){return [li.children[0].textContent,Number(li.children[1].textContent.replace(/,/g,''))];})})`);
      await b.click('#dialog-cancel');
      await b.waitFor(`document.getElementById('modal').hidden`);
      return got;
    };
    const today = await b.evalIn(`SelectCore.localDate(new Date())`);
    const valuesInOrder = of => b.evalIn(`(function(){var seen=[],n={};${ids}.forEach(function(r){var v=(${of})(r)||'No value';if(!(v in n)){seen.push(v);n[v]=0;}n[v]++;});var named=seen.filter(function(v){return v!=='No value';});if(n['No value']){named.push('No value');}return named.map(function(v,i){return [(i<9?'0':'')+(i+1)+' '+v,n[v]];});})()`);
    // The sheet lists at most 10 bins, then how many more.
    const listedAs = (got, want) => JSON.stringify(got.bins) === JSON.stringify(want.slice(0, 10)) && got.more === (want.length > 10 ? `and ${want.length - 10} more` : '');
    await pickSort(b, 'createdAt');
    const days = await binsSheet(), wantDays = await valuesInOrder(`function(r){return r.time===r.time?SelectCore.localDate(new Date(r.time)):null;}`);
    const dayNames = wantDays.map(x => x[0].slice(3)).filter(x => x !== 'No value');
    check('Sort into Bins on Shoot order: a bin per day, earliest first', days.root === `SELECT ${today} Earliest first` && listedAs(days, wantDays) && dayNames.length > 3 && dayNames.every(d => /^\d{4}-\d\d-\d\d$/.test(d)) && dayNames.join() === dayNames.slice().sort().join() && wantDays.reduce((n, x) => n + x[1], 0) === 400, { days, wantDays });
    await b.click('#mode-list');
    await b.click(`#head .h[data-key="camera"]`);
    const cams = await binsSheet(), wantCams = await valuesInOrder(`function(r){return r.camera;}`);
    check('Sort into Bins on a word column: a bin per value', cams.root === `SELECT ${today} Camera A to Z` && listedAs(cams, wantCams) && wantCams.length > 2 && wantCams.reduce((n, x) => n + x[1], 0) === 400, { cams, wantCams });
    await pickSort(b, null);
    await pickShow(b, 'interviews');
    const oneShow = await binsSheet(), ivCount = await b.evalIn(`SelectCore.showCount(SelectApp.state.store.rows,'interviews')`);
    await pickSort(b, 'sharpness');
    const oneShowSorted = await binsSheet();
    check('Sort into Bins on a show: one bin named after it, sorted or not, with no list', oneShow.root === `SELECT ${today} Interviews` && oneShow.title === `Move ${ivCount} clips into a bin?` && !oneShow.bins.length && ivCount > 0 && oneShowSorted.root === `SELECT ${today} Interviews, sharpest first` && oneShowSorted.title === oneShow.title, { oneShow, oneShowSorted });
    await resetView(b);
    const binsOff = async () => b.evalIn(`({shown:!document.getElementById('do-bins').hidden,off:document.getElementById('do-bins').disabled,title:document.getElementById('do-bins').title})`);
    const offNothing = await binsOff();
    await pickSort(b, 'name');
    const offName = await binsOff();
    check('with nothing chosen, or only a name sort, Sort into Bins is off and its tooltip says what it needs', [offNothing, offName].every(x => x.shown && x.off && x.title === 'Pick a Show, a colour or a sort') && (await b.evalIn(`SelectCore.viewName(SelectApp.state.view)`)) === 'A to Z', { offNothing, offName });
    await pickSort(b, 'colorName');
    await b.click('#mode-grid');

    // groups, in both views, arriving last
    b.engineEnv.FAKE_DELAY_MS = '4';
    await pickShow(b, 'similar');
    await pressScan(b);
    await b.waitFor(`SelectApp.state.scan.handle&&SelectApp.state.store.tier1>50`, 'scan under way', 30000);
    const waiting = await b.evalIn(`({text:document.getElementById('empty-words').textContent,hidden:document.getElementById('empty').hidden})`);
    check('Similar shots waits in plain words until the line arrives', !waiting.hidden && waiting.text === 'Similar shots come once every clip is looked at.', waiting);
    await b.waitFor(`SelectApp.state.scan.state==='Done'&&SelectApp.state.order.length>0`, 'groups', 30000);
    await sleep(120);
    const grouped = await b.evalIn(`({heads:Array.from(document.querySelectorAll('#tiles .gh')).filter(function(h){return !h.hidden;}).map(function(h){return h.textContent;}),count:SelectApp.state.groupCount,top:document.querySelector('#tiles .gh').style.top,foot:${clipsCount}})`);
    // Two small groups side by side on one shelf (which two depends on how many columns the width gives).
    const shelves = await b.evalIn(`(function(){var h=SelectApp.state.L.heads;for(var i=1;i<h.length;i++){if(h[i].y===h[i-1].y&&h[i].x>0){return {same:true,x:true};}}return {same:false,x:false};})()`);
    check('groups land last and show as groups in the grid, packed along shelves', grouped.count > 5 && grouped.heads[0] === 'Group 1 · 3 clips' && new RegExp(' \u00b7 ' + grouped.count + ' groups$').test(grouped.foot) && shelves.same && shelves.x, grouped);
    await b.shot('32-grid-groups');
    await b.click('#mode-list');
    await sleep(100);
    const listed = await b.evalIn(`Array.from(document.querySelectorAll('#body .gh')).filter(function(h){return !h.hidden;}).map(function(h){return h.textContent;})`);
    check('and as groups in the list, with no sideways scroll', listed[0] === 'Group 1 · 3 clips' && listed.length > 1 && (await b.evalIn(`document.getElementById('grid').scrollWidth<=document.getElementById('grid').clientWidth`)), listed.slice(0, 3));
    await b.shot('33-list-groups');
    const groupBins = await binsSheet(), groupSizes = await b.evalIn(`(function(){var n={};${ids}.forEach(function(r){n[r.dupGroup]=(n[r.dupGroup]||0)+1;});return Object.keys(n).sort(function(x,y){return x-y;}).map(function(g){return n[g];});})()`);
    check('Sort into Bins on similar shots: a bin per group, named by its size', groupBins.root === `SELECT ${today} Similar shots, rainbow order` && listedAs(groupBins, groupSizes.map((n, i) => [`${String(i + 1).padStart(2, '0')} Similar, ${n} clips`, n])), { groupBins, groupSizes });
    await pickShow(b, null);

    // what Tier 2 can do wrong
    b.engineEnv.FAKE_DELAY_MS = '0';
    b.engineEnv.FAKE_TIER2 = 'fail';
    await scanAndWait(b);
    const t2Fail = await b.evalIn(`({failed:SelectApp.state.store.tier2Failed,errors:SelectApp.state.store.errors,foot:document.getElementById('count').title,kept:SelectApp.state.store.rows.filter(function(r){return r.notUnderstood&&r.tier===1&&typeof r.luma==='number';}).length})`);
    check('a Tier 2 failure leaves the clip whole, and says so once', t2Fail.failed > 5 && t2Fail.errors === 8 && t2Fail.kept > 0 && /couldn't be looked at closely\./.test(t2Fail.foot) && (t2Fail.foot.match(/looked at closely/g) || []).length === 1, t2Fail);
    const slowRow = await b.evalIn(`(function(){var o=SelectApp.state.order,rows=SelectApp.state.store.rows;for(var i=0;i<o.length;i++){if(rows[o[i]].lookReason&&!rows[o[i]].reason){document.getElementById('grid').scrollTop=i*40;return rows[o[i]].name;}}return null;})()`);
    await sleep(140);
    const slowWhy = await b.evalIn(`(function(){var r=Array.from(document.querySelectorAll('#body .r')).filter(function(x){return x.querySelector('.n').textContent===${JSON.stringify(slowRow)};})[0];return r?{why:r.querySelector('.why').textContent,color:getComputedStyle(r.querySelector('.why')).color}:null;})()`);
    check('a Tier 2 timeout shows its reason quietly under the name, like Tier 1', slowRow && slowWhy && slowWhy.why === 'Looking closer at this clip took too long, so it was left out.' && slowWhy.color === 'rgb(173, 173, 177)', slowWhy);
    await b.evalIn(`document.getElementById('grid').scrollTop=0`);
    b.engineEnv.FAKE_TIER2 = 'crash';
    await scanAndWait(b);
    const t2Crash = await b.evalIn(`({read:SelectApp.state.store.tier1,tier2:SelectApp.state.store.tier2,foot:document.getElementById('foot-sentence').textContent,bins:!document.getElementById('do-bins').hidden})`);
    check('the engine dying in Tier 2 keeps every row, and the writes', t2Crash.read === 392 && t2Crash.tier2 > 0 && /What was read stays/.test(t2Crash.foot) && t2Crash.bins, t2Crash);
    b.engineEnv.FAKE_TIER2 = 'off';
    await scanAndWait(b);
    await pickShow(b, 'mediums');
    const noData = await b.evalIn(`({text:document.getElementById('empty-words').textContent,foot:${clipsCount}})`);
    check('a show on data no clip has says so plainly, not an empty table, and the bar counts none', noData.text === 'No shot size data in this scan.' && noData.foot === '0 of 400 clips', noData);
    await b.click('#show');
    const noShow = await b.evalIn(pickerItems);
    await b.click('#sort');
    const noSort = await b.evalIn(pickerItems);
    await press(b, 'Escape');
    check('the menus say when the data will not come: a dash for a show, no data for a sort', ['interviews', 'people', 'nopeople', 'mediums', 'wides', 'speech', 'music', 'onscreen', 'similar'].every(id => hintOf(noShow, id) === '\u2013') && /^\d+$/.test(hintOf(noShow, 'silent')) && hintOf(noSort, 'shake') === 'no data' && hintOf(noSort, 'colorName') === 'no data' && hintOf(noSort, 'sharpness') === 'sharpest first', { show: noShow.map(x => x[0] + ' ' + x[2]), sort: noSort.map(x => x[0] + ' ' + x[2]) });
    await pickShow(b, null);
    b.engineEnv.FAKE_TIER2 = '';

    // 1,000 clips: search, sort and scroll in the grid
    await setItems(b, 1000);
    await b.click('#mode-grid');
    await scanAndWait(b);
    await sleep(300);
    const search1000 = [];
    await b.click('#search-box');
    for (const ch of 'bread water') {
      await b.send('Input.insertText', { text: ch });
      await b.waitFor(`SelectApp.state.query.slice(-1)===${JSON.stringify(ch)}`);
      search1000.push(await b.evalIn('SelectApp.state.searchMs'));
    }
    await b.evalIn(`document.getElementById('search').value='';document.getElementById('search').dispatchEvent(new Event('input'))`);
    const worstSearch = Math.max(...search1000), meanSearch = search1000.reduce((x, y) => x + y, 0) / search1000.length;
    check('search at 1,000 clips, each keystroke with repaint, 16 ms or less', worstSearch <= 16, `worst ${worstSearch.toFixed(1)} ms, mean ${meanSearch.toFixed(1)} ms over ${search1000.length} keystrokes`);
    const gridSorts = [];
    const gridViews = [() => pickSort(b, 'colorName'), () => pickSort(b, 'sharpness'), () => b.click('#flip'), () => pickShow(b, 'people'), () => pickSort(b, 'createdAt'), () => pickShow(b, 'speech'),
      () => pickSort(b, 'shake'), () => b.click('#flip'), () => pickShow(b, null), () => pickSort(b, 'colorName')];
    for (const go of gridViews) {
      await b.evalIn(`SelectApp.state.sortMs=null`);
      await go();
      gridSorts.push(await b.evalIn('SelectApp.state.sortMs'));
    }
    const worstGrid = Math.max(...gridSorts);
    check('grid re-sort and repaint at 1,000 clips, 16 ms or less', worstGrid <= 16, `worst ${worstGrid.toFixed(1)} ms over ${gridSorts.length} sorts`);
    const gridScroll = await b.evalIn(`new Promise(function(resolve){
      var g=document.getElementById('grid'),max=g.scrollHeight-g.clientHeight,n=0,last=performance.now(),gaps=[],nodes=0;
      function step(now){gaps.push(now-last);last=now;g.scrollTop=(n%2?max*(n/240):max*(1-n/240));
        nodes=Math.max(nodes,document.querySelectorAll('#tiles .t').length);
        if(++n<240){requestAnimationFrame(step);}else{gaps.shift();gaps.sort(function(a,b){return a-b;});
          resolve({frames:n,max:gaps[gaps.length-1],p99:gaps[Math.floor(gaps.length*.99)],median:gaps[gaps.length>>1],nodes:nodes,height:g.scrollHeight});}}
      requestAnimationFrame(step);})`);
    check('the grid is virtualised at 1,000 clips', gridScroll.nodes < 80 && gridScroll.height > 15000, gridScroll);
    check('scrolling the grid end to end every frame stays near 60 fps (headless, software)', gridScroll.p99 <= 34, gridScroll);
    await b.evalIn(`document.getElementById('grid').scrollTop=9000`);
    await sleep(120);
    const tilesRight = await b.evalIn(`(function(){var bad=0,n=0;document.querySelectorAll('#tiles .t').forEach(function(t){if(t.style.display==='none'){return;}n++;var r=SelectApp.state.store.rows[SelectApp.state.order[Number(t.dataset.at)]];if(t.querySelector('.n').textContent!==r.name){bad++;}});return {bad:bad,n:n};})()`);
    check('after a long scroll every tile shows the right clip', tilesRight.bad === 0 && tilesRight.n > 20, tilesRight);
    await b.evalIn(`document.getElementById('grid').scrollTop=0`);

    // the grid at the smallest panel, and in Premiere's light theme
    await b.size(620, 420);
    await sleep(160);
    const narrowGrid = await b.evalIn(`(function(){var r=document.querySelector('#tiles .t').getBoundingClientRect(),g=document.getElementById('grid'),cols=SelectApp.state.L.cols,last=document.querySelector('#tiles .t[data-at="'+(cols-1)+'"]').getBoundingClientRect();return {cols:cols,w:Math.round(r.width),over:g.scrollWidth-g.clientWidth,right:last.right,page:document.documentElement.scrollWidth,barLines:new Set(['#show','#sort','#flip','#families','#search-box','#more'].map(function(sel){var b=document.querySelector(sel).getBoundingClientRect();return Math.round(b.top+b.height/2);})).size,barOver:document.getElementById('toolbar').scrollWidth-document.getElementById('toolbar').clientWidth};})()`);
    check('the grid fits 620 px with no sideways scroll, and the toolbar stays one line', narrowGrid.cols >= 3 && narrowGrid.over === 0 && narrowGrid.right <= 620 && narrowGrid.page <= 620 && narrowGrid.barLines === 1 && narrowGrid.barOver <= 0, narrowGrid);
    await b.evalIn(`__mock.skin={red:230,green:230,blue:230};__mock.listeners['com.adobe.csxs.events.ThemeColorChanged'].forEach(function(f){f();})`);
    await sleep(100);
    await b.shot('34-grid-620-light');
    const lightGrid = await b.evalIn(`({caption:getComputedStyle(document.querySelector('#tiles .t .n')).color,bg:getComputedStyle(document.getElementById('grid')).backgroundColor})`);
    check('the grid follows the light theme of Premiere', lightGrid.caption === 'rgb(29, 29, 31)' && lightGrid.bg === 'rgb(230, 230, 230)', lightGrid);
    await b.size(900, 620);
    await b.evalIn(`__mock.skin={red:35,green:35,blue:35};__mock.listeners['com.adobe.csxs.events.ThemeColorChanged'].forEach(function(f){f();});SelectApp.setMode('list')`);
    await setItems(b, 400);
    await resetView(b);

    // -------- a project opened after the panel started (a docked panel opens with Premiere, before any project)
    const keep = await b.evalIn(`JSON.stringify(__mock.project)`);
    await b.evalIn(`__mock.project=null`);
    await sleep(1600);
    await b.evalIn(`window.dispatchEvent(new Event('focus'))`);
    await b.waitFor(`SelectApp.state.project===null`, 'project gone', 5000);
    await b.evalIn(`__mock.project=${keep}`);
    await sleep(1600);
    await b.evalIn(`window.dispatchEvent(new Event('focus'))`);
    const seen = await b.waitFor(`!!SelectApp.state.project`, 'project seen', 5000).then(() => true, () => false);
    check('a project opened after the panel started is noticed when the panel is used again', seen && (await b.evalIn(`SelectApp.state.project.path`)) === JSON.parse(keep).path);

    // -------- the panel sends nothing
    const outside = b.requests.filter(u => !/^(file|data|about|blob):/.test(u));
    check('the panel made no network request in the whole run', outside.length === 0, outside.slice(0, 5));

    // -------- the panel going away
    b.engineEnv.FAKE_DELAY_MS = '20';
    await pressScan(b);
    await b.waitFor(`SelectApp.state.scan.handle&&SelectApp.state.store.tier0>2`);
    const exitedBefore = b.engineLog.exited.length;
    await b.send('Page.navigate', { url: 'about:blank' });
    const end = Date.now() + 3000;
    while (b.engineLog.exited.length === exitedBefore && Date.now() < end) { await sleep(20); }
    check('the engine is killed when the page unloads', b.engineLog.exited.length === exitedBefore + 1, b.engineLog.exited.slice(-1));
    check('no script errors during the whole run', b.problems.length === 0, b.problems.slice(0, 5));
  } catch (e) {
    check('harness ran to the end', false, e.stack);
    await b.shot('zz-failure').catch(() => {});
  }
  await b.close();
  // Each build package's own browser checks, in their own browser, when they are there.
  for (const name of ['./harness-a.js', './harness-b.js', './harness-resize.js', './harness-j.js', './harness-poll.js', './harness-f5.js']) {
    if (!fs.existsSync(path.join(__dirname, name))) { continue; }
    try { await require(name).run(check); } catch (e) { check(name + ' ran to the end', false, e.stack); }
  }
  stopEverything();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length} checks, ${failed.length} failed`);
  failed.forEach(f => console.log('  FAILED ' + f.name));
  process.exit(failed.length ? 1 : 0);
}

if (require.main === module) { main(); }

module.exports = { PREMIERE_APP, pickShow, pickSort, launch, setItems, clips, scanAndWait, pressScan, setDeadline, stopEverything, fixture, sleep, foot, OUT, check, contrast, over, PROJECT, press, labelFromMenu, rightClick, selectAll };
