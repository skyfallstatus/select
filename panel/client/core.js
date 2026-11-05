// Select panel logic with no DOM and no Node dependency. Loaded by the panel and by the tests.
(function (root, factory) {
  var api = factory();
  root.SelectCore = api;
  if (typeof module === 'object' && module && module.exports) { module.exports = api; }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // Interviews: speech heard with at least this confidence, a face, a medium shot, and at least this long. Judged by eye
  // on the 326 clips of the two test projects with any speech (4 Nov 2026): 46 of 46 interviews found, 1 clip that
  // isn't. Shake is no longer asked: handheld interviews were lost to it, and nothing it kept out was an interview.
  var INTERVIEW_MIN_S = 15;
  var INTERVIEW_SPEECH = 0.7;
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
    { key: 'createdAt', label: 'Date', width: 122, kind: 'date', fmt: fmtDate, words: ['Latest', 'Later', 'Middle', 'Earlier', 'Earliest'], tip: 'When the clip was recorded, by the camera\'s clock, shown in this Mac\'s time zone.' },
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

  // The Date cell's tooltip, only when the date came from the file name: a copied file often carries the day it was
  // copied, so the date the file itself holds is said too.
  function dateNote(row) {
    if (row.dateSource !== 'fileName') { return ''; }
    var file = row.containerDate ? fmtDate(row.containerDate) : '';
    return (row.dateOnly ? 'Day only, from the file name' : 'From the file name') + (file ? '; the file says ' + file : '');
  }

  // The table's columns in the editor's order: the picture, the name and the group first, always, then the rest as
  // saved. A saved key no column has any more is dropped, and a column the saved order doesn't know goes at the end.
  function orderColumns(columns, saved) {
    var out = [], rest = [], byKey = {}, placed = {};
    columns.forEach(function (c) {
      if (c.fixed) { out.push(c); } else { rest.push(c); byKey[c.key] = c; }
    });
    (Array.isArray(saved) ? saved : []).forEach(function (k) {
      if (typeof k === 'string' && byKey[k] && !placed[k]) { placed[k] = true; out.push(byKey[k]); }
    });
    rest.forEach(function (c) { if (!placed[c.key]) { out.push(c); } });
    return out;
  }

  // keys: every movable column in order, shown or not. Returns them with `key` moved to just after `after`, or first
  // when after is null, so a column switched off keeps its place among the others.
  function moveColumn(keys, key, after) {
    if (key === after) { return keys.slice(); }
    var out = keys.filter(function (k) { return k !== key; }), at = after === null ? 0 : out.indexOf(after) + 1;
    if (at === 0 && after !== null) { return keys.slice(); }
    out.splice(at, 0, key);
    return out;
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
    return { rows: [], byKey: new Map(), total: 0, tier0: 0, tier1: 0, errors: 0, cached: 0, bad: 0, start: null, done: null, noPicture: { clips: 0, noDecoder: 0, noFfmpeg: 0 }, tier2: 0, tier2Failed: 0, groups: null, notRead: 0 };
  }

  function addRow(store, path) {
    var key = pathKey(path), row = store.byKey.get(key);
    if (row) { return row; }
    row = { rowId: store.rows.length, path: path, key: key, name: baseName(path), ids: [], tier: -1, error: null, time: NaN };
    store.rows.push(row);
    store.byKey.set(key, row);
    return row;
  }

  // Rows appear as soon as the paths are known, before the engine says anything. An item from the project says the bins
  // it sits in (bin: 'Day 2/A cam'), kept for search.
  function addItems(store, items) {
    for (var i = 0; i < items.length; i++) {
      var row = addRow(store, items[i].path);
      if (items[i].id && row.ids.indexOf(items[i].id) === -1) { row.ids.push(items[i].id); }
      if (items[i].bin) {
        if (!row.binPaths) { row.binPaths = []; }
        if (row.binPaths.indexOf(items[i].bin) === -1) { row.binPaths.push(items[i].bin); }
      }
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
      case 'uncached': {
        // Last results come back from the cache only (scan --cached-only). A clip it can't answer whole is not read: it
        // says so under its name, and Rescan reads it.
        if (!msg.path) { return false; }
        var gone = addRow(store, msg.path);
        if (!gone.notRead) { store.notRead++; }
        gone.notRead = true;
        gone.lookReason = 'Not read';
        gone.version = (gone.version || 0) + 1;
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
      // A key no column has is a number the view put on the rows, as familyRank.
      c = COLUMN[spec[s].key] || { key: spec[s].key };
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

  // How sure the engine is that it heard speech, 0 to 1, from its list of sounds. 0 when speech isn't in it.
  function speechConf(r) {
    var list = r.sounds || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].name === 'speech') { return typeof list[i].conf === 'number' ? list[i].conf : 0; }
    }
    return 0;
  }

  // tip: what it really checks. none: when the scan has nothing for it.
  var SHOWS = [
    { id: 'interviews', label: 'Interviews', section: 'people',
      needs: known('speech'), none: 'No sound or face data in this scan.',
      filter: function (r) {
        return r.faces > 0 && r.shotSize === 'medium' && r.durationS >= INTERVIEW_MIN_S && speechConf(r) >= INTERVIEW_SPEECH;
      },
      tip: 'Speech heard clearly, a face seen, a medium shot (waist up or closer), ' + INTERVIEW_MIN_S + ' seconds or longer. A vlog can pass too.' },
    { id: 'people', label: 'People', section: 'people',
      needs: known('people'), none: 'No people data in this scan.',
      filter: function (r) { return r.people > 0; },
      tip: 'Someone was seen in at least one of the three frames looked at in each clip.' },
    { id: 'nopeople', label: 'No people', section: 'people',
      needs: known('people'), none: 'No people data in this scan.',
      filter: function (r) { return r.people === 0; },
      tip: 'No one was seen in the three frames looked at. Someone can still appear between them.' },
    { id: 'mediums', label: 'Mediums', section: 'people',
      needs: known('shotSize'), none: 'No shot size data in this scan.',
      filter: function (r) { return r.shotSize === 'medium'; },
      tip: 'Someone from about the waist up, or closer, judged by the size of their head in the frame.' },
    { id: 'wides', label: 'Wides', section: 'people',
      needs: known('shotSize'), none: 'No shot size data in this scan.',
      filter: function (r) { return r.shotSize === 'wide'; },
      tip: 'People small in the frame. Scenery with no one in it is under No people instead.' },
    { id: 'speech', label: 'Speech', section: 'sound',
      needs: known('speech'), none: 'No sound data in this scan.',
      filter: function (r) { return r.speech === true; },
      tip: 'Speech heard in short stretches of the audio. Nothing is transcribed.' },
    { id: 'music', label: 'Music', section: 'sound',
      needs: known('music'), none: 'No sound data in this scan.',
      filter: function (r) { return r.music === true; },
      tip: 'Music heard in short stretches of the audio.' },
    { id: 'silent', label: 'Silent', section: 'sound',
      filter: function (r) { return r.hasAudio === false || r.silent === true; },
      tip: 'No audio track, or silence in every stretch listened to. Clips whose audio could not be read are left out.' },
    { id: 'onscreen', label: 'Text on screen', section: 'picture',
      needs: known('text'), none: 'No text data in this scan.',
      filter: function (r) { return !!(r.text && r.text.length); },
      tip: 'Signs, titles, packaging, slates: words of four letters or more. About half of readable text is found, so a missing word proves nothing.' },
    { id: 'similar', label: 'Similar shots', section: 'picture', group: true,
      needs: function (r) { return r.similar !== undefined; }, none: 'No similar shots in this scan.',
      waiting: 'Similar shots come once every clip is looked at.',
      tip: 'Clips whose frames look alike, kept together: takes of one set-up, or two similar places. It does not pick the best take.' }
  ];
  var SHOW = {};
  SHOWS.forEach(function (s) { SHOW[s.id] = s; });

  // The Sort menu: a column, the way it starts, and how each way reads in the menu (ways) and, when the way alone
  // doesn't say what is sorted, in the toolbar (says). Any other column sorts from its header.
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
    { key: 'camera', label: 'Camera', dir: 1, ways: ['A to Z', 'Z to A'], says: ['Camera A to Z', 'Camera Z to A'] },
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
  FAMILIES.forEach(function (f, i) { FAMILY[f.id] = f; f.rank = i; });

  // The colours on, in the dots' order. view.families is a list since 0.4: Shift-click combines colours.
  function viewFamilies(view) {
    var on = view && Array.isArray(view.families) ? view.families : [];
    return FAMILIES.filter(function (f) { return on.indexOf(f.id) >= 0; }).map(function (f) { return f.id; });
  }

  // Which clips the colours keep: null when no colour is on, else a test on a row.
  function familyTest(view) {
    var on = {}, fams = viewFamilies(view);
    if (!fams.length) { return null; }
    fams.forEach(function (id) { on[id] = true; });
    return function (r) { return on[r.colorName] === true; };
  }

  // Yellow, Yellow and Blue, Red, Yellow and Blue. last: or, for No yellow or blue clips.
  function familyWords(view, last) {
    return listWords(viewFamilies(view).map(function (id) { return FAMILY[id].word; }), last);
  }

  // A view from a record, kept only where this Select still knows every part of it. A record from before 0.4 holds one
  // colour, as family.
  function knownView(v) {
    v = v || {};
    var sort = (Array.isArray(v.sort) ? v.sort : []).filter(function (x) { return x && COLUMN[x.key] && (x.dir === 1 || x.dir === -1); });
    var colours = Array.isArray(v.families) ? v.families : typeof v.family === 'string' ? [v.family] : [];
    return { show: SHOW[v.show] ? v.show : null, sort: sort, families: viewFamilies({ families: colours }) };
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

  // ---------------------------------------------------------------- search

  // DIGITS: a word typed that is a number. PART: what stands between two things a clip holds, so words typed together
  // are found together in one of them, never across two.
  var DIGITS = /^\d+$/, PART = '';

  function fold(s) {
    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\u0080-￿]+/g, ' ');
  }

  function isDigit(code) { return code >= 48 && code <= 57; }

  // A word typed, in folded text that starts and ends with a space. A word starts a word there. A number is a whole
  // number there, so 2 finds DAY 2, not DAY 24 or a 24-70mm lens. Each part of 04.11.2026 or 1,500 is a number of its own.
  function holds(hay, token) {
    var at = hay.indexOf(' ' + token);
    if (!DIGITS.test(token)) { return at !== -1; }
    while (at !== -1) {
      if (!isDigit(hay.charCodeAt(at + 1 + token.length))) { return true; }
      at = hay.indexOf(' ' + token, at + 1);
    }
    return false;
  }

  // The same in the file name: a word anywhere in it, a number at the start of a run of digits (0412 finds C0412; 2
  // doesn't), its extension left out.
  function nameHolds(r, token) {
    if (!DIGITS.test(token)) { return r.nameFold.indexOf(token) !== -1; }
    var at = r.nameDigits.indexOf(token);
    while (at !== -1) {
      if (!isDigit(r.nameDigits.charCodeAt(at - 1))) { return true; }
      at = r.nameDigits.indexOf(token, at + 1);
    }
    return false;
  }

  // The words typed, in runs: a number holds on to the word before it, so day 2 is one run and is found only where
  // day and then 2 stand together, in one folder, bin or phrase (DAY 2, DAY2), never through a lone 2 elsewhere. 04 11
  // 2026 is one run too, and so is 2 8, which finds F2.8. A run of one is a word as before. Made once per search.
  var runsMade = { key: null, runs: null };
  function runsOf(tokens) {
    var key = tokens.join(' ');
    if (runsMade.key === key) { return runsMade.runs; }
    var runs = [];
    tokens.forEach(function (t, i) {
      if (i && DIGITS.test(t)) { runs[runs.length - 1].tokens.push(t); } else { runs.push({ tokens: [t], re: null }); }
    });
    runs.forEach(function (run) {
      if (run.tokens.length < 2) { return; }
      var first = run.tokens[0], number = DIGITS.test(first);
      // A word may meet its number with no space (DAY2), as long as the number doesn't run on from a digit.
      var src = number ? '(?:^| |[^ 0-9])' + first + '(?![0-9])[^ ]* ' : ' ' + first + '(?:[^ ]* |[^ 0-9]*(?<![0-9]))';
      src += run.tokens.slice(1).map(function (t) { return t + '(?![0-9])'; }).join('[^ ]* ');
      run.re = new RegExp(src);
    });
    runsMade = { key: key, runs: runs };
    return runs;
  }

  // A run in what a clip holds, or every word of it in the file name.
  function runHolds(r, hay, run) {
    if (!run.re) { return nameHolds(r, run.tokens[0]) || holds(hay, run.tokens[0]); }
    return run.re.test(hay) || run.tokens.every(function (t) { return nameHolds(r, t); });
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

  // The folders a clip sits in, closest first: its bins in the project, then its last three folders on disk (card,
  // camera, day), never Volumes or a home folder's Users and user name. So a search finds a card, a day or a camera.
  function folderNames(r) {
    var out = [], seen = {};
    var add = function (name) {
      var k = fold(name).trim();
      if (k && !seen[k]) { seen[k] = true; out.push(name); }
    };
    (r.binPaths || []).forEach(function (b) { String(b).split('/').reverse().forEach(add); });
    var dirs = String(r.path).split('/').slice(1, -1);
    if (dirs[0] === 'Volumes') { dirs = dirs.slice(1); } else if (dirs[0] === 'Users') { dirs = dirs.slice(2); }
    dirs.slice(-3).reverse().forEach(add);
    return out;
  }

  function hayOf(r) {
    if (r.hayVersion !== r.version || r.hay === undefined) {
      var dot = r.name.lastIndexOf('.');
      r.hay = ' ' + searchParts(r).concat(folderNames(r)).map(fold).join(' ' + PART + ' ') + ' ';
      r.nameFold = fold(r.name).replace(/ /g, '');
      r.nameDigits = ' ' + fold(dot > 0 ? r.name.slice(0, dot) : r.name) + ' ';
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

  // Every run of words typed must match: in the file name, or in what the clip holds.
  function matches(r, tokens) {
    var hay = hayOf(r), runs = runsOf(tokens);
    for (var i = 0; i < runs.length; i++) {
      if (!runHolds(r, hay, runs[i])) { return false; }
    }
    return true;
  }

  // The first thing a clip holds that a search matched, when it isn't the name: the reason it is on screen. A folder
  // reads as its own name, DAY 2, as a word does.
  function matchedWord(r, tokens) {
    if (!tokens.length) { return ''; }
    hayOf(r);
    var runs = runsOf(tokens), parts = searchParts(r), folders = null, i;
    var hit = function (part, run) { var h = ' ' + fold(part) + ' '; return run.re ? run.re.test(h) : holds(h, run.tokens[0]); };
    for (var t = 0; t < runs.length; t++) {
      if (runs[t].tokens.every(function (w) { return nameHolds(r, w); })) { continue; }
      for (i = 0; i < parts.length; i++) {
        if (hit(parts[i], runs[t])) { return parts[i]; }
      }
      folders = folders || folderNames(r);
      for (i = 0; i < folders.length; i++) {
        if (hit(folders[i], runs[t])) { return folders[i]; }
      }
    }
    return '';
  }

  // How many clips a view shows with these words searched, as computeView would, without sorting or marking groups.
  // For the search suggestions: a row's count is what picking it shows.
  function viewCount(rows, view, tokens) {
    return viewCounter(rows, view)(tokens);
  }

  // The part of that which doesn't depend on the words, made once for several searches.
  function viewCounter(rows, view) {
    var show = view && view.show ? SHOW[view.show] : null, colour = familyTest(view), i;
    var keeps = function (r) { return !colour || colour(r); };
    if (show && show.group) {
      var groups = engineGroups(rows).map(function (g) { return g.map(function (at) { return rows[at]; }).filter(keeps); });
      return function (tokens) {
        var n = 0;
        groups.forEach(function (g) {
          var k = tokens.length ? g.filter(function (r) { return matches(r, tokens); }).length : g.length;
          if (k >= 2) { n += k; }
        });
        return n;
      };
    }
    var list = [];
    for (i = 0; i < rows.length; i++) { if ((!show || show.filter(rows[i])) && keeps(rows[i])) { list.push(rows[i]); } }
    return function (tokens) {
      if (!tokens.length) { return list.length; }
      var n = 0;
      for (var j = 0; j < list.length; j++) { if (matches(list[j], tokens)) { n++; } }
      return n;
    };
  }

  // ---------------------------------------------------------------- search suggestions

  // What a clip offers to finish a search with: its labels, words on screen, sounds, camera, folders and bins.
  function suggestWords(r) {
    var out = [];
    (r.labels || []).forEach(function (l) { out.push(l.name); });
    (r.text || []).forEach(function (t) { out.push(t); });
    (r.sounds || []).forEach(function (l) { out.push(l.name); });
    if (r.camera) { out.push(r.camera); }
    return out.concat(folderNames(r));
  }

  // Every word the clips offer, with how many clips have it, most first. Made again only when a clip changed, so after a
  // scan it is made once. It says which words to offer; what each one finds is counted for the view on screen.
  var suggestMade = null;
  function suggestIndex(rows) {
    var stamp = 0, i;
    for (i = 0; i < rows.length; i++) { stamp += (rows[i].version || 0) + 1; }
    if (suggestMade && suggestMade.rows === rows && suggestMade.stamp === stamp) { return suggestMade.list; }
    var byKey = new Map(), list = [];
    for (i = 0; i < rows.length; i++) {
      var seen = {}, words = suggestWords(rows[i]);
      for (var j = 0; j < words.length; j++) {
        var key = fold(words[j]).trim();
        if (!key || seen[key]) { continue; }
        seen[key] = true;
        var e = byKey.get(key);
        if (!e) { e = { word: String(words[j]).trim(), key: key, words: key.split(' '), count: 0 }; byKey.set(key, e); list.push(e); }
        e.count++;
      }
    }
    list.sort(function (a, b) { return b.count - a.count || a.key.length - b.key.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); });
    suggestMade = { rows: rows, stamp: stamp, list: list };
    return list;
  }

  // Ways to finish the last word typed, as [{word, count, query}], at most n, most clips first. Words that start with the
  // whole search, when there are any, replace it (day 2 → DAY 2, DAY 24); otherwise a word with a word starting as the
  // last one typed replaces that one (kitchen w → kitchen water). count: the clips picking it shows, in the view on
  // screen (view: its Show and colour). Nothing while the next word is still to come, nothing a pick wouldn't find, and
  // nothing when the only one is what is typed already. Twice n of the words the scan holds most are counted.
  function suggestions(rows, typed, n, view) {
    var raw = String(typed || ''), tokens = searchTokens(raw), most = n || 6, pool = most * 2, list = suggestIndex(rows);
    if (!tokens.length || /\s$/.test(raw)) { return []; }
    var last = tokens[tokens.length - 1], whole = tokens.join(' '), all = [], one = [], i, e;
    for (i = 0; i < list.length && all.length < pool; i++) {
      e = list[i];
      if (tokens.length > 1 && e.key.indexOf(whole) === 0) { all.push(e); } else if (one.length < pool && e.words.some(function (w) { return w.indexOf(last) === 0; })) { one.push(e); }
    }
    var from = lastWordAt(raw, last), count = viewCounter(rows, view);
    var out = (all.length ? all : one).map(function (s) {
      var query = all.length ? s.word : raw.slice(0, from) + s.word;
      return { word: s.word, count: count(searchTokens(query)), query: query, key: s.key };
    }).filter(function (s) { return s.count > 0; });
    out.sort(function (a, b) { return b.count - a.count; });
    out = out.slice(0, most);
    if (out.length === 1 && (out[0].key === last || out[0].key === whole)) { return []; }
    return out.map(function (s) { return { word: s.word, count: s.count, query: s.query }; });
  }

  // Where the last word typed starts in the raw text, so a suggestion replaces it and keeps what comes before.
  function lastWordAt(raw, last) {
    var at = raw.length;
    for (var k = raw.length - 1; k >= 0; k--) {
      var f = fold(raw.slice(k));
      if (f.trim() !== last) { if (at < raw.length) { break; } continue; }
      if (f.charAt(0) !== ' ') { at = k; }
    }
    return at;
  }

  // ---------------------------------------------------------------- the view

  // view: {show, sort, families}. opts: {tokens} from a search. Returns row indexes to show, and where groups start.
  function computeView(rows, view, now, opts) {
    var clock = now || function () { return Date.now(); };
    var t0 = clock(), show = view.show ? SHOW[view.show] : null, order = [], i, j;
    var groupCount = 0, hasGroups = !!(show && show.group), breaks = [];
    var tokens = opts && opts.tokens && opts.tokens.length ? opts.tokens : null, colour = familyTest(view);
    var keeps = function (r) {
      return (!colour || colour(r)) && (!tokens || matches(r, tokens));
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
    // Groups stay whole and in the engine's order. The sort orders the clips inside each one. Two colours or more, sorted by
    // colour: each colour together, in the dots' order, the rainbow inside it, so a flat yellow stays with the yellows.
    var spec = view.sort;
    if (!hasGroups && spec.length && spec[0].key === 'colorName' && viewFamilies(view).length > 1) {
      for (i = 0; i < order.length; i++) { var f = FAMILY[rows[order[i]].colorName]; rows[order[i]].familyRank = f ? f.rank : null; }
      spec = [{ key: 'familyRank', dir: spec[0].dir }].concat(spec);
    }
    sortOrder(rows, order, hasGroups ? [{ key: 'dupGroup', dir: 1 }].concat(spec) : spec);
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
    return row.reason ? 'No picture' : row.notRead ? 'Not read' : cellText(row, COLUMN.durationS);
  }

  // The grid's tiles, for a width of `width` px between the panel's sides. Tiles fill the row and keep near AIM: the
  // column count changes halfway between one count's tiles and the next, so a widening panel's tiles grow a little past
  // the aim and shrink a little under it, as Photos' do, instead of falling to the least and growing back. Never under
  // MIN while three or more fit, never fewer than two columns, never past MOST (a 480 px picture stays sharp at 2x).
  var TILE = { min: 130, aim: 165, most: 240, gap: 14 };

  function gridLayout(width) {
    var x = Math.max(0, width) + TILE.gap;
    var cols = Math.min(Math.round(x / (TILE.aim + TILE.gap)), Math.floor(x / (TILE.min + TILE.gap)));
    cols = Math.max(2, cols, Math.ceil(x / (TILE.most + TILE.gap)));
    var tileW = Math.max(1, Math.floor((width - (cols - 1) * TILE.gap) / cols));
    // The pixels the whole tiles leave over go to the gaps, one each, spread along the row, so the row ends on the
    // margin: gaps of 14 or 15 px.
    var extra = Math.max(0, Math.min(cols - 1, width - cols * tileW - (cols - 1) * TILE.gap));
    return { cols: cols, tileW: tileW, picH: Math.round(tileW * 9 / 16), gap: TILE.gap, extra: extra };
  }

  // Where column c of a grid layout starts, from the grid's left edge.
  function gridColumnX(fit, c) {
    return c * (fit.tileW + fit.gap) + (fit.cols > 1 ? Math.round(c * (fit.extra || 0) / (fit.cols - 1)) : 0);
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
    if (known) { return (known.says || known.ways)[s.dir === known.dir ? 0 : 1]; }
    if (c.words) { return c.words[s.dir > 0 ? 4 : 0] + ' first'; }
    if (c.key === 'pixels') { return s.dir > 0 ? 'Smallest first' : 'Largest first'; }
    // A number with no words of its own, such as ISO, reads high to low, never Z to A.
    if (c.kind === 'number') { return c.label + (s.dir > 0 ? ' low to high' : ' high to low'); }
    return c.label + (s.dir > 0 ? ' A to Z' : ' Z to A');
  }

  // Sharpest first becomes sharpest first after a comma. A to Z and ISO stay as they are.
  function lowerFirst(s) { return /^[A-Z][A-Z ]/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1); }

  // The whole view in a few words: the foot's verdict and the name of the bin. Red, interviews, sharpest first.
  // Yellow and Blue, interviews.
  function viewName(view) {
    var parts = [], s = view.sort[0], colours = familyWords(view);
    if (colours) { parts.push(colours); }
    if (view.show) { parts.push(SHOW[view.show].label); }
    if (s && !(colours && s.key === 'colorName')) { parts.push(sortWords(s)); }
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
    var colours = viewFamilies(view).length;
    return colours > 1 ? 'colours' : colours ? 'one' : null;
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
    if (kind === 'one') { return [{ name: '01 ' + (view.show ? SHOW[view.show].label : familyWords(view)), rows: rows }]; }
    var withValue = [], without = [], buckets = [], names = bucketNames(col, s.dir);
    for (i = 0; i < rows.length; i++) {
      (hasValue(rows[i], col) ? withValue : without).push(rows[i]);
    }
    // Clips whose values read the same stay together, in the bin where the first of them falls.
    var slots = [[], [], [], [], []], at = 0, was = null, text;
    for (i = 0; i < withValue.length; i++) {
      text = cellText(withValue[i], col);
      if (!i || text !== was) { at = Math.floor(i * 5 / withValue.length); }
      slots[at].push(withValue[i]);
      was = text;
    }
    for (i = 0; i < 5; i++) {
      if (slots[i].length) { buckets.push({ name: pad(i + 1, 2) + ' ' + names[i], rows: slots[i] }); }
    }
    if (without.length) { buckets.push({ name: '06 No value', rows: without }); }
    return buckets;
  }

  // What Sort into Bins makes: 'several' bins as binKind says, or 'one' bin for a Show, a colour, a search or clips
  // picked in Select. null when it can make none. picked: clips picked on screen.
  function binsPlan(view, query, picked) {
    var kind = binKind(view);
    // A colour dot brings the rainbow sort with it: one colour on makes one bin, two or more a bin for each.
    if (kind === 'colours' && viewFamilies(view).length === 1) { kind = 'one'; }
    if (kind && kind !== 'one') { return 'several'; }
    return kind === 'one' || String(query || '').trim() || picked ? 'one' : null;
  }

  // What a new bin or sequence is named after: the view, a search after it ("Interviews, “sunset”", or "“sunset”"
  // alone), Selects for clips picked with nothing else on, else where the scan came from (Day 2, the project, a folder).
  function viewWhat(view, query, picked, source) {
    var what = viewName(view), q = String(query || '').trim();
    if (q) { what = what ? what + ', ' + quoted(q) : quoted(q); }
    return what || (picked || !source ? 'Selects' : source);
  }

  // SELECT 2026-11-04 Interviews, longest first. now: for the tests.
  function sequenceName(view, query, picked, source, now) {
    return 'SELECT ' + localDate(new Date(now === undefined ? Date.now() : now)) + ' ' + viewWhat(view, query, picked, source);
  }

  function localDate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);
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

  // ---------------------------------------------------------------- icons

  // One set, drawn on a 16 × 16 grid with a 1.5 px stroke, round caps and joins, in the colour of the words beside it.
  // Straight strokes sit on quarter pixels (.25, .75), so at 2x both their edges fall on device pixels, and one does at 1x.
  // The status icons (check-circle, alert, info, spinner, clips, bin) span 1 to 15 across, so one left edge
  // lines them all up.
  var ICONS = {
    search: '<circle cx="7.25" cy="7.25" r="4.5"/><path d="M10.75 10.75l2.75 2.75"/>',
    chevron: '<path d="M4.75 6.25 8 9.5l3.25-3.25"/>',
    'chevron-up': '<path d="M4.75 9.75 8 6.5l3.25 3.25"/>',
    'chevron-right': '<path d="M6.25 4.75 9.5 8l-3.25 3.25"/>',
    flip: '<path d="M5.25 3.25v9.5M2.75 10.25l2.5 2.5 2.5-2.5M10.75 12.75v-9.5M8.25 5.75l2.5-2.5 2.5 2.5"/>',
    list: '<path d="M2.75 3.75h0M2.75 7.75h0M2.75 11.75h0M5.75 3.75h7.5M5.75 7.75h7.5M5.75 11.75h7.5"/>',
    grid: '<rect x="2.75" y="2.75" width="3.5" height="3.5" rx="1"/><rect x="9.75" y="2.75" width="3.5" height="3.5" rx="1"/><rect x="2.75" y="9.75" width="3.5" height="3.5" rx="1"/><rect x="9.75" y="9.75" width="3.5" height="3.5" rx="1"/>',
    more: '<circle cx="3.5" cy="8" r=".5"/><circle cx="8" cy="8" r=".5"/><circle cx="12.5" cy="8" r=".5"/>',
    bin: '<path d="M1.75 3.75h4l2 2h6.5v6.5H1.75z"/>',
    clips: '<rect x="1.75" y="3.75" width="12.5" height="8.5" rx="1.5"/><path d="M4.75 3.75v8.5M11.25 3.75v8.5"/>',
    check: '<path d="M3.75 8.25 6.5 11l5.75-5.75"/>',
    'check-circle': '<circle cx="8" cy="8" r="6.25"/><path d="M5.25 8.25l2 2 3.5-4"/>',
    ring: '<circle cx="8" cy="8" r="6.25"/>',
    alert: '<path d="M8 2.25 14.5 13.25H1.5z"/><path d="M8 6.25v3.25M8 11.25v0"/>',
    info: '<circle cx="8" cy="8" r="6.25"/><path d="M8 7.25v3.75M8 4.75v0"/>',
    spinner: '<circle cx="8" cy="8" r="6.25" stroke-opacity=".28"/><path d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25"/>',
    close: '<path d="M4.75 4.75l6.5 6.5M11.25 4.75l-6.5 6.5"/>'
  };
  var ICON_ATTRS = 'viewBox="0 0 16 16" width="16" height="16" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
  var SVG_NS = 'http://www.w3.org/2000/svg';

  // The icon inline, in the colour of its element.
  function iconSvg(name) {
    return '<svg class="ic" ' + ICON_ATTRS + ' stroke="currentColor" aria-hidden="true" focusable="false">' + ICONS[name] + '</svg>';
  }

  // The icon as an image for a CSS mask, where the element's background gives it its colour.
  function iconUrl(name) {
    return 'url("data:image/svg+xml,' + encodeURIComponent('<svg xmlns="' + SVG_NS + '" ' + ICON_ATTRS + ' stroke="#000">' + ICONS[name] + '</svg>') + '")';
  }

  // ---------------------------------------------------------------- words

  function fmtInt(n) { return Number(n).toLocaleString('en-US'); }

  function plural(n, word) { return fmtInt(n) + ' ' + word + (n === 1 ? '' : 's'); }

  // a, b and c. last: the word before the last part, and unless said.
  function listWords(parts, last) {
    if (parts.length < 2) { return parts.join(''); }
    return parts.slice(0, -1).join(', ') + ' ' + (last || 'and') + ' ' + parts[parts.length - 1];
  }

  // ---------------------------------------------------------------- theme

  // Dark tokens when Premiere is dark, light tokens when it is set bright. color: {red, green, blue}, 0 to 255.
  function themeFor(color) {
    if (!color) { return 'dark'; }
    return (Number(color.red) + Number(color.green) + Number(color.blue)) / 3 >= 128 ? 'light' : 'dark';
  }

  // Premiere's own panel colour, as the panel's ground, with the few greys around it moved by the same step as in
  // Ingest's tokens. Secondary text darkens or lightens until it still reads at 4.5:1 on every grey it sits on, and the
  // red of a refusal until it reads on the status.
  function skinTokens(color) {
    var theme = themeFor(color);
    if (!color) { return null; }
    var base = [Number(color.red), Number(color.green), Number(color.blue)].map(function (v) { return Math.max(0, Math.min(255, Math.round(v) || 0)); });
    var dark = theme === 'dark', hex = function (rgb) { return '#' + rgb.map(function (v) { return ('0' + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2); }).join('').toUpperCase(); };
    var step = function (by) { return hex(base.map(function (v) { return v + by; })); };
    var ink = dark ? [237, 237, 238] : [29, 29, 31], ink2 = dark ? [173, 173, 177] : [95, 96, 99];
    var lum = function (h) {
      return [1, 3, 5].map(function (i) { var c = parseInt(h.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); })
        .reduce(function (sum, c, i) { return sum + c * [0.2126, 0.7152, 0.0722][i]; }, 0);
    };
    var contrast = function (a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    var reads = function (c, grounds) { return grounds.every(function (g) { return contrast(c, g) >= 4.5; }); };
    // Text sits on the ground, the foot grey, a menu item under the pointer (disc), and a selected row or tile, which is
    // --plate-sel over the ground: white at 11% on dark, black at 7.5% on light.
    var grounds = function () {
      return [step(0), step(dark ? -10 : -11), step(dark ? 20 : -24), hex(base.map(function (v) { return dark ? v + (255 - v) * 0.11 : v * 0.925; }))];
    };
    var toward = function (from, to, k) { return hex(from.map(function (v, i) { return v + (to[i] - v) * k / 20; })); };
    // Each colour may move toward a stronger version of itself: grey toward ink, red toward a deeper or paler red. Secondary
    // text stops short of ink, so it stays secondary. Text needs 4.5:1, the focus ring and placeholders 3:1.
    var red = dark ? [255, 106, 95] : [201, 40, 28], redFar = dark ? [255, 190, 184] : [120, 16, 10];
    // The green of a proved write: words and a seal on the ground, with no fill under them, so it needs 4.5:1 there too.
    var green = dark ? [52, 199, 89] : [15, 110, 49], greenFar = dark ? [190, 255, 204] : [4, 56, 22];
    var ink3 = dark ? [124, 124, 130] : [142, 142, 147];
    // The focus ring is Premiere's one accent, a blue, moved lighter on dark greys and deeper on light ones until it reads
    // at 3:1 on every grey it sits on.
    var blue = dark ? [47, 111, 230] : [37, 99, 235], blueFar = dark ? [176, 204, 255] : [8, 34, 120];
    // Amber, for a write that partly landed and a refusal. It marks an icon only, never words, so it needs 3:1 on the
    // ground and on the band.
    var amber = dark ? [245, 165, 36] : [178, 91, 0], amberFar = dark ? [255, 236, 196] : [92, 46, 0];
    // The band under the toolbar is a shade off the panel: lighter on a dark grey, darker on a light one, as Premiere's
    // own bands are, and a little further on light, where the same step reads fainter.
    var band = function () { return step(dark ? 11 : -12); };
    // need: one ratio for every ground in on, or [[grounds, ratio], …].
    function fit(from, to, need, on, most) {
      var pairs = typeof need === 'number' ? [[on, need]] : need;
      for (var k = 0; k <= most; k++) {
        var c = toward(from, to, k);
        if (pairs.every(function (p) { return p[0].every(function (g) { return contrast(c, g) >= p[1]; }); })) { return c; }
      }
      return null;
    }
    // A mid grey where that is not enough moves, a step at a time, toward the end its theme belongs to.
    var on, t = {};
    for (var n = 0; n < 128; n++) {
      // The band holds words too (the sentence after the verdict) and the green check, so they read on it as well.
      on = grounds();
      t.ink2 = fit(ink2, ink, 4.5, on.concat(band()), 14);
      t.bad = fit(red, redFar, 4.5, on.slice(0, 2), 20);
      t.ink3 = fit(ink3, ink, [[on.slice(0, 2), 3], [[band()], 4.5]], null, 20);
      t.ring = fit(blue, blueFar, 3, on.slice(0, 3).concat(band()), 20);
      t.safe = fit(green, greenFar, 4.5, on.slice(0, 2).concat(band()), 20);
      t.warn = fit(amber, amberFar, 3, [on[0], band()], 20);
      if (reads(hex(ink), on) && t.ink2 && t.bad && t.ink3 && t.ring && t.safe && t.warn) { break; }
      base = base.map(function (v) { return v + (dark ? -1 : 1); });
    }
    var surface = on[0], foot = on[1], disc = on[2];
    // edge: a pill's outline. sel: the plate under the view that is on (list or grid).
    return { theme: theme, surface: surface, foot: foot, disc: disc, track: step(dark ? 20 : -22), ring: step(dark ? 50 : -54), ink2: t.ink2, bad: t.bad, ink3: t.ink3, 'focus-ring': t.ring, 'safe-ink': t.safe,
      band: band(), edge: step(dark ? 58 : -56), sel: step(dark ? 29 : -27), warn: t.warn };
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
    return plural(n, 'clip') + (n === 1 ? ' has' : ' have') + ' no picture scores: ' + why;
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

  // Items sent in a write, however they are grouped: [[id, path]] lists, alone or in buckets.
  function itemCount(sent) {
    if (sent.items) { return sent.items.length; }
    return (sent.buckets || []).reduce(function (n, r) { return n + r.items.length; }, 0);
  }

  // ---------------------------------------------------------------- batches

  // A write's results as its batches land, merged into one. unsent and error are set by whoever sends the batches.
  function writeAcc(kind) {
    var acc = { failed: [], skipped: [], unsent: 0, error: '' };
    if (kind === 'bins') { acc.moved = 0; acc.placed = []; acc.top = null; acc.root = null; } else { acc.changed = 0; }
    if (kind === 'sequence') { acc.made = false; acc.clips = 0; acc.inOrder = false; acc.name = ''; }
    return acc;
  }

  function addBatch(kind, acc, res) {
    acc.failed = acc.failed.concat(res.failed || []);
    acc.skipped = acc.skipped.concat(res.skipped || []);
    // Make Sequence is one call: what V1 holds after it, and whether in the order sent.
    if (kind === 'sequence') {
      acc.made = true;
      acc.clips = res.clips || 0;
      acc.inOrder = !!res.inOrder;
      acc.name = res.name || '';
      return acc;
    }
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
  // Picked clips the project in front doesn't hold, left out of a write: every sheet says it, and so does the outcome.
  function goneLine(n) {
    return n ? plural(n, 'clip') + (n === 1 ? ' isn\'t' : ' aren\'t') + ' in this project.' : '';
  }

  function refusalWords(message) {
    return String(message || '').replace(/\s*Nothing (was|has been) (written|changed|moved|imported)\.?\s*$/, '');
  }

  // The fields and words of a finished write. Green only when what was read back matches what was sent, and every item
  // sent was tried. kind: label or bins. sent: everything the write meant to send, as items [[id, path]].
  // res: the batches merged: changed or moved, failed, skipped (changed in the project since), unsent (never sent,
  // after Stop or a refusal), error (why the rest was not sent), buckets (read back at the end).
  function writeOutcome(kind, sent, res, extra) {
    var failed = res.failed || [], skipped = res.skipped || [], unsent = res.unsent || 0, why = refusalWords(res.error);
    var want = itemCount(sent), whole = !failed.length && !skipped.length && !unsent && !why;
    var keep = { failed: failed.concat(skipped) };
    function rest(line) {
      var bits = [line];
      if (skipped.length) { bits.push(plural(skipped.length, 'clip') + ' changed since, left alone.'); }
      if (why) { bits.push('The rest weren\'t sent: ' + why); } else if (unsent) { bits.push('Stopped: ' + fmtInt(unsent) + (unsent === 1 ? ' wasn\'t' : ' weren\'t') + ' sent.'); }
      return bits.filter(Boolean).join(' ');
    }
    // none: nothing landed, so there is nothing to undo either.
    function out(kindWord, verdict, sentence, undo) {
      return { kind: kindWord, green: kindWord === 'proved', verdict: verdict, sentence: sentence, undo: undo, none: !undo, failed: kindWord === 'proved' ? [] : keep.failed };
    }
    var n;
    if (kind === 'sequence') {
      // Green only when V1 holds every clip sent, in the order sent. Details names what is missing.
      n = res.clips || 0;
      var short = want - n - skipped.length - failed.length;
      if (short > 0) { keep.failed.push({ name: plural(short, 'clip'), error: 'not in the sequence' }); }
      if (whole && res.made && n === want && res.inOrder) { return out('proved', 'Made a sequence of ' + plural(want, 'clip'), '', true); }
      if (!res.made) { return out('partial', 'Nothing made', rest(''), false); }
      if (n === want) { return out('partial', 'Made a sequence of ' + plural(n, 'clip'), 'Not in the order shown.', true); }
      // The count first, so a narrow band that cuts the line keeps the part that matters.
      return out('partial', fmtInt(n) + ' of ' + plural(want, 'clip') + ' in the sequence', '', true);
    }
    if (kind === 'bins') {
      n = res.moved || 0;
      var read = binsRead(res.placed || [], res), bins = sent.buckets.length;
      if (whole && read.confirmed && read.matched === want && !read.extra) {
        return out('proved', sent.single ? 'Moved ' + plural(want, 'clip') + ' into a bin' : 'Sorted into ' + plural(bins, 'bin'), '', true);
      }
      if (!n) { return out('partial', 'Nothing moved', rest(''), false); }
      if (!read.confirmed) { return out('partial', 'Moved, not confirmed', rest('Premiere didn\'t say where they landed.'), true); }
      var off = read.expected - read.matched + read.extra + failed.length;
      return out('partial', 'Moved ' + fmtInt(read.matched) + ' of ' + plural(want, 'clip'), rest(off ? plural(off, 'clip') + ' didn\'t land.' : ''), true);
    }
    // Labels: the host reads each label back as it sets it, and `changed` counts only those that matched.
    n = res.changed || 0;
    if (whole && n === want) {
      return out('proved', 'Labelled ' + plural(n, 'clip') + ' ' + extra, '', true);
    }
    if (!n) { return out('partial', 'Nothing labelled', rest(''), false); }
    return out('partial', 'Labelled ' + fmtInt(n) + ' of ' + plural(want, 'clip'), rest(failed.length ? plural(failed.length, 'clip') + (failed.length === 1 ? ' kept its label.' : ' kept their label.') : ''), true);
  }

  // Result of Undo. Never green: putting things back proves nothing new. It offers no Undo of its own, so a second
  // click never takes back an older write; that stays in the ··· menu. kind: the record's. A sequence worked in since it
  // was made, or used in another, stays, and res.note (the host's words) says why; one skipped with no note had gone
  // already.
  function undoOutcome(res, kind) {
    var failed = countOf(res.failed), restored = res.restored || 0, unsent = res.unsent || 0, why = refusalWords(res.error), bits = [];
    if (restored) { bits.push(plural(restored, 'item') + ' back.'); }
    if (res.skipped) { bits.push(kind === 'sequence' ? (res.note || 'The sequence is already gone.') : fmtInt(res.skipped) + ' changed since, left alone.'); }
    if (failed) { bits.push(plural(failed, 'item') + ' couldn\'t go back.'); }
    if (why) { bits.push('The rest weren\'t sent: ' + why); } else if (unsent) { bits.push('Stopped: ' + fmtInt(unsent) + ' still to go back.'); }
    if (res.binRemoved === false) { bits.push('The SELECT bin is still in the project.'); }
    if (!bits.length) { bits.push('Nothing left to put back.'); }
    var verdict = !restored ? 'Nothing went back' : (failed || unsent || why ? 'Partly undone' : 'Undone');
    var clean = restored && !failed && !res.skipped && !unsent && !why && res.binRemoved !== false;
    if (clean) { bits = []; }
    return { kind: clean ? 'undone' : 'partial', verdict: verdict, sentence: bits.join(' '), undo: false, none: !restored, failed: res.failed || [] };
  }

  // ---------------------------------------------------------------- undo records

  // Premiere's own undo cannot take back a batch (see app.js), so every write keeps a record of what it replaced, on
  // disk, newest last. Undo reverses the newest one still there. This many are kept per project.
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

  // What Undo will do, in a sentence, for what is still left of a record.
  function undoWords(entry) {
    var n = entry.restore && entry.restore.items ? entry.restore.items.length : 0, m = entry.meta || {};
    if (entry.kind === 'label') { return 'Takes ' + (m.label || 'the label') + ' off ' + plural(n, 'clip') + ' and puts back the labels they had before.'; }
    // Add Columns is gone since 0.4, but a record it left from 0.2 or 0.3 still goes back.
    if (entry.kind === 'columns') { return 'Puts back what the Select columns held on ' + plural(n, 'clip') + ' before this write.'; }
    if (entry.kind === 'bins') { return 'Moves ' + plural(n, 'clip') + ' back to the bins they came from, and removes ' + (m.root || 'the SELECT bin') + ' once it is empty.'; }
    // [sequenceID, nodeId, name, clips, end]: the name Premiere gave it, with its (2) when it has one.
    if (entry.kind === 'sequence') { return 'Removes the sequence ' + ((n && entry.restore.items[0][2]) || m.name || 'Select made') + '.'; }
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

  // Scanned yesterday at 18:05, Made 2026-10-30 at 18:00: for a tooltip or a sheet. verb: Scanned unless given.
  function whenLine(iso, now, verb) {
    return (verb || 'Scanned') + ' ' + whenWords(iso, now);
  }

  // Was it today, in this Mac's time zone? Undo says when a write was made only when it wasn't.
  function isToday(iso, now) {
    var t = Date.parse(iso);
    return t === t && localDate(new Date(t)) === localDate(new Date(now === undefined ? Date.now() : now));
  }

  // The sheet's line on how far Undo reaches, before a write. held: records already kept for this project.
  function undoReach(held) {
    return held >= UNDO_KEEP ? 'This pushes the oldest of the last ' + UNDO_KEEP + ' writes out of Undo\'s reach.' : '';
  }

  // ---------------------------------------------------------------- the scan target

  // The clips a target holds as a scan would make them: video by extension, one per file.
  function targetKeys(t) {
    var keys = new Map(), items = t && t.items ? t.items : [];
    for (var i = 0; i < items.length; i++) {
      var p = items[i].path;
      if (typeof p === 'string' && isVideoPath(p) && p.indexOf('\n') === -1) { keys.set(pathKey(p), true); }
    }
    return keys;
  }

  function targetCount(t) { return targetKeys(t).size; }

  // How many clips Scan would read now that the results don't hold. 0 when a scan of it brings nothing new.
  // rows: a store, or rows.
  function otherClips(t, rows) {
    if (!t || t.kind === 'several') { return 0; }
    var have = rows && rows.byKey ? rows.byKey : new Map((rows || []).map(function (r) { return [r.key || pathKey(r.path), r]; })), n = 0;
    targetKeys(t).forEach(function (v, k) { if (!have.has(k)) { n++; } });
    return n;
  }

  function sameTarget(t, rows) { return otherClips(t, rows) === 0; }

  // The results on screen are the whole of the project in front: a scan with nothing selected, or Scan Whole Project,
  // in this project. from: where the results came from, {project, target}; project: the project in front.
  function wholeResults(from, project) {
    return !!(from && from.target && from.target.kind === 'project' && from.project && project && pathKey(from.project.path) === pathKey(project.path));
  }

  // After a scan, the clips the band offers to Scan: the ones the target holds that the results don't. A Project panel
  // selection (bins or clips) offers them always. The whole project, which the target falls back to when nothing is
  // selected, is no news by itself: it offers only the clips a scan of this whole project lacks, footage imported since.
  // So after a scan of a selection, letting the selection go opens nothing; ··· › Scan Whole Project reads the rest.
  function scanOthers(t, store, from, project) {
    if (!t || t.kind === 'several') { return 0; }
    if (t.kind === 'project' && !wholeResults(from, project)) { return 0; }
    return otherClips(t, store);
  }

  // Where a selection is: Day 2, Day 2, Day 3, or Day 2 and 3 more. The top of the project has no name of its own.
  function placeWords(places, more) {
    var names = (places || []).filter(Boolean), total = names.length + (more || 0);
    if (!names.length) { return ''; }
    if (total === 1) { return names[0]; }
    if (total === 2 && names.length === 2) { return names[0] + ', ' + names[1]; }
    return names[0] + ' and ' + fmtInt(total - 1) + ' more';
  }

  // What Scan would read, as the status says it: {verdict, sentence, tip, scan, scanTip}. t: the host's target answer,
  // null before the first. o: {connected, project, title}. others: after a scan, the clips the results don't hold, so the
  // words count those: "8 other clips selected", "Whole project · 8 new clips", and for bins partly scanned,
  // "Day 2 · 8 new clips". scan is false when there is nothing to scan.
  function targetWords(t, o, others) {
    var title = (o && o.title) || '';
    var out = function (verdict, sentence, tip, scan) {
      return { verdict: verdict, sentence: sentence || '', tip: tip || '', scan: !!scan, scanTip: scan ? verdict + (sentence ? ' · ' + sentence : '') : '' };
    };
    if (o && o.connected === false) { return out('Waiting for Premiere'); }
    if (o && !o.project) { return out('No project open'); }
    if (!t) { return out('Waiting for Premiere'); }
    if (t.kind === 'several') { return out('Selections in ' + fmtInt(t.several || 2) + ' Project panels'); }
    var n = targetCount(t), where = placeWords(t.places, t.more);
    var fresh = others !== undefined && others < n;
    if (t.kind === 'project') {
      if (!n) { return out('No video clips', '', title); }
      return out('Whole project', fresh ? plural(others, 'new clip') : plural(n, 'clip'), t.sig ? 'No video clips in the selection' : title, true);
    }
    if (t.kind === 'bins') { return out(where || 'Selected bins', fresh ? plural(others, 'new clip') : plural(n, 'clip'), title, n > 0); }
    var one = n === 1 && t.name ? String(t.name) : where;
    if (others !== undefined) { return out(plural(others, 'other clip') + ' selected', one, title, true); }
    return out(plural(n, 'clip') + ' selected', one, title, n > 0);
  }

  // ---------------------------------------------------------------- the watch poll

  // Once the pointer has left Select, `watch` runs a few times by itself, further and further apart, so the band follows
  // the Project panel selection, then stops until the pointer comes back and leaves again. Each call hands the script
  // engine one live item per selected item, so the steps are few, a selection of more than POLL_BIG items is looked at no
  // more than every POLL_FLOOR s, and there are at most POLL_HOURLY calls in any hour.
  // Above POLL_MAX selected items it doesn't poll at all (the pointer coming back still asks), and the polls of any hour
  // hand out at most POLL_ITEMS_HOURLY items in all.
  // No gap is longer than 15 s, so a selection made while the pointer is away shows within 15 s, to 93 s.
  var POLL_STEPS = [1, 1, 2, 2, 4, 8, 15, 15, 15, 15, 15], POLL_FLOOR = 10, POLL_BIG = 3, POLL_HOURLY = 300, HOUR_MS = 3600000;
  var POLL_MAX = 50, POLL_ITEMS_HOURLY = 2000;

  // The times of the polls, in seconds after the pointer left (or the selection last changed): 1, 2, 4, 6, 10, 18, 33,
  // 48, 63, 78, 93.
  function pollTimes() {
    var t = 0;
    return POLL_STEPS.map(function (s) { t += s; return t; });
  }

  // The next poll after the one at `after` s (0 before the first), for a selection of `count` items: the next of
  // pollTimes(), at least POLL_FLOOR s after the last when the selection is big. null when the run is over.
  function nextPoll(after, count) {
    if (count > POLL_MAX) { return null; }
    var floor = count > POLL_BIG ? POLL_FLOOR : 0, times = pollTimes();
    for (var i = 0; i < times.length; i++) {
      if (times[i] > after && times[i] - after >= floor) { return times[i]; }
    }
    return null;
  }

  // Room for one more poll this hour. stamps: the times of the polls so far, in ms; those older than an hour go.
  function pollRoom(stamps, now) {
    while (stamps.length && now - stamps[0] >= HOUR_MS) { stamps.shift(); }
    return stamps.length < POLL_HOURLY;
  }

  // Room for the items of one more poll this hour. log: [ms, items] of the polls so far; those older than an hour go.
  function pollItemRoom(log, now) {
    while (log.length && now - log[0][0] >= HOUR_MS) { log.shift(); }
    var n = 0;
    for (var i = 0; i < log.length; i++) { n += log[i][1]; }
    return n < POLL_ITEMS_HOURLY;
  }

  // How many items a watch with this signature handed out: its count ('12:5b1e09c2'), none for no selection, and
  // none counted for two Project panels ('several:2'), whose count the signature doesn't say.
  function sigCount(sig) {
    var n = parseInt(String(sig || ''), 10);
    return n > 0 ? n : 0;
  }

  // ---------------------------------------------------------------- the foot

  // Scan progress as a share of the work: file details are the first fifth, decoded frames and audio the rest.
  function progress(store) {
    var total = Math.max(store.total, 1), finished = store.tier1 + store.errors;
    return { finished: Math.min(finished, store.total), share: Math.min(1, (0.2 * Math.min(store.tier0 + store.errors, total) + 0.8 * Math.min(finished, total)) / total) };
  }

  // Values that only Tier 2 sends. A view that sorts, filters or searches on them is not final until every clip has them.
  var TIER2_KEYS = { people: 1, faces: 1, shotSize: 1, colorName: 1, soundText: 1, screenText: 1, labelText: 1, iso: 1, shutterS: 1, aperture: 1, shake: 1 };

  function viewNeedsTier2(view, tokens) {
    var show = view.show ? SHOW[view.show] : null;
    if ((show && (show.needs || show.group)) || viewFamilies(view).length || (tokens && tokens.length)) { return true; }
    return view.sort.some(function (s) { return TIER2_KEYS[s.key] === 1; });
  }

  // Clips Tier 2 should reach: every clip except those the engine could not read at all.
  function understandingShare(store) {
    var due = Math.max(store.total - store.errors, 0), done = Math.min(store.tier2 + store.tier2Failed, due);
    return { done: done, due: due, share: due ? done / due : 1, landed: done >= due };
  }

  function notUnderstoodSummary(store) {
    var n = store.tier2Failed;
    return n ? plural(n, 'clip') + ' couldn\'t be looked at closely.' : '';
  }

  // A write or an Undo while it runs. w: {kind: write or undo, verb, unit, done, total, stopping, whole}. whole: one
  // call for all of it, as Make Sequence is, so no count climbs and there is nothing to stop between batches.
  function writingState(busy, w) {
    if (!w || !w.total) { return { kind: 'writing', mark: 'running', verdict: busy, sentence: '', actions: [] }; }
    var many = w.total > BATCH && !w.whole, unit = w.unit || 'clip';
    var verdict = w.stopping ? 'Stopping after this batch' : w.verb + ' ' + (w.done && !w.whole ? fmtInt(w.done) + ' of ' : '') + plural(w.total, unit);
    return { kind: 'writing', mark: 'running', verdict: verdict, sentence: '', actions: many && !w.stopping ? ['stop'] : [] };
  }

  // The bottom line. Pure: every word of the foot comes from here, so tests read what a person would and no view decides.
  // f: {project, connected, title, listing, listed, listStop, busy, write, outcome, scan: {state, failure, seconds,
  //     stopping}, store, rows, shown, selected, view, groupCount, query, target, others, foreign, restoring, notRead,
  //     lastAt, now}
  // target: what Scan would read now (the host's answer). others: how many of its clips the results don't hold.
  // foreign: the title of the project the results came from, when another one is in front. restoring: last results on
  // their way back. notRead: clips the cache couldn't answer. lastAt: when the last results were scanned.
  // scanWhat says what Scan reads: the target, or the same clips again.
  function footState(f) {
    var sc = f.scan, st = f.store, total = f.rows;
    // The writes the foot offers. Label is in the right-click menu only, and waits for looking closer as these do.
    var writes = ['sequence', 'bins'];
    var sorted = !!binsPlan(f.view, f.query, f.selected);
    // The blue is Sort into Bins, always: blue when it can make bins, the grey plate when it can't. It never hops to
    // Make Sequence, so a view that makes no bins has no blue at all.
    var primary = 'bins';
    var running = !!(sc && sc.state === 'Scanning');
    if (f.busy) { return writingState(f.busy, f.write); }
    if (f.listing) {
      return { kind: 'listing', mark: 'running', verdict: 'Listing clips', sentence: f.listed ? plural(f.listed, 'video file') + ' found so far.' : '', actions: f.listStop ? ['stop'] : [] };
    }
    if (f.restoring) { return { kind: 'restoring', mark: 'running', verdict: 'Last results', sentence: '', actions: ['stop'] }; }
    // Results from another project: no write reaches this one, only a fresh scan.
    if (f.foreign && total && !running) {
      var away = targetWords(f.target, f);
      return { kind: 'foreign', mark: 'waiting', verdict: 'From ' + f.foreign, sentence: '', actions: away.scan ? ['scan'] : [], primary: 'scan',
        scanTip: away.scan && f.title ? f.title + ' · ' + away.scanTip : away.scanTip, scanWhat: 'target' };
    }
    if (f.outcome) {
      var o = f.outcome, list = o.green ? ['undo'] : (o.undo ? ['undo'] : []);
      if (!o.green) {
        if (o.failed && o.failed.length) { list.unshift('details'); }
        if (o.kind === 'undone' || !o.undo) { list = list.concat(writes); }
      }
      var result = { kind: o.kind, mark: o.green ? 'seal' : (o.kind === 'undone' ? 'done' : 'look'), verdict: o.verdict, sentence: o.sentence, green: !!o.green, actions: list, primary: list.indexOf('bins') >= 0 ? primary : null, binsOff: !sorted };
      // A write made while the scan looks closer is its own row: Undo is the result's and nothing else is, so the scan's
      // Stop waits for the scan's row to come back once the result closes. Meanwhile ··· › Stop Scan reaches it.
      return result;
    }
    if (running) {
      var p = progress(st);
      // One line while a scan runs: the spinning mark and a count. The count is the progress, so there is no bar to fill
      // twice, and the second stage gets its own words so its count starting again reads as a new step.
      // Stage three: every clip is usable, and the engine is still looking closer. The panel works, so it says so quietly.
      if (p.finished >= st.total && st.total && !sc.stopping) {
        var u = understandingShare(st), hold = !u.landed && !!f.needsTier2;
        return { kind: 'understanding', mark: 'running', verdict: 'Looking closer ' + fmtInt(u.done) + ' of ' + fmtInt(u.due), sentence: '',
          actions: ['stop'].concat(writes), primary: primary, binsOff: !sorted,
          held: hold ? ['label'].concat(writes) : [],
          wait: hold ? 'Waits for looking closer' : '' };
      }
      return { kind: 'scanning', mark: 'running', verdict: sc.stopping ? 'Stopping' : 'Reading ' + fmtInt(p.finished) + ' of ' + fmtInt(st.total), sentence: '', actions: ['stop'] };
    }
    // Before any results: what Scan would read now, live.
    if (!sc || !total) {
      var w = targetWords(f.target, f);
      return { kind: 'target', mark: 'waiting', verdict: w.verdict, sentence: w.sentence, tip: w.tip, actions: w.scan ? ['scan'] : [], primary: 'scan', scanTip: w.scanTip, scanWhat: 'target' };
    }
    var clips = plural(total, 'clip');
    var blank = st.noPicture ? noPictureSummary(st.noPicture) : '';
    var withBlank = function (line) { return blank ? (line ? line + (/[.!?]$/.test(line) ? ' ' : '. ') : '') + blank : line; };
    var count = f.shown === total ? clips : fmtInt(f.shown) + ' of ' + clips;
    // After a scan, a new Premiere selection outside the results adds a grey Scan and changes no words: its tooltip says
    // what it would read. Clips the cache couldn't answer offer the same, to read them.
    var offer = f.others > 0 ? 'target' : f.notRead ? 'same' : null;
    var again = { scanWhat: offer === 'target' ? 'target' : 'same',
      scanTip: offer === 'target' ? targetWords(f.target, f, f.others).scanTip : 'The same ' + clips };
    var extra = function (o) { var k; for (k in again) { if (again.hasOwnProperty(k)) { o[k] = again[k]; } } return o; };
    var tip = f.lastAt ? whenLine(f.lastAt, f.now) : '';
    if (sc.state === 'Stopped') {
      return extra({ kind: 'stopped', mark: 'skipped', verdict: 'Stopped', sentence: withBlank(fmtInt(progress(st).finished) + ' of ' + clips + ' read'), actions: writes.concat('scan'), primary: 'scan', binsOff: !sorted });
    }
    if (sc.failure) {
      return extra({ kind: 'failed', mark: 'failed', verdict: sc.failure.verdict, sentence: sc.failure.sentence, actions: writes.concat('scan'), primary: 'scan', binsOff: !sorted });
    }
    var read = total - st.errors;
    if (sc.state === 'Done' && !read) {
      return extra({ kind: 'unreadable', mark: 'look', verdict: 'Nothing could be read', sentence: '', actions: ['scan'], primary: 'scan' });
    }
    var actions = offer ? writes.concat('scan') : writes;
    // Facts only: the view's name, and a count when the view leaves clips out. The toolbar and the buttons say the rest.
    var show = f.view.show ? SHOW[f.view.show] : null;
    if (f.selected) {
      return extra({ kind: 'finished', mark: 'done', verdict: fmtInt(f.selected) + ' of ' + clips + ' selected', sentence: '', tip: tip, actions: actions, primary: primary, binsOff: !sorted });
    }
    var line = show && f.status === 'none' ? show.none : show && show.group ? plural(f.groupCount, 'group') : f.shown === total || f.query ? '' : count;
    var unread = f.notRead ? fmtInt(f.notRead) + ' not read' : '';
    return extra({ kind: 'finished', mark: 'done', verdict: viewName(f.view) || plural(total - (f.notRead || 0), 'clip') + ' read', sentence: withBlank([line, unread].filter(Boolean).join(' · ')),
      tip: tip, actions: actions, primary: primary, binsOff: !sorted });
  }

  // ---------------------------------------------------------------- the band and the bar

  // The band under the toolbar shows only news that ends, one row of it at a time, and closes once it has been said. By
  // rank: 1, a scan, a write or an Undo under way; 2, a write's result, or a scan that stopped or failed; 3, a note (a
  // refusal; a write that failed outright is a 2); 4, what Scan would read before any results, results from another
  // project, or a new Premiere selection waiting; 5, clips the cache lacked; 6, the update line (app.js). Calm results
  // have no row: the toolbar says the view, and the bar at the bottom counts the clips and what wasn't read. The writes
  // live in that bar, so the band keeps Stop, Details, Undo and Scan. Scan is blue only when it is the one thing to do:
  // before any results, and on another project's.
  // f: footState(x). x: the facts footState read. Returns {icon, tone, verdict, sentence, tip, actions, primary, rank}
  // or null.
  var BAND_ACTIONS = ['stop', 'details', 'undo', 'scan'];
  var UNDER_WAY = { writing: 1, listing: 1, restoring: 1, scanning: 1, understanding: 1 };

  // What Scan would read is a bin, the whole project (the project's root is a bin too), or clips.
  function targetIcon(t) {
    return t && (t.kind === 'clips' || t.kind === 'several') ? 'clips' : 'bin';
  }

  function bandRow(f, x) {
    var acts = f.actions.filter(function (a) { return BAND_ACTIONS.indexOf(a) >= 0; }), o = x.outcome;
    function row(rank, icon, tone, verdict, sentence, blue) {
      return { rank: rank, icon: icon, tone: tone, verdict: verdict, sentence: sentence || '', tip: f.kind === 'target' ? f.tip || '' : '', actions: acts, primary: blue && acts.indexOf('scan') >= 0 ? 'scan' : null };
    }
    if (UNDER_WAY[f.kind]) { return row(1, 'spinner', '', f.verdict, f.sentence); }
    if (f.kind === 'target') { return row(4, targetIcon(x.target), '', f.verdict, f.sentence, true); }
    if (f.kind === 'foreign') { return row(4, 'bin', '', f.verdict, '', true); }
    // A write's result: green on the icon only when it is proved, amber when part landed, red when nothing did. Only the
    // result's own actions sit beside it, even while the scan looks closer behind it.
    if (o && f.kind === o.kind) {
      if (o.green) { return row(2, 'check-circle', 'safe', f.verdict, f.sentence); }
      if (o.kind === 'undone') { return row(2, 'check-circle', '', f.verdict, f.sentence); }
      return row(2, 'alert', o.none ? 'bad' : 'warn', f.verdict, f.sentence);
    }
    if (f.kind === 'stopped') { return row(2, 'info', '', f.verdict, fmtInt(progress(x.store).finished) + ' of ' + plural(x.rows, 'clip') + ' read'); }
    if (f.kind === 'failed') { return row(2, 'alert', 'bad', f.verdict, f.sentence); }
    if (f.kind === 'unreadable') { return row(2, 'alert', 'bad', f.verdict, ''); }
    // Calm results: news only when Scan has something to read, a new selection or the clips the cache lacked.
    if (acts.indexOf('scan') < 0) { return null; }
    if (f.scanWhat === 'target') {
      var w = targetWords(x.target, x, x.others);
      return row(4, targetIcon(x.target), '', w.verdict, w.sentence);
    }
    return row(5, 'info', '', fmtInt(x.notRead) + ' not read', '');
  }

  // The one row the band shows, with the note: a note outranks a target, a new selection and clips not read, and then
  // takes their row with their Scan, so Scan is never hidden behind a refusal. A scan under way and a write's result
  // keep the row, and the note waits. note: {text, kind: '', 'warn' or 'bad'}.
  function bandShow(row, note) {
    if (!note || !note.text) { return row; }
    var rank = note.kind === 'bad' ? 2 : 3;
    if (row && row.rank <= rank) { return row; }
    return { rank: rank, icon: note.kind ? 'alert' : 'info', tone: note.kind || '', verdict: note.text, sentence: '', tip: '', actions: row ? row.actions : [], primary: row ? row.primary : null, note: true };
  }

  // The bar at the bottom, once there are results: the view switch, the count, Make Sequence and Sort into Bins, always
  // in their places. The count says, after a scan, how many clips weren't read whole (could not be read, not read from
  // the cache, no picture scores); its tooltip says why, and what the scan left out. A write is off, with its reason in
  // the tooltip, while another write runs, while the scan reads, while the view waits for looking closer, and for
  // another project's results; Sort into Bins too when the view makes no bins. The blue is Sort into Bins's alone, and
  // shows only while it can act.
  // x also holds skipped (items a scan left out: not video) and bad (engine lines not understood).
  // Returns {shown, count, countTip, sequence, bins, empty, primary}: sequence and bins are why each is off, or ''.
  function barState(f, x) {
    if (!x.rows) { return { shown: false }; }
    var total = x.rows, clips = plural(total, 'clip'), sorted = !!binsPlan(x.view, x.query, x.selected), sc = x.scan, st = x.store;
    var show = x.view.show ? SHOW[x.view.show] : null;
    var count = x.selected ? fmtInt(x.selected) + ' of ' + clips + ' selected'
      : (x.shown === total ? clips : fmtInt(x.shown) + ' of ' + clips) + (show && show.group && x.groupCount ? ' · ' + plural(x.groupCount, 'group') : '');
    var running = !!(sc && sc.state === 'Scanning'), reading = running && (progress(st).finished < st.total || sc.stopping);
    var settled = !!sc && !running && !x.restoring && !x.listing;
    var blank = st.noPicture ? st.noPicture.clips : 0, unread = settled ? st.errors + (st.notRead || 0) + blank : 0;
    var why = settled ? [unreadableSummary(st.rows || []), notUnderstoodSummary(st), blank ? noPictureSummary(st.noPicture) : '',
      x.bad ? plural(x.bad, 'engine line') + ' could not be understood.' : '', x.skipped ? plural(x.skipped, 'item') + ' skipped: not video.' : ''].filter(Boolean) : [];
    if (unread) { count += ' · ' + fmtInt(unread) + ' not read'; }
    var held = running && !reading && !!x.needsTier2 && !understandingShare(st).landed;
    var nothing = !!(sc && sc.state === 'Done' && total - st.errors <= 0);
    var off = x.busy ? 'A write is running' : x.foreign ? 'From ' + x.foreign : x.listing || x.restoring || reading ? 'Waits for the scan'
      : nothing ? 'Nothing could be read' : held ? 'Waits for looking closer' : '';
    // The tooltip says why first, then the count, then when the results were scanned.
    return { shown: true, count: count, countTip: why.concat([count], x.lastAt ? [whenLine(x.lastAt, x.now)] : []).join('\n'),
      sequence: off, bins: off || (sorted ? '' : 'Pick a Show, a colour or a sort'), empty: !x.shown, primary: x.foreign ? null : 'bins' };
  }

  return {
    INTERVIEW_MIN_S: INTERVIEW_MIN_S,
    INTERVIEW_SPEECH: INTERVIEW_SPEECH,
    speechConf: speechConf,
    COLUMNS: COLUMNS,
    COLUMN: COLUMN,
    SHOWS: SHOWS,
    SHOW: SHOW,
    SORTS: SORTS,
    SORT: SORT,
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
    hostCall: hostCall,
    isVideoPath: isVideoPath,
    videoItems: videoItems,
    fileUrl: fileUrl,
    fmtDuration: fmtDuration,
    fmtInt: fmtInt,
    plural: plural,
    themeFor: themeFor,
    skinTokens: skinTokens,
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
    batches: batches,
    projectKey: projectKey,
    undoWords: undoWords,
    whenWords: whenWords,
    undoReach: undoReach,
    fmtDate: fmtDate,
    footState: footState,
    pollTimes: pollTimes,
    nextPoll: nextPoll,
    pollRoom: pollRoom,
    pollItemRoom: pollItemRoom,
    POLL_MAX: POLL_MAX,
    POLL_ITEMS_HOURLY: POLL_ITEMS_HOURLY,
    sigCount: sigCount,
    POLL_HOURLY: POLL_HOURLY,
    bandRow: bandRow,
    bandShow: bandShow,
    barState: barState,
    targetIcon: targetIcon,
    ICONS: ICONS,
    iconSvg: iconSvg,
    iconUrl: iconUrl,
    FAMILIES: FAMILIES,
    FAMILY: FAMILY,
    viewFamilies: viewFamilies,
    familyWords: familyWords,
    knownView: knownView,
    rainbowKey: rainbowKey,
    searchTokens: searchTokens,
    matches: matches,
    matchedWord: matchedWord,
    folderNames: folderNames,
    suggestions: suggestions,
    viewCount: viewCount,
    dateNote: dateNote,
    orderColumns: orderColumns,
    moveColumn: moveColumn,
    dataStatus: dataStatus,
    showCount: showCount,
    showCounts: showCounts,
    warmSearch: warmSearch,
    TIER2_SORT: TIER2_KEYS,
    sortStatus: sortStatus,
    familyCounts: familyCounts,
    viewNeedsTier2: viewNeedsTier2,
    understandingShare: understandingShare,
    tileFact: tileFact,
    TILE: TILE,
    gridLayout: gridLayout,
    gridColumnX: gridColumnX,
    quoted: quoted,
    // Package A: the scan target, names, bins, last results.
    VIDEO_EXTS: Object.keys(VIDEO_EXT),
    targetCount: targetCount,
    otherClips: otherClips,
    scanOthers: scanOthers,
    wholeResults: wholeResults,
    sameTarget: sameTarget,
    placeWords: placeWords,
    targetWords: targetWords,
    binsPlan: binsPlan,
    viewWhat: viewWhat,
    sequenceName: sequenceName,
    goneLine: goneLine,
    whenLine: whenLine,
    isToday: isToday
  };
});
