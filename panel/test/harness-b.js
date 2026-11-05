#!/usr/bin/env node
// Browser checks for 0.4's column drag, hover scrub, search by folder and number, search suggestions, the Camera sort and
// the Date tooltip. harness.js runs them in a browser of their own after its own checks; alone: node harness-b.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEYS = { Escape: 27, ArrowDown: 40, ArrowUp: 38, Enter: 13, Tab: 9 };
const DAYS = [1, 2, 3, 24];

async function run(check) {
  const { launch, fixture, sleep, pressScan, pickShow, pickSort } = require('./harness.js');
  const { ensureThumbs } = require('./build_fixture.js');
  const b = await launch();
  b.engineEnv.FAKE_THUMBS = ensureThumbs();
  const ev = e => b.evalIn(e);
  const rect = sel => ev(`(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e){return null;}var r=e.getBoundingClientRect();return {l:r.left,t:r.top,r:r.right,b:r.bottom,w:r.width,h:r.height,x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  const move = (x, y, held) => b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, ...(held ? { button: 'left', buttons: 1 } : {}) });
  const down = (x, y) => b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  const up = (x, y) => b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  const key = async k => {
    const o = { key: k, code: k, windowsVirtualKeyCode: KEYS[k] };
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', ...o, ...(k === 'Enter' ? { text: '\r' } : {}) });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', ...o });
  };
  // Press, glide in steps with the button held, and stop there; the caller lets go.
  async function drag(from, to, steps) {
    await move(from.x, from.y);
    await down(from.x, from.y);
    for (let i = 1; i <= (steps || 8); i++) { await move(from.x + (to.x - from.x) * i / (steps || 8), from.y + (to.y - from.y) * i / (steps || 8), true); await sleep(16); }
  }
  const heads = () => ev(`Array.from(document.querySelectorAll('#head .h')).map(function(h){return h.dataset.key;}).filter(function(k){return k!=='thumb';})`);
  // Strip runs, from the page's own calls to spawn.
  let stripRuns = 0, onStrip = null;
  b.listen(m => {
    if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'slNative') { return; }
    const q = JSON.parse(m.params.payload);
    if (q.op === 'spawn' && q.args[0] === 'strip') {
      stripRuns++;
      if (onStrip) { const f = onStrip; onStrip = null; f(); }
    }
  });
  const strips = () => stripRuns;

  // Clips from the fixture with a picture, in Premiere bins DAY 1, 2, 3 and 24. The 11 with a number on screen (Kiln 2,
  // Lane 4, Lesson 1) are all in, in DAY 1 and DAY 3, so a search for day 2 can't pass through a lone 2. And one clip
  // whose strip takes the fake engine 2 s.
  const good = fixture.filter(r => r.tier1 && !r.tier1.reason && r.tier2 && r.tier2.moments);
  const numbered = good.filter(r => r.tier2.text.some(t => /\b\d+\b/.test(t)));
  const list = good.filter((r, i) => i % 3 === 0 && numbered.indexOf(r) < 0).slice(0, 96 - numbered.length);
  const items = list.map((r, i) => ({ id: 'b' + i, path: r.path, name: path.basename(r.path), bin: 'Footage/DAY ' + DAYS[i % 4] }))
    .concat(numbered.map((r, i) => ({ id: 'n' + i, path: r.path, name: path.basename(r.path), bin: 'Footage/DAY ' + (i % 2 ? 1 : 3) })));
  items.splice(5, 0, { id: 'slow', path: '/Volumes/Field SSD/Extra/slowstrip/C9001.MP4', name: 'C9001.MP4', bin: 'Footage/DAY 3' });
  // Scan reads the Project panel's target, which is the whole project here: the mock's items, each with its bin.
  async function scanNow() {
    await ev(`__mock.items=${JSON.stringify(items)}`);
    const n = b.engineLog.exited.length;
    await pressScan(b);
    const end = Date.now() + 30000;
    while (b.engineLog.exited.length === n && Date.now() < end) { await sleep(10); }
    await b.waitFor(`SelectApp.state.scan && !SelectApp.state.scan.handle && SelectApp.state.scan.state==='Done'`, 'scan done', 30000);
  }
  // A page with nothing on its disk, so no last results come back.
  async function freshPage() {
    await ev(`window.__disk && __disk.clear()`).catch(() => {});
    await b.open();
  }
  async function freshScan() {
    await freshPage();
    await scanNow();
  }

  try {
    await b.size(900, 620);
    await freshScan();
    check('B: the scan of 97 clips in four day bins ends Done, each row with its bin', (await ev(`SelectApp.state.store.rows.filter(function(r){return r.binPaths&&r.binPaths.length===1;}).length`)) === 97);

    // -------- column drag, in the list
    const order0 = await heads();
    const cam = await rect('#head .h[data-key="camera"]'), dur = await rect('#head .h[data-key="durationS"]');
    await drag({ x: cam.x, y: cam.y }, { x: dur.r + 14, y: cam.y + 3 });
    const lifted = await ev(`(function(){var p=document.querySelector('.lifted'),l=document.querySelector('.drop'),h=document.getElementById('head').getBoundingClientRect(),pr=p&&p.getBoundingClientRect(),lr=l&&l.getBoundingClientRect();
      return {pill:p&&p.textContent,pillIn:!!pr&&pr.top>=h.top&&pr.bottom<=h.bottom+1,line:!!lr&&lr.height===16&&lr.width===2,lineX:lr&&lr.left,from:document.querySelector('#head .h.from')&&document.querySelector('#head .h.from').dataset.key,
      blank:getComputedStyle(document.querySelector('#head .h[data-key="camera"]')).color,moving:document.querySelectorAll('#body .c-camera.moving').length,others:document.querySelectorAll('#body .c.moving:not(.c-camera)').length,
      fade:getComputedStyle(document.querySelector('#body .c-camera')).opacity,bg:getComputedStyle(p).backgroundColor,pillOpacity:getComputedStyle(p).opacity,pillShadow:getComputedStyle(p).boxShadow,menuShadow:getComputedStyle(document.getElementById('menu')).boxShadow,disc:getComputedStyle(document.documentElement).getPropertyValue('--disc').trim()};})()`);
    check('B drag: past 4 px the header lifts as a pill in the header row (92 %, the menus\' shadow), its cell goes blank, its column fades to 30 %, and a 2 × 16 px line marks the gap',
      lifted.pill === 'Camera' && lifted.pillIn && lifted.line && lifted.from === 'camera' && lifted.blank === 'rgba(0, 0, 0, 0)' && lifted.moving > 5 && lifted.others === 0 && lifted.fade === '0.3' && Math.abs(lifted.lineX - (dur.r + 4)) < 4 && lifted.pillOpacity === '0.92' && lifted.pillShadow === lifted.menuShadow, { lifted, durRight: dur.r });
    await up(dur.r + 14, cam.y + 3);
    await sleep(60);
    const after = await ev(`({heads:Array.from(document.querySelectorAll('#head .h')).map(function(h){return h.dataset.key;}).filter(function(k){return k!=='thumb';}),saved:JSON.parse(localStorage.getItem('select.columnOrder')),sort:SelectApp.state.view.sort.length,left:document.querySelectorAll('.lifted,.drop,.h.from,.c.moving').length,
      cells:Array.from(document.querySelector('#body .r').children).map(function(c){return c.className.split(' ')[1];})})`);
    const want = order0.filter(k => k !== 'camera');
    want.splice(want.indexOf('durationS') + 1, 0, 'camera');
    check('B drag: release puts the column in the gap at once, rows too, keeps the order as select.columnOrder, and doesn\'t sort',
      JSON.stringify(after.heads) === JSON.stringify(want) && after.saved[0] === 'durationS' && after.saved[1] === 'camera' && after.saved.length === (await ev(`SelectCore.COLUMNS.filter(function(c){return !c.fixed;}).length`)) && after.sort === 0 && after.left === 0 && after.cells.slice(1).join() === want.map(k => 'c-' + k).join(), { after, want });

    await b.click('#head .h[data-key="luma"]');
    check('B drag: a press and release on a header still sorts by it', (await ev(`JSON.stringify(SelectApp.state.view.sort)`)) === '[{"key":"luma","dir":-1}]');
    const luma = await rect('#head .h[data-key="luma"]');
    await move(luma.x, luma.y);
    await down(luma.x, luma.y);
    await move(luma.x + 2, luma.y + 1, true);
    await up(luma.x + 2, luma.y + 1);
    check('B drag: under 4 px it is a click, and sorts', (await ev(`JSON.stringify(SelectApp.state.view.sort)`)) === '[{"key":"luma","dir":1}]');
    await b.click('#sort');
    await b.click('#picker button[data-id="listed"]');

    const beforeEsc = await heads();
    const bright = await rect('#head .h[data-key="luma"]');
    await drag({ x: bright.x, y: bright.y }, { x: bright.x + 160, y: bright.y });
    await key('Escape');
    const escaped = await ev(`({left:document.querySelectorAll('.lifted,.drop,.h.from,.c.moving').length,drag:SelectApp.state.drag})`);
    await up(bright.x + 160, bright.y);
    await sleep(60);
    check('B drag: Esc puts the column back, and the release after it neither moves nor sorts', escaped.left === 0 && escaped.drag === null && JSON.stringify(await heads()) === JSON.stringify(beforeEsc) && (await ev(`SelectApp.state.view.sort.length`)) === 0, escaped);
    const motion = await rect('#head .h[data-key="motionProxy"]');
    await drag({ x: motion.x, y: motion.y }, { x: motion.x - 120, y: 12 });
    await up(motion.x - 120, 12);
    await sleep(60);
    check('B drag: a release away from the table puts the column back', JSON.stringify(await heads()) === JSON.stringify(beforeEsc) && (await ev(`document.querySelectorAll('.lifted,.drop').length`)) === 0 && (await ev(`SelectApp.state.view.sort.length`)) === 0);

    await b.click('#more');
    await b.click('[data-menu="columns"]');
    await b.click('#dialog-body [data-column="camera"]');
    const off = await heads();
    await b.click('#dialog-body [data-column="camera"]');
    const on = await heads();
    await b.click('#dialog-ok');
    check('B drag: Columns… switches a moved column off and on, and it comes back where it was dragged', !off.includes('camera') && JSON.stringify(on) === JSON.stringify(want), { off, on });
    // Dragged to the end, past columns switched off: it lands after the last one shown.
    const last = (await heads()).slice(-1)[0], lastR = await rect(`#head .h[data-key="${last}"]`), sharp = await rect('#head .h[data-key="sharpness"]');
    await drag({ x: sharp.x, y: sharp.y }, { x: lastR.r - 4, y: sharp.y });
    await up(lastR.r - 4, sharp.y);
    const atEnd = await heads();
    check('B drag: to the end of the row', atEnd.slice(-1)[0] === 'sharpness' && atEnd.length === on.length, atEnd);

    await freshPage();
    check('B drag: the order is still there after a reload', JSON.stringify(await heads()) === JSON.stringify(atEnd));
    // Near the right edge of a narrow table it scrolls sideways under the pill.
    await b.size(560, 620);
    await scanNow();
    const grid = await rect('#grid'), dHead = await rect('#head .h[data-key="durationS"]');
    const scroll0 = await ev(`document.getElementById('grid').scrollLeft`);
    await drag({ x: dHead.x, y: dHead.y }, { x: grid.r - 20, y: dHead.y });
    await sleep(400);
    const scrolled = await ev(`document.getElementById('grid').scrollLeft`);
    await key('Escape');
    await up(grid.r - 20, dHead.y);
    check('B drag: within 24 px of the table\'s edge the table scrolls sideways, 8 px a frame', scrolled - scroll0 >= 40, { scroll0, scrolled });
    await ev(`document.getElementById('grid').scrollLeft=0`);
    await b.size(900, 620);

    // -------- the Date tooltip and the Camera sort
    await ev(`(function(){var S=SelectApp.state,r=S.store.rows[0];SelectCore.ingest(S.store,{type:'clip',tier:0,path:r.path,createdAt:'2025-09-06T02:12:00+02:00',dateSource:'fileName',containerDate:'2026-10-30T17:00:00Z',dateOnly:false});
      SelectCore.ingest(S.store,{type:'clip',tier:0,path:S.store.rows[1].path,dateSource:'camera'});SelectApp.applyView();})()`);
    await sleep(60);
    const tips = await ev(`(function(){var c=document.querySelectorAll('#body .c-createdAt');return [c[0].title,c[1].title,c[0].textContent];})()`);
    const fileSays = await ev(`SelectCore.fmtDate('2026-10-30T17:00:00Z')`);
    check('B Date: the cell\'s tooltip says a date came from the file name, and the time the file holds; a camera date has none', tips[0] === 'From the file name; the file says ' + fileSays && tips[1] === '' && /^2025-09-06 /.test(tips[2]), tips);
    await b.click('#sort');
    const menu = await ev(`Array.from(document.querySelectorAll('#picker button')).map(function(x){return [x.dataset.id,x.firstChild.textContent,x.querySelector('span').textContent,x.title];})`);
    const ci = menu.findIndex(m => m[0] === 'camera');
    await b.click('#picker button[data-id="camera"]');
    const camNow = await ev(`({bar:document.querySelector('#sort .v').textContent,verdict:SelectCore.viewName(SelectApp.state.view),cams:SelectApp.state.order.map(function(i){return SelectApp.state.store.rows[i].camera;}),head:document.querySelector('#head .h.sorted').dataset.key})`);
    const named = camNow.cams.filter(Boolean), az = named.every((c, i) => !i || named[i - 1].localeCompare(c, 'en', { sensitivity: 'base' }) <= 0);
    const nullsLast = camNow.cams.indexOf(null) === -1 || camNow.cams.slice(camNow.cams.indexOf(null)).every(c => c === null);
    delete camNow.cams;
    check('B Camera: in the Sort menu between Colour and Name, hint A to Z, tooltip Maker and model.; the toolbar and the view\'s name say Camera A to Z',
      ci > 0 && menu[ci - 1][0] === 'colorName' && menu[ci + 1][0] === 'name' && menu[ci][1] === 'Camera' && menu[ci][2] === 'A to Z' && menu[ci][3] === 'Maker and model.' && camNow.bar === 'Camera A to Z' && camNow.verdict === 'Camera A to Z' && az && nullsLast && new Set(named).size >= 3 && camNow.head === 'camera', { menu: menu[ci], camNow, az, nullsLast });
    await b.click('#sort');
    await b.click('#picker button[data-id="listed"]');

    // -------- search: folders and numbers
    await b.click('#search-box');
    await b.send('Input.insertText', { text: 'day 2' });
    await b.waitFor(`SelectApp.state.query==='day 2'`);
    const byDay = await ev(`(function(){var S=SelectApp.state;return {shown:S.order.map(function(i){return S.store.rows[i].binPaths[0];}),all:S.store.rows.filter(function(r){return r.binPaths[0]==='Footage/DAY 2';}).length,
      lens:S.store.rows.filter(function(r){return /24-70/.test(r.lens||'')&&r.binPaths[0]!=='Footage/DAY 2';}).length,
      lone:S.store.rows.filter(function(r){return r.binPaths[0]!=='Footage/DAY 2'&&(r.text||[]).some(function(t){return /\\b2\\b/.test(t);});}).length,why:Array.from(document.querySelectorAll('#body .r .why')).filter(function(w){return w.parentNode.parentNode.style.display!=='none';}).slice(0,5).map(function(w){return w.textContent;})};})()`);
    check('B search: day 2 finds the DAY 2 bin and not DAY 24, nor a 24-70mm lens or a Kiln 2 on screen in another day, and says DAY 2 bare where the matched word shows',
      byDay.shown.length === byDay.all && byDay.all > 10 && byDay.shown.every(x => x === 'Footage/DAY 2') && byDay.lens > 5 && byDay.lone === 2 && byDay.why.every(w => w === 'DAY 2'), byDay);
    await ev(`SelectApp.setMode('grid')`);
    await sleep(100);
    const facts = await ev(`Array.from(document.querySelectorAll('#tiles .t')).filter(function(t){return t.style.display!=='none';}).slice(0,6).map(function(t){return t.querySelector('.f').textContent;})`);
    check('B search: the tiles say DAY 2', facts.length === 6 && facts.every(f => f === 'DAY 2'), facts);
    await ev(`(function(){var s=document.getElementById('search');s.value='';s.dispatchEvent(new Event('input'));})()`);
    await ev(`SelectApp.setMode('list')`);

    // -------- suggestions
    await b.click('#search-box');
    await b.send('Input.insertText', { text: 'w' });
    await b.waitFor(`!document.getElementById('suggest').hidden`, 'suggestions', 3000);
    await sleep(350);
    const sg = await ev(`(function(){var s=document.getElementById('suggest'),r=s.getBoundingClientRect(),box=document.getElementById('search-box').getBoundingClientRect();
      return {rows:Array.from(s.children).map(function(b){return [b.children.length,b.children[0].textContent,Number(b.children[1].textContent.replace(/,/g,''))];}),under:r.top>=box.bottom&&r.top<=box.bottom+6,wide:r.width>=box.width-1,
      inside:r.left>=0&&r.right<=innerWidth,radius:getComputedStyle(s).borderRadius,rowH:s.children[0].getBoundingClientRect().height,focus:document.activeElement.id};})()`);
    const counts = sg.rows.map(r => r[2]);
    check('B suggest: from the first character, at most 6 rows under the box, each the word and its count, most clips first, in the menus\' look',
      sg.rows.length >= 3 && sg.rows.length <= 6 && sg.rows.every(r => r[0] === 2 && /^w|\sw/i.test(r[1])) && counts.every((c, i) => !i || counts[i - 1] >= c) && sg.under && sg.wide && sg.inside && sg.radius === '8px' && sg.rowH === 24 && sg.focus === 'search', sg);
    await key('ArrowDown');
    await key('ArrowDown');
    const hot = await ev(`Array.from(document.querySelectorAll('#suggest button')).map(function(b){return b.classList.contains('hot');})`);
    await key('Enter');
    const took = await ev(`({value:document.getElementById('search').value,query:SelectApp.state.query,open:!document.getElementById('suggest').hidden,focus:document.activeElement.id,shown:SelectApp.state.order.length})`);
    check('B suggest: down, down, Enter takes the second row, searches at once, closes the list and keeps the field; it shows as many clips as its count', hot[1] && !hot[0] && took.value === sg.rows[1][1] && took.query === sg.rows[1][1] && !took.open && took.focus === 'search' && took.shown === sg.rows[1][2], { hot, took, second: sg.rows[1] });
    await b.send('Input.insertText', { text: ' w' });
    await b.waitFor(`!document.getElementById('suggest').hidden`, 'suggestions again', 3000);
    await key('Tab');
    const tabbed = await ev(`({value:document.getElementById('search').value,query:SelectApp.state.query})`);
    check('B suggest: Tab never takes a row: the search stays as typed', tabbed.value === sg.rows[1][1] + ' w' && tabbed.query === sg.rows[1][1] + ' w', tabbed);
    await ev(`document.getElementById('search').focus()`);
    await b.send('Input.insertText', { text: 'i' });
    await b.waitFor(`!document.getElementById('suggest').hidden`, 'suggestions on wi', 3000);
    const two = await ev(`[document.querySelector('#suggest button .w').textContent,Number(document.querySelector('#suggest button .n').textContent.replace(/,/g,''))]`);
    await key('ArrowDown');
    await key('Enter');
    const kept = await ev(`({value:document.getElementById('search').value,open:!document.getElementById('suggest').hidden,focus:document.activeElement.id,shown:SelectApp.state.order.length})`);
    check('B suggest: on the last word typed; Enter takes the row and keeps what came before, and shows its count', kept.value === sg.rows[1][1] + ' ' + two[0] && !kept.open && kept.focus === 'search' && kept.shown === two[1], { two, kept });
    await b.send('Input.insertText', { text: ' b' });
    await b.waitFor(`!document.getElementById('suggest').hidden`, 'suggestions on b', 3000).catch(() => {});
    const typedB = await ev(`document.getElementById('search').value`);
    await key('Escape');
    const esc1 = await ev(`({open:!document.getElementById('suggest').hidden,value:document.getElementById('search').value})`);
    await key('Escape');
    const esc2 = await ev(`({value:document.getElementById('search').value,shown:SelectApp.state.order.length})`);
    check('B suggest: Esc closes the list and keeps the search; a second Esc clears it', !esc1.open && esc1.value === typedB && esc2.value === '' && esc2.shown === 97, { esc1, esc2 });
    await b.send('Input.insertText', { text: 'wa' });
    await b.waitFor(`!document.getElementById('suggest').hidden`, 'suggestions on wa', 3000);
    const first = await ev(`document.querySelector('#suggest button .w').textContent`);
    await b.click('#suggest button');
    const clicked = await ev(`({value:document.getElementById('search').value,open:!document.getElementById('suggest').hidden,focus:document.activeElement.id})`);
    check('B suggest: a click on a row takes it, and the field keeps the focus', clicked.value === first && !clicked.open && clicked.focus === 'search', clicked);
    await ev(`(function(){var s=document.getElementById('search');s.value='';s.dispatchEvent(new Event('input'));})()`);
    await b.send('Input.insertText', { text: 'workshop' });
    await sleep(80);
    const alone = await ev(`({open:!document.getElementById('suggest').hidden,n:SelectCore.suggestions(SelectApp.state.store.rows,'workshop').length})`);
    await ev(`(function(){var s=document.getElementById('search');s.value='';s.dispatchEvent(new Event('input'));})()`);
    await b.send('Input.insertText', { text: 'b' });
    await b.waitFor(`!document.getElementById('suggest').hidden`, 'suggestions on b', 3000);
    await b.mouse(450, 400);
    const outside = await ev(`!document.getElementById('suggest').hidden`);
    check('B suggest: hidden when the word typed is the only one, and a click elsewhere closes it', !alone.open && alone.n === 0 && !outside, { alone, outside });
    await ev(`(function(){var s=document.getElementById('search');s.value='';s.dispatchEvent(new Event('input'));s.blur();})()`);
    await sleep(200);

    // -------- the search box: 260 px when wide; under 560 px the colour dots step aside while searching
    await b.click('#search-box');
    await sleep(350);
    const wide = await rect('#search-box');
    await b.size(420, 640);
    await sleep(350);
    const narrow = await ev(`({dots:getComputedStyle(document.getElementById('families')).display,box:document.getElementById('search-box').getBoundingClientRect().width,lines:new Set(['#show','#sort','#search-box','#more'].map(function(s){var r=document.querySelector(s).getBoundingClientRect();return Math.round(r.top+r.height/2);})).size,over:document.getElementById('toolbar').scrollWidth-document.getElementById('toolbar').clientWidth})`);
    await ev(`document.getElementById('search').blur()`);
    await sleep(350);
    await b.click('#families button[data-family="blue"]');
    await sleep(150);
    // Focus opens the search too; at 420 px with From, the flip and nine dots, the glass can sit past the edge here.
    await ev(`document.getElementById('search').focus()`);
    await sleep(350);
    const chosen = await ev(`({dots:getComputedStyle(document.getElementById('families')).display,searching:document.getElementById('toolbar').classList.contains('searching'),family:SelectApp.state.view.families.join()})`);
    await b.click('#families button[data-family="blue"]');
    await sleep(100);
    chosen.after = await ev(`SelectApp.state.view.families.length`);
    check('B search box: 260 px wide; under 560 px, while searching with no colour on, the dots step aside and the field takes the room, in one line',
      Math.round(wide.w) === 260 && narrow.dots === 'none' && narrow.box >= 140 && narrow.lines === 1 && narrow.over <= 0 && chosen.dots === 'flex' && chosen.searching && chosen.family === 'blue' && chosen.after === 0, { wide: wide.w, narrow, chosen });
    await ev(`document.getElementById('search').blur()`);
    await sleep(350);
    // Several colours on: the dots stay while searching, and the toolbar is no fuller than with one, at 420 and 300 px.
    const toolbarNow = `(function(){var t=document.getElementById('toolbar');return {dots:getComputedStyle(document.getElementById('families')).display,lines:new Set(['#show','#sort','#families','#search-box','#more'].map(function(s){var r=document.querySelector(s).getBoundingClientRect();return Math.round(r.top+r.height/2);})).size,
      over:t.scrollWidth-t.clientWidth,page:document.documentElement.scrollWidth,dots:Math.round(document.getElementById('families').getBoundingClientRect().width),box:Math.round(document.getElementById('search-box').getBoundingClientRect().width),on:document.querySelectorAll('#families button.on').length};})()`;
    const several = {};
    // Opened with a real click and a letter typed, as the editor does: an empty search closes by itself, and a scripted
    // focus opens it only sometimes in headless Chromium.
    const searchOpen = async () => {
      await b.click('#search-box');
      await b.send('Input.insertText', { text: 'b' });
      await b.waitFor(`document.getElementById('search-box').classList.contains('open')&&SelectApp.state.query==='b'`, 'search open', 3000);
      await sleep(350);
    };
    const searchShut = async () => {
      await ev(`document.getElementById('search').value='';document.getElementById('search').dispatchEvent(new Event('input'));document.getElementById('search').blur()`);
      await b.waitFor(`!document.getElementById('search-box').classList.contains('open')`, 'search shut', 3000);
      await sleep(350);
    };
    for (const w of [420, 300]) {
      await b.size(w, 640);
      await b.click('#families button[data-family="yellow"]');
      await searchOpen();
      const one = await ev(toolbarNow);
      await searchShut();
      await b.click('#families button[data-family="blue"]', { shift: true });
      await b.click('#families button[data-family="green"]', { shift: true });
      await searchOpen();
      const three = await ev(toolbarNow);
      await b.shot(`b-three-colours-searching-${w}`);
      await searchShut();
      for (const f of ['yellow', 'blue', 'green']) { await b.click(`#families button[data-family="${f}"]`, { shift: true }); }
      several[w] = { one, three };
    }
    // Under 400 px only the colours on stay while searching (10 px each), so Show and Sort keep their words.
    check('B: with several colours on, the dots stay while searching, and the toolbar stays one line and no fuller than with one colour, at 420 px; at 300 px only the colours on stay, the field 48 px or more',
      (x => x.three.on === 3 && x.one.on === 1 && x.three.dots === x.one.dots && x.three.dots > 0 && x.three.lines === 1 && x.three.lines <= x.one.lines && x.three.over <= x.one.over && x.three.page <= 420 && x.three.box === x.one.box && x.one.box >= 100)(several[420]) &&
      (x => x.one.dots === 10 && x.three.dots === 30 && x.one.lines === 1 && x.three.lines === 1 && x.one.over <= 0 && x.three.over <= 0 && x.three.page <= 300 && x.one.box >= 48 && x.three.box >= 48)(several[300]), several);
    await b.size(900, 620);
    await sleep(300);
    // A colour with no sort brought the rainbow: back to the clips as listed.
    await b.click('#sort');
    await b.click('#picker button[data-id="listed"]');

    // -------- the open search box with a query, wide and narrow: Show and Sort keep their words and the field takes the
    // room left; short of room the count goes first, whole, then the chevrons, and the words last
    const room = () => ev(`(function(){var R=function(s){return document.querySelector(s).getBoundingClientRect();},bar=document.getElementById('toolbar'),box=R('#search-box');
      var within=function(s,p){var e=document.querySelector(s),r=e.getBoundingClientRect(),q=R(p);return !e.hidden&&r.width>0&&r.left>=q.left-.5&&r.right<=q.right+.5&&r.top>=q.top-.5&&r.bottom<=q.bottom+.5;};
      return {said:document.querySelector('#show .v').textContent+'|'+document.querySelector('#sort .v').textContent,whole:Array.from(document.querySelectorAll('.pick .v')).every(function(x){return x.scrollWidth<=x.clientWidth;}),
        chevrons:within('#show .chev','#show')&&within('#sort .chev','#sort'),count:within('#search-count','#search-box'),countText:document.getElementById('search-count').textContent,x:within('#search-clear','#search-box'),
        field:Math.round(R('#search').width),box:Math.round(box.width),fills:Math.round(R('#more').left-box.right),
        lines:new Set(['#show','#sort','#search-box','#more'].map(function(s){var r=R(s);return Math.round(r.top+r.height/2);})).size,over:bar.scrollWidth-bar.clientWidth,page:document.documentElement.scrollWidth-innerWidth};})()`);
    await b.click('#search-box');
    await b.send('Input.insertText', { text: 'day 2' });
    await b.waitFor(`SelectApp.state.query==='day 2'`);
    const roomAt = {};
    roomAt.w900 = await room();
    for (const w of [420, 360, 300]) {
      await b.size(w, 640);
      await sleep(150);
      roomAt['w' + w] = await room();
    }
    await b.size(420, 640);
    await pickShow(b, 'interviews');
    await pickSort(b, 'durationS');
    await sleep(150);
    roomAt.long420 = await room();
    await pickShow(b, null);
    await pickSort(b, null);
    await ev(`(function(){var s=document.getElementById('search');s.value='';s.dispatchEvent(new Event('input'));s.blur();})()`);
    await b.size(900, 620);
    await sleep(300);
    const steady = r => r.whole && r.x && r.lines === 1 && r.over <= 0 && r.page <= 0;
    check('B search box, wide: 260 px with its count and ×, the words and their chevrons whole, as before', steady(roomAt.w900) && roomAt.w900.box === 260 && roomAt.w900.count && roomAt.w900.chevrons && roomAt.w900.said === 'Everything|As listed', roomAt.w900);
    check('B search box at 420 px: Show and Sort read whole with their chevrons, and the field takes the room left, its count and × inside, with the long words too',
      steady(roomAt.w420) && roomAt.w420.chevrons && roomAt.w420.count && roomAt.w420.fills <= 4 && roomAt.w420.field >= 80 && steady(roomAt.long420) && roomAt.long420.said === 'Interviews|Longest first' && roomAt.long420.chevrons && roomAt.long420.count && roomAt.long420.fills <= 4, { w420: roomAt.w420, long420: roomAt.long420 });
    // Premiere's font is narrower than the Mac's: at 360 px the count still fits, whole, and at 300 px it is the one gone.
    check('B search box, narrower: the count goes first, whole, before the chevrons; at 300 px Show and Sort still read whole with their chevrons beside a field of 48 px or more and its ×',
      steady(roomAt.w360) && roomAt.w360.chevrons && (roomAt.w360.count ? roomAt.w360.countText === '21 of 97' : true) && roomAt.w360.field >= 80 && steady(roomAt.w300) && !roomAt.w300.count && roomAt.w300.field >= 48 && roomAt.w300.said === 'Everything|As listed', { w360: roomAt.w360, w300: roomAt.w300 });

    // -------- hover scrub, in the grid
    await ev(`SelectApp.setMode('grid')`);
    await move(450, 30);
    await sleep(200);
    const pic = async at => rect(`#tiles .t[data-at="${at}"] .pic`);
    const shown = at => ev(`(function(){var t=document.querySelector('#tiles .t[data-at="${at}"]'),s=t.querySelector('.scrub'),p=t.querySelector('.pos');
      return {title:t.title,scrub:!s.hidden,size:s.style.backgroundSize,at:s.style.backgroundPosition,img:s.style.backgroundImage,pos:!p.hidden,fill:p.firstChild.style.width,posTop:p.getBoundingClientRect().top-t.querySelector('.pic').getBoundingClientRect().bottom,posW:p.getBoundingClientRect().width,picW:t.querySelector('.pic').getBoundingClientRect().width,track:getComputedStyle(p).backgroundColor,ring:getComputedStyle(document.documentElement).getPropertyValue('--ring').trim()};})()`);
    const near = (css, want, by) => Math.abs(parseFloat(css) - want) < (by || 0.6);
    const p0 = await pic(0);
    const s0 = strips();
    await move(p0.l + p0.w * 0.3, p0.t + p0.h / 2);
    await sleep(500);
    await move(p0.l + p0.w * 0.3 + 3, p0.t + p0.h / 2 + 2);
    await sleep(350);
    const early = { strips: strips() - s0, shown: (await shown(0)).scrub };
    await sleep(500);
    await b.waitFor(`!document.querySelector('#tiles .t[data-at="0"] .scrub').hidden`, 'strip shown', 3000).catch(() => {});
    const rest = await shown(0);
    check('B scrub: nothing before the pointer has rested a second (small moves allowed), then one strip, the frame under the pointer over the picture and the line under it, with no tooltip over it',
      early.strips === 0 && !early.shown && strips() - s0 === 1 && b.engineLog.lastArgs[0] === 'strip' && b.engineLog.lastArgs[2] === items[0].path && rest.scrub && rest.size === '1400% 100%' && near(rest.at, 4 / 13 * 100) && /% 0(px|%)?$/.test(rest.at) && rest.pos && near(rest.fill, (0.3 * p0.w + 3) / p0.w * 100, 1.5) && rest.posTop === 2 && Math.round(rest.posW) === Math.round(rest.picW) && rest.title === '', { early, rest, args: b.engineLog.lastArgs });
    await move(p0.l + p0.w * 0.8, p0.t + p0.h / 2);
    await sleep(30);
    const slid = await shown(0);
    check('B scrub: moving across slides to the frame floor(x / width × 14), and the line fills to the pointer, on the --ring track',
      near(slid.at, 11 / 13 * 100) && near(slid.fill, 80, 1.5) && slid.track === await ev(`(function(){var d=document.createElement('i');d.style.color='var(--ring)';document.body.appendChild(d);var c=getComputedStyle(d).color;d.remove();return c;})()`), slid);
    await move(p0.l + p0.w / 2, p0.b + 12);
    await sleep(30);
    const left = await shown(0);
    check('B scrub: leaving the picture puts the clip\'s own picture back at once, with no line, and the tile\'s tooltip, held back while it slid, is back', !left.scrub && !left.pos && left.img === '' && left.title === items[0].path, left);
    await move(p0.l + p0.w * 0.5, p0.t + p0.h / 2);
    await sleep(1150);
    const again = await shown(0);
    check('B scrub: the same clip again comes from the session\'s strip, with no new engine run', again.scrub && strips() - s0 === 1, { again, runs: strips() - s0 });
    const p1 = await pic(1);
    await move(p1.l + 20, p1.t + 20);
    await sleep(600);
    await move(p1.l + 20, p1.b + 40);
    await sleep(700);
    check('B scrub: leaving before the second is up asks nothing', strips() - s0 === 1);
    // One strip at a time: the slow clip's strip is still being made when the next picture's second is up.
    const slow = await ev(`SelectApp.state.order.indexOf(SelectApp.state.store.rows.filter(function(r){return /slowstrip/.test(r.path);})[0].rowId)`);
    const ps = await pic(slow), p2 = await pic(2);
    if (!ps) { throw new Error('no tile for the slow clip at ' + slow + ': ' + JSON.stringify(await ev(`Array.from(document.querySelectorAll('#tiles .t')).map(function(t){return t.dataset.at+':'+t.style.display;}).slice(0,14)`))); }
    await move(ps.l + 20, ps.t + 20);
    await sleep(1150);
    const slowAsked = strips() - s0;
    await move(p2.l + 20, p2.t + 20);
    await sleep(1150);
    const during = strips() - s0;
    await b.waitFor(`!document.querySelector('#tiles .t[data-at="2"] .scrub').hidden`, 'strip after the slow one', 4000).catch(() => {});
    check('B scrub: one strip at a time: the next picture\'s strip waits for the one being made, then shows', slowAsked === 2 && during === 2 && strips() - s0 === 3 && (await shown(2)).scrub, { slowAsked, during, now: strips() - s0 });
    await ev(`SelectApp.stopScrub()`);
    check('B scrub: stopScrub() on the app puts the picture back', !(await shown(2)).scrub && (await ev(`SelectApp.state.scrub`)) === null);
    // An error is kept: that clip is not asked again this session.
    b.engineEnv.FAKE_STRIP = 'fail';
    const p3 = await pic(3);
    await move(p3.l + 20, p3.t + 20);
    await sleep(1200);
    const failedOnce = strips() - s0;
    await move(p3.l + 20, p3.b + 40);
    await move(p3.l + 30, p3.t + 30);
    await sleep(1200);
    check('B scrub: a clip whose strip failed shows its own picture, and isn\'t asked again', failedOnce === 4 && strips() - s0 === 4 && !(await shown(3)).scrub, { failedOnce, now: strips() - s0 });
    b.engineEnv.FAKE_STRIP = '';
    // No engine: nothing at all.
    await ev(`__mock.accessError='ENOENT'`);
    const p4 = await pic(4);
    await move(p4.l + 20, p4.t + 20);
    await sleep(1200);
    check('B scrub: with no engine, nothing is asked and nothing changes', strips() - s0 === 4 && !(await shown(4)).scrub);
    await ev(`__mock.accessError=null`);
    // A strip kept for the session whose picture a scan has since removed is dropped and asked for once more, at once. A
    // strip just made that still doesn't load stays an error for the session.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-strips-'));
    try {
      const own = fixture.find(r => r.path === items[6].path), file = path.join(dir, own.index + '.jpg'), thumb = path.join(b.engineEnv.FAKE_THUMBS, own.index + '.png');
      fs.copyFileSync(thumb, file);
      b.engineEnv.FAKE_STRIPS = dir;
      const p6 = await pic(6);
      const rest6 = async () => { await move(p6.l + 30, p6.b + 40); await sleep(40); await move(p6.l + 30, p6.t + 30); await sleep(1150); };
      await rest6();
      const made = await b.waitFor(`!document.querySelector('#tiles .t[data-at="6"] .scrub').hidden`, 'strip 6', 3000).then(() => true, () => false);
      const runs1 = strips() - s0;
      fs.unlinkSync(file);
      onStrip = () => fs.copyFileSync(thumb, file);
      await rest6();
      const remade = await b.waitFor(`!document.querySelector('#tiles .t[data-at="6"] .scrub').hidden`, 'strip 6 again', 3000).then(() => true, () => false);
      const runs2 = strips() - s0;
      check('B scrub: a kept strip whose picture has gone is dropped and asked for once more, and the new one shows', made && runs1 === 5 && remade && runs2 === 6, { made, runs1, remade, runs2 });
      onStrip = null;
      fs.rmSync(file, { force: true });
      await rest6();
      await sleep(400);
      const runs3 = strips() - s0, none = !(await shown(6)).scrub && !(await shown(6)).pos;
      await rest6();
      await sleep(200);
      check('B scrub: if the strip asked for again doesn\'t load either, nothing shows, not even the line, and it isn\'t asked again', runs3 === 7 && none && strips() - s0 === 7 && !(await shown(6)).scrub, { runs3, none, now: strips() - s0 });
    } finally {
      b.engineEnv.FAKE_STRIPS = '';
      fs.rmSync(dir, { recursive: true, force: true });
    }
    await move(450, 30);
    // A clip with no picture doesn't scrub, and neither does the list.
    await ev(`SelectApp.setMode('list')`);
    const row6 = await rect('#body .r[data-at="6"] .c-thumb');
    await move(row6.x, row6.y);
    await sleep(1200);
    check('B scrub: not in the list', strips() - s0 === 7);
    await ev(`SelectApp.setMode('grid')`);
    // While a scan runs, nothing.
    b.engineEnv.FAKE_DELAY_MS = '30';
    await b.click('#more');
    await b.click('[data-menu="rescan"]');
    await b.waitFor(`SelectApp.state.store.rows.filter(function(r){return r.thumb;}).length>20 && SelectApp.state.scan.handle`, 'pictures mid scan', 20000);
    const pm = await ev(`(function(){var S=SelectApp.state;for(var i=0;i<S.order.length;i++){if(S.store.rows[S.order[i]].thumb){var e=document.querySelector('#tiles .t[data-at="'+i+'"] .pic');if(e){var r=e.getBoundingClientRect();if(r.top>60&&r.bottom<600){return {x:r.left+20,y:r.top+20};}}}}return null;})()`);
    const midScan = strips() - s0;
    if (pm) { await move(pm.x, pm.y); }
    await sleep(1200);
    const scanning = await ev(`!!SelectApp.state.scan.handle`);
    check('B scrub: nothing while a scan runs', !!pm && scanning && strips() - s0 === midScan, { pm, scanning, runs: strips() - s0 - midScan });
    await ev(`SelectApp.stopScan()`);
    b.engineEnv.FAKE_DELAY_MS = '';
    await b.waitFor(`!SelectApp.state.scan.handle`, 'scan stopped', 5000);
    // The strip pictures removed on purpose above are the only pages that may not load.
    const problems = b.problems.filter(p => !/^log Failed to load resource: net::ERR_FILE_NOT_FOUND file:.*\/sl-strips-[^/]+\/\d+\.jpg\?\d+ ?$/.test(p));
    check('B: no script errors in these checks', problems.length === 0, problems.slice(0, 5));
  } catch (e) {
    check('B checks ran to the end', false, e.stack);
    await b.shot('zz-b-failure').catch(() => {});
  }
  await b.close();
}

module.exports = { run };

if (require.main === module) {
  const { setDeadline } = require('./harness.js');
  const results = [];
  const check = (name, ok, detail) => {
    results.push(ok);
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' : ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''));
  };
  setDeadline(180000);
  run(check).then(() => {
    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length} checks, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
}
