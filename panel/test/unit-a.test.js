// Package A of 0.4: the scan target, names, bins, Make Sequence, last results, the green ink, and the platform limits.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../client/core.js');
const N = require('../client/native.js');

const V = o => ({ show: null, sort: [], families: [], ...o });
const by = (key, dir) => ({ key, dir });
const O = { connected: true, project: { path: '/p/rushsort-test.prproj', name: 'rushsort-test.prproj' }, title: 'rushsort-test' };
const items = (n, folder) => Array.from({ length: n }, (_, i) => ({ id: String(i), path: `/v/${folder || 'Day 2'}/C${1000 + i}.MP4`, bin: folder || 'Day 2' }));

function contrast(a, b) {
  const lum = hex => {
    const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test('the scan target in the status\'s words, every row of the table', () => {
  const w = (t, o, others) => { const x = C.targetWords(t, { ...O, ...o }, others); return [x.verdict, x.sentence, x.scan]; };
  const whole = { kind: 'project', sig: '', items: items(965), places: [], more: 0 };
  assert.deepStrictEqual(w(whole), ['Whole project', '965 clips', true]);
  assert.equal(C.targetWords(whole, O).tip, 'rushsort-test', 'the project, in the tooltip');
  assert.equal(C.targetWords({ ...whole, sig: '1:a:a' }, O).tip, 'No video clips in the selection', 'a sequence selected reads the whole project');
  assert.deepStrictEqual(w({ kind: 'clips', sig: '12:a:b', items: items(12), places: ['Day 2'], more: 0 }), ['12 clips selected', 'Day 2', true]);
  assert.deepStrictEqual(w({ kind: 'clips', sig: '12:a:b', items: items(12), places: [''], more: 0 }), ['12 clips selected', '', true], 'at the top of the project');
  assert.deepStrictEqual(w({ kind: 'clips', sig: '12:a:b', items: items(12), places: ['Day 2', 'Day 3'], more: 0 }), ['12 clips selected', 'Day 2, Day 3', true]);
  assert.deepStrictEqual(w({ kind: 'clips', sig: '12:a:b', items: items(12), places: ['Day 2', 'Day 3', 'Day 4'], more: 1 }), ['12 clips selected', 'Day 2 and 3 more', true]);
  assert.deepStrictEqual(w({ kind: 'clips', sig: '1:a:a', name: 'C7937.MP4', items: items(1), places: ['Day 2'], more: 0 }), ['1 clip selected', 'C7937.MP4', true]);
  assert.deepStrictEqual(w({ kind: 'bins', sig: '1:b:b', items: items(40), places: ['Day 2'], more: 0 }), ['Day 2', '40 clips', true]);
  assert.deepStrictEqual(w({ kind: 'bins', sig: '2:b:c', items: items(40), places: ['Day 2', 'Day 3'], more: 0 }), ['Day 2, Day 3', '40 clips', true]);
  assert.deepStrictEqual(w({ kind: 'several', several: 2, sig: 'several:2', items: [] }), ['Selections in 2 Project panels', '', false]);
  assert.deepStrictEqual(w({ kind: 'project', sig: '', items: [{ path: '/a/song.wav' }], places: [] }), ['No video clips', '', false]);
  assert.deepStrictEqual(w(whole, { project: null }), ['No project open', '', false]);
  assert.deepStrictEqual(w(null), ['Waiting for Premiere', '', false]);
  assert.deepStrictEqual(w(whole, { connected: false }), ['Waiting for Premiere', '', false]);
  assert.equal(C.targetWords({ kind: 'clips', sig: '12:a:b', items: items(12), places: ['Day 2'], more: 0 }, O).scanTip, '12 clips selected · Day 2', 'Scan\'s tooltip is what it would read');
  assert.equal(C.targetWords({ kind: 'clips', sig: '9:a:b', items: items(9, 'Day 3'), places: ['Day 3'], more: 0 }, O, 8).scanTip, '8 other clips selected · Day 3', 'after a scan, the clips the results lack');
});

test('a target counts what a scan would make rows of, and says how many the results lack', () => {
  const t = { kind: 'clips', items: [{ path: '/v/A.MP4' }, { path: '/v/A.MP4' }, { path: '/v/B.mov' }, { path: '/v/c.wav' }, { path: '/v/.hidden.mp4' }, { path: '/v/Café.mp4' }] };
  assert.equal(C.targetCount(t), 3, 'video only, one per file, either Unicode form the same file');
  const store = C.createStore();
  C.addItems(store, [{ path: '/v/A.MP4' }, { path: '/v/Café.mp4' }]);
  assert.equal(C.otherClips(t, store), 1, 'B.mov is new; A and Café are in the results');
  assert.equal(C.otherClips(t, store.rows), 1, 'rows do as well as a store');
  assert.ok(!C.sameTarget(t, store));
  C.addItems(store, [{ path: '/v/B.mov' }]);
  assert.ok(C.sameTarget(t, store), 'a selection inside the results changes nothing');
  assert.equal(C.otherClips({ kind: 'several', items: [] }, store), 0);
  assert.equal(C.otherClips(null, store), 0);
  assert.equal(C.placeWords([], 0), '');
  assert.equal(C.placeWords(['', 'Day 2'], 0), 'Day 2', 'the top of the project has no name');
});

test('names: SELECT, today, then what is on screen', () => {
  const now = new Date(2026, 10, 4, 12, 0).getTime();
  const name = (view, q, picked, from) => C.sequenceName(view, q, picked, from, now);
  assert.equal(name(V({ show: 'interviews', sort: [by('durationS', -1)] }), '', 0, 'Day 2'), 'SELECT 2026-11-04 Interviews, longest first');
  assert.equal(name(V({ families: ['red'], show: 'wides' }), '', 0, 'Day 2'), 'SELECT 2026-11-04 Red, wides');
  assert.equal(name(V({ show: 'interviews' }), 'sunset', 0, 'Day 2'), 'SELECT 2026-11-04 Interviews, “sunset”', 'a search after the view');
  assert.equal(name(V(), ' sunset ', 0, 'Day 2'), 'SELECT 2026-11-04 “sunset”', 'a search alone');
  assert.equal(name(V(), '', 3, 'Day 2'), 'SELECT 2026-11-04 Selects', 'picks with Everything as listed');
  assert.equal(name(V({ show: 'speech' }), '', 3, 'Day 2'), 'SELECT 2026-11-04 Speech', 'picks with a view: the view');
  assert.equal(name(V(), '', 0, 'Day 2'), 'SELECT 2026-11-04 Day 2', 'nothing on: where the scan came from');
  assert.equal(name(V(), '', 0, 'rushsort-test'), 'SELECT 2026-11-04 rushsort-test');
  assert.equal(C.viewWhat(V({ families: ['teal'], sort: [by('colorName', 1)] }), '', 0, 'x'), 'Teal');
});

test('Sort into Bins: several bins as the view says, one bin for a Show, a colour, a search or picks, else none', () => {
  assert.equal(C.binsPlan(V({ sort: [by('colorName', 1)] })), 'several', 'a bin per colour');
  assert.equal(C.binsPlan(V({ sort: [by('createdAt', 1)] })), 'several', 'a bin per day');
  assert.equal(C.binsPlan(V({ sort: [by('sharpness', -1)] })), 'several', 'fifths');
  assert.equal(C.binsPlan(V({ sort: [by('camera', 1)] })), 'several', 'a bin per value');
  assert.equal(C.binsPlan(V({ show: 'similar' })), 'several', 'a bin per group');
  assert.equal(C.binsPlan(V({ show: 'interviews' })), 'one');
  assert.equal(C.binsPlan(V({ families: ['teal'], sort: [by('colorName', 1)] })), 'one', 'a colour dot, with the rainbow it brings');
  assert.equal(C.binsPlan(V({ families: ['teal'], sort: [by('sharpness', -1)] })), 'several', 'a colour sorted by sharpness: its fifths');
  assert.equal(C.binsPlan(V(), 'bread'), 'one');
  assert.equal(C.binsPlan(V(), '', 3), 'one');
  assert.equal(C.binsPlan(V()), null);
  assert.equal(C.binsPlan(V({ sort: [by('name', 1)] })), null, 'a name order makes no bins');
});

// A foot's facts, finished unless a test says otherwise.
function facts(over) {
  const store = { total: 301, tier0: 301, tier1: 301, errors: 0, bad: 0, notRead: 0 };
  return {
    ...O, listing: false, busy: null, outcome: null, store, rows: 301, shown: 301, selected: 0, groupCount: 0, query: '',
    view: V({ sort: [by('sharpness', 1)] }), scan: { state: 'Done', failure: null, seconds: 1, stopping: false }, target: null, others: 0, ...over
  };
}

test('the blue: Sort into Bins, always, blue when it can make bins and off when it can\'t; it never hops to Make Sequence', () => {
  assert.equal(C.footState(facts()).primary, 'bins');
  const listed = C.footState(facts({ view: V() }));
  assert.equal(listed.primary, 'bins', 'a view that makes no bins: still Sort into Bins, off, so no blue at all');
  assert.ok(listed.binsOff, 'Sort into Bins is off, as in 0.3');
  assert.equal(C.footState(facts({ view: V(), selected: 3 })).primary, 'bins', 'picked clips make one bin');
  assert.equal(C.footState(facts({ view: V(), query: 'bread' })).primary, 'bins', 'so does a search');
  assert.equal(C.footState(facts({ view: V(), others: 5, target: { kind: 'clips', items: [] } })).primary, 'bins', 'a new Premiere selection does not move it');
  assert.deepStrictEqual(C.footState(facts()).actions, ['sequence', 'bins'], 'Label is in the right-click menu only');
});

test('results from another project: From that project, and only a blue Scan', () => {
  const target = { kind: 'project', sig: '', items: items(512), places: [] };
  const f = C.footState(facts({ foreign: 'rushsort-test', title: 'testt2', target }));
  assert.equal(f.kind, 'foreign');
  assert.equal(f.verdict, 'From rushsort-test');
  assert.equal(f.sentence, '');
  assert.deepStrictEqual(f.actions, ['scan'], 'no writes');
  assert.equal(f.primary, 'scan');
  assert.equal(f.scanTip, 'testt2 · Whole project · 512 clips');
  assert.deepStrictEqual(C.footState(facts({ foreign: 'rushsort-test', project: null })).actions, [], 'no project in front: nothing to scan');
  assert.equal(C.footState(facts({ foreign: 'rushsort-test', scan: { state: 'Scanning', failure: null, seconds: 1, stopping: false }, store: { total: 301, tier0: 3, tier1: 1, errors: 0, bad: 0 } })).kind, 'scanning', 'a scan under way says so first');
});

test('last results: coming back, then the view with when it was scanned in the tooltip, and what the cache lacked', () => {
  assert.deepStrictEqual(C.footState(facts({ restoring: true })), { kind: 'restoring', mark: 'running', verdict: 'Last results', sentence: '', actions: ['stop'] }, 'Stop while they come back');
  const now = new Date(2026, 10, 4, 9, 0).getTime(), at = new Date(2026, 10, 3, 18, 5).toISOString();
  const back = C.footState(facts({ lastAt: at, now }));
  assert.equal(back.verdict, 'Softest first');
  assert.equal(back.tip, 'Scanned yesterday at 18:05');
  const some = C.footState(facts({ lastAt: at, now, notRead: 12, view: V() }));
  assert.equal(some.verdict, '289 clips read', 'the clips read, not the rows');
  assert.equal(some.sentence, '12 not read');
  assert.deepStrictEqual(some.actions, ['sequence', 'bins', 'scan'], 'a grey Scan reads them');
  assert.equal(some.scanWhat, 'same');
  assert.equal(some.scanTip, 'The same 301 clips');
  assert.equal(C.footState(facts({ notRead: 12, shown: 40, view: V({ show: 'silent' }) })).sentence, '40 of 301 clips · 12 not read');
  assert.equal(C.whenLine(at, now), 'Scanned yesterday at 18:05');
  assert.equal(C.whenLine(at, now, 'Made'), 'Made yesterday at 18:05');
  assert.ok(C.isToday(new Date(2026, 10, 4, 1, 0).toISOString(), now) && !C.isToday(at, now) && !C.isToday('not a date', now));
});

test('after a scan, Scan reads the selection when it holds new clips, else the same clips again', () => {
  const target = { kind: 'clips', sig: '3:a:b', items: items(3, 'Day 3'), places: ['Day 3'] };
  const stopped = { state: 'Stopped', failure: null, seconds: 1, stopping: false };
  assert.equal(C.footState(facts({ scan: stopped })).scanWhat, 'same', 'Stopped: finish these');
  assert.equal(C.footState(facts({ scan: stopped, target, others: 3 })).scanWhat, 'target');
  assert.equal(C.footState(facts({ scan: null, rows: 0, target })).scanWhat, 'target');
});

test('Make Sequence: held with the other writes, one call with no count climbing and no Stop, green only when V1 is whole and in order', () => {
  const store = { total: 301, tier0: 301, tier1: 301, errors: 1, tier2: 120, tier2Failed: 0, bad: 0 };
  const scan = { state: 'Scanning', failure: null, seconds: 2, stopping: false };
  const held = C.footState(facts({ store, scan, view: V({ sort: [by('colorName', 1)] }), needsTier2: true }));
  assert.deepStrictEqual(held.held, ['label', 'sequence', 'bins'], 'the right-click Label waits with them');
  assert.equal(held.wait, 'Waits for looking closer');
  const w = C.footState(facts({ busy: 'Making a sequence of 420 clips', write: { kind: 'write', verb: 'Making a sequence of', unit: 'clip', done: 420, total: 420, whole: true } }));
  assert.equal(w.verdict, 'Making a sequence of 420 clips');
  assert.deepStrictEqual(w.actions, [], 'nothing to stop between batches');
  const sent = { items: [['1', '/v/1.mp4'], ['2', '/v/2.mp4'], ['3', '/v/3.mp4']] };
  const acc = r => { const a = C.writeAcc('sequence'); C.addBatch('sequence', a, r); return a; };
  const proved = C.writeOutcome('sequence', sent, acc({ ok: true, clips: 3, inOrder: true, name: 'S', skipped: [] }));
  assert.deepStrictEqual([proved.green, proved.verdict, proved.sentence, proved.undo], [true, 'Made a sequence of 3 clips', '', true]);
  const short = C.writeOutcome('sequence', sent, acc({ ok: true, clips: 2, inOrder: true, name: 'S', skipped: [] }));
  assert.deepStrictEqual([short.green, short.kind, short.verdict, short.sentence], [false, 'partial', '2 of 3 clips in the sequence', ''], 'the count first, so a cut line keeps it');
  assert.equal(short.failed.length, 1, 'Details says what is missing');
  const changed = C.writeOutcome('sequence', sent, acc({ ok: true, clips: 2, inOrder: true, name: 'S', skipped: [{ id: '3', error: 'now a different clip' }] }));
  assert.equal(changed.failed.length, 1, 'a clip changed since is the one missing');
  const order = C.writeOutcome('sequence', sent, acc({ ok: true, clips: 3, inOrder: false, name: 'S', skipped: [] }));
  assert.deepStrictEqual([order.green, order.verdict, order.sentence], [false, 'Made a sequence of 3 clips', 'Not in the order shown.']);
  const one = C.writeOutcome('sequence', { items: [['1', '/v/1.mp4']] }, acc({ ok: true, clips: 1, inOrder: true }));
  assert.equal(one.verdict, 'Made a sequence of 1 clip');
  const entry = { kind: 'sequence', meta: { name: 'SELECT 2026-11-04 Interviews' }, restore: { kind: 'sequence', items: [['s1', 'n1', 'SELECT 2026-11-04 Interviews (2)', 3, '0']] } };
  assert.equal(C.undoWords(entry), 'Removes the sequence SELECT 2026-11-04 Interviews (2).', 'the name Premiere gave it');
  // The host says why a sequence stays, and the status shows its words.
  const left = C.undoOutcome({ restored: 0, skipped: 1, failed: [], note: 'The sequence has changed. It stays.' }, 'sequence');
  assert.deepStrictEqual([left.verdict, left.sentence], ['Nothing went back', 'The sequence has changed. It stays.']);
  assert.equal(C.undoOutcome({ restored: 0, skipped: 1, failed: [], note: 'The sequence is in another sequence. It stays.' }, 'sequence').sentence, 'The sequence is in another sequence. It stays.');
  assert.equal(C.undoOutcome({ restored: 0, skipped: 1, failed: [] }, 'sequence').sentence, 'The sequence is already gone.', 'skipped with no note: it had gone');
  assert.equal(C.undoOutcome({ restored: 1, skipped: 0, failed: [] }, 'sequence').verdict, 'Undone');
});

test('one bin: Moved into a bin when it reads back whole', () => {
  const sent = { single: true, buckets: [{ name: 'SELECT 2026-11-04 “bread”', items: [['1', '/v/1.mp4'], ['2', '/v/2.mp4']] }] };
  const acc = C.writeAcc('bins');
  C.addBatch('bins', acc, { ok: true, moved: 2, top: 't1', root: 'R', buckets: [{ name: sent.buckets[0].name, moved: ['1', '2'] }] });
  acc.buckets = [{ name: sent.buckets[0].name, ids: ['1', '2'] }];
  const o = C.writeOutcome('bins', sent, acc);
  assert.deepStrictEqual([o.green, o.verdict], [true, 'Moved 2 clips into a bin']);
});

test('clips the cache could not answer are not read: under the name, in the count, never as an error', () => {
  const store = C.createStore();
  C.addItems(store, [{ path: '/v/a.mp4' }, { path: '/v/b.mp4' }]);
  assert.ok(C.ingest(store, { type: 'clip', tier: 0, path: '/v/a.mp4', cached: true, durationS: 12 }));
  assert.ok(C.ingest(store, { type: 'uncached', path: '/v/b.mp4', tier: 0, changed: false }));
  C.ingest(store, { type: 'uncached', path: '/v/b.mp4', tier: 0, changed: false });
  const b = store.byKey.get('/v/b.mp4');
  assert.equal(store.notRead, 1, 'counted once');
  assert.ok(b.notRead && !b.error && store.errors === 0);
  assert.equal(C.noPictureWords(b), 'Not read');
  assert.equal(C.tileFact(b, V(), []), 'Not read');
  assert.equal(C.tileFact(store.byKey.get('/v/a.mp4'), V(), []), '0:12.0');
});

test('the green of a proved write fits every Premiere grey as the other inks do: 4.5:1 on the ground and the foot, and still green', () => {
  for (let v = 20; v <= 245; v += 5) {
    const t = C.skinTokens({ red: v, green: v, blue: v }), g = t['safe-ink'];
    assert.match(g, /^#[0-9A-F]{6}$/, `${v}: ${g}`);
    for (const bg of [t.surface, t.foot]) { assert.ok(contrast(g, bg) >= 4.5, `${v}: safe-ink ${g} on ${bg}: ${contrast(g, bg).toFixed(2)}`); }
    const [r, gr, bl] = [1, 3, 5].map(i => parseInt(g.slice(i, i + 2), 16));
    assert.ok(gr - Math.max(r, bl) >= 40, `${v}: ${g} still reads as green`);
  }
  assert.equal(C.skinTokens({ red: 35, green: 35, blue: 35 })['safe-ink'], '#34C759', 'Premiere\'s default grey keeps the designed green');
  assert.equal(C.skinTokens({ red: 230, green: 230, blue: 230 })['safe-ink'], '#0F6E31');
  const app = fs.readFileSync(path.join(__dirname, '../client/app.js'), 'utf8');
  assert.match(app, /'focus-ring', 'safe-ink', 'band', 'edge', 'sel', 'warn'\]\.forEach/, 'the panel sets it from skinTokens with the others');
});

test('last results on disk: one record per project, the newest 20 kept, another project\'s or another format\'s never read', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-last-'));
  try {
    const L = N.lastResults, p = '/Volumes/Field SSD/Lantern/Lantern.prproj';
    assert.equal(L.load(p, home), null, 'none yet');
    const rec = { name: 'Lantern.prproj', at: '2026-11-03T17:05:00.000Z', paths: ['/v/a.mp4'], ids: [['7']], binPaths: [['Footage/Day 2']], target: { kind: 'bins', places: ['Day 2'] }, view: { show: 'interviews', sort: [], families: [] } };
    assert.deepStrictEqual(L.save(p, rec, home), { ok: true });
    const back = L.load(p, home);
    assert.deepStrictEqual([back.v, back.project, back.paths, back.binPaths, back.view.show], [1, p, ['/v/a.mp4'], [['Footage/Day 2']], 'interviews']);
    assert.equal(L.load(p.normalize('NFD'), home).project, p, 'either Unicode form of the path');
    assert.equal(L.load('/Volumes/Field SSD/Other.prproj', home), null);
    fs.writeFileSync(L.file(p, home), JSON.stringify({ ...back, v: 2 }));
    assert.equal(L.load(p, home), null, 'a newer format is left alone');
    fs.writeFileSync(L.file(p, home), '{"v":1,');
    assert.equal(L.load(p, home), null, 'a broken file is no record');
    // A save reads no other record to know which are newest: it keeps a small index of when each was saved.
    const records = () => fs.readdirSync(L.dir(home)).filter(n => /^[0-9a-f]{16}\.json$/.test(n));
    const read = fs.readFileSync, opened = [];
    fs.readFileSync = function (f) { opened.push(String(f)); return read.apply(this, arguments); };
    try {
      for (let i = 0; i < 23; i++) { L.save(`/p/${i}.prproj`, { paths: [] }, home); }
    } finally {
      fs.readFileSync = read;
    }
    assert.deepStrictEqual([...new Set(opened.map(f => path.basename(f)))], ['index.json'], 'only the index is read');
    assert.equal(records().length, 20);
    assert.ok(L.load('/p/22.prproj', home) && !L.load('/p/0.prproj', home), 'the oldest go');
    assert.ok(!fs.readdirSync(L.dir(home)).some(n => /\.tmp$/.test(n)), 'no temporary file left');
    // The index lost: the records it doesn't know count as the oldest, and the next save keeps 20 again.
    fs.unlinkSync(path.join(L.dir(home), 'index.json'));
    L.save('/p/new.prproj', { paths: [] }, home);
    assert.equal(records().length, 20);
    assert.ok(L.load('/p/new.prproj', home), 'the one just saved stays');
    // A record gone by hand leaves the index.
    const gone = records().find(n => n !== path.basename(L.file('/p/new.prproj', home)));
    fs.unlinkSync(path.join(L.dir(home), gone));
    L.save('/p/newer.prproj', { paths: [] }, home);
    assert.ok(!(gone in JSON.parse(fs.readFileSync(path.join(L.dir(home), 'index.json'), 'utf8'))));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Reveal in Finder: the engine\'s reveal of the first 20 on disk, every one selected; open -R on the first when the engine is missing or fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-finder-'));
  try {
    const paths = Array.from({ length: 25 }, (_, i) => path.join(dir, `C${i}.mp4`));
    paths.forEach((p, i) => { if (i !== 3) { fs.writeFileSync(p, ''); } });
    const engine = path.join(dir, 'select-engine');
    fs.writeFileSync(engine, '');
    fs.chmodSync(engine, 0o755);
    const want = paths.slice(0, 20).filter((p, i) => i !== 3);
    let calls = [], answer = null;
    const exec = (bin, args, opts, cb) => { calls.push({ bin, args, opts }); answer(bin, cb); };
    const reveal = (bin, list) => { let got = null; calls = []; N.revealInFinder(bin, list, (err, shown) => { got = { err, shown }; }, exec); return got; };
    const line = o => JSON.stringify(o) + '\n';

    answer = (bin, cb) => cb(null, line({ type: 'reveal', shown: 19, missing: 0, ms: 4 }), '');
    let got = reveal(engine, paths);
    assert.deepStrictEqual(calls.map(c => [c.bin, c.args]), [[engine, ['reveal'].concat(want)]], 'one engine call: the first 20 asked for, the missing one left out');
    assert.ok(calls[0].opts.timeout > 3000, 'stopped only after the engine\'s own 3 s');
    assert.deepStrictEqual(got, { err: null, shown: 19 });

    // The engine fails, one way or another: open -R on the first, so Reveal never does nothing.
    const open = [['/usr/bin/open', ['-R', want[0]]]];
    for (const fail of [
      (bin, cb) => cb(null, line({ type: 'error', message: 'The Finder took too long.', ms: 3000 }), ''),
      (bin, cb) => cb(Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }), '', ''),
      (bin, cb) => cb(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), '', ''),
      (bin, cb) => cb(null, 'not json\n', '')
    ]) {
      answer = (bin, cb) => (bin === engine ? fail(bin, cb) : cb(null, '', ''));
      got = reveal(engine, paths);
      assert.deepStrictEqual(calls.map(c => [c.bin, c.args]), [[engine, ['reveal'].concat(want)]].concat(open), fail.toString());
      assert.deepStrictEqual(got, { err: null, shown: 1 });
    }
    answer = (bin, cb) => cb(null, '', '');
    got = reveal(path.join(dir, 'no-engine'), paths);
    assert.deepStrictEqual([calls.map(c => [c.bin, c.args]), got], [open, { err: null, shown: 1 }], 'no engine: open -R on the first, at once');
    answer = (bin, cb) => (bin === engine ? cb(new Error('exit 1'), '', '') : cb(Object.assign(new Error('x'), { killed: true }), '', ''));
    got = reveal(engine, paths);
    assert.deepStrictEqual([got.err && got.err.message, got.shown], ['the Finder took too long', 0], 'both fail: the Finder didn\'t answer');

    // Gone from the disk between the look and the engine's: missing or offline.
    answer = (bin, cb) => cb(null, line({ type: 'reveal', shown: 0, missing: 2, ms: 1 }), '');
    got = reveal(engine, paths.slice(0, 2));
    assert.deepStrictEqual([calls.length, got], [1, { err: null, shown: 0 }]);
    got = reveal(engine, [path.join(dir, 'gone.mp4')]);
    assert.deepStrictEqual([calls.length, got.shown], [0, 0], 'nothing on disk: neither the engine nor the Finder is asked');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the platform's limits

// Code without its comments and strings, so a word in a comment, or in the words a panel says, never counts.
function codeOf(text, css) {
  let out = '', i = 0, quote = null;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) { quote = null; out += c; }
      i++;
      continue;
    }
    if (c === '/' && n === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; out += ' '; continue; }
    if (!css && c === '/' && n === '/') { const e = text.indexOf('\n', i); i = e < 0 ? text.length : e; continue; }
    if (!css && c === '/' && /[(,=:[!&|?{};]\s*$/.test(out)) {
      // A regular expression: its text stays, as code.
      let j = i + 1, cls = false;
      while (j < text.length && (text[j] !== '/' || cls)) { if (text[j] === '\\') { j++; } else if (text[j] === '[') { cls = true; } else if (text[j] === ']') { cls = false; } j++; }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '"' || c === '\'' || (!css && c === '`')) { quote = c; out += c; i++; continue; }
    out += c;
    i++;
  }
  return out;
}

// A rule inside another rule, as CSS nesting writes it. @media and @supports may hold rules, @keyframes its steps.
function nestedRules(css) {
  const stack = [], found = [];
  let prelude = '';
  for (const c of css) {
    if (c === '{') {
      const p = prelude.trim();
      if (stack.length && stack[stack.length - 1] === 'rule') { found.push(p); }
      stack.push(/^@(media|supports|document|layer)\b/.test(p) ? 'group' : /^@(-webkit-)?keyframes\b/.test(p) ? 'keyframes' : stack[stack.length - 1] === 'keyframes' ? 'step' : 'rule');
      prelude = '';
    } else if (c === '}') {
      stack.pop();
      prelude = '';
    } else if (c === ';') {
      prelude = '';
    } else {
      prelude += c;
    }
  }
  return found;
}

test('the panel keeps to Chromium 99 and Node 17, and the host to ES3', () => {
  const dir = path.join(__dirname, '../client');
  const banned = [[/color-mix\(/, 'color-mix'], [/:has\(/, ':has('], [/@container\b/, '@container'], [/\binert\b/, 'inert'], [/\.at\(/, '.at('],
    [/\bstructuredClone\b/, 'structuredClone'], [/\?\?=/, '??='], [/\|\|=/, '||='], [/\bfindLast(Index)?\b/, 'findLast'], [/\bObject\.hasOwn\b/, 'Object.hasOwn']];
  const files = fs.readdirSync(dir).filter(n => /\.(js|css)$/.test(n));
  assert.ok(files.includes('app.js') && files.includes('style.css'), files.join());
  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8'), css = /\.css$/.test(name), code = codeOf(text, css);
    for (const [re, what] of banned) { assert.ok(!re.test(code), `${name} uses ${what}`); }
    if (css) { assert.deepStrictEqual(nestedRules(code), [], `${name} nests a rule`); }
  }
  // The checks catch what they are for.
  assert.ok(/:has\(/.test(codeOf('a:has(b) { color: red; }', true)));
  assert.ok(!/\.at\(/.test(codeOf('// list.at(-1)\nvar s = "x.at(1)";', false)), 'a comment or a string is not code');
  assert.deepStrictEqual(nestedRules('a { color: red; b { color: blue; } }'), ['b']);
  assert.deepStrictEqual(nestedRules('@media (max-width: 5px) { a { color: red; } } @keyframes k { from { opacity: 0; } }'), []);
  const host = codeOf(fs.readFileSync(path.join(__dirname, '../host/select.jsx'), 'utf8'), false);
  for (const [re, what] of [[/\blet\s/, 'let'], [/\bconst\s/, 'const'], [/=>/, '=>'], [/`/, 'a template string']]) {
    assert.ok(!re.test(host), `select.jsx uses ${what}`);
  }
  assert.ok(/=>/.test(codeOf('var f = x => x;', false)) && /`/.test(codeOf('var s = `a`;', false)), 'and catches them');
});

test('clips the project doesn\'t hold: one line, the same in every sheet and in the outcome, and only when there are some', () => {
  assert.equal(C.goneLine(3), '3 clips aren\'t in this project.');
  assert.equal(C.goneLine(1), '1 clip isn\'t in this project.');
  assert.equal(C.goneLine(1200), '1,200 clips aren\'t in this project.');
  assert.equal(C.goneLine(0), '');
  const app = fs.readFileSync(path.join(__dirname, '../client/app.js'), 'utf8');
  assert.ok(!/' (isn|aren)\\'t' \+ ' in this project/.test(app), 'the sheets use it, not their own copy');
});

// ---------------------------------------------------------------- design J: the band, the bar, the icons, the band's grey

test('the band shows only news, each with one icon of the set, and keeps Stop, Details, Undo and Scan', () => {
  const row = over => { const x = facts(over); return C.bandRow(C.footState(x), x); };
  const pick = r => r && [r.icon, r.tone, r.verdict, r.sentence, r.actions.join(), r.primary, r.rank];
  const whole = { kind: 'project', sig: '', items: items(965), places: [], more: 0 };
  const before = { scan: null, rows: 0, shown: 0, store: { total: 0, tier0: 0, tier1: 0, errors: 0, bad: 0 } };
  assert.deepStrictEqual(pick(row({ ...before, target: whole })), ['bin', '', 'Whole project', '965 clips', 'scan', 'scan', 4], 'before any results: the target, and Scan is the one blue; the project is a bin');
  assert.equal(row({ ...before, target: whole }).tip, 'rushsort-test', 'the project in the tooltip');
  assert.deepStrictEqual(pick(row({ ...before, target: { kind: 'clips', sig: '12:a', items: items(12), places: ['DAY 2'] } })), ['clips', '', '12 clips selected', 'DAY 2', 'scan', 'scan', 4]);
  assert.deepStrictEqual(pick(row({ ...before, target: { kind: 'bins', sig: '1:b', items: items(40), places: ['DAY 2'] } })), ['bin', '', 'DAY 2', '40 clips', 'scan', 'scan', 4]);
  assert.deepStrictEqual(pick(row({ ...before, project: null })), ['bin', '', 'No project open', '', '', null, 4], 'nothing to scan: no button');
  assert.equal(row(), null, 'calm results: no band; the toolbar says the view, the bar counts');
  assert.equal(row({ selected: 3 }), null, 'picked clips are counted in the bar');
  const day3 = { kind: 'clips', sig: '9:c', items: items(9, 'Day 3'), places: ['Day 3'] };
  assert.deepStrictEqual(pick(row({ others: 9, target: day3 })), ['clips', '', '9 other clips selected', 'Day 3', 'scan', null, 4], 'a new Premiere selection waiting: its words, and an outlined Scan');
  assert.deepStrictEqual(pick(row({ notRead: 5 })), ['info', '', '5 not read', '', 'scan', null, 5], 'clips the cache lacked');
  const running = { state: 'Scanning', failure: null, seconds: 1, stopping: false };
  assert.deepStrictEqual(pick(row({ scan: running, store: { total: 301, tier0: 301, tier1: 28, errors: 0, bad: 0, tier2: 0, tier2Failed: 0 } })), ['spinner', '', 'Reading 28 of 301', '', 'stop', null, 1]);
  assert.deepStrictEqual(pick(row({ scan: running, store: { total: 301, tier0: 301, tier1: 301, errors: 0, bad: 0, tier2: 20, tier2Failed: 0 } })), ['spinner', '', 'Looking closer 20 of 301', '', 'stop', null, 1], 'the writes are in the bar, not here');
  assert.deepStrictEqual(pick(row({ busy: 'Making a sequence of 3 clips', write: { kind: 'write', verb: 'Making a sequence of', unit: 'clip', done: 0, total: 3, whole: true } })), ['spinner', '', 'Making a sequence of 3 clips', '', '', null, 1]);
  const made = C.writeOutcome('sequence', { items: [['1', '/a'], ['2', '/b'], ['3', '/c']] }, { made: true, clips: 3, inOrder: true, failed: [], skipped: [] });
  assert.deepStrictEqual(pick(row({ outcome: made })), ['check-circle', 'safe', 'Made a sequence of 3 clips', '', 'undo', null, 2], 'proved: the green is on the icon only');
  const short = C.writeOutcome('sequence', { items: [['1', '/a'], ['2', '/b'], ['3', '/c']] }, { made: true, clips: 2, inOrder: true, failed: [], skipped: [] });
  assert.deepStrictEqual(pick(row({ outcome: short })), ['alert', 'warn', '2 of 3 clips in the sequence', '', 'details,undo', null, 2], 'part landed: amber, Details and Undo');
  const none = C.writeOutcome('label', { items: [['1', '/a']] }, { changed: 0, failed: [{ id: '1', error: 'no' }], skipped: [] }, 'Mango');
  assert.deepStrictEqual(pick(row({ outcome: none })).slice(0, 3), ['alert', 'bad', 'Nothing labelled'], 'nothing landed: red');
  const undone = C.undoOutcome({ restored: 3, skipped: 0, failed: [], unsent: 0, error: '', binRemoved: null }, 'label');
  assert.deepStrictEqual(pick(row({ outcome: undone })), ['check-circle', '', 'Undone', '', '', null, 2], 'Undone: a grey check and no Undo');
  assert.deepStrictEqual(pick(row({ scan: { state: 'Stopped', failure: null, seconds: 1, stopping: false }, store: { total: 301, tier0: 301, tier1: 28, errors: 0, bad: 0 } })), ['info', '', 'Stopped', '28 of 301 clips read', 'scan', null, 2], 'with results, Scan is outlined; the sentence alone, no full stop');
  assert.deepStrictEqual(pick(row({ scan: { state: 'Failed', failure: { verdict: 'The scan stopped early', sentence: 'The engine quit before the last clip.' }, seconds: 1, stopping: false } })), ['alert', 'bad', 'The scan stopped early', 'The engine quit before the last clip.', 'scan', null, 2]);
  assert.deepStrictEqual(pick(row({ foreign: 'rushsort-test', title: 'testt2', target: whole })), ['bin', '', 'From rushsort-test', '', 'scan', 'scan', 4], 'another project\'s results: Scan is the one thing to do');
});

test('the band shows one row at a time: a note outranks the target, a new selection and clips not read, and keeps their Scan; a scan under way and a result keep the row', () => {
  const row = over => { const x = facts(over); return C.bandRow(C.footState(x), x); };
  const pick = r => r && [r.icon, r.tone, r.verdict, r.actions.join(), r.primary, r.rank];
  const whole = { kind: 'project', sig: '', items: items(965), places: [], more: 0 };
  const before = row({ scan: null, rows: 0, shown: 0, store: { total: 0, tier0: 0, tier1: 0, errors: 0, bad: 0 }, target: whole });
  assert.deepStrictEqual(pick(C.bandShow(before, { text: 'No video clips here.', kind: 'warn' })), ['alert', 'warn', 'No video clips here.', 'scan', 'scan', 3], 'the refusal, with the Scan it hid');
  assert.deepStrictEqual(pick(C.bandShow(before, null)), pick(before), 'no note: the row as it is');
  assert.deepStrictEqual(pick(C.bandShow(null, { text: 'Nothing to undo in this project.', kind: '' })), ['info', '', 'Nothing to undo in this project.', '', null, 3], 'calm results: the note alone');
  const day3 = { kind: 'clips', sig: '9:c', items: items(9, 'Day 3'), places: ['Day 3'] };
  assert.deepStrictEqual(pick(C.bandShow(row({ others: 9, target: day3 }), { text: 'Playback is running.', kind: 'warn' })), ['alert', 'warn', 'Playback is running.', 'scan', null, 3]);
  const reading = row({ scan: { state: 'Scanning', failure: null, seconds: 1, stopping: false }, store: { total: 301, tier0: 301, tier1: 28, errors: 0, bad: 0, tier2: 0, tier2Failed: 0 } });
  assert.equal(C.bandShow(reading, { text: 'Premiere answered late. Undo covers it.', kind: 'warn' }), reading, 'a scan under way keeps the row; the note waits');
  const made = row({ outcome: C.writeOutcome('sequence', { items: [['1', '/a']] }, { made: true, clips: 1, inOrder: true, failed: [], skipped: [] }) });
  assert.equal(C.bandShow(made, { text: 'Premiere didn\'t make the sequence.', kind: 'bad' }), made, 'a result keeps the row over a failure note of the same rank');
  assert.deepStrictEqual(pick(C.bandShow(row({ notRead: 5 }), { text: 'Premiere didn\'t make the sequence.', kind: 'bad' })), ['alert', 'bad', 'Premiere didn\'t make the sequence.', 'scan', null, 2], 'a failed write outranks clips not read');
});

test('the bar: there once there are results, the count, both writes in their places, off with the reason', () => {
  const bar = over => { const x = facts(over); return C.barState(C.footState(x), x); };
  assert.deepStrictEqual(bar({ rows: 0, shown: 0, scan: null }), { shown: false }, 'hidden before any scan: the band has Scan');
  const calm = bar();
  assert.deepStrictEqual([calm.count, calm.countTip, calm.sequence, calm.bins, calm.primary, calm.empty], ['301 clips', '301 clips', '', '', 'bins', false]);
  // What wasn't read whole, after the scan: counted after the clips, said in full in the tooltip, with what the scan left out.
  const rows = [{ path: '/v/a.braw', error: { message: 'x' }, ext: 'braw' }];
  const told = bar({ store: { total: 301, tier0: 301, tier1: 299, errors: 1, bad: 0, notRead: 0, rows, noPicture: { clips: 1, noDecoder: 1, noFfmpeg: 1 }, tier2Failed: 0 }, skipped: 211 });
  assert.equal(told.count, '301 clips \u00b7 2 not read');
  assert.match(told.countTip, /^1 clip could not be read: .+\n1 clip has no picture scores: this Mac has no decoder for it, and ffmpeg isn't installed\.\n211 items skipped: not video\.\n301 clips \u00b7 2 not read$/, 'why first, then the count');
  const reading = bar({ scan: { state: 'Scanning', failure: null, seconds: 1, stopping: false }, store: { total: 301, tier0: 301, tier1: 28, errors: 1, bad: 0, rows, tier2: 0, tier2Failed: 0 } });
  assert.equal(reading.count, '301 clips', 'said once the scan has ended');
  assert.equal(bar({ shown: 36 }).count, '36 of 301 clips', 'a filter');
  assert.equal(bar({ selected: 3 }).count, '3 of 301 clips selected');
  assert.equal(bar({ view: V({ show: 'similar' }), shown: 40, groupCount: 12 }).count, '40 of 301 clips · 12 groups');
  const listed = bar({ view: V() });
  assert.deepStrictEqual([listed.bins, listed.sequence, listed.primary], ['Pick a Show, a colour or a sort', '', 'bins'], 'no bins from this view: Sort into Bins is off, and Make Sequence is never the blue');
  assert.deepStrictEqual([bar({ busy: 'Labelling 3 clips' }).sequence, bar({ busy: 'Labelling 3 clips' }).bins], ['A write is running', 'A write is running']);
  const running = { state: 'Scanning', failure: null, seconds: 1, stopping: false };
  assert.equal(bar({ scan: running, store: { total: 301, tier0: 301, tier1: 28, errors: 0, bad: 0, tier2: 0, tier2Failed: 0 } }).sequence, 'Waits for the scan', 'while it reads');
  const closer = { scan: running, store: { total: 301, tier0: 301, tier1: 301, errors: 0, bad: 0, tier2: 20, tier2Failed: 0 } };
  assert.equal(bar({ ...closer, needsTier2: true }).bins, 'Waits for looking closer', 'a view that needs it waits');
  assert.equal(bar({ ...closer, needsTier2: true, outcome: C.undoOutcome({ restored: 1, failed: [] }, 'label') }).sequence, 'Waits for looking closer', 'and still waits while a result shows');
  assert.equal(bar({ ...closer, needsTier2: false }).sequence, '', 'one that doesn\'t works meanwhile');
  const away = bar({ foreign: 'rushsort-test' });
  assert.deepStrictEqual([away.sequence, away.bins, away.primary], ['From rushsort-test', 'From rushsort-test', null], 'another project\'s: off, and no blue beside the band\'s Scan');
  assert.ok(bar({ shown: 0 }).empty, 'nothing on screen: off');
  const now = new Date(2026, 10, 4, 9, 0).getTime();
  assert.equal(bar({ lastAt: new Date(2026, 10, 3, 18, 5).toISOString(), now }).countTip, '301 clips\nScanned yesterday at 18:05', 'last results: when, in the count\'s tooltip');
});

test('one set of icons: 16 × 16, a 1.5 px stroke, round caps and joins, the colour of the words, straight strokes on quarter pixels', () => {
  assert.ok(!C.ICONS.project, 'the whole project is the bin glyph');
  for (const name of ['search', 'chevron', 'flip', 'list', 'grid', 'more', 'bin', 'clips', 'check-circle', 'alert', 'info', 'spinner', 'check', 'ring', 'close', 'chevron-right', 'chevron-up']) {
    assert.ok(C.ICONS[name], name);
  }
  for (const name of Object.keys(C.ICONS)) {
    const svg = C.iconSvg(name), body = C.ICONS[name];
    assert.match(svg, /viewBox="0 0 16 16" width="16" height="16" fill="none" stroke-width="1\.5" stroke-linecap="round" stroke-linejoin="round" stroke="currentColor"/, name);
    assert.ok(!/stroke-width|fill="(?!none)|style=/.test(body), `${name} keeps the set's stroke and no fill`);
    const nums = body.replace(/stroke-opacity="[^"]*"/, '').match(/-?\d*\.?\d+/g).map(Number);
    for (const n of nums) {
      assert.ok(Math.abs(n * 4 - Math.round(n * 4)) < 1e-9, `${name}: ${n} is on the quarter-pixel grid`);
      assert.ok(n >= -16 && n <= 16, `${name}: ${n} inside the box`);
    }
    const url = C.iconUrl(name);
    assert.match(decodeURIComponent(url.slice(url.indexOf(',') + 1, -2)), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 16 16"[^>]* stroke="#000">/, `${name} as a mask`);
  }
  // Nothing else draws a glyph: no SVG in the page or the stylesheet, and none written by hand in app.js.
  const dir = path.join(__dirname, '../client');
  assert.ok(!/<svg|<path/.test(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')), 'index.html: icons come from the set');
  assert.ok(!/<svg|<path|image\/svg/.test(fs.readFileSync(path.join(dir, 'style.css'), 'utf8')), 'style.css: masks come from the set');
  assert.ok(!/<svg|<path /.test(fs.readFileSync(path.join(dir, 'app.js'), 'utf8')), 'app.js: only core.iconSvg');
  assert.ok(!/(border-(left|bottom|top)|border-right): \d[^;]*solid var\(--ink[^;]*;[^}]*rotate/.test(fs.readFileSync(path.join(dir, 'style.css'), 'utf8')), 'no tick drawn with borders');
});

test('the band\'s grey is a shade off Premiere\'s, lighter on dark and darker on light, and its words and icons read on it at every brightness', () => {
  for (let v = 20; v <= 245; v += 5) {
    const t = C.skinTokens({ red: v, green: v, blue: v }), ink = t.theme === 'dark' ? '#EDEDEE' : '#1D1D1F';
    const g = h => parseInt(h.slice(1, 3), 16);
    assert.ok(t.theme === 'dark' ? g(t.band) > g(t.surface) : g(t.band) < g(t.surface), `${v}: band ${t.band} beside ${t.surface}`);
    assert.ok(Math.abs(g(t.band) - g(t.surface)) <= 12, `${v}: a shade, not a slab`);
    // ink2, ink3 and the green fitted on the band as well, at 4.5:1; the focus ring, a blue, at 3:1 there and on the ground.
    for (const [fg, need, what] of [[ink, 4.5, 'ink'], [t.ink2, 4.5, 'ink2'], [t.ink3, 4.5, 'ink3'], [t['safe-ink'], 4.5, 'safe-ink'], [t.warn, 3, 'warn'], [t.bad, 3, 'bad'], [t['focus-ring'], 3, 'focus ring']]) {
      assert.ok(contrast(fg, t.band) >= need, `${v}: ${what} ${fg} on the band ${t.band}: ${contrast(fg, t.band).toFixed(2)}`);
    }
    assert.ok(contrast(t.warn, t.surface) >= 3, `${v}: warn on the ground`);
    for (const bg of [t.surface, t.foot]) { assert.ok(contrast(t['focus-ring'], bg) >= 3, `${v}: focus ring ${t['focus-ring']} on ${bg}`); }
    const [fr, , fb] = [1, 3, 5].map(i => parseInt(t['focus-ring'].slice(i, i + 2), 16));
    assert.ok(fb - fr >= 40, `${v}: ${t['focus-ring']} still reads as blue`);
    const [r, gr, b] = [1, 3, 5].map(i => parseInt(t.warn.slice(i, i + 2), 16));
    assert.ok(r > gr && gr > b, `${v}: ${t.warn} still reads as amber`);
    assert.ok(contrast(ink, t.sel) >= 4.5, `${v}: the view that is on reads on its plate`);
  }
  assert.equal(C.skinTokens({ red: 35, green: 35, blue: 35 }).band, '#2E2E2E');
  assert.equal(C.skinTokens({ red: 230, green: 230, blue: 230 }).band, '#DADADA', 'darker on a light grey, a step further than on dark');
  assert.equal(C.skinTokens({ red: 245, green: 245, blue: 245 }).band, '#E9E9E9', 'and seen on the lightest');
  assert.equal(C.skinTokens({ red: 27, green: 27, blue: 27 }).band, '#262626', 'the mock-up\'s #262626 on #1B1B1B');
  assert.equal(C.skinTokens({ red: 35, green: 35, blue: 35 }).warn, '#F5A524');
});

// ---------------------------------------------------------------- the watch poll

test('the watch poll: 1, 2, 4, 6, 10, 18, 33, 48, 63, 78, 93 s after the pointer leaves, a big selection no more than every 10 s, at most 300 an hour', () => {
  assert.deepStrictEqual(C.pollTimes(), [1, 2, 4, 6, 10, 18, 33, 48, 63, 78, 93], 'gaps of 1, 1, 2, 2, 4, 8, then 15 s at most');
  const run = count => { const out = []; let at = 0; for (let t = C.nextPoll(at, count); t !== null; t = C.nextPoll(at, count)) { out.push(t); at = t; } return out; };
  assert.deepStrictEqual(run(0), [1, 2, 4, 6, 10, 18, 33, 48, 63, 78, 93], 'nothing selected');
  assert.deepStrictEqual(run(1), [1, 2, 4, 6, 10, 18, 33, 48, 63, 78, 93], 'a bin: 11 polls, 11 items');
  assert.deepStrictEqual(run(3), run(1), 'three items are still small');
  assert.deepStrictEqual(run(12), [10, 33, 48, 63, 78, 93], '12 clips: 6 polls, at least 10 s apart, 72 items');
  assert.equal(C.nextPoll(93, 1), null, 'then none until the pointer comes back and leaves again');
  const stamps = [], hour = 3600000;
  let n = 0;
  for (let t = 0; t < hour; t += 1000) { if (C.pollRoom(stamps, t)) { stamps.push(t); n++; } }
  assert.equal(n, C.POLL_HOURLY, 'a poll every second for an hour: 300 go');
  assert.ok(C.pollRoom(stamps, hour + 1), 'an hour after the first, there is room again');
  assert.equal(C.sigCount('12:5b1e09c2'), 12);
  assert.equal(C.sigCount(''), 0, 'nothing selected hands out nothing');
  assert.equal(C.sigCount('several:2'), 0, 'two Project panels: no count to read');
  assert.equal(C.nextPoll(0, C.POLL_MAX), 10, 'fifty items: still polled, 10 s apart');
  assert.equal(C.nextPoll(0, C.POLL_MAX + 1), null, 'more than fifty: no poll at all; the pointer coming back asks');
  const log = [];
  let k = 0;
  for (let t = 0; t < hour; t += 1000) { if (C.pollItemRoom(log, t)) { log.push([t, 50]); k++; } }
  assert.equal(k * 50, C.POLL_ITEMS_HOURLY, 'fifty items a poll: 40 polls, then the hour holds 2,000 items');
  assert.ok(C.pollItemRoom(log, hour + 1), 'an hour on, there is room again');
});
