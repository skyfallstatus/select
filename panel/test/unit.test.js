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

// Runs fn with this process in another time zone. Node reads TZ again whenever it changes.
function inZone(tz, fn) {
  const was = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally { if (was === undefined) { delete process.env.TZ; } else { process.env.TZ = was; } }
}

// A view is two questions and a colour: what to show, and in what order.
const V = over => ({ show: null, sort: [], families: [], ...over });
const by = (key, dir) => ({ key, dir });

// The engine's similar-shot groups for fixture records, made the way the fake engine makes them.
function fixtureGroups(records) {
  const looks = new Map();
  for (const r of records) {
    if (!r.error && r.index % 11 <= 2 && r.tier2 && r.tier2.moments) {
      if (!looks.has(r.look)) { looks.set(r.look, []); }
      looks.get(r.look).push(r.path);
    }
  }
  return [...looks.values()].filter(g => g.length > 1).map((g, i) => ({ id: i + 1, paths: g }));
}

// A verdict word may appear in a tip only to deny it, as in "It does not pick the best take."
const VERDICT = /\b(bad|blurry|out of focus|unusable|ruined|best|better|worst|good|nice|quality)\b/i;
function noVerdict(text, what) {
  for (const sentence of String(text).split(/(?<=\.)\s+/)) {
    if (VERDICT.test(sentence)) { assert.match(sentence, /\b(not|never|no|nothing)\b/, what + ': ' + sentence); }
  }
}

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
  assert.equal(inZone('UTC', () => C.cellText({ createdAt: '2023-11-02T16:45:07.000000Z' }, C.COLUMN.createdAt)), '2023-11-02 16:45');
  assert.equal(inZone('Europe/Paris', () => C.cellText({ createdAt: '2023-11-02T16:45:07.000000Z' }, C.COLUMN.createdAt)), '2023-11-02 17:45');
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
      const v = C.computeView(s.rows, V({ sort: [{ key: c.key, dir }, { key: 'name', dir: 1 }] }));
      const ms = performance.now() - t0;
      assert.equal(v.order.length, 1000);
      if (ms > worst) { worst = ms; worstKey = c.key; }
    }
  }
  console.log(`  worst ${worst.toFixed(2)} ms on ${worstKey}`);
  assert.ok(worst <= 16, `worst sort ${worst} ms on ${worstKey}`);
});

test('sorts on the synthetic fixture: every Sort entry, both ways, keeps every clip with empty values last', () => {
  const s = storeFromFixture(fixture), rows = s.rows;
  const field = key => (key === 'createdAt' ? 'time' : key === 'colorName' ? 'rainbow' : key);
  const known = v => v !== null && v !== undefined && v === v;
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  for (const e of C.SORTS) {
    for (const dir of [e.dir, -e.dir]) {
      const list = byOrder(rows, C.computeView(rows, V({ sort: [by(e.key, dir)] })).order);
      assert.equal(list.length, rows.length, e.key + ' keeps every clip');
      const f = field(e.key), has = list.map(r => known(r[f]));
      assert.ok(has.lastIndexOf(true) < (has.indexOf(false) === -1 ? Infinity : has.indexOf(false)), `${e.key} ${dir}: empty values last`);
      const vals = list.map(r => r[f]).filter(known);
      assert.ok(vals.length > 10, e.key + ' has values in the fixture');
      const cmp = typeof vals[0] === 'string' ? (a, b) => collator.compare(a, b) : (a, b) => a - b;
      assert.ok(vals.every((x, i) => !i || cmp(vals[i - 1], x) * dir <= 0), `${e.key} ${dir}: in order`);
    }
  }
  const shoot = byOrder(rows, C.computeView(rows, V({ sort: [by('createdAt', 1)] })).order);
  assert.ok(isNaN(shoot[shoot.length - 1].time), 'undated clips last');
  // Choosing nothing leaves nothing behind: every row, in the order listed, and no group numbers.
  const plain = C.computeView(rows, V());
  assert.deepStrictEqual(plain.order, rows.map((r, i) => i));
  assert.ok(rows.every(r => r.dupGroup === null));
});

test('shows on the synthetic fixture: each keeps exactly what it says, in the order listed', () => {
  const s = storeFromFixture(fixture), rows = s.rows;
  C.ingest(s, { type: 'groups', groups: fixtureGroups(fixture) });
  const view = (show, sort) => { const r = C.computeView(rows, V({ show, sort: sort || [] })); return { ...r, list: byOrder(rows, r.order) }; };
  const descending = (list, key) => { const v = list.map(r => r[key]).filter(x => x !== null && x !== undefined); return v.every((x, i) => !i || v[i - 1] >= x); };

  const silent = view('silent').list;
  assert.ok(silent.length > 0 && silent.length < rows.length);
  assert.ok(silent.every(r => r.hasAudio === false || r.silent === true));
  assert.equal(silent.length, rows.filter(r => r.hasAudio === false || r.silent === true).length);

  const heard = r => (r.sounds || []).filter(x => x.name === 'speech').map(x => x.conf)[0] || 0;
  const interview = r => heard(r) >= C.INTERVIEW_SPEECH && r.faces > 0 && r.shotSize === 'medium' && r.durationS >= C.INTERVIEW_MIN_S;
  const iv = view('interviews', [by('durationS', -1)]).list;
  assert.ok(iv.length > 0);
  assert.ok(iv.every(interview), 'speech heard at 0.7 or more, a face, a medium shot, 15 s or longer');
  assert.equal(iv.length, rows.filter(interview).length, 'and nothing that qualifies is lost');
  assert.ok(iv.some(r => r.shake === null) && iv.some(r => typeof r.shake === 'number'), 'shake plays no part');
  assert.ok(rows.some(r => r.speech === true && r.faces > 0 && r.durationS < C.INTERVIEW_MIN_S && !iv.includes(r)), 'short talking clips are left out');
  assert.ok(rows.some(r => r.speech === true && r.faces > 0 && r.durationS >= C.INTERVIEW_MIN_S && r.shotSize === 'wide' && !iv.includes(r)), 'a wide shot is left out');
  assert.ok(descending(iv, 'durationS'));

  for (const sh of C.SHOWS.filter(x => !x.group)) {
    const v = view(sh.id);
    assert.ok(v.order.length > 0, sh.id + ' finds something in the fixture');
    assert.equal(v.order.length, C.showCount(rows, sh.id), sh.id);
    assert.ok(v.order.every((x, i) => !i || v.order[i - 1] < x), sh.id + ' keeps the listed order');
    assert.ok(!v.hasGroups && v.groupCount === 0 && !v.breaks.length, sh.id);
  }

  const sim = view('similar', [by('sharpness', -1)]);
  assert.ok(sim.hasGroups && sim.groupCount > 1);
  assert.equal(sim.groupCount, s.groups.length);
  assert.equal(sim.order.length, C.showCount(rows, 'similar'));
  assert.ok(sim.list.every(r => r.dupGroup !== null));
  for (let g = 1; g <= sim.groupCount; g++) {
    const at = sim.list.map((r, i) => (r.dupGroup === g ? i : -1)).filter(i => i >= 0);
    assert.ok(at.length >= 2);
    assert.equal(at[at.length - 1] - at[0], at.length - 1, 'a group stays whole');
    assert.ok(descending(at.map(i => sim.list[i]), 'sharpness'), 'sharpest first in a group');
    const sent = new Set(s.groups[g - 1].paths);
    assert.ok(at.every(i => sent.has(sim.list[i].path)), 'groups keep the engine\'s order');
  }
  C.computeView(rows, V({ sort: [by('sharpness', -1)] }));
  assert.ok(rows.every(r => r.dupGroup === null), 'leaving Similar shots leaves no group numbers');
});

test('shows and sorts stay honest: relative words, no verdicts, every tip says what it measures', () => {
  for (const s of C.SHOWS) {
    assert.ok(s.tip.length > 40, s.id);
    assert.ok(s.label && !('says' in s), s.id);
    assert.ok(!VERDICT.test([s.label, s.none || '', s.waiting || ''].join(' ')), s.id);
    noVerdict(s.tip, s.id);
  }
  for (const e of C.SORTS) {
    assert.ok(!VERDICT.test(e.label + ' ' + e.ways.join(' ')), e.key);
    for (const w of e.ways) { assert.match(w, / first$|^Rainbow |^[A-Z] to [A-Z]$/, e.key + ' reads as an order: ' + w); }
    noVerdict(C.COLUMN[e.key].tip || '', e.key);
  }
  for (const c of C.COLUMNS) {
    assert.ok(!/\b(bad|blurry)\b/i.test((c.tip || '') + (c.words || []).join(' ')), c.key);
  }
  assert.match(C.SHOW.similar.tip, /does not pick the best take/, 'Similar shots says outright that it picks nothing');
});

test('removed: presets, near duplicates, close-ups and white balance are gone, not left half-wired', () => {
  for (const name of ['PRESETS', 'PRESET', 'GROUPS', 'nearDuplicateGroups', 'hamming', 'NEAR_DUP_BITS', 'sortName', 'viewWords', 'presetCount']) {
    assert.equal(C[name], undefined, name);
  }
  assert.ok(!C.SHOWS.some(s => /close|dup/i.test(s.id + s.label)));
  assert.ok(!C.SORTS.some(s => s.key === 'dupGroup' || s.key === 'dhash'));
  assert.equal(C.COLUMN.whiteBalanceK, undefined);
  const words = C.COLUMNS.map(c => (c.tip || '') + ' ' + c.label).concat(C.SHOWS.map(s => [s.label, s.tip, s.says, s.none, s.waiting].join(' ')), C.SORTS.map(s => s.label + ' ' + s.ways.join(' '))).join(' ');
  assert.ok(!/near.?duplicate|dhash|close-?up|hamming/i.test(words), 'nothing still speaks of them');
  assert.equal(C.cellText({ shotSize: 'medium' }, C.COLUMN.shotSize), 'Medium');
  assert.equal(C.cellText({ shotSize: 'wide' }, C.COLUMN.shotSize), 'Wide');
});

test('bins: fifths of a number sort, words follow direction, no value kept apart, every row once', () => {
  const s = storeFromFixture(fixture);
  const view = V({ sort: [by('sharpness', -1)] });
  const v = C.computeView(s.rows, view);
  const list = byOrder(s.rows, v.order);
  const b = C.bucketize(list, view);
  assert.equal(b[0].name, '01 Sharpest');
  assert.equal(b[4].name, '05 Softest');
  assert.equal(b[5].name, '06 No value');
  assert.equal(b.reduce((n, x) => n + x.rows.length, 0), list.length);
  assert.ok(b.slice(0, 5).every(x => Math.abs(x.rows.length - b[0].rows.length) <= 1));
  assert.ok(Math.min(...b[0].rows.map(r => r.sharpness)) >= Math.max(...b[4].rows.map(r => r.sharpness)));
  const upView = V({ sort: [by('sharpness', 1)] });
  const up = C.bucketize(byOrder(s.rows, C.computeView(s.rows, upView).order), upView);
  assert.deepStrictEqual(up.map(x => x.name), ['01 Softest', '02 Softer', '03 Middle', '04 Sharper', '05 Sharpest', '06 No value']);
  const empties = C.bucketize([{ name: 'a', sharpness: null }, { name: 'b', sharpness: 0.2 }], view);
  assert.deepStrictEqual(empties.map(x => x.name), ['01 Sharpest', '06 No value']);
  const steadyView = V({ sort: [by('shake', C.naturalDir('shake'))] });
  const steady = C.bucketize(byOrder(s.rows, C.computeView(s.rows, steadyView).order), steadyView);
  assert.deepStrictEqual(steady.map(x => x.name), ['01 Steadiest', '02 Steadier', '03 Middle', '04 Shakier', '05 Shakiest', '06 No value'], 'shake starts steadiest');
  assert.equal(C.bucketize(list, V()), null);
  assert.equal(C.bucketize(list, V({ sort: [by('name', 1)] })), null, 'a name order has nothing to bin by');
  assert.equal(C.sortWords(by('luma', 1)), 'Darkest first');
  assert.equal(C.sortWords(by('sharpness', 1)), 'Softest first');
  assert.equal(C.sortWords(by('camera', 1)), 'Camera A to Z');
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
  assert.deepStrictEqual(C.computeView(s.rows, V({ sort: [by('sharpness', 1)] })).order, [0], 'blank scores still list');
});

test('no picture: the foot explains it once, and calmly', () => {
  const noDecoder = "This Mac has no decoder for H.264 10-bit, and ffmpeg isn't installed. File details are fine, picture scores are blank.";
  const tally = reasons => { const s = C.createStore(); reasons.forEach((r, i) => { C.addItems(s, [{ path: '/v/' + i + '.mp4' }]); C.ingest(s, { type: 'clip', tier: 1, path: '/v/' + i + '.mp4', reason: r }); }); return s.noPicture; };
  assert.equal(C.noPictureSummary(tally([])), '');
  assert.equal(C.noPictureSummary(tally([noDecoder])), "1 clip has no picture scores: this Mac has no decoder for it, and ffmpeg isn't installed.");
  assert.equal(C.noPictureSummary(tally([noDecoder, noDecoder])), "2 clips have no picture scores: this Mac has no decoder for them, and ffmpeg isn't installed.");
  assert.equal(C.noPictureSummary(tally(["This Mac couldn't decode a frame from this clip, and ffmpeg isn't installed. Rest."])), "1 clip has no picture scores: this Mac couldn't decode it, and ffmpeg isn't installed.");
  assert.equal(C.noPictureSummary(tally(["This Mac has no decoder for X, and ffmpeg couldn't read it either. Rest.", noDecoder])), "2 clips have no picture scores: this Mac couldn't decode them.");
  const store = { total: 301, tier0: 301, tier1: 301, errors: 0, bad: 0, noPicture: tally([noDecoder, noDecoder]) };
  const f = C.footState(facts({ store }));
  assert.equal(f.sentence, "2 clips have no picture scores: this Mac has no decoder for them, and ffmpeg isn't installed.");
  assert.equal(f.mark, 'done', 'a finished scan, not a failed one');
  assert.equal(f.verdict, 'Softest first');
  assert.match(C.footState(facts({ store, view: V() })).sentence, /^2 clips have no picture scores/);
  assert.equal(C.footState(facts({ store, selected: 4 })).sentence.indexOf('blank'), -1, 'a selection has its own line');
  assert.equal(C.footState(facts({ store, shown: 12, view: V({ show: 'silent' }) })).sentence, "12 of 301 clips. 2 clips have no picture scores: this Mac has no decoder for them, and ffmpeg isn't installed.", 'a count and the reason stay two sentences');
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
    project: { name: 'x', path: '/x' }, connected: true, title: 'x', listing: false, busy: null, outcome: null, store, rows: 301, shown: 301, selected: 0, groupCount: 0,
    view: V({ sort: [by('sharpness', 1)] }), scan: { state: 'Done', failure: null, seconds: 1.84, stopping: false }, ...over
  };
}

test('foot: before scanning, the status is what Scan would read', () => {
  const target = { kind: 'project', sig: '', items: [{ path: '/v/a.mp4' }, { path: '/v/b.mov' }, { path: '/v/b.mov' }, { path: '/v/c.wav' }], places: [], more: 0 };
  const f = C.footState(facts({ scan: null, rows: 0, shown: 0, view: V(), target }));
  assert.equal(f.kind, 'target');
  assert.equal(f.mark, 'waiting');
  assert.equal(f.verdict, 'Whole project');
  assert.equal(f.sentence, '2 clips', 'video only, one per file, as a scan makes rows');
  assert.deepStrictEqual(f.actions, ['scan']);
  assert.equal(f.primary, 'scan');
  assert.equal(f.scanTip, 'Whole project \u00b7 2 clips');
  assert.equal(f.tip, 'x', 'the project, in the tooltip');
  assert.ok(!f.green);
  assert.equal(C.footState(facts({ scan: null, rows: 0, project: null })).verdict, 'No project open');
  assert.deepStrictEqual(C.footState(facts({ scan: null, rows: 0, project: null })).actions, [], 'nothing to scan');
  assert.equal(C.footState(facts({ scan: null, rows: 0, project: null, connected: false })).verdict, 'Waiting for Premiere');
  assert.equal(C.footState(facts({ scan: null, rows: 0, target: null })).verdict, 'Waiting for Premiere', 'before the first answer');
});

test('foot: scanning', () => {
  const store = { total: 301, tier0: 301, tier1: 210, errors: 4, bad: 0 };
  const f = C.footState(facts({ store, scan: { state: 'Scanning', failure: null, seconds: 1.8, stopping: false } }));
  assert.equal(f.mark, 'running');
  assert.equal(f.verdict, 'Reading 214 of 301');
  assert.equal(f.sentence, '', 'one line: the count is the progress');
  assert.deepStrictEqual(f.actions, ['stop']);
  assert.equal(f.meter, undefined, 'no bar');
  assert.ok(!f.green);
});

test('foot: finished, with Scan gone from the foot', () => {
  const f = C.footState(facts());
  assert.equal(f.mark, 'done');
  assert.equal(f.verdict, 'Softest first');
  assert.equal(f.sentence, '', 'a sort keeps every clip, so there is nothing to add');
  assert.deepStrictEqual(f.actions, ['sequence', 'bins'], 'Add Columns is gone since 0.4, Make Sequence is new, Label is in the right-click menu');
  assert.equal(f.primary, 'bins');
  assert.ok(!f.binsOff && !f.green);
  const unsorted = C.footState(facts({ view: V() }));
  assert.equal(unsorted.verdict, '301 clips read');
  assert.equal(unsorted.sentence, '');
  assert.ok(unsorted.binsOff, 'bins need a show, a sort, a colour, a search or picked clips');
  assert.equal(unsorted.primary, 'bins', 'with no bins to make, Sort into Bins is off and there is no blue: it never hops to Make Sequence');
  assert.equal(C.footState(facts({ selected: 4 })).verdict, '4 of 301 clips selected');
  assert.equal(C.footState(facts({ selected: 4 })).sentence, '');
  const filtered = C.footState(facts({ shown: 12, view: V({ show: 'silent' }) }));
  assert.equal(filtered.verdict, 'Silent');
  assert.equal(filtered.sentence, '12 of 301 clips');
  assert.ok(!filtered.binsOff);
  const groups = C.footState(facts({ shown: 90, groupCount: 30, view: V({ show: 'similar', sort: [by('sharpness', -1)] }) }));
  assert.equal(groups.verdict, 'Similar shots, sharpest first');
  assert.equal(groups.sentence, '30 groups');
  const bright = C.footState(facts({ view: V({ sort: [by('luma', -1)] }) }));
  assert.equal(bright.verdict, 'Brightest first');
  assert.equal(bright.sentence, '');
});

test('foot: a new Premiere selection outside the results adds a grey Scan, and the words and the old results stay', () => {
  const was = C.footState(facts({ scan: { state: 'Done', seconds: 2, failure: null } }));
  assert.ok(!was.actions.includes('scan'));
  const target = { kind: 'clips', sig: '9:a:b', places: ['Day 3'], more: 0, items: [] };
  const f = C.footState(facts({ scan: { state: 'Done', seconds: 2, failure: null }, target, others: 8 }));
  assert.deepStrictEqual(f.actions, ['sequence', 'bins', 'scan'], 'Scan comes last');
  assert.equal(f.primary, 'bins', 'the blue never moves when he clicks in Premiere');
  assert.equal(f.verdict, was.verdict);
  assert.equal(f.sentence, was.sentence);
  assert.equal(f.scanWhat, 'target');
  assert.equal(f.scanTip, '8 other clips selected \u00b7 Day 3');
});

test('foot: stopped, failed, and nothing readable', () => {
  const stopped = C.footState(facts({ store: { total: 301, tier0: 200, tier1: 120, errors: 0, bad: 0 }, scan: { state: 'Stopped', failure: null, seconds: 1, stopping: false } }));
  assert.equal(stopped.verdict, 'Stopped');
  assert.equal(stopped.sentence, '120 of 301 clips read', 'one line, no full stop');
  assert.equal(stopped.primary, 'scan');
  const failed = C.footState(facts({ scan: { state: 'Failed', failure: C.engineFailure({ errorCode: 'ENOENT' }, 0), seconds: 0, stopping: false } }));
  assert.equal(failed.mark, 'failed');
  assert.match(failed.sentence, /not installed/);
  assert.ok(failed.actions.includes('scan'));
  const none = C.footState(facts({ store: { total: 3, tier0: 0, tier1: 0, errors: 3, bad: 0 }, rows: 3, shown: 3 }));
  assert.equal(none.verdict, 'Nothing could be read');
  assert.equal(none.mark, 'look');
});

// Items as the panel sends them: [id, media path].
const pairs = (...ids) => ids.map(id => [id, '/v/C' + id + '.MP4']);
const binsSent = () => ({ root: 'R', buckets: [{ name: '01 Softest', items: pairs('1', '2') }, { name: '02 Softer', items: pairs('3') }] });
// What the host said it moved, batch by batch, merged.
const placedAll = () => [{ name: '01 Softest', ids: ['1', '2'] }, { name: '02 Softer', ids: ['3'] }];

test('green: only when what was read back matches what was sent', () => {
  const bins = C.writeOutcome('bins', binsSent(), { ok: true, moved: 3, failed: [], placed: placedAll(), buckets: [{ name: '01 Softest', ids: ['2', '1'] }, { name: '02 Softer', ids: ['3'] }] });
  assert.equal(bins.green, true);
  assert.equal(bins.verdict, 'Sorted into 2 bins');
  assert.equal(bins.sentence, '', 'a proved write needs no words beyond its verdict');
  const foot = C.footState(facts({ outcome: bins }));
  assert.ok(foot.green);
  assert.equal(foot.mark, 'seal');
  assert.deepStrictEqual(foot.actions, ['undo']);

  const label = C.writeOutcome('label', { items: pairs('1', '2') }, { ok: true, changed: 2, failed: [] }, 'Mango');
  assert.equal(label.green, true);
  assert.equal(label.verdict, 'Labelled 2 clips Mango');
});

test('green: never on a partial or unconfirmed write, whatever the host calls it', () => {
  const never = o => { assert.ok(!o.green, o.verdict); assert.ok(!C.footState(facts({ outcome: o })).green); assert.equal(C.footState(facts({ outcome: o })).mark, 'look'); return o; };
  // One clip stayed behind, and the host still said ok.
  let o = never(C.writeOutcome('bins', binsSent(), { ok: true, moved: 3, failed: [], placed: placedAll(), buckets: [{ name: '01 Softest', ids: ['1'] }, { name: '02 Softer', ids: ['3'] }] }));
  assert.equal(o.verdict, 'Moved 2 of 3 clips');
  assert.equal(o.sentence, '1 clip didn\'t land.');
  // In the wrong bin.
  o = never(C.writeOutcome('bins', binsSent(), { ok: true, moved: 3, failed: [], placed: placedAll(), buckets: [{ name: '01 Softest', ids: ['1', '3'] }, { name: '02 Softer', ids: ['2'] }] }));
  assert.equal(o.verdict, 'Moved 1 of 3 clips');
  // A stranger in the bin.
  o = never(C.writeOutcome('bins', binsSent(), { ok: true, moved: 3, failed: [], placed: placedAll(), buckets: [{ name: '01 Softest', ids: ['1', '2', '9'] }, { name: '02 Softer', ids: ['3'] }] }));
  // A failure listed, even with every id back.
  never(C.writeOutcome('bins', binsSent(), { ok: true, moved: 3, failed: [{ id: 'x', error: 'e' }], placed: placedAll(), buckets: [{ name: '01 Softest', ids: ['1', '2'] }, { name: '02 Softer', ids: ['3'] }] }));
  // A host with no read-back at all.
  o = never(C.writeOutcome('bins', binsSent(), { ok: true, moved: 3, failed: [], placed: placedAll(), buckets: [{ name: '01 Softest', moved: 2, inBin: 2 }, { name: '02 Softer', moved: 1, inBin: 1 }] }));
  assert.equal(o.verdict, 'Moved, not confirmed');
  // A bin that did not come back.
  never(C.writeOutcome('bins', binsSent(), { ok: true, moved: 2, failed: [], placed: placedAll(), buckets: [{ name: '01 Softest', ids: ['1', '2'] }] }));
  o = never(C.writeOutcome('bins', binsSent(), { ok: true, moved: 0, failed: [], buckets: [] }));
  assert.equal(o.verdict, 'Nothing moved');
  assert.equal(o.undo, false);

  o = never(C.writeOutcome('label', { items: pairs('1', '2') }, { ok: true, changed: 1, failed: [{ id: '2', error: 'label did not change' }] }, 'Mango'));
  assert.equal(o.verdict, 'Labelled 1 of 2 clips');
  assert.deepStrictEqual(C.footState(facts({ outcome: o })).actions, ['details', 'undo']);
});

test('undo words: never green, and honest about what stayed', () => {
  assert.equal(C.undoOutcome({ restored: 301, skipped: 0, failed: [] }).sentence, '');
  const some = C.undoOutcome({ restored: 5, skipped: 1, failed: [] });
  assert.match(some.sentence, /1 changed since, left alone/);
  assert.ok(!some.green);
  assert.equal(C.footState(facts({ outcome: C.undoOutcome({ restored: 1, skipped: 0, failed: [] }) })).mark, 'done');
  // An Undo's outcome never offers Undo on the status: a second click would take back an older write.
  [{ restored: 1, skipped: 0, failed: [] }, { restored: 1, skipped: 0, failed: [{ id: '2', error: 'x' }] }, { restored: 0, skipped: 2, failed: [] }].forEach(res => {
    const o = C.undoOutcome(res), shown = C.footState(facts({ outcome: o }));
    assert.ok(['Undone', 'Partly undone', 'Nothing went back'].includes(o.verdict));
    assert.ok(!shown.actions.includes('undo'), o.verdict + ': ' + shown.actions.join());
  });
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
  assert.deepStrictEqual(light, { ink: '#1D1D1F', ink2: '#5F6063', ink3: '#8E8E93', surface: '#FFFFFF', foot: '#F4F4F6', disc: '#E7E7EC', tick: '#3A3A3C', ring: '#C9C9CE', track: '#E9E9EE', meter: '#6E6E73', 'focus-ring': '#2563EB', cobalt: '#2563EB', bad: '#C9281C', safe: '#15803D', 'safe-ink': '#0F6E31',
    band: '#F3F3F5', edge: '#A9A9AE', sel: '#E4E4E9', warn: '#B25B00' });
  assert.deepStrictEqual(dark, { ink: '#EDEDEE', ink2: '#ADADB1', ink3: '#7C7C82', surface: '#26262A', foot: '#1C1C1F', disc: '#3A3A40', tick: '#EDEDEE', ring: '#55555C', track: '#3A3A40', meter: '#A0A0A6', 'focus-ring': '#4A82EB', cobalt: '#2F6FE6', bad: '#FF6A5F', safe: '#15803D', 'safe-ink': '#34C759',
    band: '#313135', edge: '#606066', sel: '#434349', warn: '#F5A524' });
  for (const t of [light, dark]) {
    for (const [fg, bg] of [[t.ink, t.surface], [t.ink2, t.surface], [t.ink, t.foot], [t.ink2, t.foot], [t.ink, t.disc], [t.ink2, t.disc], [t.ink, t.track], [t.bad, t.foot], ['#FFFFFF', t.cobalt], ['#FFFFFF', t.safe], [t.safe, '#FFFFFF'], [t['safe-ink'], t.surface], [t['safe-ink'], t.foot],
      [t.ink, t.band], [t.ink2, t.band], [t.ink, t.sel]]) {
      assert.ok(contrast(fg, bg) >= 4.5, `${fg} on ${bg}: ${contrast(fg, bg).toFixed(2)}`);
    }
    // The coloured icons of the band need 3:1, on it and on the ground.
    for (const [fg, bg] of [[t.warn, t.band], [t.warn, t.surface], [t.bad, t.band], [t['safe-ink'], t.band], [t['focus-ring'], t.surface], [t['focus-ring'], t.foot], [t['focus-ring'], t.band]]) {
      assert.ok(contrast(fg, bg) >= 3, `${fg} on ${bg}: ${contrast(fg, bg).toFixed(2)}`);
    }
  }
  assert.ok(contrast(light.ink3, light.surface) < 4.5, 'ink3 stays for placeholders only');
  // ink3 is for a placeholder and for the words of a button that is off: never for words that have to be read.
  assert.ok(!/color:\s*var\(--ink3\)/.test(css.replace(/#(folder|search)::placeholder \{[^}]*\}/g, '').replace(/\.action:disabled, \.action\.primary:disabled \{[^}]*\}/, '')), 'ink3 is used by the placeholder and buttons that are off, and by nothing else');
});

test('the ground is Premiere\'s own grey at every brightness, and secondary text still reads at 4.5:1 on it', () => {
  for (const v of [29, 35, 50, 75, 100, 127, 128, 160, 184, 214, 240]) {
    const t = C.skinTokens({ red: v, green: v, blue: v });
    const grey = '#' + v.toString(16).padStart(2, '0').toUpperCase().repeat(3);
    if ([29, 35, 50, 75, 184, 214, 240].includes(v)) { assert.equal(t.surface, grey); }
    assert.equal(t.theme, v >= 128 ? 'light' : 'dark');
    const ink = t.theme === 'dark' ? '#EDEDEE' : '#1D1D1F';
    for (const bg of [t.surface, t.foot]) {
      assert.ok(contrast(t.ink2, bg) >= 4.5, `ink2 ${t.ink2} on ${bg}: ${contrast(t.ink2, bg).toFixed(2)}`);
      assert.ok(contrast(ink, bg) >= 4.5, `ink on ${bg}: ${contrast(ink, bg).toFixed(2)}`);
      assert.ok(contrast(t.bad, bg) >= 4.5, `bad ${t.bad} on ${bg}: ${contrast(t.bad, bg).toFixed(2)}`);
    }
    // A selected row is --plate-sel over the ground, and a menu item under the pointer is disc. Both hold ink2.
    const plate = '#' + [1, 3, 5].map(i => parseInt(t.surface.slice(i, i + 2), 16)).map(c => Math.round(t.theme === 'dark' ? c + (255 - c) * 0.11 : c * 0.925).toString(16).padStart(2, '0')).join('').toUpperCase();
    for (const bg of [t.disc, plate]) { assert.ok(contrast(t.ink2, bg) >= 4.5, `${v}: ink2 ${t.ink2} on ${bg}: ${contrast(t.ink2, bg).toFixed(2)}`); }
    // The focus ring and placeholders read at 3:1; secondary text stays apart from ink, and red stays red.
    for (const bg of [t.surface, t.foot]) {
      assert.ok(contrast(t['focus-ring'], bg) >= 3, `${v}: focus ring ${t['focus-ring']} on ${bg}: ${contrast(t['focus-ring'], bg).toFixed(2)}`);
      assert.ok(contrast(t.ink3, bg) >= 3, `${v}: ink3 ${t.ink3} on ${bg}: ${contrast(t.ink3, bg).toFixed(2)}`);
    }
    assert.notEqual(t.ink2, ink, `${v}: secondary text keeps its own grey`);
    const [r, g] = [1, 3].map(i => parseInt(t.bad.slice(i, i + 2), 16));
    assert.ok(r - g >= 60, `${v}: ${t.bad} still reads as red`);
  }
  const css = fs.readFileSync(path.join(__dirname, '../client/style.css'), 'utf8');
  assert.match(css, /:root \{[^}]*--plate-sel: rgba\(0, 0, 0, \.075\);/, 'the light plate skinTokens measures against');
  assert.match(css, /:root\[data-theme="dark"\] \{[^}]*--plate-sel: rgba\(255, 255, 255, \.11\);/, 'the dark plate skinTokens measures against');
  assert.equal(C.skinTokens({ red: 35, green: 35, blue: 35 }).ink2, '#ADADB1');
  assert.equal(C.skinTokens({ red: 35, green: 35, blue: 35 }).bad, '#FF6A5F', 'Premiere\'s default grey keeps Ingest\'s red');
  assert.equal(C.skinTokens(null), null);
});

// A project in memory, shaped as the host script sees Premiere. `lose` drops one id's move, as a failed read-back would show.
// Like Premiere 26.5.2: findItemsMatchingMediaPath matches any part of the path and can leave subclips out, treePath is
// \Project.prproj\Bin\Clip, a copy of a project keeps its documentID, and sequences are made from clips in the order given.
function hostWith(options) {
  const o = options || {}, vm = require('vm');
  let next = 100;
  const descendants = b => b.kids.flatMap(k => (k.type === 2 ? descendants(k) : [k]));
  const treeOf = c => { const names = []; for (let x = c; x; x = x.up) { names.unshift(x === root ? 'p.prproj' : x.name); } return '\\' + names.join('\\'); };
  const bin = name => {
    const b = { type: 2, name, nodeId: next++, kids: [],
      createBin(n) { const c = bin(n); c.up = b; b.kids.push(c); sync(b); return c; },
      deleteBin() { if (b.up) { b.up.kids = b.up.kids.filter(k => k !== b); sync(b.up); } return true; },
      findItemsMatchingMediaPath(text, noSub) { o.searches = (o.searches || 0) + 1; if (text === '/') { o.everything = (o.everything || 0) + 1; } return descendants(b).filter(c => !c.seq && c.getMediaPath().includes(text) && !(noSub && c.sub)); } };
    Object.defineProperty(b, 'treePath', { get: () => treeOf(b) });
    sync(b);
    return b;
  };
  function sync(b) { b.children = { numItems: b.kids.length }; b.kids.forEach((k, i) => { b.children[i] = k; }); }
  const root = bin('root');
  const clip = (id, up, extra) => {
    let meta = '', label = 0;
    const c = { type: 1, name: 'C' + id + '.MP4', nodeId: id, up, isSequence: () => false, getMediaPath: () => '/v/C' + id + '.MP4',
      getColorLabel: () => label, setColorLabel(l) { if (!o.stuckLabel || o.stuckLabel.size === 0 || !o.stuckLabel.has(id)) { label = l; } }, getProjectMetadata: () => meta,
      setProjectMetadata(xmp) { meta = o.dropMetadata ? '' : xmp; return true; },
      moveBin(to) { if (o.lose === id || (o.stuck && o.stuck.size && o.stuck.has(id))) { return 0; } c.up.kids = c.up.kids.filter(k => k !== c); sync(c.up); c.up = to; to.kids.push(c); sync(to); return true; },
      ...extra };
    Object.defineProperty(c, 'treePath', { get: () => treeOf(c) });
    up.kids.push(c); sync(up);
    return c;
  };
  [1, 2, 3].forEach(id => clip(id, root));
  const seqs = [];
  const sequences = () => { const list = { numSequences: seqs.length }; seqs.forEach((q, i) => { list[i] = q; }); return list; };
  // As 26.5.2 does: V1 in the order given, settings from the first clip, and the new sequence opens in the Timeline.
  const list = arr => Object.assign({ numItems: arr.length }, arr);
  const makeSeq = (name, items, into) => {
    if (o.noSequence) { return null; }
    const id = 'seq-' + next, item = clip(next++, into || root, { name, seq: true, isSequence: () => true, getMediaPath: () => '' });
    const v1 = items.map(it => ({ projectItem: it }));
    // Three video and three audio tracks, the clips on V1 and A1, as 26.5.2 makes them.
    const track = clips => ({ clips: list(clips), transitions: { numItems: 0 } }), tracks = arr => Object.assign({ numTracks: arr.length }, arr);
    const q = { sequenceID: id, name, projectItem: item, frameSizeHorizontal: 1920, frameSizeVertical: 1080, timebase: '10160640000', end: String(items.length * 254016000000), zeroPoint: '0',
      videoTracks: tracks([track(v1), track([]), track([])]), audioTracks: tracks([track(v1.slice()), track([]), track([])]), markers: { numMarkers: 0 },
      inPoint: '0', outPoint: String(items.length * 1), getInPoint() { return q.inPoint; }, getOutPoint() { return q.outPoint; }, v1 };
    seqs.push(q);
    project.activeSequence = q;
    return q;
  };
  const project = { path: '/p.prproj', name: 'p.prproj', documentID: 'doc-1', rootItem: root, activeSequence: null, addPropertyToProjectMetadataSchema() {},
    get sequences() { return sequences(); },
    createNewSequenceFromClips: (name, items, into) => makeSeq(name, items, into),
    openSequence(id) { const q = seqs.find(x => x.sequenceID === id); if (q) { project.activeSequence = q; } return !!q; },
    deleteSequence(q) {
      const at = seqs.indexOf(q);
      if (at < 0 || o.keepSequences) { return false; }
      seqs.splice(at, 1);
      if (project.activeSequence === q) { project.activeSequence = null; }
      q.projectItem.up.kids = q.projectItem.up.kids.filter(k => k !== q.projectItem);
      sync(q.projectItem.up);
      return true;
    } };
  let viewSel = [];
  const sandbox = { app: { version: '26', enableQE() {}, project,
    getProjectViewIDs: () => ['view0'], getProjectFromViewID: () => project, getCurrentProjectViewSelection: () => null,
    getProjectViewSelection: () => viewSel, setProjectViewSelection(items) { viewSel = items.slice(); } },
    qe: { getModalWindowID: () => '', project: { getActiveSequence: () => (project.activeSequence ? { player: { isPlaying: false } } : null), undoStackIndex: () => (o.undoAt === undefined ? 7 : o.undoAt) }, source: { player: { isPlaying: false } } } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../host/select.jsx'), 'utf8'), sandbox);
  if (o.noModalCheck) { delete sandbox.qe.getModalWindowID; }
  const all = () => descendants(root).concat(root.kids.filter(k => k.type === 2)).concat(...root.kids.filter(k => k.type === 2).map(k => k.kids.filter(x => x.type === 2)));
  return { call: (fn, args) => JSON.parse(sandbox.slCall(fn, JSON.stringify(args))), root, sandbox, seqs, options: o, addClip: (id, up, extra) => clip(id, up || root, extra),
    clip: id => all().find(c => c.nodeId === id) };
}

const binsArgs = () => ({ project: '/p.prproj', root: 'SELECT x', buckets: [{ name: '01 Softest', items: pairs('1', '2') }, { name: '02 Softer', items: pairs('3') }] });

// Sends a write to the real host script the way the panel does: in batches, merged by the panel's own core.addBatch,
// and for bins read back once at the end. Returns the merged result, with the Undo record as `restore`.
function viaHost(h, kind, sent, size) {
  const acc = C.writeAcc(kind), items = [];
  let list, head = null;
  if (kind === 'label') { list = sent.items; }
  if (kind === 'bins') { list = sent.buckets.flatMap(b => b.items.map(p => ({ name: b.name, pair: p }))); }
  for (const part of C.batches(list, size || C.BATCH)) {
    const args = kind === 'label' ? { project: '/p.prproj', items: part, color: sent.color }
      : { project: '/p.prproj', root: sent.root, buckets: C.groupMoves(part), ...(acc.top ? { top: acc.top } : {}) };
    const res = h.call(kind, args);
    if (!res.ok) { acc.error = res.message; break; }
    C.addBatch(kind, acc, res);
    head = res.restore;
    items.push(...res.restore.items);
  }
  if (kind === 'bins' && acc.top) { Object.assign(acc, h.call('binsCheck', { project: '/p.prproj', top: acc.top, clear: !acc.moved })); }
  acc.restore = head ? { ...head, items } : null;
  return acc;
}

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
  assert.equal(o.undo, false, 'what is left goes back through the ··· menu, never a second click on the status');
  assert.equal(o.kind, 'partial');
  stuck.clear();
  const second = h.call('restore', { project: '/p.prproj', restore: first.remaining });
  assert.equal(second.restored, 1);
  assert.equal(second.remaining, null);
  assert.equal(second.binRemoved, true);
});

test('undo: a label that did not change back is a failure, not a count', () => {
  const stuckLabel = new Set(), h = hostWith({ stuckLabel }), res = h.call('label', { project: '/p.prproj', items: pairs('1', '2'), color: 5 });
  assert.equal(res.changed, 2);
  stuckLabel.add(1);
  const back = h.call('restore', { project: '/p.prproj', restore: res.restore });
  assert.equal(back.restored, 1);
  assert.equal(back.failed.length, 1);
  assert.equal(C.undoOutcome(back).verdict, 'Partly undone');
});

test('undo: an id that now names another clip is left alone', () => {
  const h = hostWith(), res = h.call('label', { project: '/p.prproj', items: pairs('1'), color: 5 });
  h.root.kids[0].getMediaPath = () => '/v/Someone-Else.MP4';
  const back = h.call('restore', { project: '/p.prproj', restore: res.restore });
  assert.equal(back.restored, 0);
  assert.equal(back.skipped, 1);
});

test('undo: an Add Columns record from 0.2 or 0.3 still goes back, markup and all, though 0.4 writes no columns', () => {
  const h = hostWith(), [a, b] = h.root.kids, tag = f => 'premierePrivateProjectMetaData:' + f;
  const wrote = (c, values) => c.setProjectMetadata(Object.entries(values).map(([f, v]) => `<${tag(f)}>${v}</${tag(f)}>`).join(''));
  // As 0.3 left it: the clip holds what Add Columns wrote, and the record holds that and what was there before.
  wrote(a, { SelectRank: '0001', SelectMotion: '0.412' });
  wrote(b, { SelectRank: '0007', SelectMotion: '0.100' });
  const fields = ['SelectRank', 'SelectMotion'];
  const restore = { kind: 'columns', fields, items: [
    { id: '1', path: '/v/C1.MP4', wrote: { SelectRank: '0001', SelectMotion: '0.412' }, was: { SelectRank: 'A&B', SelectMotion: '' } },
    { id: '2', path: '/v/C2.MP4', wrote: { SelectRank: '0002', SelectMotion: '0.300' }, was: { SelectRank: '', SelectMotion: '' } }] };
  const back = h.call('restore', { project: '/p.prproj', restore, final: true, write: 'undo-1' });
  assert.ok(back.ok);
  assert.equal(back.restored, 1);
  assert.equal(back.skipped, 1, 'a clip whose values changed since is left alone');
  assert.ok(a.getProjectMetadata().includes('>A&amp;B<'));
  assert.ok(!a.getProjectMetadata().includes('&amp;amp;'));
  assert.ok(b.getProjectMetadata().includes('>0007<'));
  assert.equal(C.undoWords({ kind: 'columns', restore }), 'Puts back what the Select columns held on 2 clips before this write.');
  // Nothing in 0.4 writes columns any more.
  assert.equal(h.call('columns', { project: '/p.prproj', fields: [], rows: [] }).code, 'unknown-call');
  assert.equal(C.FIELDS, undefined);
  assert.equal(C.columnValues, undefined);
});

test('bins: a failure part way through keeps what is needed to undo the clips that moved', () => {
  const h = hostWith(), real = h.root.createBin.bind(h.root);
  h.root.createBin = name => {
    const top = real(name), inner = top.createBin.bind(top);
    let calls = 0;
    top.createBin = n => { if (++calls === 2) { throw new Error('no more bins'); } return inner(n); };
    return top;
  };
  const sent = binsArgs(), res = viaHost(h, 'bins', sent);
  assert.ok(!res.error, 'not a bare failure');
  assert.equal(res.moved, 2);
  assert.equal(res.restore.items.length, 2);
  assert.ok(res.failed.some(f => /no more bins/.test(f.error)));
  const o = C.writeOutcome('bins', sent, res);
  assert.ok(!o.green);
  assert.equal(o.undo, true);
});

test('bins: when nothing moved, no empty bins stay behind', () => {
  const h = hostWith(), sent = { project: '/p.prproj', root: 'SELECT x', buckets: [{ name: '01 Softest', items: pairs('98') }, { name: '02 Softer', items: pairs('99') }] };
  const res = viaHost(h, 'bins', sent);
  assert.equal(res.moved, 0);
  assert.equal(res.restore.items.length, 0);
  assert.equal(res.skipped.length, 2, 'ids not in the project are left alone, and said');
  assert.equal(res.binRemoved, true);
  assert.ok(!h.root.kids.some(k => k.type === 2));
});

test('guard: a dialog state nobody can read is refused', () => {
  const res = hostWith({ noModalCheck: true }).call('label', { project: '/p.prproj', items: pairs('1'), color: 5 });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'modal-unknown');
  assert.equal(res.message, 'Premiere didn\'t answer. Nothing was written.');
});

test('host: bins report what each bin really holds, and the foot reads it', () => {
  const sent = binsArgs();
  const res = viaHost(hostWith(), 'bins', sent);
  assert.ok(!res.error);
  assert.deepStrictEqual(res.buckets.map(b => b.ids), [['1', '2'], ['3']]);
  assert.equal(C.writeOutcome('bins', sent, res).green, true);
  const lost = viaHost(hostWith({ lose: 2 }), 'bins', sent);
  assert.equal(lost.moved, 3, 'the move call said yes');
  assert.deepStrictEqual(lost.buckets[0].ids, ['1'], 'the bin says otherwise');
  const o = C.writeOutcome('bins', sent, lost);
  assert.ok(!o.green);
  assert.equal(o.verdict, 'Moved 2 of 3 clips');
});

test('product: the panel agrees with product.conf', () => {
  const root = path.join(__dirname, '../..'), file = path.join(root, 'product.conf');
  const conf = Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => l.split('=')));
  const app = fs.readFileSync(path.join(root, 'panel/client/app.js'), 'utf8');
  assert.ok(app.includes(`/bin/${conf.ENGINE}'`), 'engine name');
  // The repository is stamped from product.conf at build time (scripts/stamp-panel.sh), so the source only has to name
  // one, the same in both places, for the build to replace.
  const update = fs.readFileSync(path.join(root, 'panel/client/update.js'), 'utf8');
  const repo = /^  var REPO = '([^']+)';$/m.exec(update)[1];
  assert.ok(app.includes(`var ISSUES_URL = 'https://github.com/${repo}/issues/new';`), 'bug link and updates name one repository');
  assert.match(fs.readFileSync(path.join(root, 'scripts/build-panel.sh'), 'utf8'), /^scripts\/stamp-panel\.sh \$OUT$/m, 'and the build stamps it');
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
  const v = C.computeView(s.rows, V({ sort: [by('colorName', 1)] }));
  assert.deepStrictEqual(names(v.order), ['red', 'redhigh', 'orange', 'green', 'blue', 'pink', 'pinklow', 'logred', 'logblue', 'white', 'grey', 'dark', 'later']);
  const fam = C.computeView(s.rows, V({ sort: [by('colorName', 1)], families: ['blue'] }));
  assert.deepStrictEqual(names(fam.order), ['blue', 'logblue'], 'a family filter keeps flat clips of that family');
  assert.deepStrictEqual(C.familyCounts(s.rows).neutral, 3);
  assert.equal(C.cellText(s.rows[s.rows.length - 1], C.COLUMN.colorName), '', 'unknown stays blank');
  assert.equal(C.nextSort([], 'colorName', false)[0].dir, 1, 'the natural way round is the rainbow');
  assert.equal(C.viewName(V({ sort: [by('colorName', 1)] })), 'Rainbow order');
  assert.equal(C.viewName(V({ sort: [by('colorName', 1)], families: ['blue'] })), 'Blue', 'a colour sorted by colour is just the colour');
  const back = C.computeView(s.rows, V({ sort: [by('colorName', -1)] }));
  assert.deepStrictEqual(names(back.order), ['dark', 'grey', 'white', 'logblue', 'logred', 'pinklow', 'pink', 'blue', 'green', 'orange', 'redhigh', 'red', 'later'], 'reversed, unknown still last');
  assert.equal(C.viewName(V({ sort: [by('colorName', -1)] })), 'Rainbow reversed');
});

test('colour: an all-log shoot is one muted rainbow, not one grey heap', () => {
  const s = t2Store(hues.map(([path, colorHue, colorName]) => ({ path, colorHue, colorName, colorChroma: .06, colorLight: .4 })));
  const v = C.computeView(s.rows, V({ sort: [by('colorName', 1)] }));
  assert.deepStrictEqual(v.order.map(i => s.rows[i].colorName), ['red', 'red', 'orange', 'green', 'blue', 'pink', 'pink']);
  const f = C.bucketize(v.order.map(i => s.rows[i]), V({ sort: [by('colorName', 1)] }));
  assert.deepStrictEqual(f.map(b => b.name), ['01 Red', '02 Orange', '03 Green', '04 Blue', '05 Pink']);
});

test('search: every field, several words narrow it, accents and case fold, and a word must start where it says', () => {
  const s = t2Store([
    { path: '/v/C0148.MP4', camera: 'SONY ILME-FX3', lens: 'FE 24-70mm', labels: [{ name: 'sourdough loaf', conf: .9 }], text: ['Café Lumière'], sounds: [{ name: 'speech', conf: .8 }], shotSize: 'medium', colorName: 'orange', colorHue: 30, colorChroma: .5, colorLight: .5 },
    { path: '/v/C0200.MP4', camera: 'Canon EOS R5', labels: [{ name: 'harbour', conf: .9 }], text: [], sounds: [{ name: 'water', conf: .8 }], shotSize: 'wide', colorName: 'blue', colorHue: 210, colorChroma: .5, colorLight: .5 },
    { path: '/v/not-yet.MP4', skip: true }
  ]);
  const find = q => C.computeView(s.rows, V(), null, { tokens: C.searchTokens(q) }).order.map(i => s.rows[i].name);
  for (const q of ['0148', 'c0148.mp4', 'sourdough', 'loaf', 'cafe', 'LUMIERE', 'speech', 'sony', 'fx3', '24', 'medium', 'MED', 'orange']) { assert.deepStrictEqual(find(q), ['C0148.MP4'], q); }
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
    for (const view of [V(), V({ sort: [by('colorName', 1)] }), V({ show: 'people', sort: [by('people', -1)] }), V({ show: 'interviews', sort: [by('sharpness', -1)], families: ['red'] })]) {
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
  const view = V({ sort: [by('colorName', 1)] });
  const list = byOrder(s.rows, C.computeView(s.rows, view).order);
  const b = C.bucketize(list, view);
  assert.deepStrictEqual(b.map(x => x.name.slice(3)), ['Red', 'Orange', 'Yellow', 'Green', 'Teal', 'Blue', 'Purple', 'Pink', 'Neutral', 'No value']);
  assert.ok(b.every((x, i) => x.name.startsWith(String(i + 1).padStart(2, '0') + ' ')));
  assert.equal(b.reduce((n, x) => n + x.rows.length, 0), list.length);
  assert.ok(b[0].rows.every(r => r.colorName === 'red'));
  const shot = V({ sort: [by('shotSize', C.naturalDir('shotSize'))] });
  const sb = C.bucketize(byOrder(s.rows, C.computeView(s.rows, shot).order), shot);
  assert.deepStrictEqual(sb.map(x => x.name), ['01 Medium', '02 Wide', '03 No value'], 'a word column: a bin per value, in sort order');
  assert.deepStrictEqual(C.bucketize([{ colorName: 'blue' }], view).map(x => x.name), ['01 Blue'], 'numbered among what is there');
  const words = V({ show: 'onscreen' });
  assert.deepStrictEqual(C.bucketize(byOrder(s.rows, C.computeView(s.rows, words).order), words).map(x => x.name), ['01 Text on screen']);
  const quint = V({ sort: [by('people', -1)] });
  assert.equal(C.bucketize(byOrder(s.rows, C.computeView(s.rows, quint).order), quint)[0].name, '01 Most people', 'a count keeps its fifths');
  const header = V({ sort: [by('colorName', -1)] });
  const reversed = C.bucketize(byOrder(s.rows, C.computeView(s.rows, header).order), header);
  assert.deepStrictEqual(reversed.map(x => x.name), b.map(x => x.name), 'colours keep the rainbow\'s order whichever way the rows run');
});

test('host: category bins go through the same write, with the same read-back, and a stray stays unproved', () => {
  const sent = { project: '/p.prproj', root: 'SELECT 2026-11-03 Colour', buckets: [{ name: '01 Red', items: pairs('1', '2') }, { name: '02 Blue', items: pairs('3') }] };
  const res = viaHost(hostWith(), 'bins', sent);
  assert.equal(C.writeOutcome('bins', sent, res).verdict, 'Sorted into 2 bins');
  assert.equal(C.writeOutcome('bins', sent, res).green, true);
  const lost = viaHost(hostWith({ lose: 3 }), 'bins', sent);
  assert.ok(!C.writeOutcome('bins', sent, lost).green);
  assert.ok(lost.restore && lost.restore.items.length, 'Undo still has what it needs');
});

test('groups: arrive last, once, and only for rows the scan knows', () => {
  const harbour = { labels: [{ name: 'harbour', conf: .9 }] };
  const s = t2Store([{ path: '/v/a.mp4', ...harbour }, { path: '/v/b.mp4' }, { path: '/v/c.mp4' }, { path: '/v/d.mp4' }, { path: '/v/e.mp4', ...harbour }]);
  const view = V({ show: 'similar' });
  assert.equal(C.computeView(s.rows, view).order.length, 0, 'nothing before the line');
  assert.equal(C.dataStatus(s.rows, 'similar', true), 'waiting');
  assert.equal(C.dataStatus(s.rows, 'similar', false), 'none');
  assert.equal(C.showCount(s.rows, 'similar'), 0);
  assert.ok(C.ingest(s, { type: 'groups', groups: [{ id: 7, paths: ['/v/c.mp4', '/v/a.mp4', '/v/e.mp4'] }, { id: 9, paths: ['/v/b.mp4', '/v/gone.mp4'] }] }));
  assert.equal(s.rows.length, 5, 'a path the scan does not know adds no row');
  const v = C.computeView(s.rows, view);
  assert.deepStrictEqual(v.order.map(i => s.rows[i].name), ['a.mp4', 'c.mp4', 'e.mp4']);
  assert.equal(v.groupCount, 1, 'a group the scan knows only one clip of is no group');
  assert.deepStrictEqual(v.breaks.map(b => [b.at, b.count, b.number]), [[0, 3, 1]]);
  assert.equal(C.dataStatus(s.rows, 'similar', true), 'ok');
  assert.deepStrictEqual(C.bucketize(v.order.map(i => s.rows[i]), view).map(b => b.name), ['01 Similar, 3 clips']);
  assert.equal(C.showCount(s.rows, 'similar'), 3);
  const searched = C.computeView(s.rows, view, null, { tokens: C.searchTokens('harbour') });
  assert.deepStrictEqual(searched.order.map(i => s.rows[i].name), ['a.mp4', 'e.mp4'], 'a search narrows inside a group');
  assert.deepStrictEqual(searched.breaks.map(b => b.count), [2]);
  assert.equal(C.computeView(s.rows, view, null, { tokens: C.searchTokens('c.mp4') }).order.length, 0, 'a group searched down to one clip is dropped');
});

test('similar shots: groups stay whole in engine order, the sort orders inside each, and a colour renumbers what is left', () => {
  const clip = (n, colorName, sharpness) => ({ path: `/v/s${n}.mp4`, colorName, colorHue: colorName === 'red' ? 25 : 250, colorChroma: .5, colorLight: .5, sharpness });
  const s = t2Store([clip(1, 'red', .2), clip(2, 'blue', .9), clip(3, 'red', .5), clip(4, 'blue', .1), clip(5, 'blue', .8), clip(6, 'red', .3), clip(7, 'red', .7), clip(8, 'red', .6)]);
  C.ingest(s, { type: 'groups', groups: [{ id: 1, paths: ['/v/s1.mp4', '/v/s2.mp4', '/v/s3.mp4'] }, { id: 2, paths: ['/v/s4.mp4', '/v/s5.mp4'] }, { id: 3, paths: ['/v/s6.mp4', '/v/s7.mp4'] }] });
  const run = view => { const v = C.computeView(s.rows, view); return { ...v, names: v.order.map(i => s.rows[i].name.replace('.mp4', '')), groups: v.order.map(i => s.rows[i].dupGroup) }; };

  const sharp = run(V({ show: 'similar', sort: [by('sharpness', -1)] }));
  assert.deepStrictEqual(sharp.names, ['s2', 's3', 's1', 's5', 's4', 's7', 's6'], 'groups in engine order, sharpest first inside each');
  assert.deepStrictEqual(sharp.groups, [1, 1, 1, 2, 2, 3, 3]);
  assert.deepStrictEqual(sharp.breaks.map(b => [b.at, b.count, b.number]), [[0, 3, 1], [3, 2, 2], [5, 2, 3]]);
  assert.equal(s.rows[7].dupGroup, null, 'a clip in no group is not shown');
  const soft = run(V({ show: 'similar', sort: [by('sharpness', 1)] }));
  assert.deepStrictEqual(soft.names, ['s1', 's3', 's2', 's4', 's5', 's6', 's7'], 'flipping the sort flips inside groups, never the groups');
  assert.deepStrictEqual(run(V({ show: 'similar' })).names, ['s1', 's2', 's3', 's4', 's5', 's6', 's7'], 'no sort: listed order inside each');

  const red = run(V({ show: 'similar', sort: [by('sharpness', -1)], families: ['red'] }));
  assert.deepStrictEqual(red.names, ['s3', 's1', 's7', 's6'], 'the blue group is gone');
  assert.deepStrictEqual(red.groups, [1, 1, 2, 2], 'and the rest are numbered 1 to n');
  assert.equal(red.groupCount, 2);
  assert.deepStrictEqual(red.breaks.map(b => b.number), [1, 2]);
  assert.equal(s.rows[1].dupGroup, null, 'a clip filtered out has no group number');
  assert.deepStrictEqual(C.bucketize(red.order.map(i => s.rows[i]), V({ show: 'similar', families: ['red'] })).map(b => b.name), ['01 Similar, 2 clips', '02 Similar, 2 clips']);
  const blue = run(V({ show: 'similar', families: ['blue'] }));
  assert.deepStrictEqual(blue.names, ['s4', 's5'], 'a group filtered down to one clip is dropped');
  assert.deepStrictEqual(blue.groups, [1, 1]);
  assert.equal(C.viewName(V({ show: 'similar', sort: [by('sharpness', -1)], families: ['red'] })), 'Red, similar shots, sharpest first');
  assert.equal(C.showCount(s.rows, 'similar'), 7, 'the menu counts every clip in a group, before any colour');
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
  assert.equal(C.notUnderstoodSummary(s), '2 clips couldn\'t be looked at closely.');
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
  assert.equal(C.cellText({ shotSize: 'medium' }, C.COLUMN.shotSize), 'Medium');
  const s = t2Store([{ path: '/v/a.mp4', people: null, faces: null }]);
  assert.equal(C.computeView(s.rows, V({ show: 'nopeople' })).order.length, 0, 'unknown is not no people');
  assert.equal(C.computeView(s.rows, V({ show: 'people' })).order.length, 0, 'nor people');
});

test('three stages: rows usable from Tier 1, then the foot says the rest is still running', () => {
  const store = { total: 301, tier0: 301, tier1: 301, errors: 1, tier2: 120, tier2Failed: 0, bad: 0 };
  const scan = { state: 'Scanning', failure: null, seconds: 2, stopping: false };
  const u = C.footState(facts({ store, scan, view: V({ sort: [by('sharpness', 1)] }) }));
  assert.equal(u.kind, 'understanding');
  assert.equal(u.mark, 'running');
  assert.equal(u.verdict, 'Looking closer 120 of 300');
  assert.equal(u.sentence, '');
  assert.deepStrictEqual(u.actions, ['stop', 'sequence', 'bins'], 'the writes work now, because Tier 1 is in');
  assert.equal(u.primary, 'bins');
  assert.equal(C.footState(facts({ store: { ...store, tier1: 100 }, scan })).kind, 'scanning', 'stage two still says Reading');
  assert.equal(C.footState(facts({ store, scan: { ...scan, stopping: true } })).verdict, 'Stopping');
});

test('a choice with no data says so plainly, a waiting one says waiting', () => {
  const s = t2Store([{ path: '/v/a.mp4', shake: null, people: null, speech: null }]);
  assert.equal(C.sortStatus(s.rows, 'shake', false), 'none');
  assert.equal(C.sortStatus(s.rows, 'shake', true), 'waiting');
  assert.equal(C.sortStatus(s.rows, 'sharpness', false), 'ok');
  assert.equal(C.sortStatus(s.rows, 'sharpness', true), 'ok');
  assert.equal(C.sortStatus(s.rows, 'name', false), 'ok');
  assert.equal(C.sortStatus(s.rows, 'createdAt', false), 'none', 'no date read');
  assert.equal(C.sortStatus(s.rows, 'colorName', true), 'waiting');
  assert.equal(C.sortStatus(s.rows, 'nothing-like-it', false), 'ok');
  C.ingest(s, clipLine('/v/a.mp4', 2, { shake: 0 }));
  assert.equal(C.sortStatus(s.rows, 'shake', false), 'ok', 'a real 0 is a value');
  assert.ok(C.TIER2_SORT.shake && C.TIER2_SORT.colorName && !C.TIER2_SORT.sharpness && !C.TIER2_SORT.createdAt && !C.TIER2_SORT.name, 'the Sort menu waits only on what Tier 2 sends');

  assert.equal(C.dataStatus(s.rows, 'people', false), 'none');
  assert.equal(C.dataStatus(s.rows, 'people', true), 'waiting');
  assert.equal(C.dataStatus(s.rows, 'interviews', false), 'none');
  assert.equal(C.dataStatus(s.rows, 'silent', false), 'ok', 'Silent listens to what Tiers 0 and 1 read');
  assert.equal(C.dataStatus(s.rows, null, false), 'ok');
  const f = C.footState(facts({ status: 'none', shown: 0, view: V({ show: 'people' }) }));
  assert.equal(f.sentence, 'No people data in this scan.');
  assert.equal(C.footState(facts({ status: 'waiting', shown: 0, view: V({ show: 'people' }) })).sentence, '0 of 301 clips');
});

test('foot and tiles: a search says how many and why, and a tile keeps one fact', () => {
  const q = C.footState(facts({ shown: 12, query: 'red' }));
  assert.equal(q.sentence, '', 'the search box already counts');
  assert.equal(C.footState(facts({ shown: 12, query: 'red', view: V({ show: 'speech' }) })).sentence, '');
  assert.equal(C.footState(facts({ shown: 9, view: V({ sort: [by('colorName', 1)], families: ['teal'] }) })).verdict, 'Teal');
  const row = { path: '/v/a.mp4', name: 'a.mp4', durationS: 75, sharpness: .123, labels: [{ name: 'oven', conf: .9 }], nameFold: 'a mp4', error: null };
  assert.equal(C.tileFact(row, V()), '1:15.0', 'length, with nothing else to say');
  assert.equal(C.tileFact(row, V({ sort: [by('sharpness', 1)] })), '0.123', 'what the view is about');
  assert.equal(C.tileFact(row, V({ show: 'speech' })), '1:15.0', 'a Show alone says the length');
  assert.equal(C.tileFact(row, V(), ['oven']), 'oven', 'why a search found it');
  assert.equal(C.tileFact({ ...row, reason: 'x', durationS: null }, V()), 'No picture');
  assert.equal(C.tileFact({ ...row, path: '/v/a.r3d', error: 'x' }, V()), '.r3d isn\'t supported yet');
});

test('grid layout: tiles fill the row near 165 px, two columns at least, the count changing past the aim', () => {
  const T = C.TILE, room = panel => panel - 11 - 32;    // the grid's scroll bar and its two 16 px sides
  const at = panel => { const l = C.gridLayout(room(panel)); return l.cols + 'x' + l.tileW; };
  // The usual widths keep 0.3's look; a wide panel no longer falls to the least.
  assert.deepStrictEqual([300, 420, 559, 877, 1400].map(at), ['2x121', '2x181', '3x162', '5x155', '8x157']);
  // 0.3's rule: at least 130 px, as many as fit. The tiles are never smaller than it made them.
  const before = w => { const cols = Math.max(2, Math.floor((w + 14) / 144)); return Math.floor((w - (cols - 1) * 14) / cols); };
  let was = null;
  for (let w = 0; w <= 3000; w++) {
    const l = C.gridLayout(w), used = l.cols * l.tileW + (l.cols - 1) * T.gap;
    assert.ok(l.tileW >= before(w), w + ': never smaller than 0.3\'s tiles, ' + l.tileW + ' < ' + before(w));
    assert.ok(l.cols >= 2, w + ': two columns at least');
    assert.equal(l.gap, T.gap);
    assert.equal(l.picH, Math.round(l.tileW * 9 / 16), w + ': 16:9');
    assert.ok(l.tileW <= T.most, w + ': never past the most');
    if (w >= 2 * T.min + T.gap) {
      assert.ok(used <= w && used > w - l.cols, w + ': the row is filled, less than a pixel a column left');
    }
    if (l.cols >= 3) { assert.ok(l.tileW >= T.min, w + ': never under the least'); }
    if (w >= 400) { assert.ok(l.tileW >= 135 && l.tileW <= 210, w + ': near the aim, ' + l.tileW); }
    if (was) {
      assert.ok(l.cols >= was.cols, w + ': a wider grid never has fewer columns');
      if (l.cols > was.cols && l.cols >= 3) { assert.ok(was.tileW > T.aim && l.tileW < T.aim, w + ': a column is added once the tiles are past the aim, ' + was.tileW + ' -> ' + l.tileW); }
    }
    was = l;
  }
  assert.equal(C.gridLayout(-10).cols, 2, 'no room is still two columns');
  assert.ok(C.gridLayout(0).tileW >= 1);
});

test('menus: every Show and Sort has one place, sections stay together, and people and faces are said to be counts', () => {
  assert.deepStrictEqual(C.SHOWS.map(s => s.id), ['interviews', 'people', 'nopeople', 'mediums', 'wides', 'speech', 'music', 'silent', 'onscreen', 'similar']);
  assert.deepStrictEqual(C.SORTS.map(s => s.key), ['createdAt', 'durationS', 'sharpness', 'luma', 'clipHighPct', 'motionProxy', 'shake', 'audioDb', 'colorName', 'camera', 'name']);
  for (const s of C.SHOWS) {
    assert.equal(C.SHOW[s.id], s);
    assert.equal(typeof s.filter, s.group ? 'undefined' : 'function', s.id + (s.group ? ' keeps the engine\'s groups, not a filter' : ''));
    if (s.id !== 'silent') { assert.ok(typeof s.needs === 'function' && s.none, s.id + ' says when there is nothing to go on'); }
  }
  assert.deepStrictEqual(C.SHOWS.filter(s => s.group).map(s => s.id), ['similar'], 'only Similar shots groups');
  assert.ok(C.SHOW.similar.waiting);
  const sections = C.SHOWS.map(s => s.section).filter((x, i, a) => !i || a[i - 1] !== x);
  assert.deepStrictEqual(sections, ['people', 'sound', 'picture'], 'each section in one run, so the menu has one rule between each');
  for (const e of C.SORTS) {
    assert.equal(C.SORT[e.key], e);
    assert.ok(C.COLUMN[e.key] && C.COLUMN[e.key].sortable !== false, e.key);
    assert.ok(e.dir === 1 || e.dir === -1, e.key);
    assert.ok(e.label, e.key);
  }
  assert.match(C.COLUMN.people.tip, /count/i);
  assert.match(C.COLUMN.faces.tip, /never who/i);
  assert.ok(!/identif|recogni|\bwho (is|it is)\b/i.test(C.SHOW.people.tip + C.SHOW.people.says), 'People never claims to know who');
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
  const colour = V({ sort: [by('colorName', 1)] });
  const held = C.footState(facts({ store, scan, view: colour, needsTier2: C.viewNeedsTier2(colour) }));
  assert.deepStrictEqual(held.held, ['label', 'sequence', 'bins'], 'held, but still there: Label in the right-click menu too');
  assert.deepStrictEqual(held.actions, ['stop', 'sequence', 'bins']);
  assert.equal(held.wait, 'Waits for looking closer');
  const soft = V({ sort: [by('sharpness', 1)] });
  assert.deepStrictEqual(C.footState(facts({ store, scan, view: soft, needsTier2: C.viewNeedsTier2(soft) })).held, [], 'a Tier 1 sort writes now');
  const landed = { ...store, tier2: 290, tier2Failed: 10 };
  assert.deepStrictEqual(C.footState(facts({ store: landed, scan, view: colour, needsTier2: true })).held, [], 'every clip has landed, so it turns on with nothing pressed');
  assert.ok(C.understandingShare(landed).landed && !C.understandingShare(store).landed);
  for (const view of [colour, V({ show: 'people' }), V({ show: 'interviews', sort: [by('sharpness', -1)] }), V({ show: 'similar' }), V({ families: ['teal'] }), V({ sort: [by('shotSize', 1)] }), V({ sort: [by('shake', 1)] })]) {
    assert.ok(C.viewNeedsTier2(view), JSON.stringify(view));
  }
  assert.ok(C.viewNeedsTier2(V(), ['bread']), 'a search reads Tier 2');
  for (const view of [soft, V(), V({ sort: [by('createdAt', 1)] }), V({ sort: [by('luma', 1)] }), V({ show: 'silent', sort: [by('audioDb', -1)] })]) {
    assert.ok(!C.viewNeedsTier2(view), JSON.stringify(view));
  }
  // One phrase whatever the view waits on (0.4 cut the sentence that named it).
  const wait = view => C.footState(facts({ store, scan, view, needsTier2: true })).wait;
  assert.equal(C.footState(facts({ store, scan, view: V(), query: 'bread', needsTier2: true })).wait, 'Waits for looking closer');
  for (const view of [V({ show: 'people', sort: [by('sharpness', -1)] }), V({ show: 'similar', families: ['teal'] }), V({ families: ['teal'] }), V({ sort: [by('shake', 1)] })]) {
    assert.equal(wait(view), 'Waits for looking closer', JSON.stringify(view));
  }
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
  assert.equal(C.tileFact(row, V()), '0:05.0');
  assert.ok(C.ingest(s, { type: 'groups', groups: [] }), 'an empty groups line is fine');
  assert.deepStrictEqual(s.groups, []);
  assert.equal(C.dataStatus(s.rows, 'similar', false), 'none');
});

test('tooltips say only what the engine does', () => {
  assert.equal(C.COLUMN.whiteBalanceK, undefined, 'no white balance: Sony records a mode, not kelvin');
  const words = C.COLUMNS.map(c => c.tip || '').concat(C.SHOWS.map(s => [s.tip, s.says, s.none || ''].join(' ')), C.SORTS.map(s => s.label + ' ' + s.ways.join(' '))).join(' ');
  assert.ok(!/white balance|kelvin|\bWB\b/i.test(words));
  assert.ok(!/less certain|reads flat/i.test(words), 'S-Log is graded before colour is read');
  assert.ok(!/most (cameras|do not)|record none/i.test(words), 'most files carry gyro data');
  assert.match(C.COLUMN.colorName.tip, /S-Log3/);
  assert.match(C.COLUMN.shotSize.tip, /head/);
  assert.match(C.COLUMN.screenText.tip, /four letters/);
});

test('show and sort combine freely, whichever is chosen first; a colour narrows further, and a search again', () => {
  const s = storeFromFixture(fixture), rows = s.rows;
  C.ingest(s, { type: 'groups', groups: fixtureGroups(fixture) });
  const isSubsequence = (small, big) => { let at = 0; for (const x of big) { if (x === small[at]) { at++; } } return at === small.length; };
  const sorts = [[by('sharpness', -1)], [by('shake', 1)], [by('colorName', -1)], [by('createdAt', 1)], [by('name', -1)], [by('camera', 1), by('luma', -1)]];
  for (const sh of C.SHOWS.filter(x => !x.group)) {
    const kept = C.computeView(rows, V({ show: sh.id })).order;
    const keep = new Set(kept);
    for (const sort of sorts) {
      const both = C.computeView(rows, V({ show: sh.id, sort })).order;
      const showFirst = C.sortOrder(rows, kept.slice(), sort);
      const sortFirst = C.computeView(rows, V({ sort })).order.filter(i => keep.has(i));
      const what = sh.id + ' ' + JSON.stringify(sort);
      assert.deepStrictEqual(both, showFirst, what + ': show, then sort');
      assert.deepStrictEqual(both, sortFirst, what + ': sort, then show');
    }
  }
  // Colour, then search, each narrows what the Show and Sort left, and never reorders it.
  const view = V({ show: 'speech', sort: [by('sharpness', -1)] });
  const base = C.computeView(rows, view).order;
  const red = C.computeView(rows, { ...view, families: ['red'] }).order;
  assert.ok(red.length > 0 && red.length < base.length);
  assert.ok(red.every(i => rows[i].colorName === 'red' && rows[i].speech === true));
  assert.ok(isSubsequence(red, base), 'a colour keeps the order');
  const tokens = C.searchTokens('sony');
  const searched = C.computeView(rows, { ...view, families: ['red'] }, null, { tokens }).order;
  assert.ok(searched.length > 0 && searched.length < red.length, 'the fixture has red speech both on and off the Sony');
  assert.ok(searched.every(i => C.matches(rows[i], tokens)));
  assert.ok(isSubsequence(searched, red), 'a search keeps the order');
  assert.deepStrictEqual(searched, red.filter(i => C.matches(rows[i], tokens)), 'and loses nothing that matches');
});

test('sort words: each Sort entry starts its own way, and flipping reads the other way', () => {
  for (const e of C.SORTS) {
    // The menu shows the way (A to Z); the toolbar names the column too when the way alone doesn't (Camera A to Z).
    const says = e.says || e.ways;
    assert.equal(e.ways.length, 2, e.key);
    assert.equal(says.length, 2, e.key);
    assert.notEqual(e.ways[0], e.ways[1], e.key);
    assert.ok(says[0].endsWith(e.ways[0]) && says[1].endsWith(e.ways[1]), e.key + ' says the same way in the toolbar');
    assert.equal(C.sortWords(by(e.key, e.dir)), says[0], e.key);
    assert.equal(C.sortWords(by(e.key, -e.dir)), says[1], e.key);
    const first = C.nextSort([], e.key, false), flipped = C.nextSort(first, e.key, false);
    assert.equal(C.sortWords(first[0]), says[0], e.key + ' starts the way the menu says');
    assert.equal(C.sortWords(flipped[0]), says[1], e.key + ' flips');
    assert.equal(C.sortWords(C.nextSort(flipped, e.key, false)[0]), says[0], e.key + ' flips back');
  }
  const reads = (key, dir) => C.sortWords(by(key, dir));
  assert.equal(reads('sharpness', -1), 'Sharpest first');
  assert.equal(reads('sharpness', 1), 'Softest first');
  assert.equal(reads('shake', 1), 'Steadiest first');
  assert.equal(reads('shake', -1), 'Shakiest first');
  assert.equal(reads('colorName', 1), 'Rainbow order');
  assert.equal(reads('colorName', -1), 'Rainbow reversed');
  assert.equal(reads('createdAt', 1), 'Earliest first');
  assert.equal(reads('createdAt', -1), 'Latest first');
  assert.equal(reads('durationS', -1), 'Longest first');
  assert.equal(reads('clipHighPct', 1), 'Least clipped first');
  assert.equal(reads('audioDb', 1), 'Quietest first');
  assert.equal(reads('name', 1), 'A to Z');
  assert.equal(reads('name', -1), 'Z to A');
  // Columns sorted from their header, outside the menu.
  assert.equal(reads('people', -1), 'Most people first');
  assert.equal(reads('people', 1), 'Fewest people first');
  assert.equal(reads('clipLowPct', -1), 'Most crushed first');
  assert.equal(reads('camera', 1), 'Camera A to Z');
  assert.equal(reads('camera', -1), 'Camera Z to A');
  assert.equal(reads('pixels', -1), 'Largest first');
  assert.equal(reads('pixels', 1), 'Smallest first');
  assert.equal(reads('iso', -1), 'ISO high to low');
  assert.equal(reads('iso', 1), 'ISO low to high');
  for (const c of C.COLUMNS) {
    if (c.sortable === false) { continue; }
    const one = reads(c.key, 1), other = reads(c.key, -1);
    assert.ok(one && other && one !== other, c.key + ' reads both ways');
    if (c.kind === 'number') { assert.ok(!/A to Z|Z to A/.test(one + other), c.key + ' is a number, so never A to Z'); }
  }
});

test('naturalDir: where each column starts, and a header click starts there too', () => {
  const starts = { shake: 1, createdAt: 1, colorName: 1, sharpness: -1, durationS: -1, luma: -1, clipHighPct: -1, motionProxy: -1, audioDb: -1, people: -1, faces: -1, iso: -1, pixels: -1, clipLowPct: -1, camera: 1, lens: 1, codec: 1, name: 1, shotSize: 1, labelText: 1 };
  for (const [key, dir] of Object.entries(starts)) { assert.equal(C.naturalDir(key), dir, key); }
  for (const e of C.SORTS) { assert.equal(C.naturalDir(e.key), e.dir, e.key + ' starts the way the Sort menu does'); }
  for (const c of C.COLUMNS) {
    if (c.sortable === false) { continue; }
    assert.deepStrictEqual(C.nextSort([], c.key, false), [by(c.key, C.naturalDir(c.key))], c.key);
    assert.deepStrictEqual(C.nextSort([by('name', 1)], c.key === 'name' ? 'luma' : c.key, true)[1], by(c.key === 'name' ? 'luma' : c.key, C.naturalDir(c.key === 'name' ? 'luma' : c.key)), c.key + ' added with shift');
  }
  assert.equal(C.sortWords(C.nextSort([], 'shake', false)[0]), 'Steadiest first', 'steadiest is where shake starts');
  assert.equal(C.sortWords(C.nextSort([], 'createdAt', false)[0]), 'Earliest first', 'shoot order starts at the start');
  assert.deepStrictEqual(C.nextSort([by('sharpness', -1)], 'shake', false), [by('shake', 1)], 'a new column starts its own way, whatever the last one did');
});

test('viewName: the whole view in a few words', () => {
  const name = over => C.viewName(V(over));
  assert.equal(name({}), '');
  assert.equal(name({ show: 'interviews' }), 'Interviews');
  assert.equal(name({ sort: [by('sharpness', -1)] }), 'Sharpest first');
  assert.equal(name({ families: ['red'] }), 'Red');
  assert.equal(name({ families: ['red'], show: 'interviews', sort: [by('sharpness', -1)] }), 'Red, interviews, sharpest first');
  assert.equal(name({ show: 'speech', sort: [by('name', 1)] }), 'Speech, A to Z');
  assert.equal(name({ show: 'speech', sort: [by('name', -1)] }), 'Speech, Z to A');
  assert.equal(name({ families: ['red'], sort: [by('colorName', 1)] }), 'Red', 'a colour sorted by colour is just the colour');
  assert.equal(name({ families: ['red'], sort: [by('colorName', -1)] }), 'Red');
  assert.equal(name({ families: ['red'], show: 'interviews', sort: [by('colorName', 1)] }), 'Red, interviews');
  assert.equal(name({ show: 'interviews', sort: [by('colorName', 1)] }), 'Interviews, rainbow order');
  assert.equal(name({ sort: [by('colorName', -1)] }), 'Rainbow reversed');
  assert.equal(name({ families: ['blue'], show: 'onscreen' }), 'Blue, text on screen');
  assert.equal(name({ show: 'speech', sort: [by('camera', 1)] }), 'Speech, camera A to Z');
  assert.equal(name({ show: 'similar', sort: [by('shake', 1)] }), 'Similar shots, steadiest first');
  assert.equal(name({ families: ['neutral'], sort: [by('createdAt', -1)] }), 'Neutral, latest first');
  assert.equal(name({ families: ['red'], sort: [by('iso', -1)] }), 'Red, ISO high to low', 'a short name in capitals stays in capitals');
  assert.equal(name({ show: 'people', sort: [by('people', -1)] }), 'People, most people first');
  assert.equal(name({ sort: [by('sharpness', 1), by('luma', -1)] }), 'Softest first', 'only the first key is named');
});

test('binKind: what Sort into Bins would make, for every kind of view, and the foot agrees', () => {
  const cases = [
    [{ show: 'similar' }, 'groups'],
    [{ show: 'similar', sort: [by('colorName', 1)] }, 'groups'],
    [{ show: 'similar', sort: [by('sharpness', -1)], families: ['red'] }, 'groups'],
    [{ sort: [by('colorName', 1)] }, 'colours'],
    [{ sort: [by('colorName', -1)], show: 'speech' }, 'colours'],
    [{ sort: [by('colorName', 1)], families: ['red'] }, 'colours'],
    [{ sort: [by('createdAt', 1)] }, 'days'],
    [{ sort: [by('createdAt', -1)], show: 'people' }, 'days'],
    [{ sort: [by('camera', 1)] }, 'values'],
    [{ sort: [by('lens', -1)], show: 'wides' }, 'values'],
    [{ sort: [by('shotSize', 1)] }, 'values'],
    [{ show: 'interviews' }, 'one'],
    [{ show: 'speech', sort: [by('sharpness', -1)] }, 'one'],
    [{ show: 'speech', sort: [by('name', 1)] }, 'one'],
    [{ show: 'music', sort: [by('iso', -1)] }, 'one'],
    [{ families: ['red'] }, 'one'],
    [{ show: 'interviews', families: ['red'] }, 'one'],
    [{ sort: [by('sharpness', -1)] }, 'fifths'],
    [{ sort: [by('shake', 1)], families: ['red'] }, 'fifths'],
    [{ sort: [by('people', -1)] }, 'fifths'],
    [{}, null],
    [{ sort: [by('name', 1)] }, null],
    [{ sort: [by('iso', -1)] }, null]
  ];
  for (const [over, kind] of cases) {
    const view = V(over), what = JSON.stringify(over);
    assert.equal(C.binKind(view), kind, what);
    assert.equal(C.footState(facts({ view })).binsOff, !kind, 'binsOff follows binKind: ' + what);
  }
});

test('bucketize: a bin per similar group, per colour in rainbow order, per day, per value', () => {
  const total = b => b.reduce((n, x) => n + x.rows.length, 0);
  const g = [1, 1, 1, 2, 2].map((dupGroup, i) => ({ name: 'g' + i, dupGroup }));
  const groups = C.bucketize(g, V({ show: 'similar', sort: [by('sharpness', -1)] }));
  assert.deepStrictEqual(groups.map(b => [b.name, b.rows.map(r => r.name)]), [['01 Similar, 3 clips', ['g0', 'g1', 'g2']], ['02 Similar, 2 clips', ['g3', 'g4']]]);
  const wide = C.bucketize(Array.from({ length: 240 }, (_, i) => ({ name: 'w' + i, dupGroup: 1 + (i >> 1) })), V({ show: 'similar' }));
  assert.equal(wide.length, 120);
  assert.equal(wide[0].name, '001 Similar, 2 clips', 'numbers keep one width, so the bins list in order');
  assert.equal(wide[119].name, '120 Similar, 2 clips');

  const cs = ['blue', 'red', null, 'neutral', 'red', 'teal'].map((colorName, i) => ({ name: 'c' + i, colorName }));
  for (const dir of [1, -1]) {
    for (const list of [cs, cs.slice().reverse()]) {
      const b = C.bucketize(list, V({ sort: [by('colorName', dir)] }));
      assert.deepStrictEqual(b.map(x => x.name), ['01 Red', '02 Teal', '03 Blue', '04 Neutral', '05 No value'], 'rainbow order whichever way the rows run');
      assert.ok(b[0].rows.length === 2 && b[0].rows.every(r => r.colorName === 'red'));
      assert.equal(total(b), cs.length);
    }
  }
  assert.deepStrictEqual(C.bucketize(cs, V({ show: 'speech', sort: [by('colorName', 1)] })).map(x => x.name).slice(0, 1), ['01 Red'], 'a Show sorted by colour bins by colour');

  const day = (name, createdAt) => ({ name, createdAt, time: createdAt ? Date.parse(createdAt) : NaN });
  const days = [day('a', '2026-10-12T09:00:00Z'), day('b', '2026-10-12T17:30:00Z'), day('c', '2026-10-13T08:00:00Z'), day('d', null)];
  inZone('UTC', () => {
    assert.deepStrictEqual(C.bucketize(days, V({ sort: [by('createdAt', 1)] })).map(b => [b.name, b.rows.length]), [['01 2026-10-12', 2], ['02 2026-10-13', 1], ['03 No value', 1]]);
    const latest = [days[2], days[1], days[0], days[3]];
    assert.deepStrictEqual(C.bucketize(latest, V({ sort: [by('createdAt', -1)] })).map(b => b.name), ['01 2026-10-13', '02 2026-10-12', '03 No value'], 'days come in sort order');
  });

  const cams = [{ camera: 'Canon EOS R5' }, { camera: 'SONY ILME-FX3' }, { camera: 'SONY ILME-FX3' }, { camera: null }];
  assert.deepStrictEqual(C.bucketize(cams, V({ sort: [by('camera', 1)] })).map(b => [b.name, b.rows.length]), [['01 Canon EOS R5', 1], ['02 SONY ILME-FX3', 2], ['03 No value', 1]]);
  const shots = [{ shotSize: 'medium' }, { shotSize: 'medium' }, { shotSize: 'wide' }, { shotSize: null }];
  assert.deepStrictEqual(C.bucketize(shots, V({ sort: [by('shotSize', 1)] })).map(b => b.name), ['01 Medium', '02 Wide', '03 No value']);

  const many = n => Array.from({ length: n }, (_, i) => ({ name: 'm' + i, camera: 'Cam ' + (i + 1) }));
  const twenty = C.bucketize(many(20).concat({ name: 'x', camera: null }), V({ sort: [by('camera', 1)] }));
  assert.equal(twenty.length, 21, 'twenty values make twenty bins, and no value one more');
  assert.equal(twenty[0].name, '01 Cam 1');
  assert.equal(twenty[19].name, '20 Cam 20');
  assert.equal(twenty[20].name, '21 No value');
  assert.equal(C.bucketize(many(21), V({ sort: [by('camera', 1)] })), null, 'more than twenty values make no bins');
  assert.equal(C.bucketize(many(21), V({ sort: [by('camera', 1)], families: ['red'] })), null, 'a colour does not rescue them');
  const fallback = C.bucketize(many(21), V({ show: 'speech', sort: [by('camera', 1)] }));
  assert.deepStrictEqual(fallback.map(b => [b.name, b.rows.length]), [['01 Speech', 21]], 'with a Show on, they make one bin of it');
});

test('bucketize: one bin for a Show or a colour alone, fifths for a number sort, none for a name or nothing', () => {
  const rows = [{ name: 'a', durationS: 3 }, { name: 'b', durationS: 9 }, { name: 'c', durationS: 1 }];
  for (const [over, name] of [[{ show: 'interviews' }, '01 Interviews'], [{ show: 'onscreen', sort: [by('sharpness', -1)] }, '01 Text on screen'], [{ show: 'interviews', families: ['red'] }, '01 Interviews'], [{ families: ['red'] }, '01 Red'], [{ show: 'silent', sort: [by('name', 1)] }, '01 Silent']]) {
    const b = C.bucketize(rows, V(over));
    assert.equal(b.length, 1, JSON.stringify(over));
    assert.equal(b[0].name, name);
    assert.deepStrictEqual(b[0].rows, rows, 'every clip, in view order');
  }
  const durations = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(d => ({ name: 'd' + d, durationS: d })).concat([{ name: 'n1', durationS: null }, { name: 'n2', durationS: null }]);
  const longest = C.bucketize(durations, V({ sort: [by('durationS', -1)] }));
  assert.deepStrictEqual(longest.map(b => [b.name, b.rows.map(r => r.durationS)]), [['01 Longest', [10, 9]], ['02 Longer', [8, 7]], ['03 Middle', [6, 5]], ['04 Shorter', [4, 3]], ['05 Shortest', [2, 1]], ['06 No value', [null, null]]]);
  const shortest = C.bucketize(durations.slice(0, 10).reverse().concat(durations.slice(10)), V({ sort: [by('durationS', 1)] }));
  assert.deepStrictEqual(shortest.map(b => b.name), ['01 Shortest', '02 Shorter', '03 Middle', '04 Longer', '05 Longest', '06 No value']);
  assert.deepStrictEqual(C.bucketize([{ durationS: 9 }, { durationS: 5 }, { durationS: 1 }], V({ sort: [by('durationS', -1)] })).map(b => b.name), ['01 Longest', '02 Longer', '04 Shorter'], 'with fewer clips than bins, each keeps its own word and number');
  assert.equal(C.bucketize(rows, V()), null);
  assert.equal(C.bucketize(rows, V({ sort: [by('name', 1)] })), null);
  assert.equal(C.bucketize(rows, V({ sort: [by('iso', -1)] })), null, 'a number with no words has no fifths to name');
});

test('interviews: speech heard at 0.7 or more, a face, a medium shot, 15 seconds or longer, whatever the shake', () => {
  assert.equal(C.INTERVIEW_MIN_S, 15);
  assert.equal(C.INTERVIEW_SPEECH, 0.7);
  const talk = conf => [{ name: 'music', conf: .9 }, { name: 'speech', conf }];
  const clip = (name, over) => ({ name, speech: true, sounds: talk(.8), faces: 1, shotSize: 'medium', durationS: 60, shake: null, ...over });
  const rows = [clip('at14.9', { durationS: 14.9 }), clip('at15', { durationS: 15 }), clip('long', { durationS: 600 }), clip('nospeech', { speech: false, sounds: [{ name: 'music', conf: 1 }] }),
    clip('unheard', { speech: null, sounds: null }), clip('noface', { faces: 0 }), clip('unseen', { faces: null }), clip('nolength', { durationS: null }),
    clip('at.69', { sounds: talk(.69) }), clip('at.7', { sounds: talk(.7) }), clip('wide', { shotSize: 'wide' }), clip('noshot', { shotSize: null }),
    clip('shaky', { shake: .95 }), clip('steady', { shake: 0 }), clip('noconf', { sounds: [{ name: 'speech' }] })];
  const names = view => C.computeView(rows, view).order.map(i => rows[i].name);
  assert.deepStrictEqual(names(V({ show: 'interviews' })), ['at15', 'long', 'at.7', 'shaky', 'steady']);
  assert.equal(C.showCount(rows, 'interviews'), 5);
  assert.deepStrictEqual(names(V({ show: 'speech' })).slice(0, 3), ['at14.9', 'at15', 'long'], 'a short clip with speech is still speech');
  assert.equal(C.speechConf(clip('x', {})), .8, 'confidence comes from the sounds list');
  assert.equal(C.speechConf({ sounds: null }), 0);
  assert.equal(C.SHAKE_LIMIT, undefined, 'no shake line any more');
  assert.match(C.SHOW.interviews.tip, /15 seconds or longer/);
  assert.match(C.SHOW.interviews.tip, /medium shot/);
  assert.ok(!/shak/i.test(C.SHOW.interviews.tip));
});
test('showCount: what each Show would leave, Similar shots included', () => {
  const rows = [
    { name: 'iv', speech: true, sounds: [{ name: 'speech', conf: .9 }], faces: 1, people: 1, durationS: 30, shake: null, shotSize: 'medium', music: false, hasAudio: true, silent: false, text: ['OPEN'], similar: 1 },
    { name: 'short', speech: true, faces: 1, people: 2, durationS: 5, shotSize: 'wide', music: true, hasAudio: true, silent: false, text: [], similar: 1 },
    { name: 'empty', speech: false, faces: 0, people: 0, durationS: 30, shotSize: null, music: false, hasAudio: false, silent: null, text: [], similar: 2 },
    { name: 'quiet', speech: false, faces: 0, people: 0, durationS: 30, shotSize: null, music: false, hasAudio: true, silent: true, text: null },
    { name: 'unknown', speech: null, faces: null, people: null, durationS: 30, shotSize: null, music: null, hasAudio: true, silent: null, text: null, similar: 3 },
    { name: 'pair', speech: false, faces: 0, people: 0, durationS: 30, shotSize: null, music: false, hasAudio: true, silent: false, text: [], similar: 3 }
  ];
  const expected = { interviews: 1, people: 2, nopeople: 3, mediums: 1, wides: 1, speech: 2, music: 1, silent: 2, onscreen: 1, similar: 4 };
  assert.deepStrictEqual(Object.keys(expected).sort(), C.SHOWS.map(s => s.id).sort(), 'every Show is counted here');
  for (const [id, n] of Object.entries(expected)) {
    assert.equal(C.showCount(rows, id), n, id);
    assert.equal(C.computeView(rows, V({ show: id })).order.length, n, id + ': the count is what the Show then shows');
  }
  assert.equal(C.showCount([], 'similar'), 0);
  assert.equal(C.showCount([], 'interviews'), 0);
});

test('foot wording: the verdict names the view, and the sentence only counts what a view leaves out', () => {
  const say = over => C.footState(facts(over));
  assert.equal(say({ view: V() }).verdict, '301 clips read');
  assert.equal(say({ view: V() }).sentence, '');
  const sorted = say({ view: V({ sort: [by('shake', 1)] }), scan: { state: 'Done', failure: null, seconds: 3.21, stopping: false } });
  assert.equal(sorted.verdict, 'Steadiest first');
  assert.equal(sorted.sentence, '', 'a sort alone keeps every clip, so there is nothing to say');
  const all = say({ view: V({ show: 'speech' }) });
  assert.equal(all.sentence, '');
  const full = say({ shown: 4, view: V({ show: 'interviews', sort: [by('sharpness', -1)], families: ['red'] }) });
  assert.equal(full.verdict, 'Red, interviews, sharpest first');
  assert.equal(full.sentence, '4 of 301 clips');
  for (const s of C.SHOWS.filter(x => !x.group)) {
    assert.equal(say({ shown: 7, view: V({ show: s.id }) }).sentence, '7 of 301 clips', s.id);
    if (s.none) { assert.equal(say({ shown: 7, view: V({ show: s.id }), status: 'none' }).sentence, s.none, s.id + ' with nothing to go on'); }
    assert.equal(say({ shown: 7, view: V({ show: s.id }) }).verdict, s.label);
  }
  assert.equal(say({ shown: 0, groupCount: 0, view: V({ show: 'similar' }), status: 'none' }).sentence, 'No similar shots in this scan.');
  assert.equal(say({ shown: 7, groupCount: 3, view: V({ show: 'similar', families: ['teal'] }) }).sentence, '3 groups');
  const teal = say({ shown: 9, view: V({ families: ['teal'] }) });
  assert.equal(teal.verdict, 'Teal');
  assert.equal(teal.sentence, '9 of 301 clips');
  assert.ok(!teal.binsOff);
  assert.ok(say({ view: V({ sort: [by('name', 1)] }) }).binsOff, 'a name order makes no bins');
  assert.equal(say({ view: V({ sort: [by('name', 1)] }) }).verdict, 'A to Z');

  const store = { total: 301, tier0: 301, tier1: 301, errors: 1, tier2: 120, tier2Failed: 0, bad: 0 };
  const scan = { state: 'Scanning', failure: null, seconds: 2, stopping: false };
  const stage3 = view => C.footState(facts({ store, scan, view }));
  assert.equal(stage3(V()).verdict, 'Looking closer 120 of 300');
  assert.ok(stage3(V()).binsOff);
  assert.equal(stage3(V()).sentence, '');
  assert.equal(stage3(V({ show: 'similar', families: ['teal'] })).verdict, 'Looking closer 120 of 300', 'the toolbar says the view');
  assert.ok(!stage3(V({ show: 'similar' })).binsOff);
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

// ---------------------------------------------------------------- 0.2: safe writes, durable Undo, honest words

// A Premiere with Project panels whose selections the test sets: current is the selection in focus, views the others.
function hostWithViews(current, views, options) {
  const h = hostWith(options), ids = list => list.map(id => h.clip(id) || h.root.kids.concat(...h.root.kids.map(k => k.kids || [])).find(b => b.nodeId === id));
  Object.assign(h.sandbox.app, {
    getCurrentProjectViewSelection: () => ids(current),
    getProjectViewIDs: () => views.map((v, i) => 'view' + i),
    getProjectFromViewID: () => h.sandbox.app.project,
    getProjectViewSelection: id => ids(views[Number(id.slice(4))])
  });
  return h;
}

test('H2: a write names each item by id and path, and an id that now names another clip is left alone and said', () => {
  const h = hostWith();
  h.root.kids[1].getMediaPath = () => '/v/Someone-Else.MP4';    // a revert gave id 2 to another clip
  const label = h.call('label', { project: '/p.prproj', items: pairs('1', '2', '9'), color: 5 });
  assert.equal(label.changed, 1);
  assert.deepStrictEqual(label.skipped.map(x => [x.id, x.error]), [['2', 'now a different clip'], ['9', 'no longer in the project']]);
  assert.equal(h.root.kids[1].getColorLabel(), 0, 'the other clip keeps its label');
  assert.deepStrictEqual(label.restore.items.map(e => e[0]), ['1']);
  const o = C.writeOutcome('label', { items: pairs('1', '2', '9') }, label, 'Mango');
  assert.ok(!o.green);
  assert.match(o.sentence, /2 clips changed since, left alone\./);
  assert.equal(o.failed.length, 2, 'Details lists them');

  const bins = viaHost(h, 'bins', binsArgs());
  assert.equal(bins.moved, 2);
  assert.deepStrictEqual(bins.skipped.map(x => x.id), ['2']);
  assert.ok(h.root.kids.some(k => k.name === 'C2.MP4'), 'the other clip stays where it was');
  // Open goes by the id scan gave, checked against its path, and never opens another clip under that id.
  const opened = h.call('open', { project: '/p.prproj', id: '2', path: '/v/C2.MP4' });
  assert.equal(opened.ok, false);
  assert.equal(opened.code, 'not-found');
});

test('H3: batches of about 100, one top bin across them, read back once, and Undo in batches too', () => {
  assert.equal(C.BATCH, 100);
  assert.deepStrictEqual(C.batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  const h = hostWith(), sent = binsArgs();
  const res = viaHost(h, 'bins', sent, 1);
  const tops = h.root.kids.filter(k => k.type === 2);
  assert.equal(tops.length, 1, 'later batches fill the bin the first one made');
  assert.deepStrictEqual(tops[0].kids.map(k => [k.name, k.kids.map(c => c.nodeId)]), [['01 Softest', [1, 2]], ['02 Softer', [3]]]);
  const o = C.writeOutcome('bins', sent, res);
  assert.ok(o.green, o.sentence);
  assert.equal(res.restore.items.length, 3);
  // Undo in batches of one: the SELECT bin goes only with the last.
  const parts = C.batches(res.restore.items, 1);
  const backs = parts.map((part, i) => h.call('restore', { project: '/p.prproj', restore: { ...res.restore, items: part }, final: i === parts.length - 1 }));
  assert.deepStrictEqual(backs.map(b => b.binRemoved), [null, null, true]);
  assert.equal(backs.reduce((n, b) => n + b.restored, 0), 3);
  assert.deepStrictEqual(h.root.kids.map(k => k.name), ['C1.MP4', 'C2.MP4', 'C3.MP4']);
});

test('H3: a write stopped or refused part way says what landed, is never green, and keeps Undo', () => {
  const stopped = C.writeOutcome('label', { items: pairs('1', '2', '3', '4') }, { changed: 2, failed: [], skipped: [], unsent: 2 }, 'Mango');
  assert.ok(!stopped.green);
  assert.equal(stopped.verdict, 'Labelled 2 of 4 clips');
  assert.equal(stopped.sentence, 'Stopped: 2 weren\'t sent.');
  assert.equal(stopped.undo, true);
  const refused = C.writeOutcome('columns', { fields: C.FIELDS, rows: [{ items: pairs('1', '2'), values: {} }] }, { changed: 1, matched: 1, failed: [], skipped: [], unsent: 1, error: 'Playback is running. Stop it and try again. Nothing was changed.', columns: { shown: true } });
  assert.ok(!refused.green);
  assert.match(refused.sentence, /The rest weren't sent: Playback is running\. Stop it and try again\.$/);
  assert.ok(!/Nothing was changed/.test(refused.sentence), 'part way, nothing changed is no longer true');
  const late = C.undoOutcome({ restored: 100, skipped: 0, failed: [], unsent: 300, error: 'Premiere didn\'t answer within 2 minutes.' });
  assert.equal(late.verdict, 'Partly undone');
  assert.match(late.sentence, /The rest weren't sent: Premiere didn't answer within 2 minutes\./);
});

test('H3: the foot shows a long write\'s real progress, with Stop, and a short one stays brief', () => {
  const base = facts({});
  const long = C.footState({ ...base, busy: 'Adding columns to 973 clips', write: { kind: 'write', verb: 'Adding columns to', unit: 'clip', done: 300, total: 973, stopping: false } });
  assert.equal(long.verdict, 'Adding columns to 300 of 973 clips');
  assert.equal(long.sentence, '');
  assert.deepStrictEqual(long.actions, ['stop']);
  const stopping = C.footState({ ...base, busy: 'x', write: { kind: 'write', verb: 'Labelling', done: 300, total: 973, stopping: true } });
  assert.equal(stopping.verdict, 'Stopping after this batch');
  assert.deepStrictEqual(stopping.actions, []);
  const undo = C.footState({ ...base, busy: 'x', write: { kind: 'undo', verb: 'Putting back', unit: 'item', done: 0, total: 400, stopping: false } });
  assert.equal(undo.verdict, 'Putting back 400 items');
  assert.equal(undo.sentence, '');
  const short = C.footState({ ...base, busy: 'Labelling 4 clips', write: { kind: 'write', verb: 'Labelling', unit: 'clip', done: 0, total: 4, stopping: false } });
  assert.equal(short.verdict, 'Labelling 4 clips');
});

test('H1: Undo records live on disk per project, newest last, ten kept, and read back after a reload', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-undo-'));
  try {
    const project = '/Volumes/Field SSD/Projects/lantern-spring.prproj', other = '/Volumes/Field SSD/Projects/north-pier.prproj';
    assert.match(N.undoDir(project, home), /\/Library\/Application Support\/com\.skyfallstatus\.select\/undo\/[0-9a-f]{16}$/);
    assert.notEqual(C.projectKey(project), C.projectKey(other));
    assert.equal(C.projectKey('/a/Créme.prproj'), C.projectKey('/a/Créme.prproj'), 'one key whatever the Unicode form');
    const ids = [];
    for (let i = 0; i < 12; i++) {
      const id = N.newUndoId(1790000000000 + i);
      ids.push(id);
      assert.ok(N.saveUndo(project, { v: 1, id, project, at: new Date().toISOString(), kind: 'label', meta: { label: 'Mango' }, restore: { kind: 'label', color: 7, items: [['1', 0, '/v/C1.MP4']] } }, C.UNDO_KEEP, home).ok);
    }
    assert.equal(C.UNDO_KEEP, 10);
    assert.deepStrictEqual(N.listUndo(project, home), ids.slice(2), 'the newest ten stay, oldest first');
    assert.deepStrictEqual(N.listUndo(other, home), [], 'another project has its own');
    const again = require('vm').runInNewContext(fs.readFileSync(path.join(__dirname, '../client/native.js'), 'utf8') + ';SelectNative', { require, SelectCore: C });
    const top = again.readUndo(project, again.listUndo(project, home).pop(), home);
    assert.equal(top.restore.items.length, 1, 'a fresh copy of the panel reads them back');
    assert.equal(C.undoWords(top), 'Takes Mango off 1 clip and puts back the labels they had before.');
    assert.ok(!fs.readdirSync(N.undoDir(project, home)).some(n => /\.tmp$/.test(n)), 'nothing half written is left');
    // A record that names another project is not read as this one's.
    fs.writeFileSync(path.join(N.undoDir(project, home), '1790000000099-0001.json'), JSON.stringify({ project: other, restore: { items: [] } }));
    assert.equal(N.readUndo(project, '1790000000099-0001', home), null);
    assert.ok(N.dropUndo(project, ids[11], home));
    assert.equal(N.readUndo(project, ids[11], home), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('S2: an Undo record is found in either Unicode form of its path, and one that does not read is skipped, never deleted', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-undo-'));
  try {
    const nfc = '/Volumes/Field SSD/Projects/Cr\u00e9me br\u00fbl\u00e9e.prproj', nfd = nfc.normalize('NFD');
    assert.notEqual(nfc, nfd);
    assert.equal(N.undoDir(nfc, home), N.undoDir(nfd, home), 'one folder for both forms');
    const record = (id, project, items, extra) => ({ v: 1, id, project, at: new Date().toISOString(), kind: 'label', meta: { label: 'Mango' }, restore: { kind: 'label', color: 7, items }, ...extra });
    const written = N.newUndoId(1790000000000);
    // Written while Premiere gave the path decomposed, read back while it gives it composed.
    assert.ok(N.saveUndo(nfd, record(written, nfd, [['1', 0, '/v/C1.MP4']]), C.UNDO_KEEP, home).ok);
    const back = N.readUndo(nfc, written, home);
    assert.ok(back, 'the record is this project\'s whatever the form');
    assert.equal(back.restore.items.length, 1);
    assert.equal(N.topUndo(nfc, null, home).top.id, written);
    // Newer files that don't read as this panel's records: damaged, a newer format, another project, no format at all.
    const dir = N.undoDir(nfc, home), file = id => path.join(dir, id + '.json');
    const odd = {
      [N.newUndoId(1790000000001)]: '{"v":1,"project":',
      [N.newUndoId(1790000000002)]: JSON.stringify(record('x', nfc, [['2', 0, '/v/C2.MP4']], { v: 2 })),
      [N.newUndoId(1790000000003)]: JSON.stringify(record('x', '/Volumes/Field SSD/Projects/north-pier.prproj', [['3', 0, '/v/C3.MP4']])),
      [N.newUndoId(1790000000004)]: JSON.stringify({ project: nfc, restore: { items: [['4', 0, '/v/C4.MP4']] } })
    };
    for (const [id, text] of Object.entries(odd)) { fs.writeFileSync(file(id), text); }
    for (const id of Object.keys(odd)) { assert.equal(N.readUndo(nfc, id, home), null, odd[id].slice(0, 40)); }
    const found = N.topUndo(nfc, null, home);
    assert.equal(found.top.id, written, 'Undo reaches past them to the last record it can read');
    assert.equal(found.ids.length, 5, 'they still count, as the newest ten kept on disk count them');
    for (const id of Object.keys(odd)) { assert.equal(fs.readFileSync(file(id), 'utf8'), odd[id], 'left exactly as it was'); }
    // An empty record of this format is a write whose first batch never answered: cleared, unless a write is filling it.
    const empty = N.newUndoId(1790000000005), filling = N.newUndoId(1790000000006);
    assert.ok(N.saveUndo(nfc, record(empty, nfc, []), 0, home).ok);
    assert.ok(N.saveUndo(nfc, record(filling, nfc, []), 0, home).ok);
    const again = N.topUndo(nfd, filling, home);
    assert.equal(again.top.id, written);
    assert.ok(!fs.existsSync(file(empty)), 'the empty one is cleared');
    assert.ok(fs.existsSync(file(filling)), 'the one a running write is filling stays');
    for (const id of Object.keys(odd)) { assert.ok(fs.existsSync(file(id))); }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('S2: the panel finds Undo records by the project\'s path in either form, and asks Premiere by the path it gives now', () => {
  const app = fs.readFileSync(path.join(__dirname, '../client/app.js'), 'utf8');
  assert.match(app, /N\.topUndo\(path, S\.activeRecord\)/, 'loadUndo leaves the choice of what to clear to N.topUndo');
  assert.doesNotMatch(app, /N\.readUndo|N\.listUndo/, 'and reads no record itself');
  assert.doesNotMatch(app, /\.project === path|\.path !== path/, 'project paths are compared with samePath');
  assert.match(app, /undoBatches\(entry, r\.project\.path\)/);
});

test('N6: the docs say what the panel does: Undo\'s reach per project, which log is converted, and where updates come from', () => {
  const root = path.join(__dirname, '../..');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const writes = fs.readFileSync(path.join(root, 'docs/WHAT-IT-WRITES.md'), 'utf8');
  assert.match(writes, new RegExp(`up to the last ${C.UNDO_KEEP} for each project`));
  assert.doesNotMatch(readme + writes, /up to your last \d+ writes/, 'not ten in all');
  const looks = fs.readFileSync(path.join(root, 'docs/WHAT-IT-LOOKS-AT.md'), 'utf8');
  assert.doesNotMatch(looks, /reads log footage through its own curve/i, 'not every log');
  assert.match(looks, /S-Log3 with S-Gamut3\.Cine is read through that curve and gamut/);
  assert.match(looks, /left as recorded[^.]*tooltip says so/);
  assert.ok(readme.includes('Once a day Select asks GitHub whether there is a new version. That is the only thing it sends.'));
  assert.ok(writes.includes('None of it leaves the Mac. Once a day Select asks GitHub whether there is a new version, and downloads it from there when there is.'));
  // About is one line since 0.4, and it says the same: nothing leaves the Mac but the daily question to GitHub.
  assert.match(fs.readFileSync(path.join(root, 'panel/client/app.js'), 'utf8'), /dialog\('About Select'.*Everything runs on this Mac\. Once a day Select asks GitHub for a new version\./);
});

test('H1: the write sheets say how far Undo reaches, and Undo says what it will put back', () => {
  assert.equal(C.undoReach(3), '', 'said only when it matters');
  assert.match(C.undoReach(10), /pushes the oldest of the last 10 writes out of Undo's reach/);
  assert.equal(C.undoWords({ kind: 'columns', restore: { items: [1, 2, 3] } }), 'Puts back what the Select columns held on 3 clips before this write.');
  assert.equal(C.undoWords({ kind: 'bins', meta: { root: 'SELECT 2026-11-03 Sharpest first' }, restore: { items: [1, 2] } }), 'Moves 2 clips back to the bins they came from, and removes SELECT 2026-11-03 Sharpest first once it is empty.');
  const now = new Date(2026, 10, 3, 18, 0).getTime();
  assert.equal(C.whenWords(new Date(2026, 10, 3, 14, 32).toISOString(), now), 'today at 14:32');
  assert.equal(C.whenWords(new Date(2026, 10, 2, 9, 5).toISOString(), now), 'yesterday at 09:05');
  assert.equal(C.whenWords(new Date(2026, 9, 30, 18, 0).toISOString(), now), '2026-10-30 at 18:00');
});

test('M2: dates and day bins are in this Mac\'s time zone, whether the time came with an offset or a Z', () => {
  const s = C.createStore();
  C.addItems(s, [{ path: '/v/kept-sidecar.mp4' }, { path: '/v/lost-sidecar.mp4' }, { path: '/v/late.mp4' }, { path: '/v/after-midnight.mp4' }]);
  C.ingest(s, { type: 'clip', tier: 0, path: '/v/kept-sidecar.mp4', createdAt: '2026-09-17T18:50:40+01:00' });
  C.ingest(s, { type: 'clip', tier: 0, path: '/v/lost-sidecar.mp4', createdAt: '2026-09-17T17:50:40Z' });
  C.ingest(s, { type: 'clip', tier: 0, path: '/v/late.mp4', createdAt: '2026-09-17T21:30:00Z' });
  C.ingest(s, { type: 'clip', tier: 0, path: '/v/after-midnight.mp4', createdAt: '2026-09-17T22:30:00Z' });
  const dates = () => s.rows.map(r => C.cellText(r, C.COLUMN.createdAt));
  const dayBins = () => C.bucketize(s.rows, V({ sort: [by('createdAt', 1)] })).map(b => [b.name, b.rows.length]);
  inZone('Europe/Paris', () => {
    assert.deepStrictEqual(dates(), ['2026-09-17 19:50', '2026-09-17 19:50', '2026-09-17 23:30', '2026-09-18 00:30'], 'one camera reads the same with or without its sidecar');
    assert.deepStrictEqual(dayBins(), [['01 2026-09-17', 3], ['02 2026-09-18', 1]], 'a night shoot splits at local midnight');
  });
  inZone('America/Los_Angeles', () => {
    assert.deepStrictEqual(dates(), ['2026-09-17 10:50', '2026-09-17 10:50', '2026-09-17 14:30', '2026-09-17 15:30']);
    assert.deepStrictEqual(dayBins(), [['01 2026-09-17', 4]], 'west of UTC an evening stays on its own day');
  });
  assert.match(C.COLUMN.createdAt.tip, /this Mac's time zone/);
  assert.ok(!/Camera time when present/.test(C.COLUMN.createdAt.tip));
});

test('M3: Interviews is a fixed rule: the same clip is in or out whatever else is in the scan', () => {
  const x = { name: 'X', speech: true, sounds: [{ name: 'speech', conf: .75 }], faces: 1, shotSize: 'medium', durationS: 40, shake: 0.45 };
  const broll = s => Array.from({ length: 9 }, (_, i) => ({ name: 'b' + i, speech: false, sounds: [], faces: 0, shotSize: null, durationS: 10, shake: s }));
  const inScan = rows => C.computeView(rows, V({ show: 'interviews' })).order.map(i => rows[i].name).includes('X');
  assert.ok(inScan([x].concat(broll(0.2))), 'with tripod b-roll');
  assert.ok(inScan([x].concat(broll(0.6))), 'with handheld b-roll');
  assert.ok(inScan([x]), 'alone');
  const handheld = { ...x, shake: 0.8 };
  assert.ok(inScan([handheld]) && inScan([handheld].concat(broll(0.1))), 'a handheld interview stays in: shake is not asked');
  const quiet = { ...x, sounds: [{ name: 'speech', conf: .5 }] };
  assert.ok(!inScan([quiet]) && !inScan([quiet].concat(broll(0.1))), 'speech heard faintly stays out, among any clips');
});
test('unknown is not zero: a null from Vision is never No people, 0 faces or Silent, and shows blank', () => {
  const unknown = { name: 'u', durationS: 30, hasAudio: true, silent: null, speech: null, music: null, people: null, faces: null, shotSize: null, text: null, labels: null, sounds: null, colorName: null, shake: null };
  const rows = [unknown, { ...unknown, name: 'none', people: 0, faces: 0 }, { ...unknown, name: 'quiet', silent: true }];
  const shown = id => C.computeView(rows, V({ show: id })).order.map(i => rows[i].name);
  assert.deepStrictEqual(shown('nopeople'), ['none']);
  assert.deepStrictEqual(shown('people'), []);
  assert.deepStrictEqual(shown('silent'), ['quiet']);
  assert.deepStrictEqual(shown('interviews'), []);
  for (const id of ['speech', 'music', 'mediums', 'wides', 'onscreen']) { assert.ok(!shown(id).includes('u'), id); }
  for (const key of ['people', 'faces', 'shotSize', 'colorName', 'soundText', 'screenText', 'labelText', 'shake']) {
    assert.equal(C.cellText(unknown, C.COLUMN[key]), '', key);
  }
  assert.equal(C.cellText({ people: 0 }, C.COLUMN.people), '0', 'a real zero stays 0');
  const sorted = C.computeView(rows, V({ sort: [by('people', -1)] })).order.map(i => rows[i].name);
  assert.equal(sorted[0], 'none', 'unknown sorts after a real 0');
});

test('L1: an Undo that put nothing back never says Undone', () => {
  const o = C.undoOutcome({ ok: true, restored: 0, skipped: 12, failed: [], remaining: null, binRemoved: null });
  assert.equal(o.verdict, 'Nothing went back');
  assert.equal(o.sentence, '12 changed since, left alone.');
  assert.equal(o.kind, 'partial');
  assert.equal(C.undoOutcome({ restored: 0, skipped: 0, failed: [] }).sentence, 'Nothing left to put back.');
});

test('L2: a write during stage three is its own row: Undo beside it, the scan\'s Stop not', () => {
  const store = C.createStore();
  C.addItems(store, [{ path: '/a/1.mp4', id: '1' }, { path: '/a/2.mp4', id: '2' }]);
  ['/a/1.mp4', '/a/2.mp4'].forEach(p => { C.ingest(store, { type: 'clip', tier: 0, path: p, durationS: 20 }); C.ingest(store, { type: 'clip', tier: 1, path: p, sharpness: 0.5 }); });
  C.ingest(store, { type: 'clip', tier: 2, path: '/a/1.mp4', moments: 3, people: 1 });
  const scanning = { ...facts({}), scan: { state: 'Scanning', failure: null, seconds: 3, stopping: false }, store, rows: 2, shown: 2, view: V({ sort: [by('sharpness', -1)] }) };
  const out = C.writeOutcome('label', { items: pairs('1', '2') }, { changed: 2, failed: [], skipped: [] }, 'Mango');
  const f = C.footState({ ...scanning, outcome: out });
  assert.ok(f.green);
  assert.deepStrictEqual(f.actions, ['undo']);
  assert.deepStrictEqual(C.bandRow(f, { ...scanning, outcome: out }).actions, ['undo']);
  const undone = C.footState({ ...scanning, outcome: { kind: 'undone', verdict: 'Undone', sentence: '', green: false, undo: false } });
  assert.ok(undone.actions.indexOf('stop') < 0, 'Undone carries no Stop either');
  // Once the result closes, the scan's own row is back, with its Stop.
  const back = C.footState(scanning);
  assert.equal(back.kind, 'understanding');
  assert.equal(back.actions[0], 'stop');
  const after = C.footState({ ...scanning, scan: { ...scanning.scan, state: 'Done' }, outcome: out });
  assert.deepStrictEqual(after.actions, ['undo']);
});

test('L3: listing a folder can be stopped, and stops by itself past the cap', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-walk-'));
  try {
    fs.mkdirSync(path.join(dir, 'a/b'), { recursive: true });
    for (const f of ['1.mp4', 'a/2.mp4', 'a/3.mov', 'a/b/4.mp4', 'a/b/5.mxf']) { fs.writeFileSync(path.join(dir, f), ''); }
    const counts = [];
    const all = await new Promise(res => N.walkFolder(dir, (e, p, info) => res({ p, info }), { onCount: n => counts.push(n) }));
    assert.equal(all.p.length, 5);
    assert.deepStrictEqual(all.info, { capped: false, stopped: false });
    assert.ok(counts.length >= 1 && counts[counts.length - 1] === 5, 'the count climbs as it goes');
    const capped = await new Promise(res => N.walkFolder(dir, (e, p, info) => res({ p, info }), { most: 3 }));
    assert.deepStrictEqual(capped, { p: [], info: { capped: true, stopped: false } });
    let stopped = null;
    const handle = N.walkFolder(dir, (e, p, info) => { stopped = { p, info }; });
    handle.stop();
    assert.deepStrictEqual(stopped, { p: [], info: { capped: false, stopped: true } }, 'Stop ends it at once');
    assert.equal(N.MOST_FILES, 50000);
    const f = C.footState({ ...facts({}), listing: true, listed: 1234, listStop: true });
    assert.equal(f.sentence, '1,234 video files found so far.');
    assert.deepStrictEqual(f.actions, ['stop']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('L5: a Selection scan knows where its clips come from, and two selections are refused rather than guessed', () => {
  const h = hostWithViews([], [[2]]), day = h.root.createBin('Day 2');
  h.clip(2).moveBin(day);
  const one = h.call('collect', { mode: 'selection' });
  assert.ok(one.ok);
  assert.deepStrictEqual(one.picked, { clips: 1, where: ['Day 2'] });
  const bin = hostWithViews([], [[]]);
  bin.sandbox.app.getProjectViewSelection = () => [bin.root.kids[0], bin.root.kids[1]];
  assert.deepStrictEqual(bin.call('collect', { mode: 'selection' }).picked, { clips: 2, where: [''] });
  const two = hostWithViews([], [[1], [3]]).call('collect', { mode: 'selection' });
  assert.equal(two.ok, false);
  assert.equal(two.code, 'several-selections');
  assert.match(two.message, /2 Project panels have clips selected/);
  const current = hostWithViews([1], [[1], [3]]).call('collect', { mode: 'selection' });
  assert.ok(current.ok, 'the selection in focus wins');
  assert.deepStrictEqual(current.items.map(i => i.id), ['1']);
});

// ---------------------------------------------------------------- 0.4: search, sort and bins

test('0.4 search: a folder name finds its clips: the bins in the project first, then the last three folders on disk, closest first', () => {
  const home = ['', 'Users', 'someone', 'Movies'].join('/');
  const s = C.createStore();
  C.addItems(s, [
    { id: '1', path: '/Volumes/Field SSD/Shoot/DAY 2/A CAM/C0001.MP4', bin: 'Selects/Day 2' },
    { id: '2', path: home + '/Card 03/C0002.MP4' },
    { id: '3', path: '/Volumes/EOS_DIGITAL/DCIM/100CANON/MVI_0001.MP4' },
    { id: '4', path: '/Volumes/Field SSD/Shoot/DAY 2/A CAM/C0001.MP4', bin: 'Interviews' }
  ]);
  const find = q => C.computeView(s.rows, V(), null, { tokens: C.searchTokens(q) }).order.map(i => s.rows[i].name);
  assert.deepStrictEqual(s.rows[0].binPaths, ['Selects/Day 2', 'Interviews'], 'one row, the bins of both its items');
  assert.deepStrictEqual(C.folderNames(s.rows[0]), ['Day 2', 'Selects', 'Interviews', 'A CAM', 'Shoot'], 'a name already there is not said twice, and a fourth folder up is not a card, a camera or a day');
  assert.deepStrictEqual(find('day 2'), ['C0001.MP4']);
  assert.deepStrictEqual(find('a cam'), ['C0001.MP4']);
  assert.deepStrictEqual(find('interviews'), ['C0001.MP4'], 'a bin the clip sits in');
  assert.deepStrictEqual(find('card 03'), ['C0002.MP4']);
  assert.deepStrictEqual(find('movies'), ['C0002.MP4']);
  assert.deepStrictEqual(find('eos'), ['MVI_0001.MP4'], 'a card\'s own name');
  assert.deepStrictEqual(find('100canon'), ['MVI_0001.MP4']);
  for (const q of ['volumes', 'users', 'someone', 'field ssd']) { assert.deepStrictEqual(find(q), [], q + ' is not a folder anyone means'); }
  assert.deepStrictEqual(find('ay'), [], 'a folder is matched from the start of a word, as everything else is');
  // Why it is on screen: the folder's own name, bare, as a word is.
  assert.equal(C.matchedWord(s.rows[0], C.searchTokens('day')), 'Day 2');
  assert.equal(C.matchedWord(s.rows[0], C.searchTokens('cam')), 'A CAM');
  assert.equal(C.matchedWord(s.rows[1], C.searchTokens('card')), 'Card 03');
  assert.equal(C.tileFact(s.rows[2], V(), C.searchTokens('dcim')), 'DCIM');
  // What the frames hold comes before a folder.
  const t = t2Store([{ path: '/v/Kitchen/C1.MP4', labels: [{ name: 'kitchen', conf: .9 }], text: [], sounds: [] }]);
  assert.equal(C.matchedWord(t.rows[0], C.searchTokens('kitchen')), 'kitchen');
});

test('0.4 bins: clips whose values read the same stay in one bin, whichever fifth they would cross', () => {
  const view = V({ sort: [by('sharpness', -1)] });
  const rows = vals => vals.map((v, i) => ({ name: 'c' + i, sharpness: v }));
  const bins = list => C.bucketize(list, view).map(b => [b.name, b.rows.map(r => r.name)]);
  // Ten clips with the same sharpness were five bins in 0.3.
  assert.deepStrictEqual(bins(rows(Array(10).fill(0.5))), [['01 Sharpest', ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']]]);
  assert.deepStrictEqual(bins(rows([0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.3, 0.2])), [['01 Sharpest', ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']], ['05 Softest', ['c8', 'c9']]]);
  assert.deepStrictEqual(bins(rows([0.9, 0.8, 0.7, 0.6, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1])).map(b => b[1].length), [2, 3, 1, 2, 2], 'a pair across a line goes where the first of it falls');
  // Equal as the column shows them: 0.5001 and 0.5004 both read 0.500.
  assert.equal(bins(rows([0.5004, 0.5001, 0.5001, 0.5001, 0.5001])).length, 1);
  // On the fixture: every value the column shows sits in exactly one bin, and every clip in one.
  const s = storeFromFixture(fixture);
  for (const key of ['sharpness', 'luma', 'durationS', 'audioDb', 'shake']) {
    const v = V({ sort: [by(key, C.naturalDir(key))] }), list = byOrder(s.rows, C.computeView(s.rows, v).order);
    const b = C.bucketize(list, v), where = new Map();
    assert.equal(b.reduce((n, x) => n + x.rows.length, 0), list.length, key);
    for (const bin of b) {
      for (const r of bin.rows) {
        const shown = C.cellText(r, C.COLUMN[key]);
        assert.ok(!where.has(shown) || where.get(shown) === bin.name, `${key} ${shown} in ${where.get(shown)} and ${bin.name}`);
        where.set(shown, bin.name);
      }
    }
  }
});

test('0.4 sort: Camera in the Sort menu, A to Z, clips with no camera last, and a bin per camera', () => {
  const rows = [{ name: 'a', camera: 'SONY ILME-FX3' }, { name: 'b', camera: 'Canon EOS R5' }, { name: 'c', camera: null }, { name: 'd', camera: 'SONY ILME-FX3' }, { name: 'e', camera: 'Apple iPhone 15 Pro' }];
  const names = dir => C.computeView(rows, V({ sort: [by('camera', dir)] })).order.map(i => rows[i].name);
  assert.deepStrictEqual(names(1), ['e', 'b', 'a', 'd', 'c']);
  assert.deepStrictEqual(names(-1), ['a', 'd', 'b', 'e', 'c'], 'no camera stays last both ways');
  assert.equal(C.SORT.camera.dir, 1);
  assert.deepStrictEqual(C.SORT.camera.ways, ['A to Z', 'Z to A'], 'the menu hint');
  assert.equal(C.sortWords(by('camera', 1)), 'Camera A to Z', 'the toolbar');
  assert.equal(C.sortWords(by('camera', -1)), 'Camera Z to A');
  assert.equal(C.viewName(V({ show: 'interviews', sort: [by('camera', 1)] })), 'Interviews, camera A to Z');
  assert.equal(C.COLUMN.camera.tip, 'Maker and model.', 'the Sort menu\'s tooltip, as CONTRACTS 5.7 has it');
  const list = byOrder(rows, C.computeView(rows, V({ sort: [by('camera', 1)] })).order);
  assert.deepStrictEqual(C.bucketize(list, V({ sort: [by('camera', 1)] })).map(b => [b.name, b.rows.length]), [['01 Apple iPhone 15 Pro', 1], ['02 Canon EOS R5', 1], ['03 SONY ILME-FX3', 2], ['04 No value', 1]]);
  assert.equal(C.binKind(V({ sort: [by('camera', 1)] })), 'values');
});

// ---------------------------------------------------------------- 0.4: the host's new calls

const VIDEO = ['mp4', 'mov', 'mxf'];
// FNV-1a, 32 bits, written the plain way, to check the host's ES3 one against.
const fnv = text => { let h = 0x811c9dc5; for (const ch of text) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16).padStart(8, '0'); };
const sigOf = ids => ids.length + ':' + fnv(ids.join(','));

test('0.4 host: every answer says how long it took inside Premiere, and the protocol is 3 in the host and the page', () => {
  const h = hostWith();
  for (const [fn, args] of [['ping', {}], ['status', {}], ['watch', {}], ['target', {}], ['find', { paths: ['/v/C1.MP4'] }], ['nonsense', {}]]) {
    const res = h.call(fn, args);
    assert.equal(typeof res.ms, 'number', fn);
  }
  assert.equal(h.call('ping', {}).protocol, 3);
  const host = fs.readFileSync(path.join(__dirname, '../host/select.jsx'), 'utf8'), app = fs.readFileSync(path.join(__dirname, '../client/app.js'), 'utf8');
  assert.match(host, /^var SELECT_HOST_PROTOCOL = 3;$/m);
  assert.match(app, /^  var HOST_PROTOCOL = 3;$/m);
});

test('0.4 host: watch names the project and a signature of the selection, with no search and no walk', () => {
  const h = hostWithViews([], [[2, 3]]);
  h.options.searches = 0;
  const w = h.call('watch', {});
  assert.ok(w.ok);
  assert.deepStrictEqual(w.project, { path: '/p.prproj', name: 'p.prproj', id: 'doc-1' });
  assert.equal(w.sig, sigOf(['2', '3']), 'count and a hash of every id');
  assert.equal(h.options.searches, 0);
  assert.equal(hostWithViews([], [[]]).call('watch', {}).sig, '', 'nothing selected');
  assert.equal(hostWithViews([], [[1], [3]]).call('watch', {}).sig, 'several:2', 'two Project panels, none in focus');
  assert.equal(hostWithViews([3], [[1], [3]]).call('watch', {}).sig, sigOf(['3']), 'the one in focus wins');
  const none = hostWith();
  none.sandbox.app.project.path = '';
  assert.deepStrictEqual([none.call('watch', {}).project, none.call('watch', {}).sig], [null, '']);
});

test('0.4 host fixes K1: the signature is the count and a 32-bit FNV-1a of every id, so a clip swapped in the middle changes it', () => {
  const h = hostWith();
  assert.deepStrictEqual(['', 'a', 'foobar'].map(x => h.sandbox.slFnv(x)), ['811c9dc5', 'e40c292c', 'bf9cf968'], 'the published test values');
  for (const x of ['000f4a21', '000f4a21,000f4a3c,000f4b02', 'é,ü', Array.from({ length: 900 }, (_, i) => (0xf4000 + i).toString(16)).join(',')]) {
    assert.equal(h.sandbox.slFnv(x), fnv(x), x.slice(0, 30));
  }
  const sig = sel => hostWithViews([], [sel]).call('watch', {}).sig;
  assert.notEqual(sig([1, 2, 3]), sig([1, 3, 2]), 'order counts');
  const swap = hostWithViews([], [[1, 2, 3]]), before = swap.call('watch', {}).sig;
  swap.addClip(9, swap.root);
  swap.sandbox.app.getProjectViewSelection = () => [swap.clip(1), swap.clip(9), swap.clip(3)];
  const after = swap.call('watch', {}).sig;
  assert.ok(/^3:[0-9a-f]{8}$/.test(before) && /^3:[0-9a-f]{8}$/.test(after) && before !== after, 'same count, same ends, another clip in the middle');
  assert.equal(hostWithViews([], [[1], [3]]).call('watch', {}).sig, 'several:2');
  assert.equal(hostWithViews([], [[]]).call('watch', {}).sig, '');
});

test('0.4 host fixes R6: the whole project is walked again only when it may have changed, and many loose clips never hand it all out', () => {
  // A sequence selected means the whole project: the first time it is walked, then it comes from that walk while Premiere's
  // undo history stands still. An import, a move or a deletion adds a step, and the next target walks again.
  const h = hostWithViews([], [[]]), o = h.options;
  const seq = h.sandbox.app.project.createNewSequenceFromClips('A sequence', [h.clip(1)], h.root);
  h.sandbox.app.getProjectViewSelection = () => [seq.projectItem];
  o.everything = 0;
  let t = h.call('target', { exts: VIDEO });
  assert.deepStrictEqual([t.kind, t.items.length, t.walked, o.everything], ['project', 3, true, 1]);
  const again = h.call('target', { exts: VIDEO });
  assert.deepStrictEqual([again.kind, again.items.length, again.walked, o.everything], ['project', 3, false, 1], 'another click, no walk');
  h.sandbox.app.getProjectViewSelection = () => [];
  assert.deepStrictEqual([h.call('target', { exts: VIDEO }).walked, o.everything], [false, 1], 'nothing selected: still the same project');
  h.addClip(4, h.root);
  o.undoAt = 8;
  t = h.call('target', { exts: VIDEO });
  assert.deepStrictEqual([t.items.length, t.walked, o.everything], [4, true, 2], 'an import moved the undo history: walked again');
  assert.equal(h.call('target', { whole: true, exts: VIDEO }).walked, true, 'Scan Whole Project walks whatever');
  assert.equal(h.call('target', { fresh: true, exts: VIDEO }).walked, true, 'and so does fresh');
  assert.equal(o.everything, 4);
  // No undo history to read: every target walks, as before.
  const blind = hostWithViews([], [[]]);
  blind.sandbox.qe.project.undoStackIndex = () => { throw new Error('no QE'); };
  blind.call('target', { exts: VIDEO });
  blind.call('target', { exts: VIDEO });
  assert.equal(blind.options.everything, 2);
  // Another project in front never gets this one's list.
  const other = hostWithViews([], [[]]);
  other.call('target', { exts: VIDEO });
  other.sandbox.app.project.path = '/q.prproj';
  assert.equal(other.call('target', { exts: VIDEO }).walked, true);
  // 150 loose clips selected: one search per path, never one search of every item in the project.
  const many = hostWithViews([], [[]]);
  const list = Array.from({ length: 150 }, (_, i) => many.addClip(200 + i, many.root));
  many.addClip(400, many.root, { name: 'sub', sub: true, getMediaPath: () => '/v/C200.MP4' });
  many.sandbox.app.getProjectViewSelection = () => list.concat([many.clip(400)]);
  many.options.searches = 0; many.options.everything = 0;
  t = many.call('target', { exts: VIDEO });
  assert.deepStrictEqual([t.kind, t.items.length, t.subclips, many.options.everything, many.options.searches], ['clips', 150, 1, 0, 150]);
});

test('0.4 host fixes R5: Reveal in Project selects at most 50 clips', () => {
  const h = hostWith();
  for (let i = 4; i <= 60; i++) { h.addClip(i, h.root); }
  const ids = n => Array.from({ length: n }, (_, i) => [String(i + 4), '/v/C' + (i + 4) + '.MP4']);
  const fifty = h.call('reveal', { project: '/p.prproj', items: ids(50) });
  assert.deepStrictEqual([fifty.ok, fifty.selected], [true, 50]);
  const more = h.call('reveal', { project: '/p.prproj', items: ids(51) });
  assert.deepStrictEqual([more.ok, more.code, more.message], [false, 'too-many', 'At most 50 clips.']);
  assert.equal(h.sandbox.SL_MOST_REVEAL, 50);
});

test('0.4 host fixes R21: refusals are a few words, with the same codes', () => {
  const said = (options, change, fn, args) => { const h = hostWith(options); if (change) { change(h); } const r = h.call(fn, args || { project: '/p.prproj', items: pairs('1'), color: 5 }); return [r.code, r.message]; };
  assert.deepStrictEqual(said({}, h => { h.sandbox.qe.getModalWindowID = () => 'dlg'; }, 'label'), ['modal', 'A Premiere dialog is open.']);
  assert.deepStrictEqual(said({ noModalCheck: true }, null, 'bins'), ['modal-unknown', 'Premiere didn\'t answer. Nothing was written.']);
  assert.deepStrictEqual(said({}, h => { h.sandbox.qe.source.player.isPlaying = true; }, 'restore', { project: '/p.prproj', restore: { kind: 'label', color: 5, items: [] } }), ['playing', 'Playback is running.']);
  assert.deepStrictEqual(said({}, h => { h.sandbox.qe.source.player.isPlaying = 'x'; }, 'label'), ['playback-unknown', 'Premiere didn\'t answer. Nothing was written.']);
  assert.deepStrictEqual(said({}, h => { h.sandbox.app.project.path = ''; }, 'sequence', { project: '/p.prproj', name: 'X', items: pairs('1') }), ['no-project', 'No project is open.']);
  assert.deepStrictEqual(said({}, null, 'sequence', { project: '/p.prproj', name: 'X', items: [['9', '/v/C9.MP4']] }), ['empty', 'None of these clips are in this project.']);
  assert.deepStrictEqual(said({}, null, 'reveal', { project: '/p.prproj', items: [['9', '/v/C9.MP4']] }), ['not-found', 'None of these clips are in this project.']);
  assert.deepStrictEqual(said({}, null, 'sequence', { project: '/p.prproj', name: 'X', items: Array.from({ length: 2001 }, () => ['1', '/v/C1.MP4']) }), ['too-many', 'A sequence from Select holds at most 2,000 clips.']);
  const host = fs.readFileSync(path.join(__dirname, '../host/select.jsx'), 'utf8');
  assert.ok(!/Close it first|Stop it and try again|and try again\. Nothing was changed|did not confirm that/.test(host), 'none of the long ones left');
});

test('0.4 host fixes R3: Undo deletes a sequence only while it holds what Select made and no other sequence uses it', () => {
  const make = () => {
    const h = hostWith(), made = h.call('sequence', { project: '/p.prproj', name: 'Picks', items: pairs('1', '2'), write: 's' });
    return { h, made, q: h.seqs[h.seqs.length - 1], undo: () => h.call('restore', { project: '/p.prproj', restore: made.restore, final: true, write: 'u' }) };
  };
  // The record holds the sequence's shape as it was made.
  let { h, made, q, undo } = make();
  assert.equal(made.restore.items[0].length, 6);
  assert.equal(made.restore.items[0][5], 'v3,2/0,0/0,0/0|a3,2/0,0/0,0/0|m0|io0,2|f1920x1080@10160640000|z0|e' + q.end);
  let r = undo();
  assert.deepStrictEqual([r.restored, r.skipped, r.kept, r.note], [1, 0, [], null], 'untouched: it goes');
  const kept = (change, words) => {
    const m = make();
    change(m.q, m.h);
    const a = m.undo();
    assert.deepStrictEqual([a.restored, a.skipped, a.kept.length, a.note, m.h.seqs.includes(m.q)], [0, 1, 1, words || 'The sequence has changed. It stays.', true], change.toString());
    assert.equal(a.kept[0].name, 'Picks');
    assert.equal(C.undoOutcome(a, 'sequence').verdict, 'Nothing went back');
  };
  kept(q => { q.videoTracks[1].clips = { numItems: 1 }; });                   // a title on V2
  kept(q => { q.audioTracks[0].clips = { numItems: 3 }; });                   // an audio edit on A1
  kept(q => { q.audioTracks[2].transitions = { numItems: 1 }; });             // a crossfade on A3
  kept(q => { q.markers = { numMarkers: 1 }; });                              // a marker
  kept(q => { q.outPoint = '1'; });                                           // an out point
  kept(q => { q.videoTracks = Object.assign({ numTracks: 4 }, [q.videoTracks[0], q.videoTracks[1], q.videoTracks[2], { clips: { numItems: 0 }, transitions: { numItems: 0 } }]); }); // a track added
  kept(q => { q.timebase = '5080320000'; });                                  // settings changed
  // Nested in another sequence: Premiere says so in the item's Video Usage, and deleting it would empty that timeline.
  const usage = n => `<premierePrivateProjectMetaData:Column.Intrinsic.VideoUsage>${n}</premierePrivateProjectMetaData:Column.Intrinsic.VideoUsage>`;
  kept(q => { q.projectItem.setProjectMetadata(usage(1)); }, 'The sequence is in another sequence. It stays.');
  kept(q => { q.projectItem.getProjectMetadata = () => { throw new Error('unreadable'); }; }, 'The sequence is in another sequence. It stays.');
  ({ h, made, q, undo } = make());
  q.projectItem.setProjectMetadata(usage(0));
  assert.equal(undo().restored, 1, 'a usage of 0, as after the other sequence let it go, is free to go');
  // A record without a shape (a dev build's, before this) is never trusted.
  ({ h, made, q, undo } = make());
  made.restore.items[0] = made.restore.items[0].slice(0, 5);
  r = undo();
  assert.deepStrictEqual([r.restored, r.note], [0, 'The sequence has changed. It stays.']);
  // Gone already is not a change, and says nothing.
  ({ h, made, q, undo } = make());
  h.sandbox.app.project.deleteSequence(q);
  r = undo();
  assert.deepStrictEqual([r.restored, r.skipped, r.kept, r.note], [0, 1, [], null]);
});

test('0.4 host: target reads what Scan would: the clips selected, the bins selected, or the whole project', () => {
  // Day 2 holds 4 and 5, Day 3 holds 6; 7 is a still; 8 is a subclip of 4; a sequence sits at the top.
  const make = () => {
    const h = hostWithViews([], [[]]), day2 = h.root.createBin('Day 2'), day3 = h.root.createBin('Day 3');
    h.addClip(4, day2); h.addClip(5, day2); h.addClip(6, day3);
    h.addClip(7, h.root, { name: 'still.png', getMediaPath: () => '/v/still.png' });
    h.addClip(8, day2, { name: 'sub of 4', sub: true, getMediaPath: () => '/v/C4.MP4' });
    h.sandbox.app.project.createNewSequenceFromClips('A sequence', [h.clip(1)], h.root);
    return { h, day2, day3 };
  };
  const select = (h, list) => { h.sandbox.app.getProjectViewSelection = () => list; };
  let { h, day2, day3 } = make();
  select(h, [h.clip(4), h.clip(6)]);
  let t = h.call('target', { exts: VIDEO });
  assert.equal(t.kind, 'clips');
  assert.deepStrictEqual(t.places, ['Day 2', 'Day 3']);
  assert.equal(t.name, null, 'two clips have no one name');
  assert.deepStrictEqual(t.items.map(i => [i.id, i.bin]), [['4', 'Day 2'], ['6', 'Day 3']]);
  assert.equal(t.sig, sigOf(['4', '6']));
  select(h, [h.clip(6)]);
  t = h.call('target', { exts: VIDEO });
  assert.deepStrictEqual([t.kind, t.name, t.places], ['clips', 'C6.MP4', ['Day 3']]);
  select(h, [day2]);
  t = h.call('target', { exts: VIDEO });
  assert.equal(t.kind, 'bins');
  assert.deepStrictEqual(t.places, ['Day 2']);
  assert.deepStrictEqual(t.items.map(i => i.id), ['4', '5'], 'the subclip in the bin is left out');
  select(h, [day2, day3]);
  assert.deepStrictEqual(h.call('target', { exts: VIDEO }).items.map(i => i.id), ['4', '5', '6']);
  // Only a still, or only the sequence: Scan reads the whole project.
  select(h, [h.clip(7)]);
  t = h.call('target', { exts: VIDEO });
  assert.equal(t.kind, 'project');
  assert.deepStrictEqual(t.items.map(i => i.id).sort(), ['1', '2', '3', '4', '5', '6', '7'], 'every master clip with media; the panel keeps the video');
  assert.equal(t.sequences, 1);
  select(h, [h.clip(4), h.clip(8)]);
  t = h.call('target', { exts: VIDEO });
  assert.deepStrictEqual([t.kind, t.items.length, t.subclips], ['clips', 1, 1], 'a subclip selected is counted and left out');
  assert.equal(h.call('target', { whole: true, exts: VIDEO }).kind, 'project', 'Scan Whole Project ignores the selection');
  // More than three places: three and a count.
  ({ h } = make());
  const bins = ['A', 'B', 'C', 'D', 'E'].map((n, i) => { const b = h.root.createBin(n); h.addClip(20 + i, b); return b; });
  select(h, bins);
  t = h.call('target', { exts: VIDEO });
  assert.deepStrictEqual([t.places, t.more], [['A', 'B', 'C'], 2]);
  const several = hostWithViews([], [[1], [3]]).call('target', { exts: VIDEO });
  assert.deepStrictEqual([several.kind, several.several, several.items.length], ['several', 2, 0]);
  const none = hostWith();
  none.sandbox.app.project.path = '';
  assert.equal(none.call('target', {}).code, 'no-project');
});

test('0.4 host: subclips are never written to: find, collect and target leave them out, so Label and Bins never reach one', () => {
  const h = hostWith();
  h.addClip(9, h.root, { name: 'sub of 1', sub: true, getMediaPath: () => '/v/C1.MP4' });
  assert.deepStrictEqual(h.call('find', { paths: ['/v/C1.MP4'] }).items.map(i => i.id), ['1']);
  assert.deepStrictEqual(h.call('collect', { mode: 'project' }).items.map(i => i.id), ['1', '2', '3']);
  h.options.searches = 0;
  const many = ['/v/C1.MP4'].concat(Array.from({ length: 120 }, (_, i) => '/v/none' + i + '.MP4'));
  assert.deepStrictEqual(h.call('find', { paths: many }).items.map(i => i.id), ['1'], 'one search for every item, past 100 paths');
  assert.equal(h.options.searches, 1);
  h.options.searches = 0;
  assert.deepStrictEqual(h.call('find', { paths: many.slice(0, 100) }).items.map(i => i.id), ['1'], 'one search per path up to 100');
  assert.equal(h.options.searches, 100);
  const sel = hostWithViews([], [[1, 9]]);
  sel.addClip(9, sel.root, { name: 'sub of 1', sub: true, getMediaPath: () => '/v/C1.MP4' });
  const picked = sel.call('collect', { mode: 'selection' });
  assert.deepStrictEqual([picked.items.map(i => i.id), picked.picked.subclips], [['1'], 1]);
});

test('0.4 host: a write looks the project up once: later batches reuse the index, the last lets it go', () => {
  const h = hostWith();
  const one = h.call('label', { project: '/p.prproj', items: pairs('1'), color: 3, write: 'w1' });
  const two = h.call('label', { project: '/p.prproj', items: pairs('2'), color: 3, write: 'w1' });
  assert.deepStrictEqual([one.index.reused, two.index.reused], [false, true]);
  assert.ok(h.sandbox.slCache && h.sandbox.slCache.token === 'w1');
  const last = h.call('label', { project: '/p.prproj', items: pairs('3'), color: 3, write: 'w1', final: true });
  assert.equal(last.index.reused, true);
  assert.equal(h.sandbox.slCache, null, 'let go after the last batch');
  assert.equal(h.call('label', { project: '/p.prproj', items: pairs('1'), color: 4, write: 'w2' }).index.reused, false, 'another write looks again');
  assert.equal(h.call('label', { project: '/p.prproj', items: pairs('1'), color: 5 }).index.reused, false, 'no write id, no reuse');
  // A clip changed between two batches of one write is still left alone: its path is checked every time.
  h.call('label', { project: '/p.prproj', items: pairs('1'), color: 6, write: 'w3' });
  h.clip(2).getMediaPath = () => '/v/Other.MP4';
  const later = h.call('label', { project: '/p.prproj', items: pairs('2'), color: 6, write: 'w3', final: true });
  assert.deepStrictEqual([later.changed, later.skipped[0].error], [0, 'now a different clip']);
  // Loading the host again keeps a write's index.
  h.call('label', { project: '/p.prproj', items: pairs('1'), color: 7, write: 'w4' });
  require('vm').runInContext(fs.readFileSync(path.join(__dirname, '../host/select.jsx'), 'utf8'), h.sandbox);
  assert.equal(h.call('label', { project: '/p.prproj', items: pairs('3'), color: 7, write: 'w4', final: true }).index.reused, true);
  // Undo's batches share one too, and a bins write keeps the bins it made in it.
  const b = hostWith(), res = b.call('bins', { ...binsArgs(), write: 'b1' });
  assert.equal(b.call('restore', { project: '/p.prproj', restore: res.restore, final: true, write: 'u1' }).restored, 3);
});

test('0.4 host: open goes by the id the scan gave, and by the path only when that id has gone', () => {
  const h = hostWith();
  let opened = null;
  h.sandbox.app.sourceMonitor = { openProjectItem(it) { opened = it.nodeId; } };
  h.options.searches = 0;
  let r = h.call('open', { project: '/p.prproj', id: '2', path: '/v/C2.MP4' });
  assert.deepStrictEqual([r.ok, r.by, r.id, opened], [true, 'id', '2', 2]);
  assert.equal(h.options.searches, 1, 'one search for that path, no walk');
  r = h.call('open', { project: '/p.prproj', id: '77', path: '/v/C3.MP4' });
  assert.deepStrictEqual([r.ok, r.by, r.id], [true, 'path', '3'], 'an id from before a revert: the clip with that path');
  r = h.call('open', { project: '/p.prproj', id: '1', path: '/v/gone.MP4' });
  assert.deepStrictEqual([r.ok, r.code], [false, 'not-found']);
  assert.equal(h.call('open', { project: '/elsewhere.prproj', id: '1', path: '/v/C1.MP4' }).code, 'wrong-project');
  const app = fs.readFileSync(path.join(__dirname, '../client/app.js'), 'utf8');
  assert.match(app, /openId\(known, st\.project, true\)/, 'the panel opens by the scan\'s id first');
});

test('0.4 host: reveal selects the clips in the Project panel, by id and path, and says what it could not', () => {
  const h = hostWith();
  const r = h.call('reveal', { project: '/p.prproj', items: pairs('1', '3', '9') });
  assert.ok(r.ok);
  assert.deepStrictEqual([r.selected, r.asked, r.skipped.map(s => s.id)], [2, 2, ['9']]);
  assert.deepStrictEqual(Array.from(h.sandbox.app.getProjectViewSelection('view0'), i => i.nodeId), [1, 3]);
  assert.equal(h.call('reveal', { project: '/p.prproj', items: pairs('9') }).code, 'not-found');
  assert.equal(h.call('reveal', { project: '/p.prproj', items: [] }).code, 'empty');
  assert.equal(h.call('reveal', { project: '/p.prproj', items: Array.from({ length: 501 }, (_, i) => [String(i), '/v/x.MP4']) }).code, 'too-many');
  const blind = hostWith();
  blind.sandbox.app.getProjectFromViewID = () => ({ path: '/other.prproj' });
  assert.equal(blind.call('reveal', { project: '/p.prproj', items: pairs('1') }).code, 'no-view');
  // It changes nothing in the project, so playback doesn't stop it; a dialog does.
  const playing = hostWith();
  playing.sandbox.qe.source.player.isPlaying = true;
  assert.ok(playing.call('reveal', { project: '/p.prproj', items: pairs('1') }).ok);
  assert.equal(playing.call('label', { project: '/p.prproj', items: pairs('1'), color: 1 }).code, 'playing');
});

test('0.4 host: Make Sequence: one new sequence at the top, in the order given, never over another name, and Undo removes exactly it', () => {
  const h = hostWith();
  h.sandbox.app.project.createNewSequenceFromClips('Old cut', [h.clip(1)], h.root);
  h.root.createBin('SELECT 2026-11-04 Interviews');
  const order = pairs('3', '1', '2');
  const made = h.call('sequence', { project: '/p.prproj', name: 'SELECT 2026-11-04 Interviews', items: order.concat([['9', '/v/C9.MP4']]), open: true, write: 's1' });
  assert.ok(made.ok, made.message);
  assert.equal(made.name, 'SELECT 2026-11-04 Interviews (2)', 'a bin at the top already has the name');
  assert.deepStrictEqual([made.clips, made.inOrder, made.opened, made.othersKept], [3, true, true, true]);
  assert.deepStrictEqual(Array.from(h.seqs[1].v1, c => String(c.projectItem.nodeId)), ['3', '1', '2']);
  assert.deepStrictEqual(made.skipped.map(s => s.id), ['9']);
  assert.deepStrictEqual(made.settings, { width: 1920, height: 1080, fps: 25, par: null });
  assert.equal(made.restore.kind, 'sequence');
  assert.deepStrictEqual(made.restore.items[0].slice(0, 4), [made.sequenceID, made.id, made.name, 3]);
  assert.ok(h.root.kids.some(k => String(k.nodeId) === made.id), 'its project item is at the top of the project');
  // Undo: only that sequence goes, found by its id, even while it is open in front.
  assert.equal(h.sandbox.app.project.activeSequence, h.seqs[1]);
  const back = h.call('restore', { project: '/p.prproj', restore: made.restore, final: true, write: 'u1' });
  assert.deepStrictEqual([back.restored, back.skipped, back.failed.length], [1, 0, 0]);
  assert.deepStrictEqual(h.seqs.map(q => q.name), ['Old cut']);
  assert.equal(h.call('restore', { project: '/p.prproj', restore: made.restore, final: true }).skipped, 1, 'already gone');
  // Worked in since: left alone.
  const again = h.call('sequence', { project: '/p.prproj', name: 'Picks', items: pairs('1', '2'), write: 's2' });
  h.seqs[1].name = 'Picks, renamed';
  assert.deepStrictEqual([h.call('restore', { project: '/p.prproj', restore: again.restore }).skipped, h.seqs.length], [1, 2]);
  const third = h.call('sequence', { project: '/p.prproj', name: 'More', items: pairs('1', '2'), write: 's3' });
  h.seqs[2].end = '1';
  assert.equal(h.call('restore', { project: '/p.prproj', restore: third.restore }).skipped, 1, 'a changed end is a change');
  const kept = hostWith({ keepSequences: true }), k = kept.call('sequence', { project: '/p.prproj', name: 'K', items: pairs('1') });
  const stuck = kept.call('restore', { project: '/p.prproj', restore: k.restore });
  assert.deepStrictEqual([stuck.restored, stuck.failed[0].error, stuck.remaining.items.length], [0, 'did not go', 1]);
  // Nothing found, or nothing made: nothing changed.
  assert.equal(h.call('sequence', { project: '/p.prproj', name: 'X', items: [['9', '/v/C9.MP4']] }).code, 'empty');
  assert.equal(hostWith({ noSequence: true }).call('sequence', { project: '/p.prproj', name: 'X', items: pairs('1') }).code, 'failed');
  assert.equal(h.call('sequence', { project: '/p.prproj', name: 'X', items: Array.from({ length: 2001 }, () => ['1', '/v/C1.MP4']) }).code, 'too-many');
  // A Premiere that makes the sequence and answers nothing: the new sequence of that name is the one made, and Undo reaches it.
  const mute = hostWith(), real = mute.sandbox.app.project.createNewSequenceFromClips;
  mute.sandbox.app.project.createNewSequenceFromClips = (n, list, into) => { real(n, list, into); return undefined; };
  const quiet = mute.call('sequence', { project: '/p.prproj', name: 'Quiet', items: pairs('2', '1') });
  assert.deepStrictEqual([quiet.ok, quiet.clips, quiet.inOrder, quiet.name], [true, 2, true, 'Quiet']);
  assert.equal(mute.call('restore', { project: '/p.prproj', restore: quiet.restore }).restored, 1);
  assert.equal(h.call('sequence', { project: '/elsewhere.prproj', name: 'X', items: pairs('1') }).code, 'wrong-project');
  assert.equal(C.undoWords({ kind: 'sequence', restore: made.restore }), 'Removes the sequence ' + made.name + '.');
});

test('0.4 host: Sort into Bins can make one bin with no bins inside, read back and undone like the others', () => {
  const h = hostWith();
  h.root.createBin('SELECT x');
  const sent = { project: '/p.prproj', root: 'SELECT x', single: true, buckets: [{ name: 'SELECT x', items: pairs('1', '3') }], write: 'b1', final: true };
  const res = h.call('bins', sent);
  assert.ok(res.ok);
  assert.equal(res.root, 'SELECT x (2)');
  const top = h.root.kids.find(k => String(k.nodeId) === res.top);
  assert.deepStrictEqual(top.kids.map(k => k.nodeId), [1, 3], 'the clips sit in the bin itself');
  const check = h.call('binsCheck', { project: '/p.prproj', top: res.top, single: true, name: 'SELECT x' });
  assert.deepStrictEqual(check.buckets, [{ name: 'SELECT x', ids: ['1', '3'] }]);
  const back = h.call('restore', { project: '/p.prproj', restore: res.restore, final: true, write: 'u1' });
  assert.deepStrictEqual([back.restored, back.binRemoved], [2, true]);
  assert.ok(!h.root.kids.some(k => String(k.nodeId) === res.top));
});

test('wording: Undo has one name, and refusals name projects plainly', () => {
  assert.equal(C.COLUMN.audioDb.label, 'Loudness');
  assert.equal(C.COLUMN.audioDb.label, C.SORT.audioDb.label, 'the table and the Sort menu agree');
  const html = fs.readFileSync(path.join(__dirname, '../client/index.html'), 'utf8');
  assert.match(html, /data-menu="undo" hidden>Undo</);
  assert.match(html, /id="undo-write" class="action" hidden>Undo</);
  assert.match(html, /data-menu="undo-view"[^>]*>Previous View</);
  assert.ok(!/Undo Last Write|>Undo View<|Undo Write/.test(html));
  // Since 0.4 the editor sees one word, Undo: no "Undo Write" left in what the panel says.
  const app = fs.readFileSync(path.join(__dirname, '../client/app.js'), 'utf8'), core = fs.readFileSync(path.join(__dirname, '../client/core.js'), 'utf8');
  assert.ok(!/Undo Write/.test(app + core), 'no Undo Write in the panel');
  assert.ok(!/foot-close/.test(html + app), 'no × on the status: a write that worked goes by itself');
  const wrong = hostWith().call('label', { project: '/Volumes/Field SSD/Projects/north-pier.prproj', items: pairs('1'), color: 5 });
  assert.equal(wrong.message, 'The project in front is p, not north-pier.');
  assert.ok(!/\/Volumes|\.prproj/.test(wrong.message), 'no full path');
  const twin = hostWith().call('restore', { project: '/elsewhere/p.prproj', restore: { kind: 'label', color: 5, items: [] } });
  assert.match(twin.message, /^The project in front is another p, in a different folder\./);
  const long = C.footState({ ...facts({}), busy: 'x', write: { kind: 'write', verb: 'Labelling', done: 100, total: 973 } });
  assert.ok(!/busy for a moment/.test(long.sentence));
});

// ExtendScript is ES3. Code with strings, regex literals and comments blanked out (same length, lines kept), so the
// patterns below see code alone.
function codeOnly(src) {
  let out = '', i = 0, prev = '';   // prev: the last word or character of code, to tell a regex from a division
  const n = src.length, blank = t => t.replace(/[^\n]/g, ' ');
  const regexMayStart = () => prev === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || /^(return|typeof|in|new|delete|void|throw|case|do|else)$/.test(prev);
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && (d === '/' || d === '*')) {
      const e = d === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2) + 2;
      const end = e < (d === '/' ? 0 : 2) ? n : e;
      out += blank(src.slice(i, end)); i = end; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') { j++; } j++; }
      out += c + blank(src.slice(i + 1, j)) + c; i = j + 1; prev = 'string'; continue;
    }
    if (c === '/' && regexMayStart()) {
      let j = i + 1, inClass = false;
      while (j < n && (src[j] !== '/' || inClass)) { if (src[j] === '\\') { j++; } else if (src[j] === '[') { inClass = true; } else if (src[j] === ']') { inClass = false; } j++; }
      let k = j + 1;
      while (k < n && /[a-z]/i.test(src[k])) { k++; }
      out += '/' + blank(src.slice(i + 1, j)) + '/' + src.slice(j + 1, k); i = k; prev = 'regex'; continue;
    }
    if (/[A-Za-z_$]/.test(c)) { let j = i; while (j < n && /[\w$]/.test(src[j])) { j++; } prev = src.slice(i, j); out += prev; i = j; continue; }
    if (!/\s/.test(c)) { prev = c; }
    out += c; i++;
  }
  return out;
}

// What ExtendScript doesn't have. Array.prototype.indexOf is missing there too, but a read can't tell it from String's,
// which is fine: the host's own header keeps indexOf to strings.
const ES3_RULES = [
  [/\blet\s+[\w$[{]/, '`let`'], [/\bconst\s+[\w$[{]/, '`const`'], [/=>/, 'an arrow function'], [/`/, 'a template literal'],
  [/\bclass\s+[\w$]/, '`class`'], [/\.\.\.\s*[\w$[({]/, 'spread or rest'], [/\bfor\s*\([^)]*\bof\b/, 'for…of'],
  [/\b(async|await|yield)\b/, 'async, await or yield'], [/\bfunction\s*\*/, 'a generator'],
  [/,\s*\)/, 'a trailing comma in a call or parameter list'], [/,\s*\}/, 'a trailing comma in an object literal'], [/,\s*\]/, 'a trailing comma in an array literal'],
  [/\b(get|set)\s+[\w$]+\s*\(/, 'a getter or setter'], [/[{,]\s*(?!(?:if|for|while|switch|catch|with|function|return)\b)[\w$]+\s*\([^)]*\)\s*\{/, 'a method shorthand'],
  [/\.(forEach|map|filter|reduce|reduceRight|some|every|find|findIndex|includes|fill|flat|flatMap)\s*\(/, 'an array method ExtendScript lacks'],
  [/\.(trim|trimStart|trimEnd|startsWith|endsWith|padStart|padEnd|repeat|codePointAt|normalize|toISOString|toJSON)\s*\(/, 'a string or date method ExtendScript lacks'],
  [/\.bind\s*\(/, 'Function.prototype.bind'],
  [/\b(Array\.(isArray|from|of)|Object\.(keys|values|entries|assign|create|defineProperty|defineProperties|freeze|seal|getPrototypeOf|getOwnPropertyNames)|Date\.now|Number\.(isFinite|isNaN|isInteger|parseFloat|parseInt)|String\.(raw|fromCodePoint))\b/, 'an ES5 or later built-in'],
  [/\b(JSON|Promise|Map|Set|WeakMap|WeakSet|Symbol|Proxy|Reflect)\b/, 'a global ExtendScript lacks'],
  [/(^|[^\w$.])\d+n\b/, 'a BigInt'], [/\?\?|\?\.(?!\d)|\*\*/, 'an ES2016 or later operator']
];

function es3Problems(src) {
  const code = codeOnly(src), lines = src.split('\n'), found = [];
  for (const [re, what] of ES3_RULES) {
    const g = new RegExp(re.source, 'g');
    let m;
    while ((m = g.exec(code))) {
      const line = code.slice(0, m.index).split('\n').length;
      found.push(`line ${line}: ${what}: ${lines[line - 1].trim()}`);
    }
  }
  return found;
}

test('N7: the ExtendScript host uses ES3 only, and the check catches what ExtendScript lacks', () => {
  const host = fs.readFileSync(path.join(__dirname, '../host/select.jsx'), 'utf8');
  assert.deepStrictEqual(es3Problems(host), []);
  // ExtendScript may read the file in the Mac's own encoding, so a character past ASCII, even in a regex, would change.
  assert.ok(/^[\x00-\x7f]*$/.test(host), 'the host file is pure ASCII');
  // It parses JSON by eval and writes it with slJson, because ExtendScript has no JSON object.
  assert.match(host, /eval\('\(' \+ json \+ '\)'\)/);
  assert.match(host, /^function slJson\(v\)/m);
  // The check itself: each of these is caught...
  const bad = ['[1].forEach(function (x) {});', 'x = list.map(f);', 'x = list.filter(f);', 'let a = 1;', 'const a = 1;', 'var g = (x) => x;',
    'var s = `a${b}`;', 'f(a, b,\n);', 'var o = { a: 1, };', 'var k = Object.keys(o);', 'var j = JSON.stringify(o);', 's = s.trim();',
    't = Date.now();', 'Array.isArray(x);', 'f.bind(this);', 'var o = { m(x) { return x; } };', 'var o = { get x() { return 1; } };', 'f(...args);', 'for (var x of y) {}'];
  for (const src of bad) { assert.equal(es3Problems(src).length > 0, true, src); }
  // ...and the same words in strings, comments and regex literals, or ES3 that looks close, are not.
  const fine = "// a.forEach(x => x) `t` let const JSON\nvar s = 'a.map(f) => `x` let b, ) JSON.parse'; var r = /,\\s*\\)|=>|`/g; var d = a / b / c;\n" +
    "var o = { 'k': 1 }; if (x) { y(); } for (k in o) { if (o.hasOwnProperty(k)) { z(k); } }\nfunction f(a, b) { return a ? .5 : b; }\n/* JSON.stringify(x, ) */ var t = \"Object.keys(o)\"; var i = s.indexOf('x');";
  assert.deepStrictEqual(es3Problems(fine), []);
});

test('host: quoting stays pure ASCII for accents, quotes, controls and line separators', () => {
  const sb = {};
  require('vm').createContext(sb);
  require('vm').runInContext(fs.readFileSync(path.join(__dirname, '../host/select.jsx'), 'utf8'), sb);
  for (const s of ['plain', 'Crème Brûlée "A"\\x', 'line\nbreak\t\u0001', '  ￿', 'Créme']) {
    const q = sb.slQuote(s);
    assert.ok(/^[\x20-\x7e]*$/.test(q), q);
    assert.equal(JSON.parse(q), s);
  }
});

test('L4: a write or an open asks the host for its own clips only, in either Unicode form', () => {
  const h = hostWith();
  h.root.kids[2].getMediaPath = () => '/v/Cre\u0301me.MP4';
  const got = h.call('find', { paths: ['/v/C1.MP4', '/v/Cr\u00e9me.MP4', '/v/Cre\u0301me.MP4', '/v/not-here.MP4'] });
  assert.ok(got.ok);
  assert.deepStrictEqual(got.items.map(i => [i.id, i.path]), [['1', '/v/C1.MP4'], ['3', '/v/Cre\u0301me.MP4']]);
  const app = fs.readFileSync(path.join(__dirname, '../client/app.js'), 'utf8');
  assert.match(app, /host\('find', \{ paths: paths \}\)/, 'resolveIds uses find, not a walk of the whole project');
  assert.match(app, /normalize\('NFD'\)/);
});

test('speed: text columns sort on ranks in exactly the collator\'s order, and a changed value is seen', () => {
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  // The order before ranks: the collator inside every comparison, empty last both ways, ties in scan order.
  const reference = (rows, key, dir) => rows.map((r, i) => i).sort((a, b) => {
    const x = rows[a][key] || null, y = rows[b][key] || null;
    if (x === null || y === null) { return x === y ? a - b : x === null ? 1 : -1; }
    return collator.compare(x, y) * dir || a - b;
  });
  const names = ['C10.MP4', 'C2.MP4', 'c2.mp4', 'Crème', 'Creme', null, '', 'A0001', 'a0001', 'Zoë', 'zoe', 'C2.MP4'];
  const rows = names.map((name, i) => ({ name, camera: i % 3 ? 'SONY ILME-FX3' : i % 2 ? 'Canon EOS R5' : null, labelText: name && name.length > 5 ? name.slice(1) : null, version: 1 }));
  for (const key of ['name', 'camera', 'labelText']) {
    for (const dir of [1, -1]) {
      assert.deepStrictEqual(C.sortOrder(rows, rows.map((r, i) => i), [by(key, dir)]), reference(rows, key, dir), key + ' ' + dir);
    }
  }
  const s = storeFromFixture(fixture);
  for (const key of ['name', 'camera', 'lens', 'codec', 'soundText', 'screenText', 'labelText']) {
    assert.deepStrictEqual(C.sortOrder(s.rows, s.rows.map((r, i) => i), [by(key, 1)]), reference(s.rows, key, 1), key);
  }
  rows[0].name = 'A0000';
  assert.equal(C.sortOrder(rows, rows.map((r, i) => i), [by('name', 1)])[0], 0, 'a new value is sorted, not an old rank');
});

test('speed: the Show menu counts every Show in one pass, and agrees with each Show alone', () => {
  const s = storeFromFixture(fixture);
  C.ingest(s, { type: 'groups', groups: fixtureGroups(fixture) });
  const all = C.showCounts(s.rows);
  for (const sh of C.SHOWS) {
    assert.equal(all[sh.id].n, C.showCount(s.rows, sh.id), sh.id);
    assert.equal(all[sh.id].known, C.dataStatus(s.rows, sh.id, false) === 'ok', sh.id);
  }
  const bare = C.showCounts([{ name: 'x', durationS: 3 }]);
  assert.equal(bare.people.known, false);
  assert.equal(bare.silent.known, true, 'Silent needs no Tier 2');
});

test('speed: the search text built in idle time is the one a search uses', () => {
  const s = storeFromFixture(fixture), rows = s.rows;
  let budget = 1;
  const first = C.warmSearch(rows, 0, () => budget-- > 0);
  assert.ok(first > 0 && first < rows.length, 'it stops when the idle time runs out, and says where');
  assert.equal(C.warmSearch(rows, first, () => true), rows.length);
  assert.ok(rows.every(r => typeof r.hay === 'string' && r.hayVersion === r.version));
  const tokens = C.searchTokens('bread');
  const warm = C.computeView(rows, V(), null, { tokens }).order;
  rows.forEach(r => { r.hay = undefined; });
  assert.deepStrictEqual(C.computeView(rows, V(), null, { tokens }).order, warm);
});
