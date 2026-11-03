// Everything in the panel that needs Node: the engine process, the optional write lock, the Undo records, the folder walk
// and the manifest.
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

  // What Undo Write reaches in a project: {ids, top}, every record id oldest first, and the newest record with something
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

  return {
    available: true,
    pickFolder: pickFolder,
    engineProblem: engineProblem,
    runEngine: runEngine,
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
