#!/usr/bin/env node
// Stand-in for select-engine, for tests only. Emits contract-shaped JSON Lines: fixture values for known paths,
// values derived from the path hash for others.
//   FAKE_DELAY_MS  pause between lines     FAKE_ERRORS=n  every nth clip gets an error line
//   FAKE_MODE      split: bytes cut mid-line and mid-character   garbage: junk lines   crash: exit 3 half way
//                  deaf: ignores SIGTERM   noend: exit 0 without a done line
//   FAKE_THUMBS    a folder of generated pictures, one per fixture clip, named <index>.png
//   FAKE_REPLAY    a real engine's JSON Lines file: replayed as they are, paced by FAKE_DELAY_MS
//   FAKE_TIER2     off: stop after Tier 1, as an older engine would   fail: every 40th clip fails Tier 2, one way or the other
//                  crash: exit 4 half way through Tier 2   nogroups: no groups line
//   --cached-only  every clip comes from the cache, except those whose path contains "uncached" (an uncached line, tier 0),
//                  "changed" (the same, changed: true) or "partial" (tiers 0 and 1, then an uncached line for tier 2)
//   strip          one strip line; FAKE_STRIP=fail gives an error line instead, and a path containing "slowstrip" waits 2 s
//                  first. The strip's file is FAKE_THUMBS/<index>.png when FAKE_THUMBS is set, or FAKE_STRIPS/<fixture
//                  index>.jpg when FAKE_STRIPS is
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
if (args[0] === 'version') { console.log('0.0.0-fake'); process.exit(0); }
if (args[0] === 'strip') {
  const at = k => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  const p = at('--path'), frames = Number(at('--frames') || 14), width = Number(at('--width') || 384);
  if (!p) { console.error('usage: strip --path <clip>'); process.exit(2); }
  const out = o => { process.stdout.write(JSON.stringify(o) + '\n', () => process.exit(0)); };
  const go = () => {
    if (process.env.FAKE_STRIP === 'fail') { return out({ type: 'error', path: p, message: 'Making this strip took too long.', ms: 1500 }); }
    const n = crypto.createHash('sha1').update(p).digest().readUInt32LE(0) % 20;
    const times = Array.from({ length: frames }, (_, i) => Math.round((i + 0.5) / frames * 30 * 1000) / 1000);
    const strips = process.env.FAKE_STRIPS, own = strips && fs.readFileSync(path.join(__dirname, 'fixtures/clips.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).find(r => r.path === p);
    const file = strips ? path.join(strips, (own ? own.index : n) + '.jpg') : process.env.FAKE_THUMBS ? path.join(process.env.FAKE_THUMBS, n + '.png') : '/nonexistent/strip.jpg';
    out({ type: 'strip', path: p, file, frames, frameWidth: width, frameHeight: Math.round(width * 9 / 32) * 2, times, distinct: frames, cached: false, ms: 120 });
  };
  process.on('SIGTERM', () => process.exit(143));
  setTimeout(go, p.includes('slowstrip') ? 2000 : 0);
  return;
}
if (args[0] !== 'scan' || !args.includes('--paths-file')) { console.error('usage: scan --paths-file <file|->'); process.exit(2); }
const file = args[args.indexOf('--paths-file') + 1];
const tierArg = args.includes('--tier') ? Number(args[args.indexOf('--tier') + 1]) : 2;
const cachedOnly = args.includes('--cached-only');
const env = process.env;
const delay = Number(env.FAKE_DELAY_MS || 0), mode = env.FAKE_MODE || '', every = Number(env.FAKE_ERRORS || 0);
const thumbs = env.FAKE_THUMBS || '';

const fixture = new Map();
for (const line of fs.readFileSync(path.join(__dirname, 'fixtures/clips.jsonl'), 'utf8').split('\n')) {
  if (line) { const r = JSON.parse(line); fixture.set(r.path, r); }
}

const known = [...fixture.values()].filter(r => r.tier2 && r.tier2.moments);

function synth(p) {
  const h = crypto.createHash('sha1').update(p).digest();
  const u = i => h[i] / 255;
  return {
    tier0: {
      name: path.basename(p), sizeBytes: 1e8 + h[0] * 1e6, durationS: 2 + u(1) * 120, fps: 25, width: 3840, height: 2160, rotation: 0, codec: u(2) > 0.5 ? 'hevc' : 'h264',
      bitDepth: 10, chroma: '422', allIntra: false, mbps: 50 + u(3) * 200, hasAudio: u(4) > 0.2, audioChannels: 2, createdAt: new Date(1.76e12 + h.readUInt32LE(4) * 500).toISOString(),
      timecode: '00:00:00:00', camera: 'SONY ILME-FX3', lens: null, gamma: 's-log3-cine', isLog: true, gpsLat: null, gpsLon: null, keyframeBytesMean: u(5) * 1e5, motionProxy: u(6)
    },
    tier2: known[h.readUInt32LE(0) % known.length].tier2,
    tier1: {
      sharpness: u(7), luma: u(8), contrast: u(9), clipHighPct: u(10) * 3, clipLowPct: u(11) * 3, saturation: u(12), warmth: u(13) * 2 - 1,
      dhash: h.subarray(0, 8).toString('hex'), audioDb: u(4) > 0.2 ? -60 + u(14) * 50 : null, silent: u(4) > 0.2 ? u(14) < 0.1 : null, thumb: null
    }
  };
}

function shuffled(list, seed) {
  const out = list.slice();
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Clips beyond the fixture borrow a fixture clip's picture.
function fixtureThumb(p) {
  return known[crypto.createHash('sha1').update(p).digest().readUInt32LE(0) % known.length].index;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let leaving = false;
if (mode === 'deaf') { process.on('SIGTERM', () => {}); } else { process.on('SIGTERM', () => { leaving = true; process.exit(143); }); }
process.stdout.on('error', () => process.exit(0));

async function emit(obj) {
  const text = JSON.stringify(obj) + '\n';
  if (mode === 'split') {
    const b = Buffer.from(text, 'utf8');
    for (let i = 0; i < b.length; i += 7) {
      process.stdout.write(b.subarray(i, i + 7));
      if (i % 70 === 0) { await sleep(0); }
    }
  } else {
    process.stdout.write(text);
  }
  if (delay) { await sleep(delay); }
}

async function main() {
  const text = fs.readFileSync(file === '-' ? 0 : file, 'utf8');
  if (env.FAKE_REPLAY) {
    for (const line of fs.readFileSync(env.FAKE_REPLAY, 'utf8').split('\n')) {
      if (line && !leaving) { await emit(JSON.parse(line)); }
    }
    return;
  }
  const paths = text.split('\n').filter(Boolean);
  const t0 = Date.now();
  const n = paths.length;
  await emit({ type: 'start', total: n, schema: 1, engineVersion: '0.0.0-fake', ...(cachedOnly ? { cachedOnly: true } : {}) });
  const rec = p => fixture.get(p) || synth(p);
  if (cachedOnly) { return answerFromCache(paths, rec, t0); }
  const failed = new Set(every ? paths.filter((_, i) => i % every === every - 1) : []);
  for (const p of paths) { if (rec(p).error) { failed.add(p); } }
  for (const p of shuffled(paths, 7)) {
    if (leaving) { return; }
    if (failed.has(p)) { await emit({ type: 'error', path: p, message: rec(p).error || 'cannot read this file' }); continue; }
    await emit({ type: 'clip', tier: 0, path: p, cached: false, ms: 3.1, ...rec(p).tier0 });
    if (mode === 'garbage') { process.stdout.write('this is not json\n{"type":\n'); }
  }
  let done = 0;
  if (tierArg > 0) {
    for (const p of shuffled(paths, 13)) {
      if (leaving || failed.has(p)) { continue; }
      if (mode === 'crash' && done > n / 2) { console.error('fake engine: simulated crash'); process.exit(3); }
      const t1 = { ...rec(p).tier1 };
      if (thumbs && !t1.reason) { t1.thumb = path.join(thumbs, (rec(p).index === undefined ? fixtureThumb(p) : rec(p).index) + '.png'); }
      await emit({ type: 'clip', tier: 1, path: p, cached: false, ms: 41, ...t1 });
      done++;
    }
  }
  const t2 = env.FAKE_TIER2 || '';
  if (tierArg > 1 && t2 !== 'off') {
    const live = shuffled(paths, 19).filter(p => !failed.has(p));
    let at = 0;
    for (const p of live) {
      if (leaving) { return; }
      if (t2 === 'crash' && at > live.length / 2) { console.error('fake engine: simulated crash in Tier 2'); process.exit(4); }
      at++;
      if (t2 === 'fail' && at % 80 === 0) { await emit({ type: 'error', tier: 2, path: p, message: 'could not look closer' }); continue; }
      if (t2 === 'fail' && at % 40 === 0) { await emit({ type: 'clip', tier: 2, path: p, cached: false, ms: 0, moments: 0 }); continue; }
      if (t2 === 'fail' && at % 60 === 0) { await emit({ type: 'clip', tier: 2, path: p, cached: false, ms: 0, moments: 0, people: null, labels: null, text: null, palette: null, colorName: null, reason: 'Looking closer at this clip took too long, so it was left out.' }); continue; }
      await emit({ type: 'clip', tier: 2, path: p, cached: false, ms: 90, ...rec(p).tier2 });
    }
    if (t2 !== 'nogroups') {
      const looks = new Map();
      for (const p of live) {
        const r = fixture.get(p);
        if (r && r.index % 11 <= 2 && r.tier2 && r.tier2.moments) { if (!looks.has(r.look)) { looks.set(r.look, []); } looks.get(r.look).push(p); }
      }
      const groups = [...looks.values()].filter(g => g.length > 1).map((g, i) => ({ id: i + 1, paths: g }));
      await emit({ type: 'groups', groups });
    }
  }
  if (mode === 'noend') { return; }
  await emit({ type: 'done', clips: n, failed: failed.size, cached: 0, wallMs: Date.now() - t0, degraded: paths.filter(p => !failed.has(p) && rec(p).tier1 && rec(p).tier1.reason).length });
}

// --cached-only: tiers in order, every line cached, uncached lines for what the cache wouldn't hold, then groups and done.
async function answerFromCache(paths, rec, t0) {
  const gone = p => /uncached|changed/.test(p);
  const partial = p => p.includes('partial');
  let failed = 0, uncached = 0, clips = 0;
  for (const p of paths) {
    if (rec(p).error) { failed++; await emit({ type: 'error', path: p, message: rec(p).error }); continue; }
    if (gone(p)) { uncached++; await emit({ type: 'uncached', path: p, tier: 0, changed: p.includes('changed') }); continue; }
    clips++;
    await emit({ type: 'clip', tier: 0, path: p, cached: true, ms: 0, ...rec(p).tier0 });
  }
  const live = paths.filter(p => !rec(p).error && !gone(p));
  if (tierArg > 0) {
    for (const p of live) {
      const t1 = { ...rec(p).tier1 };
      if (thumbs && !t1.reason) { t1.thumb = path.join(thumbs, (rec(p).index === undefined ? fixtureThumb(p) : rec(p).index) + '.png'); }
      await emit({ type: 'clip', tier: 1, path: p, cached: true, ms: 0, ...t1 });
    }
  }
  if (tierArg > 1) {
    for (const p of live) {
      if (partial(p)) { uncached++; await emit({ type: 'uncached', path: p, tier: 2, changed: false }); continue; }
      await emit({ type: 'clip', tier: 2, path: p, cached: true, ms: 0, ...rec(p).tier2 });
    }
    await emit({ type: 'groups', groups: [] });
  }
  const answered = live.filter(p => tierArg < 2 || !partial(p)).length;
  await emit({ type: 'done', clips, failed, cached: answered, wallMs: Date.now() - t0, degraded: 0, uncached });
}

main().then(() => process.stdout.write('', () => process.exit(0)));
