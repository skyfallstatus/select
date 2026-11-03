// node --test test/unit.test.js : core logic, foot states, engine process handling, write lock and folder walk, against the fake engine.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../client/core.js');
const N = require('../client/native.js');

const FAKE = path.join(__dirname, 'fake-engine.js');
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/clips.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const fixturePaths = fixture.map(r => r.path);
const unreadable = fixture.filter(r => r.error).length;

function storeFromFixture(records) {
  const s = C.createStore();
  C.addItems(s, records.map(r => ({ path: r.path, id: 'id-' + r.path })));
  for (const r of records) {
    if (r.error) { C.ingest(s, { type: 'error', path: r.path, message: r.error }); continue; }
    C.ingest(s, { type: 'clip', tier: 0, path: r.path, cached: false, ms: 1, ...r.tier0 });
    C.ingest(s, { type: 'clip', tier: 1, path: r.path, cached: false, ms: 1, ...r.tier1 });
    C.ingest(s, { type: 'clip', tier: 2, path: r.path, cached: false, ms: 1, ...r.tier2 });
  }
  return s;
}

function byOrder(rows, order) { return order.map(i => rows[i]); }

function run(env, paths, extra) {
  return new Promise(resolve => {
    const lines = [], bad = [];
    Object.assign(process.env, { FAKE_DELAY_MS: '', FAKE_MODE: '', FAKE_ERRORS: '' }, env);
    const handle = N.runEngine(FAKE, paths, {
      onMessage: m => { lines.push(m); if (extra && extra.onMessage) { extra.onMessage(m, handle); } },
      onBad: l => bad.push(l),
      onExit: info => resolve({ lines, bad, info, handle })
    });
  });
}

test('parser: any chunking gives the same lines', () => {
  const text = '{"a":1}\n{"b":"café"}\r\n\n{"c":3}\n';
  for (let size = 1; size < text.length; size++) {
    const got = [];
    const p = new C.JsonlParser(m => got.push(m), () => assert.fail('bad'));
    for (let i = 0; i < text.length; i += size) { p.push(text.slice(i, i + size)); }
    p.flush();
    assert.deepStrictEqual(got, [{ a: 1 }, { b: 'café' }, { c: 3 }]);
  }
});

test('parser: bad lines are reported and do not stop it; a tail without newline is flushed', () => {
  const got = [], bad = [];
  const p = new C.JsonlParser(m => got.push(m), l => bad.push(l));
  p.push('{"a":1}\nnot json\n{"b":2}');
  assert.equal(got.length, 1);
  p.flush();
  assert.equal(got.length, 2);
  assert.deepStrictEqual(bad, ['not json']);
});

test('store: rows exist before the engine speaks; lines merge by path; accents merge across Unicode forms', () => {
  const s = C.createStore();
  const nfd = '/m/café.mp4', nfc = '/m/café.mp4';
  C.addItems(s, [{ path: nfd, id: 'a' }, { path: nfd, id: 'b' }, { path: '/m/two.mov' }]);
  assert.equal(s.rows.length, 2);
  assert.deepStrictEqual(s.rows[0].ids, ['a', 'b']);
  assert.equal(s.rows[0].tier, -1);
  C.ingest(s, { type: 'clip', tier: 0, path: nfc, durationS: 3, width: 10, height: 20, createdAt: null });
  C.ingest(s, { type: 'clip', tier: 1, path: nfc, sharpness: null, luma: 0.5 });
  assert.equal(s.rows.length, 2);
  assert.equal(s.rows[0].durationS, 3);
  assert.equal(s.rows[0].sharpness, null);
  assert.equal(s.rows[0].luma, 0.5);
  assert.equal(s.rows[0].tier, 1);
  assert.equal(s.rows[0].pixels, 200);
  C.ingest(s, { type: 'error', path: '/m/two.mov', message: 'boom' });
  assert.equal(s.rows[1].error, 'boom');
  C.ingest(s, { type: 'clip', tier: 0, path: '/m/unknown.mp4', durationS: 1 });
  assert.equal(s.rows.length, 3, 'a line for an unlisted path is kept, not dropped');
});

test('format: null is an empty cell, never 0; 0 stays 0', () => {
  const row = { name: 'x', sharpness: null, luma: 0, clipHighPct: null, clipLowPct: 0, motionProxy: undefined, audioDb: null, durationS: null, createdAt: null, camera: null, width: null };
  const text = k => C.cellText(row, C.COLUMN[k]);
  assert.equal(text('sharpness'), '');
  assert.equal(text('clipHighPct'), '');
  assert.equal(text('motionProxy'), '');
  assert.equal(text('audioDb'), '');
  assert.equal(text('durationS'), '');
  assert.equal(text('createdAt'), '');
  assert.equal(text('camera'), '');
  assert.equal(text('pixels'), '');
  assert.equal(text('luma'), '0.00');
  assert.equal(text('clipLowPct'), '0.00');
  assert.equal(C.fmtDuration(65.25), '1:05.3');
  assert.equal(C.fmtDuration(3725), '1:02:05.0');
  assert.equal(C.cellText({ width: 3840, height: 2160 }, C.COLUMN.pixels), '3840x2160');
  assert.equal(C.cellText({ createdAt: '2023-11-02T16:45:07.000000Z' }, C.COLUMN.createdAt), '2023-11-02 16:45');
});

test('sort: nulls last in both directions, secondary keys, stable', () => {
  const rows = [
    { name: 'C10', sharpness: 0.5, luma: 0.2, time: NaN },
    { name: 'C2', sharpness: null, luma: 0.9, time: 5 },
    { name: 'C1', sharpness: 0.5, luma: 0.1, time: 3 },
    { name: 'c3', sharpness: 0.9, luma: null, time: NaN },
    { name: null, sharpness: 0, luma: 0, time: 1 }
  ];
  const run = spec => C.sortOrder(rows, [0, 1, 2, 3, 4], spec);
  assert.deepStrictEqual(run([{ key: 'sharpness', dir: 1 }]), [4, 0, 2, 3, 1]);
  assert.deepStrictEqual(run([{ key: 'sharpness', dir: -1 }]), [3, 0, 2, 4, 1]);
  assert.deepStrictEqual(run([{ key: 'sharpness', dir: -1 }, { key: 'luma', dir: 1 }]), [3, 2, 0, 4, 1]);
  assert.deepStrictEqual(run([{ key: 'name', dir: 1 }]), [2, 1, 3, 0, 4], 'numeric, case-insensitive, null last');
  assert.deepStrictEqual(run([{ key: 'name', dir: -1 }]), [0, 3, 1, 2, 4], 'null still last');
  assert.deepStrictEqual(run([{ key: 'createdAt', dir: 1 }]), [4, 2, 1, 0, 3]);
});

test('header clicks: click sorts, click again flips, shift adds, shift again flips that key', () => {
  let s = C.nextSort([], 'sharpness', false);
  assert.deepStrictEqual(s, [{ key: 'sharpness', dir: -1 }]);
  s = C.nextSort(s, 'sharpness', false);
  assert.deepStrictEqual(s, [{ key: 'sharpness', dir: 1 }]);
  s = C.nextSort(s, 'luma', true);
  assert.deepStrictEqual(s, [{ key: 'sharpness', dir: 1 }, { key: 'luma', dir: -1 }]);
  s = C.nextSort(s, 'luma', true);
  assert.deepStrictEqual(s[1], { key: 'luma', dir: 1 });
  s = C.nextSort(s, 'name', false);
  assert.deepStrictEqual(s, [{ key: 'name', dir: 1 }]);
});

test('re-sort of 1,000 rows, every column, stays inside 16 ms (Node)', () => {
  const recs = [];
  for (let i = 0; i < 1000; i++) { const r = fixture[i % fixture.length]; recs.push({ ...r, path: r.path + '.' + i }); }
  const s = storeFromFixture(recs);
  let worst = 0, worstKey = '';
  for (const c of C.COLUMNS) {
    if (c.sortable === false) { continue; }
    for (const dir of [1, -1]) {
      const t0 = performance.now();
      const v = C.computeView(s.rows, { sort: [{ key: c.key, dir }, { key: 'name', dir: 1 }], preset: null });
      const ms = performance.now() - t0;
      assert.equal(v.order.length, 1000);
      if (ms > worst) { worst = ms; worstKey = c.key; }
    }
  }
  console.log(`  worst ${worst.toFixed(2)} ms on ${worstKey}`);
  assert.ok(worst <= 16, `worst sort ${worst} ms on ${worstKey}`);
});

test('presets on the synthetic fixture', () => {
  const s = storeFromFixture(fixture), rows = s.rows;
  const view = id => {
    const r = C.computeView(rows, { sort: C.PRESET[id].sort, preset: id });
    return { ...r, list: byOrder(rows, r.order) };
  };
  const ascending = (list, key) => { const v = list.map(r => r[key]).filter(x => x !== null && x !== undefined); return v.every((x, i) => !i || v[i - 1] <= x); };
  const descending = (list, key) => { const v = list.map(r => r[key]).filter(x => x !== null && x !== undefined); return v.every((x, i) => !i || v[i - 1] >= x); };
  const nullsLast = (list, key) => { const n = list.map(r => r[key] === null || r[key] === undefined); return n.lastIndexOf(false) < (n.indexOf(true) === -1 ? Infinity : n.indexOf(true)); };

  assert.ok(ascending(view('softest').list, 'sharpness') && nullsLast(view('softest').list, 'sharpness'));
  assert.ok(descending(view('sharpest').list, 'sharpness'));
  assert.ok(ascending(view('darkest').list, 'luma'));
  assert.ok(descending(view('overexposed').list, 'clipHighPct'));
  assert.ok(descending(view('motion').list, 'motionProxy'));
  assert.ok(ascending(view('static').list, 'motionProxy'));

  const silent = view('silent').list;
  assert.ok(silent.length > 0 && silent.length < rows.length);
  assert.ok(silent.every(r => r.hasAudio === false || r.silent === true));
  assert.equal(silent.length, rows.filter(r => r.hasAudio === false || r.silent === true).length);

  const iv = view('interviews').list;
  assert.ok(iv.length > 0);
  const shakes = rows.map(r => r.shake).filter(v => typeof v === 'number').sort((a, b) => a - b);
  const limit = shakes[Math.ceil(shakes.length * 0.6) - 1];
  assert.ok(iv.every(r => r.speech === true && r.faces > 0 && (typeof r.shake !== 'number' || r.shake <= limit)), 'speech, a face, and steady when shake is known');
  assert.ok(iv.some(r => r.shake === null), 'an unknown shake does not rule a clip out');
  assert.ok(descending(iv, 'durationS'));

  const dup = view('duplicates');
  assert.ok(dup.groupCount > 0);
  assert.ok(dup.list.every(r => r.dupGroup !== null));
  for (let g = 1; g <= dup.groupCount; g++) {
    const members = dup.list.filter(r => r.dupGroup === g);
    assert.ok(members.length >= 2);
    assert.ok(descending(members, 'sharpness'), 'sharpest first in a group');
  }
  const shoot = view('shoot').list;
  const stamps = shoot.map(r => r.time).filter(t => !isNaN(t));
  assert.ok(stamps.every((t, i) => !i || stamps[i - 1] <= t));
  assert.ok(isNaN(shoot[shoot.length - 1].time), 'undated clips last');

  // Leaving a preset leaves nothing behind: the plain view has every row and no group numbers.
  const plain = C.computeView(rows, { sort: [], preset: null });
  assert.equal(plain.order.length, rows.length);
  assert.ok(rows.every(r => r.dupGroup === null));
});

test('presets stay honest: relative words, no verdicts, every tip says what it measures', () => {
  for (const p of C.PRESETS) {
    assert.ok(p.tip.length > 40, p.id);
    assert.ok(p.says, p.id);
    assert.ok(!/\b(bad|blurry|out of focus|unusable|ruined|best|better|worst|good|nice|quality)\b/i.test(p.tip + p.label + p.says), p.id);
  }
  for (const c of C.COLUMNS) {
    assert.ok(!/\b(bad|blurry)\b/i.test((c.tip || '') + (c.words || []).join(' ')), c.key);
  }
});

test('hamming and near-duplicate groups', () => {
  assert.equal(C.hamming('0000000000000000', '0000000000000000'), 0);
  assert.equal(C.hamming('ffffffffffffffff', '0000000000000000'), 64);
  assert.equal(C.hamming('8000000000000001', '0000000000000000'), 2);
  assert.equal(C.hamming(null, '00'), null);
  const rows = [
    { dhash: 'ffffffff00000000' }, { dhash: 'ffffffff000000ff' }, { dhash: '00000000ffffffff' }, { dhash: null }, { dhash: 'not hex' },
    { dhash: '00000000fffffff0' }, { dhash: 'aaaaaaaaaaaaaaaa' }
  ];
  assert.deepStrictEqual(C.nearDuplicateGroups(rows, 8), [[0, 1], [2, 5]]);
  assert.deepStrictEqual(C.nearDuplicateGroups(rows, 0), []);
  const chain = [{ dhash: '0000000000000000' }, { dhash: '00000000000000ff' }, { dhash: '000000000000ffff' }];
  assert.deepStrictEqual(C.nearDuplicateGroups(chain, 8), [[0, 1]], 'no chaining through the second clip');
});

test('bins: quintiles of the active sort, words follow direction, no value kept apart, every row once', () => {
  const s = storeFromFixture(fixture);
  const view = { sort: [{ key: 'sharpness', dir: -1 }], preset: null };
  const v = C.computeView(s.rows, view);
  const list = byOrder(s.rows, v.order);
  const b = C.bucketize(list, view);
  assert.equal(b[0].name, '01 Sharpest');
  assert.equal(b[4].name, '05 Softest');
  assert.equal(b.reduce((n, x) => n + x.rows.length, 0), list.length);
  assert.ok(b.slice(0, 5).every(x => Math.abs(x.rows.length - b[0].rows.length) <= 1));
  assert.ok(Math.min(...b[0].rows.map(r => r.sharpness)) >= Math.max(...b[4].rows.map(r => r.sharpness)));
  const up = C.bucketize(list, { sort: [{ key: 'sharpness', dir: 1 }], preset: null });
  assert.equal(up[0].name, '01 Softest');
  const empties = C.bucketize([{ name: 'a', sharpness: null }, { name: 'b', sharpness: 0.2 }], view);
  assert.deepStrictEqual(empties.map(x => x.name), ['01 Sharpest', '06 No value']);
  assert.equal(C.bucketize(list, { sort: [], preset: null }), null);
  assert.equal(C.bucketize(list, { sort: [{ key: 'camera', dir: 1 }], preset: null })[0].name, '01 First fifth');
  const dv = { sort: C.PRESET.duplicates.sort, preset: 'duplicates' };
  const d = C.computeView(s.rows, dv);
  const dups = C.bucketize(byOrder(s.rows, d.order), dv);
  assert.equal(dups.length, d.groupCount);
  assert.match(dups[0].name, /^001 Group of \d+$/);
  assert.equal(C.sortName({ sort: [{ key: 'luma', dir: 1 }], preset: null }), 'Darkest first');
  assert.equal(C.sortName({ sort: [{ key: 'sharpness', dir: 1 }], preset: null }), 'Softest first');
  assert.equal(C.sortName({ sort: [{ key: 'camera', dir: 1 }], preset: null }), 'Camera A to Z');
  assert.equal(C.sortName(dv), 'Near duplicates');
});

test('column values: text order equals number order, and null stays empty', () => {
  const s = storeFromFixture(fixture);
  const checks = { SelectLuma: 'luma', SelectSharpness: 'sharpness', SelectClipHigh: 'clipHighPct', SelectMotion: 'motionProxy', SelectAudio: 'audioDb' };
  for (const [field, key] of Object.entries(checks)) {
    const pairs = s.rows.filter(r => r[key] !== null && r[key] !== undefined).map((r, i) => [r[key], C.columnValues(r, i + 1, 4)[field]]);
    assert.ok(pairs.length > 10, field);
    assert.equal(new Set(pairs.map(p => p[1].length)).size, 1, field + ' has one width');
    const lexical = pairs.slice().sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(p => p[0]);
    assert.ok(lexical.every((v, i) => !i || lexical[i - 1] <= v + 1e-3), field + ' sorts as a number');
  }
  const v = C.columnValues({ sharpness: null, luma: null, clipHighPct: null, motionProxy: null, audioDb: null }, 7, 4);
  assert.deepStrictEqual(v, { SelectRank: '0007', SelectSharpness: '', SelectLuma: '', SelectClipHigh: '', SelectMotion: '', SelectAudio: '', SelectPeople: '', SelectFaces: '', SelectShot: '', SelectColour: '', SelectSound: '', SelectLabels: '', SelectText: '' });
  const full = C.columnValues({ people: 12, faces: 0, shotSize: 'closeup', colorName: 'teal', sounds: [{ name: 'speech', conf: 1 }, { name: 'wind', conf: .5 }], labels: [{ name: 'oven', conf: .9 }], text: ['Fresh today'] }, 1, 4);
  assert.deepStrictEqual([full.SelectPeople, full.SelectFaces, full.SelectShot, full.SelectColour, full.SelectSound, full.SelectLabels, full.SelectText], ['012', '000', 'Close-up', 'Teal', 'speech, wind', 'oven', 'Fresh today']);
  assert.equal(C.columnValues({ audioDb: -9 }, 1, 4).SelectAudio, '091.0');
  assert.equal(C.columnValues({ audioDb: -30 }, 1, 4).SelectAudio, '070.0');
  assert.equal(C.columnValues({ clipHighPct: 12.5 }, 1, 4).SelectClipHigh, '012.50');
});

test('host call text is pure ASCII and survives quoting', () => {
  const args = { paths: ['/Volumes/Field SSD/Crème Brûlée "A"/Ć\\x.mp4'], n: 1 };
  const call = C.hostCall('importClips', args);
  assert.ok(/^[\x00-\x7e]*$/.test(call));
  let seen;
  const slCall = (fn, json) => { seen = [fn, JSON.parse(json)]; };   // eslint-disable-line no-unused-vars
  eval(call);
  assert.deepStrictEqual(seen, ['importClips', args]);
});

test('sources: video only, no AppleDouble, thumbnails get a safe URL', () => {
  assert.ok(C.isVideoPath('/a/C0001.MP4'));
  assert.ok(!C.isVideoPath('/a/._C0001.MP4'));
  assert.ok(!C.isVideoPath('/a/C0001M01.XML'));
  assert.ok(!C.isVideoPath('/a/still.jpg'));
  const f = C.videoItems([{ path: '/a/x.mov' }, { path: '/a/x.png' }, { path: '/a/bad\nname.mov' }]);
  assert.equal(f.items.length, 1);
  assert.equal(f.skipped, 2);
  assert.equal(C.fileUrl('/a b/c#1?.jpg'), 'file:///a%20b/c%231%3F.jpg');
});

test('engine: real process, 400 fixture clips, both tiers, in order', async () => {
  const r = await run({ FAKE_THUMBS: '' }, fixturePaths);
  assert.equal(r.info.code, 0);
  assert.equal(r.lines[0].type, 'start');
  assert.equal(r.lines[r.lines.length - 1].type, 'done');
  const s = C.createStore();
  C.addItems(s, fixturePaths.map(p => ({ path: p })));
  r.lines.forEach(m => C.ingest(s, m));
  assert.equal(s.tier0, 400 - unreadable);
  assert.equal(s.tier1, 400 - unreadable);
  assert.equal(s.errors, unreadable);
  assert.equal(s.rows.length, 400);
  assert.ok(s.rows.filter(row => !row.error).every(row => row.tier === 1 && row.durationS !== undefined && 'sharpness' in row));
  const blank = fixture.filter(r => r.tier1 && r.tier1.reason).length;
  assert.ok(blank > 0);
  assert.equal(s.noPicture.clips, blank);
  assert.equal(s.done.degraded, blank, 'the panel counts what the engine counted');
  assert.ok(s.rows.filter(row => row.error).every(row => row.tier === -1 && row.name));
});

test('engine: stdout cut mid-line and mid-character still parses', async () => {
  const paths = ['/Volumes/Field SSD/Crème Brûlée/été 1.mp4', '/Volumes/Field SSD/Crème Brûlée/日本語.mp4'];
  const r = await run({ FAKE_MODE: 'split' }, paths);
  assert.equal(r.bad.length, 0);
  assert.deepStrictEqual(r.lines.filter(l => l.type === 'clip').map(l => l.path).sort(), [...paths, ...paths, ...paths].sort(), 'three tiers each');
});

test('engine: junk lines are counted, error lines kept, exit 0', async () => {
  const r = await run({ FAKE_MODE: 'garbage', FAKE_ERRORS: '5' }, fixturePaths.slice(0, 20));
  assert.equal(r.info.code, 0);
  assert.equal(r.lines.filter(l => l.type === 'error').length, 4);
  assert.ok(r.bad.length >= 16);
});

test('engine: Stop ends a running scan promptly', async () => {
  const t0 = Date.now();
  const r = await run({ FAKE_DELAY_MS: '20' }, fixturePaths, { onMessage: (m, h) => { if (m.type === 'clip') { h.stop(); } } });
  assert.ok(r.info.stopped);
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(r.lines.length < 100);
});

test('engine: one that ignores SIGTERM is killed', async () => {
  const t0 = Date.now();
  const r = await run({ FAKE_DELAY_MS: '20', FAKE_MODE: 'deaf' }, fixturePaths, { onMessage: (m, h) => { if (m.type === 'clip') { h.stop(); } } });
  assert.equal(r.info.signal, 'SIGKILL');
  assert.ok(Date.now() - t0 < 4000);
});

test('engine: crash reports code and stderr; missing binary reports the path', async () => {
  const r = await run({ FAKE_MODE: 'crash' }, fixturePaths.slice(0, 20));
  assert.equal(r.info.code, 3);
  assert.match(r.info.stderr, /simulated crash/);
  assert.equal(N.engineProblem('/nonexistent/select-engine'), 'ENOENT');
  assert.equal(N.engineProblem(FAKE), null);
  const gone = await new Promise(resolve => N.runEngine('/nonexistent/select-engine', ['/a.mp4'], { onMessage() {}, onExit: resolve }));
  assert.ok(gone.error);
  assert.equal(gone.errorCode, 'ENOENT');
});

test('engine: what the foot says when it cannot run, in plain words', () => {
  const missing = C.engineFailure({ errorCode: 'ENOENT' }, 0);
  assert.match(missing.sentence, /not installed/);
  assert.match(missing.sentence, /Reinstall Select/);
  for (const errorCode of ['EACCES', 'EPERM', 'ENOEXEC', 'EBADARCH']) {
    assert.match(C.engineFailure({ errorCode }, 0).sentence, /macOS will not run .* Privacy & Security/);
  }
  assert.match(C.engineFailure({ code: null, signal: 'SIGKILL' }, 0).sentence, /macOS stopped .* Privacy & Security/, 'killed before a word: Gatekeeper, not a crash');
  assert.match(C.engineFailure({ code: null, signal: 'SIGKILL' }, 40).sentence, /quit \(SIGKILL\)\. What was read stays/);
  assert.match(C.engineFailure({ code: 3, signal: null }, 40).sentence, /quit \(code 3\)\. What was read stays/);
});

test('write lock: only with the setting, held, free, stale and unreadable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-lock-'));
  const file = path.join(dir, 'some-tool.lock.json');
  const config = { writeLockFile: file };
  assert.deepStrictEqual(N.writeLock({}), { held: false }, 'no setting, no check');
  assert.deepStrictEqual(N.writeLock({ writeLockFile: 7 }), { held: false }, 'a setting that is not a path is no setting');
  assert.deepStrictEqual(N.writeLock(config), { held: false }, 'no file, nothing held');
  fs.writeFileSync(file, JSON.stringify({ who: 'tool x', pid: process.pid, op: 'build' }));
  const held = N.writeLock(config);
  assert.equal(held.held, true);
  assert.equal(held.who, 'tool x');
  fs.writeFileSync(file, JSON.stringify({ who: 'gone', pid: 999999 }));
  assert.equal(N.writeLock(config).held, false);
  assert.equal(N.writeLock(config).stale, true);
  fs.writeFileSync(file, '{oops');
  assert.equal(N.writeLock(config).held, true, 'unreadable counts as held');
  fs.writeFileSync(file, '{"who":"no pid"}');
  assert.equal(N.writeLock(config).held, true, 'a file with no pid counts as held');
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.equal(N.writeLock(config).held, true, 'a path that cannot be read counts as held');
  fs.rmSync(dir, { recursive: true });
});

test('config: the one optional setting, which can never break the panel', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-config-'));
  const file = path.join(dir, 'config.json');
  assert.equal(N.configFile('/home/editor'), '/home/editor/Library/Application Support/com.skyfallstatus.select/config.json');
  assert.deepStrictEqual(N.readConfig(file), {}, 'absent');
  for (const junk of ['', '{oops', 'null', '[1,2]', '"text"', '7']) {
    fs.writeFileSync(file, junk);
    assert.deepStrictEqual(N.readConfig(file), {}, JSON.stringify(junk));
    assert.deepStrictEqual(N.writeLock(N.readConfig(file)), { held: false });
  }
  fs.writeFileSync(file, '{"writeLockFile":"/tmp/x.json"}');
  assert.equal(N.readConfig(file).writeLockFile, '/tmp/x.json');
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.deepStrictEqual(N.readConfig(file), {}, 'a folder in its place');
  fs.rmSync(dir, { recursive: true });
});

test('manifest: About reads the bundle version, and survives its absence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-manifest-'));
  assert.equal(N.manifestVersion(dir), null);
  fs.mkdirSync(path.join(dir, 'CSXS'));
  fs.writeFileSync(path.join(dir, 'CSXS/manifest.xml'), '<ExtensionManifest Version="12.0" ExtensionBundleVersion="1.2.3">');
  assert.equal(N.manifestVersion(dir), '1.2.3');
  fs.rmSync(dir, { recursive: true });
});

test('folder walk: recursive, video only, hidden left out, missing folder reported', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-walk-'));
  fs.mkdirSync(path.join(dir, 'a/b'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.hidden'));
  for (const f of ['a/1.mp4', 'a/b/2.MOV', 'a/._1.mp4', 'a/1M01.XML', '.hidden/3.mp4', 'note.txt']) { fs.writeFileSync(path.join(dir, f), ''); }
  const got = await new Promise(res => N.walkFolder(dir, (e, p) => res({ e, p })));
  assert.deepStrictEqual(got.p, [path.join(dir, 'a/1.mp4'), path.join(dir, 'a/b/2.MOV')]);
  const none = await new Promise(res => N.walkFolder(dir + '/nope', (e, p) => res({ e, p })));
  assert.equal(none.e.code, 'ENOENT');
  fs.rmSync(dir, { recursive: true });
});

test('pickFolder returns the chosen path, null on cancel, and an error otherwise, without touching a real dialog', () => {
  const native = require('../client/native.js');
  const run = (err, stdout, stderr) => {
    let seen = null, argv = null;
    native.pickFolder('Pick', '/definitely/not/here', (e, p) => { seen = { e, p }; },
      (bin, args, opts, cb) => { argv = args; cb(err, stdout, stderr); });
    return { seen, argv };
  };
  const ok = run(null, '/Volumes/Field SSD/Clients/\n', '');
  assert.equal(ok.seen.p, '/Volumes/Field SSD/Clients');
  assert.equal(ok.argv[ok.argv.length - 1], '');   // a start folder that does not exist is dropped
  const cancelled = run(Object.assign(new Error('x'), { code: 1 }), '', 'execution error: User canceled. (-128)');
  assert.equal(cancelled.seen.e, null);
  assert.equal(cancelled.seen.p, null);
  const failed = run(Object.assign(new Error('x'), { code: 1 }), '', 'boom');
  assert.equal(failed.seen.e.message, 'boom');
  const quiet = run(Object.assign(new Error('Command failed: /usr/bin/osascript -e a long script'), { code: 1 }), '', '');
  assert.equal(quiet.seen.e.message, 'the dialog closed unexpectedly', 'no command line in the panel');
});

test('unreadable clips: a quiet reason per row, one plain sentence for all', () => {
  const row = (name, error) => ({ path: '/v/' + name, name, error });
  assert.equal(C.unreadableReason(row('a.R3D', 'x')), '.r3d isn\'t supported yet');
  assert.equal(C.unreadableReason(row('a.braw', 'unsupported file (no moov) and ffprobe not found')), '.braw isn\'t supported yet', 'ffmpeg would not help it');
  assert.equal(C.unreadableReason(row('a.MXF', 'unsupported file (x) and ffprobe not found')), '.mxf needs ffmpeg');
  assert.equal(C.unreadableReason(row('a.mp4', 'no system decoder for this clip and ffmpeg not found')), 'This clip needs ffmpeg');
  assert.equal(C.unreadableReason(row('a.mp4', 'No such file or directory')), 'Missing or offline');
  assert.equal(C.unreadableReason(row('a.mov', 'Operation not permitted')), 'macOS denied access');
  assert.equal(C.unreadableReason(row('a.mp4', 'file is truncated')), 'Couldn\'t read this file');
  assert.equal(C.unreadableSummary([]), '');
  assert.equal(C.unreadableSummary([{ path: '/v/ok.mp4', error: null }]), '');
  assert.equal(C.unreadableSummary([row('a.r3d', 'x')]), '1 clip could not be read: .r3d isn\'t supported yet.');
  assert.equal(C.unreadableSummary([row('a.r3d', 'x'), row('b.r3d', 'x'), row('c.braw', 'x')]), '3 clips could not be read: .braw and .r3d aren\'t supported yet.');
  assert.equal(C.unreadableSummary([row('a.r3d', 'x'), row('b.mxf', 'ffprobe not found')]), '2 clips could not be read: .r3d isn\'t supported yet and .mxf needs ffmpeg.');
  const s = storeFromFixture(fixture);
  assert.equal(s.errors, unreadable);
  assert.equal(s.rows.length, 400, 'nothing vanishes');
  assert.match(C.unreadableSummary(s.rows), /^8 clips could not be read: /);
  const twice = C.createStore();
  C.ingest(twice, { type: 'error', path: '/v/a.mp4', message: 'x' });
  C.ingest(twice, { type: 'error', path: '/v/a.mp4', message: 'y' });
  assert.equal(twice.errors, 1, 'one clip counts once');
});

test('no picture: Tier 0 stands, it is not an error, and the row says why in quiet words', () => {
  const s = C.createStore();
  const reason = "This Mac has no decoder for H.264 10-bit 4:2:2 (error -12906), and ffmpeg isn't installed. File details are fine, picture scores are blank.";
  C.addItems(s, [{ path: '/v/C0001.MP4' }]);
  C.ingest(s, { type: 'clip', tier: 0, path: '/v/C0001.MP4', durationS: 12, camera: 'Cam', width: 3840, height: 2160 });
  C.ingest(s, { type: 'clip', tier: 1, path: '/v/C0001.MP4', sharpness: null, luma: null, audioDb: -30, reason });
  const row = s.rows[0];
  assert.equal(row.error, null, 'never an error');
  assert.equal(s.errors, 0);
  assert.equal(row.durationS, 12);
  assert.equal(row.audioDb, -30);
  assert.equal(C.cellText(row, C.COLUMN.sharpness), '', 'blank, not 0');
  assert.equal(C.noPictureWords(row), "This Mac has no decoder for H.264 10-bit 4:2:2, and ffmpeg isn't installed.");
  assert.equal(C.noPictureWords({ reason: 'One plain sentence' }), 'One plain sentence');
  assert.equal(C.noPictureWords({}), '');
  assert.equal(C.unreadableSummary(s.rows), '', 'and nothing says it may be damaged');
  assert.equal(s.noPicture.clips, 1);
  C.ingest(s, { type: 'clip', tier: 1, path: '/v/C0001.MP4', reason });
  assert.equal(s.noPicture.clips, 1, 'one clip counts once');
  assert.deepStrictEqual(C.computeView(s.rows, { sort: C.PRESET.softest.sort, preset: 'softest' }).order, [0]);
});

test('no picture: the foot explains it once, and calmly', () => {
  const noDecoder = "This Mac has no decoder for H.264 10-bit, and ffmpeg isn't installed. File details are fine, picture scores are blank.";
  const tally = reasons => { const s = C.createStore(); reasons.forEach((r, i) => { C.addItems(s, [{ path: '/v/' + i + '.mp4' }]); C.ingest(s, { type: 'clip', tier: 1, path: '/v/' + i + '.mp4', reason: r }); }); return s.noPicture; };
  assert.equal(C.noPictureSummary(tally([])), '');
  assert.equal(C.noPictureSummary(tally([noDecoder])), "1 clip is listed with blank picture scores: this Mac has no decoder for it, and ffmpeg isn't installed.");
  assert.equal(C.noPictureSummary(tally([noDecoder, noDecoder])), "2 clips are listed with blank picture scores: this Mac has no decoder for them, and ffmpeg isn't installed.");
  assert.equal(C.noPictureSummary(tally(["This Mac couldn't decode a frame from this clip, and ffmpeg isn't installed. Rest."])), "1 clip is listed with blank picture scores: this Mac couldn't decode it, and ffmpeg isn't installed.");
  assert.equal(C.noPictureSummary(tally(["This Mac has no decoder for X, and ffmpeg couldn't read it either. Rest.", noDecoder])), "2 clips are listed with blank picture scores: this Mac couldn't decode them.");
  const store = { total: 301, tier0: 301, tier1: 301, errors: 0, bad: 0, noPicture: tally([noDecoder, noDecoder]) };
  const f = C.footState(facts({ store }));
  assert.equal(f.sentence, "301 clips in 1.8 s. Softest at the top. 2 clips are listed with blank picture scores: this Mac has no decoder for them, and ffmpeg isn't installed.");
  assert.equal(f.mark, 'done', 'a finished scan, not a failed one');
  assert.equal(f.verdict, 'Softest first');
  assert.match(C.footState(facts({ store, view: { sort: [], preset: null } })).sentence, /^Took 1\.8 s\. Pick a sort above\. 2 clips are listed/);
  assert.equal(C.footState(facts({ store, selected: 4 })).sentence.indexOf('blank'), -1, 'a selection has its own line');
});

test('ffmpeg: the engine\'s own words still read as needing ffmpeg', () => {
  const mxf = 'MXF files need ffmpeg (ffmpeg not found on this Mac). Most MP4 and MOV clips work without it.';
  assert.equal(C.unreadableReason({ path: '/v/a.MXF', error: mxf }), '.mxf needs ffmpeg');
  assert.equal(C.unreadableSummary([{ path: '/v/a.mxf', error: mxf }]), '1 clip could not be read: .mxf needs ffmpeg.');
  assert.equal(C.unreadableReason({ path: '/v/a.mp4', error: 'unsupported file (x) and ffprobe not found' }), 'This clip needs ffmpeg');
});

test('sources: claims stay honest; .r3d and .braw list as rows without a claim that they read', () => {
  assert.ok(C.isVideoPath('/a/A001.R3D') && C.isVideoPath('/a/b.braw') && C.isVideoPath('/a/c.MXF'));
  assert.match(C.FORMATS_NOTE, /\.mp4, \.mov and \.m4v/);
  assert.match(C.FORMATS_NOTE, /\.mxf when ffmpeg is installed/);
  assert.match(C.FORMATS_NOTE, /\.r3d and \.braw, stay in the list but can't be read yet/);
});

// A foot's facts, finished unless a test says otherwise.
function facts(over) {
  const store = { total: 301, tier0: 301, tier1: 301, errors: 0, bad: 0 };
  return {
    source: 'project', project: { name: 'x', path: '/x' }, connected: true, listing: false, busy: null, outcome: null, store, rows: 301, shown: 301, selected: 0, groupCount: 0,
    view: { sort: C.PRESET.softest.sort, preset: 'softest' }, scan: { state: 'Done', failure: null, seconds: 1.84, stopping: false }, ...over
  };
}

test('foot: before scanning', () => {
  const f = C.footState(facts({ scan: null, rows: 0, shown: 0, view: { sort: [], preset: null } }));
  assert.equal(f.kind, 'empty');
  assert.equal(f.mark, 'waiting');
  assert.equal(f.verdict, 'Nothing scanned yet');
  assert.deepStrictEqual(f.actions, ['scan']);
  assert.equal(f.primary, 'scan');
  assert.ok(!f.green);
  assert.match(C.footState(facts({ scan: null, rows: 0, project: null })).sentence, /Open a project/);
  assert.match(C.footState(facts({ scan: null, rows: 0, source: 'folder' })).sentence, /this folder/);
});

test('foot: scanning', () => {
  const store = { total: 301, tier0: 301, tier1: 210, errors: 4, bad: 0 };
  const f = C.footState(facts({ store, scan: { state: 'Scanning', failure: null, seconds: 1.8, stopping: false } }));
  assert.equal(f.mark, 'running');
  assert.equal(f.verdict, 'Reading 214 of 301');
  assert.equal(f.sentence, '119 clips per second');
  assert.deepStrictEqual(f.actions, ['stop']);
  assert.ok(f.meter > 0.7 && f.meter < 0.8, String(f.meter));
  assert.ok(!f.green);
});

test('foot: finished, with Scan gone from the foot', () => {
  const f = C.footState(facts());
  assert.equal(f.mark, 'done');
  assert.equal(f.verdict, 'Softest first');
  assert.equal(f.sentence, '301 clips in 1.8 s. Softest at the top.');
  assert.deepStrictEqual(f.actions, ['label', 'columns', 'bins']);
  assert.equal(f.primary, 'bins');
  assert.ok(!f.binsOff && !f.green);
  const unsorted = C.footState(facts({ view: { sort: [], preset: null } }));
  assert.equal(unsorted.verdict, '301 clips read');
  assert.ok(unsorted.binsOff, 'bins need a sort');
  assert.equal(C.footState(facts({ selected: 4 })).sentence, '4 of 301 clips selected. Label, Add Columns and Sort into Bins use these.');
  const filtered = C.footState(facts({ shown: 12, view: { sort: C.PRESET.silent.sort, preset: 'silent' } }));
  assert.equal(filtered.sentence, '12 of 301 clips. No audio track, or sampled audio reads as silent.');
  const groups = C.footState(facts({ shown: 90, groupCount: 30, view: { sort: C.PRESET.duplicates.sort, preset: 'duplicates' } }));
  assert.equal(groups.sentence, '30 groups, 90 of 301 clips. Similar frames grouped, sharpest first in each.');
  assert.equal(C.footState(facts({ view: { sort: [{ key: 'luma', dir: -1 }], preset: null } })).sentence, '301 clips in 1.8 s. Brightest at the top.');
});

test('foot: a new source brings Scan back, and the old results stay', () => {
  const was = C.footState(facts({ scan: { state: 'Done', seconds: 2, failure: null } }));
  assert.ok(!was.actions.includes('scan'));
  const f = C.footState(facts({ scan: { state: 'Done', seconds: 2, failure: null }, source: 'folder', rescan: true }));
  assert.deepStrictEqual(f.actions, ['scan']);
  assert.equal(f.primary, 'scan');
  assert.match(f.sentence, /last scan/);
});

test('foot: stopped, failed, and nothing readable', () => {
  const stopped = C.footState(facts({ store: { total: 301, tier0: 200, tier1: 120, errors: 0, bad: 0 }, scan: { state: 'Stopped', failure: null, seconds: 1, stopping: false } }));
  assert.equal(stopped.verdict, 'Stopped');
  assert.equal(stopped.sentence, '120 of 301 clips read. What was read stays.');
  assert.equal(stopped.primary, 'scan');
  const failed = C.footState(facts({ scan: { state: 'Failed', failure: C.engineFailure({ errorCode: 'ENOENT' }, 0), seconds: 0, stopping: false } }));
  assert.equal(failed.mark, 'failed');
  assert.match(failed.sentence, /not installed/);
  assert.ok(failed.actions.includes('scan'));
  const none = C.footState(facts({ store: { total: 3, tier0: 0, tier1: 0, errors: 3, bad: 0 }, rows: 3, shown: 3 }));
  assert.equal(none.verdict, 'Nothing could be read');
  assert.equal(none.mark, 'look');
});

const binsSent = () => ({ root: 'R', buckets: [{ name: '01 Softest', ids: ['1', '2'] }, { name: '02 Softer', ids: ['3'] }] });

test('green: only when what was read back matches what was sent', () => {
  const bins = C.writeOutcome('bins', binsSent(), { ok: true, moved: 3, failed: [], buckets: [{ name: '01 Softest', ids: ['2', '1'] }, { name: '02 Softer', ids: ['3'] }] });
  assert.equal(bins.green, true);
  assert.equal(bins.verdict, 'Sorted into 2 bins');
  assert.equal(bins.sentence, '3 clips moved. Your files weren\'t touched.');
  const foot = C.footState(facts({ outcome: bins }));
  assert.ok(foot.green);
  assert.equal(foot.mark, 'seal');
  assert.deepStrictEqual(foot.actions, ['undo']);

  const label = C.writeOutcome('label', { ids: ['1', '2'] }, { ok: true, changed: 2, failed: [] }, 'Mango');
  assert.equal(label.green, true);
  assert.equal(label.verdict, 'Labelled 2 clips Mango');

  const cols = { fields: C.FIELDS, rows: [{ ids: ['1', '2'], values: {} }] };
  const columns = C.writeOutcome('columns', cols, { ok: true, changed: 2, matched: 2, failed: [], columns: { shown: true } });
  assert.equal(columns.green, true);
  assert.equal(columns.verdict, 'Added 13 columns');
});

test('green: never on a partial or unconfirmed write, whatever the host calls it', () => {
  const never = o => { assert.ok(!o.green, o.verdict); assert.ok(!C.footState(facts({ outcome: o })).green); assert.equal(C.footState(facts({ outcome: o })).mark, 'look'); return o; };
  // One clip stayed behind, and the host still said ok.
  let o = never(C.writeOutcome('bins', binsSent(), { ok: true, moved: 3, failed: [], buckets: [{ name: '01 Softest', ids: ['1'] }, { name: '02 Softer', ids: ['3'] }] }));
  assert.equal(o.verdict, 'Moved 2 of 3 clips');
  assert.equal(o.sentence, '1 clip did not land where it should. Your files weren\'t touched.');
  // In the wrong bin.
  o = never(C.writeOutcome('bins', binsSent(), { ok: true, moved: 3, failed: [], buckets: [{ name: '01 Softest', ids: ['1', '3'] }, { name: '02 Softer', ids: ['2'] }] }));
  assert.equal(o.verdict, 'Moved 1 of 3 clips');
  // A stranger in the bin.
  o = never(C.writeOutcome('bins', binsSent(), { ok: true, moved: 3, failed: [], buckets: [{ name: '01 Softest', ids: ['1', '2', '9'] }, { name: '02 Softer', ids: ['3'] }] }));
  // A failure listed, even with every id back.
  never(C.writeOutcome('bins', binsSent(), { ok: true, moved: 3, failed: [{ id: 'x', error: 'e' }], buckets: [{ name: '01 Softest', ids: ['1', '2'] }, { name: '02 Softer', ids: ['3'] }] }));
  // A host with no read-back at all.
  o = never(C.writeOutcome('bins', binsSent(), { ok: true, moved: 3, failed: [], buckets: [{ name: '01 Softest', moved: 2, inBin: 2 }, { name: '02 Softer', moved: 1, inBin: 1 }] }));
  assert.equal(o.verdict, 'Moved, not confirmed');
  // A bin that did not come back.
  never(C.writeOutcome('bins', binsSent(), { ok: true, moved: 2, failed: [], buckets: [{ name: '01 Softest', ids: ['1', '2'] }] }));
  o = never(C.writeOutcome('bins', binsSent(), { ok: true, moved: 0, failed: [], buckets: [] }));
  assert.equal(o.verdict, 'Nothing moved');
  assert.equal(o.undo, false);

  const cols = { fields: C.FIELDS, rows: [{ ids: ['1'], values: {} }, { ids: ['2', '3'], values: {} }] };
  o = never(C.writeOutcome('columns', cols, { ok: true, changed: 3, matched: 2, failed: [], columns: { shown: true } }));
  assert.equal(o.verdict, 'Wrote 2 of 3 clips');
  o = never(C.writeOutcome('columns', cols, { ok: true, changed: 3, failed: [], columns: { shown: true } }));
  assert.equal(o.verdict, 'Written, not confirmed');
  o = never(C.writeOutcome('columns', cols, { ok: true, changed: 3, matched: 3, failed: [], columns: { shown: false } }));
  assert.match(o.sentence, /Metadata Display/);

  o = never(C.writeOutcome('label', { ids: ['1', '2'] }, { ok: true, changed: 1, failed: [{ id: '2', error: 'label did not change' }] }, 'Mango'));
  assert.equal(o.verdict, 'Labelled 1 of 2 clips');
  assert.deepStrictEqual(C.footState(facts({ outcome: o })).actions, ['details', 'undo']);
});

test('undo words: never green, and honest about what stayed', () => {
  assert.equal(C.undoOutcome({ restored: 301, skipped: 0, failed: [] }).sentence, '301 items back where they were.');
  const some = C.undoOutcome({ restored: 5, skipped: 1, failed: [] });
  assert.match(some.sentence, /1 changed since and left alone/);
  assert.ok(!some.green);
  assert.equal(C.footState(facts({ outcome: C.undoOutcome({ restored: 1, skipped: 0, failed: [] }) })).mark, 'done');
});

test('theme: follows Premiere\'s brightness', () => {
  assert.equal(C.themeFor({ red: 35, green: 35, blue: 35 }), 'dark');
  assert.equal(C.themeFor({ red: 75, green: 75, blue: 75 }), 'dark');
  assert.equal(C.themeFor({ red: 184, green: 184, blue: 184 }), 'light');
  assert.equal(C.themeFor({ red: 240, green: 240, blue: 240 }), 'light');
  assert.equal(C.themeFor(null), 'dark');
});

function tokensOf(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})/g)) { out[m[1]] = m[2]; }
  return out;
}

function contrast(a, b) {
  const lum = hex => {
    const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test('tokens: exactly Ingest\'s, and every text colour measures at least 4.5:1', () => {
  const css = fs.readFileSync(path.join(__dirname, '../client/style.css'), 'utf8');
  const light = tokensOf(css.slice(css.indexOf(':root {'), css.indexOf(':root[data-theme="dark"] {')));
  const dark = { ...light, ...tokensOf(css.slice(css.indexOf(':root[data-theme="dark"] {'), css.indexOf('* { box-sizing'))) };
  assert.deepStrictEqual(light, { ink: '#1D1D1F', ink2: '#5F6063', ink3: '#8E8E93', surface: '#FFFFFF', foot: '#F4F4F6', disc: '#E7E7EC', tick: '#3A3A3C', ring: '#C9C9CE', track: '#E9E9EE', meter: '#6E6E73', 'focus-ring': '#8A8A90', cobalt: '#2563EB', bad: '#C9281C', safe: '#15803D' });
  assert.deepStrictEqual(dark, { ink: '#EDEDEE', ink2: '#ADADB1', ink3: '#7C7C82', surface: '#26262A', foot: '#1C1C1F', disc: '#3A3A40', tick: '#EDEDEE', ring: '#55555C', track: '#3A3A40', meter: '#A0A0A6', 'focus-ring': '#9A9AA0', cobalt: '#2F6FE6', bad: '#FF6A5F', safe: '#15803D' });
  for (const t of [light, dark]) {
    for (const [fg, bg] of [[t.ink, t.surface], [t.ink2, t.surface], [t.ink, t.foot], [t.ink2, t.foot], [t.ink, t.disc], [t.ink2, t.disc], [t.ink, t.track], [t.bad, t.foot], ['#FFFFFF', t.cobalt], ['#FFFFFF', t.safe], [t.safe, '#FFFFFF']]) {
      assert.ok(contrast(fg, bg) >= 4.5, `${fg} on ${bg}: ${contrast(fg, bg).toFixed(2)}`);
    }
  }
  assert.ok(contrast(light.ink3, light.surface) < 4.5, 'ink3 stays for placeholders only');
  assert.ok(!/color:\s*var\(--ink3\)/.test(css.replace(/#(folder|search)::placeholder \{[^}]*\}/g, '')), 'ink3 is used by the placeholder and by nothing else');
});

// A project in memory, shaped as the host script sees Premiere. `lose` drops one id's move, as a failed read-back would show.
function hostWith(options) {
  const o = options || {}, vm = require('vm');
  let next = 100;
  const bin = name => { const b = { type: 2, name, nodeId: next++, kids: [], createBin(n) { const c = bin(n); c.up = b; b.kids.push(c); sync(b); return c; }, deleteBin() { if (b.up) { b.up.kids = b.up.kids.filter(k => k !== b); sync(b.up); } return true; } }; sync(b); return b; };
  function sync(b) { b.children = { numItems: b.kids.length }; b.kids.forEach((k, i) => { b.children[i] = k; }); }
  const root = bin('root');
  const clip = (id, up) => {
    let meta = '', label = 0;
    const c = { type: 1, name: 'C' + id + '.MP4', nodeId: id, up, isSequence: () => false, getMediaPath: () => '/v/C' + id + '.MP4',
      getColorLabel: () => label, setColorLabel(l) { if (!o.stuckLabel || o.stuckLabel.size === 0 || !o.stuckLabel.has(id)) { label = l; } }, getProjectMetadata: () => meta,
      setProjectMetadata(xmp) { meta = o.dropMetadata ? '' : xmp; return true; },
      moveBin(to) { if (o.lose === id || (o.stuck && o.stuck.size && o.stuck.has(id))) { return 0; } c.up.kids = c.up.kids.filter(k => k !== c); sync(c.up); c.up = to; to.kids.push(c); sync(to); return true; } };
    up.kids.push(c); sync(up);
    return c;
  };
  [1, 2, 3].forEach(id => clip(id, root));
  const sandbox = { app: { version: '26', enableQE() {}, project: { path: '/p.prproj', name: 'p.prproj', rootItem: root, activeSequence: null, addPropertyToProjectMetadataSchema() {} } },
    qe: { getModalWindowID: () => '', project: { getActiveSequence: () => null }, source: { player: { isPlaying: false } } } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../host/select.jsx'), 'utf8'), sandbox);
  if (o.noModalCheck) { delete sandbox.qe.getModalWindowID; }
  return { call: (fn, args) => JSON.parse(sandbox.slCall(fn, JSON.stringify(args))), root, sandbox, clip: id => root.kids.concat(...root.kids.map(k => k.kids || [])).concat(...root.kids.flatMap(k => (k.kids || []).map(x => x.kids || []))).find(c => c.nodeId === id) };
}

const binsArgs = () => ({ project: '/p.prproj', root: 'SELECT x', buckets: [{ name: '01 Softest', ids: ['1', '2'] }, { name: '02 Softer', ids: ['3'] }] });

test('undo: bins that really went back are counted, and the SELECT bin leaves', () => {
  const h = hostWith(), res = h.call('bins', binsArgs()), back = h.call('restore', { project: '/p.prproj', restore: res.restore });
  assert.equal(back.restored, 3);
  assert.equal(back.binRemoved, true);
  assert.equal(back.remaining, null);
  assert.equal(C.undoOutcome(back).verdict, 'Undone');
  assert.deepStrictEqual(h.root.kids.map(k => k.name), ['C1.MP4', 'C2.MP4', 'C3.MP4']);
});

test('undo: a move that said yes and did nothing is a failure, and it can be retried', () => {
  const stuck = new Set(), h = hostWith({ stuck }), res = h.call('bins', binsArgs());
  stuck.add(2);
  const first = h.call('restore', { project: '/p.prproj', restore: res.restore });
  assert.equal(first.restored, 2);
  assert.equal(first.failed.length, 1);
  assert.equal(first.remaining.items.length, 1, 'only what is left is retried');
  const o = C.undoOutcome(first);
  assert.equal(o.verdict, 'Partly undone');
  assert.equal(o.undo, true);
  assert.equal(o.kind, 'partial');
  stuck.clear();
  const second = h.call('restore', { project: '/p.prproj', restore: first.remaining });
  assert.equal(second.restored, 1);
  assert.equal(second.remaining, null);
  assert.equal(second.binRemoved, true);
});

test('undo: a label that did not change back is a failure, not a count', () => {
  const stuckLabel = new Set(), h = hostWith({ stuckLabel }), res = h.call('label', { project: '/p.prproj', ids: ['1', '2'], color: 5 });
  assert.equal(res.changed, 2);
  stuckLabel.add(1);
  const back = h.call('restore', { project: '/p.prproj', restore: res.restore });
  assert.equal(back.restored, 1);
  assert.equal(back.failed.length, 1);
  assert.equal(C.undoOutcome(back).verdict, 'Partly undone');
});

test('undo: an id that now names another clip is left alone', () => {
  const h = hostWith(), res = h.call('label', { project: '/p.prproj', ids: ['1'], color: 5 });
  h.root.kids[0].getMediaPath = () => '/v/Someone-Else.MP4';
  const back = h.call('restore', { project: '/p.prproj', restore: res.restore });
  assert.equal(back.restored, 0);
  assert.equal(back.skipped, 1);
});

test('undo: column values with markup go back as they were', () => {
  const h = hostWith(), c = h.root.kids[0], tag = 'premierePrivateProjectMetaData:SelectRank';
  c.setProjectMetadata(`<${tag}>A&amp;B</${tag}>`);
  const res = h.call('columns', { project: '/p.prproj', show: false, fields: [{ name: 'SelectRank', label: 'x' }], rows: [{ ids: ['1'], values: { SelectRank: '0001' } }] });
  const back = h.call('restore', { project: '/p.prproj', restore: res.restore });
  assert.equal(back.restored, 1);
  assert.ok(c.getProjectMetadata().includes('>A&amp;B<'));
  assert.ok(!c.getProjectMetadata().includes('&amp;amp;'));
});

test('bins: a failure part way through keeps what is needed to undo the clips that moved', () => {
  const h = hostWith(), real = h.root.createBin.bind(h.root);
  h.root.createBin = name => {
    const top = real(name), inner = top.createBin.bind(top);
    let calls = 0;
    top.createBin = n => { if (++calls === 2) { throw new Error('no more bins'); } return inner(n); };
    return top;
  };
  const sent = binsArgs(), res = h.call('bins', sent);
  assert.ok(res.ok, 'not a bare failure');
  assert.equal(res.moved, 2);
  assert.equal(res.restore.items.length, 2);
  assert.ok(res.failed.some(f => /no more bins/.test(f.error)));
  const o = C.writeOutcome('bins', sent, res);
  assert.ok(!o.green);
  assert.equal(o.undo, true);
});

test('bins: when nothing moved, no empty bins stay behind', () => {
  const h = hostWith(), sent = { project: '/p.prproj', root: 'SELECT x', buckets: [{ name: '01 Softest', ids: ['98'] }, { name: '02 Softer', ids: ['99'] }] };
  const res = h.call('bins', sent);
  assert.equal(res.moved, 0);
  assert.equal(res.restore, null);
  assert.equal(res.binRemoved, true);
  assert.ok(!h.root.kids.some(k => k.type === 2));
});

test('guard: a dialog state nobody can read is refused', () => {
  const res = hostWith({ noModalCheck: true }).call('label', { project: '/p.prproj', ids: ['1'], color: 5 });
  assert.equal(res.ok, false);
  assert.match(res.message, /no dialog is open/);
});

test('host: bins report what each bin really holds, and the foot reads it', () => {
  const sent = { project: '/p.prproj', root: 'SELECT x', buckets: [{ name: '01 Softest', ids: ['1', '2'] }, { name: '02 Softer', ids: ['3'] }] };
  const res = hostWith().call('bins', sent);
  assert.ok(res.ok);
  assert.deepStrictEqual(res.buckets.map(b => b.ids), [['1', '2'], ['3']]);
  assert.equal(C.writeOutcome('bins', sent, res).green, true);
  const lost = hostWith({ lose: 2 }).call('bins', sent);
  assert.equal(lost.moved, 3, 'the move call said yes');
  assert.deepStrictEqual(lost.buckets[0].ids, ['1'], 'the bin says otherwise');
  const o = C.writeOutcome('bins', sent, lost);
  assert.ok(!o.green);
  assert.equal(o.verdict, 'Moved 2 of 3 clips');
});

test('host: columns read each value back, and a value that did not stick is not counted', () => {
  const values = { SelectRank: '0001', SelectMotion: '0.412' }, sent = { project: '/p.prproj', show: false, fields: [{ name: 'SelectRank', label: 'Select Rank' }, { name: 'SelectMotion', label: 'Select Motion' }], rows: [{ ids: ['1', '2'], values }] };
  const ok = hostWith().call('columns', sent);
  assert.equal(ok.changed, 2);
  assert.equal(ok.matched, 2);
  const lost = hostWith({ dropMetadata: true }).call('columns', sent);
  assert.equal(lost.changed, 2, 'the set call said yes');
  assert.equal(lost.matched, 0);
  assert.ok(!C.writeOutcome('columns', sent, lost).green);
});

test('product: the panel agrees with product.conf', () => {
  const root = path.join(__dirname, '../..'), file = path.join(root, 'product.conf');
  const conf = Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => l.split('=')));
  const app = fs.readFileSync(path.join(root, 'panel/client/app.js'), 'utf8');
  assert.ok(app.includes(`/bin/${conf.ENGINE}'`), 'engine name');
  assert.ok(app.includes(`https://github.com/${conf.REPO}/issues/new`), 'bug link');
  assert.equal(N.configFile('/h'), `/h/Library/Application Support/${conf.BUNDLE_ID}/config.json`);
  assert.equal(fs.readFileSync(path.join(root, 'panel/client/index.html'), 'utf8').match(/<title>(.*)<\/title>/)[1], conf.NAME);
});

const clipLine = (path, tier, fields) => ({ type: 'clip', tier, path, cached: false, ms: 1, ...fields });

function t2Store(list) {
  const s = C.createStore();
  C.addItems(s, list.map(r => ({ path: r.path })));
  for (const r of list) {
    C.ingest(s, clipLine(r.path, 0, { durationS: 5, camera: r.camera === undefined ? null : r.camera, lens: r.lens === undefined ? null : r.lens }));
    C.ingest(s, clipLine(r.path, 1, { sharpness: .5 }));
    if (!r.skip) { C.ingest(s, clipLine(r.path, 2, r)); }
  }
  return s;
}

// Oklab degrees, with the engine's family boundaries: pink wraps across zero.
const hues = [['/v/pinklow.mp4', 8, 'pink'], ['/v/red.mp4', 24, 'red'], ['/v/redhigh.mp4', 40, 'red'], ['/v/orange.mp4', 60, 'orange'], ['/v/green.mp4', 140, 'green'], ['/v/blue.mp4', 250, 'blue'], ['/v/pink.mp4', 340, 'pink']];

test('colour: rainbow order, red first, flat clips after vivid ones, neutral last from light to dark, unknown after that', () => {
  const list = hues.map(([path, colorHue, colorName]) => ({ path, colorHue, colorName, colorChroma: .6, colorLight: .5 }));
  list.push({ path: '/v/logblue.mp4', colorHue: 255, colorName: 'blue', colorChroma: .07, colorLight: .5 }, { path: '/v/logred.mp4', colorHue: 30, colorName: 'red', colorChroma: .08, colorLight: .5 });
  list.push({ path: '/v/grey.mp4', colorHue: null, colorName: 'neutral', colorChroma: .01, colorLight: .4 }, { path: '/v/white.mp4', colorHue: null, colorName: 'neutral', colorChroma: .01, colorLight: .9 }, { path: '/v/dark.mp4', colorHue: null, colorName: 'neutral', colorChroma: .01, colorLight: .1 });
  list.push({ path: '/v/later.mp4', skip: true });
  const s = t2Store(list), names = order => order.map(i => s.rows[i].name.replace('.mp4', ''));
  const v = C.computeView(s.rows, { sort: C.PRESET.colour.sort, preset: 'colour' });
  assert.deepStrictEqual(names(v.order), ['red', 'redhigh', 'orange', 'green', 'blue', 'pink', 'pinklow', 'logred', 'logblue', 'white', 'grey', 'dark', 'later']);
  const fam = C.computeView(s.rows, { sort: C.PRESET.colour.sort, preset: 'colour', family: 'blue' });
  assert.deepStrictEqual(names(fam.order), ['blue', 'logblue'], 'a family filter keeps flat clips of that family');
  assert.deepStrictEqual(C.familyCounts(s.rows).neutral, 3);
  assert.equal(C.cellText(s.rows[s.rows.length - 1], C.COLUMN.colorName), '', 'unknown stays blank');
  assert.equal(C.nextSort([], 'colorName', false)[0].dir, 1, 'the natural way round is the rainbow');
  assert.equal(C.sortName({ sort: [{ key: 'colorName', dir: 1 }], preset: null }), 'Colour');
});

test('colour: an all-log shoot is one muted rainbow, not one grey heap', () => {
  const s = t2Store(hues.map(([path, colorHue, colorName]) => ({ path, colorHue, colorName, colorChroma: .06, colorLight: .4 })));
  const v = C.computeView(s.rows, { sort: C.PRESET.colour.sort, preset: 'colour' });
  assert.deepStrictEqual(v.order.map(i => s.rows[i].colorName), ['red', 'red', 'orange', 'green', 'blue', 'pink', 'pink']);
  const f = C.bucketize(v.order.map(i => s.rows[i]), { sort: C.PRESET.colour.sort, preset: 'colour' });
  assert.deepStrictEqual(f.map(b => b.name), ['01 Red', '02 Orange', '03 Green', '04 Blue', '05 Pink']);
});

test('search: every field, several words narrow it, accents and case fold, and a word must start where it says', () => {
  const s = t2Store([
    { path: '/v/C0148.MP4', camera: 'SONY ILME-FX3', lens: 'FE 24-70mm', labels: [{ name: 'sourdough loaf', conf: .9 }], text: ['Café Lumière'], sounds: [{ name: 'speech', conf: .8 }], shotSize: 'closeup', colorName: 'orange', colorHue: 30, colorChroma: .5, colorLight: .5 },
    { path: '/v/C0200.MP4', camera: 'Canon EOS R5', labels: [{ name: 'harbour', conf: .9 }], text: [], sounds: [{ name: 'water', conf: .8 }], shotSize: 'wide', colorName: 'blue', colorHue: 210, colorChroma: .5, colorLight: .5 },
    { path: '/v/not-yet.MP4', skip: true }
  ]);
  const find = q => C.computeView(s.rows, { sort: [], preset: null }, null, { tokens: C.searchTokens(q) }).order.map(i => s.rows[i].name);
  for (const q of ['0148', 'c0148.mp4', 'sourdough', 'loaf', 'cafe', 'LUMIERE', 'speech', 'sony', 'fx3', '24', 'close-up', 'closeup', 'orange']) { assert.deepStrictEqual(find(q), ['C0148.MP4'], q); }
  for (const q of ['harbour', 'water', 'canon', 'wide', 'blue']) { assert.deepStrictEqual(find(q), ['C0200.MP4'], q); }
  assert.deepStrictEqual(find('orange speech'), ['C0148.MP4'], 'both words');
  assert.deepStrictEqual(find('orange water'), [], 'several words narrow, they never widen');
  assert.deepStrictEqual(find('ange'), [], 'a colour name is matched from its start, so red does not find bored');
  assert.deepStrictEqual(find('mp4').length, 3, 'a file name matches anywhere');
  assert.equal(find('   ').length, 3, 'nothing typed, nothing filtered');
  C.ingest(s, clipLine('/v/not-yet.MP4', 2, { labels: [{ name: 'harbour wall', conf: .7 }], text: [], sounds: [] }));
  assert.equal(find('harbour').length, 2, 'a clip understood later is found at once');
  const tokens = C.searchTokens('cafe');
  assert.equal(C.matchedWord(s.rows[0], tokens), 'Café Lumière', 'it says why a clip is there');
  assert.equal(C.matchedWord(s.rows[0], C.searchTokens('0148')), '', 'and nothing when the name is why');
});

test('search: 1,000 clips, keystroke by keystroke, inside 16 ms, with sort and filter', () => {
  const recs = [];
  for (let i = 0; i < 1000; i++) { const r = fixture[i % fixture.length]; recs.push({ ...r, path: r.path + '.' + i }); }
  const s = storeFromFixture(recs);
  let worst = 0;
  for (const word of ['b', 'br', 'bre', 'brea', 'bread', 'bread s', 'bread so', 'sony', 'water wind']) {
    for (const view of [{ sort: [], preset: null }, { sort: C.PRESET.colour.sort, preset: 'colour' }, { sort: C.PRESET.people.sort, preset: 'people' }]) {
      const t0 = performance.now();
      C.computeView(s.rows, view, null, { tokens: C.searchTokens(word) });
      worst = Math.max(worst, performance.now() - t0);
    }
  }
  console.log(`  search worst ${worst.toFixed(2)} ms`);
  assert.ok(worst <= 16, `worst ${worst} ms`);
});

test('bins by category: named, numbered in the category\'s order, no value kept apart, every clip once', () => {
  const s = storeFromFixture(fixture);
  const view = { sort: C.PRESET.colour.sort, preset: 'colour' };
  const list = byOrder(s.rows, C.computeView(s.rows, view).order);
  const b = C.bucketize(list, view);
  assert.deepStrictEqual(b.map(x => x.name.slice(3)), ['Red', 'Orange', 'Yellow', 'Green', 'Teal', 'Blue', 'Purple', 'Pink', 'Neutral', 'No value']);
  assert.ok(b.every((x, i) => x.name.startsWith(String(i + 1).padStart(2, '0') + ' ')));
  assert.equal(b.reduce((n, x) => n + x.rows.length, 0), list.length);
  assert.ok(b[0].rows.every(r => r.colorName === 'red'));
  const shot = { sort: C.PRESET.shot.sort, preset: 'shot' };
  const sb = C.bucketize(byOrder(s.rows, C.computeView(s.rows, shot).order), shot);
  assert.deepStrictEqual(sb.map(x => x.name), ['01 Close-ups', '02 Mediums', '03 Wides', '04 No people', '05 No value']);
  assert.deepStrictEqual(C.bucketize([{ colorName: 'blue' }], view).map(x => x.name), ['01 Blue'], 'numbered among what is there');
  const close = { sort: C.PRESET.closeups.sort, preset: 'closeups' };
  assert.deepStrictEqual(C.bucketize(byOrder(s.rows, C.computeView(s.rows, close).order), close).map(x => x.name), ['01 Close-ups']);
  const words = { sort: C.PRESET.onscreen.sort, preset: 'onscreen' };
  assert.deepStrictEqual(C.bucketize(byOrder(s.rows, C.computeView(s.rows, words).order), words).map(x => x.name), ['01 Text on screen']);
  const quint = { sort: C.PRESET.people.sort, preset: 'people' };
  assert.equal(C.bucketize(byOrder(s.rows, C.computeView(s.rows, quint).order), quint)[0].name, '01 Most people', 'a count keeps its quintiles');
  const header = { sort: [{ key: 'colorName', dir: 1 }], preset: null };
  assert.equal(C.bucketize(list, header)[0].name, '01 Red', 'a column sort does the same');
});

test('host: category bins go through the same write, with the same read-back, and a stray stays unproved', () => {
  const sent = { project: '/p.prproj', root: 'SELECT 2026-11-03 Colour', buckets: [{ name: '01 Red', ids: ['1', '2'] }, { name: '02 Blue', ids: ['3'] }] };
  const res = hostWith().call('bins', sent);
  assert.equal(C.writeOutcome('bins', sent, res).verdict, 'Sorted into 2 bins');
  assert.equal(C.writeOutcome('bins', sent, res).green, true);
  const lost = hostWith({ lose: 3 }).call('bins', sent);
  assert.ok(!C.writeOutcome('bins', sent, lost).green);
  assert.ok(lost.restore && lost.restore.items.length, 'Undo still has what it needs');
});

test('groups: arrive last, once, and only for rows the scan knows', () => {
  const s = t2Store([{ path: '/v/a.mp4' }, { path: '/v/b.mp4' }, { path: '/v/c.mp4' }, { path: '/v/d.mp4' }]);
  const view = { sort: C.PRESET.similar.sort, preset: 'similar' };
  assert.equal(C.computeView(s.rows, view).order.length, 0, 'nothing before the line');
  assert.equal(C.dataStatus(s.rows, 'similar', true), 'waiting');
  assert.equal(C.dataStatus(s.rows, 'similar', false), 'none');
  assert.ok(C.ingest(s, { type: 'groups', groups: [{ id: 7, paths: ['/v/c.mp4', '/v/a.mp4'] }, { id: 9, paths: ['/v/b.mp4', '/v/gone.mp4'] }] }));
  assert.equal(s.rows.length, 4, 'a path the scan does not know adds no row');
  const v = C.computeView(s.rows, view);
  assert.deepStrictEqual(v.order.map(i => s.rows[i].name), ['a.mp4', 'c.mp4', 'b.mp4']);
  assert.equal(v.groupCount, 2);
  assert.deepStrictEqual(v.breaks.map(b => [b.at, b.count, b.number]), [[0, 2, 1], [2, 1, 2]]);
  assert.equal(C.dataStatus(s.rows, 'similar', true), 'ok');
  assert.deepStrictEqual(C.bucketize(v.order.map(i => s.rows[i]), view).map(b => b.name), ['001 Group of 2', '002 Group of 1']);
  assert.equal(C.presetCount(s.rows, 'similar'), 3);
  const searched = C.computeView(s.rows, view, null, { tokens: C.searchTokens('c.mp4') });
  assert.deepStrictEqual(searched.breaks.map(b => b.count), [1], 'a search narrows inside a group');
});

test('tier 2 failure: a line with no moments, as the engine sends it, leaves the clip whole', () => {
  const s = t2Store([{ path: '/v/a.mp4', skip: true }, { path: '/v/b.mp4', skip: true }]);
  C.ingest(s, clipLine('/v/a.mp4', 2, { moments: 0 }));
  assert.equal(s.tier2Failed, 1);
  assert.equal(s.rows[0].error, null);
  assert.equal(s.rows[0].sharpness, .5);
  assert.equal(C.cellText(s.rows[0], C.COLUMN.people), '', 'blank, never 0');
  assert.equal(C.cellText(s.rows[0], C.COLUMN.colorName), '');
  C.ingest(s, clipLine('/v/b.mp4', 1, { reason: 'This Mac has no decoder for X. File details are fine, picture scores are blank.' }));
  C.ingest(s, clipLine('/v/b.mp4', 2, { moments: 0 }));
  assert.equal(s.tier2Failed, 1, 'a clip with no picture is already explained, so it does not count twice');
  assert.equal(s.tier2, 1);
});

test('tier 2 failure: nothing Tiers 0 and 1 found is touched, and it is not called unreadable', () => {
  const s = t2Store([{ path: '/v/a.mp4', skip: true }, { path: '/v/b.mp4', skip: true }, { path: '/v/c.mp4', people: 2 }]);
  C.ingest(s, { type: 'error', tier: 2, path: '/v/a.mp4', message: 'could not look closer' });
  C.ingest(s, { type: 'error', path: '/v/b.mp4', message: 'no tier given' });
  assert.equal(s.errors, 0);
  assert.equal(s.tier2Failed, 2);
  assert.equal(s.rows[0].error, null);
  assert.equal(s.rows[0].sharpness, .5);
  assert.equal(s.rows[0].durationS, 5);
  assert.equal(C.unreadableSummary(s.rows), '');
  assert.equal(C.footState(facts({ store: s, rows: 3, shown: 3 })).mark, 'done');
  assert.equal(C.notUnderstoodSummary(s), '2 clips could not be looked at more closely. Their file details and picture scores stand.');
  const early = C.createStore();
  C.addItems(early, [{ path: '/v/x.mp4' }]);
  C.ingest(early, { type: 'error', path: '/v/x.mp4', message: 'unreadable' });
  assert.equal(early.errors, 1, 'before Tier 1, an error still means the clip could not be read');
});

test('null stays blank, never 0: every Tier 2 column', () => {
  const row = {};
  for (const k of ['people', 'faces', 'shotSize', 'soundText', 'screenText', 'labelText', 'iso', 'shutterS', 'aperture', 'shake', 'colorName']) {
    assert.equal(C.cellText({ ...row, [k]: null }, C.COLUMN[k]), '', k);
  }
  assert.equal(C.cellText({ people: 0 }, C.COLUMN.people), '0', 'a real zero stays');
  assert.equal(C.cellText({ shake: 0 }, C.COLUMN.shake), '0.000');
  assert.equal(C.cellText({ shutterS: .02 }, C.COLUMN.shutterS), '1/50');
  assert.equal(C.cellText({ aperture: 2.8 }, C.COLUMN.aperture), 'f/2.8');
  assert.equal(C.cellText({ aperture: 2 }, C.COLUMN.aperture), 'f/2');
  assert.equal(C.cellText({ shotSize: 'closeup' }, C.COLUMN.shotSize), 'Close-up');
  const s = t2Store([{ path: '/v/a.mp4', people: null, faces: null }]);
  assert.equal(C.computeView(s.rows, { sort: C.PRESET.nopeople.sort, preset: 'nopeople' }).order.length, 0, 'unknown is not no people');
});

test('three stages: rows usable from Tier 1, then the foot says the rest is still running', () => {
  const store = { total: 301, tier0: 301, tier1: 301, errors: 1, tier2: 120, tier2Failed: 0, bad: 0 };
  const scan = { state: 'Scanning', failure: null, seconds: 2, stopping: false };
  const u = C.footState(facts({ store, scan, view: { sort: C.PRESET.softest.sort, preset: 'softest' } }));
  assert.equal(u.kind, 'understanding');
  assert.equal(u.mark, 'running');
  assert.equal(u.verdict, 'Softest first');
  assert.equal(u.sentence, 'Still looking closer, on this Mac: 120 of 300');
  assert.ok(u.meter > .39 && u.meter < .41);
  assert.deepStrictEqual(u.actions, ['stop', 'label', 'columns', 'bins'], 'the writes work now, because Tier 1 is in');
  assert.equal(u.primary, 'bins');
  assert.equal(C.footState(facts({ store: { ...store, tier1: 100 }, scan })).kind, 'scanning', 'stage two still says Reading');
  assert.equal(C.footState(facts({ store, scan: { ...scan, stopping: true } })).verdict, 'Stopping');
});

test('a sort with no data says so plainly, a waiting one says waiting', () => {
  const s = t2Store([{ path: '/v/a.mp4', shake: null }]);
  assert.equal(C.dataStatus(s.rows, 'steadiest', false), 'none');
  assert.equal(C.dataStatus(s.rows, 'steadiest', true), 'waiting');
  assert.equal(C.dataStatus(s.rows, 'softest', false), 'ok');
  assert.equal(C.dataStatus(s.rows, null, false), 'ok');
  const f = C.footState(facts({ status: 'none', view: { sort: C.PRESET.steadiest.sort, preset: 'steadiest' } }));
  assert.match(f.sentence, /No clip here has gyro data, so there is no shake to sort by\./);
  assert.equal(C.presetCount(s.rows, 'softest'), null, 'a sort keeps every clip, so it has no count');
});

test('foot and tiles: a search says how many and why, and a tile keeps one fact', () => {
  const q = C.footState(facts({ shown: 12, query: 'red', view: { sort: C.PRESET.softest.sort, preset: 'softest' } }));
  assert.equal(q.sentence, '12 of 301 clips match “red”. Softest at the top.');
  assert.equal(C.footState(facts({ shown: 9, view: { sort: C.PRESET.colour.sort, preset: 'colour', family: 'teal' } })).verdict, 'Teal, colour');
  const row = { path: '/v/a.mp4', name: 'a.mp4', durationS: 75, sharpness: .123, labels: [{ name: 'oven', conf: .9 }], nameFold: 'a mp4', error: null };
  assert.equal(C.tileFact(row, { sort: [], preset: null }), '1:15.0', 'length, with nothing else to say');
  assert.equal(C.tileFact(row, { sort: C.PRESET.softest.sort, preset: 'softest' }), '0.123', 'what the view is about');
  assert.equal(C.tileFact(row, { sort: [], preset: null }, ['oven']), 'oven', 'why a search found it');
  assert.equal(C.tileFact({ ...row, reason: 'x', durationS: null }, { sort: [], preset: null }), 'No picture');
  assert.equal(C.tileFact({ ...row, path: '/v/a.r3d', error: 'x' }, { sort: [], preset: null }), '.r3d isn\'t supported yet');
});

test('sort row: every preset has one place, and people and faces are said to be counts', () => {
  const placed = C.GROUPS.flatMap(g => g.presets).concat(['colour', 'shoot']);
  assert.equal(new Set(placed).size, placed.length);
  assert.deepStrictEqual(placed.slice().sort(), C.PRESETS.map(p => p.id).sort());
  assert.ok(C.GROUPS.length <= 6, 'a short line');
  assert.match(C.COLUMN.people.tip, /count/i);
  assert.match(C.COLUMN.faces.tip, /never who/i);
  assert.match(C.PRESET.people.tip, /never says who/);
  for (const c of C.COLUMNS) { if (c.key !== 'codec' && c.key !== 'thumb') { assert.ok(c.tip, c.key + ' says what it measures'); } }
});

test('fixture: invented Tier 2 with its nulls, flat clips, groups and failures', () => {
  const t2 = fixture.filter(r => r.tier2).map(r => r.tier2);
  assert.ok(t2.some(x => x.people === null) && t2.some(x => x.shake === null) && t2.some(x => x.shake !== null) && t2.some(x => x.sounds === null) && t2.some(x => x.colorHue === null));
  assert.ok(fixture.filter(r => r.plan && r.plan.log).length > 30, 'flat clips');
  assert.ok(t2.filter(x => x.moments).every(x => x.palette.length && x.palette.every(c => /^#[0-9a-f]{6}$/.test(c))), 'each palette measured from its picture');
  assert.ok(C.FAMILIES.every(f => t2.some(x => x.colorName === f.id)), 'every family present');
});

test('writes that need Tier 2 wait for it in stage three, turn on by themselves, and the rest keep working', () => {
  const store = { total: 301, tier0: 301, tier1: 301, errors: 1, tier2: 120, tier2Failed: 0, bad: 0 };
  const scan = { state: 'Scanning', failure: null, seconds: 2, stopping: false };
  const colour = { sort: C.PRESET.colour.sort, preset: 'colour' };
  const held = C.footState(facts({ store, scan, view: colour, needsTier2: C.viewNeedsTier2(colour) }));
  assert.deepStrictEqual(held.held, ['label', 'columns', 'bins'], 'held, but still there');
  assert.deepStrictEqual(held.actions, ['stop', 'label', 'columns', 'bins']);
  assert.equal(held.wait, 'Colour needs every clip looked at, so Label, Add Columns and Sort into Bins wait until it is done. They turn on by themselves.');
  const soft = { sort: C.PRESET.softest.sort, preset: 'softest' };
  assert.deepStrictEqual(C.footState(facts({ store, scan, view: soft, needsTier2: C.viewNeedsTier2(soft) })).held, [], 'a Tier 1 sort writes now');
  const landed = { ...store, tier2: 290, tier2Failed: 10 };
  assert.deepStrictEqual(C.footState(facts({ store: landed, scan, view: colour, needsTier2: true })).held, [], 'every clip has landed, so it turns on with nothing pressed');
  assert.ok(C.understandingShare(landed).landed && !C.understandingShare(store).landed);
  for (const view of [colour, { sort: C.PRESET.people.sort, preset: 'people' }, { sort: C.PRESET.similar.sort, preset: 'similar' }, { sort: [], preset: null, family: 'teal' }, { sort: [{ key: 'shotSize', dir: 1 }], preset: null }]) {
    assert.ok(C.viewNeedsTier2(view), JSON.stringify(view));
  }
  assert.ok(C.viewNeedsTier2({ sort: [], preset: null }, ['bread']), 'a search reads Tier 2');
  for (const view of [soft, { sort: [], preset: null }, { sort: C.PRESET.shoot.sort, preset: 'shoot' }, { sort: [{ key: 'luma', dir: 1 }], preset: null }]) {
    assert.ok(!C.viewNeedsTier2(view), JSON.stringify(view));
  }
  assert.match(C.footState(facts({ store, scan, view: { sort: [], preset: null }, query: 'bread', needsTier2: true })).wait, /^This search needs every clip/);
});

test('Add Columns writes Tier 2 fields only once they have landed', () => {
  assert.deepStrictEqual(C.columnFields(false).map(f => f.name), ['SelectRank', 'SelectSharpness', 'SelectLuma', 'SelectClipHigh', 'SelectMotion', 'SelectAudio']);
  assert.equal(C.columnFields(true).length, 13);
  const sent = { fields: C.columnFields(false), rows: [{ ids: ['1'], values: {} }] };
  assert.equal(C.writeOutcome('columns', sent, { ok: true, changed: 1, matched: 1, failed: [], columns: { shown: true } }).verdict, 'Added 6 columns');
});

test('a Tier 2 reason is kept apart from Tier 1, shown quietly, and never called a picture problem', () => {
  const s = t2Store([{ path: '/v/a.mp4', skip: true }]);
  C.ingest(s, clipLine('/v/a.mp4', 2, { moments: 0, people: null, labels: null, text: null, palette: null, colorChroma: null, colorLight: null, colorName: null, reason: 'Looking closer took too long, so it was left out. Its scores stand.' }));
  const row = s.rows[0];
  assert.equal(row.reason, undefined, 'Tier 1 reason untouched');
  assert.equal(s.noPicture.clips, 0, 'not counted as blank picture scores');
  assert.equal(s.tier2Failed, 1);
  assert.equal(C.noPictureWords(row), 'Looking closer took too long, so it was left out.');
  assert.equal(row.sharpness, .5);
  assert.equal(C.cellText(row, C.COLUMN.colorName), '');
  assert.equal(row.rainbow, null);
  assert.equal(C.matches(row, C.searchTokens('a.mp4')), true, 'null lists do not break search');
  assert.equal(C.tileFact(row, { sort: [], preset: null }), '0:05.0');
  assert.ok(C.ingest(s, { type: 'groups', groups: [] }), 'an empty groups line is fine');
  assert.deepStrictEqual(s.groups, []);
  assert.equal(C.dataStatus(s.rows, 'similar', false), 'none');
});

test('tooltips say only what the engine does', () => {
  assert.equal(C.COLUMN.whiteBalanceK, undefined, 'no white balance: Sony records a mode, not kelvin');
  const words = C.COLUMNS.map(c => c.tip || '').concat(C.PRESETS.map(p => p.tip + p.says)).join(' ');
  assert.ok(!/white balance|kelvin|\bWB\b/i.test(words));
  assert.ok(!/less certain|reads flat/i.test(words), 'S-Log is graded before colour is read');
  assert.ok(!/most (cameras|do not)|record none/i.test(words), 'most files carry gyro data');
  assert.match(C.COLUMN.colorName.tip, /S-Log3/);
  assert.match(C.COLUMN.shotSize.tip, /head/);
  assert.match(C.COLUMN.screenText.tip, /four letters/);
});

test('public: the panel carries nothing private, and asks nothing of the network', () => {
  const words = ['T' + '9', 'CHAR' + 'LES', 'MA' + 'SH', 'IO' + 'TA', 'Rom' + 'ain', '/Us' + 'ers/', '\\.co' + 'dex', 'premiere-' + 'write', 'EDITOR_' + 'RUNTIME', 'premiere_' + 'lock', 'Cla' + 'ude', 'Anth' + 'ropic'];
  const bad = new RegExp(words.join('|'));
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.name === 'out' || e.name === 'bin' || e.name === '.DS_Store') { return []; }
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
  const root = path.join(__dirname, '..');
  const files = walk(root);
  assert.ok(files.length >= 10);
  for (const f of files) {
    const hit = fs.readFileSync(f, 'utf8').match(bad);
    assert.ok(!hit, `${path.relative(root, f)}: ${hit && hit[0]}`);
  }
  for (const f of ['app.js', 'core.js', 'native.js', 'index.html']) {
    const text = fs.readFileSync(path.join(root, 'client', f), 'utf8').replace('http://www.w3.org', '').replace('https://github.com/skyfallstatus/select/issues/new', '');
    assert.ok(!/https?:\/\/|XMLHttpRequest|fetch\(|WebSocket|sendBeacon/.test(text), f);
  }
});
