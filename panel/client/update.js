// Select updates itself. Once a day it asks GitHub's releases API whether there is a newer version. When there is, it
// downloads the release's signed manifest and checks its Ed25519 signature before it believes anything the release
// says, then downloads Select.zxp, checks the size and the SHA-256, unpacks it outside Adobe's extensions folder, and
// swaps it into the user's extensions folder when no scan or write is running. The old copy is kept for rollback. Then
// one quiet line offers a restart. A release without a manifest signed with the release key is never mentioned on its
// own: anyone who can make a release could have made it.
// Self-contained: it wires itself to the panel and only reads window.SelectApp.state. docs/PACKAGING.md says why.
(function (root, factory) {
  var req = root.cep_node ? root.cep_node.require : (typeof require === 'function' ? require : null);
  var api = factory(req);
  root.SelectUpdate = api;
  if (typeof module === 'object' && module && module.exports) { module.exports = api; }
  if (typeof document !== 'undefined' && root.SelectApp && api.available) {
    try { api.attach(root, document); } catch (e) { /* an update problem must never stop the panel */ }
  }
})(typeof window !== 'undefined' ? window : globalThis, function (req) {
  'use strict';

  // Stamped from product.conf's REPO by scripts/stamp-panel.sh at build time. Change it there, not here.
  var REPO = 'skyfallstatus/select';
  var ENGINE = 'select-engine';
  // The release key. Its private half never leaves the maintainer's Mac: see docs/RELEASING.md.
  var KEYS = { '477ec9c948d3721b': 'MCowBQYDK2VwAyEAQlDwgj9ZKbTzLbJaC6t1PiDQ6HUkM8nnmmOdHTMdwW8=' };
  var API = 'https://api.github.com';
  // GitHub answers on api.github.com, and a release file redirects from github.com to one of its asset hosts.
  var HOSTS = ['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com'];
  var DAY = 24 * 3600 * 1000;
  // lockNewMs: how long a lock folder may be without its owner file, which its maker writes right after it.
  var LIMITS = { api: 1024 * 1024, manifest: 64 * 1024, zxp: 500 * 1024 * 1024, idleMs: 30000, apiMs: 20000, zxpMs: 15 * 60000, unzipMs: 120000, engineMs: 15000, lockNewMs: 2 * 60000 };
  var VERSION_RE = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

  // ---------------------------------------------------------------- pure parts, no Node needed

  function parseVersion(v) {
    var m = VERSION_RE.exec(String(v || '').replace(/^v/, ''));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }

  // 1 when a is newer, -1 when older, 0 when the same. null when either isn't x.y.z.
  function compareVersions(a, b) {
    var x = parseVersion(a), y = parseVersion(b);
    if (!x || !y) { return null; }
    for (var i = 0; i < 3; i++) {
      if (x[i] !== y[i]) { return x[i] > y[i] ? 1 : -1; }
    }
    return 0;
  }

  // 0.2.0 reads as 0.2, 0.2.1 stays as it is.
  function shortVersion(v) {
    return String(v).replace(/^v/, '').replace(/\.0$/, '');
  }

  function readManifestText(xml) {
    var get = function (re) { var m = re.exec(xml); return m ? m[1] : null; };
    return {
      bundleId: get(/ExtensionBundleId="([^"]+)"/),
      version: get(/ExtensionBundleVersion="([^"]+)"/),
      name: get(/ExtensionBundleName="([^"]+)"/),
      script: get(/<ScriptPath>\.\/([^<]+)<\/ScriptPath>/)
    };
  }

  // What CEP reads only when Premiere starts: everything in the manifest except the versions. When that changes, a
  // reload of the panel isn't enough.
  function manifestShape(xml) {
    return String(xml)
      .replace(/ExtensionBundleVersion="[^"]*"/g, 'ExtensionBundleVersion=""')
      .replace(/(<Extension\s+Id="[^"]*"\s+Version=")[^"]*"/g, '$1"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function allowedUrl(url, policy) {
    var u;
    try { u = new URL(url); } catch (e) { return false; }
    return policy.protocols.indexOf(u.protocol) >= 0 && policy.hosts.indexOf(u.hostname) >= 0 && !u.username && !u.password && (!u.port || policy.ports === 'any');
  }

  // Run in ExtendScript after a reload. CEP evaluated ScriptPath when the panel first loaded, and a reload of the page
  // may leave that old host in memory, so a host of another version is evaluated again from the folder now on disk.
  // When there's no host at all, app.js loads it.
  function hostRefreshScript(file, version) {
    return 'typeof slCall !== "function" ? "absent" : (typeof SELECT_HOST_VERSION !== "undefined" && SELECT_HOST_VERSION === ' +
      JSON.stringify(version) + ') ? "current" : ($.evalFile(' + JSON.stringify(file) + '), "loaded " + SELECT_HOST_VERSION)';
  }

  // The page of one release, never releases/latest: that could be another release by the time it's opened.
  function releasePage(version) {
    return parseVersion(version) ? 'https://github.com/' + REPO + '/releases/tag/v' + String(version).replace(/^v/, '') : null;
  }

  // The words for the line at the bottom of the panel, or null for nothing. Automatic checks speak only when there's
  // something to act on, and only once per version. Every status that names a version comes from the Updater only
  // after a manifest signed with the release key named that version: 'unverified' is all an unsigned release gets.
  function lineFor(result, name, manual) {
    var v = result.version ? name + ' ' + shortVersion(result.version) : name;
    var page = releasePage(result.version);
    switch (result.status) {
      case 'checking': return manual ? { text: 'Checking for updates…' } : null;
      case 'downloading': return manual ? { text: 'Downloading ' + v + '…' } : null;
      case 'ready':
        return result.needsPremiereRestart ? { text: v + ' is ready. Restart Premiere to use it.' } : { text: v + ' is ready.', restart: true };
      case 'waiting':
        return manual ? { text: v + ' is downloaded. It installs as soon as ' + (result.busy === 'write' ? 'this write ends.' : result.busy === 'scan' ? 'this scan ends.' : 'the panel is free.') } : null;
      case 'current': return manual ? { text: name + ' ' + shortVersion(result.running) + ' is the latest version.', fades: true } : null;
      case 'off': return null;
      case 'busy': return manual ? { text: 'Another Premiere is updating ' + name + ' right now.', fades: true } : null;
      case 'offline': return manual ? { text: 'Couldn\'t reach GitHub. Try again later.', fades: true } : null;
      case 'manual': return page ? { text: v + ' is out. Install it with ' + name + '.pkg.', link: page } : null;
      case 'blocked': return page ? { text: v + ' is out. This copy can\'t replace itself, so install it with ' + name + '.pkg.', link: page } : null;
      case 'quarantined': return page ? { text: v + ' is out, but macOS quarantined the download, so it wasn\'t installed. Install it with ' + name + '.pkg.', link: page } : null;
      case 'unverified': return manual ? { text: 'No verified update is available.', detail: result.message } : null;
      case 'dev': return manual ? { text: v + ' is out. This is a development copy, so it\'s left as it is.' } : null;
      case 'rejected': return manual ? { text: v + ' didn\'t pass its checks, so it wasn\'t installed.', detail: result.message } : null;
      case 'failed': return manual ? { text: (result.version ? v + ' couldn\'t be installed' : 'The update check failed') + '. Nothing changed.', detail: result.message } : null;
      default: return null;
    }
  }

  var pure = {
    REPO: REPO, ENGINE: ENGINE, KEYS: KEYS, HOSTS: HOSTS, DAY: DAY, LIMITS: LIMITS,
    parseVersion: parseVersion, compareVersions: compareVersions, shortVersion: shortVersion, readManifestText: readManifestText,
    manifestShape: manifestShape, allowedUrl: allowedUrl, hostRefreshScript: hostRefreshScript, lineFor: lineFor, releasePage: releasePage
  };

  var mods = null;
  try {
    mods = req && { fs: req('fs'), path: req('path'), os: req('os'), crypto: req('crypto'), http: req('http'), https: req('https'), cp: req('child_process') };
    if (mods) {
      for (var k in mods) { if (!mods[k]) { mods = null; break; } }
    }
    if (mods && (typeof mods.crypto.verify !== 'function' || typeof mods.fs.renameSync !== 'function' || typeof mods.https.request !== 'function' || typeof mods.cp.execFile !== 'function')) { mods = null; }
  } catch (e) {
    mods = null;
  }
  if (!mods) {
    pure.available = false;
    return pure;
  }
  var nodePath = mods.path, os = mods.os, crypto = mods.crypto;

  // CEP's Node is built by Adobe. Ed25519 is in Node from version 12, but this proves it once with RFC 8032's first
  // test vector before any signature is trusted to say no.
  var RFC8032 = {
    key: 'MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=',
    sig: '5VZDAMNgrHKQhuLMgG6CioSHfx645dl02HPgZSJJAVVfuIIVkKM7rMYeOXAc+bRr0lv18FlbviRlUUFDjnoQCw=='
  };
  var selfTested = null;
  function ed25519Works() {
    if (selfTested === null) {
      try {
        var key = crypto.createPublicKey({ key: Buffer.from(RFC8032.key, 'base64'), format: 'der', type: 'spki' });
        var sig = Buffer.from(RFC8032.sig, 'base64'), bad = Buffer.from(sig);
        bad[0] ^= 1;
        selfTested = crypto.verify(null, Buffer.alloc(0), key, sig) === true && crypto.verify(null, Buffer.alloc(0), key, bad) === false;
      } catch (e) {
        selfTested = false;
      }
    }
    return selfTested;
  }

  // ---------------------------------------------------------------- errors

  function problem(status, message, extra) {
    var e = new Error(message);
    e.status = status;
    if (extra) { for (var k in extra) { e[k] = extra[k]; } }
    return e;
  }

  var OFFLINE = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'ENETDOWN', 'EPIPE', 'ECONNABORTED'];

  // ---------------------------------------------------------------- the signed manifest

  // Own keys only: an id such as __proto__ or toString names nothing here.
  function keyFor(id, keys) {
    var table = keys || KEYS;
    if (!Object.prototype.hasOwnProperty.call(table, id) || typeof table[id] !== 'string') { return null; }
    try { return crypto.createPublicKey({ key: Buffer.from(table[id], 'base64'), format: 'der', type: 'spki' }); } catch (e) { return null; }
  }

  // The signed manifest: {format, key, payload, signature}. payload is base64 of the JSON that was signed, so nothing
  // is re-serialised before it's checked. Returns the payload, or throws a 'rejected' problem.
  function openManifest(text, keys) {
    var outer;
    try { outer = JSON.parse(text); } catch (e) { throw problem('rejected', 'The update manifest isn\'t JSON.'); }
    if (!outer || outer.format !== 1 || typeof outer.payload !== 'string' || typeof outer.signature !== 'string' || typeof outer.key !== 'string') {
      throw problem('rejected', 'The update manifest isn\'t in the expected form.');
    }
    var key = keyFor(outer.key, keys);
    if (!key) { throw problem('rejected', 'The update manifest is signed with a key this version doesn\'t know.'); }
    var body = Buffer.from(outer.payload, 'base64'), sig = Buffer.from(outer.signature, 'base64');
    var good = false;
    try { good = sig.length === 64 && crypto.verify(null, body, key, sig); } catch (e) { good = false; }
    if (!good) { throw problem('rejected', 'The update manifest\'s signature doesn\'t verify.'); }
    var p;
    try { p = JSON.parse(body.toString('utf8')); } catch (e) { throw problem('rejected', 'The signed part of the manifest isn\'t JSON.'); }
    if (!p || p.format !== 1 || !parseVersion(p.version) || typeof p.bundleId !== 'string' || typeof p.file !== 'string' ||
        typeof p.size !== 'number' || !(p.size > 0 && p.size <= LIMITS.zxp && Math.floor(p.size) === p.size) || !/^[0-9a-f]{64}$/.test(String(p.sha256))) {
      throw problem('rejected', 'The signed manifest is missing a field.');
    }
    return p;
  }

  // ---------------------------------------------------------------- the network: GET only, to GitHub only

  function get(url, o) {
    return new Promise(function (resolve, reject) {
      var hops = 0, finished = false, current = null;
      var overall = setTimeout(function () { stop(problem('offline', 'GitHub took too long to answer.')); }, o.totalMs);
      function stop(err, value) {
        if (finished) { return; }
        finished = true;
        clearTimeout(overall);
        if (err && current) { try { current.destroy(); } catch (e) {} }
        if (err) { reject(err); } else { resolve(value); }
      }
      function go(u) {
        if (!allowedUrl(u, o.policy)) { return stop(problem('rejected', 'Refused to fetch from ' + safeHost(u) + '.')); }
        var parsed = new URL(u);
        var mod = parsed.protocol === 'https:' ? mods.https : mods.http;
        var request = mod.request(parsed, { method: 'GET', agent: false, headers: { 'User-Agent': 'Select', 'Accept': o.accept } }, function (res) {
          var code = res.statusCode;
          if (code === 301 || code === 302 || code === 303 || code === 307 || code === 308) {
            res.resume();
            if (++hops > 5) { return stop(problem('failed', 'Too many redirects.')); }
            var next;
            try { next = new URL(String(res.headers.location || ''), parsed).toString(); } catch (e) { return stop(problem('failed', 'A bad redirect.')); }
            if (!res.headers.location) { return stop(problem('failed', 'A redirect with nowhere to go.')); }
            return go(next);
          }
          if (code !== 200) {
            res.resume();
            return stop(problem(code === 404 && o.missingOk ? 'none' : 'failed', 'GitHub answered ' + code + '.'));
          }
          var declared = Number(res.headers['content-length']);
          if (declared > o.max) { res.resume(); return stop(problem(o.tooBig || 'failed', 'The file is bigger than it should be.')); }
          o.receive(res, stop);
        });
        current = request;
        request.setTimeout(LIMITS.idleMs, function () { request.destroy(problem('offline', 'The connection went quiet.')); });
        request.on('error', function (e) {
          if (e && e.status) { return stop(e); }
          stop(problem(OFFLINE.indexOf(e && e.code) >= 0 ? 'offline' : 'failed', 'Network: ' + (e && (e.code || e.message))));
        });
        request.end();
      }
      go(url);
    });
  }

  function safeHost(u) {
    try { return new URL(u).host || 'there'; } catch (e) { return 'a bad address'; }
  }

  function getText(url, o) {
    return get(url, {
      policy: o.policy, accept: o.accept, max: o.max, totalMs: o.totalMs, missingOk: o.missingOk,
      receive: function (res, stop) {
        var chunks = [], size = 0;
        res.on('data', function (c) {
          size += c.length;
          if (size > o.max) { res.destroy(); return stop(problem('failed', 'The answer is bigger than it should be.')); }
          chunks.push(c);
        });
        res.on('end', function () { stop(null, Buffer.concat(chunks).toString('utf8')); });
        res.on('error', function (e) { stop(problem('offline', 'Network: ' + (e.code || e.message))); });
      }
    });
  }

  // Streams to a new file and hashes on the way, stopping as soon as it's longer than the signed size.
  function download(url, file, expect, o, F) {
    return get(url, {
      policy: o.policy, accept: 'application/octet-stream', max: expect.size, totalMs: LIMITS.zxpMs, tooBig: 'rejected',
      receive: function (res, stop) {
        var hash = crypto.createHash('sha256'), size = 0, out = F.createWriteStream(file, { flags: 'wx', mode: 384 }), failed = false;
        function bail(err) {
          if (failed) { return; }
          failed = true;
          res.destroy();
          out.destroy();
          stop(err);
        }
        res.on('data', function (c) {
          size += c.length;
          if (size > expect.size) { return bail(problem('rejected', 'The download is bigger than the signed size.')); }
          hash.update(c);
        });
        res.on('error', function (e) { bail(problem('offline', 'Network: ' + (e.code || e.message))); });
        out.on('error', function (e) { bail(problem('failed', 'Couldn\'t save the download: ' + (e.code || e.message))); });
        out.on('finish', function () {
          if (failed) { return; }
          if (size !== expect.size) { return stop(problem('rejected', 'The download is ' + size + ' bytes, and the signed size is ' + expect.size + '.')); }
          var digest = hash.digest('hex');
          if (digest !== expect.sha256) { return stop(problem('rejected', 'The download\'s SHA-256 doesn\'t match the signed one.')); }
          stop(null, { size: size, sha256: digest });
        });
        res.pipe(out);
      }
    });
  }

  // ---------------------------------------------------------------- files

  function exists(F, p) {
    try { F.lstatSync(p); return true; } catch (e) { return false; }
  }

  function removeTree(F, p) {
    if (!exists(F, p)) { return; }
    if (F.rmSync) { F.rmSync(p, { recursive: true, force: true }); } else { F.rmdirSync(p, { recursive: true }); }
    if (exists(F, p)) { throw problem('failed', 'Couldn\'t remove ' + nodePath.basename(p) + '.'); }
  }

  // Every entry under dir, depth first. Refuses links, which Adobe's installer breaks and which could point anywhere.
  function walk(F, dir, visit) {
    var list = F.readdirSync(dir);
    for (var i = 0; i < list.length; i++) {
      var p = nodePath.join(dir, list[i]), st = F.lstatSync(p);
      if (st.isSymbolicLink()) { throw problem('rejected', 'The update has a link in it: ' + list[i] + '.'); }
      visit(p, st);
      if (st.isDirectory()) { walk(F, p, visit); }
    }
  }

  function writeJsonAtomic(F, file, value) {
    var tmp = file + '.' + process.pid + '.tmp';
    F.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 384 });
    F.renameSync(tmp, file);
  }

  function run(execFile, file, args, timeout) {
    return new Promise(function (resolve) {
      execFile(file, args, { timeout: timeout, maxBuffer: 1024 * 1024 }, function (err, stdout, stderr) {
        resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), killed: !!(err && err.killed) });
      });
    });
  }

  // ---------------------------------------------------------------- the updater

  // o.root            the running extension folder (required)
  // o.isBusy()        'scan', 'write' or 'panel' while the folder must not change, else null
  // Tests only: o.extensionsDir, o.supportDir, o.api, o.policy, o.keys, o.fs, o.execFile, o.now.
  function Updater(o) {
    var home = os.homedir();
    this.root = o.root;
    this.extensionsDir = o.extensionsDir || nodePath.join(home, 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions');
    this.supportDir = o.supportDir || nodePath.join(home, 'Library', 'Application Support', 'com.skyfallstatus.select');
    this.dir = nodePath.join(this.supportDir, 'updates');
    this.api = o.api || API;
    this.policy = o.policy || { protocols: ['https:'], hosts: HOSTS };
    this.keys = o.keys || KEYS;
    this.F = o.fs || mods.fs;
    this.execFile = o.execFile || mods.cp.execFile;
    this.now = o.now || function () { return Date.now(); };
    this.isBusy = o.isBusy || function () { return null; };
    this.inFlight = null;
    this.staged = null;
    this.locked = false;
    this.loadedXml = null;
  }

  Updater.prototype.running = function () {
    var text;
    try { text = this.F.readFileSync(nodePath.join(this.root, 'CSXS', 'manifest.xml'), 'utf8'); } catch (e) { return null; }
    // The manifest this page was loaded with, as far as this object knows: the first one it read.
    if (this.loadedXml === null) { this.loadedXml = text; }
    var m = readManifestText(text);
    return m.bundleId && parseVersion(m.version) ? { bundleId: m.bundleId, version: m.version, name: m.name || 'Select', script: m.script, xml: text } : null;
  };

  // ---- settings and memory, in the support folder beside config.json

  Updater.prototype.stateFile = function () { return nodePath.join(this.dir, 'state.json'); };

  Updater.prototype.load = function () {
    var s = {};
    try { s = JSON.parse(this.F.readFileSync(this.stateFile(), 'utf8')) || {}; } catch (e) { s = {}; }
    if (typeof s !== 'object' || Array.isArray(s)) { s = {}; }
    return {
      automatic: s.automatic !== false,
      lastCheck: Number(s.lastCheck) || 0,
      lastAttempt: Number(s.lastAttempt) || 0,
      lastResult: s.lastResult || null,
      ready: s.ready && parseVersion(s.ready.version) ? s.ready : null,
      told: s.told && typeof s.told === 'object' ? s.told : {}
    };
  };

  Updater.prototype.save = function (change) {
    var s = this.load();
    for (var k in change) { s[k] = change[k]; }
    try {
      this.F.mkdirSync(this.dir, { recursive: true, mode: 448 });
      writeJsonAtomic(this.F, this.stateFile(), s);
    } catch (e) { /* settings that can't be saved fall back to the defaults next time */ }
    return s;
  };

  Updater.prototype.setAutomatic = function (on) { return this.save({ automatic: !!on }).automatic; };

  // Due when the panel opens: automatic, and no good answer from GitHub in the last day.
  Updater.prototype.dueOnOpen = function () {
    var s = this.load(), age = this.now() - s.lastCheck;
    return s.automatic && (age >= DAY || age < 0);
  };

  // Due while the panel stays open: a day since the last try, whatever it gave.
  Updater.prototype.dueWhileOpen = function () {
    var s = this.load(), age = this.now() - Math.max(s.lastCheck, s.lastAttempt);
    return s.automatic && (age >= DAY || age < 0);
  };

  // Once per version, for the lines automatic checks show.
  Updater.prototype.tellOnce = function (key) {
    var s = this.load();
    if (s.told[key]) { return false; }
    s.told[key] = this.now();
    var keys = Object.keys(s.told);
    if (keys.length > 20) { delete s.told[keys[0]]; }
    this.save({ told: s.told });
    return true;
  };

  // When the panel opens. Forgets an update that is now the running version, and cleans what a closed panel left.
  Updater.prototype.opened = function () {
    var me = this.running(), s = this.load();
    if (me && s.ready && (compareVersions(me.version, s.ready.version) >= 0 || !this.holds(me, s.ready.version))) {
      this.save({ ready: null });
      s.ready = null;
    }
    if (!this.lockHeld()) { this.cleanWork(); }
    return s.ready && me ? { status: 'ready', version: s.ready.version, running: me.version, needsPremiereRestart: s.ready.needsPremiereRestart } : null;
  };

  // ---- a lock, so two Premieres never update the same folder at once

  Updater.prototype.lockDir = function () { return nodePath.join(this.dir, 'lock'); };

  // Held while its owner is alive, however long that is: a Premiere waiting for a long scan to end before it installs
  // still needs its staged copy. A folder with no owner file yet is one another Premiere has just made, so it's held
  // unless it's older than LIMITS.lockNewMs. This page's own process holds it only while this page is using it: a
  // lock from before a reload is free.
  Updater.prototype.lockHeld = function () {
    var F = this.F, dir = this.lockDir(), st, info;
    try { st = F.statSync(dir); } catch (e) { return false; }
    try { info = JSON.parse(F.readFileSync(nodePath.join(dir, 'owner.json'), 'utf8')); } catch (e) { info = null; }
    var pid = info && typeof info === 'object' ? info.pid : null;
    if (typeof pid !== 'number' || !(pid > 0) || Math.floor(pid) !== pid) {
      var age = Date.now() - st.mtimeMs;
      return age < LIMITS.lockNewMs;
    }
    if (pid === process.pid) { return !!(this.locked || this.inFlight || this.staged); }
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  };

  Updater.prototype.lock = function () {
    var F = this.F, dir = this.lockDir();
    F.mkdirSync(this.dir, { recursive: true, mode: 448 });
    if (exists(F, dir)) {
      if (this.lockHeld()) { return false; }
      removeTree(F, dir);
    }
    try { F.mkdirSync(dir, { mode: 448 }); } catch (e) { return false; }
    F.writeFileSync(nodePath.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, at: this.now() }));
    this.locked = true;
    return true;
  };

  // Only a lock this page took. Another Premiere's stays where it is.
  Updater.prototype.unlock = function () {
    if (!this.locked) { return; }
    this.locked = false;
    try { removeTree(this.F, this.lockDir()); } catch (e) {}
  };

  Updater.prototype.cleanWork = function () {
    var F = this.F, dir = this.dir, list;
    try { list = F.readdirSync(dir); } catch (e) { return; }
    for (var i = 0; i < list.length; i++) {
      if (/^work-/.test(list[i]) && !(this.staged && this.staged.work === nodePath.join(dir, list[i]))) {
        try { removeTree(F, nodePath.join(dir, list[i])); } catch (e) {}
      }
    }
  };

  // ---- where the new copy goes

  // The folder in the user's extensions folder that CEP loads this panel from, and whether this copy may be replaced.
  Updater.prototype.target = function (me) {
    var F = this.F, real = function (p) { try { return F.realpathSync(p); } catch (e) { return nodePath.resolve(p); } };
    var runningAt = real(this.root), extensions = real(this.extensionsDir);
    var inside = nodePath.dirname(runningAt) === extensions;
    var target = inside ? runningAt : nodePath.join(extensions, me.bundleId);
    var plan = { target: target, here: inside, problem: null };
    if (!exists(F, target)) {
      var up = target;
      while (!exists(F, up)) { up = nodePath.dirname(up); }
      try { F.accessSync(up, F.constants.W_OK); } catch (e) { plan.problem = 'blocked'; }
      return plan;
    }
    var st = F.lstatSync(target);
    if (st.isSymbolicLink() || !st.isDirectory()) { plan.problem = 'dev'; return plan; }
    if (!exists(F, nodePath.join(target, 'META-INF', 'signatures.xml'))) { plan.problem = 'dev'; return plan; }
    // Renaming the folder needs its parent and the folder itself. Removing it later needs every folder inside.
    try {
      F.accessSync(nodePath.dirname(target), F.constants.W_OK);
      F.accessSync(target, F.constants.W_OK);
      walk(F, target, function (p, s) { if (s.isDirectory()) { F.accessSync(p, F.constants.W_OK); } });
    } catch (e) {
      plan.problem = e.status === 'rejected' ? 'dev' : 'blocked';
    }
    return plan;
  };

  // ---- the check

  // One check, start to end. Resolves to {status, version, running, ...} and never rejects.
  // status: current, ready, waiting, offline, failed, rejected, manual, blocked, quarantined, dev, unverified, off, busy.
  // Only current, offline, failed, unverified, off and busy can come from a release whose signed manifest didn't verify,
  // and none of them names its version.
  Updater.prototype.check = function (opts) {
    var me = this;
    opts = opts || {};
    if (me.inFlight) { return me.inFlight; }
    // A downloaded update is waiting for the panel to be free. Try that, rather than download it again.
    if (me.staged) { return me.install(); }
    if (!opts.manual && !me.load().automatic) { return Promise.resolve({ status: 'off' }); }
    var p = me.checkNow(opts).then(function (r) { return r; }, function (e) {
      return { status: e.status || 'failed', message: e.message, version: e.version || null };
    }).then(function (r) {
      me.inFlight = null;
      if (r.status !== 'busy' && r.status !== 'waiting') { me.unlock(); }
      var mine = me.running();
      r.running = r.running || (mine && mine.version);
      var change = { lastAttempt: me.now(), lastResult: { status: r.status, version: r.version || null, message: r.message || null, at: me.now() } };
      if (['current', 'ready', 'manual', 'blocked', 'dev', 'quarantined', 'unverified'].indexOf(r.status) >= 0) { change.lastCheck = me.now(); }
      if (r.status !== 'busy') { me.save(change); }
      return r;
    });
    me.inFlight = p;
    return p;
  };

  Updater.prototype.checkNow = function (opts) {
    var me = this, F = me.F, progress = opts.progress || function () {};
    var mine = me.running();
    if (!mine) { return Promise.reject(problem('failed', 'This copy of Select has no readable manifest.')); }
    var state = me.load();
    if (!me.lock()) { return Promise.resolve({ status: 'busy', message: 'Another Premiere is updating Select.' }); }
    me.cleanWork();
    progress({ status: 'checking' });

    var url = me.api + '/repos/' + REPO + '/releases/latest';
    return getText(url, { policy: me.policy, accept: 'application/vnd.github+json', max: LIMITS.api, totalMs: LIMITS.apiMs, missingOk: true }).then(function (text) {
      var release;
      try { release = JSON.parse(text); } catch (e) { throw problem('failed', 'GitHub\'s answer isn\'t JSON.'); }
      var version = release && String(release.tag_name || '').replace(/^v/, '');
      if (!parseVersion(version)) { throw problem('failed', 'The latest release has no version I can read.'); }
      if (release.draft || release.prerelease || compareVersions(version, mine.version) <= 0) {
        return { status: 'current', version: null, running: mine.version };
      }
      if (state.ready && state.ready.version === version && me.holds(mine, version)) {
        return { status: 'ready', version: version, running: mine.version, needsPremiereRestart: state.ready.needsPremiereRestart, again: true };
      }
      var assets = Object.create(null);
      (release.assets || []).forEach(function (a) { if (a && typeof a.name === 'string' && typeof a.browser_download_url === 'string') { assets[a.name] = a.browser_download_url; } });
      var manifestName = mine.name + '-update.json', zxpName = mine.name + '.zxp';
      // Until a manifest signed with the release key names this version, nothing about this release is believed or
      // shown: not its version, not whether it can be installed here.
      var unverified = function (why) { return problem('unverified', why); };
      if (!assets[manifestName]) { throw unverified('The latest release has no signed manifest.'); }
      if (!ed25519Works()) { throw unverified('This Premiere\'s Node can\'t check an Ed25519 signature.'); }
      return getText(assets[manifestName], { policy: me.policy, accept: 'application/octet-stream', max: LIMITS.manifest, totalMs: LIMITS.apiMs }).then(function (text) {
        var signed;
        try { signed = openManifest(text, me.keys); } catch (e) { throw unverified(e.message); }
        var why = signed.bundleId !== mine.bundleId ? 'is for ' + signed.bundleId
          : signed.version !== version ? 'says ' + signed.version + ', and the release is ' + version
          : signed.file !== zxpName ? 'names ' + signed.file
          : compareVersions(signed.version, mine.version) <= 0 ? 'isn\'t newer than ' + mine.version : null;
        if (why) { throw unverified('The signed manifest ' + why + '.'); }
        // From here on, the version is one the release key signed.
        if (!assets[zxpName]) { return { status: 'manual', version: version, message: 'The release has no ' + zxpName + '.' }; }
        var plan = me.target(mine);
        if (plan.problem) { return { status: plan.problem, version: version }; }
        progress({ status: 'downloading', version: version });
        var work = nodePath.join(me.dir, 'work-' + process.pid + '-' + me.now());
        F.mkdirSync(work, { recursive: true, mode: 448 });
        var zxp = nodePath.join(work, zxpName);
        return download(assets[zxpName], zxp, signed, { policy: me.policy }, F).then(function () {
          return me.stage(zxp, work, signed, mine);
        }).then(function (staged) {
          me.staged = { dir: staged, work: work, version: version, signed: signed, plan: plan };
          return me.install();
        }).catch(function (e) {
          if (!me.staged || me.staged.work !== work) { try { removeTree(F, work); } catch (x) {} }
          e.version = e.version || version;
          throw e;
        });
      });
    }, function (e) {
      if (e.status === 'none') { return { status: 'current', version: null, running: mine.version }; }
      throw e;
    });
  };

  // Unpacks outside Adobe's extensions folder, where a second copy with the same bundle id would confuse CEP, and checks
  // that what came out is this panel, at the signed version, signed for Adobe, with a working engine.
  Updater.prototype.stage = function (zxp, work, signed, mine) {
    var me = this, F = me.F, dir = nodePath.join(work, mine.bundleId);
    F.mkdirSync(dir, { mode: 493 });
    return run(me.execFile, '/usr/bin/ditto', ['-x', '-k', zxp, dir], LIMITS.unzipMs).then(function (r) {
      if (!r.ok) { throw problem('failed', 'Couldn\'t unpack the update: ' + (r.stderr.trim() || 'ditto failed') + '.'); }
      var text;
      try { text = F.readFileSync(nodePath.join(dir, 'CSXS', 'manifest.xml'), 'utf8'); } catch (e) { throw problem('rejected', 'The update has no manifest.'); }
      var m = readManifestText(text);
      if (m.bundleId !== mine.bundleId) { throw problem('rejected', 'The update is for ' + m.bundleId + ', not ' + mine.bundleId + '.'); }
      if (m.version !== signed.version) { throw problem('rejected', 'The update\'s manifest says ' + m.version + ', and the signed version is ' + signed.version + '.'); }
      if (!m.script || !exists(F, nodePath.join(dir, m.script))) { throw problem('rejected', 'The update has no host script.'); }
      if (!exists(F, nodePath.join(dir, 'client', 'index.html'))) { throw problem('rejected', 'The update has no panel page.'); }
      if (!exists(F, nodePath.join(dir, 'META-INF', 'signatures.xml'))) { throw problem('rejected', 'The update isn\'t signed for Adobe, so Premiere wouldn\'t load it.'); }
      var count = 0;
      walk(F, dir, function () { count++; });
      if (count > 5000) { throw problem('rejected', 'The update has too many files in it.'); }
      var engine = nodePath.join(dir, 'bin', ENGINE);
      if (!exists(F, engine)) { throw problem('rejected', 'The update has no engine.'); }
      // A zip may or may not keep the execute bit. Modes aren't part of what Adobe signs.
      F.chmodSync(engine, 493);
      // Nothing here removes quarantine. If macOS marked the files, the package is the honest way in.
      return run(me.execFile, '/usr/bin/xattr', ['-p', 'com.apple.quarantine', engine], 10000).then(function (q) {
        if (q.ok) { throw problem('quarantined', 'macOS quarantined the downloaded engine.'); }
        return run(me.execFile, engine, ['version'], LIMITS.engineMs);
      }).then(function (v) {
        if (!v.ok || v.stdout.trim() !== signed.version) { throw problem('rejected', 'The new engine didn\'t run' + (v.ok ? ' as version ' + signed.version : '') + '.'); }
        return dir;
      });
    });
  };

  // Swaps the staged copy in, unless a scan or a write is running. Synchronous from here on, so nothing in the panel
  // can start in between.
  Updater.prototype.install = function () {
    var me = this, F = me.F, st = me.staged;
    if (!st) { return Promise.resolve({ status: 'current' }); }
    var busy = me.isBusy();
    if (busy) { return Promise.resolve({ status: 'waiting', version: st.version, busy: busy }); }
    var mine = me.running();
    var plan = me.target(mine || { bundleId: st.signed.bundleId });
    var result;
    try {
      if (plan.problem) { throw problem(plan.problem, 'The extension folder changed while the update was downloading.'); }
      var oldXml = me.manifestAt(plan.target) || (mine && mine.xml);
      var there = readManifestText(oldXml || '').version;
      if (there && compareVersions(there, st.version) >= 0) {
        // Another Premiere put this version, or a newer one, in place since the download. Swapping now would move it into
        // previous/ over the copy a rollback needs, so the folder is left as it is, and this page can still restart into it.
        var loaded = me.loadedXml || oldXml;
        result = { status: 'ready', version: there, needsPremiereRestart: !plan.here || manifestShape(loaded) !== manifestShape(oldXml), here: plan.here };
      } else {
        if (!exists(F, nodePath.join(st.dir, 'CSXS', 'manifest.xml'))) { throw problem('failed', 'The downloaded copy was removed before it could be installed. Nothing changed.'); }
        me.swap(st.dir, plan.target, st.version);
        var newXml = me.manifestAt(plan.target);
        var restart = !plan.here || !oldXml || manifestShape(oldXml) !== manifestShape(newXml);
        me.save({ ready: { version: st.version, needsPremiereRestart: restart, at: me.now() } });
        result = { status: 'ready', version: st.version, needsPremiereRestart: restart, here: plan.here };
      }
    } catch (e) {
      result = { status: e.status || 'failed', version: st.version, message: e.message, rolledBack: !!e.rolledBack };
    }
    try { removeTree(F, st.work); } catch (e) {}
    me.staged = null;
    me.unlock();
    return Promise.resolve(result);
  };

  // Whether the folder CEP loads holds this version now. False after the old one was put back by hand.
  Updater.prototype.holds = function (mine, version) {
    return readManifestText(this.manifestAt(this.target(mine).target) || '').version === version;
  };

  Updater.prototype.manifestAt = function (dir) {
    try { return this.F.readFileSync(nodePath.join(dir, 'CSXS', 'manifest.xml'), 'utf8'); } catch (e) { return null; }
  };

  Updater.prototype.previousDir = function (bundleId) {
    return nodePath.join(this.dir, 'previous', bundleId);
  };

  // Two renames in one volume: the old folder aside, the new one in. If the second fails, or the result doesn't read
  // as the new version, the old one goes back. The previous copy stays in the support folder for a manual rollback.
  // install() calls this only when the folder holds an older version, so previous/ is always the one before.
  // Not handled: the Mac stopping between the two renames. The extensions folder then has no Select at all, and the
  // old copy is whole in previous/: PACKAGING.md's rollback steps move it back, or Select.pkg installs again.
  Updater.prototype.swap = function (staged, target, version) {
    var F = this.F, previous = this.previousDir(nodePath.basename(target)), aside = false;
    F.mkdirSync(nodePath.dirname(previous), { recursive: true, mode: 448 });
    removeTree(F, previous);
    F.mkdirSync(nodePath.dirname(target), { recursive: true });
    if (exists(F, target)) {
      try { F.renameSync(target, previous); } catch (e) { throw problem('failed', 'Couldn\'t move the current copy aside (' + (e.code || e.message) + '). Nothing changed.'); }
      aside = true;
    }
    var putBack = function (why) {
      var err = problem('failed', why);
      if (aside) {
        try { F.renameSync(previous, target); err.rolledBack = true; err.message += ' The previous version is back in place.'; } catch (x) {
          err.message += ' The previous version is in ' + previous + '.';
        }
      }
      return err;
    };
    try {
      F.renameSync(staged, target);
    } catch (e) {
      throw putBack('Couldn\'t move the new version in (' + (e.code || e.message) + ').');
    }
    var now = readManifestText(this.manifestAt(target) || '');
    if (now.version !== version) {
      try { F.renameSync(target, staged); } catch (e) {
        try { removeTree(F, target); } catch (x) {}
      }
      throw putBack('The new version didn\'t read back as ' + version + '.');
    }
  };

  // ---------------------------------------------------------------- the panel side

  var STYLE = [
    '#update-line { display: flex; align-items: center; gap: 8px; padding-left: 22px; margin-top: 4px; min-height: 20px; font-size: 12px; line-height: 16px; color: var(--ink2); }',
    '#update-line .u-words { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '#update-line .u-restart { height: 20px; padding: 0 9px; border-radius: 6px; font-size: 12px; font-weight: 600; background: var(--cobalt); color: #fff; flex: none; }',
    '#update-line .u-restart:disabled { opacity: .36; }',
    '#update-line .u-restart:active:not(:disabled) { transform: scale(.97); }',
    '#foot.green #update-line { color: #fff; }',
    '#foot.green #update-line .u-restart { background: #fff; color: var(--safe); }',
    '#menu button[data-update="auto"] { display: flex; justify-content: space-between; align-items: center; gap: 18px; }',
    '#menu button[data-update="auto"]::after { content: ""; width: 7px; height: 4px; margin: 0 2px 3px 0; border-left: 1.5px solid var(--ink); border-bottom: 1.5px solid var(--ink); transform: rotate(-45deg); visibility: hidden; flex: none; }',
    '#menu button[data-update="auto"][aria-checked="true"]::after { visibility: visible; }'
  ].join('\n');

  var SCAN_AFTER = 'select.update.scanAfterRestart';

  // testing: the Updater's test-only options. The panel itself never passes any.
  function attach(win, doc, testing) {
    var app = win.SelectApp, $ = function (id) { return doc.getElementById(id); };
    var line = $('update-line'), check = doc.querySelector('#menu [data-update="check"]'), auto = doc.querySelector('#menu [data-update="auto"]');
    if (!line || !check || !auto || typeof app.extensionRoot !== 'function') { return null; }
    var busy = function () {
      var s = app.state || {};
      // A Premiere call past its deadline can still land, and a write's batch that lands late goes into its Undo record.
      // A reload before then would lose that, so it counts as a write until Premiere answers.
      if (s.busy || s.hostLate > 0) { return 'write'; }
      if (s.listing || (s.scan && s.scan.handle)) { return 'scan'; }
      if (s.modalOpen) { return 'panel'; }
      return null;
    };
    var o = { root: app.extensionRoot(), isBusy: busy };
    for (var k in (testing || {})) { o[k] = testing[k]; }
    var u = new Updater(o);
    var me = u.running();
    if (!me) { return null; }
    // installed: what this page has put on disk, when that's the folder this page runs from. From then on this page is
    // older than its own files, and a scan would start the new engine.
    var name = me.name, fadeTimer = null, waitTimer = null, installed = null;

    var style = doc.createElement('style');
    style.textContent = STYLE;
    doc.head.appendChild(style);
    var rule = doc.querySelector('#menu hr[data-update]');
    if (rule) { rule.hidden = false; }
    check.hidden = false;
    auto.hidden = false;
    auto.setAttribute('aria-checked', u.load().automatic ? 'true' : 'false');

    function closeMenu() {
      $('menu').hidden = true;
      if ($('more')) { $('more').setAttribute('aria-expanded', 'false'); }
    }

    function show(words) {
      win.clearTimeout(fadeTimer);
      line.textContent = '';
      if (!words) { line.hidden = true; return; }
      var span = doc.createElement('span');
      span.className = 'u-words';
      span.textContent = words.text;
      span.title = words.detail ? words.text + ' ' + words.detail : words.text;
      line.appendChild(span);
      if (words.restart) {
        var b = doc.createElement('button');
        b.className = 'u-restart';
        b.textContent = 'Restart';
        b.title = 'Reloads the panel with the new version. Premiere keeps running.';
        b.disabled = !!busy();
        b.onclick = function () { if (!busy()) { restart(false); } };
        line.appendChild(b);
      }
      if (words.link) {
        var a = doc.createElement('button');
        a.className = 'link';
        a.textContent = 'Get it';
        a.onclick = function () { if (win.cep && win.cep.util && win.cep.util.openURLInDefaultBrowser) { win.cep.util.openURLInDefaultBrowser(words.link); } };
        line.appendChild(a);
      }
      line.hidden = false;
      if (words.fades) { fadeTimer = win.setTimeout(function () { line.hidden = true; }, 8000); }
    }

    // Restart is off while a scan or a write runs.
    win.setInterval(function () {
      var b = line.querySelector('.u-restart');
      if (b && !line.hidden) { b.disabled = !!busy(); }
    }, 1000);

    function restart(thenScan) {
      if (thenScan) { try { win.localStorage.setItem(SCAN_AFTER, String(Date.now())); } catch (e) {} }
      win.location.reload();
    }

    function settle(r, manual) {
      if (r.status === 'ready' && r.here && !r.again) { installed = r; }
      if (r.status === 'waiting') { waitForIdle(manual); }
      // After an install, a later check finds nothing newer than the files on disk. The news is still the update.
      if (installed && (r.status === 'current' || r.status === 'ready')) { r = installed; }
      var words = lineFor(r, name, manual);
      if (!words) {
        if (manual) { show(null); }
        return;
      }
      // Automatic checks speak once per version and outcome. A check by hand always answers.
      if (!manual && !u.tellOnce(r.status + ' ' + r.version)) { return; }
      show(words);
    }

    function waitForIdle(manual) {
      win.clearInterval(waitTimer);
      waitTimer = win.setInterval(function () {
        if (busy()) { return; }
        win.clearInterval(waitTimer);
        u.install().then(function (r) { settle(r, manual); });
      }, 5000);
    }

    function runCheck(manual) {
      return u.check({ manual: manual, progress: function (p) { if (manual) { show(lineFor(p, name, true)); } } }).then(function (r) { settle(r, manual); return r; });
    }

    check.addEventListener('click', function (e) {
      e.stopPropagation();
      closeMenu();
      runCheck(true);
    });
    auto.addEventListener('click', function (e) {
      e.stopPropagation();
      closeMenu();
      var on = u.setAutomatic(auto.getAttribute('aria-checked') !== 'true');
      auto.setAttribute('aria-checked', on ? 'true' : 'false');
    });

    // Once this page has installed over its own folder, a scan asked for here restarts into the new version first and
    // then starts. If the new version needs Premiere restarted, the scan waits for that instead.
    doc.addEventListener('click', function (e) {
      if (!installed || busy()) { return; }
      var t = e.target && e.target.closest && e.target.closest('#scan, #menu [data-menu="rescan"]');
      if (!t || t.disabled) { return; }
      e.stopPropagation();
      e.preventDefault();
      closeMenu();
      if (installed.needsPremiereRestart) {
        show({ text: name + ' ' + shortVersion(installed.version) + ' is installed. Restart Premiere before the next scan.' });
      } else {
        restart(true);
      }
    }, true);

    var host = win.__adobe_cep__;
    if (host && host.evalScript && me.script) {
      host.evalScript(hostRefreshScript(nodePath.join(u.root, me.script), me.version), function () {});
    }

    var pending = u.opened();
    if (pending) { settle(pending, false); }

    var asked = 0;
    try { asked = Number(win.localStorage.getItem(SCAN_AFTER)) || 0; win.localStorage.removeItem(SCAN_AFTER); } catch (e) {}
    if (asked && Date.now() - asked < 60000 && typeof app.startScan === 'function') {
      win.setTimeout(function () { app.startScan(); }, 0);
    }

    if (u.dueOnOpen()) { win.setTimeout(function () { runCheck(false); }, 20000); }
    win.setInterval(function () { if (u.dueWhileOpen()) { runCheck(false); } }, 3600 * 1000);
    return u;
  }

  pure.available = true;
  pure.Updater = Updater;
  pure.openManifest = openManifest;
  pure.ed25519Works = ed25519Works;
  pure.attach = attach;
  return pure;
});
