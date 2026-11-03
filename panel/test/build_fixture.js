#!/usr/bin/env node
// Builds test/fixtures/clips.jsonl and test/out/thumbs/*.png. Everything here is invented: the clients, the shoots, the
// paths under a fake volume and the pictures. The values follow the spreads of real footage, with their long tails,
// heavy zeros and nulls, so sorting, bins and the table are tested on realistic data without any real data.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const COUNT = 400;
const VOLUME = '/Volumes/Field SSD/Clients';

// hues: the colours a shoot leans to, in degrees. scenes: what it was shot in. text: words on its signs.
const SHOOTS = [
  { client: 'Lantern Bakery Co.', shoot: '22.10.26 Spring menu', hues: [32, 42, 18], scenes: ['interior', 'figure', 'interior'], labels: ['bread', 'kitchen', 'oven', 'table'], text: ['Lantern Bakery', 'Fresh today', 'Sourdough'] },
  { client: 'Tidemark Rowing Club', shoot: '19.10.26 Regatta', hues: [204, 186, 216], scenes: ['sea', 'sea', 'figure'], labels: ['water', 'boat', 'rowing', 'sky'], text: ['TIDEMARK', 'Lane 4', 'Finish'] },
  { client: 'Fernhill Gardens', shoot: '30.09.26 Open day', hues: [112, 92, 142, 330], scenes: ['ridge', 'cloth', 'ridge', 'figure'], labels: ['garden', 'trees', 'flowers', 'grass'], text: ['Fernhill', 'Rose walk'] },
  { client: 'Neon Tide Festival', shoot: '12.10.26 Night two', hues: [282, 312, 262, 332], scenes: ['bokeh', 'bokeh', 'figure'], labels: ['stage', 'lights', 'crowd', 'night'], text: ['NEON TIDE', 'Main stage'] },
  { client: 'Harbour Street Ceramics', shoot: '08.10.26 Studio', hues: [8, 352, 172, 24], scenes: ['interior', 'cloth', 'figure'], labels: ['pottery', 'clay', 'workshop', 'hands'], text: ['Harbour St', 'Kiln 2'] },
  { client: 'North Pier Coffee', shoot: '27.09.26 Roastery', hues: [28, 54, 16], scenes: ['interior', 'bokeh', 'figure'], labels: ['coffee', 'cup', 'cafe', 'machine'], text: ['North Pier', 'Single origin'] },
  { client: 'Saltmarsh Surf School', shoot: '05.09.26 Dawn', hues: [176, 196, 340, 44], scenes: ['sea', 'ridge', 'figure'], labels: ['beach', 'waves', 'surfboard', 'sunrise'], text: ['Saltmarsh', 'Lesson 1'] },
  { client: 'Lantern Bakery Co.', shoot: '02.09.26 Launch', hues: [50, 36, 6], scenes: ['figure', 'interior'], labels: ['bread', 'people', 'shop', 'counter'], text: ['Grand opening'] }
];
const SOUNDS = { interior: ['kitchen', 'clatter', 'speech'], sea: ['water', 'wind', 'birds'], ridge: ['wind', 'birds', 'rustle'], bokeh: ['crowd', 'music', 'cheering'], cloth: ['rustle', 'room tone'], figure: ['speech', 'room tone', 'laughter'] };
const CAMERAS = [
  { folder: 'FX3', camera: 'SONY ILME-FX3', lens: 'FE 24-70mm F2.8 GM II', weight: 5 },
  { folder: 'A7S', camera: 'SONY ILCE-7SM3', lens: 'FE 35mm F1.4 GM', weight: 3 },
  { folder: 'R5', camera: 'Canon EOS R5', lens: 'RF 50mm F1.2L USM', weight: 2 },
  { folder: 'Drone', camera: 'DJI Mavic 3', lens: null, weight: 1 },
  { folder: 'Pocket', camera: null, lens: null, weight: 2 }
];
const SIZES = [[3840, 2160, 62], [1920, 1080, 18], [4096, 2160, 12], [2160, 3840, 5], [1080, 1920, 3]];
const RATES = [[50, 47], [25, 34], [59.94, 9], [29.97, 4], [24, 3], [23.98, 2], [100, 1]];
const CODECS = [['h264', 90], ['prores', 8], ['hevc', 2]];
const BITS = [[10, 68], [8, 30], [12, 2]];

// [share of clips, value]: read as a curve, so an odd draw lands in the tail as it does in a real project.
const SPREADS = {
  durationS: [[0, 3.4], [.02, 4.3], [.1, 6.2], [.25, 8.2], [.5, 12.5], [.75, 23.5], [.9, 78], [.98, 830], [1, 3360]],
  mbps: [[0, 2.4], [.02, 13], [.1, 71], [.25, 169], [.5, 280], [.75, 514], [.9, 590], [.98, 710], [1, 966]],
  motionProxy: [[0, 0], [.02, .034], [.1, .122], [.25, .246], [.5, .436], [.75, .757], [.88, 1], [1, 1]],
  sharpness: [[0, .01], [.02, .096], [.1, .177], [.25, .28], [.5, .493], [.75, .69], [.88, 1], [1, 1]],
  luma: [[0, 0], [.02, .175], [.1, .284], [.25, .349], [.5, .419], [.75, .475], [.9, .52], [.98, .648], [1, .86]],
  contrast: [[0, .003], [.02, .047], [.1, .107], [.25, .184], [.5, .286], [.75, .459], [.9, .623], [.98, .756], [1, .962]],
  clipHighPct: [[0, 0], [.87, 0], [.9, .02], [.98, .81], [1, 15]],
  clipLowPct: [[0, 0], [.84, 0], [.9, .43], [.98, 50], [1, 100]],
  audioDb: [[0, -91], [.02, -91], [.1, -68.5], [.25, -53.3], [.5, -38.7], [.75, -24.4], [.9, -18.7], [.98, -13.8], [1, -12.8]]
};
const RATE_OF = { noAudio: .02, silent: .15, noDate: .04, noSharpness: .015, noMotion: .01, noChroma: .2 };
const LOG_SHARE = .18, NEUTRAL_SHARE = .13;

// A clip the engine cannot read, as it reports one: its line carries a message and nothing else.
const UNREADABLE = [
  { name: 'A001_C014_1022AB.R3D', folder: 'RED', message: 'unsupported file (not an MP4 container) and ffprobe not found' },
  { name: 'A001_10221430_C003.braw', folder: 'Pocket', message: 'unsupported file (not an MP4 container) and ffprobe not found' },
  { name: 'A001_C015_1022AC.R3D', folder: 'RED', message: 'unsupported file (not an MP4 container) and ffprobe not found' },
  { name: 'C0012.MXF', folder: 'FX6', message: 'unsupported file (not an MP4 container) and ffprobe not found' },
  { name: 'C0013.MXF', folder: 'FX6', message: 'unsupported file (not an MP4 container) and ffprobe not found' },
  { name: 'C0214.MP4', folder: 'FX3', message: 'file is truncated' },
  { name: 'C0215.MP4', folder: 'FX3', message: 'No such file or directory' },
  { name: 'C0098.MOV', folder: 'A7S', message: 'no system decoder for this clip and ffmpeg not found' }
];

// A clip with good file details whose picture this Mac cannot decode, as the engine reports one. Most are the same
// format, because on a given Mac they usually are.
const NO_PICTURE = ["This Mac has no decoder for H.264 10-bit 4:2:2, and ffmpeg isn't installed. File details are fine, picture scores are blank.",
  "This Mac has no decoder for H.264 8-bit 4:2:2, and ffmpeg isn't installed. File details are fine, picture scores are blank."];

function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function along(curve, share) {
  for (let i = 1; i < curve.length; i++) {
    const [p0, v0] = curve[i - 1], [p1, v1] = curve[i];
    if (share <= p1) { return p1 === p0 ? v1 : v0 + (v1 - v0) * (share - p0) / (p1 - p0); }
  }
  return curve[curve.length - 1][1];
}

function weighted(rand, list, weightOf) {
  const total = list.reduce((n, x) => n + weightOf(x), 0);
  let at = rand() * total;
  for (const x of list) {
    at -= weightOf(x);
    if (at <= 0) { return x; }
  }
  return list[list.length - 1];
}

function round(v, places) { const k = 10 ** places; return Math.round(v * k) / k; }

function flip(hex, bits) {
  let n = BigInt('0x' + hex);
  for (let i = 0; i < bits; i++) { n ^= 1n << BigInt(i * 5); }
  return n.toString(16).padStart(16, '0');
}

function stamp(shoot, rand) {
  const [, day, month, year] = /^(\d\d)\.(\d\d)\.(\d\d)/.exec(shoot.shoot);
  const minutes = 8 * 60 + Math.floor(rand() * 9 * 60);
  return `20${year}-${month}-${day}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:${String(Math.floor(rand() * 60)).padStart(2, '0')}.000000Z`;
}

function build() {
  const rand = random(20261103), out = [];
  let card = 82, clip = 148, shoot = SHOOTS[0], gear = CAMERAS[0], prevHash = null, prev = null, look = null, nextFailed = 0;
  for (let i = 0; i < COUNT; i++) {
    if (i % 40 === 0) { shoot = SHOOTS[(i / 40) % SHOOTS.length]; look = null; gear = i % 120 === 80 ? CAMERAS[CAMERAS.length - 1] : weighted(rand, CAMERAS, c => c.weight); card++; clip += 3 + Math.floor(rand() * 30); }
    const base = `${VOLUME}/${shoot.client}/${shoot.shoot}/Footage`;
    if (i % 47 === 23 && nextFailed < UNREADABLE.length) {
      const bad = UNREADABLE[nextFailed++];
      out.push({ path: `${base}/${bad.folder}/A0${card}/${bad.name}`, index: i, scene: 0, error: bad.message });
      continue;
    }
    const shape = i % 11 === 1 || i % 11 === 2 ? prev : drawPlan(shoot, rand);
    if (i % 11 === 0) { prev = shape; }
    const name = `C${String(clip++).padStart(4, '0')}.MP4`;
    const clipPath = `${base}/${gear.folder}/A0${card}/${name}`;
    const has = key => rand() >= RATE_OF[key];
    const [width, height] = weighted(rand, SIZES, s => s[2]);
    const durationS = round(along(SPREADS.durationS, rand()), 2), mbps = round(along(SPREADS.mbps, rand()), 1);
    const hasAudio = has('noAudio'), audioDb = hasAudio ? round(along(SPREADS.audioDb, rand()), 1) : null;
    let dhash = crypto.createHash('sha1').update(clipPath).digest('hex').slice(0, 16);
    if (i % 11 === 0) { prevHash = dhash; }
    if (i % 11 === 1 || i % 11 === 2) { dhash = flip(prevHash, 2 + i % 11); }     // groups of three, 3 or 4 bits apart
    const bit = weighted(rand, BITS, b => b[1])[0];
    const clipHigh = round(along(SPREADS.clipHighPct, rand()), 2), clipLow = round(along(SPREADS.clipLowPct, rand()), 2);
    const blank = i % 61 === 40;
    out.push({
      path: clipPath, index: i, look: i - i % 11, plan: shape,
      tier0: {
        name, sizeBytes: Math.round(mbps * durationS * 125000), durationS, fps: weighted(rand, RATES, r => r[1])[0], width, height, rotation: height > width ? 90 : 0,
        codec: weighted(rand, CODECS, c => c[1])[0], bitDepth: bit, chroma: has('noChroma') ? (bit === 8 ? '420' : '422') : null, allIntra: null, mbps, hasAudio, audioChannels: hasAudio ? 2 : null,
        createdAt: has('noDate') ? stamp(shoot, rand) : null, timecode: null, camera: gear.camera, lens: gear.lens,
        gamma: null, isLog: null, gpsLat: null, gpsLon: null, keyframeBytesMean: null,
        motionProxy: has('noMotion') ? round(along(SPREADS.motionProxy, rand()), 3) : null
      },
      tier1: blank
        ? { sharpness: null, luma: null, contrast: null, clipHighPct: null, clipLowPct: null, saturation: null, warmth: null, dhash: null, audioDb, silent: hasAudio ? audioDb < -60 : null, thumb: null, reason: NO_PICTURE[i % 2] }
        : {
          sharpness: has('noSharpness') ? round(along(SPREADS.sharpness, rand()), 3) : null, luma: round(along(SPREADS.luma, rand()), 3), contrast: round(along(SPREADS.contrast, rand()), 3),
          clipHighPct: clipHigh, clipLowPct: clipLow, saturation: round(.25 + rand() * .5, 3), warmth: round(rand() * 1.2 - .6, 3),
          dhash, audioDb, silent: hasAudio ? audioDb < -60 : null, thumb: null
        },
      tier2: tier2Of(shape, shoot, gear, rand, { hasAudio, blank, lost: i % 53 === 7, slow: i % 97 === 50 })
    });
  }
  return out;
}

// ---------------------------------------------------------------- Tier 2, invented, with its nulls where real files have them

function drawPlan(shoot, rand) {
  const pick = list => list[Math.floor(rand() * list.length)];
  const neutral = rand() < NEUTRAL_SHARE, log = !neutral && rand() < LOG_SHARE;
  const hue = (pick(shoot.hues) + (rand() - .5) * 26 + 360) % 360;
  return { kind: pick(shoot.scenes), hue, neutral, log, sat: neutral ? .05 : .55 + rand() * .35, seed: Math.floor(rand() * 1e6), people: 0 };
}

// The engine's hues are Oklab degrees, so the fixture's are too, with the engine's family boundaries.
function oklabHue(rgb) {
  const [r, g, b] = rgb.map(v => { const x = v / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; });
  const l = Math.cbrt(.4122 * r + .5363 * g + .0514 * b), m = Math.cbrt(.2119 * r + .6807 * g + .1074 * b), s = Math.cbrt(.0883 * r + .2817 * g + .63 * b);
  const a = 1.9779 * l - 2.4286 * m + .4506 * s, bb = .0259 * l + .7828 * m - .8087 * s;
  return (Math.atan2(bb, a) * 180 / Math.PI + 360) % 360;
}

function familyOf(hue) {
  if (hue < 20) { return 'pink'; }
  if (hue < 45) { return 'red'; }
  if (hue < 80) { return 'orange'; }
  if (hue < 115) { return 'yellow'; }
  if (hue < 165) { return 'green'; }
  if (hue < 220) { return 'teal'; }
  if (hue < 285) { return 'blue'; }
  if (hue < 330) { return 'purple'; }
  return 'pink';
}

function tier2Of(plan, shoot, gear, rand, o) {
  const pick = list => list[Math.floor(rand() * list.length)], conf = () => round(.4 + rand() * .59, 2);
  const nothing = { moments: 0, people: null, faces: null, shotSize: null, labels: [], text: [], sounds: o.hasAudio ? [] : null, speech: o.hasAudio ? false : null, music: o.hasAudio ? false : null,
    iso: null, shutterS: null, aperture: null, shake: null, colorHue: null, colorChroma: 0, colorLight: .5, colorName: 'neutral', palette: [] };
  if (o.lost) { return { moments: 0 }; }    // how the engine reports a clip it could not look at
  // With no picture, every picture field is null and sound and camera values stay, as the engine sends it.
  const noPicture = { ...nothing, labels: null, text: null, palette: null, colorHue: null, colorChroma: null, colorLight: null, colorName: null };
  if (o.blank) { return { ...noPicture, sounds: o.hasAudio ? [{ name: 'room tone', conf: .6 }] : null }; }
  if (o.slow) { return { ...noPicture, people: null, faces: null, moments: 0, reason: 'Looking closer at this clip took too long, so it was left out. Its file details and picture scores stand.' }; }
  const figure = plan.kind === 'figure', crowd = plan.kind === 'bokeh' && rand() < .5;
  const shot = figure ? pick(['medium', 'medium', 'medium', 'medium', 'wide']) : (crowd ? 'wide' : null);
  plan.shot = shot;
  const people = figure ? 1 + Math.floor(rand() * rand() * 4) : (crowd ? 5 + Math.floor(rand() * 20) : 0);
  const faces = figure ? (shot === 'wide' ? Math.min(people, 1) : people) : (crowd ? Math.floor(rand() * 4) : 0);
  const voices = figure && o.hasAudio && rand() < .7, tune = o.hasAudio && (plan.kind === 'bokeh' ? rand() < .8 : rand() < .08);
  const sounds = !o.hasAudio ? null : [...(voices ? ['speech'] : []), ...(tune ? ['music'] : []), ...SOUNDS[plan.kind].filter(n => n !== 'speech')].slice(0, 3).map(name => ({ name, conf: conf() }));
  const gyro = rand() < .88;     // the engine finds gyro data in most files, and none in about one in eight
  return {
    moments: 3, people, faces, shotSize: shot,
    labels: [...shoot.labels.slice().sort(() => rand() - .5).slice(0, 3), ...(figure ? ['person'] : [])].map(name => ({ name, conf: conf() })),
    text: rand() < .14 ? [pick(shoot.text)] : [], sounds, speech: o.hasAudio ? voices : null, music: o.hasAudio ? tune : null,
    iso: gear.camera ? pick([100, 400, 800, 1600, 3200, 6400, 12800]) : null, shutterS: gear.camera ? pick([1 / 50, 1 / 100, 1 / 60, 1 / 200]) : null, aperture: gear.lens ? pick([1.4, 2, 2.8, 4, 5.6]) : null,
    shake: gyro ? round(Math.min(1, rand() ** 2.2), 3) : null,
    colorHue: plan.neutral ? null : round(oklabHue(hsl(plan.hue, .8, .5)), 1), colorChroma: round(plan.neutral ? .02 : (plan.log ? .05 + rand() * .08 : .25 + rand() * .55), 3),
    colorLight: round(.25 + rand() * .55, 3), colorName: plan.neutral ? 'neutral' : familyOf(oklabHue(hsl(plan.hue, .8, .5))), palette: []
  };
}

// ---------------------------------------------------------------- pictures: drawn from numbers, nothing filmed

function png(width, height, rgb) {
  const crc = (() => {
    const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) { c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; } return c >>> 0; });
    return b => { let c = 0xFFFFFFFF; for (const x of b) { c = table[(c ^ x) & 255] ^ (c >>> 8); } return (c ^ 0xFFFFFFFF) >>> 0; };
  })();
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), size = Buffer.alloc(4), sum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([size, body, sum]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8;
  head[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) { rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function hsl(h, sat, l) {
  const c = (1 - Math.abs(2 * l - 1)) * sat, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

const mixInto = (c, to, a) => { c[0] += (to[0] - c[0]) * a; c[1] += (to[1] - c[1]) * a; c[2] += (to[2] - c[2]) * a; };
const edge = (d, soft) => { const t = Math.max(0, Math.min(1, .5 - d / (2 * soft))); return t * t * (3 - 2 * t); };
const W = 320, H = 180;

// One clip's picture. Its scores decide how it looks: soft clips are soft, dark clips dark, log clips flat and lifted.
function picture(rec) {
  const plan = rec.plan, r = random(plan.seed), hue = plan.hue, sat = plan.neutral ? .05 : plan.sat, rnd = () => r();
  const sharp = rec.tier1.sharpness === null ? .5 : rec.tier1.sharpness;
  const soft = .004 + (1 - sharp) ** 2.4 * .1;
  const light = .62 + rec.tier1.luma * .9, sx = rnd() * .4 + .3, sy = rnd() * .3 + .12;
  const a1 = rnd() * 6, a2 = rnd() * 6, a3 = rnd() * 6, f1 = 3 + rnd() * 4, f2 = 7 + rnd() * 6;
  const discs = Array.from({ length: 11 }, () => ({ x: rnd(), y: rnd() * .9, r: .04 + rnd() * .1, c: hsl((hue + (rnd() - .5) * 70 + 360) % 360, Math.min(1, sat + .2), .55 + rnd() * .2), a: .35 + rnd() * .5 }));
  const objects = Array.from({ length: 3 }, (_, i) => ({ x: .22 + i * .27 + rnd() * .08, w: .07 + rnd() * .06, h: .16 + rnd() * .16, c: hsl((hue + (rnd() - .5) * 40 + 360) % 360, sat * .8, .3 + rnd() * .35) }));
  const shot = plan.shot || 'medium', head = { closeup: .15, medium: .075, wide: .026 }[shot], figX = .3 + rnd() * .4;
  const figY = { closeup: .34, medium: .36, wide: .62 }[shot] * H / W;
  const skin = hsl((hue + 350) % 360, sat * .7, .2 + rnd() * .1), top = hsl(hue, sat, .68), low = hsl((hue + 16) % 360, Math.min(1, sat * 1.1), .4), deep = hsl((hue + 340) % 360, sat * .9, .16);
  const rgb = Buffer.alloc(W * H * 3), c = [0, 0, 0], aspect = H / W;
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1);
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      const k = plan.kind;
      if (k === 'ridge' || k === 'sea') {
        const g = Math.min(1, v * 1.5);
        c[0] = top[0] + (low[0] - top[0]) * g; c[1] = top[1] + (low[1] - top[1]) * g; c[2] = top[2] + (low[2] - top[2]) * g;
        const dx = (u - sx) , dy = (v - sy) * aspect;
        mixInto(c, [255, 244, 222], edge(Math.sqrt(dx * dx + dy * dy) - .05, soft + .012) * .92);
        mixInto(c, [255, 236, 200], Math.max(0, .34 - Math.sqrt(dx * dx + dy * dy)) * .9);
        if (k === 'ridge') {
          for (let n = 0; n < 3; n++) {
            const base = .52 + n * .16 + Math.sin(u * f1 + a1 + n * 2.1) * .06 + Math.sin(u * f2 + a2 + n) * .025;
            const t = (n + 1) / 3;
            mixInto(c, [low[0] + (deep[0] - low[0]) * t, low[1] + (deep[1] - low[1]) * t, low[2] + (deep[2] - low[2]) * t], edge(base - v, soft + .004));
          }
        } else {
          const w = edge(.58 - v, soft + .003);
          const ripple = .5 + .5 * Math.sin(v * 90 + Math.sin(u * 14 + a1) * 1.6 + a2);
          mixInto(c, [low[0] * .78 + deep[0] * .22 + ripple * 16, low[1] * .78 + deep[1] * .22 + ripple * 16, low[2] * .78 + deep[2] * .22 + ripple * 16], w);
          mixInto(c, [255, 240, 214], w * Math.max(0, 1 - Math.abs(u - sx) * 9) * (.3 + ripple * .5));
          mixInto(c, [24, 26, 30], edge(Math.max(Math.abs(u - .55 - a3 * .03) - .1, Math.abs(v - .61) - .007), soft + .002));
        }
      } else if (k === 'bokeh') {
        c[0] = deep[0] * .5; c[1] = deep[1] * .5; c[2] = deep[2] * .5;
        for (const d of discs) {
          const dx = u - d.x, dy = (v - d.y) * aspect;
          const e = edge(Math.sqrt(dx * dx + dy * dy) - d.r, soft + .008) * d.a;
          c[0] += d.c[0] * e * .5; c[1] += d.c[1] * e * .5; c[2] += d.c[2] * e * .5;
        }
      } else if (k === 'cloth') {
        const t = .5 + .5 * Math.sin((u * 3 + v * 2.2) * 2 + Math.sin(v * 3.4 + a1) * 1.3 + a2);
        c[0] = low[0] + (top[0] - low[0]) * t * .7; c[1] = low[1] + (top[1] - low[1]) * t * .7; c[2] = low[2] + (top[2] - low[2]) * t * .7;
        mixInto(c, deep, Math.max(0, .42 - t) * 1.1);
      } else {
        const g = v * .8 + Math.abs(u - .5) * .35;
        c[0] = top[0] + (low[0] - top[0]) * g; c[1] = top[1] + (low[1] - top[1]) * g; c[2] = top[2] + (low[2] - top[2]) * g;
        if (k === 'interior') {
          mixInto(c, [255, 240, 214], edge(Math.max(Math.abs(u - sx) - .13, Math.abs(v - .3) - .19), soft + .02) * .55);
          mixInto(c, top, edge(Math.min(Math.abs(u - sx), Math.abs(v - .3)) - .006, soft + .002) * .5);
          mixInto(c, deep, edge(.74 - v, soft + .003));
          for (const o of objects) {
            const dy = (v - (.74 - o.h / 2)) / (o.h / 2), dx = (u - o.x) / o.w;
            mixInto(c, o.c, edge(Math.sqrt(dx * dx + dy * dy) - 1, (soft + .004) * 6));
          }
        } else {
          const dx = u - figX, Y = v * aspect, hd = Math.sqrt(dx * dx + (Y - figY) * (Y - figY)) - head;
          const bw = dx / (head * 2.3), bh = (Y - figY - head * 3.3) / (head * 2.4), body = (Math.sqrt(bw * bw + bh * bh) - 1) * head * 2;
          const shape = Math.min(hd, body);
          mixInto(c, [255, 244, 224], edge(shape - .03, soft + .03) * .22);
          mixInto(c, deep, edge(body, soft + .004));
          mixInto(c, skin, edge(hd, soft + .004));
        }
      }
      const fall = 1 - ((u - .5) * (u - .5) + (v - .5) * (v - .5)) * .5;
      for (let q = 0; q < 3; q++) {
        let val = c[q] * light * fall;
        if (plan.log) { const grey = (c[0] + c[1] + c[2]) / 3 * light * fall; val = 58 + (grey + (val - grey) * .22) * .46; }
        rgb[(y * W + x) * 3 + q] = Math.max(0, Math.min(255, val));
      }
    }
  }
  return rgb;
}

// The palette a clip really has: the commonest coarse colours in its picture, strongest first and kept apart.
function paletteOf(rgb) {
  const counts = new Map();
  for (let p = 0; p < rgb.length; p += 12) {
    const k = (rgb[p] >> 3) << 10 | (rgb[p + 1] >> 3) << 5 | rgb[p + 2] >> 3;
    const e = counts.get(k) || [0, 0, 0, 0];
    e[0] += rgb[p]; e[1] += rgb[p + 1]; e[2] += rgb[p + 2]; e[3]++;
    counts.set(k, e);
  }
  const kept = [];
  for (const e of [...counts.values()].sort((a, b) => b[3] - a[3])) {
    const c = [e[0] / e[3], e[1] / e[3], e[2] / e[3]];
    if (kept.every(k => Math.abs(k[0] - c[0]) + Math.abs(k[1] - c[1]) + Math.abs(k[2] - c[2]) > 54)) { kept.push(c); }
    if (kept.length === 5) { break; }
  }
  return kept.map(c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join(''));
}

function drawn(rec) { return rec.tier1 && !rec.tier1.reason; }

function buildThumbs(records, dir) {
  fs.mkdirSync(dir, { recursive: true });
  let made = 0;
  for (const rec of records) {
    if (!drawn(rec)) { continue; }
    const rgb = picture(rec);
    if (rec.tier2 && rec.tier2.moments) { rec.tier2.palette = paletteOf(rgb); }
    fs.writeFileSync(path.join(dir, rec.index + '.png'), png(W, H, rgb));
    made++;
  }
  return made;
}

const FIXTURE = path.join(__dirname, 'fixtures/clips.jsonl');
const THUMBS = path.join(__dirname, 'out/thumbs');

// The pictures are generated, so they stay out of the repo. Anything that shows them calls this first.
function ensureThumbs() {
  if (fs.existsSync(path.join(THUMBS, '0.png'))) { return THUMBS; }
  buildThumbs(fs.readFileSync(FIXTURE, 'utf8').trim().split('\n').map(l => JSON.parse(l)), THUMBS);
  return THUMBS;
}

if (require.main === module) {
  const records = build(), t0 = Date.now(), made = buildThumbs(records, THUMBS);
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(`${records.length} clips, ${records.filter(r => r.error).length} unreadable, ${records.filter(r => r.tier1 && r.tier1.reason).length} with no picture -> ${FIXTURE}`);
  console.log(`${made} pictures in ${Date.now() - t0} ms -> ${THUMBS}`);
}

module.exports = { ensureThumbs, THUMBS };
