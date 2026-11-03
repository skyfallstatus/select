// Select panel logic with no DOM and no Node dependency. Loaded by the panel and by the tests.
(function (root, factory) {
  var api = factory();
  root.SelectCore = api;
  if (typeof module === 'object' && module && module.exports) { module.exports = api; }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // Clips a near-duplicate group's members may differ from its first clip by, in dhash bits out of 64.
  var NEAR_DUP_BITS = 8;
  // Interviews keeps clips in the calmest share of the scan.
  var CALM_SHARE = 0.4;

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

  // ---------------------------------------------------------------- columns

  // words: bucket names from the highest values to the lowest, for "Sort into Bins" and the foot's verdict.
  // hidden: off by default, switchable from the menu. A hidden column still shows while the view sorts by it.
  var COLUMNS = [
    { key: 'thumb', label: '', width: 74, kind: 'thumb', sortable: false, fixed: true },
    { key: 'name', label: 'Name', width: 150, kind: 'text', grow: true, fixed: true, tip: 'File name.' },
    { key: 'dupGroup', label: 'Group', width: 48, kind: 'number', fmt: fmtText, onlyWithGroups: true, fixed: true, tip: 'Near-duplicate group.' },
    { key: 'durationS', label: 'Duration', width: 66, kind: 'number', fmt: fmtDuration, words: ['Longest', 'Longer', 'Middle', 'Shorter', 'Shortest'], tip: 'Duration.' },
    { key: 'sharpness', label: 'Sharpness', width: 72, kind: 'number', fmt: fixed(3), words: ['Sharpest', 'Sharper', 'Middle', 'Softer', 'Softest'],
      tip: 'Fine detail in the sharpest tiles of one decoded moment, at native resolution, normalised by local contrast. It compares clips; it says nothing about the rest of the take.' },
    { key: 'luma', label: 'Brightness', width: 74, kind: 'number', fmt: fixed(2), words: ['Brightest', 'Brighter', 'Middle', 'Darker', 'Darkest'], tip: 'Mean luma of one decoded moment, 0 to 1. Log footage reads differently from graded footage.' },
    { key: 'motionProxy', label: 'Motion', width: 58, kind: 'number', fmt: fixed(3), words: ['Most motion', 'More motion', 'Middle', 'Less motion', 'Least motion'], tip: 'Spread of compressed frame sizes along the clip, 0 to 1. A stand-in for motion read from the file structure; no pixels are decoded.' },
    { key: 'audioDb', label: 'Audio', width: 56, kind: 'number', fmt: fixed(1), words: ['Loudest', 'Louder', 'Middle', 'Quieter', 'Quietest'], tip: 'Mean level in dB from sampled windows, not a full read. Empty when the clip has no audio or none could be read.' },
    { key: 'createdAt', label: 'Date', width: 132, kind: 'date', fmt: fmtDate, words: ['Latest', 'Later', 'Middle', 'Earlier', 'Earliest'], tip: 'Camera time when present.' },
    { key: 'camera', label: 'Camera', width: 112, kind: 'text', tip: 'Maker and model.' },
    { key: 'clipHighPct', label: 'Highlights', width: 62, kind: 'number', hidden: true, fmt: fixed(2), words: ['Most clipped', 'More clipped', 'Middle', 'Less clipped', 'Least clipped'], tip: 'Percent of pixels at the top extreme, in one decoded moment.' },
    { key: 'clipLowPct', label: 'Shadows', width: 58, kind: 'number', hidden: true, fmt: fixed(2), words: ['Most crushed', 'More crushed', 'Middle', 'Less crushed', 'Least crushed'], tip: 'Percent of pixels at the bottom extreme, in one decoded moment.' },
    { key: 'lens', label: 'Lens', width: 130, kind: 'text', hidden: true, tip: 'From embedded metadata or the Sony sidecar.' },
    { key: 'codec', label: 'Codec', width: 60, kind: 'text', hidden: true },
    { key: 'pixels', label: 'Resolution', width: 84, kind: 'number', hidden: true, fmt: null, tip: 'Display size after rotation.' }
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
    return { rows: [], byKey: new Map(), total: 0, tier0: 0, tier1: 0, errors: 0, cached: 0, bad: 0, start: null, done: null, noPicture: { clips: 0, noDecoder: 0, noFfmpeg: 0 } };
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
      case 'error': {
        if (!msg.path) { return false; }
        var bad = addRow(store, msg.path);
        if (bad.error === null) { store.errors++; }
        bad.error = msg.message === undefined ? 'unknown error' : String(msg.message);
        bad.version = (bad.version || 0) + 1;
        return true;
      }
      case 'clip': {
        if (!msg.path) { return false; }
        var row = addRow(store, msg.path), counted = !!row.reason;
        for (var k in msg) {
          if (!ENVELOPE[k]) { row[k] = msg[k]; }
        }
        if (msg.reason && !counted) { countNoPicture(store.noPicture, msg.reason); }
        row.version = (row.version || 0) + 1;
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

  function isText(col) { return col.kind === 'text'; }

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
        var nums = new Float64Array(n), field = c.kind === 'date' ? 'time' : c.key;
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
    { id: 'interviews', label: 'Interviews', sort: [S('durationS', -1)], says: 'With audio, in the calmest 40% of this scan. Longest first.',
      prepare: calmLimit,
      filter: function (r, limit) {
        return r.hasAudio === true && r.silent !== true && typeof r.motionProxy === 'number' && limit !== null && r.motionProxy <= limit;
      },
      tip: 'Shows clips with audio and low motion: the calmest 40% of this scan by the motion stand-in, longest first. It does not detect faces or speech, so it finds likely interviews, and static ambience passes too.' },
    { id: 'duplicates', label: 'Near duplicates', group: true, sort: [S('dupGroup', 1), S('sharpness', -1)], says: 'Similar frames grouped, sharpest first in each.',
      tip: 'Groups clips whose 64-bit frame hash differs by ' + NEAR_DUP_BITS + ' bits or fewer from the first clip of the group. It compares one moment per clip, so two takes of a set-up can match, and clips that differ only later do not.' },
    { id: 'shoot', label: 'Shoot order', sort: [S('createdAt', 1), S('name', 1)], says: 'Earliest at the top.',
      tip: 'Sorts by the creation time in the file, then by name. Clips with no date go last. It trusts the camera clock, and offloaded or re-exported files may carry another date.' }
  ];
  var PRESET = {};
  PRESETS.forEach(function (p) { PRESET[p.id] = p; });

  function calmLimit(rows) {
    var values = [];
    for (var i = 0; i < rows.length; i++) {
      if (typeof rows[i].motionProxy === 'number') { values.push(rows[i].motionProxy); }
    }
    if (!values.length) { return null; }
    values.sort(function (a, b) { return a - b; });
    return values[Math.max(0, Math.ceil(values.length * CALM_SHARE) - 1)];
  }

  // view: {sort: [...], preset: id or null}. Returns {order, groupCount, ms} where order is row indexes to show.
  function computeView(rows, view, now) {
    var clock = now || function () { return Date.now(); };
    var t0 = clock(), p = view.preset ? PRESET[view.preset] : null, order = [], i;
    var groupCount = 0, hasGroups = !!(p && p.group);
    for (i = 0; i < rows.length; i++) { rows[i].dupGroup = null; }
    if (hasGroups) {
      var groups = nearDuplicateGroups(rows);
      groupCount = groups.length;
      for (i = 0; i < groups.length; i++) {
        for (var j = 0; j < groups[i].length; j++) {
          rows[groups[i][j]].dupGroup = i + 1;
          order.push(groups[i][j]);
        }
      }
    } else if (p && p.filter) {
      var ctx = p.prepare ? p.prepare(rows) : null;
      for (i = 0; i < rows.length; i++) {
        if (p.filter(rows[i], ctx)) { order.push(i); }
      }
    } else {
      for (i = 0; i < rows.length; i++) { order.push(i); }
    }
    sortOrder(rows, order, view.sort);
    return { order: order, groupCount: groupCount, hasGroups: hasGroups, ms: clock() - t0 };
  }

  // One click sorts by that column, again flips it. Shift adds it as the next key, or flips it if already there.
  function nextSort(sort, key, shift) {
    var col = COLUMN[key], natural = col.kind === 'number' ? -1 : 1;
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
    if (c.words) { return c.words[s.dir > 0 ? 4 : 0] + ' first'; }
    if (c.key === 'pixels') { return s.dir > 0 ? 'Smallest first' : 'Largest first'; }
    return c.label + (s.dir > 0 ? ' A to Z' : ' Z to A');
  }

  function viewWords(view) {
    if (view.preset) { return PRESET[view.preset].says; }
    if (!view.sort.length) { return ''; }
    var s = view.sort[0], c = COLUMN[s.key];
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
    var v = col.kind === 'date' ? row.time : row[col.key];
    return !(v === null || v === undefined || v === '' || v !== v);
  }

  // Sharpest to softest for a descending sort, softest to sharpest for an ascending one.
  function bucketNames(col, dir) {
    if (!col.words) { return FIFTHS.slice(); }
    var words = col.words.slice();
    if (dir > 0) { words.reverse(); }
    return words;
  }

  // rows in view order. Near-duplicate views get one bin per group; everything else gets quintiles of the
  // active sort, with clips that have no value for that sort kept apart. Returns [{name, rows}] or null.
  function bucketize(rows, view) {
    var buckets = [], i;
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
    { name: 'SelectAudio', label: 'Select Audio dB+100' }
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
      SelectAudio: db === null || db === undefined ? '' : padFixed(Math.min(999.9, Math.max(0, db + 100)), 3, 1)
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

  // The quiet words under a clip's name: the engine's first sentence, without its error number.
  function noPictureWords(row) {
    if (!row.reason) { return ''; }
    var first = /^.+?\.(?=\s|$)/.exec(String(row.reason));
    return (first ? first[0] : String(row.reason)).replace(/ \(error -?\d+\)/, '');
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
    var seconds = sc.seconds < 10 ? sc.seconds.toFixed(1) : String(Math.round(sc.seconds));
    var head = f.view.preset && PRESET[f.view.preset].group ? plural(f.groupCount, 'group') + ', ' + count + '.' : (f.shown === total ? clips + ' in ' + seconds + ' s.' : count + '.');
    var line = selected ? fmtInt(selected) + ' of ' + clips + ' selected. Label, Add Columns and Sort into Bins use these.' : withBlank(words ? head + ' ' + words : 'Took ' + seconds + ' s. Pick a sort above.');
    return { kind: 'finished', mark: 'done', verdict: sortName(f.view) || clips + ' read', sentence: line, actions: writes, primary: 'bins', binsOff: !sorted };
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
    engineFailure: engineFailure,
    writeOutcome: writeOutcome,
    undoOutcome: undoOutcome,
    footState: footState
  };
});
