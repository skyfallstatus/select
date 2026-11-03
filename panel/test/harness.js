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
const DEADLINE_MS = 330000;
const ROW_H = 40;
const PROJECT = { path: '/Volumes/Field SSD/Projects/lantern-spring.prproj', name: 'lantern-spring.prproj' };
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
    items: [], calls: [], partial: false, misplaced: 0, unconfirmed: false, hidden: false, hostFail: null, folderFiles: [], projectItemsForFolder: [], skin: { red: 35, green: 35, blue: 35 }, listeners: {}, urls: [] };
  var M = window.__mock;
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
    } },
    fs: { constants: { X_OK: 1 },
      accessSync: function () { if (M.accessError) { var e = new Error(M.accessError); e.code = M.accessError; throw e; } },
      readFileSync: function (file) {
        var text = /manifest\.xml$/.test(file) ? M.manifest : /config\.json$/.test(file) ? M.config : M.lockFile;
        if (text === null) { var e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
        return text;
      },
      readdir: function (dir, o, cb) { setTimeout(function () { cb(null, M.folderFiles.map(function (f) { return { name: f, isDirectory: function () { return false; }, isFile: function () { return true; } }; })); }, 0); } },
    os: { homedir: function () { return '/home/editor'; } },
    path: { join: function () { return Array.prototype.join.call(arguments, '/'); } },
    string_decoder: { StringDecoder: function () { var d = new TextDecoder('utf-8'); this.write = function (u) { return d.decode(u, { stream: true }); }; this.end = function () { return d.decode(); }; } }
  };
  window.require = function (n) { return shims[n]; };
  window.process = { env: {}, kill: function () { return true; } };
  function answer(fn, a) {
    M.calls.push({ fn: fn, args: a });
    if (M.hostFail && M.hostFail.fn === fn) { return M.hostFail.reply; }
    var bad = M.partial ? [{ id: 'x', name: 'C0001.MP4', error: 'simulated failure' }] : [];
    switch (fn) {
      case 'status': return { ok: true, version: 't', premiere: '26', project: M.project, playback: M.playback };
      case 'collect':
        if (!M.project) { return { ok: false, code: 'no-project', message: 'No project is open.' }; }
        return { ok: true, project: M.project, mode: a.mode, items: M.items, sequences: 1, noPath: 0, ms: 3 };
      case 'label': return { ok: true, changed: a.ids.length - bad.length, failed: bad, ms: 300, restore: { kind: 'label', color: a.color, items: a.ids.map(function (i) { return [i, 1]; }) } };
      case 'columns': return { ok: true, changed: a.rows.length - bad.length, matched: M.unconfirmed ? undefined : a.rows.length - bad.length - M.misplaced, failed: bad, columns: { shown: !M.hidden, added: 6, columns: 30 }, ms: 2000, restore: { kind: 'columns', fields: [], items: [] } };
      case 'bins': return { ok: true, root: a.root, moved: a.buckets.reduce(function (n, b) { return n + b.ids.length; }, 0) - bad.length, failed: bad, ms: 400,
        buckets: a.buckets.map(function (b, i) {
          var ids = b.ids.slice(0, i === 0 ? Math.max(0, b.ids.length - M.misplaced) : undefined);
          var out = { name: b.name, moved: b.ids.length, inBin: ids.length };
          if (!M.unconfirmed) { out.ids = ids; }
          return out;
        }), restore: { kind: 'bins', top: 't', items: [] } };
      case 'restore': return { ok: true, restored: 5, skipped: 1, failed: [], binRemoved: true, ms: 100 };
      case 'open': return { ok: true, name: 'clip' };
      case 'importClips': return { ok: true, imported: true, items: a.paths.map(function (p, i) { return { id: 'new' + i, path: p, name: p }; }), bin: a.bin, ms: 200 };
      default: return { ok: false, code: 'unknown-call', message: fn };
    }
  }
  window.__adobe_cep__ = {
    evalScript: function (script, cb) {
      setTimeout(function () {
        if (script === 'typeof slCall') { cb('function'); return; }
        var out = null;
        new Function('slCall', script)(function (fn, json) { out = JSON.stringify(answer(fn, JSON.parse(json))); });
        cb(out);
      }, 0);
    },
    getHostEnvironment: function () { return JSON.stringify({ appSkinInfo: { panelBackgroundColor: { color: M.skin } } }); },
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
  await P('Page.addScriptToEvaluateOnNewDocument', { source: SHIM.replace('__PROJECT__', JSON.stringify(PROJECT)) + `\nwindow.__mock.manifest=${JSON.stringify(manifest)};` });
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
  async function click(selector, opts) {
    const r = await evalIn(`(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e){return null;}e.scrollIntoView({block:'nearest',inline:'nearest'});var b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2};})()`);
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
  return { evalIn, open, waitFor, click, mouse, shot, close, size, problems, requests, engineEnv, engineLog, send: P };
}

// ---------------------------------------------------------------- helpers in the page

const text = id => `document.getElementById(${JSON.stringify(id)}).textContent`;
const domRows = `Array.from(document.querySelectorAll('#body .r')).filter(function(r){return r.style.display!=='none';}).map(function(r){return {at:Number(r.dataset.at),cls:r.className,cells:Array.from(r.children).map(function(c){return c.textContent;})};}).sort(function(a,b){return a.at-b.at;})`;
const colIndex = key => `SelectApp.state.columns.map(function(c){return c.key;}).indexOf(${JSON.stringify(key)})`;
const ids = `SelectApp.state.order.map(function(i){return SelectApp.state.store.rows[i];})`;
const foot = `({kind:document.getElementById('foot').className,mark:document.getElementById('foot-mark').dataset.kind,verdict:document.getElementById('foot-verdict').textContent,sentence:document.getElementById('foot-sentence').textContent,
  actions:Array.from(document.querySelectorAll('#foot-actions button')).filter(function(b){return !b.hidden;}).map(function(b){return b.id+(b.classList.contains('primary')?'*':'');}),
  background:getComputedStyle(document.getElementById('foot')).backgroundColor,color:getComputedStyle(document.getElementById('foot-verdict')).color})`;

function clips(n) {
  const list = [];
  for (let i = 0; i < n; i++) {
    const r = fixture[i % fixture.length];
    list.push({ id: 'id' + i, path: i < fixture.length ? r.path : `${r.path}.${i}.mp4`, name: path.basename(r.path) });
  }
  return list;
}

// A preset is a word in the sort row, or a word in one of its group menus. Real clicks either way.
async function pressPreset(b, id) {
  const group = await b.evalIn(`(SelectCore.GROUPS.filter(function(g){return g.presets.indexOf(${JSON.stringify(id)})>=0;})[0]||{}).id||''`);
  if (group) {
    await b.click(`#presets [data-group="${group}"]`);
    await b.click(`#sort-menu [data-id="${id}"]`);
  } else {
    await b.click(`#presets [data-id="${id}"]`);
  }
}

async function setItems(b, n) { await b.evalIn(`__mock.items=${JSON.stringify(clips(n))}`); }

// Scan is in the foot until the first scan ends, then in the menu as Rescan.
async function pressScan(b) {
  if (await b.evalIn(`document.getElementById('scan').hidden`)) {
    await b.click('#more');
    await b.click('[data-menu="rescan"]');
  } else {
    await b.click('#scan');
  }
}

async function scanAndWait(b) {
  await b.click('#source button[data-src="project"]');
  const n = b.engineLog.exited.length;
  await pressScan(b);
  const end = Date.now() + 60000;
  while (b.engineLog.exited.length === n && Date.now() < end) { await sleep(10); }
  await b.waitFor(`SelectApp.state.scan && !SelectApp.state.scan.handle && SelectApp.state.scan.state!=='Scanning'`, 'scan end', 60000);
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
  for (const p of ['softest', 'sharpest', 'darkest', 'overexposed', 'motion', 'static', 'silent', 'interviews', 'duplicates', 'shoot']) {
    await pressPreset(b, p);
    await sleep(250);
    report[p] = await b.evalIn(`({says:document.getElementById('foot-sentence').textContent,top:${ids}.slice(0,3).map(function(r){return r.name;})})`);
    await b.shot('21-real-' + p);
    await pressPreset(b, p);
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
  const GREEN = 'rgb(21, 128, 61)';
  try {
    await b.open();
    check('page loads with no script errors', b.problems.length === 0, b.problems);
    const row = await b.evalIn(`({tips:SelectCore.PRESETS.filter(function(p){return p.tip.length>40;}).length,all:SelectCore.PRESETS.length,words:document.querySelectorAll('#presets .word').length,dots:document.querySelectorAll('#families button').length,tips2:Array.from(document.querySelectorAll('#presets .word')).filter(function(x){return x.title.length>4;}).length})`);
    check('the sort row is seven words and nine dots, and every preset has a tooltip', row.all === 23 && row.tips === 23 && row.words === 7 && row.dots === 9 && row.tips2 === 7, row);
    await b.waitFor(`document.getElementById('project-name').textContent==='lantern-spring'`, 'project name');
    check('project name shows from status, without the extension', true);

    // -------- the foot before a scan
    await b.click('#source button[data-src="project"]');
    const before = await footNow();
    check('foot before a scan: a ring, a plain line and a cobalt Scan', before.mark === 'waiting' && /Nothing scanned yet/.test(before.verdict) && /every clip in this project/.test(before.sentence) && before.actions.join() === 'scan*', before);
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
    const meter = await b.evalIn(`({shown:!document.getElementById('foot-meter').hidden,width:parseFloat(document.getElementById('foot-meter-fill').style.width),fill:getComputedStyle(document.getElementById('foot-meter-fill')).backgroundColor,spin:getComputedStyle(document.querySelector('#foot-mark .m-arc')).animationName})`);
    check('foot while scanning: spinner, count of the total, clips per second, quiet Stop', mid.mark === 'running' && /^Reading [1-9]\d* of 400$/.test(mid.verdict) && /[1-9]\d* clips per second/.test(mid.sentence) && mid.actions.join() === 'stop', mid);
    check('the meter is thin, grey and moving', meter.shown && meter.width > 0 && meter.width < 100 && meter.fill === 'rgb(160, 160, 166)' && meter.spin === 'turn', meter);
    const filled = await b.evalIn(`(function(){var d=${domRows},i=${colIndex('sharpness')};return d.filter(function(r){return r.cells[i]!=='';}).length;})()`);
    check('columns fill in while the scan runs', filled > 0, filled);
    await b.shot('01-scanning');
    await b.waitFor(`SelectApp.state.scan && SelectApp.state.scan.state==='Done'`, 'done', 30000);
    const done = await b.evalIn(`({foot:${foot},t0:SelectApp.state.store.tier0,t1:SelectApp.state.store.tier1,errors:SelectApp.state.store.errors})`);
    check('scan ends Done, both tiers landed', /^400 clips read$/.test(done.foot.verdict) && /^Took \d+\.\d s\. Pick a sort above\. \d+ clips are listed with blank picture scores: this Mac has no decoder for them, and ffmpeg isn't installed\./.test(done.foot.sentence) && done.t0 === 400 - unreadable && done.t1 === 400 - unreadable && done.errors === unreadable, done);
    check('engine binary path is inside the extension, with scan arguments', /\/bin\/select-engine$/.test(b.engineLog.lastBin) && b.engineLog.lastArgs.join(' ') === 'scan --paths-file -', b.engineLog.lastBin);
    await b.waitFor(`document.querySelectorAll('#body img[src]').length>0`, 'thumbs');
    await sleep(200);
    const loaded = await b.evalIn(`Array.from(document.querySelectorAll('#body img[src]')).filter(function(i){return i.complete&&i.naturalWidth>0;}).length`);
    check('thumbnails load from file paths', loaded > 0, loaded);
    await b.shot('02-done');

    // -------- clips that could not be read
    const status = await b.evalIn(text('status-unread'));
    check('a status line counts the unread clips and says why in one sentence', status.startsWith('8 clips could not be read: .braw and .r3d aren\'t supported yet, .mov and .mxf need ffmpeg, some files are missing or offline and some files may be damaged.'), status);
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
    await b.click(`#head .h[data-key="audioDb"]`);
    const shown = await b.evalIn(`(function(){var d=${domRows},i=${colIndex('audioDb')};return d.map(function(r){return r.cells[i];});})()`);
    check('no zero appears in the Audio column where the value is null', !shown.some(v => v === '0' || v === '0.0'), shown.slice(0, 5));
    await b.evalIn(`document.getElementById('grid').scrollTop=1e9`);
    await sleep(100);
    const tail = await b.evalIn(`(function(){var d=${domRows},i=${colIndex('audioDb')};return d.slice(-5).map(function(r){return r.cells[i];});})()`);
    check('nulls sort to the end of the table and stay empty', tail.every(v => v === ''), tail);
    await b.evalIn(`document.getElementById('grid').scrollTop=0`);

    // -------- presets
    await b.click('#clear-view');
    const orderOf = key => b.evalIn(`${ids}.map(function(r){return r[${JSON.stringify(key)}];})`);
    const sorted = (v, dir) => { const a = v.filter(x => x !== null && x !== undefined); return a.every((x, i) => !i || (dir > 0 ? a[i - 1] <= x : a[i - 1] >= x)); };
    const presets = [['softest', 'sharpness', 1], ['sharpest', 'sharpness', -1], ['darkest', 'luma', 1], ['overexposed', 'clipHighPct', -1], ['motion', 'motionProxy', -1], ['static', 'motionProxy', 1]];
    for (const [id, key, dir] of presets) {
      await pressPreset(b, id);
      const v = await orderOf(key);
      const on = await b.evalIn(`SelectApp.state.view.preset`);
      const f = await footNow();
      check(`preset ${id} sorts and says so`, sorted(v, dir) && on === id && f.verdict === (await b.evalIn(`SelectCore.PRESET[${JSON.stringify(id)}].label`)) && / at the top\./.test(f.sentence) && (await b.evalIn(`!!document.querySelector('#presets .on')`)), f.sentence);
      await pressPreset(b, id);
      const off = await b.evalIn(`document.querySelector('#presets button.on')===null&&SelectApp.state.view.preset===null`);
      check(`preset ${id} turns off with a second press`, off);
    }
    const presetStyle = await b.evalIn(`(function(){var x=document.querySelector('#presets [data-id="colour"]');x.click();var a=getComputedStyle(x),o=getComputedStyle(document.querySelector('#presets [data-id="shoot"]'));var r={on:[a.color,a.fontWeight,a.backgroundColor,a.borderStyle],off:[o.color,o.fontWeight,o.backgroundColor]};x.click();return r;})()`);
    check('the active word is in ink and semibold, the others in ink2, no pills', presetStyle.on[0] === 'rgb(237, 237, 238)' && presetStyle.on[1] === '600' && presetStyle.on[2] === 'rgba(0, 0, 0, 0)' && presetStyle.off[0] === 'rgb(173, 173, 177)' && presetStyle.off[1] === '400', presetStyle);
    await pressPreset(b, 'overexposed');
    check('a switched-off column shows while the view sorts by it', await b.evalIn(`!!document.querySelector('#head .h[data-key="clipHighPct"]')`));
    await pressPreset(b, 'overexposed');
    for (const id of ['silent', 'interviews', 'duplicates', 'shoot']) {
      await pressPreset(b, id);
      const info = await b.evalIn(`({shown:SelectApp.state.order.length,sentence:document.getElementById('foot-sentence').textContent,group:SelectApp.state.hasGroups})`);
      check(`preset ${id} shows what it does`, info.sentence.length > 5 && (id === 'shoot' ? info.shown === 400 : info.shown > 0 && info.shown < 400), info);
      if (id === 'duplicates') {
        await b.shot('03-near-duplicates');
        check('near duplicates show as groups, each under its own heading', await b.evalIn(`/^Group 1 /.test(document.querySelector('#body .gh').textContent)&&!document.querySelector('#head .h[data-key="dupGroup"]')`));
      }
      if (id === 'interviews') { await b.shot('04-interviews'); }
      await b.click('#more');
      await b.click('[data-menu="undo-view"]');
      check(`preset ${id} undoes with Undo view`, await b.evalIn(`SelectApp.state.view.preset===null&&SelectApp.state.order.length===400`));
    }
    check('group headings leave after undo', await b.evalIn(`!SelectApp.state.L.heads.length&&Array.from(document.querySelectorAll('#body .gh')).length===0`));

    // -------- sort at 1,000 rows: real clicks on every header
    await setItems(b, 1000);
    b.engineEnv.FAKE_DELAY_MS = '0';
    await scanAndWait(b);
    check('1,000 clips scanned', (await b.evalIn(`SelectApp.state.store.rows.length`)) === 1000);
    await b.evalIn(`SelectApp.state.history.length=0`);
    await b.evalIn(`document.getElementById('clear-view').click()`);
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
    check('About shows the sort time, and the version from the manifest', /Last re-sort: \d+\.\d ms, 1,000 rows/.test(about) && new RegExp('Version ' + (/ExtensionBundleVersion="([^"]+)"/.exec(fs.readFileSync(MANIFEST, 'utf8'))[1]).replace(/\./g, '\\.')).test(about), about);
    check('About claims only the formats that work', /Reads \.mp4, \.mov and \.m4v/.test(about) && /\.mxf when ffmpeg is installed/.test(about) && /\.r3d/.test(about) && /sends nothing/.test(about));
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
    await b.evalIn(`document.getElementById('clear-view').click()`);
    await pressPreset(b, 'sharpest');
    const finished = await footNow();
    check('foot when finished: a grey tick, the sort as the verdict, three actions, Sort into Bins cobalt, Scan gone', finished.mark === 'done' && finished.verdict === 'Sharpest first' && /^400 clips in \d+\.\d s\. Sharpest at the top\. \d+ clips are listed with blank picture scores/.test(finished.sentence) && (finished.sentence.match(/blank/g) || []).length === 1 && finished.actions.join() === 'do-label,do-columns,do-bins*', finished);
    await b.click('#more');
    const menu = await b.evalIn(`Array.from(document.querySelectorAll('#menu button')).filter(function(x){return !x.hidden;}).map(function(x){return x.textContent;})`);
    check('the menu holds Rescan, Columns, Undo View, Clear Results, Report a Bug and About', menu.join('|') === 'Rescan|Columns…|Undo View|Clear Results|Report a Bug|About Select', menu);
    await b.shot('12-menu');
    await b.mouse(300, 300);
    check('a click elsewhere closes the menu', await b.evalIn(`document.getElementById('menu').hidden`));
    await b.evalIn(`SelectApp.state.selected.clear();SelectApp.state.anchor=null;SelectApp.applyView()`);
    const rowSel = n => `#body .r[data-at="${n}"]`;
    await b.click(rowSel(2));
    await b.click(rowSel(6), { shift: true });
    await b.click(rowSel(4), { meta: true });
    check('click, shift-click and cmd-click select rows', (await b.evalIn(`SelectApp.state.selected.size`)) === 4, await b.evalIn(text('foot-sentence')));
    const selected = await b.evalIn(`(function(){var s=getComputedStyle(document.querySelector('#body .r.sel'),'::before');return {bg:s.backgroundColor,radius:s.borderRadius,left:s.left};})()`);
    check('selected rows use a quiet grey, inset and rounded, never cobalt', selected.bg === 'rgb(58, 58, 64)' && selected.radius === '7px' && selected.left === '8px', selected);
    const hierarchy = await b.evalIn(`(function(){var r=document.querySelector('#body .r:not(.err):not(.two)');return {by:getComputedStyle(r.querySelector('.c-sharpness')).color,weight:getComputedStyle(r.querySelector('.c-sharpness')).fontWeight,other:getComputedStyle(r.querySelector('.c-luma')).color};})()`);
    check('the sorted column keeps ink and the other figures step back', hierarchy.by === 'rgb(237, 237, 238)' && hierarchy.weight === '600' && hierarchy.other === 'rgb(173, 173, 177)', hierarchy);
    await b.shot('13-selected');

    await b.click('#do-label');
    await waitModal();
    const labelText = await dialogText();
    check('Label confirmation gives the count and the undo truth', /Label 4 clips/.test(labelText) && /Mango/.test(labelText) && /4 clips/.test(labelText) && /Cmd\+Z/.test(labelText), labelText);
    await b.shot('05-label-dialog');
    await b.click('#dialog-cancel');
    check('cancel writes nothing', (await calls('label')).length === 0 && /Cancelled/.test(await noteText()));

    await b.click('#do-label');
    await waitModal();
    await b.click('#dialog-ok');
    await b.waitFor(`__mock.calls.some(function(c){return c.fn==='label';})`);
    const lab = (await calls('label'))[0].args;
    const want = await b.evalIn(`Array.from(SelectApp.state.selected).map(function(i){return SelectApp.state.store.rows[i].ids[0];})`);
    check('Label sends one batch, for the selected rows only', lab.ids.length === 4 && lab.color === 7 && lab.project === PROJECT.path && want.every(i => lab.ids.includes(i)), lab);
    await b.waitFor(`/Labelled/.test(${text('foot-verdict')})`);
    await sleep(320);
    const labelled = await footNow();
    check('labels read back: the foot turns green, with a white Undo', /green/.test(labelled.kind) && labelled.mark === 'seal' && labelled.background === GREEN && labelled.actions.join() === 'undo-write', labelled);

    await b.click('#undo-write');
    await waitModal();
    await b.click('#dialog-ok');
    await b.waitFor(`__mock.calls.some(function(c){return c.fn==='restore';})`);
    const rest = (await calls('restore'))[0].args;
    check('Undo sends back what the write replaced', rest.restore.kind === 'label' && rest.restore.items.length === 4 && rest.project === PROJECT.path);
    await b.waitFor(`/left alone/.test(${text('foot-sentence')})`);
    const undone = await footNow();
    check('a restore that skips an item says so, and is never green', !/green/.test(undone.kind) && /left alone/.test(undone.sentence), undone.sentence);

    // a selection empties: the writes then cover the current view
    await b.evalIn(`SelectApp.state.selected.clear();SelectApp.state.outcome=null;SelectApp.applyView()`);
    await b.click('#do-columns');
    await waitModal();
    const colText = await dialogText();
    check('Add Columns confirmation: count, fields, undo limits', /400 clips/.test(colText) && /13 columns/.test(colText) && /Rank, Sharpness/.test(colText) && /start with Select/.test(colText) && /Premiere keeps only the last 50/.test(colText) && /Metadata Display/.test(colText), colText);
    await b.shot('06-columns-dialog');
    await b.click('#dialog-ok');
    await b.waitFor(`__mock.calls.some(function(c){return c.fn==='columns';})`);
    const col = (await calls('columns'))[0].args;
    check('Add Columns sends one call, rows ranked by view order', col.rows.length === 400 && col.rows[0].values.SelectRank === '0001' && col.rows[399].values.SelectRank === '0400' && col.fields.length === 13, col.rows[0]);
    await b.waitFor(`/Added 13 columns/.test(${text('foot-verdict')})`);
    await sleep(320);
    check('columns read back and shown: green', (await footNow()).background === GREEN, (await footNow()).sentence);
    await b.evalIn(`SelectApp.state.outcome=null;SelectApp.applyView()`);

    await b.click('#do-bins');
    await waitModal();
    const binText = await dialogText();
    check('Sort into Bins confirmation says items move, not files', /moves items in the Project panel, not files on disk/.test(binText) && /SELECT \d{4}-\d\d-\d\d Sharpest first/.test(binText) && /01 Sharpest\s+\d+/.test(binText) && /05 Softest\s+\d+/.test(binText), binText);
    check('the sheet has a radius of 14, one cobalt button and the undo truth', (await b.evalIn(`getComputedStyle(document.getElementById('dialog')).borderRadius`)) === '14px' && (await b.evalIn(`Array.from(document.querySelectorAll('#dialog button')).filter(function(x){return getComputedStyle(x).backgroundColor==='rgb(47, 111, 230)';}).length`)) === 1 && /Premiere keeps only the last 50/.test(binText));
    await b.shot('07-bins-dialog');
    await b.click('#dialog-ok');
    await b.waitFor(`__mock.calls.some(function(c){return c.fn==='bins';})`);
    const bin = (await calls('bins'))[0].args;
    check('Sort into Bins sends one call with every clip in one bucket', bin.buckets.reduce((n, x) => n + x.ids.length, 0) === 400 && new Set(bin.buckets.flatMap(x => x.ids)).size === 400, bin.buckets.map(x => [x.name, x.ids.length]));
    await b.waitFor(`/Sorted into/.test(${text('foot-verdict')})`);
    await sleep(320);
    const sortedFoot = await b.evalIn(`(function(){var u=getComputedStyle(document.getElementById('undo-write'));return {f:${foot},undoBg:u.backgroundColor,undoColor:u.color,sentence:getComputedStyle(document.getElementById('foot-sentence')).color};})()`);
    check('bins read back: green foot, plain words, Undo in white', sortedFoot.f.background === GREEN && /^Sorted into 6 bins$/.test(sortedFoot.f.verdict) && /^400 clips moved\. Your files weren't touched\.$/.test(sortedFoot.f.sentence) && sortedFoot.undoBg === 'rgb(255, 255, 255)' && sortedFoot.undoColor === GREEN && sortedFoot.sentence === 'rgb(255, 255, 255)', sortedFoot);
    await b.shot('08-bins-green');
    await pressPreset(b, 'softest');
    await sleep(320);
    check('a new view moves on from the green foot', (await footNow()).background !== GREEN);
    await pressPreset(b, 'sharpest');

    // -------- a read-back that does not match is never green
    await b.evalIn(`__mock.misplaced=3`);
    await b.click('#do-bins');
    await waitModal();
    await b.click('#dialog-ok');
    await b.waitFor(`/Moved 397 of 400/.test(${text('foot-verdict')})`);
    const partial = await footNow();
    check('partial read-back on bins: plain words, no green', partial.background !== GREEN && !/green/.test(partial.kind) && partial.mark === 'look' && /3 clips did not land where they should/.test(partial.sentence) && partial.actions.includes('undo-write'), partial);
    await b.shot('14-bins-partial');
    await b.evalIn(`__mock.misplaced=0;__mock.unconfirmed=true;SelectApp.state.outcome=null;SelectApp.applyView()`);
    await b.click('#do-bins');
    await waitModal();
    await b.click('#dialog-ok');
    await b.waitFor(`/not confirmed/.test(${text('foot-verdict')})`);
    check('a write with no read-back at all is not green, whatever the host says', (await footNow()).background !== GREEN, (await footNow()).sentence);
    await b.evalIn(`__mock.unconfirmed=false;__mock.misplaced=2;SelectApp.state.outcome=null;SelectApp.applyView()`);
    await b.click('#do-columns');
    await waitModal();
    await b.click('#dialog-ok');
    await b.waitFor(`/Wrote 398 of 400/.test(${text('foot-verdict')})`);
    check('partial read-back on columns: plain words, no green', (await footNow()).background !== GREEN, (await footNow()).sentence);
    await b.evalIn(`__mock.misplaced=0;__mock.hidden=true;SelectApp.state.outcome=null;SelectApp.applyView()`);
    await b.click('#do-columns');
    await waitModal();
    await b.click('#dialog-ok');
    await b.waitFor(`/not showing/.test(${text('foot-verdict')})`);
    check('columns written but not shown: says what to do, no green', (await footNow()).background !== GREEN && /Metadata Display/.test((await footNow()).sentence));
    await b.evalIn(`__mock.hidden=false;SelectApp.state.outcome=null;SelectApp.applyView()`);

    await b.evalIn(`__mock.partial=true`);
    await b.click('#do-label');
    await waitModal();
    await b.click('#dialog-ok');
    await b.waitFor(`/Labelled 399 of 400/.test(${text('foot-verdict')})`);
    check('partial failures: no green, and Details lists them', (await footNow()).background !== GREEN && (await footNow()).actions.includes('foot-details'), (await footNow()).sentence);
    await b.click('#foot-details');
    await waitModal();
    check('partial failures are listed', /simulated failure/.test(await dialogText()), await dialogText());
    await b.click('#dialog-ok');
    await b.evalIn(`__mock.partial=false;SelectApp.state.outcome=null;SelectApp.applyView()`);

    // -------- refusals
    const start = await b.evalIn(`__mock.calls.length`);
    await b.evalIn(`__mock.config='{"writeLockFile":"/tmp/some-tool.lock.json"}';__mock.lockFile=${JSON.stringify(JSON.stringify({ who: 'cutting tool', pid: 123, op: 'build cut', since: 'now' }))}`);
    await b.click('#do-label');
    await b.waitFor(`/write lock is held by cutting tool/.test(${text('status-note')})`);
    check('write refused while the configured lock is held, no dialog, no host write', !(await modalOpen()) && (await b.evalIn(`__mock.calls.slice(${start}).filter(function(c){return c.fn!=='status';}).length`)) === 0, await noteText());
    await b.evalIn(`__mock.lockFile='{broken'`);
    await b.click('#do-bins');
    await b.waitFor(`/write lock is held/.test(${text('status-note')})`);
    check('unreadable lock file is refused too', !(await modalOpen()));
    await b.evalIn(`__mock.config=null;__mock.lockFile='{"pid":123}'`);
    await b.click('#do-label');
    await waitModal();
    check('with no setting the lock file is not even looked at', true);
    await b.click('#dialog-cancel');
    await b.evalIn(`__mock.config='not json at all';__mock.lockFile='{"pid":123}'`);
    await b.click('#do-label');
    await waitModal();
    check('a broken config file never breaks the panel, and means no check', b.problems.length === 0);
    await b.click('#dialog-cancel');
    await b.evalIn(`__mock.config=null;__mock.lockFile=null;__mock.playback={program:true,source:false,modal:''}`);
    await b.click('#do-label');
    await b.waitFor(`/Playback is running/.test(${text('status-note')})`);
    check('write refused while the program plays', !(await modalOpen()));
    await b.evalIn(`__mock.playback={program:null,source:false,modal:''}`);
    await b.click('#do-bins');
    await b.waitFor(`/did not confirm/.test(${text('status-note')})`);
    check('unknown playback state is refused', !(await modalOpen()), await noteText());
    await b.evalIn(`__mock.playback={program:false,source:false,modal:'dialog'}`);
    await b.click('#do-columns');
    await b.waitFor(`/dialog is open/.test(${text('status-note')})`);
    check('open dialog in Premiere is refused', !(await modalOpen()));
    await b.evalIn(`__mock.playback={program:false,source:false,modal:''}`);
    // lock taken while the sheet is up
    await b.evalIn(`__mock.config='{"writeLockFile":"/tmp/some-tool.lock.json"}'`);
    await b.click('#do-label');
    await waitModal();
    await b.evalIn(`__mock.lockFile=${JSON.stringify(JSON.stringify({ who: 'tool y', pid: 123, op: 'x' }))}`);
    const n0 = (await calls('label')).length;
    await b.click('#dialog-ok');
    await b.waitFor(`/held by tool y/.test(${text('status-note')})`);
    check('lock checked again after the confirmation', (await calls('label')).length === n0);
    await b.evalIn(`__mock.lockFile=null;__mock.config=null`);
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
    await b.click('#body .r[data-at="1"]', { count: 2 });
    await b.waitFor(`__mock.calls.some(function(c){return c.fn==='open';})`);
    const op = (await calls('open'))[0].args;
    check('double-click opens the clip by id', /^id\d+$/.test(op.id) && op.project === PROJECT.path, op);

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
    const clearedView = await b.evalIn(`({sort:SelectApp.state.view.sort.length,preset:SelectApp.state.view.preset,on:document.querySelectorAll('#presets button.on').length,marks:document.querySelectorAll('#head .mark').length})`);
    check('Clear Results goes back to the first foot and the first view, and writes nothing', cleared.mark === 'waiting' && cleared.actions.join() === 'scan*' && (await b.evalIn(`SelectApp.state.store.rows.length`)) === 0 && !clearedView.sort && !clearedView.preset && !clearedView.on && !clearedView.marks, { cleared, clearedView });

    // -------- folder source, not in the project
    await b.evalIn(`__mock.folderFiles=['A0001.MP4','._A0001.MP4','A0001M01.XML','B0002.mov'];__mock.items=[{id:'p1',path:'/Volumes/Field SSD/f/A0001.MP4',name:'A0001.MP4'}]`);
    await b.click('#source button[data-src="folder"]');
    check('Folder reveals a quiet path line with Choose', await b.evalIn(`!document.getElementById('folder-box').hidden&&!document.getElementById('choose').hidden&&getComputedStyle(document.getElementById('folder')).borderTopStyle==='none'`));
    await b.click('#folder');
    await b.send('Input.insertText', { text: '/Volumes/Field SSD/f' });
    await b.shot('16-folder');
    await b.click('#scan');
    await b.waitFor(`SelectApp.state.scan && SelectApp.state.scan.state==='Done'&&SelectApp.state.store.rows.length===2`, 'folder scan');
    check('folder source lists video only', (await b.evalIn(`SelectApp.state.store.rows.map(function(r){return r.name;}).sort().join()`)) === 'A0001.MP4,B0002.mov');
    const atOf = await b.evalIn(`SelectApp.state.order.map(function(i){return SelectApp.state.store.rows[i].name;}).indexOf('B0002.mov')`);
    await b.click(`#body .r[data-at="${atOf}"]`, { count: 2 });
    await waitModal();
    const offer = await dialogText();
    check('a clip outside the project is offered, not imported silently', /not in lantern-spring/.test(offer) && /Import and Open/.test(offer) && (await calls('importClips')).length === 0, offer);
    await b.shot('09-import-offer');
    await b.click('#dialog-ok');
    await b.waitFor(`__mock.calls.some(function(c){return c.fn==='importClips';})`);
    await b.waitFor(`__mock.calls.filter(function(c){return c.fn==='open';}).length>=2`);
    const imp = (await calls('importClips'))[0].args;
    const open2 = (await calls('open')).pop().args;
    check('import then open uses the new item', imp.paths[0] === '/Volumes/Field SSD/f/B0002.mov' && open2.id === 'new0', { imp, open2 });
    const atA = await b.evalIn(`SelectApp.state.order.map(function(i){return SelectApp.state.store.rows[i].name;}).indexOf('A0001.MP4')`);
    await b.click(`#body .r[data-at="${atA}"]`, { count: 2 });
    await sleep(200);
    check('a folder clip already in the project opens without an offer', (await calls('open')).pop().args.id === 'p1' && !(await modalOpen()));
    // one row in the project, one not: paths decide, whatever ids a row carried before
    await b.evalIn(`__mock.items=[{id:'p9',path:'/Volumes/Field SSD/f/A0001.MP4',name:'A0001.MP4'}];__mock.calls.length=0;SelectApp.state.selected.clear();SelectApp.state.store.rows.forEach(function(r){r.ids=['stale'];});SelectApp.applyView()`);
    await b.click('#do-label');
    await waitModal();
    const skipped = await dialogText();
    check('rows not in the project are counted as skipped', /1 clip not in this project will be skipped/.test(skipped), skipped);
    await b.click('#dialog-ok');
    await b.waitFor(`__mock.calls.some(function(c){return c.fn==='label';})`);
    check('ids come from the project in front, never from an old scan', JSON.stringify((await calls('label'))[0].args.ids) === '["p9"]', (await calls('label'))[0].args.ids);
    await b.evalIn(`SelectApp.state.outcome=null;SelectApp.applyView()`);
    // another project in front, same clip path: the write lands on that project's item
    await b.evalIn(`__mock.project={path:'/Volumes/Field SSD/Projects/other.prproj',name:'other.prproj'};__mock.items=[{id:'q1',path:'/Volumes/Field SSD/f/A0001.MP4',name:'A0001.MP4'}];__mock.calls.length=0`);
    await b.click('#do-label');
    await waitModal();
    check('the confirmation names the project in front', /other/.test(await dialogText()), await dialogText());
    await b.click('#dialog-cancel');
    await b.evalIn(`__mock.project=${JSON.stringify(PROJECT)}`);

    // -------- failures of the engine
    await setItems(b, 400);
    await b.click('#source button[data-src="project"]');
    b.engineEnv.FAKE_DELAY_MS = '5';
    await pressScan(b);
    await b.waitFor(`SelectApp.state.scan.handle&&SelectApp.state.store.tier0>3`);
    const spawnedBefore = b.engineLog.exited.length;
    await b.click('#stop');
    await b.waitFor(`SelectApp.state.scan.state==='Stopped'`);
    const stopped = await b.evalIn(`({rows:SelectApp.state.store.rows.length,t0:SelectApp.state.store.tier0,foot:${foot}})`);
    check('Stop ends the engine, rows stay, Scan is back', b.engineLog.exited.length === spawnedBefore + 1 && stopped.rows === 400 && stopped.t0 < 400 && stopped.foot.verdict === 'Stopped' && /What was read stays/.test(stopped.foot.sentence) && stopped.foot.actions.includes('scan*'), stopped);

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
    const dirty = await b.evalIn(text('status-unread'));
    check('junk lines and clip errors are counted', /^16 clips could not be read: /.test(dirty) && /engine lines could not be understood/.test(dirty) && (await b.evalIn(`SelectApp.state.store.errors`)) === 16, dirty);
    await pressPreset(b, 'shoot');
    await pressPreset(b, 'shoot');
    await b.shot('10-errors');
    b.engineEnv.FAKE_MODE = '';
    b.engineEnv.FAKE_ERRORS = '';
    await b.evalIn(`__mock.accessError='ENOENT'`);
    await pressScan(b);
    await b.waitFor(`/not installed/.test(${text('foot-sentence')})`);
    const noEngine = await footNow();
    check('missing engine: rows still list, and the foot says what to do', (await b.evalIn(`SelectApp.state.store.rows.length`)) === 400 && noEngine.mark === 'failed' && /Reinstall Select/.test(noEngine.sentence) && noEngine.actions.includes('scan*'), noEngine);
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
    await b.click('#scan');
    await b.waitFor(`/No project is open/.test(${text('status-note')})`);
    check('no project open is a clear message', true);
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
    check('Premiere dark: dark tokens', dark.theme === 'dark' && dark.surface === '#26262A' && dark.ink === '#EDEDEE', dark);
    await b.evalIn(`__mock.skin={red:230,green:230,blue:230};__mock.listeners['com.adobe.csxs.events.ThemeColorChanged'].forEach(function(f){f();})`);
    const light = await b.evalIn(`({theme:document.documentElement.dataset.theme,surface:${token('surface')},ink:${token('ink')},bg:getComputedStyle(document.getElementById('grid')).backgroundColor})`);
    check('Premiere set bright: the theme-change event switches to the light tokens', light.theme === 'light' && light.surface === '#FFFFFF' && light.ink === '#1D1D1F' && light.bg === 'rgb(255, 255, 255)', light);
    await b.shot('18-light');
    const TOKENS = {
      light: { ink: '#1D1D1F', ink2: '#5F6063', ink3: '#8E8E93', surface: '#FFFFFF', foot: '#F4F4F6', disc: '#E7E7EC', tick: '#3A3A3C', ring: '#C9C9CE', track: '#E9E9EE', meter: '#6E6E73', 'focus-ring': '#8A8A90', cobalt: '#2563EB', bad: '#C9281C', safe: '#15803D' },
      dark: { ink: '#EDEDEE', ink2: '#ADADB1', ink3: '#7C7C82', surface: '#26262A', foot: '#1C1C1F', disc: '#3A3A40', tick: '#EDEDEE', ring: '#55555C', track: '#3A3A40', meter: '#A0A0A6', 'focus-ring': '#9A9AA0', cobalt: '#2F6FE6', bad: '#FF6A5F', safe: '#15803D' }
    };
    const measured = [];
    for (const theme of ['light', 'dark']) {
      await b.evalIn(`__mock.skin=${theme === 'light' ? '{red:230,green:230,blue:230}' : '{red:35,green:35,blue:35}'};__mock.listeners['com.adobe.csxs.events.ThemeColorChanged'].forEach(function(f){f();})`);
      const got = await b.evalIn(`(function(){var o={};${JSON.stringify(Object.keys(TOKENS[theme]))}.forEach(function(k){o[k]=${token('X').replace('"--X"', "'--'+k")};});return o;})()`);
      check(`every ${theme} token is exactly Ingest's`, JSON.stringify(got) === JSON.stringify(TOKENS[theme]), got);
      const T = TOKENS[theme];
      for (const [fg, bg, label] of [[T.ink, T.surface, 'ink on surface'], [T.ink2, T.surface, 'ink2 on surface'], [T.ink, T.foot, 'ink on foot'], [T.ink2, T.foot, 'ink2 on foot'], [T.ink, T.disc, 'ink on a selected row'], [T.ink2, T.disc, 'ink2 on a selected row'], [T.ink, T.track, 'ink on a quiet button'], [T.bad, T.foot, 'bad on foot'], ['#FFFFFF', T.cobalt, 'white on cobalt'], ['#FFFFFF', T.safe, 'white on safe'], [T.safe, '#FFFFFF', 'safe on white']]) {
        measured.push({ theme, label, ratio: contrast(fg, bg) });
      }
    }
    const low = measured.filter(m => m.ratio < 4.5);
    check('every text colour measures at least 4.5:1 in both themes', low.length === 0, low.length ? low : `lowest ${Math.min(...measured.map(m => m.ratio)).toFixed(2)}:1 over ${measured.length} pairs`);

    // -------- 620 px, the panel's minimum
    await b.size(620, 420);
    await b.evalIn(`(function(){var o=document.querySelector('#presets [data-id="colour"]');if(!o.classList.contains('on')){o.click();}})()`);
    await sleep(120);
    const narrow = await b.evalIn(`(function(){var d=document.documentElement,w=innerWidth,inside=function(sel){var r=document.querySelector(sel).getBoundingClientRect();return r.left>=0&&r.right<=w&&r.bottom<=innerHeight;};
      var words=Array.from(document.querySelectorAll('#presets .word')).map(function(x){var r=x.getBoundingClientRect();return {t:Math.round(r.top),r:r.right};});
      return {page:d.scrollWidth,lines:new Set(words.map(function(x){return x.t;})).size,modes:inside('#mode-grid'),search:inside('#search-box'),wordsIn:words.every(function(x){return x.r<=w;}),bins:inside('#do-bins'),label:inside('#do-label'),more:inside('#more'),source:inside('#source'),verdict:document.getElementById('foot-verdict').scrollWidth<=document.getElementById('foot-verdict').clientWidth,table:document.getElementById('grid').scrollWidth,grid:document.getElementById('grid').clientWidth,head:document.getElementById('top').scrollWidth};})()`);
    check('at 620 px nothing leaves the panel: the sort row is one line, the foot and the header stay whole', narrow.page <= 620 && narrow.lines === 1 && narrow.modes && narrow.search && narrow.wordsIn && narrow.bins && narrow.label && narrow.more && narrow.source && narrow.verdict && narrow.head <= 620, narrow);
    check('at 620 px the table scrolls inside itself', narrow.table >= narrow.grid, narrow);
    await b.shot('19-620-light');
    await b.size(900, 620);
    await sleep(100);

    // -------- motion
    await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const still = await b.evalIn(`({spin:getComputedStyle(document.querySelector('#foot-mark .m-arc')).animationName,fade:getComputedStyle(document.getElementById('foot')).transitionDuration})`);
    check('prefers-reduced-motion: the arc stands still and nothing fades', still.spin === 'none' && /^0s/.test(still.fade), still);
    await b.evalIn(`document.querySelector('#presets [data-id="shoot"]').click()`);
    check('prefers-reduced-motion: new foot words arrive without a fade', (await b.evalIn(`document.getElementById('foot-verdict').getAnimations().length`)) === 0);
    await b.send('Emulation.setEmulatedMedia', { features: [] });
    await b.evalIn(`document.querySelector('#presets [data-id="colour"]').click()`);
    check('new foot words fade in', (await b.evalIn(`document.getElementById('foot-verdict').getAnimations().length`)) === 1);
    await b.evalIn(`document.querySelector('#presets [data-id="shoot"]').click()`);
    const box = await b.evalIn(`(function(){var r=document.getElementById('do-bins').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(140);
    const pressed = await b.evalIn(`getComputedStyle(document.getElementById('do-bins')).transform`);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 300, y: box.y - 300, button: 'left', clickCount: 1 });
    check('a pressed button scales to 0.97', /matrix\(0\.97/.test(pressed), pressed);
    const radius = await b.evalIn(`getComputedStyle(document.getElementById('do-bins')).borderRadius`);
    check('buttons have a radius of 7', radius === '7px', radius);

    // -------- colour discipline, on the finished panel and on the sheets
    const cobalts = await b.evalIn(`(function(){var c=[getComputedStyle(document.documentElement).getPropertyValue('--cobalt')],hits=[];document.querySelectorAll('body *').forEach(function(e){if(e.closest('[hidden]')){return;}var s=getComputedStyle(e);if(s.backgroundColor==='rgb(47, 111, 230)'||s.color==='rgb(47, 111, 230)'){hits.push(e.id||e.className);}});return hits;})()`);
    check('cobalt is on the primary action only', cobalts.join() === 'do-bins', cobalts);

    // -------- search, the three stages, the grid, colour, groups and failures of Tier 2
    await b.evalIn(`__mock.skin={red:35,green:35,blue:35};__mock.listeners['com.adobe.csxs.events.ThemeColorChanged'].forEach(function(f){f();});SelectApp.setMode('list')`);
    await b.evalIn(`document.getElementById('clear-view').click()`);
    await setItems(b, 400);

    // stage three, live: rows usable, writes usable, the foot calm
    b.engineEnv.FAKE_DELAY_MS = '3';
    await b.click('#source button[data-src="project"]');
    await pressScan(b);
    await b.waitFor(`SelectApp.state.scan.handle&&document.getElementById('foot').className==='understanding'`, 'stage three', 30000);
    const stage = await footNow();
    const menuWait = await (async () => { await b.click('#presets [data-group="people"]'); const t = await b.evalIn(`Array.from(document.querySelectorAll('#sort-menu button')).map(function(x){return x.textContent;})`); await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); return t; })();
    const legible = await b.evalIn(`(function(){var el=document.getElementById('foot-sentence');return {anims:el.getAnimations().length,opacity:getComputedStyle(el).opacity,w:el.getBoundingClientRect().width};})()`);
    check('the stage-three count changes in place, legible, with no fade restarting', legible.anims === 0 && legible.opacity === '1' && legible.w > 100, legible);
    check('stage three: the foot says it is still looking closer, and the writes work', /^Still looking closer, on this Mac: \d+ of 392$/.test(stage.sentence) && stage.mark === 'running' && stage.actions.join() === 'stop,do-label,do-columns,do-bins*', stage);
    check('the group menu counts what has landed so far', menuWait.length === 7 && menuWait.some(t => /^People\d+$/.test(t)), menuWait);
    await b.evalIn(`document.querySelector('#presets [data-id="colour"]').click()`);
    await sleep(120);
    const holding = await b.evalIn(`({bins:document.getElementById('do-bins').disabled,label:document.getElementById('do-label').disabled,columns:document.getElementById('do-columns').disabled,shown:!document.getElementById('do-bins').hidden,why:document.getElementById('status-unread').textContent,title:document.getElementById('do-bins').title,running:!!SelectApp.state.scan.handle})`);
    check('in stage three, a Colour write waits: visible, off, with a plain reason', holding.running && holding.shown && holding.bins && holding.label && holding.columns && /^Colour needs every clip looked at/.test(holding.why) && holding.why.startsWith(holding.title), holding);
    await b.shot('35-stage-three-waiting');
    await b.evalIn(`__mock.calls.length=0`);
    await b.evalIn(`document.getElementById('do-bins').disabled=false`);
    await b.click('#do-bins');
    await sleep(80);
    check('even forced, a held write refuses before any sheet or host call', !(await modalOpen()) && (await b.evalIn(`__mock.calls.filter(function(c){return c.fn!=='status';}).length`)) === 0 && /needs every clip/.test(await noteText()));
    await b.waitFor(`!document.getElementById('do-bins').disabled`, 'writes turn on by themselves', 30000);
    const turned = await b.evalIn(`({clicked:__mock.calls.length,landed:SelectCore.understandingShare(SelectApp.state.store).landed||!SelectApp.state.scan.handle})`);
    check('and turns on by itself once every clip has landed', turned.landed, turned);
    await b.waitFor(`SelectApp.state.scan.state==='Done'`, 'done', 30000);
    await b.evalIn(`document.getElementById('clear-view').click()`);

    // a Tier 1 write in stage three works, and Add Columns writes only Tier 1 fields
    await pressScan(b);
    await b.waitFor(`SelectApp.state.scan.handle&&document.getElementById('foot').className==='understanding'`, 'stage three again', 30000);
    await b.evalIn(`document.querySelector('#presets [data-id="shoot"]').click()`);
    await sleep(80);
    check('a Tier 1 sort writes during stage three', !(await b.evalIn(`document.getElementById('do-bins').disabled||document.getElementById('do-columns').disabled`)));
    await b.evalIn(`__mock.calls.length=0`);
    await b.click('#do-columns');
    await waitModal();
    const earlySheet = await dialogText();
    await b.click('#dialog-ok');
    await b.waitFor(`__mock.calls.some(function(c){return c.fn==='columns';})`);
    const earlyCols = (await calls('columns'))[0].args;
    check('Add Columns in stage three writes the 6 Tier 1 fields and says the rest come later', earlyCols.fields.length === 6 && !earlyCols.fields.some(f => f.name === 'SelectColour') && /Adds 6 columns/.test(earlySheet) && /The other 7/.test(earlySheet), earlyCols.fields.map(f => f.name));
    await b.waitFor(`SelectApp.state.scan.state==='Done'`, 'done', 30000);
    await b.evalIn(`SelectApp.state.outcome=null;document.getElementById('clear-view').click()`);
    await b.evalIn(`document.getElementById('clear-view').click()`);

    // search, real keystrokes
    await b.click('#search');
    await b.send('Input.insertText', { text: 'bread' });
    await b.waitFor(`SelectApp.state.query==='bread'`);
    const found = await b.evalIn(`({shown:SelectApp.state.order.length,count:document.getElementById('search-count').textContent,why:document.querySelector('#body .r .why').textContent,foot:document.getElementById('foot-sentence').textContent})`);
    check('search narrows, says how many, and shows why a clip is there', found.shown > 0 && found.shown < 400 && found.count === `${found.shown} of 400` && found.why === 'bread' && new RegExp(`^${found.shown} of 400 clips match`).test(found.foot), found);
    await b.send('Input.insertText', { text: ' sony' });
    await b.waitFor(`SelectApp.state.query==='bread sony'`);
    check('a second word narrows further', (await b.evalIn(`SelectApp.state.order.length`)) < found.shown, await b.evalIn(`document.getElementById('search-count').textContent`));
    await b.send('Input.insertText', { text: ' zzz' });
    await b.waitFor(`/Nothing matches/.test(document.getElementById('empty-words').textContent)`);
    check('an empty search says so in plain words, with a way back', (await b.evalIn(text('empty-words'))) === 'Nothing matches “bread sony zzz”.' && !(await b.evalIn(`document.getElementById('empty-clear').hidden`)));
    await b.shot('30-search-empty');
    await b.click('#empty-clear');
    check('Clear search puts every clip back', (await b.evalIn(`SelectApp.state.order.length`)) === 400 && (await b.evalIn(`document.getElementById('search').value`)) === '');

    // the grid
    await pressPreset(b, 'softest');
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
    const sel = await b.evalIn(`({n:SelectApp.state.selected.size,cls:document.querySelectorAll('#tiles .t.sel').length,ring:getComputedStyle(document.querySelector('#tiles .t.sel .pic')).boxShadow,foot:document.getElementById('foot-sentence').textContent})`);
    check('click, shift-click and cmd-click select tiles, with a grey ring, never cobalt', sel.n === 4 && sel.cls === 4 && !/47, 111, 230/.test(sel.ring) && /^4 of 400 clips selected/.test(sel.foot), sel);
    await b.click('#mode-list');
    check('a selection made in the grid is the selection in the list', (await b.evalIn(`document.querySelectorAll('#body .r.sel').length`)) === 4);
    await b.click('#mode-grid');
    await b.evalIn(`__mock.calls.length=0`);
    await b.click('#do-label');
    await waitModal();
    await b.click('#dialog-ok');
    await b.waitFor(`/Labelled 4 clips/.test(${text('foot-verdict')})`);
    const fromGrid = (await calls('label'))[0].args;
    check('a write from the grid covers exactly the selected tiles', fromGrid.ids.length === 4, fromGrid.ids);
    await b.evalIn(`SelectApp.state.selected.clear();SelectApp.state.outcome=null;SelectApp.applyView();__mock.calls.length=0`);
    await b.click(tile(2), { count: 2 });
    await b.waitFor(`__mock.calls.some(function(c){return c.fn==='open';})`);
    check('double-clicking a tile opens the clip', /^id\d+$/.test((await calls('open'))[0].args.id));
    await b.evalIn(`SelectApp.state.selected.clear();SelectApp.applyView()`);

    // colour in the grid
    await pressPreset(b, 'colour');
    const rainbow = await b.evalIn(`(function(){var r=${ids},keys=r.map(function(x){return x.rainbow;}).filter(function(k){return typeof k==='number';}),up=keys.every(function(k,i){return !i||keys[i-1]<=k;}),first=r[0].colorName,lastHue=keys.filter(function(k){return k<800;}).length,neutral=r.filter(function(x){return x.colorName==='neutral';}).length;return {up:up,first:first,hued:lastHue,neutral:neutral,chips:!document.querySelector('#tiles .t[data-at="0"] .p').hidden,fact:document.querySelector('#tiles .t[data-at="0"] .f').hidden};})()`);
    check('Colour sorts by hue from red, neutrals after, blanks last, and tiles show their palette', rainbow.up && rainbow.first === 'red' && rainbow.hued > 200 && rainbow.neutral > 10 && rainbow.chips && rainbow.fact, rainbow);
    await b.click('#families [data-family="teal"]');
    const teal = await b.evalIn(`({n:SelectApp.state.order.length,all:${ids}.every(function(r){return r.colorName==='teal';}),verdict:document.getElementById('foot-verdict').textContent,dot:document.querySelector('#families [data-family="teal"]').classList.contains('on')})`);
    check('a colour family filters, in the grid, with its dot on', teal.n > 5 && teal.all && teal.verdict === 'Teal, colour' && teal.dot, teal);
    await b.evalIn(`__mock.calls.length=0`);
    await b.click('#do-bins');
    await waitModal();
    const tealSheet = await dialogText();
    await b.click('#dialog-ok');
    await b.waitFor(`/Sorted into 1 bin/.test(${text('foot-verdict')})`);
    await sleep(320);
    const tealBins = (await calls('bins'))[0].args;
    check('Sort into Bins by category names the bins, reads back, and goes green', /01 Teal/.test(tealSheet) && tealBins.buckets[0].name === '01 Teal' && tealBins.buckets[0].ids.length === teal.n && (await footNow()).background === GREEN, tealBins.buckets.map(x => x.name));
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
    check('every family has its bin, in rainbow order, and a stray is not green', /01 Red[\s\S]*02 Orange[\s\S]*09 Neutral[\s\S]*10 No value/.test(rainbowSheet) && (await footNow()).background !== GREEN, (await footNow()).verdict);
    await b.evalIn(`__mock.misplaced=0;SelectApp.state.outcome=null;SelectApp.applyView()`);

    // groups, in both views, arriving last
    b.engineEnv.FAKE_DELAY_MS = '4';
    await pressPreset(b, 'similar');
    await pressScan(b);
    await b.waitFor(`SelectApp.state.scan.handle&&SelectApp.state.store.tier1>50`, 'scan under way', 30000);
    const waiting = await b.evalIn(`({text:document.getElementById('empty-words').textContent,hidden:document.getElementById('empty').hidden})`);
    check('Similar shots waits in plain words until the line arrives', !waiting.hidden && /arrive last/.test(waiting.text), waiting);
    await b.waitFor(`SelectApp.state.scan.state==='Done'&&SelectApp.state.order.length>0`, 'groups', 30000);
    await sleep(120);
    const grouped = await b.evalIn(`({heads:Array.from(document.querySelectorAll('#tiles .gh')).filter(function(h){return !h.hidden;}).map(function(h){return h.textContent;}),count:SelectApp.state.groupCount,top:document.querySelector('#tiles .gh').style.top,foot:document.getElementById('foot-sentence').textContent})`);
    const shelves = await b.evalIn(`(function(){var h=SelectApp.state.L.heads;return {same:h[0].y===h[1].y,x:h[1].x>0};})()`);
    check('groups land last and show as groups in the grid, packed along shelves', grouped.count > 5 && grouped.heads[0] === 'Group 1 · 3 clips' && /groups, /.test(grouped.foot) && shelves.same && shelves.x, grouped);
    await b.shot('32-grid-groups');
    await b.click('#mode-list');
    await sleep(100);
    const listed = await b.evalIn(`Array.from(document.querySelectorAll('#body .gh')).filter(function(h){return !h.hidden;}).map(function(h){return h.textContent;})`);
    check('and as groups in the list, with no sideways scroll', listed[0] === 'Group 1 · 3 clips' && listed.length > 1 && (await b.evalIn(`document.getElementById('grid').scrollWidth<=document.getElementById('grid').clientWidth`)), listed.slice(0, 3));
    await b.shot('33-list-groups');
    await pressPreset(b, 'similar');

    // what Tier 2 can do wrong
    b.engineEnv.FAKE_DELAY_MS = '0';
    b.engineEnv.FAKE_TIER2 = 'fail';
    await scanAndWait(b);
    const t2Fail = await b.evalIn(`({failed:SelectApp.state.store.tier2Failed,errors:SelectApp.state.store.errors,foot:document.getElementById('status-unread').textContent,kept:SelectApp.state.store.rows.filter(function(r){return r.notUnderstood&&r.tier===1&&typeof r.luma==='number';}).length})`);
    check('a Tier 2 failure leaves the clip whole, and says so once', t2Fail.failed > 5 && t2Fail.errors === 8 && t2Fail.kept > 0 && /could not be looked at more closely/.test(t2Fail.foot), t2Fail);
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
    await pressPreset(b, 'closeups');
    const noData = await b.evalIn(`({text:document.getElementById('empty-words').textContent,foot:document.getElementById('foot-sentence').textContent})`);
    check('a sort on data no clip has says so plainly, not an empty table', /No clip has shot size data/.test(noData.text) && /No clip has shot size data/.test(noData.foot), noData);
    await b.click('#presets [data-group="people"]');
    const noHint = await b.evalIn(`document.querySelector('#sort-menu [data-id="closeups"] span').textContent`);
    check('the group menu says no data', noHint === 'no data', noHint);
    await b.click('#sort-menu [data-id="closeups"]');
    b.engineEnv.FAKE_TIER2 = '';

    // 1,000 clips: search, sort and scroll in the grid
    await setItems(b, 1000);
    await b.click('#mode-grid');
    await scanAndWait(b);
    await sleep(300);
    const search1000 = [];
    await b.click('#search');
    for (const ch of 'bread water') {
      await b.send('Input.insertText', { text: ch });
      await b.waitFor(`SelectApp.state.query.slice(-1)===${JSON.stringify(ch)}`);
      search1000.push(await b.evalIn('SelectApp.state.searchMs'));
    }
    await b.evalIn(`document.getElementById('search').value='';document.getElementById('search').dispatchEvent(new Event('input'))`);
    const worstSearch = Math.max(...search1000), meanSearch = search1000.reduce((x, y) => x + y, 0) / search1000.length;
    check('search at 1,000 clips, each keystroke with repaint, 16 ms or less', worstSearch <= 16, `worst ${worstSearch.toFixed(1)} ms, mean ${meanSearch.toFixed(1)} ms over ${search1000.length} keystrokes`);
    const gridSorts = [];
    for (const id of ['colour', 'softest', 'people', 'shoot', 'shakiest', 'colour']) {
      await b.evalIn(`SelectApp.state.sortMs=null`);
      await pressPreset(b, id);
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
    const narrowGrid = await b.evalIn(`(function(){var r=document.querySelector('#tiles .t').getBoundingClientRect(),g=document.getElementById('grid'),cols=SelectApp.state.L.cols,last=document.querySelector('#tiles .t[data-at="'+(cols-1)+'"]').getBoundingClientRect();return {cols:cols,w:Math.round(r.width),over:g.scrollWidth-g.clientWidth,right:last.right,page:document.documentElement.scrollWidth,sortLines:document.getElementById('presets').getBoundingClientRect().height};})()`);
    check('the grid fits 620 px with no sideways scroll, and the sort row stays one line', narrowGrid.cols >= 3 && narrowGrid.over === 0 && narrowGrid.right <= 620 && narrowGrid.page <= 620 && narrowGrid.sortLines <= 20, narrowGrid);
    await b.evalIn(`__mock.skin={red:230,green:230,blue:230};__mock.listeners['com.adobe.csxs.events.ThemeColorChanged'].forEach(function(f){f();})`);
    await sleep(100);
    await b.shot('34-grid-620-light');
    const lightGrid = await b.evalIn(`({caption:getComputedStyle(document.querySelector('#tiles .t .n')).color,bg:getComputedStyle(document.getElementById('grid')).backgroundColor})`);
    check('the grid follows the light theme of Premiere', lightGrid.caption === 'rgb(29, 29, 31)' && lightGrid.bg === 'rgb(255, 255, 255)', lightGrid);
    await b.size(900, 620);
    await b.evalIn(`__mock.skin={red:35,green:35,blue:35};__mock.listeners['com.adobe.csxs.events.ThemeColorChanged'].forEach(function(f){f();});SelectApp.setMode('list')`);
    await setItems(b, 400);
    await b.evalIn(`document.getElementById('clear-view').click()`);

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
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length} checks, ${failed.length} failed`);
  failed.forEach(f => console.log('  FAILED ' + f.name));
  process.exit(failed.length ? 1 : 0);
}

if (require.main === module) { main(); }

module.exports = { pressPreset, launch, setItems, clips, scanAndWait, pressScan, setDeadline, stopEverything, fixture, sleep, foot, OUT };
