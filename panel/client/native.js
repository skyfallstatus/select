// Everything in the panel that needs Node: the engine process, the optional write lock, the Undo records, the last
// results, the folder walk, the Finder, the manifest and Premiere's font.
(function (root, factory) {
  var req = root.cep_node ? root.cep_node.require : (typeof require === 'function' ? require : null);
  var core = root.SelectCore || (typeof module === 'object' && module && module.exports ? require('./core.js') : null);
  var api = factory(req, core);
  root.SelectNative = api;
  if (typeof module === 'object' && module && module.exports) { module.exports = api; }
})(typeof window !== 'undefined' ? window : globalThis, function (req, core) {
  'use strict';
  if (!req) { return { available: false }; }

  var cp = req('child_process');
  var fs = req('fs');
  var os = req('os');
  var nodePath = req('path');
  var StringDecoder = req('string_decoder').StringDecoder;

  var KILL_AFTER_MS = 1500;
  var STDERR_TAIL = 4000;

  // The reason the engine cannot run, as an error code for core.engineFailure, or null when it can.
  function engineProblem(binary) {
    try {
      fs.accessSync(binary, fs.constants.X_OK);
      return null;
    } catch (e) {
      return e.code === 'ENOENT' ? 'ENOENT' : 'EACCES';
    }
  }

  // Spawns the engine out of process and streams its JSON Lines. Premiere is never blocked by a scan.
  // handlers: onMessage(msg), onBad(line), onExit({code, signal, stderr, error, stopped}).
  function runEngine(binary, paths, handlers, extraArgs) {
    var child = cp.spawn(binary, ['scan', '--paths-file', '-'].concat(extraArgs || []), { stdio: ['pipe', 'pipe', 'pipe'] });
    var decoder = new StringDecoder('utf8');
    var parser = new core.JsonlParser(handlers.onMessage, handlers.onBad);
    var stderr = '', spawnError = null, stopped = false, finished = false, killer = null;

    child.stdout.on('data', function (chunk) { parser.push(decoder.write(chunk)); });
    child.stdout.on('error', function () {});
    child.stderr.on('data', function (chunk) { stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL); });
    child.stdin.on('error', function () {});   // the engine may stop before it has read every path
    child.on('error', function (e) {
      spawnError = e;
      finish(null, null);
    });
    child.on('close', finish);

    function finish(code, signal) {
      if (finished) { return; }
      finished = true;
      if (killer) { clearTimeout(killer); }
      parser.push(decoder.end());
      parser.flush();
      handlers.onExit({
        code: code,
        signal: signal,
        stderr: stderr,
        error: spawnError ? String(spawnError.message || spawnError) : null,
        errorCode: spawnError ? spawnError.code || null : null,
        stopped: stopped
      });
    }

    if (child.pid) {
      child.stdin.end(paths.join('\n') + '\n');
    }

    return {
      pid: child.pid,
      // SIGTERM, then SIGKILL if the engine has not left. Used by the Stop button.
      stop: function () {
        if (finished || stopped) { return; }
        stopped = true;
        child.kill('SIGTERM');
        killer = setTimeout(function () { child.kill('SIGKILL'); }, KILL_AFTER_MS);
      },
      // For the page going away, when there is no time to wait. Closing stdout also stops the engine.
      kill: function () {
        if (!finished) { child.kill('SIGTERM'); }
      }
    };
  }

  // One clip's hover-scrub frames: `strip --path`, one line back. The engine gives up after 1.5 s by itself; past
  // STRIP_KILL_MS it is stopped anyway, as Stop stops a scan. done(err, msg) once, msg the strip line; an error line, a
  // crash or the deadline is err. stop() ends it without calling done.
  var STRIP_KILL_MS = 3000;

  function runStrip(binary, clip, done, killAfterMs) {
    var called = false, timer = null, killer = null, out = '', decoder = new StringDecoder('utf8'), child;
    function finish(err, msg) {
      if (called) { return; }
      called = true;
      clearTimeout(timer);
      done(err, msg || null);
    }
    function end() {
      child.kill('SIGTERM');
      killer = setTimeout(function () { child.kill('SIGKILL'); }, KILL_AFTER_MS);
    }
    try {
      child = cp.spawn(binary, ['strip', '--path', clip], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) {
      finish(e);
      return { stop: function () {} };
    }
    child.stdout.on('data', function (chunk) { out += decoder.write(chunk); });
    child.stdout.on('error', function () {});
    child.stdin.on('error', function () {});
    child.on('error', function (e) { finish(e); });
    child.on('close', function (code, signal) {
      if (killer) { clearTimeout(killer); }
      var msg = null;
      try { msg = JSON.parse((out + decoder.end()).split('\n')[0]); } catch (e) {}
      if (msg && msg.type === 'strip' && msg.file) { finish(null, msg); return; }
      finish(new Error(msg && msg.message ? String(msg.message) : 'The engine ended ' + (signal || 'with code ' + code) + '.'));
    });
    timer = setTimeout(function () { end(); finish(new Error('The engine took too long.')); }, killAfterMs || STRIP_KILL_MS);
    if (child.pid) { child.stdin.end(); }
    return { pid: child.pid, stop: function () { if (!called) { called = true; clearTimeout(timer); end(); } } };
  }

  function pidAlive(pid) {
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch (e) {
      return e.code === 'EPERM';
    }
  }

  function supportDir(home) {
    return nodePath.join(home || os.homedir(), 'Library', 'Application Support', 'com.skyfallstatus.select');
  }

  // One optional setting: {"writeLockFile": "<path>"}, for anyone who drives Premiere with their own tools. Anything
  // wrong with this file means no setting, because a stray file must never stop the panel.
  function configFile(home) {
    return nodePath.join(supportDir(home), 'config.json');
  }

  // ---------------------------------------------------------------- Undo records

  // One file per write, in a folder per project: undo/<projectKey>/<ms>-<seq>.json, so names sort oldest first and a
  // batch rewrites only its own record. A record names its project, and one that names another is ignored.
  // UNDO_FORMAT is the record's `v`. A record in another format, from a newer Select, is left for that Select to read.
  var RECORD = /^\d{13}-\d{4}\.json$/;
  var UNDO_FORMAT = 1;
  var seq = 0;

  function undoDir(project, home) {
    return nodePath.join(supportDir(home), 'undo', core.projectKey(project));
  }

  function newUndoId(now) {
    seq = (seq + 1) % 10000;
    return String(now === undefined ? Date.now() : now) + '-' + ('000' + seq).slice(-4);
  }

  // Record ids, oldest first. A folder that isn't there is no records.
  function listUndo(project, home) {
    try {
      return fs.readdirSync(undoDir(project, home)).filter(function (n) { return RECORD.test(n); }).sort().map(function (n) { return n.slice(0, -5); });
    } catch (e) {
      return [];
    }
  }

  // The record, or null when it can't be read, is in another format, or names another project. The project is compared
  // the way the folder is named, in one Unicode form: macOS may give the same path in either.
  function readUndo(project, id, home) {
    try {
      var e = JSON.parse(fs.readFileSync(nodePath.join(undoDir(project, home), id + '.json'), 'utf8'));
      if (!e || typeof e !== 'object' || e.v !== UNDO_FORMAT || typeof e.project !== 'string' || core.pathKey(e.project) !== core.pathKey(project)) { return null; }
      if (!e.restore || typeof e.restore !== 'object' || !Array.isArray(e.restore.items)) { return null; }
      e.id = id;
      return e;
    } catch (x) {
      return null;
    }
  }

  // What Undo reaches in a project: {ids, top}, every record id oldest first, and the newest record with something
  // left to put back. A record of this format with nothing in it, from a write whose first batch never answered, is
  // removed on the way, except `filling`, the one a running write is filling. A record that doesn't read is skipped and
  // stays on disk: it may be damaged, or a newer Select's, and only the newest UNDO_KEEP are kept anyway.
  function topUndo(project, filling, home) {
    var ids = listUndo(project, home), top = null;
    for (var i = ids.length - 1; i >= 0 && !top; i--) {
      var e = readUndo(project, ids[i], home);
      if (!e) { continue; }
      if (e.restore.items.length) { top = e; } else if (ids[i] !== filling && dropUndo(project, ids[i], home)) { ids.splice(i, 1); }
    }
    return { ids: ids, top: top };
  }

  // Written whole to a temporary file and renamed over the record, so a crash leaves the old record or the new one.
  // Then only the newest `keep` records stay. Returns {ok} or {ok: false, error}.
  function saveUndo(project, entry, keep, home) {
    var dir = undoDir(project, home), file = nodePath.join(dir, entry.id + '.json'), tmp = file + '.tmp';
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(entry));
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (x) {}
      return { ok: false, error: e.code || String(e.message || e) };
    }
    var all = listUndo(project, home);
    for (var i = 0; keep && i < all.length - keep; i++) { dropUndo(project, all[i], home); }
    return { ok: true };
  }

  function dropUndo(project, id, home) {
    try { fs.unlinkSync(nodePath.join(undoDir(project, home), id + '.json')); return true; } catch (e) { return false; }
  }

  function readConfig(file) {
    try {
      var config = JSON.parse(fs.readFileSync(file || configFile(), 'utf8'));
      return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
    } catch (e) {
      return {};
    }
  }

  // A write is refused while the lock file exists and its pid is alive. A dead pid is a stale file. A file that cannot
  // be read, or says nothing about a pid, counts as held. No setting means no check.
  function writeLock(config) {
    var file = (config || readConfig()).writeLockFile, text;
    if (typeof file !== 'string' || !file) { return { held: false }; }
    if (file.slice(0, 2) === '~/') { file = nodePath.join(os.homedir(), file.slice(2)); }
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      return e.code === 'ENOENT' ? { held: false } : { held: true, unreadable: true };
    }
    var holder;
    try {
      holder = JSON.parse(text);
    } catch (e) {
      return { held: true, unreadable: true };
    }
    if (!holder || typeof holder !== 'object' || !holder.pid) { return { held: true, unreadable: true }; }
    if (!pidAlive(holder.pid)) { return { held: false, stale: true }; }
    return { held: true, who: holder.who || '', op: holder.op || '', pid: holder.pid };
  }

  // The bundle version the manifest declares, or null. Read from the file so it cannot drift from the release.
  function manifestVersion(root) {
    try {
      var found = /ExtensionBundleVersion="([^"]+)"/.exec(fs.readFileSync(nodePath.join(root, 'CSXS', 'manifest.xml'), 'utf8'));
      return found ? found[1] : null;
    } catch (e) {
      return null;
    }
  }

  // Every video file under a folder, hidden files and folders left out. Reads names only. Stops at `most` video files,
  // so a drive root can't run for minutes, and stop() ends it at once. done(err, paths, {capped, stopped}); onCount(n)
  // as the count climbs.
  var MOST_FILES = 50000;

  function walkFolder(root, done, opts) {
    var o = opts || {}, most = o.most || MOST_FILES, found = [], pending = 0, failed = null, finished = false, capped = false, stopped = false;
    function finish() {
      if (finished) { return; }
      finished = true;
      if (!capped && !stopped) { found.sort(); }
      done(failed, capped || stopped ? [] : found, { capped: capped, stopped: stopped });
    }
    function visit(dir) {
      pending++;
      fs.readdir(dir, { withFileTypes: true }, function (err, entries) {
        if (finished) { return; }
        if (err) {
          if (dir === root) { failed = err; }
        } else {
          for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (e.name.charAt(0) === '.') { continue; }
            var full = nodePath.join(dir, e.name);
            if (e.isDirectory()) { visit(full); } else if (e.isFile() && core.isVideoPath(full)) { found.push(full); }
          }
          if (found.length > most) { capped = true; finish(); return; }
          if (o.onCount) { o.onCount(found.length); }
        }
        if (--pending === 0) { finish(); }
      });
    }
    visit(root);
    return { stop: function () { if (!finished) { stopped = true; finish(); } } };
  }

  // A folder dialog in its own process. CEP's cep.fs.showOpenDialog is synchronous, and inside Premiere 26.5 it showed
  // nothing and froze the panel. Here a dialog that fails can only fail: the panel keeps running. done(err, path), and
  // both are null when the editor cancels.
  var CHOOSE_FOLDER = [
    'on run argv',
    'activate',
    'if (item 2 of argv) is "" then',
    'set picked to choose folder with prompt (item 1 of argv)',
    'else',
    'set picked to choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv))',
    'end if',
    'return POSIX path of picked',
    'end run'
  ];
  var CHOOSE_TIMEOUT_MS = 300000;

  function pickFolder(prompt, start, done, execFile) {
    var from = '';
    try { if (start && fs.statSync(start).isDirectory()) { from = start; } } catch (e) {}
    var args = [];
    CHOOSE_FOLDER.forEach(function (line) { args.push('-e', line); });
    (execFile || cp.execFile)('/usr/bin/osascript', args.concat([prompt, from]), { timeout: CHOOSE_TIMEOUT_MS }, function (err, stdout, stderr) {
      if (!err) { return done(null, String(stdout).trim().replace(/(.)\/$/, '$1') || null); }
      if (/-128/.test(String(stderr))) { return done(null, null); }   // Cancel
      done(new Error(err.killed ? 'the dialog timed out' : (String(stderr).trim() || 'the dialog closed unexpectedly')), null);
    });
  }

  // ---------------------------------------------------------------- the Finder

  // Shows clips in the Finder, every one selected: the first 20 that are on disk, through the engine's `reveal`, since
  // `open -R` with several files selects only the last. Should the engine be missing or fail, `open -R` shows the first
  // one, so Reveal never does nothing. The engine gives up after 3 s by itself; past REVEAL_KILL_MS it is stopped.
  // done(err, shown).
  var MOST_REVEAL = 20, REVEAL_KILL_MS = 6000;

  // The first `most` of these paths that are on disk.
  function onDisk(paths, most) {
    return (paths || []).slice(0, most || MOST_REVEAL).filter(function (p) {
      try { return fs.existsSync(p); } catch (e) { return false; }
    });
  }

  function revealInFinder(binary, paths, done, execFile) {
    var list = onDisk(paths), exec = execFile || cp.execFile;
    if (!list.length) { done(null, 0); return; }
    function openFirst() {
      exec('/usr/bin/open', ['-R', list[0]], { timeout: 10000 }, function (err) {
        done(err ? new Error(err.killed ? 'the Finder took too long' : String(err.message || err)) : null, err ? 0 : 1);
      });
    }
    if (!binary || engineProblem(binary)) { openFirst(); return; }
    exec(binary, ['reveal'].concat(list), { timeout: REVEAL_KILL_MS }, function (err, stdout) {
      var msg = null;
      try { msg = JSON.parse(String(stdout || '').split('\n')[0]); } catch (e) {}
      // shown 0: they went from the disk since the look above.
      if (!err && msg && msg.type === 'reveal') { done(null, msg.shown || 0); return; }
      openFirst();
    });
  }

  // ---------------------------------------------------------------- last results

  // What a project's last scan read, so a panel opened again shows it from the cache: last/<projectKey>.json, one per
  // project, the newest LAST_KEEP kept. A record names its project, and one that names another, or is in another
  // format, is ignored.
  var LAST_FORMAT = 1, LAST_KEEP = 20, LAST_FILE = /^[0-9a-f]{16}\.json$/, lastSaved = 0;

  function lastDir(home) {
    return nodePath.join(supportDir(home), 'last');
  }

  function lastFile(project, home) {
    return nodePath.join(lastDir(home), core.projectKey(project) + '.json');
  }

  function readLast(file, project) {
    try {
      var r = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!r || typeof r !== 'object' || r.v !== LAST_FORMAT || typeof r.project !== 'string' || !Array.isArray(r.paths)) { return null; }
      if (project !== undefined && core.pathKey(r.project) !== core.pathKey(project)) { return null; }
      return r;
    } catch (e) {
      return null;
    }
  }

  // Written whole to a temporary file and renamed, so a crash leaves the old record or the new one. Then only the
  // LAST_KEEP projects saved most recently stay. Returns {ok} or {ok: false, error}.
  function saveLast(project, record, home) {
    var dir = lastDir(home), file = lastFile(project, home), tmp = file + '.tmp';
    record.v = LAST_FORMAT;
    record.project = project;
    // Strictly later than the save before, so the newest are known even within one millisecond.
    lastSaved = record.saved = Math.max(Date.now(), lastSaved + 1);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(record));
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (x) {}
      return { ok: false, error: e.code || String(e.message || e) };
    }
    keepNewest(dir, file.slice(dir.length + 1), record.saved);
    return { ok: true };
  }

  // Which records are newest, from a small index (last/index.json: file name to when it was saved), so a save never
  // reads the other records. A record the index doesn't know, as after the index was lost, counts as the oldest; one
  // that has gone leaves it.
  var LAST_INDEX = 'index.json';
  function keepNewest(dir, name, saved) {
    var index = {}, names = [], file = nodePath.join(dir, LAST_INDEX);
    try {
      var read = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (read && typeof read === 'object' && !Array.isArray(read)) { index = read; }
    } catch (e) {}
    try { names = fs.readdirSync(dir).filter(function (n) { return LAST_FILE.test(n); }); } catch (e) {}
    var kept = {};
    names.forEach(function (n) { kept[n] = typeof index[n] === 'number' ? index[n] : 0; });
    kept[name] = saved;
    var order = Object.keys(kept).sort(function (a, b) { return kept[b] - kept[a]; });
    order.slice(LAST_KEEP).forEach(function (n) {
      try { fs.unlinkSync(nodePath.join(dir, n)); } catch (e) {}
      delete kept[n];
    });
    try {
      fs.writeFileSync(file + '.tmp', JSON.stringify(kept));
      fs.renameSync(file + '.tmp', file);
    } catch (e) {
      try { fs.unlinkSync(file + '.tmp'); } catch (x) {}
    }
  }

  // The record, or null when there is none, it can't be read, it is in another format or names another project.
  function loadLast(project, home) {
    return project ? readLast(lastFile(project, home), project) : null;
  }

  // A file's bytes, for Premiere's own font (app.js loadHostFont). done(err, buffer).
  function readFile(file, done) {
    fs.readFile(file, done);
  }

  return {
    available: true,
    readFile: readFile,
    revealInFinder: revealInFinder,
    onDisk: onDisk,
    MOST_REVEAL: MOST_REVEAL,
    lastResults: { save: saveLast, load: loadLast, dir: lastDir, file: lastFile, KEEP: LAST_KEEP },
    pickFolder: pickFolder,
    engineProblem: engineProblem,
    runEngine: runEngine,
    runStrip: runStrip,
    STRIP_KILL_MS: STRIP_KILL_MS,
    configFile: configFile,
    readConfig: readConfig,
    undoDir: undoDir,
    newUndoId: newUndoId,
    listUndo: listUndo,
    readUndo: readUndo,
    topUndo: topUndo,
    UNDO_FORMAT: UNDO_FORMAT,
    saveUndo: saveUndo,
    dropUndo: dropUndo,
    MOST_FILES: MOST_FILES,
    writeLock: writeLock,
    manifestVersion: manifestVersion,
    walkFolder: walkFolder
  };
});
