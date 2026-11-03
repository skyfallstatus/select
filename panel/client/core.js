// Select panel logic with no DOM and no Node dependency. Loaded by the panel and by the tests.
(function (root, factory) {
  var api = factory();
  root.SelectCore = api;
  if (typeof module === 'object' && module && module.exports) { module.exports = api; }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // Clips a near-duplicate group's members may differ from its first clip by, in dhash bits out of 64.
  var NEAR_DUP_BITS = 8;
  // Interviews keeps clips in the steadier share of the scan, among those whose shake is known.
  var STEADY_SHARE = 0.6;
  // Below this a clip's colour is too flat to sit among vivid clips in the rainbow.
  var MUTED_CHROMA = 0.15;

  // ---------------------------------------------------------------- formatting: null is always an empty cell

  function fixed(n) {
    return function (v) { return v === null || v === undefined || v !== v ? '' : Number(v).toFixed(n); };
  }

  function fmtDuration(v) {
    if (v === null || v === undefined || v !== v) { return ''; }
    var s = Number(v), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var ss = sec.toFixed(1);
    if (sec < 10) { ss = '0' + ss; }
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + ss;
  }

  function fmtDate(v) {
    return v ? String(v).slice(0, 16).replace('T', ' ') : '';
  }

  function fmtText(v) { return v === null || v === undefined ? '' : String(v); }

  function fmtCount(v) { return typeof v === 'number' ? String(v) : ''; }

  function fmtShutter(v) {
    if (typeof v !== 'number' || !(v > 0)) { return ''; }
    return v >= 0.3 ? v.toFixed(1) + ' s' : '1/' + Math.round(1 / v);
  }

  function fmtAperture(v) { return typeof v === 'number' ? 'f/' + (v % 1 ? v.toFixed(1) : v) : ''; }

  var SHOT_WORD = { closeup: 'Close-up', medium: 'Medium', wide: 'Wide' };
  var SHOT_RANK = { closeup: 0, medium: 1, wide: 2 };

  function fmtShot(v) { return SHOT_WORD[v] || ''; }

  function fmtColour(v) { return v ? v.charAt(0).toUpperCase() + v.slice(1) : ''; }

  // ---------------------------------------------------------------- columns

  // words: bucket names from the highest values to the lowest, for "Sort into Bins" and the foot's verdict.
  // hidden: off by default, switchable from the menu. A hidden column still shows while the view sorts by it.
  var COLUMNS = [
    { key: 'thumb', label: '', width: 74, kind: 'thumb', sortable: false, fixed: true },
    { key: 'name', label: 'Name', width: 120, kind: 'text', grow: true, fixed: true, tip: 'File name.' },
    { key: 'dupGroup', label: 'Group', width: 48, kind: 'number', fmt: fmtText, onlyWithGroups: true, fixed: true, tip: 'Near-duplicate group.' },
    { key: 'durationS', label: 'Duration', width: 66, kind: 'number', fmt: fmtDuration, words: ['Longest', 'Longer', 'Middle', 'Shorter', 'Shortest'], tip: 'Duration.' },
    { key: 'sharpness', label: 'Sharpness', width: 72, kind: 'number', fmt: fixed(3), words: ['Sharpest', 'Sharper', 'Middle', 'Softer', 'Softest'],
      tip: 'Fine detail in the sharpest tiles of one decoded moment, at native resolution, normalised by local contrast. It compares clips; it says nothing about the rest of the take.' },
    { key: 'luma', label: 'Brightness', width: 74, kind: 'number', fmt: fixed(2), words: ['Brightest', 'Brighter', 'Middle', 'Darker', 'Darkest'], tip: 'Mean luma of one decoded moment, 0 to 1. Log footage reads differently from graded footage.' },
    { key: 'motionProxy', label: 'Motion', width: 58, kind: 'number', fmt: fixed(3), words: ['Most motion', 'More motion', 'Middle', 'Less motion', 'Least motion'], tip: 'Spread of compressed frame sizes along the clip, 0 to 1. A stand-in for motion read from the file structure; no pixels are decoded.' },
    { key: 'audioDb', label: 'Audio', width: 56, kind: 'number', fmt: fixed(1), words: ['Loudest', 'Louder', 'Middle', 'Quieter', 'Quietest'], tip: 'Mean level in dB from sampled windows, not a full read. Empty when the clip has no audio or none could be read.' },
    { key: 'createdAt', label: 'Date', width: 132, kind: 'date', fmt: fmtDate, words: ['Latest', 'Later', 'Middle', 'Earlier', 'Earliest'], tip: 'Camera time when present.' },
    { key: 'camera', label: 'Camera', width: 112, kind: 'text', tip: 'Maker and model.' },
    { key: 'colorName', label: 'Colour', width: 72, kind: 'color', fmt: fmtColour, sortKey: 'rainbow', natural: 1, category: 'colour', named: ['Colour', 'Colour reversed'], says: ['Rainbow order, neutral clips last.', 'Rainbow order reversed, neutral clips first.'],
      tip: 'The dominant colours of up to three frames, strongest first. S-Log3 that the camera names is turned back into normal colour before it is measured. Hover for the family. It describes the picture, nothing more.' },
    { key: 'clipHighPct', label: 'Highlights', width: 62, kind: 'number', hidden: true, fmt: fixed(2), words: ['Most clipped', 'More clipped', 'Middle', 'Less clipped', 'Least clipped'], tip: 'Percent of pixels at the top extreme, in one decoded moment.' },
    { key: 'clipLowPct', label: 'Shadows', width: 58, kind: 'number', hidden: true, fmt: fixed(2), words: ['Most crushed', 'More crushed', 'Middle', 'Less crushed', 'Least crushed'], tip: 'Percent of pixels at the bottom extreme, in one decoded moment.' },
    { key: 'lens', label: 'Lens', width: 130, kind: 'text', hidden: true, tip: 'From embedded metadata or the Sony sidecar.' },
    { key: 'codec', label: 'Codec', width: 60, kind: 'text', hidden: true },
    { key: 'pixels', label: 'Resolution', width: 84, kind: 'number', hidden: true, fmt: null, tip: 'Display size after rotation.' },
    { key: 'people', label: 'People', width: 52, kind: 'number', hidden: true, fmt: fmtCount, words: ['Most people', 'More people', 'Middle', 'Fewer people', 'Fewest people'], tip: 'The most people seen in any one moment read. A count of bodies in the frame, not who they are.' },
    { key: 'faces', label: 'Faces', width: 48, kind: 'number', hidden: true, fmt: fmtCount, words: ['Most faces', 'More faces', 'Middle', 'Fewer faces', 'Fewest faces'], tip: 'The most faces seen in any one moment read. A count of faces, never who they are.' },
    { key: 'shotSize', label: 'Shot', width: 66, kind: 'text', hidden: true, fmt: fmtShot, sortKey: 'shotRank', natural: 1, category: 'shot', named: ['Shot size', 'Shot size reversed'], says: ['Close-ups first, wides last.', 'Wides first, close-ups last.'], tip: 'From how tall a head is in the frame: a quarter of its height or more is a close-up, about an eighth or more is medium, smaller is wide. Blank when no one was seen.' },
    { key: 'soundText', label: 'Sound', width: 110, kind: 'text', hidden: true, tip: 'What the sampled audio sounds like, strongest first. Audio is sampled, not read in full.' },
    { key: 'screenText', label: 'Text', width: 120, kind: 'text', hidden: true, tip: 'Words of four letters or more read off up to three frames. About half of readable text is found, so a missing word proves nothing.' },
    { key: 'labelText', label: 'Labels', width: 170, kind: 'text', hidden: true, tip: 'What up to three frames seem to show, strongest first. A label is kept only where Apple rates it right at least three times in four. A suggestion, not a fact.' },
    { key: 'iso', label: 'ISO', width: 56, kind: 'number', hidden: true, fmt: fmtCount, tip: 'From the file, not estimated. Blank when the file has none.' },
    { key: 'shutterS', label: 'Shutter', width: 56, kind: 'number', hidden: true, fmt: fmtShutter, tip: 'Exposure time from the file. Blank when the file has none.' },
    { key: 'aperture', label: 'Aperture', width: 60, kind: 'number', hidden: true, fmt: fmtAperture, tip: 'F-number from the file. Blank when the file has none.' },
    { key: 'shake', label: 'Shake', width: 52, kind: 'number', hidden: true, fmt: fixed(3), words: ['Shakiest', 'Shakier', 'Middle', 'Steadier', 'Steadiest'], tip: 'Camera movement from the gyro in the file, 0 to 1 on a log scale: a tripod reads low, handheld higher, a whip pan near the top. A steady pan does not count. Blank when the file has no gyro data.' }
  ];
  var COLUMN = {};
  COLUMNS.forEach(function (c) { COLUMN[c.key] = c; });

  function cellText(row, col) {
    if (col.key === 'pixels') { return row.width && row.height ? row.width + 'x' + row.height : ''; }
    var v = col.key === 'createdAt' ? row.createdAt : row[col.key];
    return (col.fmt || fmtText)(v);
  }

  // ---------------------------------------------------------------- JSON Lines

  // Feed it decoded text in any chunk sizes. Each complete line goes to onLine, a line that is not JSON to onBad.
  function JsonlParser(onLine, onBad) {
    this.buf = '';
    this.onLine = onLine;
    this.onBad = onBad || function () {};
  }
  JsonlParser.prototype.push = function (text) {
    var buf = this.buf ? this.buf + text : text, start = 0, nl;
    while ((nl = buf.indexOf('\n', start)) !== -1) {
      this.line(buf.slice(start, nl));
      start = nl + 1;
    }
    this.buf = start ? buf.slice(start) : buf;
  };
  JsonlParser.prototype.line = function (line) {
    if (line.charCodeAt(line.length - 1) === 13) { line = line.slice(0, -1); }
    if (!line) { return; }
    var msg;
    try { msg = JSON.parse(line); } catch (e) { this.onBad(line); return; }
    this.onLine(msg);
  };
  JsonlParser.prototype.flush = function () {
    var rest = this.buf;
    this.buf = '';
    if (rest) { this.line(rest); }
  };

  // ---------------------------------------------------------------- the store

  function pathKey(p) { return String(p).normalize('NFC'); }

  function baseName(p) { return String(p).slice(String(p).lastIndexOf('/') + 1); }

  function createStore() {
    return { rows: [], byKey: new Map(), total: 0, tier0: 0, tier1: 0, errors: 0, cached: 0, bad: 0, start: null, done: null, noPicture: { clips: 0, noDecoder: 0, noFfmpeg: 0 }, tier2: 0, tier2Failed: 0, groups: null };
  }

  function addRow(store, path) {
    var key = pathKey(path), row = store.byKey.get(key);
    if (row) { return row; }
    row = { rowId: store.rows.length, path: path, key: key, name: baseName(path), ids: [], tier: -1, error: null, time: NaN };
    store.rows.push(row);
    store.byKey.set(key, row);
    return row;
  }

  // Rows appear as soon as the paths are known, before the engine says anything.
  function addItems(store, items) {
    for (var i = 0; i < items.length; i++) {
      var row = addRow(store, items[i].path);
      if (items[i].id && row.ids.indexOf(items[i].id) === -1) { row.ids.push(items[i].id); }
    }
    store.total = store.rows.length;
  }

  var ENVELOPE = { type: 1, tier: 1, path: 1, cached: 1, ms: 1 };

  // What Tier 2 sends as lists, kept as words so they sort, show and search like any other value. Null stays null.
  function namesOf(list, most) {
    if (!list) { return null; }
    return list.slice(0, most).map(function (x) { return typeof x === 'string' ? x : x.name; }).join(', ');
  }

  function settleTier2(row) {
    row.rainbow = rainbowKey(row);
    row.shotRank = row.shotSize in SHOT_RANK ? SHOT_RANK[row.shotSize] : null;
    row.labelText = namesOf(row.labels, 12);
    row.soundText = namesOf(row.sounds, 6);
    row.screenText = namesOf(row.text, 12);
  }

  // A clip with good file details and no decoded frame. It is not an error: its Tier 0 data stands, its picture scores
  // are blank, and the engine says why in `reason`.
  function countNoPicture(tally, reason) {
    tally.clips++;
    if (/no decoder/i.test(reason)) { tally.noDecoder++; }
    if (/ffmpeg isn't installed|ff(mpeg|probe) not found/i.test(reason)) { tally.noFfmpeg++; }
  }

  // Returns true when the line changed a row.
  function ingest(store, msg) {
    switch (msg.type) {
      case 'start':
        store.start = msg;
        return false;
      case 'done':
        store.done = msg;
        return false;
      case 'groups': {
        // Similar shots, once, after every Tier 2 line. A clip outside the list has no group.
        store.groups = msg.groups || [];
        store.groups.forEach(function (g) {
          (g.paths || []).forEach(function (p) {
            var member = store.byKey.get(pathKey(p));
            if (member) { member.similar = g.id; member.version = (member.version || 0) + 1; }
          });
        });
        return true;
      }
      case 'error': {
        if (!msg.path) { return false; }
        var bad = addRow(store, msg.path);
        // Tier 2 failing never touches what Tiers 0 and 1 found: the row stays good, only its understanding is missing.
        if (msg.tier === 2 || bad.tier === 1) {
          if (!bad.notUnderstood) { store.tier2Failed++; }
          bad.notUnderstood = true;
          bad.version = (bad.version || 0) + 1;
          return true;
        }
        if (bad.error === null) { store.errors++; }
        bad.error = msg.message === undefined ? 'unknown error' : String(msg.message);
        bad.version = (bad.version || 0) + 1;
        return true;
      }
      case 'clip': {
        if (!msg.path) { return false; }
        var row = addRow(store, msg.path), counted = !!row.reason, t2 = msg.tier === 2;
        for (var k in msg) {
          // Tier 2's reason is about looking closer, and Tier 1's about the picture, so they never share a field.
          if (!ENVELOPE[k] && !(t2 && k === 'reason')) { row[k] = msg[k]; }
        }
        if (msg.reason && !counted && !t2) { countNoPicture(store.noPicture, msg.reason); }
        row.version = (row.version || 0) + 1;
        if (msg.tier === 2) {
          // The engine reports a clip it could not look at as a line with no moments. A clip with no picture has already
          // been explained, so it does not count twice.
          if (msg.reason) { row.lookReason = String(msg.reason); }
          if ((msg.moments === 0 || msg.reason) && !row.reason) {
            if (!row.notUnderstood && !row.understood) { store.tier2Failed++; }
            row.notUnderstood = true;
          } else if (!row.understood && !row.notUnderstood) {
            store.tier2++;
          }
          row.understood = true;
          settleTier2(row);
          return true;
        }
        if (msg.tier === 1) {
          store.tier1++;
          row.tier = 1;
          if (msg.cached) { store.cached++; }
        } else {
          store.tier0++;
          if (row.tier < 0) { row.tier = 0; }
        }
        if (msg.width && msg.height) { row.pixels = msg.width * msg.height; }
        if ('createdAt' in msg) {
          var t = msg.createdAt ? Date.parse(msg.createdAt) : NaN;
          row.time = t;
        }
        return true;
      }
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------- sorting

  var collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

  function isText(col) { return col.kind === 'text' && !col.sortKey; }

  // spec: [{key, dir}], dir 1 ascending or -1 descending. Empty values go last in both directions, and equal rows
  // keep their scan order, so a sort is stable and repeatable.
  function sortOrder(rows, order, spec) {
    if (!spec.length) { return order; }
    var n = rows.length, keys = [], s, c, i, r;
    for (s = 0; s < spec.length; s++) {
      c = COLUMN[spec[s].key];
      if (isText(c)) {
        var strs = new Array(n);
        for (i = 0; i < n; i++) {
          r = rows[i][c.key];
          strs[i] = r === null || r === undefined || r === '' ? null : String(r);
        }
        keys.push({ text: true, vals: strs, dir: spec[s].dir });
      } else {
        var nums = new Float64Array(n), field = c.sortKey || (c.kind === 'date' ? 'time' : c.key);
        for (i = 0; i < n; i++) {
          r = rows[i][field];
          nums[i] = r === null || r === undefined ? NaN : Number(r);
        }
        keys.push({ text: false, vals: nums, dir: spec[s].dir });
      }
    }
    var k0 = keys.length;
    return order.sort(function (a, b) {
      for (var j = 0; j < k0; j++) {
        var K = keys[j], x = K.vals[a], y = K.vals[b];
        if (K.text) {
          if (x === null || y === null) {
            if (x === y) { continue; }
            return x === null ? 1 : -1;
          }
          var d = collator.compare(x, y);
          if (d) { return d * K.dir; }
        } else {
          var xn = x !== x, yn = y !== y;
          if (xn || yn) {
            if (xn && yn) { continue; }
            return xn ? 1 : -1;
          }
          if (x !== y) { return (x < y ? -1 : 1) * K.dir; }
        }
      }
      return a - b;
    });
  }

  // ---------------------------------------------------------------- near duplicates

  function popcount32(v) {
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }

  function parseHash(hex) {
    if (typeof hex !== 'string' || !/^[0-9a-fA-F]{1,16}$/.test(hex)) { return null; }
    var padded = ('0000000000000000' + hex).slice(-16);
    return [parseInt(padded.slice(0, 8), 16) | 0, parseInt(padded.slice(8), 16) | 0];
  }

  function hamming(a, b) {
    var x = parseHash(a), y = parseHash(b);
    if (!x || !y) { return null; }
    return popcount32(x[0] ^ y[0]) + popcount32(x[1] ^ y[1]);
  }

  // Greedy: the first clip in scan order that is not yet taken opens a group, and every free clip within
  // NEAR_DUP_BITS of that first clip joins it. No chaining, so one group cannot drift across a whole shoot.
  // Returns [[rowIndex, ...], ...], groups of two or more.
  function nearDuplicateGroups(rows, bits) {
    var limit = bits === undefined ? NEAR_DUP_BITS : bits, list = [], i, j;
    for (i = 0; i < rows.length; i++) {
      var h = parseHash(rows[i].dhash);
      if (h) { list.push({ i: i, hi: h[0], lo: h[1], taken: false }); }
    }
    var groups = [];
    for (i = 0; i < list.length; i++) {
      var a = list[i];
      if (a.taken) { continue; }
      var group = null;
      for (j = i + 1; j < list.length; j++) {
        var b = list[j];
        if (b.taken) { continue; }
        if (popcount32(a.hi ^ b.hi) + popcount32(a.lo ^ b.lo) <= limit) {
          if (!group) { group = [a.i]; a.taken = true; }
          group.push(b.i);
          b.taken = true;
        }
      }
      if (group) { groups.push(group); }
    }
    return groups;
  }

  // ---------------------------------------------------------------- presets

  function S(key, dir) { return { key: key, dir: dir }; }

  // Every preset is a visible sort, a visible filter or both, and each tip says what it really measures.
  // says: the foot's plain words about the view. Relative, never a verdict on a clip.
  var PRESETS = [
    { id: 'softest', label: 'Softest first', sort: [S('sharpness', 1)], says: 'Softest at the top.',
      tip: 'Sorts by the Sharpness score, lowest first. It scores one decoded moment per clip, so a clip can read soft here and be fine elsewhere, and plain subjects with little fine detail score low too. A heuristic for where to look first.' },
    { id: 'sharpest', label: 'Sharpest first', sort: [S('sharpness', -1)], says: 'Sharpest at the top.',
      tip: 'Sorts by the Sharpness score, highest first. It scores the sharpest tiles of one decoded moment per clip, not whether the focus landed on what matters.' },
    { id: 'darkest', label: 'Darkest', sort: [S('luma', 1)], says: 'Darkest at the top.',
      tip: 'Sorts by mean luma of one decoded moment, lowest first. Log footage and night scenes sit low by design.' },
    { id: 'overexposed', label: 'Most clipped', sort: [S('clipHighPct', -1), S('luma', -1)], says: 'Most clipped highlights at the top.',
      tip: 'Sorts by the percent of pixels at the top extreme in one decoded moment, then by luma. It measures clipping in that frame only. A window or a lamp can account for all of it.' },
    { id: 'motion', label: 'Most motion', sort: [S('motionProxy', -1)], says: 'Most motion at the top.',
      tip: 'Sorts by the spread of compressed frame sizes along the clip. That stands in for motion, read from the file structure, so complex detail or a change of light can read as motion too.' },
    { id: 'static', label: 'Static', sort: [S('motionProxy', 1)], says: 'Least motion at the top.',
      tip: 'Sorts by the spread of compressed frame sizes, lowest first. Likely tripod or locked-off shots, not a guarantee. A subject can move inside a clip that reads as static.' },
    { id: 'silent', label: 'Silent', sort: [S('name', 1)], says: 'No audio track, or sampled audio reads as silent.',
      filter: function (r) { return r.hasAudio === false || r.silent === true; },
      tip: 'Shows clips with no audio track, or whose sampled windows read as silent. Audio is sampled, not read in full, so sound elsewhere in a clip can be missed. Clips with unknown audio are left out.' },
    { id: 'interviews', label: 'Interviews', sort: [S('durationS', -1)], says: 'Speech and a face, steadier where shake is known. Longest first.',
      needs: known('speech'), none: 'No clip has speech or face data yet, so this has nothing to go on.',
      prepare: steadyLimit,
      filter: function (r, limit) {
        return r.speech === true && r.faces > 0 && (typeof r.shake !== 'number' || limit === null || r.shake <= limit);
      },
      tip: 'Shows clips where speech was heard and a face was seen in the moments read, longest first. Where the file has gyro data, it keeps the steadier ones. Likely interviews, not a promise: a vlog passes too, and it does not know who is speaking.' },
    { id: 'people', label: 'People', sort: [S('people', -1)], says: 'Clips with people, the most people first.',
      needs: known('people'), none: 'No clip has people data, so this has nothing to go on.',
      filter: function (r) { return r.people > 0; },
      tip: 'Shows clips where people were seen, most first. People is the most seen in any one moment read. It counts bodies in up to three frames, and never says who they are.' },
    { id: 'nopeople', label: 'No people', sort: [S('name', 1)], says: 'No people seen in the moments read.', binAs: 'category', category: 'shot',
      needs: known('people'), none: 'No clip has people data, so this has nothing to go on.',
      filter: function (r) { return r.people === 0; },
      tip: 'Shows clips where no one was seen in the moments read, up to three per clip. Someone can appear between them. Clips with unknown people are left out.' },
    { id: 'shot', label: 'Shot size', sort: [S('shotSize', 1)], says: 'Close-ups first, wides last.',
      needs: known('shotSize'), none: 'No clip has shot size data, so this has nothing to go on.',
      tip: 'Sorts by how tall a head is in the frame, close-ups first. Blank when no one was seen, so scenery has no shot size here.' },
    { id: 'closeups', label: 'Close-ups', sort: [S('name', 1)], says: 'A face or body fills the frame.', category: 'shot',
      needs: known('shotSize'), none: 'No clip has shot size data, so this has nothing to go on.',
      filter: function (r) { return r.shotSize === 'closeup'; },
      tip: 'Shows clips where a head is at least a quarter of the frame tall in the moments read.' },
    { id: 'mediums', label: 'Mediums', sort: [S('name', 1)], says: 'A person from about the waist up.', category: 'shot',
      needs: known('shotSize'), none: 'No clip has shot size data, so this has nothing to go on.',
      filter: function (r) { return r.shotSize === 'medium'; },
      tip: 'Shows clips where a head is about an eighth to a quarter of the frame tall, or someone is cut off by the bottom of the frame.' },
    { id: 'wides', label: 'Wides', sort: [S('name', 1)], says: 'People small in the frame.', category: 'shot',
      needs: known('shotSize'), none: 'No clip has shot size data, so this has nothing to go on.',
      filter: function (r) { return r.shotSize === 'wide'; },
      tip: 'Shows clips where heads sit small in the frame. Scenery with no one in it has no shot size, so it is not here.' },
    { id: 'speech', label: 'Speech', sort: [S('durationS', -1)], says: 'Speech heard in the sampled audio. Longest first.',
      needs: known('speech'), none: 'No clip has sound data, so this has nothing to go on.',
      filter: function (r) { return r.speech === true; },
      tip: 'Shows clips where speech was heard in sampled windows of audio. It does not transcribe or know who is speaking, and speech elsewhere in a clip can be missed.' },
    { id: 'music', label: 'Music', sort: [S('durationS', -1)], says: 'Music heard in the sampled audio. Longest first.',
      needs: known('music'), none: 'No clip has sound data, so this has nothing to go on.',
      filter: function (r) { return r.music === true; },
      tip: 'Shows clips where music was heard in sampled windows of audio, so music elsewhere in a clip can be missed.' },
    { id: 'steadiest', label: 'Steadiest', sort: [S('shake', 1)], says: 'Least camera movement at the top. Clips with no gyro data last.',
      needs: known('shake'), none: 'No clip here has gyro data, so there is no shake to sort by.',
      tip: 'Sorts by camera movement from the gyro in the file, lowest first. A steady pan does not count as movement. Clips with no gyro data sit at the end, blank.' },
    { id: 'shakiest', label: 'Shakiest', sort: [S('shake', -1)], says: 'Most camera movement at the top. Clips with no gyro data last.',
      needs: known('shake'), none: 'No clip here has gyro data, so there is no shake to sort by.',
      tip: 'Sorts by camera movement from the gyro in the file, highest first. Handheld on purpose reads high too. Clips with no gyro data sit at the end, blank.' },
    { id: 'onscreen', label: 'Text on screen', sort: [S('name', 1)], says: 'Words were read off these frames.', binAs: 'one',
      needs: known('text'), none: 'No clip has text data, so this has nothing to go on.',
      filter: function (r) { return !!(r.text && r.text.length); },
      tip: 'Shows clips where words of four letters or more were read in the moments looked at: signs, packaging, slates. About half of readable text is found.' },
    { id: 'colour', label: 'Colour', sort: [S('colorName', 1)], says: 'Rainbow order, neutral clips last.', category: 'colour',
      needs: known('colorName'), none: 'No clip has colour data, so this has nothing to go on.',
      tip: 'Sorts by the hue of each clip\'s dominant colour, red round to pink, with neutral clips last from light to dark. It describes the picture and says nothing about whether the colour is right.' },
    { id: 'similar', label: 'Similar shots', group: 'engine', sort: [S('dupGroup', 1), S('name', 1)], says: 'Clips that look alike, kept together.',
      needs: function (r) { return r.similar !== undefined; }, none: 'No similar shots in this scan.', waiting: 'Similar shots arrive last, once every clip has been looked at.',
      tip: 'Groups clips whose frames look alike: their closest moments match and their average colours agree. Two takes of a set-up land together, and so can two similar places. Nothing here says which take to keep.' },
    { id: 'duplicates', label: 'Near duplicates', group: true, sort: [S('dupGroup', 1), S('sharpness', -1)], says: 'Similar frames grouped, sharpest first in each.',
      tip: 'Groups clips whose 64-bit frame hash differs by ' + NEAR_DUP_BITS + ' bits or fewer from the first clip of the group. It compares one moment per clip, so two takes of a set-up can match, and clips that differ only later do not.' },
    { id: 'shoot', label: 'Shoot order', sort: [S('createdAt', 1), S('name', 1)], says: 'Earliest at the top.',
      tip: 'Sorts by the creation time in the file, then by name. Clips with no date go last. It trusts the camera clock, and offloaded or re-exported files may carry another date.' }
  ];
  var PRESET = {};
  PRESETS.forEach(function (p) { PRESET[p.id] = p; });

  // How the sort row groups the presets, so a long list stays a short line. Colour and Shoot order stand alone.
  var GROUPS = [
    { id: 'people', label: 'People', presets: ['people', 'nopeople', 'shot', 'closeups', 'mediums', 'wides', 'interviews'] },
    { id: 'picture', label: 'Picture', presets: ['softest', 'sharpest', 'darkest', 'overexposed', 'onscreen'] },
    { id: 'motion', label: 'Motion', presets: ['motion', 'static', 'steadiest', 'shakiest'] },
    { id: 'sound', label: 'Sound', presets: ['speech', 'music', 'silent'] },
    { id: 'similar', label: 'Similar', presets: ['similar', 'duplicates'] }
  ];

  var FAMILIES = [
    { id: 'red', word: 'Red', dot: '#d9483b' }, { id: 'orange', word: 'Orange', dot: '#e8873a' }, { id: 'yellow', word: 'Yellow', dot: '#e3c24a' },
    { id: 'green', word: 'Green', dot: '#5aa65c' }, { id: 'teal', word: 'Teal', dot: '#35a79c' }, { id: 'blue', word: 'Blue', dot: '#3f83d6' },
    { id: 'purple', word: 'Purple', dot: '#8a63c9' }, { id: 'pink', word: 'Pink', dot: '#df6fa4' }, { id: 'neutral', word: 'Neutral', dot: '#9a9aa0' }
  ];
  var FAMILY = {};
  FAMILIES.forEach(function (f) { FAMILY[f.id] = f; });

  function known(key) {
    return function (r) { var v = r[key]; return v !== null && v !== undefined; };
  }

  // Hues are Oklab degrees, as the engine sends them: red starts at 20, and pink wraps across zero. Flat clips, such as log, run the spectrum again after the vivid
  // ones, so they keep their hue without breaking the bands. An all-log shoot is simply one muted rainbow.
  // Neutral clips follow every hue, from light to dark.
  function rainbowKey(r) {
    if (typeof r.colorHue === 'number' && r.colorName !== 'neutral') {
      return (r.colorHue + 340) % 360 + (typeof r.colorChroma === 'number' && r.colorChroma < MUTED_CHROMA ? 400 : 0);
    }
    return typeof r.colorLight === 'number' ? 800 + (1 - r.colorLight) : null;
  }

  function steadyLimit(rows) {
    var values = [];
    for (var i = 0; i < rows.length; i++) {
      if (typeof rows[i].shake === 'number') { values.push(rows[i].shake); }
    }
    if (!values.length) { return null; }
    values.sort(function (a, b) { return a - b; });
    return values[Math.max(0, Math.ceil(values.length * STEADY_SHARE) - 1)];
  }

  // ---------------------------------------------------------------- search

  function fold(s) {
    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\u0080-￿]+/g, ' ');
  }

  function searchParts(r) {
    var parts = [];
    (r.labels || []).forEach(function (l) { parts.push(l.name); });
    (r.text || []).forEach(function (t) { parts.push(t); });
    (r.sounds || []).forEach(function (l) { parts.push(l.name); });
    if (r.camera) { parts.push(r.camera); }
    if (r.lens) { parts.push(r.lens); }
    if (r.shotSize) { parts.push(SHOT_WORD[r.shotSize]); }
    if (r.colorName) { parts.push(fmtColour(r.colorName)); }
    return parts;
  }

  function hayOf(r) {
    if (r.hayVersion !== r.version || r.hay === undefined) {
      r.hay = ' ' + fold(searchParts(r).join(' ')) + ' ' + (r.shotSize === 'closeup' ? 'closeup ' : '');
      r.nameFold = fold(r.name).replace(/ /g, '');
      r.hayVersion = r.version;
    }
    return r.hay;
  }

  function searchTokens(query) {
    return fold(query || '').split(' ').filter(Boolean);
  }

  // Every word must match: anywhere in the file name, or at the start of a word in what the clip holds.
  function matches(r, tokens) {
    var hay = hayOf(r);
    for (var i = 0; i < tokens.length; i++) {
      if (r.nameFold.indexOf(tokens[i]) === -1 && hay.indexOf(' ' + tokens[i]) === -1) { return false; }
    }
    return true;
  }

  // The first thing a clip holds that a search matched, when it isn't the name: the reason it is on screen.
  function matchedWord(r, tokens) {
    if (!tokens.length) { return ''; }
    var parts = searchParts(r);
    for (var t = 0; t < tokens.length; t++) {
      if (r.nameFold !== undefined && r.nameFold.indexOf(tokens[t]) !== -1) { continue; }
      for (var i = 0; i < parts.length; i++) {
        if ((' ' + fold(parts[i])).indexOf(' ' + tokens[t]) !== -1) { return parts[i]; }
      }
    }
    return '';
  }

  // ---------------------------------------------------------------- the view

  // view: {sort, preset, family}. opts: {tokens} from a search. Returns row indexes to show, and where groups start.
  function computeView(rows, view, now, opts) {
    var clock = now || function () { return Date.now(); };
    var t0 = clock(), p = view.preset ? PRESET[view.preset] : null, order = [], i, j;
    var groupCount = 0, hasGroups = !!(p && p.group), breaks = [];
    var tokens = opts && opts.tokens && opts.tokens.length ? opts.tokens : null, family = view.family || null;
    var keeps = function (r) {
      return (!family || (r.colorName || null) === family) && (!tokens || matches(r, tokens));
    };
    for (i = 0; i < rows.length; i++) { rows[i].dupGroup = null; }
    if (hasGroups) {
      var groups = p.group === 'engine' ? engineGroups(rows) : nearDuplicateGroups(rows);
      for (i = 0; i < groups.length; i++) {
        var members = groups[i].filter(function (at) { return keeps(rows[at]); });
        if (!members.length) { continue; }
        groupCount++;
        for (j = 0; j < members.length; j++) {
          rows[members[j]].dupGroup = i + 1;
          order.push(members[j]);
        }
      }
    } else {
      var ctx = p && p.prepare ? p.prepare(rows) : null;
      for (i = 0; i < rows.length; i++) {
        if ((!p || !p.filter || p.filter(rows[i], ctx)) && keeps(rows[i])) { order.push(i); }
      }
    }
    sortOrder(rows, order, view.sort);
    if (hasGroups) {
      for (i = 0; i < order.length; i++) {
        var g = rows[order[i]].dupGroup;
        if (!breaks.length || breaks[breaks.length - 1].group !== g) { breaks.push({ at: i, group: g, count: 0, number: breaks.length + 1 }); }
        breaks[breaks.length - 1].count++;
      }
    }
    return { order: order, groupCount: groupCount, hasGroups: hasGroups, breaks: breaks, ms: clock() - t0 };
  }

  // The engine's groups, as row indexes, in the order it sent them.
  function engineGroups(rows) {
    var byId = new Map(), out = [];
    for (var i = 0; i < rows.length; i++) {
      var g = rows[i].similar;
      if (g === undefined) { continue; }
      if (!byId.has(g)) { byId.set(g, []); out.push(byId.get(g)); }
      byId.get(g).push(i);
    }
    return out;
  }

  // Has this preset anything to work with yet? ok, waiting (the engine may still send it) or none (it won't).
  function dataStatus(rows, id, running) {
    var p = id ? PRESET[id] : null;
    if (!p || !p.needs) { return 'ok'; }
    for (var i = 0; i < rows.length; i++) { if (p.needs(rows[i])) { return 'ok'; } }
    return running ? 'waiting' : 'none';
  }

  // How many clips a preset would show now, for the group menus. Null for a sort that keeps every clip.
  function presetCount(rows, id) {
    var p = PRESET[id];
    if (p.group === 'engine') { return engineGroups(rows).reduce(function (n, g) { return n + g.length; }, 0); }
    if (!p.filter) { return null; }
    var ctx = p.prepare ? p.prepare(rows) : null, n = 0;
    for (var i = 0; i < rows.length; i++) { if (p.filter(rows[i], ctx)) { n++; } }
    return n;
  }

  function familyCounts(rows) {
    var out = {};
    for (var i = 0; i < rows.length; i++) {
      var c = rows[i].colorName;
      if (c) { out[c] = (out[c] || 0) + 1; }
    }
    return out;
  }

  // The one useful fact on a tile: why it is here (a search), else what the view is about, else its length.
  function tileFact(row, view, tokens) {
    if (row.error) { return unreadableReason(row); }
    var hit = matchedWord(row, tokens || []);
    if (hit) { return hit; }
    var col = view.sort.length ? COLUMN[view.sort[0].key] : null;
    if (col && col.key !== 'name' && col.key !== 'dupGroup') {
      var text = cellText(row, col);
      return text || (row.reason ? 'No picture' : '');
    }
    return row.reason ? 'No picture' : cellText(row, COLUMN.durationS);
  }

  // One click sorts by that column, again flips it. Shift adds it as the next key, or flips it if already there.
  function nextSort(sort, key, shift) {
    var col = COLUMN[key], natural = col.natural || (col.kind === 'number' ? -1 : 1);
    var at = -1;
    for (var i = 0; i < sort.length; i++) { if (sort[i].key === key) { at = i; } }
    if (shift) {
      var copy = sort.map(function (s) { return { key: s.key, dir: s.dir }; });
      if (at >= 0) { copy[at].dir = -copy[at].dir; } else { copy.push({ key: key, dir: natural }); }
      return copy;
    }
    if (sort.length === 1 && at === 0) { return [{ key: key, dir: -sort[0].dir }]; }
    return [{ key: key, dir: natural }];
  }

  // The active sort in words: the foot's verdict and the name of the bin.
  function sortName(view) {
    var p = view.preset ? PRESET[view.preset] : null;
    if (p) { return p.label; }
    if (!view.sort.length) { return ''; }
    var s = view.sort[0], c = COLUMN[s.key];
    if (c.named) { return c.named[s.dir > 0 ? 0 : 1]; }
    if (c.words) { return c.words[s.dir > 0 ? 4 : 0] + ' first'; }
    if (c.key === 'pixels') { return s.dir > 0 ? 'Smallest first' : 'Largest first'; }
    return c.label + (s.dir > 0 ? ' A to Z' : ' Z to A');
  }

  function viewWords(view) {
    if (view.preset) { return PRESET[view.preset].says; }
    if (!view.sort.length) { return ''; }
    var s = view.sort[0], c = COLUMN[s.key];
    if (c.says) { return c.says[s.dir > 0 ? 0 : 1]; }
    if (c.words) { return c.words[s.dir > 0 ? 4 : 0] + ' at the top.'; }
    if (c.key === 'pixels') { return (s.dir > 0 ? 'Smallest' : 'Largest') + ' at the top.'; }
    return 'By ' + c.label.toLowerCase() + ', ' + (s.dir > 0 ? 'A to Z.' : 'Z to A.');
  }

  // ---------------------------------------------------------------- bins

  var FIFTHS = ['First fifth', 'Second fifth', 'Third fifth', 'Fourth fifth', 'Last fifth'];

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) { s = '0' + s; }
    return s;
  }

  function hasValue(row, col) {
    var v = col.kind === 'date' ? row.time : row[col.sortKey || col.key];
    return !(v === null || v === undefined || v === '' || v !== v);
  }

  // Sharpest to softest for a descending sort, softest to sharpest for an ascending one.
  function bucketNames(col, dir) {
    if (!col.words) { return FIFTHS.slice(); }
    var words = col.words.slice();
    if (dir > 0) { words.reverse(); }
    return words;
  }

  // What a categorical sort calls a clip, in the order its bins come. Null means no value.
  var CATEGORIES = {
    colour: { names: FAMILIES.map(function (f) { return f.word; }), of: function (r) { return FAMILY[r.colorName] ? FAMILY[r.colorName].word : null; } },
    shot: { names: ['Close-ups', 'Mediums', 'Wides', 'No people'], of: function (r) {
      if (r.shotSize in SHOT_RANK) { return ['Close-ups', 'Mediums', 'Wides'][SHOT_RANK[r.shotSize]]; }
      return r.people === 0 ? 'No people' : null;
    } }
  };

  // Numbered in the category's own order, so Red stays before Blue whatever order the rows are in.
  function categoryBuckets(rows, kind) {
    var cat = CATEGORIES[kind], found = new Map(), without = [], out = [];
    rows.forEach(function (r) {
      var name = cat.of(r);
      if (name === null) { without.push(r); return; }
      if (!found.has(name)) { found.set(name, []); }
      found.get(name).push(r);
    });
    cat.names.forEach(function (name) {
      if (found.has(name)) { out.push({ name: pad(out.length + 1, 2) + ' ' + name, rows: found.get(name) }); }
    });
    if (without.length) { out.push({ name: pad(out.length + 1, 2) + ' No value', rows: without }); }
    return out;
  }

  // rows in view order. Group views get one bin per group, categorical sorts one bin per category, and everything else
  // quintiles of the active sort, with clips that have no value for that sort kept apart. Returns [{name, rows}] or null.
  function bucketize(rows, view) {
    var buckets = [], i, p = view.preset ? PRESET[view.preset] : null;
    if (p && p.binAs === 'one') { return [{ name: '01 ' + p.label, rows: rows }]; }
    if (p && p.category) { return categoryBuckets(rows, p.category); }
    if (view.preset && PRESET[view.preset].group) {
      var byGroup = new Map();
      for (i = 0; i < rows.length; i++) {
        var g = rows[i].dupGroup;
        if (!byGroup.has(g)) { byGroup.set(g, []); }
        byGroup.get(g).push(rows[i]);
      }
      byGroup.forEach(function (members, g) {
        buckets.push({ name: pad(g, 3) + ' Group of ' + members.length, rows: members });
      });
      return buckets;
    }
    if (!view.sort.length) { return null; }
    var col = COLUMN[view.sort[0].key], names = bucketNames(col, view.sort[0].dir);
    if (col.category) { return categoryBuckets(rows, col.category); }
    var withValue = [], without = [];
    for (i = 0; i < rows.length; i++) {
      (hasValue(rows[i], col) ? withValue : without).push(rows[i]);
    }
    var slots = [[], [], [], [], []];
    for (i = 0; i < withValue.length; i++) {
      slots[Math.floor(i * 5 / withValue.length)].push(withValue[i]);
    }
    for (i = 0; i < 5; i++) {
      if (slots[i].length) { buckets.push({ name: pad(i + 1, 2) + ' ' + names[i], rows: slots[i] }); }
    }
    if (without.length) { buckets.push({ name: '06 No value', rows: without }); }
    return buckets;
  }

  function localDate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);
  }

  // ---------------------------------------------------------------- project columns

  // The Project panel's custom columns are text, so every value has the same width and sorts as a number would.
  var FIELDS = [
    { name: 'SelectRank', label: 'Select Rank' },
    { name: 'SelectSharpness', label: 'Select Sharpness' },
    { name: 'SelectLuma', label: 'Select Luma' },
    { name: 'SelectClipHigh', label: 'Select Clip Hi' },
    { name: 'SelectMotion', label: 'Select Motion' },
    { name: 'SelectAudio', label: 'Select Audio dB+100' },
    { name: 'SelectPeople', label: 'Select People', tier2: true },
    { name: 'SelectFaces', label: 'Select Faces', tier2: true },
    { name: 'SelectShot', label: 'Select Shot', tier2: true },
    { name: 'SelectColour', label: 'Select Colour', tier2: true },
    { name: 'SelectSound', label: 'Select Sound', tier2: true },
    { name: 'SelectLabels', label: 'Select Labels', tier2: true },
    { name: 'SelectText', label: 'Select Text', tier2: true }
  ];

  function padUnit(v) {
    return v === null || v === undefined || v !== v ? '' : Number(v).toFixed(3);
  }

  function padFixed(v, whole, decimals) {
    if (v === null || v === undefined || v !== v) { return ''; }
    var s = Number(v).toFixed(decimals), dot = s.indexOf('.');
    return pad(s.slice(0, dot), whole) + s.slice(dot);
  }

  // rank is the 1-based place in the current view. dB is negative, so it is written as dB + 100 and clamped to
  // 0..999.9: text would otherwise sort -9 above -30.
  function columnValues(row, rank, width) {
    var db = row.audioDb;
    return {
      SelectRank: pad(rank, width),
      SelectSharpness: padUnit(row.sharpness),
      SelectLuma: padUnit(row.luma),
      SelectClipHigh: padFixed(row.clipHighPct, 3, 2),
      SelectMotion: padUnit(row.motionProxy),
      SelectAudio: db === null || db === undefined ? '' : padFixed(Math.min(999.9, Math.max(0, db + 100)), 3, 1),
      SelectPeople: typeof row.people === 'number' ? pad(row.people, 3) : '',
      SelectFaces: typeof row.faces === 'number' ? pad(row.faces, 3) : '',
      SelectShot: fmtShot(row.shotSize),
      SelectColour: fmtColour(row.colorName),
      SelectSound: namesOf(row.sounds, 3) || '',
      SelectLabels: namesOf(row.labels, 5) || '',
      SelectText: (namesOf(row.text, 6) || '').slice(0, 120)
    };
  }

  // ---------------------------------------------------------------- calling ExtendScript

  // ES3 string literal in pure ASCII. CEP passes the script as text, and accented paths must survive it.
  function jsString(s) {
    return JSON.stringify(s).replace(/[\u007f-￿]/g, function (c) {
      return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
    });
  }

  function hostCall(fn, args) {
    return 'slCall(' + jsString(fn) + ',' + jsString(JSON.stringify(args || {})) + ')';
  }

  // ---------------------------------------------------------------- sources

  // Listed as rows, so a clip the engine cannot read still shows with a reason. Listing is not a claim that it reads.
  var VIDEO_EXT = { mp4: 1, mov: 1, mxf: 1, m4v: 1, avi: 1, mts: 1, m2ts: 1, mkv: 1, webm: 1, mpg: 1, mpeg: 1, r3d: 1, braw: 1 };
  // What really reads today. MXF goes through ffmpeg, so only when it is installed.
  var READS_NATIVELY = { mp4: 1, mov: 1, m4v: 1 };
  var READS_WITH_FFMPEG = { mxf: 1 };
  var FORMATS_NOTE = 'Reads .mp4, .mov and .m4v. Reads .mxf when ffmpeg is installed. Other formats, such as .r3d and .braw, stay in the list but can\'t be read yet.';

  function extension(p) {
    var name = baseName(p), dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  function isVideoPath(p) {
    var name = baseName(p);
    if (name.charAt(0) === '.') { return false; }
    var dot = name.lastIndexOf('.');
    return dot > 0 && VIDEO_EXT[name.slice(dot + 1).toLowerCase()] === 1;
  }

  // Merge Premiere's items by path; a file in the project twice is one row with two ids. Non-video is dropped here.
  function videoItems(items) {
    var keep = [], skipped = 0;
    for (var i = 0; i < items.length; i++) {
      if (isVideoPath(items[i].path) && items[i].path.indexOf('\n') === -1) { keep.push(items[i]); } else { skipped++; }
    }
    return { items: keep, skipped: skipped };
  }

  function fileUrl(path) {
    return 'file://' + encodeURI(path).replace(/[?#]/g, encodeURIComponent);
  }

  // ---------------------------------------------------------------- labels: Premiere's default names, index order

  // The write sets an index. Names and colours are the defaults; someone who renamed a label sees it under the new name there.
  var LABELS = [
    ['Violet', '#a990dd'], ['Iris', '#6a7fd8'], ['Caribbean', '#28b8a8'], ['Lavender', '#e384e3'],
    ['Cerulean', '#2d9fe0'], ['Forest', '#5fa83b'], ['Rose', '#e2506e'], ['Mango', '#f09a2a'],
    ['Purple', '#9650c8'], ['Blue', '#3f62d8'], ['Teal', '#2f9aa0'], ['Magenta', '#cc3fa8'],
    ['Tan', '#d3bb93'], ['Green', '#3d8f52'], ['Brown', '#8c5a36'], ['Yellow', '#e6d44c']
  ];
  var DEFAULT_LABEL = 7;

  // ---------------------------------------------------------------- words

  function fmtInt(n) { return Number(n).toLocaleString('en-US'); }

  function plural(n, word) { return fmtInt(n) + ' ' + word + (n === 1 ? '' : 's'); }

  function listWords(parts) {
    if (parts.length < 2) { return parts.join(''); }
    return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
  }

  // ---------------------------------------------------------------- theme

  // Dark tokens when Premiere is dark, light tokens when it is set bright. color: {red, green, blue}, 0 to 255.
  function themeFor(color) {
    if (!color) { return 'dark'; }
    return (Number(color.red) + Number(color.green) + Number(color.blue)) / 3 >= 128 ? 'light' : 'dark';
  }

  // ---------------------------------------------------------------- clips the engine could not read

  var WHY = { unsupported: 'unsupported', ffmpeg: 'ffmpeg', missing: 'missing', denied: 'denied', other: 'other' };

  // Why a clip failed, from its extension first and the engine's message second, whose wording can change.
  function unreadableKind(row) {
    var ext = extension(row.path), msg = String(row.error || '');
    if (!READS_NATIVELY[ext] && !READS_WITH_FFMPEG[ext]) { return WHY.unsupported; }
    if (/ff(mpeg|probe) not found/i.test(msg)) { return WHY.ffmpeg; }
    if (/no such file|does not exist|ENOENT/i.test(msg)) { return WHY.missing; }
    if (/not permitted|permission denied|EACCES|EPERM/i.test(msg)) { return WHY.denied; }
    return WHY.other;
  }

  // The quiet words under a clip's name.
  function unreadableReason(row) {
    var ext = extension(row.path);
    switch (unreadableKind(row)) {
      case WHY.unsupported: return ext ? '.' + ext + ' isn\'t supported yet' : 'This format isn\'t supported yet';
      case WHY.ffmpeg: return ext === 'mxf' ? '.mxf needs ffmpeg' : 'This clip needs ffmpeg';
      case WHY.missing: return 'Missing or offline';
      case WHY.denied: return 'macOS denied access';
      default: return 'Couldn\'t read this file';
    }
  }

  // One plain sentence for the status line, or '' when every clip was read.
  function unreadableSummary(rows) {
    var count = 0, unsupported = [], ffmpeg = [], seen = {}, missing = false, denied = false, other = false, i, row, kind, ext;
    for (i = 0; i < rows.length; i++) {
      row = rows[i];
      if (!row.error) { continue; }
      count++;
      kind = unreadableKind(row);
      ext = '.' + extension(row.path);
      if (kind === WHY.unsupported || kind === WHY.ffmpeg) {
        if (!seen[kind + ext]) {
          seen[kind + ext] = true;
          (kind === WHY.unsupported ? unsupported : ffmpeg).push(ext);
        }
      } else if (kind === WHY.missing) { missing = true; } else if (kind === WHY.denied) { denied = true; } else { other = true; }
    }
    if (!count) { return ''; }
    var why = [];
    if (unsupported.length) { why.push(listWords(unsupported.sort()) + (unsupported.length > 1 ? ' aren\'t' : ' isn\'t') + ' supported yet'); }
    if (ffmpeg.length) { why.push(listWords(ffmpeg.sort()) + (ffmpeg.length > 1 ? ' need' : ' needs') + ' ffmpeg'); }
    if (missing) { why.push((count === 1 ? 'the file is' : 'some files are') + ' missing or offline'); }
    if (denied) { why.push('macOS denied access to ' + (count === 1 ? 'the file' : 'some files')); }
    if (other) { why.push((count === 1 ? 'the file' : 'some files') + ' may be damaged'); }
    return plural(count, 'clip') + ' could not be read: ' + listWords(why) + '.';
  }

  // ---------------------------------------------------------------- clips with no picture scores

  // The quiet words under a clip's name: the engine's first sentence, without its error number. A picture problem from
  // Tier 1 comes first; failing to look closer in Tier 2 comes second.
  function noPictureWords(row) {
    var reason = row.reason || row.lookReason;
    if (!reason) { return ''; }
    var first = /^.+?\.(?=\s|$)/.exec(String(reason));
    return (first ? first[0] : String(reason)).replace(/ \(error -?\d+\)/, '');
  }

  // Why a scan left picture scores blank, said once for all of them, or '' when none are. Depends on the Mac, so it says so.
  function noPictureSummary(tally) {
    var n = tally.clips, them = n === 1 ? 'it' : 'them';
    if (!n) { return ''; }
    var why;
    if (tally.noDecoder === n && tally.noFfmpeg === n) {
      why = 'this Mac has no decoder for ' + them + ', and ffmpeg isn\'t installed.';
    } else if (tally.noFfmpeg === n) {
      why = 'this Mac couldn\'t decode ' + them + ', and ffmpeg isn\'t installed.';
    } else {
      why = 'this Mac couldn\'t decode ' + them + '.';
    }
    return plural(n, 'clip') + (n === 1 ? ' is' : ' are') + ' listed with blank picture scores: ' + why;
  }

  // ---------------------------------------------------------------- when the engine does not run

  var REFUSED = { EACCES: 1, EPERM: 1, ENOEXEC: 1, EBADARCH: 1, UNKNOWN: 1 };
  var REINSTALL = 'Reinstall Select, then press Scan.';
  var ALLOW = 'Open System Settings, Privacy & Security, and allow it, or reinstall Select.';

  // What the foot says when a scan did not run to the end. heard: lines the engine sent before it went.
  function engineFailure(info, heard) {
    var code = info.errorCode || '';
    if (code === 'ENOENT') { return { verdict: 'Can\'t scan', sentence: 'The scanning engine is not installed. ' + REINSTALL }; }
    if (REFUSED[code]) { return { verdict: 'Can\'t scan', sentence: 'macOS will not run the scanning engine. ' + ALLOW }; }
    if (info.error) { return { verdict: 'Can\'t scan', sentence: 'The scanning engine did not start. ' + REINSTALL }; }
    if (info.signal === 'SIGKILL' && !heard) { return { verdict: 'Can\'t scan', sentence: 'macOS stopped the scanning engine as it started. ' + ALLOW }; }
    var how = info.signal ? '(' + info.signal + ')' : '(code ' + info.code + ')';
    return { verdict: 'The scan stopped early', sentence: 'The engine quit ' + how + '. What was read stays. Rescan, or report a bug.' };
  }

  // ---------------------------------------------------------------- read-back

  function countOf(list) { return list ? list.length : 0; }

  function quoted(s) { return '\u201c' + s + '\u201d'; }

  // Did every sent id come back from the bin it was sent to, and nothing else?
  function binsRead(sent, res) {
    var expected = 0, matched = 0, extra = 0, confirmed = true;
    sent.forEach(function (bucket) {
      expected += bucket.ids.length;
      var back = (res.buckets || []).filter(function (b) { return b.name === bucket.name; })[0];
      if (!back || !back.ids) { confirmed = false; return; }
      var inBin = {};
      back.ids.forEach(function (id) { inBin[String(id)] = true; });
      bucket.ids.forEach(function (id) {
        if (inBin[String(id)]) { matched++; delete inBin[String(id)]; }
      });
      extra += Object.keys(inBin).length;
    });
    return { expected: expected, matched: confirmed ? matched : 0, confirmed: confirmed, extra: extra };
  }

  // The fields and words of a finished write. Green only when what was read back matches what was sent.
  // kind: label, columns or bins. sent: the host call's arguments. res: its answer. Nothing here trusts `ok` alone.
  function writeOutcome(kind, sent, res, extra) {
    var failed = countOf(res.failed), files = 'Your files weren\'t touched.', o, read, n;
    if (kind === 'bins') {
      read = binsRead(sent.buckets, res);
      n = res.moved || 0;
      var bins = sent.buckets.length;
      if (read.confirmed && read.matched === read.expected && !read.extra && !failed) {
        return { kind: 'proved', green: true, verdict: 'Sorted into ' + plural(bins, 'bin'), sentence: plural(read.matched, 'clip') + ' moved. ' + files, undo: true, failed: [] };
      }
      if (!n) { return { kind: 'partial', verdict: 'Nothing moved', sentence: 'Premiere did not move any clips. ' + files, undo: false, failed: res.failed || [] }; }
      if (!read.confirmed) {
        return { kind: 'partial', verdict: 'Moved, not confirmed', sentence: 'Premiere moved ' + plural(n, 'clip') + ' but did not confirm where they landed, so check the bins. ' + files, undo: true, failed: res.failed || [] };
      }
      var off = read.expected - read.matched + read.extra;
      return { kind: 'partial', verdict: 'Moved ' + fmtInt(read.matched) + ' of ' + plural(read.expected, 'clip'), sentence: plural(off, 'clip') + ' did not land where ' + (off === 1 ? 'it' : 'they') + ' should. ' + files, undo: true, failed: res.failed || [] };
    }
    if (kind === 'columns') {
      var expected = 0, added = sent.fields.length;
      sent.rows.forEach(function (r) { expected += r.ids.length; });
      n = res.changed || 0;
      var matched = typeof res.matched === 'number' ? res.matched : null, shown = !!(res.columns && res.columns.shown);
      if (matched === expected && !failed && shown) {
        return { kind: 'proved', green: true, verdict: 'Added ' + plural(added, 'column'), sentence: plural(matched, 'clip') + ' updated. ' + files, undo: true, failed: [] };
      }
      if (!n) { return { kind: 'partial', verdict: 'Nothing written', sentence: 'Premiere did not take the columns. ' + files, undo: false, failed: res.failed || [] }; }
      if (matched === null) {
        return { kind: 'partial', verdict: 'Written, not confirmed', sentence: 'Premiere took the columns on ' + plural(n, 'clip') + ' but did not confirm them, so check a few. ' + files, undo: true, failed: res.failed || [] };
      }
      if (matched === expected && !failed) {
        return { kind: 'partial', verdict: 'Added, not showing', sentence: 'The values are in. Turn the columns on with Metadata Display in the Project panel menu.', undo: true, failed: [] };
      }
      return { kind: 'partial', verdict: 'Wrote ' + fmtInt(matched) + ' of ' + plural(expected, 'clip'), sentence: plural(expected - matched, 'clip') + ' did not read back the same. ' + files, undo: true, failed: res.failed || [] };
    }
    // Labels: the host reads each label back as it sets it, and `changed` counts only those that matched.
    var want = sent.ids.length;
    n = res.changed || 0;
    if (n === want && !failed) {
      return { kind: 'proved', green: true, verdict: 'Labelled ' + plural(n, 'clip') + ' ' + extra, sentence: 'Every label read back. ' + files, undo: true, failed: [] };
    }
    if (!n) { return { kind: 'partial', verdict: 'Nothing labelled', sentence: 'Premiere did not change any labels. ' + files, undo: false, failed: res.failed || [] }; }
    return { kind: 'partial', verdict: 'Labelled ' + fmtInt(n) + ' of ' + plural(want, 'clip'), sentence: plural(want - n, 'clip') + ' did not read back the same. ' + files, undo: true, failed: res.failed || [] };
  }

  // Result of Undo. Never green: putting things back proves nothing new.
  function undoOutcome(res) {
    var failed = countOf(res.failed), bits = plural(res.restored, 'item') + ' back where ' + (res.restored === 1 ? 'it was' : 'they were') + '.';
    if (res.skipped) { bits += ' ' + fmtInt(res.skipped) + ' changed since and left alone.'; }
    if (failed) { bits += ' ' + plural(failed, 'item') + ' could not go back.'; }
    if (res.binRemoved === false) { bits += ' The SELECT bin is still in the project.'; }
    var verdict = !failed ? 'Undone' : (res.restored ? 'Partly undone' : 'Nothing went back');
    return { kind: failed || res.skipped || res.binRemoved === false ? 'partial' : 'undone', verdict: verdict, sentence: bits, undo: !!res.remaining, failed: res.failed || [] };
  }

  // ---------------------------------------------------------------- the foot

  var SOURCE_WORDS = {
    selection: 'Scan reads the clips selected in the Project panel.',
    project: 'Scan reads every clip in this project.',
    folder: 'Scan reads the video files in this folder.'
  };

  // Scan progress as a share of the work: file details are the first fifth, decoded frames and audio the rest.
  function progress(store) {
    var total = Math.max(store.total, 1), finished = store.tier1 + store.errors;
    return { finished: Math.min(finished, store.total), share: Math.min(1, (0.2 * Math.min(store.tier0 + store.errors, total) + 0.8 * Math.min(finished, total)) / total) };
  }

  // Values that only Tier 2 sends. A view that sorts, filters or searches on them is not final until every clip has them.
  var TIER2_KEYS = { people: 1, faces: 1, shotSize: 1, colorName: 1, soundText: 1, screenText: 1, labelText: 1, iso: 1, shutterS: 1, aperture: 1, shake: 1 };

  function viewNeedsTier2(view, tokens) {
    var p = view.preset ? PRESET[view.preset] : null;
    if ((p && (p.needs || p.group === 'engine')) || view.family || (tokens && tokens.length)) { return true; }
    return view.sort.some(function (s) { return TIER2_KEYS[s.key] === 1; });
  }

  // What the view is waiting on, in a few words for the foot.
  function waitingOn(view, tokens) {
    if (view.preset) { return PRESET[view.preset].label; }
    if (view.family) { return FAMILY[view.family].word; }
    var tier2 = view.sort.filter(function (s) { return TIER2_KEYS[s.key] === 1; })[0];
    if (tier2) { return COLUMN[tier2.key].label; }
    return tokens && tokens.length ? 'This search' : '';
  }

  // The fields Add Columns may write: Tier 2's only once it has landed for every clip, so it never writes a blank for a
  // value that is still on its way.
  function columnFields(tier2Landed) {
    return FIELDS.filter(function (f) { return tier2Landed || !f.tier2; });
  }

  // Clips Tier 2 should reach: every clip except those the engine could not read at all.
  function understandingShare(store) {
    var due = Math.max(store.total - store.errors, 0), done = Math.min(store.tier2 + store.tier2Failed, due);
    return { done: done, due: due, share: due ? done / due : 1, landed: done >= due };
  }

  function notUnderstoodSummary(store) {
    var n = store.tier2Failed;
    return n ? plural(n, 'clip') + ' could not be looked at more closely. ' + (n === 1 ? 'Its' : 'Their') + ' file details and picture scores stand.' : '';
  }

  // The bottom line. Pure: every word of the foot comes from here, so tests read what a person would and no view decides.
  // f: {source, project, connected, listing, busy, outcome, scan: {state, failure, seconds, stopping}, store,
  //     rows, shown, selected, view, groupCount}
  function footState(f) {
    var sc = f.scan, st = f.store, total = f.rows;
    var writes = ['label', 'columns', 'bins'];
    var sorted = !!sortName(f.view);
    if (f.busy) { return { kind: 'writing', mark: 'running', verdict: f.busy, sentence: 'Premiere is busy for a moment.', actions: [] }; }
    if (f.listing) { return { kind: 'listing', mark: 'running', verdict: 'Listing clips', sentence: '', actions: [] }; }
    if (f.outcome) {
      var o = f.outcome, list = o.green ? ['undo'] : (o.undo ? ['undo'] : []);
      if (!o.green) {
        if (o.failed && o.failed.length) { list.unshift('details'); }
        if (o.kind === 'undone' || !o.undo) { list = list.concat(writes); }
      }
      return { kind: o.kind, mark: o.green ? 'seal' : (o.kind === 'undone' ? 'done' : 'look'), verdict: o.verdict, sentence: o.sentence, green: !!o.green, actions: list, primary: list.indexOf('bins') >= 0 ? 'bins' : null, binsOff: !sorted };
    }
    if (sc && sc.state === 'Scanning') {
      var p = progress(st), rate = Math.round(p.finished / Math.max(sc.seconds, 0.001));
      // Stage three: every clip is usable, and the engine is still looking closer. The panel works, so it says so quietly.
      if (p.finished >= st.total && st.total && !sc.stopping) {
        var u = understandingShare(st), hold = !u.landed && !!f.needsTier2;
        var on = waitingOn(f.view, f.query ? [f.query] : null);
        return { kind: 'understanding', mark: 'running', verdict: sortName(f.view) || plural(st.total, 'clip') + ' read', sentence: 'Still looking closer, on this Mac: ' + fmtInt(u.done) + ' of ' + fmtInt(u.due), meter: u.share,
          actions: ['stop'].concat(writes), primary: 'bins', binsOff: !sorted,
          held: hold ? writes : [],
          wait: hold ? on + ' needs every clip looked at, so Label, Add Columns and Sort into Bins wait until it is done. They turn on by themselves.' : '' };
      }
      return { kind: 'scanning', mark: 'running', verdict: sc.stopping ? 'Stopping' : 'Reading ' + fmtInt(p.finished) + ' of ' + fmtInt(st.total), sentence: fmtInt(rate) + ' clips per second', meter: p.share, actions: ['stop'] };
    }
    // The source changed since this scan, so Scan comes back to the foot. The results stay until it's pressed.
    if (f.rescan && sc) {
      return { kind: 'finished', mark: 'waiting', verdict: 'Ready to scan', sentence: SOURCE_WORDS[f.source] + ' The list below is from the last scan.', actions: ['scan'], primary: 'scan' };
    }
    if (!sc || !total) {
      var idle = f.project ? SOURCE_WORDS[f.source] : (f.connected ? 'Open a project in Premiere, then press Scan.' : (f.source === 'folder' ? SOURCE_WORDS.folder : 'Waiting for Premiere.'));
      return { kind: 'empty', mark: 'waiting', verdict: 'Nothing scanned yet', sentence: idle, actions: ['scan'], primary: 'scan' };
    }
    var clips = plural(total, 'clip');
    var blank = st.noPicture ? noPictureSummary(st.noPicture) : '';
    var withBlank = function (line) { return blank ? line + ' ' + blank : line; };
    var count = f.shown === total ? clips : fmtInt(f.shown) + ' of ' + clips;
    if (sc.state === 'Stopped') {
      return { kind: 'stopped', mark: 'skipped', verdict: 'Stopped', sentence: withBlank(fmtInt(progress(st).finished) + ' of ' + clips + ' read. What was read stays.'), actions: writes.concat('scan'), primary: 'scan', binsOff: !sorted };
    }
    if (sc.failure) {
      return { kind: 'failed', mark: 'failed', verdict: sc.failure.verdict, sentence: sc.failure.sentence, actions: writes.concat('scan'), primary: 'scan', binsOff: !sorted };
    }
    var read = total - st.errors;
    if (sc.state === 'Done' && !read) {
      return { kind: 'unreadable', mark: 'look', verdict: 'Nothing could be read', sentence: 'None of these ' + clips + ' could be read. The line below says why.', actions: ['scan'], primary: 'scan' };
    }
    var selected = f.selected;
    var words = viewWords(f.view);
    var plain = f.view.preset ? PRESET[f.view.preset] : null;
    if (f.status === 'none' && plain) { words = plain.none; }
    var seconds = sc.seconds < 10 ? sc.seconds.toFixed(1) : String(Math.round(sc.seconds));
    var head = f.view.preset && PRESET[f.view.preset].group ? plural(f.groupCount, 'group') + ', ' + count + '.' : (f.shown === total ? clips + ' in ' + seconds + ' s.' : count + (f.query ? ' match ' + quoted(f.query) + '.' : '.'));
    var line = selected ? fmtInt(selected) + ' of ' + clips + ' selected. Label, Add Columns and Sort into Bins use these.' : withBlank(words ? head + ' ' + words : (f.shown === total ? 'Took ' + seconds + ' s. Pick a sort above.' : head));
    var family = f.view.family ? FAMILY[f.view.family].word : '';
    var name = sortName(f.view);
    return { kind: 'finished', mark: 'done', verdict: family && name ? family + ', ' + name.toLowerCase() : family || name || clips + ' read', sentence: line, actions: writes, primary: 'bins', binsOff: !sorted };
  }

  return {
    NEAR_DUP_BITS: NEAR_DUP_BITS,
    COLUMNS: COLUMNS,
    COLUMN: COLUMN,
    PRESETS: PRESETS,
    PRESET: PRESET,
    FIELDS: FIELDS,
    LABELS: LABELS,
    DEFAULT_LABEL: DEFAULT_LABEL,
    FORMATS_NOTE: FORMATS_NOTE,
    cellText: cellText,
    JsonlParser: JsonlParser,
    createStore: createStore,
    addItems: addItems,
    ingest: ingest,
    pathKey: pathKey,
    sortOrder: sortOrder,
    hamming: hamming,
    nearDuplicateGroups: nearDuplicateGroups,
    computeView: computeView,
    nextSort: nextSort,
    sortName: sortName,
    viewWords: viewWords,
    bucketize: bucketize,
    localDate: localDate,
    columnValues: columnValues,
    hostCall: hostCall,
    isVideoPath: isVideoPath,
    videoItems: videoItems,
    fileUrl: fileUrl,
    fmtDuration: fmtDuration,
    fmtInt: fmtInt,
    plural: plural,
    themeFor: themeFor,
    unreadableReason: unreadableReason,
    unreadableSummary: unreadableSummary,
    noPictureWords: noPictureWords,
    noPictureSummary: noPictureSummary,
    notUnderstoodSummary: notUnderstoodSummary,
    engineFailure: engineFailure,
    writeOutcome: writeOutcome,
    undoOutcome: undoOutcome,
    footState: footState,
    GROUPS: GROUPS,
    FAMILIES: FAMILIES,
    FAMILY: FAMILY,
    rainbowKey: rainbowKey,
    searchTokens: searchTokens,
    matches: matches,
    matchedWord: matchedWord,
    dataStatus: dataStatus,
    presetCount: presetCount,
    familyCounts: familyCounts,
    viewNeedsTier2: viewNeedsTier2,
    columnFields: columnFields,
    understandingShare: understandingShare,
    tileFact: tileFact,
    quoted: quoted
  };
});
