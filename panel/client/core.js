// Select panel logic with no DOM and no Node dependency. Loaded by the panel and by the tests.
(function (root, factory) {
  var api = factory();
  root.SelectCore = api;
  if (typeof module === 'object' && module && module.exports) { module.exports = api; }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // Interviews are at least this long: shorter clips with speech and a face were nearly never interviews.
  var INTERVIEW_MIN_S = 15;
  // Interviews leaves out clips that move more than a handheld camera, where the gyro says so. On the engine's scale
  // (log10 of deg/s over 0.3, halved) 0.6 is about 4.8 deg/s, just above the handheld range it documents (1.5 to 4 deg/s,
  // 0.35 to 0.56). A fixed line, so a clip is an interview or not whatever else is in the scan.
  var SHAKE_LIMIT = 0.6;
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

  // In this Mac's time zone. The engine sends every time with its offset or a Z, so a clip whose sidecar was left
  // behind (container time, in UTC) reads the same as one that kept it.
  function fmtDate(v) {
    if (v === null || v === undefined || v === '') { return ''; }
    var t = typeof v === 'number' ? v : Date.parse(v);
    if (t !== t) { return typeof v === 'number' ? '' : String(v).slice(0, 16).replace('T', ' '); }
    var d = new Date(t);
    return localDate(d) + ' ' + pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2);
  }

  function fmtText(v) { return v === null || v === undefined ? '' : String(v); }

  function fmtCount(v) { return typeof v === 'number' ? String(v) : ''; }

  function fmtShutter(v) {
    if (typeof v !== 'number' || !(v > 0)) { return ''; }
    return v >= 0.3 ? v.toFixed(1) + ' s' : '1/' + Math.round(1 / v);
  }

  function fmtAperture(v) { return typeof v === 'number' ? 'f/' + (v % 1 ? v.toFixed(1) : v) : ''; }

  var SHOT_WORD = { medium: 'Medium', wide: 'Wide' };
  var SHOT_RANK = { medium: 0, wide: 1 };

  function fmtShot(v) { return SHOT_WORD[v] || ''; }

  function fmtColour(v) { return v ? v.charAt(0).toUpperCase() + v.slice(1) : ''; }

  // ---------------------------------------------------------------- columns

  // words: bucket names from the highest values to the lowest, for "Sort into Bins" and the foot's verdict.
  // hidden: off by default, switchable from the menu. A hidden column still shows while the view sorts by it.
  var COLUMNS = [
    { key: 'thumb', label: '', width: 74, kind: 'thumb', sortable: false, fixed: true },
    { key: 'name', label: 'Name', width: 120, kind: 'text', grow: true, fixed: true, tip: 'File name.' },
    { key: 'dupGroup', label: 'Group', width: 48, kind: 'number', fmt: fmtText, onlyWithGroups: true, fixed: true, tip: 'Similar shots, as the engine grouped them.' },
    { key: 'durationS', label: 'Duration', width: 66, kind: 'number', fmt: fmtDuration, words: ['Longest', 'Longer', 'Middle', 'Shorter', 'Shortest'], tip: 'Duration.' },
    { key: 'sharpness', label: 'Sharpness', width: 72, kind: 'number', fmt: fixed(3), words: ['Sharpest', 'Sharper', 'Middle', 'Softer', 'Softest'],
      tip: 'Fine detail in the sharpest tiles of one decoded moment, at native resolution, normalised by local contrast. It compares clips; it says nothing about the rest of the take.' },
    { key: 'luma', label: 'Brightness', width: 74, kind: 'number', fmt: fixed(2), words: ['Brightest', 'Brighter', 'Middle', 'Darker', 'Darkest'], tip: 'Mean luma of one decoded moment, 0 to 1. Log footage reads differently from graded footage.' },
    { key: 'motionProxy', label: 'Motion', width: 58, kind: 'number', fmt: fixed(3), words: ['Most motion', 'More motion', 'Middle', 'Less motion', 'Least motion'], tip: 'Spread of compressed frame sizes along the clip, 0 to 1. A stand-in for motion read from the file structure; no pixels are decoded.' },
    { key: 'audioDb', label: 'Loudness', width: 66, kind: 'number', fmt: fixed(1), words: ['Loudest', 'Louder', 'Middle', 'Quieter', 'Quietest'], tip: 'Mean level in dB of the loudest channel, from sampled windows, not a full read. Empty when the clip has no audio or a track couldn\'t be read.' },
    { key: 'createdAt', label: 'Date', width: 132, kind: 'date', fmt: fmtDate, words: ['Latest', 'Later', 'Middle', 'Earlier', 'Earliest'], tip: 'When the clip was recorded, by the camera\'s clock, shown in this Mac\'s time zone.' },
    { key: 'camera', label: 'Camera', width: 112, kind: 'text', tip: 'Maker and model.' },
    { key: 'colorName', label: 'Colour', width: 72, kind: 'color', fmt: fmtColour, sortKey: 'rainbow', natural: 1,
      tip: 'The dominant colours of up to three frames, strongest first. S-Log3 that the camera names is turned back into normal colour before it is measured. Hover for the family. It describes the picture, nothing more.' },
    { key: 'clipHighPct', label: 'Highlights', width: 62, kind: 'number', hidden: true, fmt: fixed(2), words: ['Most clipped', 'More clipped', 'Middle', 'Less clipped', 'Least clipped'], tip: 'Percent of pixels at the top extreme, in one decoded moment.' },
    { key: 'clipLowPct', label: 'Shadows', width: 58, kind: 'number', hidden: true, fmt: fixed(2), words: ['Most crushed', 'More crushed', 'Middle', 'Less crushed', 'Least crushed'], tip: 'Percent of pixels at the bottom extreme, in one decoded moment.' },
    { key: 'lens', label: 'Lens', width: 130, kind: 'text', hidden: true, tip: 'From embedded metadata or the Sony sidecar.' },
    { key: 'codec', label: 'Codec', width: 60, kind: 'text', hidden: true },
    { key: 'pixels', label: 'Resolution', width: 84, kind: 'number', hidden: true, fmt: null, tip: 'Display size after rotation.' },
    { key: 'people', label: 'People', width: 52, kind: 'number', hidden: true, fmt: fmtCount, words: ['Most people', 'More people', 'Middle', 'Fewer people', 'Fewest people'], tip: 'The most people seen in any one moment read. A count of bodies in the frame, not who they are.' },
    { key: 'faces', label: 'Faces', width: 48, kind: 'number', hidden: true, fmt: fmtCount, words: ['Most faces', 'More faces', 'Middle', 'Fewer faces', 'Fewest faces'], tip: 'The most faces seen in any one moment read. A count of faces, never who they are.' },
    { key: 'shotSize', label: 'Shot', width: 66, kind: 'text', hidden: true, fmt: fmtShot, sortKey: 'shotRank', natural: 1, tip: 'Medium when someone fills the frame from about the waist up, or closer; wide when people are small in it. Judged by the size of a head. Blank when no one was seen.' },
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
    return (col.fmt || fmtText)(row[col.key]);
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

  // A text column as numbers: each distinct word gets its place in the collator's order, words it calls equal share
  // one, and empty is NaN. The collator then runs once per distinct word, not on every comparison of a sort. Kept per
  // column and built again only when one of its values changes, so a scan that fills other columns doesn't touch it.
  var rankCache = new Map();

  function textRanks(rows, key) {
    var hit = rankCache.get(key), n = rows.length, vals = new Array(n), same = !!hit && hit.vals.length === n, i, v;
    for (i = 0; i < n; i++) {
      v = rows[i][key];
      vals[i] = v === null || v === undefined || v === '' ? null : String(v);
      if (same && vals[i] !== hit.vals[i]) { same = false; }
    }
    if (same) { return hit.ranks; }
    var place = new Map();
    for (i = 0; i < n; i++) { if (vals[i] !== null) { place.set(vals[i], 0); } }
    var words = Array.from(place.keys()).sort(collator.compare), at = 0;
    for (i = 0; i < words.length; i++) {
      if (i && collator.compare(words[i - 1], words[i]) !== 0) { at++; }
      place.set(words[i], at);
    }
    var ranks = new Float64Array(n);
    for (i = 0; i < n; i++) { ranks[i] = vals[i] === null ? NaN : place.get(vals[i]); }
    rankCache.set(key, { vals: vals, ranks: ranks });
    return ranks;
  }

  // spec: [{key, dir}], dir 1 ascending or -1 descending. Empty values go last in both directions, and equal rows
  // keep their scan order, so a sort is stable and repeatable. Every key is a number by the time it is compared.
  function sortOrder(rows, order, spec) {
    if (!spec.length) { return order; }
    var n = rows.length, keys = [], s, c, i, r;
    for (s = 0; s < spec.length; s++) {
      c = COLUMN[spec[s].key];
      if (isText(c)) {
        keys.push({ vals: textRanks(rows, c.key), dir: spec[s].dir });
      } else {
        var nums = new Float64Array(n), field = c.sortKey || (c.kind === 'date' ? 'time' : c.key);
        for (i = 0; i < n; i++) {
          r = rows[i][field];
          nums[i] = r === null || r === undefined ? NaN : Number(r);
        }
        keys.push({ vals: nums, dir: spec[s].dir });
      }
    }
    var k0 = keys.length;
    return order.sort(function (a, b) {
      for (var j = 0; j < k0; j++) {
        var K = keys[j], x = K.vals[a], y = K.vals[b], xn = x !== x, yn = y !== y;
        if (xn || yn) {
          if (xn && yn) { continue; }
          return xn ? 1 : -1;
        }
        if (x !== y) { return (x < y ? -1 : 1) * K.dir; }
      }
      return a - b;
    });
  }

  // ---------------------------------------------------------------- show and sort

  // Two questions, each with its own menu: what to show, and in what order. Either works with the other. A colour dot
  // narrows what is shown, and a search narrows it again. Every tip says what is really measured.

  function known(key) {
    return function (r) { var v = r[key]; return v !== null && v !== undefined; };
  }

  // tip: what it really checks. says: the foot's words while it is on. none: when the scan has nothing for it.
  var SHOWS = [
    { id: 'interviews', label: 'Interviews', section: 'people',
      needs: known('speech'), none: 'No clip has sound and face data, so there is nothing to go on.',
      filter: function (r) {
        return r.speech === true && r.faces > 0 && r.durationS >= INTERVIEW_MIN_S && (typeof r.shake !== 'number' || r.shake <= SHAKE_LIMIT);
      },
      says: 'Speech and a face, ' + INTERVIEW_MIN_S + ' seconds or longer.',
      tip: 'Speech heard and a face seen, ' + INTERVIEW_MIN_S + ' seconds or longer. Where the camera recorded its movement, a clip shakier than a handheld camera is left out. A vlog can pass too.' },
    { id: 'people', label: 'People', section: 'people',
      needs: known('people'), none: 'No clip has people data, so there is nothing to go on.',
      filter: function (r) { return r.people > 0; },
      says: 'Someone seen in the frames looked at.',
      tip: 'Someone was seen in at least one of the three frames looked at in each clip.' },
    { id: 'nopeople', label: 'No people', section: 'people',
      needs: known('people'), none: 'No clip has people data, so there is nothing to go on.',
      filter: function (r) { return r.people === 0; },
      says: 'No one seen in the frames looked at.',
      tip: 'No one was seen in the three frames looked at. Someone can still appear between them.' },
    { id: 'mediums', label: 'Mediums', section: 'people',
      needs: known('shotSize'), none: 'No clip has shot size data, so there is nothing to go on.',
      filter: function (r) { return r.shotSize === 'medium'; },
      says: 'Someone from the waist up, or closer.',
      tip: 'Someone from about the waist up, or closer, judged by the size of their head in the frame.' },
    { id: 'wides', label: 'Wides', section: 'people',
      needs: known('shotSize'), none: 'No clip has shot size data, so there is nothing to go on.',
      filter: function (r) { return r.shotSize === 'wide'; },
      says: 'People small in the frame.',
      tip: 'People small in the frame. Scenery with no one in it is under No people instead.' },
    { id: 'speech', label: 'Speech', section: 'sound',
      needs: known('speech'), none: 'No clip has sound data, so there is nothing to go on.',
      filter: function (r) { return r.speech === true; },
      says: 'Speech heard in the audio sampled.',
      tip: 'Speech heard in short stretches of the audio. Nothing is transcribed.' },
    { id: 'music', label: 'Music', section: 'sound',
      needs: known('music'), none: 'No clip has sound data, so there is nothing to go on.',
      filter: function (r) { return r.music === true; },
      says: 'Music heard in the audio sampled.',
      tip: 'Music heard in short stretches of the audio.' },
    { id: 'silent', label: 'Silent', section: 'sound',
      filter: function (r) { return r.hasAudio === false || r.silent === true; },
      says: 'No audio, or silence wherever it was sampled.',
      tip: 'No audio track, or silence in every stretch listened to. Clips whose audio could not be read are left out.' },
    { id: 'onscreen', label: 'Text on screen', section: 'picture',
      needs: known('text'), none: 'No clip has text data, so there is nothing to go on.',
      filter: function (r) { return !!(r.text && r.text.length); },
      says: 'Words read off the frames looked at.',
      tip: 'Signs, titles, packaging, slates: words of four letters or more. About half of readable text is found, so a missing word proves nothing.' },
    { id: 'similar', label: 'Similar shots', section: 'picture', group: true,
      needs: function (r) { return r.similar !== undefined; }, none: 'No similar shots in this scan.',
      waiting: 'Similar shots come last, once every clip has been looked at.',
      says: 'Clips that look alike, side by side.',
      tip: 'Clips whose frames look alike, kept together: takes of one set-up, or two similar places. It does not pick the best take.' }
  ];
  var SHOW = {};
  SHOWS.forEach(function (s) { SHOW[s.id] = s; });

  // The Sort menu: a column, the way it starts, and how each way reads. Any other column sorts from its header.
  var SORTS = [
    { key: 'createdAt', label: 'Shoot order', dir: 1, ways: ['Earliest first', 'Latest first'] },
    { key: 'durationS', label: 'Duration', dir: -1, ways: ['Longest first', 'Shortest first'] },
    { key: 'sharpness', label: 'Sharpness', dir: -1, ways: ['Sharpest first', 'Softest first'] },
    { key: 'luma', label: 'Brightness', dir: -1, ways: ['Brightest first', 'Darkest first'] },
    { key: 'clipHighPct', label: 'Highlights', dir: -1, ways: ['Most clipped first', 'Least clipped first'] },
    { key: 'motionProxy', label: 'Motion', dir: -1, ways: ['Most motion first', 'Least motion first'] },
    { key: 'shake', label: 'Camera shake', dir: 1, ways: ['Steadiest first', 'Shakiest first'] },
    { key: 'audioDb', label: 'Loudness', dir: -1, ways: ['Loudest first', 'Quietest first'] },
    { key: 'colorName', label: 'Colour', dir: 1, ways: ['Rainbow order', 'Rainbow reversed'] },
    { key: 'name', label: 'Name', dir: 1, ways: ['A to Z', 'Z to A'] }
  ];
  var SORT = {};
  SORTS.forEach(function (s) { SORT[s.key] = s; });

  var FAMILIES = [
    { id: 'red', word: 'Red', dot: '#d9483b' }, { id: 'orange', word: 'Orange', dot: '#e8873a' }, { id: 'yellow', word: 'Yellow', dot: '#e3c24a' },
    { id: 'green', word: 'Green', dot: '#5aa65c' }, { id: 'teal', word: 'Teal', dot: '#35a79c' }, { id: 'blue', word: 'Blue', dot: '#3f83d6' },
    { id: 'purple', word: 'Purple', dot: '#8a63c9' }, { id: 'pink', word: 'Pink', dot: '#df6fa4' }, { id: 'neutral', word: 'Neutral', dot: '#9a9aa0' }
  ];
  var FAMILY = {};
  FAMILIES.forEach(function (f) { FAMILY[f.id] = f; });

  // Hues are Oklab degrees, as the engine sends them: red starts at 20, and pink wraps across zero. Flat clips, such as log, run the spectrum again after the vivid
  // ones, so they keep their hue without breaking the bands. An all-log shoot is simply one muted rainbow.
  // Neutral clips follow every hue, from light to dark.
  function rainbowKey(r) {
    if (typeof r.colorHue === 'number' && r.colorName !== 'neutral') {
      return (r.colorHue + 340) % 360 + (typeof r.colorChroma === 'number' && r.colorChroma < MUTED_CHROMA ? 400 : 0);
    }
    return typeof r.colorLight === 'number' ? 800 + (1 - r.colorLight) : null;
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
      r.hay = ' ' + fold(searchParts(r).join(' ')) + ' ';
      r.nameFold = fold(r.name).replace(/ /g, '');
      r.hayVersion = r.version;
    }
    return r.hay;
  }

  // Builds the search text of rows from `at` on while more() says there is time, and returns where it stopped. The
  // panel runs it when idle after a scan, so the first keystroke finds it ready.
  function warmSearch(rows, at, more) {
    var i = at;
    while (i < rows.length && more()) {
      for (var end = Math.min(rows.length, i + 200); i < end; i++) { hayOf(rows[i]); }
    }
    return i;
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

  // view: {show, sort, family}. opts: {tokens} from a search. Returns row indexes to show, and where groups start.
  function computeView(rows, view, now, opts) {
    var clock = now || function () { return Date.now(); };
    var t0 = clock(), show = view.show ? SHOW[view.show] : null, order = [], i, j;
    var groupCount = 0, hasGroups = !!(show && show.group), breaks = [];
    var tokens = opts && opts.tokens && opts.tokens.length ? opts.tokens : null, family = view.family || null;
    var keeps = function (r) {
      return (!family || (r.colorName || null) === family) && (!tokens || matches(r, tokens));
    };
    for (i = 0; i < rows.length; i++) { rows[i].dupGroup = null; }
    if (hasGroups) {
      var groups = engineGroups(rows);
      for (i = 0; i < groups.length; i++) {
        var members = groups[i].filter(function (at) { return keeps(rows[at]); });
        if (members.length < 2) { continue; }
        groupCount++;
        for (j = 0; j < members.length; j++) {
          rows[members[j]].dupGroup = groupCount;
          order.push(members[j]);
        }
      }
    } else {
      for (i = 0; i < rows.length; i++) {
        if ((!show || show.filter(rows[i])) && keeps(rows[i])) { order.push(i); }
      }
    }
    // Groups stay whole and in the engine's order. The sort orders the clips inside each one.
    sortOrder(rows, order, hasGroups ? [{ key: 'dupGroup', dir: 1 }].concat(view.sort) : view.sort);
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

  // Has this choice anything to work with yet? ok, waiting (the engine may still send it) or none (it won't).
  function dataStatus(rows, showId, running) {
    var show = showId ? SHOW[showId] : null;
    if (!show || !show.needs) { return 'ok'; }
    for (var i = 0; i < rows.length; i++) { if (show.needs(rows[i])) { return 'ok'; } }
    return running ? 'waiting' : 'none';
  }

  // The same for a sort: has any clip a value for it?
  function sortStatus(rows, key, running) {
    var col = COLUMN[key];
    if (!col) { return 'ok'; }
    for (var i = 0; i < rows.length; i++) { if (hasValue(rows[i], col)) { return 'ok'; } }
    return running ? 'waiting' : 'none';
  }

  // Every Show's count and whether it has anything to go on, in one pass over the rows, for the Show menu.
  // Returns {id: {n, known}}: known is false when no clip has the data the Show needs.
  function showCounts(rows) {
    var plain = SHOWS.filter(function (x) { return !x.group; }), k = plain.length, i, j, r;
    var filters = plain.map(function (x) { return x.filter; }), needs = plain.map(function (x) { return x.needs || null; });
    var n = new Int32Array(k), known = plain.map(function (x) { return !x.needs; }), unknown = known.filter(function (x) { return !x; }).length;
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      for (j = 0; j < k; j++) { if (filters[j](r)) { n[j]++; } }
      if (unknown) {
        for (j = 0; j < k; j++) { if (!known[j] && needs[j](r)) { known[j] = true; unknown--; } }
      }
    }
    var out = {};
    for (j = 0; j < k; j++) { out[plain[j].id] = { n: n[j], known: known[j] }; }
    SHOWS.forEach(function (x) {
      if (x.group) { out[x.id] = { n: showCount(rows, x.id), known: dataStatus(rows, x.id, false) === 'ok' }; }
    });
    return out;
  }

  // How many clips a Show would leave, for its menu.
  function showCount(rows, id) {
    var show = SHOW[id];
    if (show.group) { return engineGroups(rows).reduce(function (n, g) { return n + (g.length > 1 ? g.length : 0); }, 0); }
    var n = 0;
    for (var i = 0; i < rows.length; i++) { if (show.filter(rows[i])) { n++; } }
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

  // The one useful fact on a tile: why it is here (a search), else the value it is sorted by, else its length.
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

  // The way a column starts: the Sort menu's for its own sorts, else high to low for numbers and A to Z for words.
  function naturalDir(key) {
    var col = COLUMN[key];
    return SORT[key] ? SORT[key].dir : (col.natural || (col.kind === 'number' ? -1 : 1));
  }

  // One click sorts by that column, again flips it. Shift adds it as the next key, or flips it if already there.
  function nextSort(sort, key, shift) {
    var natural = naturalDir(key), at = -1;
    for (var i = 0; i < sort.length; i++) { if (sort[i].key === key) { at = i; } }
    if (shift) {
      var copy = sort.map(function (s) { return { key: s.key, dir: s.dir }; });
      if (at >= 0) { copy[at].dir = -copy[at].dir; } else { copy.push({ key: key, dir: natural }); }
      return copy;
    }
    if (sort.length === 1 && at === 0) { return [{ key: key, dir: -sort[0].dir }]; }
    return [{ key: key, dir: natural }];
  }

  // How one sort reads: Sharpest first, Softest first, Camera A to Z.
  function sortWords(s) {
    var known = SORT[s.key], c = COLUMN[s.key];
    if (known) { return known.ways[s.dir === known.dir ? 0 : 1]; }
    if (c.words) { return c.words[s.dir > 0 ? 4 : 0] + ' first'; }
    if (c.key === 'pixels') { return s.dir > 0 ? 'Smallest first' : 'Largest first'; }
    // A number with no words of its own, such as ISO, reads high to low, never Z to A.
    if (c.kind === 'number') { return c.label + (s.dir > 0 ? ' low to high' : ' high to low'); }
    return c.label + (s.dir > 0 ? ' A to Z' : ' Z to A');
  }

  // Sharpest first becomes sharpest first after a comma. A to Z and ISO stay as they are.
  function lowerFirst(s) { return /^[A-Z][A-Z ]/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1); }

  // The whole view in a few words: the foot's verdict and the name of the bin. Red, interviews, sharpest first.
  function viewName(view) {
    var parts = [], s = view.sort[0];
    if (view.family) { parts.push(FAMILY[view.family].word); }
    if (view.show) { parts.push(SHOW[view.show].label); }
    if (s && !(view.family && s.key === 'colorName')) { parts.push(sortWords(s)); }
    return parts.map(function (p, i) { return i ? lowerFirst(p) : p; }).join(', ');
  }

  // ---------------------------------------------------------------- bins

  // Sort into Bins follows the view. Similar shots: a bin per group. Colour: a bin per colour. Shoot order: a bin per day.
  // A word column such as Camera: a bin per value, when there are few enough. Otherwise a Show makes one bin of what it
  // shows, and a number sort makes five, from the top of the sort to the bottom.
  var MOST_VALUE_BINS = 20;

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
    var words = col.words.slice();
    if (dir > 0) { words.reverse(); }
    return words;
  }

  // Bins named by what the clips have, numbered in the order they first come. Clips with no value come last.
  function valueBuckets(rows, of, most) {
    var found = new Map(), without = [], out = [];
    rows.forEach(function (r) {
      var name = of(r);
      if (name === null || name === undefined || name === '') { without.push(r); return; }
      if (!found.has(name)) { found.set(name, []); }
      found.get(name).push(r);
    });
    if (most && found.size > most) { return null; }
    var width = String(found.size + 1).length < 2 ? 2 : String(found.size + 1).length;
    found.forEach(function (list, name) { out.push({ name: pad(out.length + 1, width) + ' ' + name, rows: list }); });
    if (without.length) { out.push({ name: pad(out.length + 1, width) + ' No value', rows: without }); }
    return out;
  }

  // Colours keep the rainbow's order, so Red stays before Blue whichever way the rows run.
  function colourBuckets(rows) {
    var byName = new Map(), out = [], without = [];
    rows.forEach(function (r) {
      var f = FAMILY[r.colorName];
      if (!f) { without.push(r); return; }
      if (!byName.has(f.id)) { byName.set(f.id, []); }
      byName.get(f.id).push(r);
    });
    FAMILIES.forEach(function (f) {
      if (byName.has(f.id)) { out.push({ name: pad(out.length + 1, 2) + ' ' + f.word, rows: byName.get(f.id) }); }
    });
    if (without.length) { out.push({ name: pad(out.length + 1, 2) + ' No value', rows: without }); }
    return out;
  }

  // What the bins would be, in words, before any rows: null when this view can't make bins.
  function binKind(view) {
    var show = view.show ? SHOW[view.show] : null, s = view.sort[0], col = s ? COLUMN[s.key] : null;
    if (show && show.group) { return 'groups'; }
    if (col && col.key === 'colorName') { return 'colours'; }
    if (col && col.kind === 'date') { return 'days'; }
    if (col && col.kind === 'text' && col.key !== 'name') { return 'values'; }
    if (show) { return 'one'; }
    if (col && col.words) { return 'fifths'; }
    return view.family ? 'one' : null;
  }

  // rows in view order. Returns [{name, rows}], or null when the view has nothing to make bins from.
  function bucketize(rows, view) {
    var kind = binKind(view), s = view.sort[0], col = s ? COLUMN[s.key] : null, i;
    if (!kind) { return null; }
    if (kind === 'groups') {
      var byGroup = new Map(), out = [];
      rows.forEach(function (r) {
        if (!byGroup.has(r.dupGroup)) { byGroup.set(r.dupGroup, []); }
        byGroup.get(r.dupGroup).push(r);
      });
      var width = Math.max(2, String(byGroup.size).length);
      byGroup.forEach(function (members) { out.push({ name: pad(out.length + 1, width) + ' Similar, ' + members.length + ' clips', rows: members }); });
      return out;
    }
    if (kind === 'colours') { return colourBuckets(rows); }
    if (kind === 'days') { return valueBuckets(rows, function (r) { return r.time === r.time ? localDate(new Date(r.time)) : null; }); }
    if (kind === 'values') {
      var values = valueBuckets(rows, function (r) { return cellText(r, col); }, MOST_VALUE_BINS);
      if (values) { return values; }
      if (!view.show) { return null; }
      kind = 'one';
    }
    if (kind === 'one') { return [{ name: '01 ' + (view.show ? SHOW[view.show].label : FAMILY[view.family].word), rows: rows }]; }
    var withValue = [], without = [], buckets = [], names = bucketNames(col, s.dir);
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
  // Labels use the panel's own words. Premiere keeps a label once a project has the field, so a project that had
  // Add Columns from 0.1 keeps the old names; the values are the same.
  var FIELDS = [
    { name: 'SelectRank', label: 'Select Rank' },
    { name: 'SelectSharpness', label: 'Select Sharpness' },
    { name: 'SelectLuma', label: 'Select Brightness' },
    { name: 'SelectClipHigh', label: 'Select Highlights' },
    { name: 'SelectMotion', label: 'Select Motion' },
    { name: 'SelectAudio', label: 'Select Loudness' },
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

  // rank is the 1-based place in the current view. dB is negative, and text would sort -9 above -30, so the value
  // starts with dB + 100, clamped to 0..999.9, for sorting, and then says the real level: 077.6 (-22.4 dB).
  function loudnessValue(db) {
    if (db === null || db === undefined || db !== db) { return ''; }
    return padFixed(Math.min(999.9, Math.max(0, db + 100)), 3, 1) + ' (' + Number(db).toFixed(1) + ' dB)';
  }

  function columnValues(row, rank, width) {
    return {
      SelectRank: pad(rank, width),
      SelectSharpness: padUnit(row.sharpness),
      SelectLuma: padUnit(row.luma),
      SelectClipHigh: padFixed(row.clipHighPct, 3, 2),
      SelectMotion: padUnit(row.motionProxy),
      SelectAudio: loudnessValue(row.audioDb),
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

  // Did every id the host moved come back from the bin it was sent to, and nothing else?
  // expected: [{name, ids}] that the host reported moving. res.buckets: what each bin holds now.
  function binsRead(expected, res) {
    var want = 0, matched = 0, extra = 0, confirmed = true;
    expected.forEach(function (bucket) {
      want += bucket.ids.length;
      var back = (res.buckets || []).filter(function (b) { return b.name === bucket.name; })[0];
      if (!back || !back.ids) { confirmed = false; return; }
      var inBin = {};
      back.ids.forEach(function (id) { inBin[String(id)] = true; });
      bucket.ids.forEach(function (id) {
        if (inBin[String(id)]) { matched++; delete inBin[String(id)]; }
      });
      extra += Object.keys(inBin).length;
    });
    return { expected: want, matched: confirmed ? matched : 0, confirmed: confirmed, extra: extra };
  }

  // Items sent in a write, however they are grouped: [[id, path]] lists in rows or buckets.
  function itemCount(sent) {
    if (sent.items) { return sent.items.length; }
    return (sent.rows || sent.buckets || []).reduce(function (n, r) { return n + r.items.length; }, 0);
  }

  // ---------------------------------------------------------------- batches

  // A write's results as its batches land, merged into one. unsent and error are set by whoever sends the batches.
  function writeAcc(kind) {
    var acc = { failed: [], skipped: [], unsent: 0, error: '' };
    if (kind === 'bins') { acc.moved = 0; acc.placed = []; acc.top = null; acc.root = null; } else { acc.changed = 0; }
    if (kind === 'columns') { acc.matched = 0; acc.columns = null; }
    return acc;
  }

  function addBatch(kind, acc, res) {
    acc.failed = acc.failed.concat(res.failed || []);
    acc.skipped = acc.skipped.concat(res.skipped || []);
    if (kind === 'bins') {
      acc.moved += res.moved || 0;
      if (res.top) { acc.top = res.top; acc.root = res.root; }
      (res.buckets || []).forEach(function (b) {
        var have = acc.placed.filter(function (p) { return p.name === b.name; })[0];
        if (!have) { have = { name: b.name, ids: [] }; acc.placed.push(have); }
        have.ids = have.ids.concat(b.moved || []);
      });
      return acc;
    }
    acc.changed += res.changed || 0;
    if (kind === 'columns') {
      // One batch that could not confirm makes the whole write unconfirmed.
      acc.matched = typeof res.matched === 'number' && acc.matched !== null ? acc.matched + res.matched : null;
      if (res.columns && !acc.columns) { acc.columns = res.columns; }
    }
    return acc;
  }

  // A batch of moves [{name, pair}], grouped by bin in the order they come, as the host takes them.
  function groupMoves(part) {
    var out = [], at = {};
    part.forEach(function (m) {
      if (!Object.prototype.hasOwnProperty.call(at, m.name)) { at[m.name] = out.length; out.push({ name: m.name, items: [] }); }
      out[at[m.name]].items.push(m.pair);
    });
    return out;
  }

  // A host refusal says "Nothing was changed." for a single call. Part way through a write, that is no longer true.
  function refusalWords(message) {
    return String(message || '').replace(/\s*Nothing (was|has been) (written|changed|moved|imported)\.?\s*$/, '');
  }

  // The fields and words of a finished write. Green only when what was read back matches what was sent, and every item
  // sent was tried. kind: label, columns or bins. sent: everything the write meant to send, as items [[id, path]].
  // res: the batches merged: changed or moved, matched, failed, skipped (changed in the project since), unsent (never
  // sent, after Stop or a refusal), error (why the rest was not sent), buckets and columns (read back at the end).
  function writeOutcome(kind, sent, res, extra) {
    var failed = res.failed || [], skipped = res.skipped || [], unsent = res.unsent || 0, why = refusalWords(res.error);
    var want = itemCount(sent), whole = !failed.length && !skipped.length && !unsent && !why, files = 'Your files weren\'t touched.';
    var keep = { failed: failed.concat(skipped) };
    function rest(line) {
      var bits = [line];
      if (skipped.length) { bits.push(plural(skipped.length, 'item') + (skipped.length === 1 ? ' was' : ' were') + ' left alone: ' + (skipped.length === 1 ? 'it has' : 'they have') + ' changed in the project since Select found ' + (skipped.length === 1 ? 'it' : 'them') + '.'); }
      if (why) { bits.push('The rest weren\'t sent: ' + why); } else if (unsent) { bits.push('Stopped, so the last ' + plural(unsent, 'item') + (unsent === 1 ? ' wasn\'t' : ' weren\'t') + ' written.'); }
      bits.push(files);
      return bits.filter(Boolean).join(' ');
    }
    function out(kindWord, verdict, sentence, undo) {
      return { kind: kindWord, green: kindWord === 'proved', verdict: verdict, sentence: sentence, undo: undo, failed: kindWord === 'proved' ? [] : keep.failed };
    }
    var n;
    if (kind === 'bins') {
      n = res.moved || 0;
      var read = binsRead(res.placed || [], res), bins = sent.buckets.length;
      if (whole && read.confirmed && read.matched === want && !read.extra) {
        return out('proved', 'Sorted into ' + plural(bins, 'bin'), plural(read.matched, 'clip') + ' moved. ' + files, true);
      }
      if (!n) { return out('partial', 'Nothing moved', rest('Premiere did not move any clips.'), false); }
      if (!read.confirmed) { return out('partial', 'Moved, not confirmed', rest('Premiere moved ' + plural(n, 'clip') + ' but did not confirm where they landed, so check the bins.'), true); }
      var off = read.expected - read.matched + read.extra + failed.length;
      return out('partial', 'Moved ' + fmtInt(read.matched) + ' of ' + plural(want, 'clip'), rest(off ? plural(off, 'clip') + ' did not land where ' + (off === 1 ? 'it' : 'they') + ' should.' : ''), true);
    }
    if (kind === 'columns') {
      var added = sent.fields.length;
      n = res.changed || 0;
      var matched = typeof res.matched === 'number' ? res.matched : null, shown = !!(res.columns && res.columns.shown);
      if (whole && matched === want && shown) {
        return out('proved', 'Added ' + plural(added, 'column'), plural(matched, 'clip') + ' updated. ' + files, true);
      }
      if (!n) { return out('partial', 'Nothing written', rest('Premiere did not take the columns.'), false); }
      if (matched === null) { return out('partial', 'Written, not confirmed', rest('Premiere took the columns on ' + plural(n, 'clip') + ' but did not confirm them, so check a few.'), true); }
      if (whole && matched === want) { return out('partial', 'Added, not showing', 'The values are in. Turn the columns on with Metadata Display in the Project panel menu.', true); }
      var unread = n - matched + failed.length;
      return out('partial', 'Wrote ' + fmtInt(matched) + ' of ' + plural(want, 'clip'), rest(unread ? plural(unread, 'clip') + ' did not read back the same.' : ''), true);
    }
    // Labels: the host reads each label back as it sets it, and `changed` counts only those that matched.
    n = res.changed || 0;
    if (whole && n === want) {
      return out('proved', 'Labelled ' + plural(n, 'clip') + ' ' + extra, 'Every label read back. ' + files, true);
    }
    if (!n) { return out('partial', 'Nothing labelled', rest('Premiere did not change any labels.'), false); }
    return out('partial', 'Labelled ' + fmtInt(n) + ' of ' + plural(want, 'clip'), rest(failed.length ? plural(failed.length, 'clip') + ' did not read back the same.' : ''), true);
  }

  // Result of Undo Write. Never green: putting things back proves nothing new. more: an earlier write is still in reach.
  function undoOutcome(res, more) {
    var failed = countOf(res.failed), restored = res.restored || 0, unsent = res.unsent || 0, why = refusalWords(res.error), bits = [];
    if (restored) { bits.push(plural(restored, 'item') + ' back where ' + (restored === 1 ? 'it was' : 'they were') + '.'); }
    if (res.skipped) { bits.push(fmtInt(res.skipped) + ' changed since and left alone.'); }
    if (failed) { bits.push(plural(failed, 'item') + ' could not go back.'); }
    if (why) { bits.push('The rest weren\'t sent: ' + why); } else if (unsent) { bits.push('Stopped, so ' + plural(unsent, 'item') + (unsent === 1 ? ' is' : ' are') + ' still to go back. Undo Write again finishes it.'); }
    if (res.binRemoved === false) { bits.push('The SELECT bin is still in the project.'); }
    if (!bits.length) { bits.push('There was nothing left to put back.'); }
    var verdict = !restored ? 'Nothing went back' : (failed || unsent || why ? 'Partly undone' : 'Undone');
    var clean = restored && !failed && !res.skipped && !unsent && !why && res.binRemoved !== false;
    return { kind: clean ? 'undone' : 'partial', verdict: verdict, sentence: bits.join(' '), undo: !!more, failed: res.failed || [] };
  }

  // ---------------------------------------------------------------- undo records

  // Premiere's own undo cannot take back a batch (see app.js), so every write keeps a record of what it replaced, on
  // disk, newest last. Undo Write reverses the newest one still there. This many are kept per project.
  var UNDO_KEEP = 10;
  // Project items per host call. Premiere stays usable between calls, and Stop takes effect between them.
  var BATCH = 100;

  function batches(list, size) {
    var out = [];
    for (var i = 0; i < list.length; i += size) { out.push(list.slice(i, i + size)); }
    return out;
  }

  // A short, stable name for a project's records: two 32-bit FNV-1a hashes of its path. The record keeps the path too,
  // and a record whose path differs is ignored.
  function projectKey(path) {
    var s = pathKey(path), a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995, i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = Math.imul(b ^ c, 0x01000193) >>> 0;
      b = (b ^ (b >>> 15)) >>> 0;
    }
    return ('0000000' + a.toString(16)).slice(-8) + ('0000000' + b.toString(16)).slice(-8);
  }

  // What Undo Write will do, in a sentence, for what is still left of a record.
  function undoWords(entry) {
    var n = entry.restore && entry.restore.items ? entry.restore.items.length : 0, m = entry.meta || {};
    if (entry.kind === 'label') { return 'Takes ' + (m.label || 'the label') + ' off ' + plural(n, 'clip') + ' and puts back the labels they had before.'; }
    if (entry.kind === 'columns') { return 'Puts back what the Select columns held on ' + plural(n, 'clip') + ' before this write.'; }
    if (entry.kind === 'bins') { return 'Moves ' + plural(n, 'clip') + ' back to the bins they came from, and removes ' + (m.root || 'the SELECT bin') + ' once it is empty.'; }
    return 'Puts back ' + plural(n, 'item') + '.';
  }

  // today at 14:32, yesterday at 09:05, 2026-10-30 at 18:00, in this Mac's time zone.
  function whenWords(iso, now) {
    var t = Date.parse(iso);
    if (t !== t) { return 'an earlier session'; }
    var d = new Date(t), today = new Date(now === undefined ? Date.now() : now), day = localDate(d);
    var at = ' at ' + pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2);
    if (day === localDate(today)) { return 'today' + at; }
    if (day === localDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1))) { return 'yesterday' + at; }
    return day + at;
  }

  // The sheet's line on how far Undo Write reaches, before a write. held: records already kept for this project.
  function undoReach(held) {
    var line = 'Undo Write in Select takes back the last ' + UNDO_KEEP + ' writes to this project, newest first, and keeps them when the panel reloads.';
    return held >= UNDO_KEEP ? line + ' This one pushes the oldest of them out of reach.' : line;
  }

  // ---------------------------------------------------------------- the selection

  // Where a Selection scan's clips came from, before the scan runs. picked: {clips, where: [bin names, '' for the top]}.
  function pickedWords(picked) {
    if (!picked || !picked.clips) { return ''; }
    var where = picked.where || [], named = where.map(function (w) { return w ? quoted(w) : 'the top of the project'; });
    var place = !named.length ? '' : named.length <= 3 ? ' in ' + listWords(named) : ' in ' + fmtInt(named.length) + ' bins';
    return 'Scanning the ' + plural(picked.clips, 'clip') + ' selected' + place + '.';
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
    var show = view.show ? SHOW[view.show] : null;
    if ((show && (show.needs || show.group)) || view.family || (tokens && tokens.length)) { return true; }
    return view.sort.some(function (s) { return TIER2_KEYS[s.key] === 1; });
  }

  // What the view is waiting on, in a few words for the foot.
  function waitingOn(view, tokens) {
    if (view.show) { return SHOW[view.show].label; }
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

  // A write or an Undo Write while it runs. w: {kind: write or undo, verb, unit, done, total, stopping}.
  function writingState(busy, w) {
    if (!w || !w.total) { return { kind: 'writing', mark: 'running', verdict: busy, sentence: 'Premiere is busy for a moment.', actions: [] }; }
    var many = w.total > BATCH, unit = w.unit || 'clip';
    var verdict = w.stopping ? 'Stopping after this batch' : w.verb + ' ' + (w.done ? fmtInt(w.done) + ' of ' : '') + plural(w.total, unit);
    if (!many) { return { kind: 'writing', mark: 'running', verdict: verdict, sentence: 'Premiere is busy for a moment.', actions: [] }; }
    var after = w.kind === 'undo' ? 'what isn\'t back yet stays for the next Undo Write.' : 'Undo Write takes back what was written.';
    return { kind: 'writing', mark: 'running', verdict: verdict, sentence: 'Premiere takes them ' + BATCH + ' at a time. Stop ends it after this batch, and ' + after,
      meter: Math.min(1, w.done / w.total), actions: w.stopping ? [] : ['stop'] };
  }

  // The bottom line. Pure: every word of the foot comes from here, so tests read what a person would and no view decides.
  // f: {source, project, connected, listing, listed, listStop, busy, write, outcome, scan: {state, failure, seconds,
  //     stopping}, store, rows, shown, selected, view, groupCount}
  function footState(f) {
    var sc = f.scan, st = f.store, total = f.rows;
    var writes = ['label', 'columns', 'bins'];
    var sorted = !!binKind(f.view);
    var running = !!(sc && sc.state === 'Scanning');
    if (f.busy) { return writingState(f.busy, f.write); }
    if (f.listing) {
      return { kind: 'listing', mark: 'running', verdict: 'Listing clips', sentence: f.listed ? plural(f.listed, 'video file') + ' found so far.' : '', actions: f.listStop ? ['stop'] : [] };
    }
    if (f.outcome) {
      var o = f.outcome, list = o.green ? ['undo'] : (o.undo ? ['undo'] : []);
      if (!o.green) {
        if (o.failed && o.failed.length) { list.unshift('details'); }
        if (o.kind === 'undone' || !o.undo) { list = list.concat(writes); }
      }
      var result = { kind: o.kind, mark: o.green ? 'seal' : (o.kind === 'undone' ? 'done' : 'look'), verdict: o.verdict, sentence: o.sentence, green: !!o.green, actions: list, primary: list.indexOf('bins') >= 0 ? 'bins' : null, binsOff: !sorted };
      // A write made while the scan runs leaves the scan's Stop and its meter in place.
      if (running && !sc.stopping) {
        var pr = progress(st);
        result.actions = ['stop'].concat(list);
        result.meter = pr.finished >= st.total && st.total ? understandingShare(st).share : pr.share;
      }
      return result;
    }
    if (running) {
      var p = progress(st), rate = Math.round(p.finished / Math.max(sc.seconds, 0.001));
      // Stage three: every clip is usable, and the engine is still looking closer. The panel works, so it says so quietly.
      if (p.finished >= st.total && st.total && !sc.stopping) {
        var u = understandingShare(st), hold = !u.landed && !!f.needsTier2;
        var on = waitingOn(f.view, f.query ? [f.query] : null);
        return { kind: 'understanding', mark: 'running', verdict: viewName(f.view) || plural(st.total, 'clip') + ' read', sentence: 'Finding people, words, sound and colour: ' + fmtInt(u.done) + ' of ' + fmtInt(u.due), meter: u.share,
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
    var show = f.view.show ? SHOW[f.view.show] : null;
    var words = show ? (f.status === 'none' ? show.none : show.says) : '';
    var seconds = sc.seconds < 10 ? sc.seconds.toFixed(1) : String(Math.round(sc.seconds));
    var head = show && show.group ? plural(f.groupCount, 'group') + ', ' + count + '.' : (f.shown === total ? clips + ' in ' + seconds + ' s.' : count + (f.query ? ' match ' + quoted(f.query) + '.' : '.'));
    var line = selected ? fmtInt(selected) + ' of ' + clips + ' selected. Label, Add Columns and Sort into Bins use these.' : withBlank(words ? head + ' ' + words : (f.shown === total && !viewName(f.view) ? 'Took ' + seconds + ' s. Choose what to show, or how to sort, above.' : head));
    return { kind: 'finished', mark: 'done', verdict: viewName(f.view) || clips + ' read', sentence: line, actions: writes, primary: 'bins', binsOff: !sorted };
  }

  return {
    INTERVIEW_MIN_S: INTERVIEW_MIN_S,
    COLUMNS: COLUMNS,
    COLUMN: COLUMN,
    SHOWS: SHOWS,
    SHOW: SHOW,
    SORTS: SORTS,
    SORT: SORT,
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
    computeView: computeView,
    nextSort: nextSort,
    viewName: viewName,
    sortWords: sortWords,
    naturalDir: naturalDir,
    binKind: binKind,
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
    itemCount: itemCount,
    writeAcc: writeAcc,
    addBatch: addBatch,
    groupMoves: groupMoves,
    refusalWords: refusalWords,
    UNDO_KEEP: UNDO_KEEP,
    BATCH: BATCH,
    SHAKE_LIMIT: SHAKE_LIMIT,
    batches: batches,
    projectKey: projectKey,
    undoWords: undoWords,
    whenWords: whenWords,
    undoReach: undoReach,
    pickedWords: pickedWords,
    fmtDate: fmtDate,
    footState: footState,
    FAMILIES: FAMILIES,
    FAMILY: FAMILY,
    rainbowKey: rainbowKey,
    searchTokens: searchTokens,
    matches: matches,
    matchedWord: matchedWord,
    dataStatus: dataStatus,
    showCount: showCount,
    showCounts: showCounts,
    warmSearch: warmSearch,
    TIER2_SORT: TIER2_KEYS,
    sortStatus: sortStatus,
    familyCounts: familyCounts,
    viewNeedsTier2: viewNeedsTier2,
    columnFields: columnFields,
    understandingShare: understandingShare,
    tileFact: tileFact,
    quoted: quoted
  };
});
