// The updater, end to end: a local server stands in for GitHub's releases API and its asset hosts, and the
// extensions folder and support folder are temp folders. Nothing here touches the network, Premiere or Adobe's folders.
//   cd panel && node --test test/update.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// Two guards against the real Mac: the home folder is a temp folder, and https can't be used at all.
// Real path: macOS's temp folder sits behind a symlink, and the updater resolves real paths on purpose.
const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'select-update-test-')));
process.env.HOME = fs.mkdtempSync(path.join(WORK, 'home-'));
require('https').request = () => { throw new Error('the update tests must never reach the network'); };
require('https').get = require('https').request;

const U = require('../client/update.js');
const SIGN = require('../../scripts/sign-update.js');

// A hard stop for the whole file, whatever hangs.
const deadline = setTimeout(() => { console.error('update tests: deadline passed'); process.exit(1); }, 150000);
deadline.unref();

const BUNDLE = 'com.skyfallstatus.select';
const MANIFEST = fs.readFileSync(path.join(__dirname, '..', 'CSXS', 'manifest.xml'), 'utf8');
const MAX_BYTES = 50 * 1024 * 1024;   // nothing here comes near it, and the cleanup checks
test.after(() => {
  const used = Number(cp.execFileSync('/usr/bin/du', ['-sk', WORK]).toString().split('\t')[0]) * 1024;
  fs.rmSync(WORK, { recursive: true, force: true });
  assert.ok(used < MAX_BYTES, 'the tests wrote ' + used + ' bytes');
});

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const KEYS = { [SIGN.keyId(publicKey)]: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
const other = crypto.generateKeyPairSync('ed25519').privateKey;

let n = 0;
const fresh = name => fs.mkdtempSync(path.join(WORK, (name || 'x') + '-' + (++n) + '-'));

function manifestXml(version, bundleId, extra) {
  let xml = MANIFEST
    .replace(/ExtensionBundleId="[^"]*"/, `ExtensionBundleId="${bundleId || BUNDLE}"`)
    .replace(/ExtensionBundleVersion="[^"]*"/, `ExtensionBundleVersion="${version}"`)
    .replace(/(<Extension Id="[^"]*" Version=")[^"]*/, `$1${version}`);
  if (extra) { xml = xml.replace('</CEFCommandLine>', extra + '</CEFCommandLine>'); }
  return xml;
}

// An extension folder as the release builds it: manifest, page, host, engine, Adobe's signature file.
function makeExtension(dir, version, o) {
  o = o || {};
  const w = (rel, text, mode) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text, { mode: mode || 0o644 }); };
  w('CSXS/manifest.xml', manifestXml(o.manifestVersion || version, o.bundleId, o.extraCef));
  w('client/index.html', '<!doctype html><title>Select ' + version + '</title>');
  w('host/select.jsx', `var SELECT_HOST_VERSION = '${version}';\n`);
  w('bin/select-engine', `#!/bin/sh\n[ "$1" = version ] && echo ${o.engineVersion || version}\n`, o.engineMode || 0o644);
  if (o.signed !== false) { w('META-INF/signatures.xml', '<signatures/>'); }
  return dir;
}

function makeZxp(version, o) {
  const src = makeExtension(path.join(fresh('src'), 'ext'), version, o);
  const zip = path.join(fresh('zip'), 'Select.zxp');
  cp.execFileSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--noextattr', src, zip]);
  return fs.readFileSync(zip);
}

function signed(zxp, version, o) {
  o = o || {};
  const text = SIGN.buildManifest({ zxp: o.zxpForManifest || zxp, version: o.version || version, bundleId: o.bundleId || BUNDLE, name: 'Select', privateKey: o.key || privateKey, file: o.file });
  if (!o.tamper && !o.edit) { return text; }
  const outer = JSON.parse(text), p = JSON.parse(Buffer.from(outer.payload, 'base64'));
  (o.tamper || o.edit)(p);
  outer.payload = Buffer.from(JSON.stringify(p)).toString('base64');
  // edit: changed before signing, so the signature is good. tamper: changed after, so it isn't.
  if (o.edit) { outer.signature = crypto.sign(null, Buffer.from(outer.payload, 'base64'), o.key || privateKey).toString('base64'); }
  return JSON.stringify(outer);
}

// ---------------------------------------------------------------- a stand-in for GitHub

const server = {
  log: [],
  release: null,       // {tag, assets: {name: Buffer}, status, body, redirectTo, draft}
  start() {
    return new Promise(resolve => {
      this.http = http.createServer((req, res) => this.route(req, res));
      this.http.listen(0, '127.0.0.1', () => { this.base = 'http://127.0.0.1:' + this.http.address().port; resolve(); });
    });
  },
  stop() { return new Promise(resolve => { this.http.closeAllConnections && this.http.closeAllConnections(); this.http.close(() => resolve()); }); },
  route(req, res) {
    this.log.push(req.url);
    const r = this.release;
    if (req.headers['user-agent'] !== 'Select') { res.writeHead(403); return res.end('no user agent'); }
    if (req.url === '/repos/skyfallstatus/select/releases/latest') {
      if (!r) { res.writeHead(404); return res.end('{"message":"Not Found"}'); }
      if (r.status) { res.writeHead(r.status); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(r.body !== undefined ? r.body : JSON.stringify({
        tag_name: 'v' + r.tag, draft: !!r.draft, prerelease: false, name: 'Select ' + r.tag,
        assets: Object.keys(r.assets).map(name => ({ name, browser_download_url: this.base + '/skyfallstatus/select/releases/download/v' + r.tag + '/' + name }))
      }));
    }
    let m = /^\/skyfallstatus\/select\/releases\/download\/v[^/]+\/(.+)$/.exec(req.url);
    if (m && r && r.assets[m[1]]) {
      // github.com sends a release file on to its asset host.
      res.writeHead(302, { location: (r.redirectTo || this.base) + '/asset/' + m[1] });
      return res.end();
    }
    m = /^\/asset\/(.+)$/.exec(req.url);
    if (m && r && r.assets[m[1]]) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(r.assets[m[1]]);
    }
    res.writeHead(404);
    res.end();
  },
  downloads() { return this.log.filter(u => u.startsWith('/asset/')); }
};

test.before(() => server.start());
test.after(() => server.stop());

function publish(version, o) {
  o = o || {};
  const zxp = o.zxp || makeZxp(version, o.ext);
  const assets = { 'Select.zxp': zxp, 'Select-update.json': Buffer.from(o.manifest || signed(zxp, version, o.sign)) };
  if (o.without) { delete assets[o.without]; }
  server.release = { tag: o.tag || version, assets, redirectTo: o.redirectTo, draft: o.draft };
  server.log = [];
  return zxp;
}

const POLICY = { protocols: ['http:'], hosts: ['127.0.0.1'], ports: 'any' };

// A fresh Mac: Select 0.1.0 installed in the user's extensions folder, and an empty support folder.
function mac(o) {
  o = o || {};
  const home = fresh('home');
  const extensions = path.join(home, 'extensions');
  const support = path.join(home, 'support');
  const root = o.runningFrom || path.join(extensions, BUNDLE);
  makeExtension(root, o.version || '0.1.0', o.ext);
  let busy = null;
  const testing = Object.assign({ extensionsDir: extensions, supportDir: support, api: server.base, policy: POLICY, keys: KEYS }, o.updater);
  const u = new U.Updater(Object.assign({ root, isBusy: () => busy }, testing));
  return { home, extensions, support, root, u, testing, target: path.join(extensions, BUNDLE), setBusy: b => { busy = b; } };
}

const versionAt = dir => { try { return U.readManifestText(fs.readFileSync(path.join(dir, 'CSXS', 'manifest.xml'), 'utf8')).version; } catch (e) { return null; } };
const leftovers = m => { try { return fs.readdirSync(path.join(m.support, 'updates')).filter(f => /^work-/.test(f)); } catch (e) { return []; } };
const inExtensions = m => fs.readdirSync(m.extensions).filter(f => f !== '.DS_Store');

// ---------------------------------------------------------------- the pure parts

test('versions compare as numbers, and anything else is refused', () => {
  assert.equal(U.compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(U.compareVersions('v0.2.0', '0.2.0'), 0);
  assert.equal(U.compareVersions('0.1.9', '0.2.0'), -1);
  assert.equal(U.compareVersions('0.2.0-beta', '0.1.0'), null);
  assert.equal(U.compareVersions('', '0.1.0'), null);
  assert.equal(U.shortVersion('0.2.0'), '0.2');
  assert.equal(U.shortVersion('0.2.1'), '0.2.1');
});

test('only GitHub, only https, in production', () => {
  const prod = { protocols: ['https:'], hosts: U.HOSTS };
  assert.ok(U.allowedUrl('https://api.github.com/repos/skyfallstatus/select/releases/latest', prod));
  assert.ok(U.allowedUrl('https://github.com/skyfallstatus/select/releases/download/v0.2.0/Select.zxp', prod));
  assert.ok(U.allowedUrl('https://release-assets.githubusercontent.com/github-production-release-asset/1/2', prod));
  assert.ok(U.allowedUrl('https://objects.githubusercontent.com/github-production-release-asset-2e65be/1', prod));
  for (const bad of ['http://github.com/x', 'https://github.com.evil.example/x', 'https://evil.example/x', 'https://raw.githubusercontent.com/x',
    'https://github.com:8443/x', 'https://user:pw@github.com/x', 'file:///etc/passwd', 'not a url']) {
    assert.ok(!U.allowedUrl(bad, prod), bad);
  }
});

test('the panel code names GitHub and nothing else', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'client', 'update.js'), 'utf8');
  const urls = (text.match(/https?:\/\/[^'"\s)]+/g) || []).sort();
  assert.deepEqual([...new Set(urls)], ['https://api.github.com', 'https://github.com/']);
  assert.ok(!/XMLHttpRequest|fetch\(|WebSocket|sendBeacon/.test(text));
  // The release key is a real Ed25519 key, and it's the only one.
  const keys = Object.keys(U.KEYS);
  assert.equal(keys.length, 1);
  const k = crypto.createPublicKey({ key: Buffer.from(U.KEYS[keys[0]], 'base64'), format: 'der', type: 'spki' });
  assert.equal(k.asymmetricKeyType, 'ed25519');
  assert.equal(SIGN.keyId(k), keys[0]);
});

test('this Node checks Ed25519, proved on RFC 8032\'s vector', () => {
  assert.equal(U.ed25519Works(), true);
});

test('the host is evaluated again only when it is another version', () => {
  const script = U.hostRefreshScript('/x/host/select.jsx', '0.2.0');
  const run = (slCall, version) => {
    const loaded = [];
    const $ = { evalFile: f => { loaded.push(f); } };
    const out = new Function('slCall', 'SELECT_HOST_VERSION', '$', 'return ' + script)(slCall, version, $);
    return { out, loaded };
  };
  assert.deepEqual(run(() => {}, '0.2.0'), { out: 'current', loaded: [] });
  assert.deepEqual(run(() => {}, '0.1.0').loaded, ['/x/host/select.jsx']);
  assert.deepEqual(run(undefined, undefined), { out: 'absent', loaded: [] });
  // The host the build ships defines the name this looks for.
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'host', 'select.jsx'), 'utf8'), /^var SELECT_HOST_VERSION = '/m);
});

test('a manifest change other than the version needs Premiere restarted', () => {
  assert.equal(U.manifestShape(manifestXml('0.1.0')), U.manifestShape(manifestXml('0.2.0')));
  assert.notEqual(U.manifestShape(manifestXml('0.1.0')), U.manifestShape(manifestXml('0.2.0', null, '<Parameter>--new</Parameter>')));
});

test('the words: automatic checks speak only when there is something to do', () => {
  const ready = U.lineFor({ status: 'ready', version: '0.2.0' }, 'Select', false);
  assert.deepEqual(ready, { text: 'Select 0.2 is ready.', restart: true });
  assert.equal(U.lineFor({ status: 'ready', version: '0.2.0', needsPremiereRestart: true }, 'Select', false).text, 'Select 0.2 is ready. Restart Premiere to use it.');
  for (const status of ['checking', 'downloading', 'current', 'offline', 'rejected', 'failed', 'waiting', 'dev', 'off']) {
    assert.equal(U.lineFor({ status, version: '0.2.0', running: '0.1.0' }, 'Select', false), null, status);
  }
  assert.equal(U.lineFor({ status: 'current', running: '0.1.0' }, 'Select', true).text, 'Select 0.1 is the latest version.');
  assert.equal(U.lineFor({ status: 'offline' }, 'Select', true).text, 'Couldn\'t reach GitHub. Try again later.');
  assert.equal(U.lineFor({ status: 'waiting', version: '0.2.0', busy: 'scan' }, 'Select', true).text, 'Select 0.2 is downloaded. It installs as soon as this scan ends.');
  assert.ok(U.lineFor({ status: 'blocked', version: '0.2.0' }, 'Select', false).link);
});

// ---------------------------------------------------------------- end to end

test('a newer version downloads, verifies, and swaps in, keeping the old one', async () => {
  const m = mac();
  publish('0.2.0');
  const r = await m.u.check({ manual: false });
  assert.equal(r.status, 'ready', r.message);
  assert.equal(r.version, '0.2.0');
  assert.equal(r.needsPremiereRestart, false);
  assert.equal(versionAt(m.target), '0.2.0');
  assert.equal(versionAt(path.join(m.support, 'updates', 'previous', BUNDLE)), '0.1.0');
  assert.deepEqual(inExtensions(m), [BUNDLE], 'one folder for the bundle id, nothing staged beside it');
  assert.equal(fs.statSync(path.join(m.target, 'bin', 'select-engine')).mode & 0o777, 0o755);
  assert.deepEqual(leftovers(m), []);
  assert.ok(!fs.existsSync(path.join(m.support, 'updates', 'lock')));
  const state = m.u.load();
  assert.equal(state.ready.version, '0.2.0');
  assert.ok(state.lastCheck > 0);
  assert.deepEqual(server.downloads(), ['/asset/Select-update.json', '/asset/Select.zxp']);
  // The next check knows, and fetches nothing again.
  server.log = [];
  const again = await m.u.check({ manual: true });
  assert.equal(again.status, 'current');
  assert.deepEqual(server.downloads(), []);
  // The new page, once loaded, forgets the news.
  assert.equal(m.u.opened(), null);
  assert.equal(m.u.load().ready, null);
});

test('the same version, or an older one, is left alone and nothing is downloaded', async () => {
  for (const v of ['0.1.0', '0.0.9']) {
    const m = mac();
    publish(v);
    const r = await m.u.check({ manual: true });
    assert.equal(r.status, 'current', v);
    assert.equal(versionAt(m.target), '0.1.0');
    assert.deepEqual(server.downloads(), []);
  }
  const m = mac();
  publish('0.2.0', { draft: true });
  assert.equal((await m.u.check({ manual: true })).status, 'current', 'a draft is never an update');
});

test('a bad signature is refused before the zxp is fetched', async () => {
  const m = mac();
  const zxp = makeZxp('0.2.0');
  publish('0.2.0', { zxp, sign: { key: other } });
  const r = await m.u.check({ manual: true });
  assert.equal(r.status, 'rejected');
  assert.match(r.message, /key this version doesn't know/);
  assert.deepEqual(server.downloads(), ['/asset/Select-update.json']);
  assert.equal(versionAt(m.target), '0.1.0');

  // The right key id, the payload changed after signing.
  publish('0.2.0', { zxp, sign: { tamper: p => { p.size += 1; } } });
  const t = await m.u.check({ manual: true });
  assert.equal(t.status, 'rejected');
  assert.match(t.message, /signature doesn't verify/);
  assert.deepEqual(server.downloads(), ['/asset/Select-update.json']);
  assert.equal(versionAt(m.target), '0.1.0');
  assert.deepEqual(leftovers(m), []);
});

test('a zxp that doesn\'t match the signed hash is refused', async () => {
  const m = mac();
  const good = makeZxp('0.2.0');
  const evil = Buffer.from(good);
  evil[evil.length - 30] ^= 0xff;    // same size, other bytes
  publish('0.2.0', { zxp: evil, sign: { zxpForManifest: good } });
  const r = await m.u.check({ manual: true });
  assert.equal(r.status, 'rejected');
  assert.match(r.message, /SHA-256/);
  assert.equal(versionAt(m.target), '0.1.0');
  assert.deepEqual(leftovers(m), []);
});

test('a zxp of the wrong size is refused, longer or shorter', async () => {
  for (const by of [+100, -100]) {
    const m = mac();
    const good = makeZxp('0.2.0');
    publish('0.2.0', { zxp: good, sign: { edit: p => { p.size -= by; } } });
    const r = await m.u.check({ manual: true });
    assert.equal(r.status, 'rejected', String(by));
    assert.match(r.message, /size|bigger/);
    assert.equal(versionAt(m.target), '0.1.0');
    assert.deepEqual(leftovers(m), []);
  }
});

test('the wrong bundle id is refused, signed or inside the zxp', async () => {
  let m = mac();
  publish('0.2.0', { sign: { bundleId: 'com.example.other' } });
  let r = await m.u.check({ manual: true });
  assert.equal(r.status, 'rejected');
  assert.match(r.message, /is for com\.example\.other/);

  m = mac();
  publish('0.2.0', { ext: { bundleId: 'com.example.other' } });
  r = await m.u.check({ manual: true });
  assert.equal(r.status, 'rejected');
  assert.match(r.message, /for com\.example\.other, not com\.skyfallstatus\.select/);
  assert.equal(versionAt(m.target), '0.1.0');
  assert.deepEqual(inExtensions(m), [BUNDLE]);
  assert.deepEqual(leftovers(m), []);
});

test('versions that disagree are refused: tag, signed manifest, zxp manifest, engine', async () => {
  const cases = [
    [{ sign: { version: '0.3.0' } }, /says 0\.3\.0, and the release is 0\.2\.0/],
    [{ ext: { manifestVersion: '0.3.0' } }, /manifest says 0\.3\.0, and the signed version is 0\.2\.0/],
    [{ ext: { engineVersion: '0.1.0' } }, /engine didn't run/],
    [{ ext: { signed: false } }, /isn't signed for Adobe/],
    [{ sign: { file: 'Other.zxp' } }, /names Other\.zxp/]
  ];
  for (const [o, why] of cases) {
    const m = mac();
    publish('0.2.0', o);
    const r = await m.u.check({ manual: true });
    assert.equal(r.status, 'rejected', JSON.stringify(o));
    assert.match(r.message, why);
    assert.equal(versionAt(m.target), '0.1.0');
    assert.deepEqual(leftovers(m), []);
  }
  // A signed manifest for an older version, replayed under a newer tag, is refused as well.
  const m = mac({ version: '0.3.0' });
  const old = makeZxp('0.2.0');
  publish('0.4.0', { zxp: old, manifest: signed(old, '0.2.0') });
  assert.equal((await m.u.check({ manual: true })).status, 'rejected');
});

test('a redirect off the allowed hosts is refused', async () => {
  const m = mac();
  publish('0.2.0', { redirectTo: server.base.replace('127.0.0.1', 'localhost') });
  const r = await m.u.check({ manual: true });
  assert.equal(r.status, 'rejected');
  assert.match(r.message, /Refused to fetch from localhost/);
  assert.deepEqual(server.downloads(), []);
  assert.equal(versionAt(m.target), '0.1.0');
});

test('the network down, a server error, or nonsense: nothing changes', async () => {
  const closed = http.createServer();
  await new Promise(r => closed.listen(0, '127.0.0.1', r));
  const dead = 'http://127.0.0.1:' + closed.address().port;
  await new Promise(r => closed.close(r));
  let m = mac({ updater: { api: dead } });
  let r = await m.u.check({ manual: false });
  assert.equal(r.status, 'offline');
  assert.equal(versionAt(m.target), '0.1.0');
  const s = m.u.load();
  assert.ok(s.lastAttempt > 0);
  assert.equal(s.lastCheck, 0, 'a failed check is not a check, so the next panel open tries again');
  assert.equal(m.u.dueOnOpen(), true);
  assert.equal(m.u.dueWhileOpen(), false, 'but not again and again while the panel stays open');

  m = mac();
  server.release = { status: 500, assets: {} };
  assert.equal((await m.u.check({ manual: true })).status, 'failed');
  server.release = { body: 'not json', assets: {} };
  assert.equal((await m.u.check({ manual: true })).status, 'failed');
  server.release = null;   // a repository with no release yet
  assert.equal((await m.u.check({ manual: true })).status, 'current');
  assert.equal(versionAt(m.target), '0.1.0');
});

test('a release without the signed manifest asks for the package, and installs nothing', async () => {
  const m = mac();
  publish('0.2.0', { without: 'Select-update.json' });
  const r = await m.u.check({ manual: false });
  assert.equal(r.status, 'manual');
  assert.deepEqual(server.downloads(), []);
  assert.equal(versionAt(m.target), '0.1.0');
});

test('a swap that fails half way puts the old version back', async () => {
  const fsx = Object.assign({}, fs);
  let calls = 0;
  fsx.renameSync = (a, b) => {
    if (b.endsWith(path.join('extensions', BUNDLE)) && a.includes('work-') && ++calls === 1) {
      const e = new Error('simulated'); e.code = 'EIO'; throw e;
    }
    return fs.renameSync(a, b);
  };
  const m = mac({ updater: { fs: fsx } });
  publish('0.2.0');
  const r = await m.u.check({ manual: true });
  assert.equal(r.status, 'failed');
  assert.equal(r.rolledBack, true);
  assert.match(r.message, /previous version is back in place/);
  assert.equal(versionAt(m.target), '0.1.0');
  assert.deepEqual(inExtensions(m), [BUNDLE]);
  assert.deepEqual(leftovers(m), []);
  assert.equal(m.u.load().ready, null);

  // The next try works.
  const ok = await m.u.check({ manual: true });
  assert.equal(ok.status, 'ready');
  assert.equal(versionAt(m.target), '0.2.0');
});

test('a swap whose result doesn\'t read back as the new version is undone', async () => {
  const fsx = Object.assign({}, fs);
  fsx.readFileSync = (f, enc) => {
    const text = fs.readFileSync(f, enc);
    return f.startsWith(path.join(fsx.target || '', 'CSXS')) && fsx.target ? String(text).replace('ExtensionBundleVersion="0.2.0"', 'ExtensionBundleVersion="9.9.9"') : text;
  };
  const m = mac({ updater: { fs: fsx } });
  fsx.target = m.target;
  publish('0.2.0');
  const r = await m.u.check({ manual: true });
  assert.equal(r.status, 'failed');
  assert.match(r.message, /didn't read back/);
  assert.equal(fs.readFileSync(path.join(m.target, 'client', 'index.html'), 'utf8').includes('0.1.0'), true);
  assert.deepEqual(inExtensions(m), [BUNDLE]);
});

test('nothing is swapped while a scan or a write runs; it installs when the panel is free', async () => {
  for (const busy of ['scan', 'write']) {
    const m = mac();
    m.setBusy(busy);
    publish('0.2.0');
    const r = await m.u.check({ manual: false });
    assert.equal(r.status, 'waiting', busy);
    assert.equal(r.busy, busy);
    assert.equal(versionAt(m.target), '0.1.0');
    assert.deepEqual(inExtensions(m), [BUNDLE], 'staged outside the extensions folder');
    // Still busy: still waiting, and not downloaded again.
    server.log = [];
    assert.equal((await m.u.check({ manual: false })).status, 'waiting');
    assert.deepEqual(server.downloads(), []);
    m.setBusy(null);
    const done = await m.u.install();
    assert.equal(done.status, 'ready');
    assert.equal(versionAt(m.target), '0.2.0');
    assert.deepEqual(leftovers(m), []);
  }
});

test('automatic checks off: no request at all, and a check by hand still works', async () => {
  const m = mac();
  publish('0.2.0');
  assert.equal(m.u.setAutomatic(false), false);
  assert.equal(m.u.dueOnOpen(), false);
  assert.equal(m.u.dueWhileOpen(), false);
  assert.equal((await m.u.check({ manual: false })).status, 'off');
  assert.deepEqual(server.log, []);
  assert.equal(versionAt(m.target), '0.1.0');
  const r = await m.u.check({ manual: true });
  assert.equal(r.status, 'ready');
  assert.equal(m.u.load().automatic, false, 'a check by hand doesn\'t turn them back on');
});

test('once a day: due on open after a day, not before; a clock set back counts as due', async () => {
  let now = Date.UTC(2026, 10, 3, 9);
  const m = mac({ updater: { now: () => now } });
  assert.equal(m.u.dueOnOpen(), true, 'never checked');
  publish('0.1.0');
  assert.equal((await m.u.check()).status, 'current');
  now += U.DAY - 60000;
  assert.equal(m.u.dueOnOpen(), false);
  assert.equal(m.u.dueWhileOpen(), false);
  now += 120000;
  assert.equal(m.u.dueOnOpen(), true);
  assert.equal(m.u.dueWhileOpen(), true);
  now -= 10 * U.DAY;
  assert.equal(m.u.dueOnOpen(), true);
});

test('after the old version is put back by hand, the next check installs the new one again', async () => {
  const elsewhere = path.join(fresh('system'), BUNDLE);
  const m = mac({ runningFrom: elsewhere });
  publish('0.2.0');
  assert.equal((await m.u.check({ manual: true })).status, 'ready');
  // Put back by hand: here that means the per-user copy goes, and the one elsewhere is the only one again.
  fs.rmSync(m.target, { recursive: true });
  assert.equal(m.u.opened(), null, 'the news is forgotten once the folder no longer holds it');
  server.log = [];
  const r = await m.u.check({ manual: false });
  assert.equal(r.status, 'ready');
  assert.notEqual(r.again, true);
  assert.equal(server.downloads().length, 2);
  assert.equal(versionAt(m.target), '0.2.0');
});

test('a development copy is never replaced', async () => {
  const m = mac({ ext: { signed: false } });
  publish('0.2.0');
  const r = await m.u.check({ manual: true });
  assert.equal(r.status, 'dev');
  assert.deepEqual(server.downloads(), []);
  assert.equal(versionAt(m.target), '0.1.0');
});

test('a copy the user can\'t change asks for the package', async () => {
  const m = mac();
  fs.chmodSync(path.join(m.target, 'host'), 0o555);
  try {
    publish('0.2.0');
    const r = await m.u.check({ manual: false });
    assert.equal(r.status, 'blocked');
    assert.deepEqual(server.downloads(), []);
    assert.equal(versionAt(m.target), '0.1.0');
  } finally {
    fs.chmodSync(path.join(m.target, 'host'), 0o755);
  }
});

test('a quarantined download is refused and never run', async () => {
  const runs = [];
  const execFile = (file, args, o, cb) => {
    runs.push(path.basename(file));
    if (file === '/usr/bin/xattr') { return setImmediate(() => cb(null, '0081;00000000;Safari;', '')); }
    return cp.execFile(file, args, o, cb);
  };
  const m = mac({ updater: { execFile } });
  publish('0.2.0');
  const r = await m.u.check({ manual: true });
  assert.equal(r.status, 'blocked');
  assert.match(r.message, /quarantined/);
  assert.deepEqual(runs, ['ditto', 'xattr'], 'the engine never ran');
  assert.equal(versionAt(m.target), '0.1.0');
});

test('running from another folder (0.1 in /Library): installs for the user, and says restart Premiere', async () => {
  const elsewhere = path.join(fresh('system'), BUNDLE);
  const m = mac({ runningFrom: elsewhere });
  publish('0.2.0');
  const r = await m.u.check({ manual: true });
  assert.equal(r.status, 'ready');
  assert.equal(r.needsPremiereRestart, true);
  assert.equal(versionAt(m.target), '0.2.0');
  assert.equal(versionAt(elsewhere), '0.1.0', 'the other copy is left alone');
  // The old copy is what's running until Premiere restarts, so it says so once more on the next open.
  const pending = m.u.opened();
  assert.equal(pending.status, 'ready');
  assert.equal(pending.needsPremiereRestart, true);
});

test('a new version with a new manifest needs Premiere restarted', async () => {
  const m = mac();
  publish('0.2.0', { ext: { extraCef: '<Parameter>--something-new</Parameter>' } });
  const r = await m.u.check({ manual: true });
  assert.equal(r.status, 'ready');
  assert.equal(r.needsPremiereRestart, true);
});

test('two checks at once share one run; another live Premiere holding the lock is left to it', async () => {
  const m = mac();
  publish('0.2.0');
  const [a, b] = await Promise.all([m.u.check({ manual: true }), m.u.check({ manual: false })]);
  assert.equal(a, b);
  assert.equal(server.downloads().length, 2);

  const m2 = mac();
  const lock = path.join(m2.support, 'updates', 'lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.ppid, at: Date.now() }));
  assert.equal((await m2.u.check({ manual: true })).status, 'busy');
  // A lock left by a process that is gone doesn't count.
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 999999, at: Date.now() }));
  assert.equal((await m2.u.check({ manual: true })).status, 'ready');
});

test('the settings file can be missing or broken', () => {
  const m = mac();
  assert.equal(m.u.load().automatic, true);
  fs.mkdirSync(path.join(m.support, 'updates'), { recursive: true });
  fs.writeFileSync(path.join(m.support, 'updates', 'state.json'), '{broken');
  assert.equal(m.u.load().automatic, true);
  assert.equal(m.u.setAutomatic(false), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(m.support, 'updates', 'state.json'), 'utf8')).automatic, false);
  assert.equal(fs.statSync(path.join(m.support, 'updates', 'state.json')).mode & 0o777, 0o600);
});

// The real thing, when a release has been built here: Adobe's ZXP layout, its signature file and the real engine.
const BUILT_ZXP = path.join(__dirname, '..', '..', 'dist', 'Select.zxp');
test('a real signed Select.zxp installs over an older copy', { skip: !fs.existsSync(BUILT_ZXP) && 'no dist/Select.zxp built here' }, async () => {
  const zxp = fs.readFileSync(BUILT_ZXP);
  const peek = fresh('peek');
  cp.execFileSync('/usr/bin/ditto', ['-x', '-k', BUILT_ZXP, peek]);
  const version = versionAt(peek);
  assert.ok(fs.existsSync(path.join(peek, 'META-INF', 'signatures.xml')), 'the built zxp is signed');
  const m = mac({ version: '0.0.1' });
  publish(version, { zxp });
  const r = await m.u.check({ manual: true });
  assert.equal(r.status, 'ready', r.message);
  assert.equal(versionAt(m.target), version);
  assert.equal(cp.execFileSync(path.join(m.target, 'bin', 'select-engine'), ['version']).toString().trim(), version);
  // Byte for byte what Adobe signed, so Premiere's check sees the same files.
  assert.equal(cp.spawnSync('/usr/bin/diff', ['-r', peek, m.target]).status, 0);
});

// ---------------------------------------------------------------- the panel side, with a stand-in DOM

function fakePanel(m, state) {
  const timers = [];
  class El {
    constructor(id, o) { Object.assign(this, { id, hidden: false, textContent: '', title: '', className: '', disabled: false, attrs: {}, listeners: {}, kids: [], onclick: null }, o); }
    appendChild(c) { this.kids.push(c); return c; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    querySelector(sel) { return this.kids.find(k => sel === '.' + k.className) || null; }
    closest(sel) { return sel.split(', ').some(s => s === '#' + this.id || (s === '#menu [data-menu="rescan"]' && this.attrs['data-menu'] === 'rescan')) ? this : null; }
    get words() { return this.kids.map(k => k.textContent).join(' | '); }
  }
  Object.defineProperty(El.prototype, 'textContent', { get() { return this._t; }, set(v) { this._t = v; if (v === '' && this.kids) { this.kids = []; } } });
  const els = { 'update-line': new El('update-line', { hidden: true }), menu: new El('menu'), more: new El('more'), scan: new El('scan') };
  const check = new El('', { hidden: true }), auto = new El('', { hidden: true, attrs: { 'aria-checked': 'true' } }), rule = new El('', { hidden: true });
  const rescan = new El('', { attrs: { 'data-menu': 'rescan' } });
  const store = new Map();
  const doc = {
    head: new El('head'), listeners: {},
    getElementById: id => els[id] || null,
    querySelector: sel => ({ '#menu [data-update="check"]': check, '#menu [data-update="auto"]': auto, '#menu hr[data-update]': rule })[sel] || null,
    createElement: () => new El(''),
    addEventListener(t, f, capture) { (this.listeners[t] = this.listeners[t] || []).push({ f, capture }); }
  };
  const evals = [], reloads = [], scans = [];
  const win = {
    SelectApp: { state, extensionRoot: () => m.root, startScan: () => scans.push(1) },
    __adobe_cep__: { evalScript: (s, cb) => { evals.push(s); cb(''); } },
    cep: { util: { openURLInDefaultBrowser: () => {} } },
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    location: { reload: () => reloads.push(1) },
    setTimeout: (f, ms) => { timers.push({ f, ms, once: true }); return timers.length; },
    setInterval: (f, ms) => { timers.push({ f, ms }); return timers.length; },
    clearTimeout: () => {}, clearInterval: () => {}
  };
  const click = el => {
    const e = { target: el, stopped: false, prevented: false, stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; } };
    for (const l of doc.listeners.click || []) { if (l.capture) { l.f(e); } }
    if (!e.stopped) { for (const f of el.listeners.click || []) { f(e); } }
    return e;
  };
  return { els, check, auto, rule, rescan, doc, win, evals, reloads, scans, timers, click, store };
}

const settle = () => new Promise(r => setTimeout(r, 0));

test('the panel: menu items appear, the setting sticks, and a check by hand ends in one line with Restart', async () => {
  const m = mac();
  const state = { scan: null, busy: null, listing: false, modalOpen: false };
  const p = fakePanel(m, state);
  const u = U.attach(p.win, p.doc, m.testing);
  assert.ok(u);
  assert.equal(p.check.hidden, false);
  assert.equal(p.auto.hidden, false);
  assert.equal(p.rule.hidden, false);
  assert.match(p.evals[0], /SELECT_HOST_VERSION === "0\.1\.0"/);
  assert.ok(p.evals[0].includes(JSON.stringify(path.join(m.root, 'host', 'select.jsx'))));
  assert.equal(p.timers.filter(t => t.once && t.ms === 20000).length, 1, 'one check, soon after the panel opens');

  // The setting, from the menu. The click doesn't reach app.js's menu handler.
  const off = p.click(p.auto);
  assert.equal(off.stopped, true);
  assert.equal(p.auto.getAttribute('aria-checked'), 'false');
  assert.equal(u.load().automatic, false);
  assert.equal(p.els.menu.hidden, true);
  p.click(p.auto);
  assert.equal(u.load().automatic, true);

  publish('0.2.0');
  p.click(p.check);
  assert.equal(p.els['update-line'].hidden, false);
  assert.equal(p.els['update-line'].words, 'Checking for updates…');
  await u.inFlight;
  await settle();
  assert.equal(p.els['update-line'].words, 'Select 0.2 is ready. | Restart');
  assert.equal(versionAt(m.target), '0.2.0');

  // A scan asked for in the old page restarts into the new one and then scans.
  const e = p.click(p.els.scan);
  assert.equal(e.stopped, true);
  assert.equal(p.reloads.length, 1);
  assert.ok(p.store.get('select.update.scanAfterRestart'));

  // The new page: no news, the scan that was asked for starts, and no check is due.
  const q = fakePanel(m, state);
  q.store.set('select.update.scanAfterRestart', p.store.get('select.update.scanAfterRestart'));
  fs.writeFileSync(path.join(m.root, 'CSXS', 'manifest.xml'), manifestXml('0.2.0'));
  U.attach(q.win, q.doc, m.testing);
  assert.equal(q.els['update-line'].hidden, true);
  q.timers.filter(t => t.once && t.ms === 0).forEach(t => t.f());
  assert.equal(q.scans.length, 1);
  assert.equal(q.timers.filter(t => t.once && t.ms === 20000).length, 0);
});

test('the panel: Restart waits for a scan, and an automatic install speaks once', async () => {
  const m = mac();
  const state = { scan: { handle: {} }, busy: null };
  const p = fakePanel(m, state);
  const u = U.attach(p.win, p.doc, m.testing);
  publish('0.2.0');
  // The automatic check, as the timer would run it, during a scan: downloads, then waits.
  p.timers.find(t => t.once && t.ms === 20000).f();
  await u.inFlight;
  await settle();
  assert.equal(p.els['update-line'].hidden, true, 'an automatic check says nothing while it waits');
  assert.equal(versionAt(m.target), '0.1.0');
  state.scan = { handle: null };
  const waiting = p.timers.filter(t => !t.once && t.ms === 5000).pop();
  waiting.f();
  await settle(); await settle();
  assert.equal(versionAt(m.target), '0.2.0');
  assert.equal(p.els['update-line'].words, 'Select 0.2 is ready. | Restart');
  // Restart is off while a write runs.
  state.busy = 'Labelling 3 clips';
  p.timers.find(t => !t.once && t.ms === 1000).f();
  const restart = p.els['update-line'].kids[1];
  assert.equal(restart.disabled, true);
  restart.onclick();
  assert.equal(p.reloads.length, 0);
  state.busy = null;
  restart.onclick();
  assert.equal(p.reloads.length, 1);
  // Told once: the same news again stays quiet.
  assert.equal(u.tellOnce('ready 0.2.0'), false);
});

test('the panel stays out of the way where Node is missing, as in the browser harness', () => {
  const stub = {};
  const api = (function () {
    const mod = { exports: {} };
    new Function('module', 'require', 'window', 'globalThis', fs.readFileSync(path.join(__dirname, '..', 'client', 'update.js'), 'utf8'))(mod, name => ({ fs: {}, os: {}, path: {} })[name], stub, stub);
    return mod.exports;
  })();
  assert.equal(api.available, false);
  assert.equal(typeof api.attach, 'undefined');
});
