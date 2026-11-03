#!/usr/bin/env node
// Renders docs/media/panel-grid.png, panel-grid-dark.png, panel.png, panel-dark.png and panel-sorted.png: the real panel page in headless Chromium, on the
// synthetic fixture and generated pictures, with a real scan and real clicks. The panel is cut to Ingest's rounded look
// on a clear ground, and everything inside the rounded edge is what the page drew.
'use strict';
const fs = require('fs');
const path = require('path');
const { launch, fixture, setDeadline, sleep, OUT, pickSource, pickSort } = require('./harness.js');
const { ensureThumbs } = require('./build_fixture.js');

const MEDIA = path.join(__dirname, '../../docs/media');
const PROJECT = { path: '/Volumes/Field SSD/Projects/Lantern Bakery Spring Menu.prproj', name: 'Lantern Bakery Spring Menu.prproj' };
const STAGE = { width: 956, height: 647 };
const CUT = `html, body { background: transparent !important; }
#app { position: absolute; left: 28px; top: 24px; width: 900px; height: 595px; border-radius: 14px; overflow: hidden; background: var(--surface); box-shadow: 0 0 0 .5px rgba(0,0,0,.07), 0 10px 26px rgba(0,0,0,.13); }
#modal { position: absolute; padding: 20px; }`;
const THEME = { light: { red: 230, green: 230, blue: 230 }, dark: { red: 35, green: 35, blue: 35 } };

const clean = fixture.filter(r => r.tier1 && !r.tier1.reason && r.tier1.sharpness !== null && r.tier2.moments).slice(0, 301);
// The colour stills scan a real selection of 24 clips, picked across the hues, so one screen holds the whole spectrum.
const vivid = clean.filter(r => r.tier2 && r.tier2.colorHue !== null && r.tier2.colorChroma >= .15).sort((a, c) => (a.tier2.colorHue + 340) % 360 - (c.tier2.colorHue + 340) % 360);
const quiet = clean.filter(r => r.tier2 && r.tier2.moments && r.tier2.colorHue === null).slice(0, 4);
const spread = [...vivid.filter((r, i) => Math.floor(i * 20 / vivid.length) !== Math.floor((i - 1) * 20 / vivid.length)), ...quiet];

async function shot(b, name) {
  await b.mouse(4, 4);      // no hover on any row
  await sleep(420);
  const r = await b.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(MEDIA, name);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log(file);
}

const pictures = b => b.waitFor(`Array.from(document.querySelectorAll('img[src]')).every(function(i){return i.complete&&i.naturalWidth>0;})`, 'pictures');

async function panel(b, theme, list, source) {
  await b.open();
  await b.evalIn(`(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(CUT)};document.head.appendChild(s);
    __mock.skin=${JSON.stringify(THEME[theme])};__mock.listeners['com.adobe.csxs.events.ThemeColorChanged'].forEach(function(f){f();});
    __mock.project=${JSON.stringify(PROJECT)};__mock.items=${JSON.stringify((list || clean).map((r, i) => ({ id: 'n' + i, path: r.path, name: path.basename(r.path) })))};})()`);
  await pickSource(b, source || 'project');
  const n = b.engineLog.exited.length;
  await b.click('#scan');
  while (b.engineLog.exited.length === n) { await sleep(20); }
  await b.waitFor(`SelectApp.state.scan.state==='Done'`, 'scan');
  await pictures(b);
  await b.waitFor(`document.getElementById('project-name').textContent==='Lantern Bakery Spring Menu'`, 'project name');
}

async function main() {
  setDeadline(120000);
  fs.mkdirSync(MEDIA, { recursive: true });
  const b = await launch();
  b.engineEnv.FAKE_THUMBS = ensureThumbs();
  b.engineEnv.FAKE_DELAY_MS = '3';
  await b.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await b.size(STAGE.width, STAGE.height);

  await panel(b, 'dark', spread, 'selection');
  await pickSort(b, 'colorName');
  await b.click('#mode-grid');
  await pictures(b);
  await shot(b, 'panel-grid-dark.png');

  await panel(b, 'light', spread, 'selection');
  await pickSort(b, 'colorName');
  await b.click('#mode-grid');
  await pictures(b);
  await shot(b, 'panel-grid.png');

  await panel(b, 'dark');
  await b.evalIn(`SelectApp.setMode('list')`);
  await pickSort(b, 'sharpness');
  await b.click('#flip');
  await shot(b, 'panel-dark.png');

  await panel(b, 'light');
  await pickSort(b, 'sharpness');
  await b.click('#flip');
  await shot(b, 'panel.png');
  await b.click('#do-bins');
  await b.waitFor(`!document.getElementById('modal').hidden`);
  await sleep(260);
  fs.writeFileSync(path.join(OUT, 'bins-sheet.txt'), await b.evalIn(`document.getElementById('dialog').innerText`));
  await b.click('#dialog-ok');
  await b.waitFor(`/Sorted into 5 bins/.test(document.getElementById('foot-verdict').textContent)`, 'green status');
  await shot(b, 'panel-sorted.png');
  console.log(JSON.stringify(await b.evalIn(`document.getElementById('foot').innerText`)), 'script problems:', b.problems.length);
  await b.close();
  process.exit(b.problems.length ? 1 : 0);
}

main();
