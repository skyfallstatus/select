// node --test test/unit-b.test.js : 0.4 column order, search by folder and number, search suggestions, the Date
// tooltip and the hover-scrub strip process.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../client/core.js');
const N = require('../client/native.js');

const FAKE = path.join(__dirname, 'fake-engine.js');
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/clips.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const V = over => ({ show: null, sort: [], families: [], ...over });
const keys = list => list.map(c => c.key);
const movable = C.COLUMNS.filter(c => !c.fixed).map(c => c.key);

// Rows as a scan leaves them: items with their bins, then each clip's lines.
function store(clips) {
  const s = C.createStore();
  C.addItems(s, clips.map((c, i) => ({ id: String(i), path: c.path, bin: c.bin })));
  for (const c of clips) {
    const { path: p, bin, ...rest } = c;
    C.ingest(s, { type: 'clip', tier: 0, path: p, ...rest });
  }
  return s;
}
const finds = (s, q) => C.computeView(s.rows, V(), null, { tokens: C.searchTokens(q) }).order.map(i => s.rows[i].name);

// ---------------------------------------------------------------- column order

test('column order: the picture, the name and the group stay first; the rest follow the saved order', () => {
  assert.deepStrictEqual(keys(C.orderColumns(C.COLUMNS, [])), keys(C.COLUMNS), 'nothing saved: the order as shipped');
  assert.deepStrictEqual(keys(C.orderColumns(C.COLUMNS, null)), keys(C.COLUMNS));
  const saved = ['camera', 'durationS', ...movable.filter(k => k !== 'camera' && k !== 'durationS')];
  const got = keys(C.orderColumns(C.COLUMNS, saved));
  assert.deepStrictEqual(got.slice(0, 3), ['thumb', 'name', 'dupGroup']);
  assert.deepStrictEqual(got.slice(3, 5), ['camera', 'durationS']);
  assert.equal(got.length, C.COLUMNS.length, 'every column once');
  // A fixed column in the saved order changes nothing, and neither does a key no column has any more.
  assert.deepStrictEqual(keys(C.orderColumns(C.COLUMNS, ['name', 'gone', 'camera', 'camera', 7])).slice(0, 4), ['thumb', 'name', 'dupGroup', 'camera']);
  // A column the saved order doesn't know, from a newer Select, goes at the end.
  const added = C.COLUMNS.concat([{ key: 'newOne', label: 'New', width: 40, kind: 'text' }]);
  assert.deepStrictEqual(keys(C.orderColumns(added, saved)).slice(-1), ['newOne']);
  assert.deepStrictEqual(keys(C.orderColumns(added, ['newOne'])).slice(3, 4), ['newOne'], 'and where it was dragged once it is known');
});

test('column order: a move puts a column just after another, or first; a column switched off keeps its place', () => {
  const k = ['durationS', 'sharpness', 'luma', 'camera', 'lens'];
  assert.deepStrictEqual(C.moveColumn(k, 'camera', 'durationS'), ['durationS', 'camera', 'sharpness', 'luma', 'lens']);
  assert.deepStrictEqual(C.moveColumn(k, 'camera', null), ['camera', 'durationS', 'sharpness', 'luma', 'lens'], 'first, right after the name');
  assert.deepStrictEqual(C.moveColumn(k, 'durationS', 'lens'), ['sharpness', 'luma', 'camera', 'lens', 'durationS'], 'last');
  assert.deepStrictEqual(C.moveColumn(k, 'camera', 'camera'), k, 'onto itself: nothing moves');
  assert.deepStrictEqual(C.moveColumn(k, 'camera', 'luma'), k, 'to where it already is');
  assert.deepStrictEqual(C.moveColumn(k, 'camera', 'gone'), k, 'after a column that is not there: nothing moves');
  // luma switched off: camera dragged in front of sharpness on screen lands after durationS, and luma stays between.
  assert.deepStrictEqual(C.moveColumn(k, 'camera', 'durationS'), ['durationS', 'camera', 'sharpness', 'luma', 'lens']);
  assert.deepStrictEqual(C.moveColumn(k, 'sharpness', 'camera'), ['durationS', 'luma', 'camera', 'sharpness', 'lens'], 'a hidden column between keeps its order with the rest');
  assert.deepStrictEqual(k, ['durationS', 'sharpness', 'luma', 'camera', 'lens'], 'the list given is left as it was');
});

// ---------------------------------------------------------------- the Camera and Date tips

test('Camera sorts from its menu with the contract\'s words, and the Date cell says when a date came from the file name', () => {
  const at = C.SORTS.map(s => s.key);
  assert.equal(at.indexOf('camera'), at.indexOf('colorName') + 1, 'Camera after Colour');
  assert.equal(at.indexOf('name'), at.indexOf('camera') + 1, 'and before Name');
  assert.equal(C.COLUMN.camera.tip, 'Maker and model.');
  assert.deepStrictEqual(C.SORT.camera.ways, ['A to Z', 'Z to A']);
  assert.equal(C.sortWords({ key: 'camera', dir: -1 }), 'Camera Z to A');
  const was = process.env.TZ;
  process.env.TZ = 'Europe/Paris';
  try {
    assert.equal(C.dateNote({ dateSource: 'fileName', containerDate: null }), 'From the file name');
    assert.equal(C.dateNote({ dateSource: 'fileName', containerDate: '2026-10-30T17:00:00Z' }), 'From the file name; the file says 2026-10-30 18:00', 'the time in the file, in this Mac\'s zone');
    assert.equal(C.dateNote({ dateSource: 'fileName', dateOnly: true, containerDate: '2026-10-30T17:00:00Z' }), 'Day only, from the file name; the file says 2026-10-30 18:00');
  } finally { if (was === undefined) { delete process.env.TZ; } else { process.env.TZ = was; } }
  for (const r of [{ dateSource: 'camera' }, { dateSource: 'container' }, { dateSource: null }, {}]) { assert.equal(C.dateNote(r), '', JSON.stringify(r)); }
});

// ---------------------------------------------------------------- search: folders and numbers

test('search: a number is a whole number in what the clip holds, so day 2 is not day 24, nor a 24-70mm lens', () => {
  const s = store([
    { path: '/Volumes/Field SSD/Shoot/DAY 2/FX3/A083/C0412.MP4', lens: 'FE 35mm F1.4 GM' },
    { path: '/Volumes/Field SSD/Shoot/DAY 24/FX3/A090/C0245.MP4' },
    { path: '/Volumes/Field SSD/Shoot/DAY 8/FX3/A091/C0300.MP4', lens: 'FE 24-70mm F2.8 GM II' },
    { path: '/Volumes/Field SSD/Shoot/DAY 4/R5/MVI_0001.MP4', camera: 'Canon EOS R5' }
  ]);
  assert.deepStrictEqual(finds(s, 'day 2'), ['C0412.MP4']);
  assert.deepStrictEqual(finds(s, 'day 24'), ['C0245.MP4'], 'day and 24 together, not day 8 with a 24-70mm lens');
  assert.deepStrictEqual(finds(s, 'day 8'), ['C0300.MP4'], 'not day 2 with an F2.8 lens');
  assert.deepStrictEqual(finds(s, 'day 4'), ['MVI_0001.MP4'], 'nor day 2 with an F1.4 lens, nor the 4 of .MP4');
  assert.deepStrictEqual(finds(s, '2.8'), ['C0300.MP4'], 'a decimal is found inside F2.8');
  assert.deepStrictEqual(finds(s, 'f2.8'), ['C0300.MP4']);
  assert.deepStrictEqual(finds(s, 'f1'), ['C0412.MP4'], 'a word still starts a word');
  assert.deepStrictEqual(finds(s, 'r5'), ['MVI_0001.MP4']);
  assert.deepStrictEqual(finds(s, 'a08'), ['C0412.MP4'], 'a card folder, from the start of its name');
});

test('search: a number holds on to the word before it: day 2 is found where day and 2 stand together, never through a lone 2', () => {
  const s = store([
    { path: '/Volumes/Field SSD/Shoot/DAY 1/CARD 2/C0001.MP4' },
    { path: '/Volumes/Field SSD/Shoot/DAY 3/A/C0002.MP4', bin: 'Cam 2' },
    { path: '/Volumes/Field SSD/Shoot/DAY 1/B/C0003.MP4', text: ['GATE 2'], labels: [], sounds: [] },
    { path: '/Volumes/Field SSD/Shoot/DAY 2/A/C0004.MP4' },
    { path: '/Volumes/Field SSD/Shoot/DAY2/A/C0005.MP4' },
    { path: '/Volumes/Field SSD/Shoot/DAY 20/A/C0006.MP4' },
    { path: '/Volumes/Field SSD/Shoot/X/A/C0007.MP4', text: ['Day', '2 pm'], labels: [], sounds: [] }
  ]);
  assert.deepStrictEqual(finds(s, 'day 2'), ['C0004.MP4', 'C0005.MP4'], 'DAY 2 and DAY2; not DAY 1/CARD 2, a bin Cam 2, a slate GATE 2, DAY 20, or Day and 2 pm apart');
  assert.deepStrictEqual(finds(s, 'card 2'), ['C0001.MP4']);
  assert.deepStrictEqual(finds(s, 'cam 2'), ['C0002.MP4']);
  assert.deepStrictEqual(finds(s, 'gate 2'), ['C0003.MP4']);
  assert.deepStrictEqual(finds(s, 'day 2 a'), ['C0004.MP4', 'C0005.MP4'], 'a word after the run is a run of its own');
  assert.deepStrictEqual(finds(s, '2'), ['C0001.MP4', 'C0002.MP4', 'C0003.MP4', 'C0004.MP4', 'C0007.MP4'], 'a lone 2, typed alone, still finds every whole 2');
  assert.equal(C.matchedWord(s.rows[4], C.searchTokens('day 2')), 'DAY2');
  assert.equal(C.matchedWord(s.rows[3], C.searchTokens('day 2')), 'DAY 2');
  // The name holds a run when it holds each of its words.
  const n = store([{ path: '/v/DJI_20250906021200_0013_D.MP4' }, { path: '/v/C0100.MP4' }]);
  assert.deepStrictEqual(finds(n, 'dji 0013'), ['DJI_20250906021200_0013_D.MP4']);
});

test('search: every part of a dotted or comma number is found, and the whole of it', () => {
  const s = store([
    { path: '/Volumes/Field SSD/Shoot/04.11.2026/A/C0001.MP4' },
    { path: '/Volumes/Field SSD/Shoot/Pier/A/C0002.MP4', text: ['1,500 m'], labels: [], sounds: [] },
    { path: '/Volumes/Field SSD/Shoot/Pier/A/C0003.MP4', text: ['11 boats'], labels: [], sounds: [] }
  ]);
  for (const q of ['04', '2026', '04.11.2026', '04.11', '11.2026', '04 11 2026']) { assert.deepStrictEqual(finds(s, q), ['C0001.MP4'], q); }
  assert.deepStrictEqual(finds(s, '11'), ['C0001.MP4', 'C0003.MP4'], 'the middle part too');
  for (const q of ['500', '1,500', '1.500']) { assert.deepStrictEqual(finds(s, q), ['C0002.MP4'], q); }
  assert.deepStrictEqual(finds(s, '1'), ['C0002.MP4'], 'the first part as a whole number');
  assert.deepStrictEqual(finds(s, '50'), [], 'still no part of a number');
  assert.equal(C.matchedWord(s.rows[0], C.searchTokens('2026')), '04.11.2026', 'the folder, as it is written');
});

test('search: in the file name a number starts a run of digits, and the extension is left out', () => {
  const s = store([
    { path: '/v/C0412.MP4' }, { path: '/v/C2412.MP4' },
    { path: '/v/DJI_20250906021200_0013_D.MP4' }, { path: '/v/A001C014_250906_R1AB.mov' }
  ]);
  assert.deepStrictEqual(finds(s, '0412'), ['C0412.MP4']);
  assert.deepStrictEqual(finds(s, '412'), [], 'inside a run of digits: no');
  assert.deepStrictEqual(finds(s, '2'), ['C2412.MP4', 'DJI_20250906021200_0013_D.MP4', 'A001C014_250906_R1AB.mov'], 'the start of 2412, 20250906 and 250906');
  assert.deepStrictEqual(finds(s, '0013'), ['DJI_20250906021200_0013_D.MP4'], 'a run of its own after an underscore');
  assert.deepStrictEqual(finds(s, '4'), [], 'not the 4 of MP4');
  assert.deepStrictEqual(finds(s, 'c0412'), ['C0412.MP4'], 'words anywhere in the name, as before');
  assert.deepStrictEqual(finds(s, 'mp4'), ['C0412.MP4', 'C2412.MP4', 'DJI_20250906021200_0013_D.MP4'], 'the extension as a word');
  assert.deepStrictEqual(finds(s, '1c014'), ['A001C014_250906_R1AB.mov']);
});

test('search: a clip found by a folder or a bin says that folder\'s name, bare, as it is written', () => {
  const s = store([
    { path: '/Volumes/Field SSD/Lantern/Footage/DAY 2/FX3/A083/C0412.MP4', bin: 'Footage/Day 2' },
    { path: '/Volumes/Field SSD/Lantern/Footage/DAY 3/FX3/A084/C0500.MP4', bin: 'Interviews' },
    { path: '/Volumes/Field SSD/Lantern/Footage/DAY 3/R5/C0501.MP4' }
  ]);
  assert.deepStrictEqual(C.folderNames(s.rows[0]), ['Day 2', 'Footage', 'A083', 'FX3'], 'bins first, then the card, camera and day folders, each name once');
  assert.deepStrictEqual(C.folderNames(s.rows[2]), ['R5', 'DAY 3', 'Footage']);
  assert.deepStrictEqual(finds(s, 'day 3'), ['C0500.MP4', 'C0501.MP4']);
  assert.deepStrictEqual(finds(s, 'interviews'), ['C0500.MP4'], 'a bin in the project');
  assert.deepStrictEqual(finds(s, 'lantern'), [], 'four folders up is not a card, a camera or a day');
  const why = (r, q) => C.matchedWord(r, C.searchTokens(q));
  assert.equal(why(s.rows[0], 'day 2'), 'Day 2', 'the bin\'s name, which comes first');
  assert.equal(why(s.rows[1], 'day 3'), 'DAY 3', 'the folder\'s own name, no "in"');
  assert.equal(why(s.rows[0], 'a083'), 'A083');
  assert.equal(why(s.rows[0], 'c0412 fx3'), 'FX3', 'the name is why for its own word, the folder for the next');
  assert.equal(C.tileFact(s.rows[2], V(), C.searchTokens('r5')), 'R5', 'on a tile too');
  assert.equal(why(s.rows[0], 'c0412'), '', 'nothing when the name is why');
});

// ---------------------------------------------------------------- search suggestions

function suggestStore() {
  return store([
    { path: '/v/DAY 2/FX3/C1.MP4', bin: 'Footage/DAY 2', camera: 'SONY ILME-FX3', labels: [{ name: 'water' }, { name: 'Wind' }], text: ['Rose walk'], sounds: [{ name: 'wind' }, { name: 'speech' }] },
    { path: '/v/DAY 2/FX3/C2.MP4', bin: 'Footage/DAY 2', camera: 'SONY ILME-FX3', labels: [{ name: 'water' }], text: [], sounds: [{ name: 'wind' }] },
    { path: '/v/DAY 24/R5/C3.MP4', bin: 'Footage/Day 24', camera: 'Canon EOS R5', labels: [{ name: 'waves' }, { name: 'water' }], text: ['Wharf'], sounds: [] },
    { path: '/v/DAY 3/R5/C4.MP4', camera: 'Canon EOS R5', labels: [{ name: 'workshop' }], text: [], sounds: [{ name: 'wind' }] }
  ]);
}

test('suggestions: words that start as the last word typed, from labels, words on screen, sounds, camera, folders and bins, most clips first', () => {
  const s = suggestStore();
  const got = C.suggestions(s.rows, 'w', 6);
  assert.deepStrictEqual(got.map(x => [x.word, x.count]), [['Wind', 3], ['water', 3], ['waves', 1], ['Wharf', 1], ['workshop', 1], ['Rose walk', 1]],
    'a word one clip holds twice counts that clip once, written as first met; equal counts: the shorter word first; a word inside a phrase counts');
  assert.ok(got.every(x => Object.keys(x).join() === 'word,count,query'), 'each row: the word, its count, and the search it makes');
  assert.equal(C.suggestions(s.rows, 'w', 2).length, 2, 'at most n');
  assert.equal(C.suggestions(s.rows, 'w').length, 6, 'six by default');
  assert.deepStrictEqual(C.suggestions(s.rows, 'so', 6).map(x => x.word), ['SONY ILME-FX3'], 'the camera');
  assert.deepStrictEqual(C.suggestions(s.rows, 'fx', 6).map(x => [x.word, x.count]), [['FX3', 2], ['SONY ILME-FX3', 2]], 'a folder on disk');
  assert.deepStrictEqual(C.suggestions(s.rows, 'foot', 6).map(x => [x.word, x.count]), [['Footage', 3]], 'a bin');
  assert.deepStrictEqual(C.suggestions(s.rows, 'sp', 6).map(x => x.word), ['speech'], 'a sound');
  assert.deepStrictEqual(C.suggestions(s.rows, 'd', 6).map(x => [x.word, x.count]), [['DAY 2', 2], ['DAY 3', 1], ['Day 24', 1]], 'DAY 24 and Day 24 are one word, written as first met: the bin, which comes before the folder');
});

test('suggestions: what a row puts in the search box, and when there is nothing to say', () => {
  const s = suggestStore();
  const q = (typed, n) => C.suggestions(s.rows, typed, n).map(x => x.query);
  assert.deepStrictEqual(q('speech wa'), ['speech water', 'speech Rose walk'], 'the last word is replaced, what comes before stays, and only what that finds');
  assert.deepStrictEqual(q('Speech,  WA', 1), ['Speech,  water']);
  assert.deepStrictEqual(q('kitchen wa'), [], 'nothing a pick wouldn\'t find');
  assert.deepStrictEqual(q('day 2'), ['DAY 2', 'Day 24'], 'words that start with the whole search replace it, and only they show');
  assert.deepStrictEqual(q('rose w'), ['Rose walk']);
  assert.deepStrictEqual(q('w '), [], 'nothing typed yet for the next word');
  assert.deepStrictEqual(q(''), []);
  assert.deepStrictEqual(q('zzz'), [], 'no match');
  assert.deepStrictEqual(q('workshop'), [], 'the word typed is already the only one');
  assert.deepStrictEqual(q('day 24'), [], 'and the same for a whole search');
  assert.deepStrictEqual(q('wate'), ['water']);
  assert.deepStrictEqual(C.suggestions([], 'w'), []);
});

test('suggestions: a row\'s count is what picking it shows, inside the Show and the colour on screen', () => {
  const s = store([
    { path: '/v/DAY 2/A/C1.MP4', text: ['DAY 2 CALL SHEET'], labels: [{ name: 'water' }], sounds: [{ name: 'speech', conf: .9 }], faces: 1, shotSize: 'medium', durationS: 40, colorName: 'blue' },
    { path: '/v/DAY 2/A/C2.MP4', labels: [{ name: 'waterfall' }], sounds: [], colorName: 'blue' },
    { path: '/v/DAY 1/A/C3.MP4', text: ['2'], labels: [{ name: 'water' }], sounds: [], colorName: 'green' },
    { path: '/v/DAY 3/A/C4.MP4', labels: [{ name: 'water' }], sounds: [{ name: 'speech', conf: .9 }], faces: 1, shotSize: 'medium', durationS: 40, colorName: 'blue' }
  ]);
  const shows = (view, query) => C.computeView(s.rows, view, null, { tokens: C.searchTokens(query) }).order.length;
  for (const view of [V(), V({ show: 'interviews' }), V({ families: ['blue'] }), V({ show: 'interviews', families: ['blue'] })]) {
    for (const typed of ['w', 'wa', 'd', 'day 2', 'day', 'c', 'water w']) {
      for (const sg of C.suggestions(s.rows, typed, 6, view)) {
        assert.equal(sg.count, shows(view, sg.query), `${JSON.stringify(view)} ${typed} → ${sg.query}`);
        assert.ok(sg.count > 0);
      }
    }
  }
  assert.deepStrictEqual(C.suggestions(s.rows, 'wat', 6).map(x => [x.word, x.count]), [['water', 4], ['waterfall', 1]], 'water finds waterfall too, as the search does');
  assert.deepStrictEqual(C.suggestions(s.rows, 'wat', 6, V({ show: 'interviews' })).map(x => [x.word, x.count]), [['water', 2]], 'inside Interviews; waterfall finds none there, so it goes');
  assert.deepStrictEqual(C.suggestions(s.rows, 'd', 6, V({ families: ['blue'] })).map(x => [x.word, x.count]), [['DAY 2', 2], ['DAY 3', 1], ['DAY 2 CALL SHEET', 1]], 'inside blue; DAY 1 finds none; equal counts, the shorter first');
  // Similar shots: a group shows only while two of its clips are left.
  const g = store([{ path: '/v/a/C1.MP4', labels: [{ name: 'boat' }] }, { path: '/v/a/C2.MP4', labels: [{ name: 'boat' }] }, { path: '/v/a/C3.MP4', labels: [{ name: 'bowl' }] }, { path: '/v/a/C4.MP4', labels: [{ name: 'bowl' }] }]);
  C.ingest(g, { type: 'groups', groups: [{ id: 1, paths: ['/v/a/C1.MP4', '/v/a/C3.MP4'] }, { id: 2, paths: ['/v/a/C2.MP4', '/v/a/C4.MP4'] }] });
  assert.deepStrictEqual(C.suggestions(g.rows, 'bo', 6, V({ show: 'similar' })), [], 'boat leaves one clip in each group, so Similar shots shows none');
  assert.equal(C.viewCount(g.rows, V({ show: 'similar' }), []), 4);
});

test('suggestions: the words are counted once while nothing changes, and again when a clip does', () => {
  const s = suggestStore();
  const t0 = process.hrtime.bigint();
  C.suggestions(s.rows, '');
  assert.deepStrictEqual(C.suggestions(s.rows, 'wh').map(x => x.word), ['Wharf']);
  C.ingest(s, { type: 'clip', tier: 2, path: s.rows[3].path, labels: [{ name: 'wheel' }], text: [], sounds: [] });
  assert.deepStrictEqual(C.suggestions(s.rows, 'wh').map(x => x.word), ['Wharf', 'wheel'], 'a new line from the engine is seen');
  // 1,000 clips of the fixture: made once in a few ms, then each keystroke well inside a frame.
  const big = C.createStore();
  const recs = Array.from({ length: 1000 }, (_, i) => fixture[i % fixture.length]).map((r, i) => ({ ...r, path: r.path + '.' + i + '.mp4' }));
  C.addItems(big, recs.map(r => ({ path: r.path, bin: 'Footage/DAY ' + (1 + r.index % 9) })));
  for (const r of recs) { if (r.tier0) { C.ingest(big, { type: 'clip', tier: 0, path: r.path, ...r.tier0 }); C.ingest(big, { type: 'clip', tier: 2, path: r.path, ...r.tier2 }); } }
  let at = Date.now();
  C.suggestions(big.rows, '');
  const made = Date.now() - at;
  at = Date.now();
  for (const typed of ['b', 'br', 'bre', 'brea', 'bread', 'bread w', 'bread wa', 'day', 'day 2']) { C.suggestions(big.rows, typed); }
  const typing = (Date.now() - at) / 9;
  assert.ok(made < 200 && typing < 8, `made in ${made} ms, ${typing.toFixed(1)} ms a keystroke`);
  assert.ok(process.hrtime.bigint() > t0);
});

// ---------------------------------------------------------------- the strip process

function strip(binary, clip, env, killAfter) {
  Object.assign(process.env, { FAKE_STRIP: '' }, env);
  return new Promise(resolve => {
    const handle = N.runStrip(binary, clip, (err, msg) => resolve({ err, msg, handle }), killAfter);
  });
}

test('runStrip: one strip line, or the reason there is none', async () => {
  const ok = await strip(FAKE, '/v/C0412.MP4');
  assert.equal(ok.err, null);
  assert.equal(ok.msg.type, 'strip');
  assert.equal(ok.msg.frames, 14, 'the engine\'s defaults');
  assert.equal(ok.msg.frameWidth, 384);
  assert.equal(ok.msg.distinct, 14);
  const t0 = Date.now();
  const bad = await strip(FAKE, '/v/C0412.MP4', { FAKE_STRIP: 'fail' });
  assert.equal(bad.msg, null);
  assert.equal(bad.err && bad.err.message, 'Making this strip took too long.', 'the engine\'s own words, not the panel\'s deadline');
  assert.ok(Date.now() - t0 < 1500, 'as soon as the engine says so, not at the 3 s kill');
  const gone = await strip('/nonexistent/select-engine', '/v/C0412.MP4');
  assert.ok(gone.err, 'no engine');
  process.env.FAKE_STRIP = '';
});

test('runStrip: an engine that doesn\'t answer in time is stopped, and stop() ends one without an answer', async () => {
  assert.equal(N.STRIP_KILL_MS, 3000, 'twice the engine\'s own 1.5 s');
  const t0 = Date.now();
  const late = await strip(FAKE, '/v/slowstrip.MP4', {}, 300);
  assert.equal(late.err && late.err.message, 'The engine took too long.', 'the panel\'s own deadline');
  assert.ok(Date.now() - t0 < 1500, 'it does not wait for the engine');
  const pid = late.handle.pid;
  const end = Date.now() + 3000;
  let alive = true;
  while (alive && Date.now() < end) {
    try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 50)); } catch (e) { alive = false; }
  }
  assert.equal(alive, false, 'the process is gone');
  let called = false;
  const h = N.runStrip(FAKE, '/v/slowstrip-two.MP4', () => { called = true; });
  h.stop();
  await new Promise(r => setTimeout(r, 400));
  assert.equal(called, false, 'stopped: no answer');
  let gone = false;
  try { process.kill(h.pid, 0); } catch (e) { gone = true; }
  assert.ok(gone, 'and no process');
});

// ---------------------------------------------------------------- colours combined: Shift-click on the dots

const by = (key, dir) => ({ key, dir });
// Each clip's colour comes with looking closer, as the engine sends it.
const colours = () => tier2(store([
  { path: '/v/DAY 1/Y1.MP4', colorName: 'yellow', colorHue: 100, colorChroma: .6, colorLight: .5, labels: [{ name: 'sun' }] },
  { path: '/v/DAY 1/B1.MP4', colorName: 'blue', colorHue: 250, colorChroma: .6, colorLight: .5, labels: [{ name: 'sea' }] },
  { path: '/v/DAY 2/R1.MP4', colorName: 'red', colorHue: 24, colorChroma: .6, colorLight: .5, labels: [{ name: 'sun' }] },
  { path: '/v/DAY 2/Y2.MP4', colorName: 'yellow', colorHue: 104, colorChroma: .6, colorLight: .5, labels: [{ name: 'sunset' }] },
  { path: '/v/DAY 2/B2.MP4', colorName: 'blue', colorHue: 255, colorChroma: .6, colorLight: .5, labels: [{ name: 'sun' }] },
  { path: '/v/DAY 2/G1.MP4', colorName: 'green', colorHue: 140, colorChroma: .6, colorLight: .5, labels: [{ name: 'sea' }] },
  { path: '/v/DAY 3/Y3.MP4', colorName: 'yellow', colorHue: 98, colorChroma: .05, colorLight: .5, labels: [{ name: 'sand' }] }
]));
function tier2(s) {
  s.rows.slice().forEach(r => C.ingest(s, { type: 'clip', tier: 2, path: r.path, moments: 3, colorName: r.colorName, colorHue: r.colorHue, colorChroma: r.colorChroma, colorLight: r.colorLight, labels: r.labels }));
  return s;
}

test('colours combined: the view shows clips of any colour on; with the rainbow sort they come grouped in the dots\' order', () => {
  const s = colours(), names = view => C.computeView(s.rows, view).order.map(i => s.rows[i].name.replace('.MP4', ''));
  assert.deepStrictEqual(C.viewFamilies({ families: ['blue', 'yellow', 'gone', 'blue'] }), ['yellow', 'blue'], 'the dots\' order, once each, only colours Select knows');
  assert.deepStrictEqual(C.viewFamilies({}), [], 'none on');
  assert.deepStrictEqual(names(V({ families: ['blue', 'yellow'] })), ['Y1', 'B1', 'Y2', 'B2', 'Y3'], 'with no sort: as listed, any of the colours');
  assert.deepStrictEqual(names(V({ families: ['blue', 'yellow'], sort: [by('colorName', 1)] })), ['Y1', 'Y2', 'Y3', 'B1', 'B2'], 'with the rainbow: every yellow, the flat one too, then blue');
  assert.deepStrictEqual(names(V({ families: ['blue', 'yellow'], sort: [by('colorName', -1)] })), ['B2', 'B1', 'Y3', 'Y2', 'Y1'], 'reversed: blue first');
  assert.deepStrictEqual(names(V({ sort: [by('colorName', 1)] })), ['R1', 'Y1', 'Y2', 'G1', 'B1', 'B2', 'Y3'], 'with no colour on, flat clips still run the spectrum again after the vivid ones');
  assert.deepStrictEqual(names(V({ families: ['yellow', 'blue'], sort: [by('colorName', 1)] })), names(V({ families: ['blue', 'yellow'], sort: [by('colorName', 1)] })), 'whichever was clicked first');
  assert.deepStrictEqual(names(V({ families: ['yellow'], sort: [by('colorName', 1)] })), ['Y1', 'Y2', 'Y3'], 'one colour as before');
  assert.deepStrictEqual(names(V({ families: [] })), ['Y1', 'B1', 'R1', 'Y2', 'B2', 'G1', 'Y3'], 'none: every clip');
  assert.equal(C.computeView(s.rows, V({ families: ['yellow', 'blue'] }), null, { tokens: C.searchTokens('sun') }).order.length, 3, 'a search narrows inside them');
  assert.ok(C.viewNeedsTier2(V({ families: ['yellow', 'blue'] })), 'colours come from looking closer');
});

test('colours combined: the words, the empty line, and the names a sequence or a bin gets', () => {
  const now = new Date(2026, 10, 4, 12).getTime();
  assert.equal(C.viewName(V({ families: ['blue', 'yellow'] })), 'Yellow and Blue');
  assert.equal(C.viewName(V({ families: ['blue', 'red', 'yellow'], sort: [by('colorName', 1)] })), 'Red, Yellow and Blue', 'three or more: commas, then and; the rainbow sort says nothing more');
  assert.equal(C.viewName(V({ families: ['yellow', 'blue'], show: 'interviews', sort: [by('sharpness', -1)] })), 'Yellow and Blue, interviews, sharpest first');
  assert.equal(C.familyWords(V({ families: ['yellow', 'blue'] }), 'or').toLowerCase(), 'yellow or blue', 'No yellow or blue clips.');
  assert.equal(C.familyWords(V({ families: ['yellow'] }), 'or'), 'Yellow');
  assert.equal(C.sequenceName(V({ families: ['blue', 'yellow'], sort: [by('colorName', 1)] }), '', 0, 'Day 2', now), 'SELECT 2026-11-04 Yellow and Blue');
  assert.equal(C.viewWhat(V({ families: ['blue', 'yellow'], sort: [by('colorName', 1)] }), '', 0, 'x'), 'Yellow and Blue', 'the top bin\'s name');
  const facts = { project: { path: '/p.prproj', name: 'p.prproj' }, connected: true, scan: { state: 'Done', failure: null, seconds: 2, stopping: false }, store: { total: 6, tier0: 6, tier1: 6, tier2: 6, errors: 0, bad: 0 }, rows: 6, shown: 4, selected: 0, query: '', groupCount: 0, status: 'ok' };
  assert.equal(C.footState({ ...facts, view: V({ families: ['blue', 'yellow'], sort: [by('colorName', 1)] }) }).verdict, 'Yellow and Blue', 'the status says the colours');
});

test('colours combined: Sort into Bins makes one bin for one colour, a bin per colour in the dots\' order for two or more', () => {
  const s = colours(), inView = view => C.computeView(s.rows, view).order.map(i => s.rows[i]);
  const one = V({ families: ['yellow'], sort: [by('colorName', 1)] });
  assert.equal(C.binsPlan(one), 'one', 'one colour: one bin, as before');
  const two = V({ families: ['blue', 'yellow'], sort: [by('colorName', 1)] });
  assert.equal(C.binsPlan(two), 'several');
  assert.deepStrictEqual(C.bucketize(inView(two), two).map(b => b.name + ':' + b.rows.length), ['01 Yellow:3', '02 Blue:2']);
  const three = V({ families: ['green', 'red', 'blue'] });
  assert.equal(C.binKind(three), 'colours', 'with no sort too');
  assert.deepStrictEqual(C.bucketize(inView(three), three).map(b => b.name), ['01 Red', '02 Green', '03 Blue']);
  assert.equal(C.binsPlan(V({ families: ['blue', 'yellow'], sort: [by('sharpness', -1)] })), 'several', 'sorted by sharpness: its fifths, as one colour does');
  assert.equal(C.binsPlan(V({ families: ['blue', 'yellow'], show: 'interviews' })), 'one', 'a Show makes one bin');
});

test('colours combined: a view saved with one colour, before 0.4, comes back as a list of one', () => {
  assert.deepStrictEqual(C.knownView({ show: 'interviews', sort: [by('sharpness', -1)], family: 'teal' }), { show: 'interviews', sort: [by('sharpness', -1)], families: ['teal'] });
  assert.deepStrictEqual(C.knownView({ family: null }).families, []);
  assert.deepStrictEqual(C.knownView({ family: 'mauve' }).families, [], 'a colour this Select doesn\'t know goes');
  assert.deepStrictEqual(C.knownView({ families: ['blue', 'red', 'mauve'] }).families, ['red', 'blue']);
  assert.deepStrictEqual(C.knownView(null), { show: null, sort: [], families: [] });
  assert.deepStrictEqual(C.knownView({ show: 'gone', sort: [by('gone', 1), by('luma', 2), by('luma', -1)] }), { show: null, sort: [by('luma', -1)], families: [] }, 'and the rest as before');
});

test('colours combined: a suggestion\'s count is what picking it shows inside the Show and the colours on', () => {
  const s = colours(), shows = (view, q) => C.computeView(s.rows, view, null, { tokens: C.searchTokens(q) }).order.length;
  for (const view of [V({ families: ['yellow', 'blue'] }), V({ families: ['red', 'green', 'blue'] }), V({ families: ['yellow', 'blue'], show: 'people' })]) {
    for (const typed of ['s', 'su', 'sun', 'se', 'd', 'day 2']) {
      for (const sg of C.suggestions(s.rows, typed, 6, view)) { assert.equal(sg.count, shows(view, sg.query), `${JSON.stringify(view)} ${typed} → ${sg.query}`); }
    }
  }
  assert.deepStrictEqual(C.suggestions(s.rows, 'su', 6, V({ families: ['yellow', 'blue'] })).map(x => [x.word, x.count]), [['sun', 3], ['sunset', 1]]);
});
