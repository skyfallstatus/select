#!/usr/bin/env node
// Runs the real engine binary through the panel's own Node code. Writes its lines for harness.js --replay.
//   real-engine.js <engine> <paths.txt> <out.jsonl> [--cache dir]
'use strict';
const fs = require('fs');
const C = require('../client/core.js');
const N = require('../client/native.js');
const [binary, list, out, ...extra] = process.argv.slice(2);
const paths = fs.readFileSync(list, 'utf8').split('\n').filter(Boolean);
const store = C.createStore();
C.addItems(store, paths.map(p => ({ path: p })));
const lines = [];
const t0 = performance.now();
let first = null;
const keys = { 0: new Set(), 1: new Set(), 2: new Set() };
N.runEngine(binary, paths, {
  onMessage: m => {
    if (first === null && m.type === 'clip') { first = performance.now() - t0; }
    lines.push(JSON.stringify(m));
    C.ingest(store, m);
    if (m.type === 'clip') { Object.keys(m).forEach(k => keys[m.tier].add(k)); }
  },
  onBad: l => console.log('BAD LINE', l.slice(0, 200)),
  onExit: info => {
    fs.writeFileSync(out, lines.join('\n') + '\n');
    console.log(`exit ${info.code}, ${lines.length} lines, ${((performance.now() - t0) / 1000).toFixed(2)} s, first clip at ${first && first.toFixed(0)} ms`);
    console.log(`rows ${store.rows.length}, tier0 ${store.tier0}, tier1 ${store.tier1}, errors ${store.errors}, bad ${store.bad}, done ${JSON.stringify(store.done)}`);
    const contract0 = 'name sizeBytes durationS fps width height rotation codec bitDepth chroma allIntra mbps hasAudio audioChannels createdAt timecode camera lens gamma isLog gpsLat gpsLon keyframeBytesMean motionProxy'.split(' ');
    const contract1 = 'sharpness luma contrast clipHighPct clipLowPct saturation warmth dhash audioDb silent thumb'.split(' ');
    const env = new Set(['type', 'tier', 'path', 'cached', 'ms']);
    console.log('tier 0 missing:', contract0.filter(k => !keys[0].has(k)), 'extra:', [...keys[0]].filter(k => !contract0.includes(k) && !env.has(k)));
    console.log('tier 1 missing:', contract1.filter(k => !keys[1].has(k)), 'extra:', [...keys[1]].filter(k => !contract1.includes(k) && !env.has(k)));
    const contract2 = 'moments people faces shotSize labels text sounds speech music iso shutterS aperture whiteBalanceK shake colorHue colorChroma colorLight colorName palette'.split(' ');
    console.log('tier 2 missing:', contract2.filter(k => !keys[2].has(k)), 'extra:', [...keys[2]].filter(k => !contract2.includes(k) && !env.has(k)));
    console.log(`tier2 ${store.tier2}, failed ${store.tier2Failed}, groups ${store.groups ? store.groups.length : 'none'}`);
    const nums = k => store.rows.map(r => r[k]).filter(v => typeof v === 'number').sort((a, b) => a - b);
    for (const k of ['sharpness', 'luma', 'clipHighPct', 'motionProxy', 'audioDb']) {
      const v = nums(k);
      console.log(`${k}: n=${v.length} min=${v[0]} median=${v[v.length >> 1]} max=${v[v.length - 1]}`);
    }
    const v = C.computeView(store.rows, { sort: [], preset: 'duplicates' });
    console.log(`near duplicates at ${C.NEAR_DUP_BITS} bits: ${v.groupCount} groups, ${v.order.length} clips`);
    console.log('thumb exists:', store.rows.filter(r => r.thumb && fs.existsSync(r.thumb)).length);
    if (info.stderr) { console.log('stderr tail:', info.stderr.split('\n').filter(Boolean).slice(-3).join(' | ')); }
  }
}, extra);
