#!/usr/bin/env node
// The signed manifest that lets an installed Select update itself: name, bundle id, version, size and SHA-256 of the
// release's .zxp, signed with an Ed25519 key that never enters this repository. scripts/release.sh runs it.
//   node scripts/sign-update.js keygen                     makes the key pair, once. Refuses to replace a key
//   node scripts/sign-update.js check-key [update.js]      the key is there, private, and the panel trusts it
//   node scripts/sign-update.js sign <zxp> <out> [update.js]   writes the manifest, then checks it the panel's way
// SELECT_UPDATE_KEY overrides the key's path, ~/.config/skyfallstatus/signing/select-update-ed25519.pem by default.
// [update.js] is the panel copy whose embedded key must accept the manifest, panel/client/update.js by default.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const KEY_FILE = process.env.SELECT_UPDATE_KEY || path.join(os.homedir(), '.config', 'skyfallstatus', 'signing', 'select-update-ed25519.pem');

function refuse(message) {
  const e = new Error(message);
  e.refusal = true;
  throw e;
}

// product.conf is shell syntax with no spaces around =.
function readConf(file) {
  const conf = {};
  for (const line of fs.readFileSync(file || path.join(REPO_ROOT, 'product.conf'), 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) { conf[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
  }
  return conf;
}

function keyId(publicKey) {
  return crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

// The manifest, as the panel's openManifest reads it. The payload is signed as bytes, and carried as base64 so
// nothing re-serialises it on the way.
function buildManifest({ zxp, version, bundleId, name, privateKey, file }) {
  const publicKey = crypto.createPublicKey(privateKey);
  const payload = Buffer.from(JSON.stringify({
    format: 1,
    name,
    bundleId,
    version,
    file: file || name + '.zxp',
    size: zxp.length,
    sha256: crypto.createHash('sha256').update(zxp).digest('hex')
  }));
  const signature = crypto.sign(null, payload, privateKey);
  return JSON.stringify({ format: 1, key: keyId(publicKey), payload: payload.toString('base64'), signature: signature.toString('base64') }, null, 2) + '\n';
}

// The private key: present, readable by its owner only, outside this repository, and Ed25519.
function loadKey(file) {
  file = path.resolve(file || KEY_FILE);
  let st;
  try { st = fs.statSync(file); } catch (e) { refuse(`No update signing key at ${file}. Make one with: node scripts/sign-update.js keygen`); }
  if (st.mode & 0o077) { refuse(`${file} can be read by others (mode ${(st.mode & 0o777).toString(8)}). Run: chmod 600 "${file}"`); }
  if (file === REPO_ROOT || file.startsWith(REPO_ROOT + path.sep)) { refuse(`Keep the update key outside the repository, not at ${file}.`); }
  const key = crypto.createPrivateKey(fs.readFileSync(file));
  if (key.asymmetricKeyType !== 'ed25519') { refuse(`${file} isn't an Ed25519 key.`); }
  return key;
}

function panelApi(updateJs) {
  const file = path.resolve(updateJs || path.join(REPO_ROOT, 'panel', 'client', 'update.js'));
  if (!fs.existsSync(file)) { refuse(`No panel at ${file}.`); }
  delete require.cache[file];
  const api = require(file);
  if (!api.available || typeof api.openManifest !== 'function') { refuse(`${file} can't check a manifest.`); }
  return { api, file };
}

function checkKey(updateJs) {
  const key = loadKey();
  const id = keyId(crypto.createPublicKey(key));
  const { api, file } = panelApi(updateJs);
  if (!api.KEYS[id]) { refuse(`The panel at ${path.relative(process.cwd(), file)} doesn't trust key ${id}. Its keys: ${Object.keys(api.KEYS).join(', ') || 'none'}.`); }
  return id;
}

function sign(zxpFile, outFile, updateJs) {
  const conf = readConf();
  const key = loadKey();
  const zxp = fs.readFileSync(zxpFile);
  if (!/^\d+\.\d+\.\d+$/.test(conf.VERSION || '')) { refuse(`VERSION in product.conf isn't x.y.z.`); }
  if (path.basename(zxpFile) !== conf.NAME + '.zxp') { refuse(`The panel downloads ${conf.NAME}.zxp, not ${path.basename(zxpFile)}.`); }
  const text = buildManifest({ zxp, version: conf.VERSION, bundleId: conf.BUNDLE_ID, name: conf.NAME, privateKey: key });
  // Checked the way an installed panel checks it, with the key that panel carries.
  const { api, file } = panelApi(updateJs);
  let p;
  try { p = api.openManifest(text, api.KEYS); } catch (e) { refuse(`The panel at ${path.relative(process.cwd(), file)} wouldn't take this manifest: ${e.message}`); }
  const sha = crypto.createHash('sha256').update(zxp).digest('hex');
  if (p.version !== conf.VERSION || p.bundleId !== conf.BUNDLE_ID || p.size !== zxp.length || p.sha256 !== sha) { refuse('The signed manifest doesn\'t read back as written.'); }
  fs.writeFileSync(outFile, text);
  return p;
}

function keygen() {
  const file = path.resolve(KEY_FILE);
  if (fs.existsSync(file)) { refuse(`${file} already exists. A new key would stop every installed copy from updating, so it isn't replaced.`); }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  return { file, id: keyId(publicKey), spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'keygen') {
    const k = keygen();
    console.log(`made ${k.file}, mode 600. Back it up somewhere private: losing it means installed copies can't update.`);
    console.log(`Put this line in KEYS in panel/client/update.js:\n  '${k.id}': '${k.spki}'`);
  } else if (cmd === 'check-key') {
    console.log(`update key ${checkKey(rest[0])}: private, and the panel trusts it`);
  } else if (cmd === 'sign' && rest.length >= 2) {
    const p = sign(rest[0], rest[1], rest[2]);
    console.log(`signed ${rest[1]}: ${p.name} ${p.version}, ${p.size} bytes, sha256 ${p.sha256.slice(0, 12)}…`);
  } else {
    refuse('usage: node scripts/sign-update.js keygen | check-key [update.js] | sign <zxp> <out> [update.js]');
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e.refusal ? e.message : (e.stack || String(e)));
    process.exit(1);
  }
}

module.exports = { buildManifest, keyId, readConf, loadKey, checkKey, sign };
