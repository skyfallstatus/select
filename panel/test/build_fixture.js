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

const SHOOTS = [
  { client: 'Lantern Bakery Co.', shoot: '22.10.26 Spring menu', scenes: [0, 1, 2] },
  { client: 'Lantern Bakery Co.', shoot: '02.09.26 Launch', scenes: [1, 2] },
  { client: 'Tidemark Rowing Club', shoot: '19.10.26 Regatta', scenes: [3, 4] },
  { client: 'Tidemark Rowing Club', shoot: '14.10.26 Crew', scenes: [3] },
  { client: 'Harbour Street Ceramics', shoot: '08.10.26 Studio', scenes: [5] },
  { client: 'North Pier Coffee', shoot: '27.09.26 Roastery', scenes: [6] }
];
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
  let card = 82, clip = 148, shoot = SHOOTS[0], gear = CAMERAS[0], prevHash = null, prevScene = 0, nextFailed = 0;
  for (let i = 0; i < COUNT; i++) {
    if (i % 40 === 0) { shoot = SHOOTS[(i / 40) % SHOOTS.length]; gear = i % 120 === 80 ? CAMERAS[CAMERAS.length - 1] : weighted(rand, CAMERAS, c => c.weight); card++; clip += 3 + Math.floor(rand() * 30); }
    const base = `${VOLUME}/${shoot.client}/${shoot.shoot}/Footage`;
    if (i % 47 === 23 && nextFailed < UNREADABLE.length) {
      const bad = UNREADABLE[nextFailed++];
      out.push({ path: `${base}/${bad.folder}/A0${card}/${bad.name}`, index: i, scene: 0, error: bad.message });
      continue;
    }
    const scene = shoot.scenes[Math.floor(rand() * shoot.scenes.length)];
    const name = `C${String(clip++).padStart(4, '0')}.MP4`;
    const clipPath = `${base}/${gear.folder}/A0${card}/${name}`;
    const has = key => rand() >= RATE_OF[key];
    const [width, height] = weighted(rand, SIZES, s => s[2]);
    const durationS = round(along(SPREADS.durationS, rand()), 2), mbps = round(along(SPREADS.mbps, rand()), 1);
    const hasAudio = has('noAudio'), audioDb = hasAudio ? round(along(SPREADS.audioDb, rand()), 1) : null;
    let dhash = crypto.createHash('sha1').update(clipPath).digest('hex').slice(0, 16), look = i;
    if (i % 11 === 0) { prevHash = dhash; prevScene = scene; }
    if (i % 11 === 1 || i % 11 === 2) { dhash = flip(prevHash, 2 + i % 11); look = i - i % 11; }     // groups of three, 3 or 4 bits apart
    const bit = weighted(rand, BITS, b => b[1])[0];
    const clipHigh = round(along(SPREADS.clipHighPct, rand()), 2), clipLow = round(along(SPREADS.clipLowPct, rand()), 2);
    const blank = i % 61 === 40;
    out.push({
      path: clipPath, index: i, scene: i % 11 === 1 || i % 11 === 2 ? prevScene : scene, look,
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
        }
    });
  }
  return out;
}

// ---------------------------------------------------------------- pictures: soft shapes on a gradient, nothing filmed

const SCENES = [
  { top: [226, 196, 150], bottom: [150, 104, 62], shapes: [[.2, .62, .17, .13, [140, 84, 40]], [.5, .6, .17, .14, [176, 112, 54]], [.8, .63, .16, .12, [130, 78, 40]], [.34, .36, .15, .1, [190, 130, 66]], [.66, .36, .15, .1, [158, 98, 48]]] },
  { top: [58, 46, 40], bottom: [28, 22, 20], shapes: [[.68, .4, .2, .32, [244, 218, 170]], [.3, .76, .34, .1, [120, 80, 50]], [.3, .6, .1, .12, [214, 170, 110]]] },
  { top: [234, 226, 212], bottom: [196, 182, 160], shapes: [[.5, .56, .28, .25, [244, 232, 208]], [.46, .5, .11, .08, [252, 244, 228]], [.8, .24, .12, .08, [170, 136, 100]]] },
  { top: [180, 206, 224], bottom: [70, 112, 138], shapes: [[.5, .56, .62, .02, [36, 44, 54]], [.34, .5, .06, .05, [226, 92, 66]], [.62, .5, .06, .05, [226, 92, 66]], [.8, .18, .1, .07, [244, 240, 230]]] },
  { top: [116, 164, 190], bottom: [38, 84, 112], shapes: [[.5, .3, .7, .006, [232, 238, 240]], [.5, .52, .7, .006, [232, 238, 240]], [.5, .74, .7, .006, [232, 238, 240]], [.28, .4, .1, .02, [30, 34, 40]], [.7, .64, .1, .02, [230, 196, 70]]] },
  { top: [196, 140, 112], bottom: [128, 80, 62], shapes: [[.3, .56, .1, .26, [232, 220, 200]], [.52, .62, .13, .2, [84, 104, 112]], [.74, .58, .09, .24, [214, 170, 126]], [.5, .9, .6, .08, [90, 58, 44]]] },
  { top: [66, 50, 42], bottom: [34, 24, 20], shapes: [[.28, .6, .2, .26, [132, 104, 76]], [.66, .54, .24, .3, [166, 132, 92]], [.86, .26, .08, .1, [226, 170, 92]], [.5, .92, .5, .06, [18, 14, 12]]] }
];

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

// A clip's picture follows its scores, so soft clips look soft and dark clips look dark when a sort puts them on top.
function picture(rec) {
  const W = 160, H = 90, scene = SCENES[rec.scene], rand = random(rec.look * 7919 + 13);
  const sharp = rec.tier1.sharpness === null ? .5 : rec.tier1.sharpness;
  const blur = .006 + (1 - sharp) ** 2.4 * .2;      // a high score looks sharp, a low one looks soft
  const light = .35 + rec.tier1.luma * 1.55, shiftX = (rand() - .5) * .16, shiftY = (rand() - .5) * .1, zoom = .92 + rand() * .3;
  const rgb = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1);
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      const c = [0, 1, 2].map(k => scene.top[k] + (scene.bottom[k] - scene.top[k]) * v);
      for (const [cx, cy, rx, ry, color] of scene.shapes) {
        const dx = ((u - .5) / zoom + .5 - cx - shiftX) / rx, dy = ((v - .5) / zoom + .5 - cy - shiftY) / ry;
        const edge = Math.sqrt(dx * dx + dy * dy) - 1;
        const reach = blur / Math.min(rx, ry) + .015;
        const t = Math.max(0, Math.min(1, .5 - edge / (2 * reach)));
        const a = t * t * (3 - 2 * t);
        for (let k = 0; k < 3; k++) { c[k] += (color[k] - c[k]) * a; }
      }
      for (let k = 0; k < 3; k++) { rgb[(y * W + x) * 3 + k] = Math.max(0, Math.min(255, c[k] * light)); }
    }
  }
  return png(W, H, rgb);
}

function buildThumbs(records, dir) {
  fs.mkdirSync(dir, { recursive: true });
  let made = 0;
  for (const rec of records) {
    if (!rec.tier1 || rec.tier1.reason) { continue; }
    fs.writeFileSync(path.join(dir, rec.index + '.png'), picture(rec));
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
  const records = build();
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const t0 = Date.now(), made = buildThumbs(records, THUMBS);
  console.log(`${records.length} clips, ${records.filter(r => r.error).length} unreadable, ${records.filter(r => r.tier1 && r.tier1.reason).length} with no picture -> ${FIXTURE}`);
  console.log(`${made} pictures in ${Date.now() - t0} ms -> ${THUMBS}`);
}

module.exports = { ensureThumbs, THUMBS };
