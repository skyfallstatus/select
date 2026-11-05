// The fifth round of feedback on 0.4: the band's life. Every way the band opens to offer a scan, and what closes it.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../client/core.js');

const V = o => ({ show: null, sort: [], families: [], ...o });
const PROJECT = { path: '/p/rushsort-test.prproj', name: 'rushsort-test.prproj' };
const OTHER = { path: '/p/testt2.prproj', name: 'testt2.prproj' };
const O = { connected: true, project: PROJECT, title: 'rushsort-test' };
const items = (n, folder, from) => Array.from({ length: n }, (_, i) => ({ id: String(i), path: `/v/${folder || 'Day 2'}/C${1000 + (from || 0) + i}.MP4`, bin: folder || 'Day 2' }));
const store = list => { const s = C.createStore(); C.addItems(s, list); return s; };
const whole = list => ({ kind: 'project', sig: '', items: list, places: [], more: 0, project: PROJECT });

// The band as the panel draws it: the facts, footState, bandRow. others as refreshOthers works it out.
function band(over) {
  const st = over.store || store(items(72));
  const x = {
    ...O, listing: false, busy: null, outcome: null, store: st, rows: st.rows.length, shown: st.rows.length, selected: 0, groupCount: 0,
    query: '', view: V(), scan: { state: 'Done', failure: null, seconds: 1, stopping: false }, target: null, foreign: '', notRead: 0, ...over
  };
  if (!('others' in over)) { x.others = x.rows && x.scan && x.scan.state !== 'Scanning' ? C.scanOthers(x.target, st, over.from || null, x.project) : 0; }
  const f = C.footState(x), row = C.bandRow(f, x);
  return row && { icon: row.icon, verdict: row.verdict, sentence: row.sentence, actions: row.actions.join(), primary: row.primary, rank: row.rank, scanWhat: f.scanWhat };
}

const day2 = items(72);                                  // what was scanned: Day 2
const fromBins = { project: PROJECT, words: 'Day 2', target: { kind: 'bins', places: ['Day 2'] } };
const fromClips = { project: PROJECT, words: 'New', target: { kind: 'clips', places: ['New'] } };
const fromWhole = { project: PROJECT, words: 'rushsort-test', target: { kind: 'project', places: [] } };
const fromWholeMenu = { project: PROJECT, words: 'rushsort-test', target: { kind: 'project', places: [], whole: true } };
const fromFolder = { project: null, words: 'A001', target: null };
const projectNow = items(72).concat(items(547, 'Day 1'));   // 619 clips in the project

test('row 1, first run: before any results the target shows, with the one blue Scan', () => {
  const none = store([]);
  assert.deepStrictEqual(band({ store: none, scan: null, target: whole(projectNow) }),
    { icon: 'bin', verdict: 'Whole project', sentence: '619 clips', actions: 'scan', primary: 'scan', rank: 4, scanWhat: 'target' });
  assert.deepStrictEqual(band({ store: none, scan: null, target: { kind: 'clips', sig: '12:a', items: items(12), places: ['Day 2'], more: 0 } })
    .verdict, '12 clips selected', 'a selection before any results: the same row, its words');
});

test('row 2, a new selection: bins or clips the results lack open the band with an outlined Scan', () => {
  const day3 = { kind: 'clips', sig: '9:c', items: items(9, 'Day 3'), places: ['Day 3'], more: 0 };
  assert.deepStrictEqual(band({ from: fromBins, target: day3 }),
    { icon: 'clips', verdict: '9 other clips selected', sentence: 'Day 3', actions: 'scan', primary: null, rank: 4, scanWhat: 'target' });
  const mixed = { kind: 'clips', sig: '12:c', items: items(4).concat(items(8, 'Day 3')), places: ['Day 2', 'Day 3'], more: 0 };
  assert.equal(band({ from: fromBins, target: mixed }).verdict, '8 other clips selected', 'clips: today\'s words, counting only what the results lack');
  const bin3 = { kind: 'bins', sig: '1:b', items: items(40, 'Day 3'), places: ['Day 3'], more: 0 };
  assert.deepStrictEqual(band({ from: fromBins, target: bin3 }).verdict + ' · ' + band({ from: fromBins, target: bin3 }).sentence, 'Day 3 · 40 clips', 'a bin the results don\'t hold at all: its clips');
  const grown = { kind: 'bins', sig: '1:b2', items: items(72).concat(items(8, 'Day 2', 500)), places: ['Day 2'], more: 0 };
  const g = band({ from: fromBins, target: grown });
  assert.deepStrictEqual([g.verdict, g.sentence, g.actions], ['Day 2', '8 new clips', 'scan'], 'a scanned bin with footage added since: only the new clips');
  assert.equal(band({ from: fromWhole, target: bin3 }).verdict, 'Day 3', 'after a scan of the whole project too');
  assert.equal(band({ from: fromFolder, target: bin3 }).verdict, 'Day 3', 'and after a folder\'s');
});

test('row 2 closes: a selection inside the results, a scan under way, or Clear Results', () => {
  const inside = { kind: 'clips', sig: '5:a', items: items(5), places: ['Day 2'], more: 0 };
  assert.equal(band({ from: fromBins, target: inside }), null, 'a selection inside the results is no news');
  const day3 = { kind: 'clips', sig: '9:c', items: items(9, 'Day 3'), places: ['Day 3'], more: 0 };
  const running = { state: 'Scanning', failure: null, seconds: 1, stopping: false };
  assert.equal(band({ from: fromBins, target: day3, scan: running, store: { ...store(day3.items), tier0: 0 } }).rank, 1, 'Scan pressed: the scan\'s own row');
  assert.equal(band({ from: fromBins, target: day3, store: store(items(9, 'Day 3')) }), null, 'scanned: the results are that selection, nothing more to offer');
  assert.equal(band({ store: store([]), scan: null, target: day3 }).primary, 'scan', 'Clear Results: back to row 1, the blue Scan');
});

test('row 3, the whole project: an empty selection is news only for new footage after a scan of the whole project', () => {
  // 5 Nov, in real Premiere: a selection of new footage scanned, then the Project panel selection let go. Nothing opens.
  const fresh = items(8, 'New', 900);
  assert.equal(band({ from: fromClips, store: store(fresh), target: whole(projectNow.concat(fresh)) }), null, 'after a scan of a selection, letting it go opens nothing');
  assert.equal(band({ from: fromBins, target: whole(projectNow) }), null, 'after a scan of a bin, the same');
  assert.equal(band({ from: fromFolder, target: whole(projectNow) }), null, 'after a scan of a folder, the same');
  assert.equal(band({ from: fromBins, target: { ...whole(projectNow), sig: '1:seq' } }), null, 'a sequence selected reads the whole project: no news either');
  // The results are the whole project: news only when the project now holds clips they lack.
  assert.equal(band({ from: fromWhole, store: store(projectNow), target: whole(projectNow) }), null, 'nothing new: no band');
  const row = band({ from: fromWhole, store: store(projectNow), target: whole(projectNow.concat(fresh)) });
  assert.deepStrictEqual(row, { icon: 'bin', verdict: 'Whole project', sentence: '8 new clips', actions: 'scan', primary: null, rank: 4, scanWhat: 'target' }, 'footage imported since: only the new clips, an outlined Scan');
  assert.equal(band({ from: fromWholeMenu, store: store(projectNow), target: whole(projectNow.concat(fresh)) }).sentence, '8 new clips', 'Scan Whole Project from ··· counts as the whole project');
  assert.equal(band({ from: fromWhole, store: store(projectNow), target: whole(projectNow.concat(items(1, 'New', 900))) }).sentence, '1 new clip');
  // Scan's tooltip says the same, and Scan reads the whole project (the target), most of it from the cache.
  const x = { ...O, listing: false, busy: null, outcome: null, store: store(projectNow), rows: 619, shown: 619, selected: 0, groupCount: 0, query: '', view: V(), scan: { state: 'Done', failure: null, seconds: 1, stopping: false }, target: whole(projectNow.concat(fresh)), foreign: '', notRead: 0 };
  x.others = C.scanOthers(x.target, x.store, fromWhole, PROJECT);
  assert.equal(C.footState(x).scanTip, 'Whole project · 8 new clips');
});

test('row 3 closes: Scan reads the whole project again, and the new clips are in the results', () => {
  const fresh = items(8, 'New', 900), all = projectNow.concat(fresh);
  assert.equal(band({ from: fromWhole, store: store(all), target: whole(all) }), null);
  assert.equal(band({ from: fromWhole, store: store(projectNow), target: { kind: 'clips', sig: '3:a', items: items(3), places: ['Day 2'], more: 0 } }), null, 'a selection inside the results: none either');
});

test('the whole project of another project is never news for this one\'s results', () => {
  assert.equal(C.wholeResults(fromWhole, PROJECT), true);
  assert.equal(C.wholeResults(fromWhole, OTHER), false);
  assert.equal(C.wholeResults(fromBins, PROJECT), false);
  assert.equal(C.wholeResults(fromFolder, PROJECT), false);
  assert.equal(C.wholeResults(null, PROJECT), false);
  assert.equal(C.wholeResults({ project: { path: '/p/Café.prproj' }, target: { kind: 'project' } }, { path: '/p/Café.prproj' }), true, 'either Unicode form of the path');
  assert.equal(C.scanOthers({ kind: 'several', items: [] }, store(day2), fromWhole, PROJECT), 0);
  assert.equal(C.scanOthers(null, store(day2), fromWhole, PROJECT), 0);
});

test('row 4, clips not read: the count and an outlined Scan of the same clips; it closes once they are read', () => {
  assert.deepStrictEqual(band({ from: fromBins, notRead: 5 }), { icon: 'info', verdict: '5 not read', sentence: '', actions: 'scan', primary: null, rank: 5, scanWhat: 'same' });
  assert.equal(band({ from: fromBins, notRead: 0 }), null);
  const day3 = { kind: 'clips', sig: '9:c', items: items(9, 'Day 3'), places: ['Day 3'], more: 0 };
  assert.equal(band({ from: fromBins, notRead: 5, target: day3 }).verdict, '9 other clips selected', 'a new selection outranks them');
});

test('row 5, another project in front: From it, with the one blue Scan; it closes with that project back in front', () => {
  const row = band({ from: fromWhole, foreign: 'rushsort-test', project: OTHER, title: 'testt2', target: whole(items(60, 'B')) });
  assert.deepStrictEqual([row.verdict, row.actions, row.primary, row.rank], ['From rushsort-test', 'scan', 'scan', 4]);
  assert.equal(band({ from: fromWhole, foreign: '', store: store(projectNow), target: whole(projectNow) }), null, 'back in front: calm');
});
