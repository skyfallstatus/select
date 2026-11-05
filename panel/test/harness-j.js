// The band and the bar of 0.4 in the real page: the band shows only news, one row at a time, and goes; the bar's
// contents and order; Premiere's font, from Premiere's own folder, and the Mac's when it isn't there; one margin on
// every edge at every width; nothing past the edges at 300 px; the colour dots as one tab stop; the band opening and
// closing over 1,000 tiles. Run by harness.js, in its own browser.
'use strict';
const fs = require('fs');
const path = require('path');

const WIDTHS = [300, 420, 559, 760, 1100];
const FRAME = `new Promise(function(r){requestAnimationFrame(function(){var c=new MessageChannel();c.port1.onmessage=function(){r(true);};c.port2.postMessage(0);});})`;

// The ink edges the panel lines up on its 14 px margin, left and right. The status icons span 1 to 15 of their 16 px,
// the list glyph starts at 2, the last dot of ··· ends at 13.75.
const EDGES = `(function(){var q=function(s){var e=document.querySelector(s);if(!e){return null;}var r=e.getBoundingClientRect();return r.width||r.height?r:null;},W=innerWidth,o={W:W};
  var word=q('#show .k')||q('#show .v');o.word=word&&word.left;
  var mark=q('#foot-mark');o.mark=mark&&document.getElementById('foot').dataset.open==='true'?mark.left+1:null;
  var list=q('#mode-list');o.list=list&&list.left+4+2;
  var tile=q('#tiles .t[data-at="0"]');o.tile=tile&&!document.getElementById('tiles').hidden?tile.left:null;
  var img=q('#body .r[data-at="0"] .c-thumb img'),cell=q('#body .r[data-at="0"] .c-thumb');o.thumb=!document.getElementById('body').hidden&&(img||cell)?(img?img.left:cell.left+14):null;
  var more=q('#more');o.more=more&&W-(more.left+4+13.75);
  var pills=Array.prototype.filter.call(document.querySelectorAll('#foot-actions .action'),function(b){return b.offsetWidth>0;});o.pill=pills.length&&document.getElementById('foot').dataset.open==='true'?W-pills[pills.length-1].getBoundingClientRect().right:null;
  var bins=q('#do-bins');o.bins=bins&&W-bins.right;
  var S=SelectApp.state,lastAt=S.L.cols-1,last=q('#tiles .t[data-at="'+lastAt+'"]');o.lastTile=last&&!document.getElementById('tiles').hidden&&S.order.length>lastAt?W-last.right:null;
  return o;})()`;

// Everything on screen that sits past the panel's edges, or a row that wraps.
const OVER = `(function(){var W=innerWidth,out=[];document.querySelectorAll('#toolbar *, #foot *, #bottom *').forEach(function(e){if(!e.offsetWidth){return;}var r=e.getBoundingClientRect();if(r.right>W+0.5||r.left<-0.5){out.push((e.id||e.className||e.tagName)+' '+Math.round(r.left)+'..'+Math.round(r.right));}});
  var lines=function(sel){var ys=new Set();Array.prototype.forEach.call(document.querySelector(sel).children,function(c){if(c.offsetWidth){var r=c.getBoundingClientRect();ys.add(Math.round(r.top+r.height/2));}});return ys.size;};
  var cut=Array.prototype.filter.call(document.querySelectorAll('.action'),function(b){return b.offsetWidth&&b.scrollWidth>b.clientWidth+1;}).map(function(b){return b.id;});
  return {over:out,toolbar:lines('#toolbar'),bottom:lines('#bottom'),cut:cut,page:document.documentElement.scrollWidth,W:W};})()`;

async function run(check) {
  const H = require('./harness.js');
  const { launch, sleep, clips, foot, PREMIERE_APP } = H;
  const { ensureThumbs } = require('./build_fixture.js');
  const b = await launch();
  b.engineEnv.FAKE_THUMBS = ensureThumbs();
  b.engineEnv.FAKE_DELAY_MS = '0';
  const ev = e => b.evalIn(e);
  // Headless Chromium moves a transition on only with the frames it draws: let a quarter of a second of them run.
  const frames = async () => { for (let i = 0; i < 15; i++) { await ev(FRAME); } };
  const footNow = async () => { await frames(); return ev(foot); };
  const items = (n, from, bin) => clips(n).slice(from || 0).map(it => ({ ...it, bin: bin || 'Footage/DAY 2' }));
  const scanDay2 = async n => {
    await ev(`__mock.selection={kind:'bins',items:__mock.items.slice(0,${n}),places:['DAY 2']};SelectApp.askTarget()`);
    await b.waitFor(`SelectApp.state.target&&SelectApp.state.target.kind==='bins'`, 'the bin selected', 4000);
    const exits = b.engineLog.exited.length;
    await ev(`document.getElementById('scan').click()`);
    while (b.engineLog.exited.length === exits) { await sleep(10); }
    await b.waitFor(`SelectApp.state.scan&&SelectApp.state.scan.state==='Done'&&!SelectApp.state.scan.handle`, 'scan', 30000);
  };
  try {
    // -------- Premiere's font: from its folder when it is there, the Mac's own when it isn't
    const fontDir = path.join(path.dirname(path.dirname(PREMIERE_APP)), 'Resources/ttf');
    const premiere = fs.existsSync(path.join(fontDir, 'AdobeClean-Regular.ttf'));
    await b.size(420, 560);
    await b.open();
    await b.waitFor(`document.documentElement.dataset.font==='host'||(document.documentElement.dataset.font==='system'&&__mock.fontReads.length>0)`, 'the font', 5000).catch(() => {});
    const font = await ev(`({font:document.documentElement.dataset.font,reads:__mock.fontReads.slice(),loaded:document.fonts.check('12px SelectUI'),family:getComputedStyle(document.body).fontFamily,size:getComputedStyle(document.body).fontSize,faces:Array.from(document.fonts).filter(function(f){return f.family==='SelectUI'&&f.status==='loaded';}).map(function(f){return f.weight+' '+f.style;}).sort()})`);
    check('J: Premiere\'s own font, read from Premiere\'s folder at each start: Adobe Clean regular, bold and both italics, as SelectUI, at 12 px', premiere ? font.font === 'host' && font.loaded && font.faces.join() === '400 italic,400 normal,700 italic,700 normal' &&
      font.reads.length === 4 && font.reads.every(r => r.indexOf(fontDir + '/AdobeClean-') === 0) && /^SelectUI, -apple-system/.test(font.family) && font.size === '12px' : font.font === 'system', { premiere, font });
    await ev(`localStorage.setItem('__hostApp','/Applications/Nowhere/Nothing.app/Contents/MacOS/Nothing')`);
    await b.open();
    await b.waitFor(`__mock.fontReads.length>0`, 'the font asked for', 5000).catch(() => {});
    await sleep(200);
    const none = await ev(`({font:document.documentElement.dataset.font,reads:__mock.fontReads.slice(),faces:Array.from(document.fonts).filter(function(f){return f.family==='SelectUI';}).length,family:getComputedStyle(document.body).fontFamily})`);
    await ev(`localStorage.removeItem('__hostApp')`);
    check('J: without Premiere\'s font files, the Mac\'s own font: nothing added, and the system stack after SelectUI', none.font === 'system' && none.faces === 0 && none.reads.length >= 1 && /^SelectUI, -apple-system, /.test(none.family), none);
    // The stand-in for Node reads the missing files through the browser, which logs each miss; Node would not.
    for (let i = b.problems.length - 1; i >= 0; i--) { if (/ERR_FILE_NOT_FOUND file:\/\/\/Applications\/Nowhere\//.test(b.problems[i])) { b.problems.splice(i, 1); } }
    await b.open();
    await ev(`__disk.clear();SelectApp.setMode('grid');SelectApp.timeouts.settle=1e9`);

    // -------- the band: only news, one row, and gone; the bar: once there are results
    await ev(`__mock.items=${JSON.stringify(items(400))};__mock.selection=null;SelectApp.askTarget()`);
    await b.waitFor(`document.getElementById('foot-verdict').textContent==='Whole project'`, 'whole project', 4000);
    await sleep(300);
    const before = await footNow();
    check('J: before any results the band is open with the target and the one blue Scan, and there is no bar', before.open && before.verdict === 'Whole project' && before.actions.join() === 'scan*' && before.bar === null, before);
    await scanDay2(72);
    await sleep(300);
    const calm = await footNow(), barNow = await ev(`({order:Array.from(document.getElementById('bottom').querySelectorAll('[id]')).filter(function(e){return e.offsetWidth>0;}).map(function(e){return e.id;}).join(),h:document.getElementById('bottom').offsetHeight,line:getComputedStyle(document.getElementById('bottom')).borderTopStyle,
      on:document.querySelector('#modes .on').id,plate:getComputedStyle(document.querySelector('#modes .on')).backgroundColor,sel:getComputedStyle(document.documentElement).getPropertyValue('--sel').trim(),radius:getComputedStyle(document.querySelector('#modes .on')).borderRadius,
      gap:getComputedStyle(document.getElementById('modes')).columnGap,count:getComputedStyle(document.getElementById('count')).color,ink2:getComputedStyle(document.documentElement).getPropertyValue('--ink2').trim(),bins:getComputedStyle(document.getElementById('do-bins')).backgroundColor,seq:getComputedStyle(document.getElementById('do-sequence')).backgroundColor,
      grid:document.getElementById('grid').getBoundingClientRect().height,bandH:document.getElementById('foot').getBoundingClientRect().height})`);
    check('J: calm results: the band closed, no row and no height; the toolbar names the view and the bar counts', !calm.open && calm.mark === '' && barNow.bandH === 0 && calm.count === '72 clips', { calm, barNow });
    check('J: the bar: list and grid 4 px apart, the one on a 4 px plate, the count in ink2, then Make Sequence and Sort into Bins; 40 px, no line', barNow.order === 'modes,mode-list,mode-grid,count-box,count,bottom-actions,do-sequence,do-bins' && barNow.h === 40 && barNow.line === 'none' && barNow.on === 'mode-grid' && barNow.radius === '4px' && barNow.gap === '4px' && barNow.count === 'rgb(173, 173, 177)', barNow);
    // Off, Sort into Bins is a grey plate with quiet words, never a dim blue.
    const off = await ev(`(function(){var c=getComputedStyle(document.getElementById('do-bins'));return {disabled:document.getElementById('do-bins').disabled,bg:c.backgroundColor,border:c.borderTopColor,color:c.color,opacity:c.opacity,ink3:getComputedStyle(document.documentElement).getPropertyValue('--ink3').trim(),title:document.getElementById('do-bins').title};})()`);
    check('J: a pill that is off is a grey plate, no outline, its words in ink3, at full opacity; never a dim blue', off.disabled && off.bg === 'rgba(255, 255, 255, 0.05)' && off.border === 'rgba(0, 0, 0, 0)' && off.color === 'rgb(152, 152, 157)' && off.ink3 === '#98989D' && off.opacity === '1' && off.title === 'Pick a Show, a colour or a sort', off);
    // A new selection opens the band; a note takes its row, with its Scan; the update line waits behind both.
    await ev(`__mock.selection={kind:'clips',items:__mock.items.slice(200,212),places:['DAY 3']};SelectApp.askTarget()`);
    await b.waitFor(`/other clips selected/.test(document.getElementById('foot-verdict').textContent)`, 'the new selection', 4000);
    await sleep(250);
    const waiting = await footNow();
    await ev(`document.getElementById('update-line').hidden=false;document.getElementById('update-line').textContent='Select 0.4.1 is ready.'`);
    await sleep(250);
    await frames();
    const behind = await ev(`({shown:getComputedStyle(document.getElementById('update-line')).display,row:document.getElementById('foot').dataset.row,h:document.getElementById('foot').getBoundingClientRect().height})`);
    await ev(`__mock.playback={program:true,source:false,modal:''};document.getElementById('do-sequence').click()`);
    await b.waitFor(`/Playback is running/.test(document.getElementById('foot-verdict').textContent)`, 'the refusal', 4000);
    await sleep(250);
    const refused = await footNow(), refusedH = await ev(`document.getElementById('foot').getBoundingClientRect().height`);
    await ev(`__mock.playback={program:false,source:false,modal:''}`);
    check('J: a new selection opens the band with its words and an outlined Scan; the update line waits hidden behind it, one row high', waiting.open && waiting.mark === 'clips' && waiting.verdict === '12 other clips selected' && waiting.sentence === 'DAY 3' && waiting.actions.join() === 'scan' && behind.shown === 'none' && behind.row === 'status' && behind.h === 36, { waiting, behind });
    check('J: a refusal takes the band\'s one row, amber, with the Scan of the selection it hides; still one row', refused.verdict === 'Playback is running' && refused.mark === 'alert' && refused.tone === 'warn' && refused.actions.join() === 'scan' && refusedH === 36, { refused, refusedH });
    // Moving on: the note goes, the selection's row comes back; it is scanned, and the update line shows alone.
    await b.click('#tiles .t[data-at="1"] .pic');
    await sleep(250);
    const back = await footNow();
    await ev(`__mock.selection={kind:'clips',items:__mock.items.slice(2,6),places:['DAY 2']};SelectApp.askTarget()`);
    await sleep(300);
    await frames();
    const alone = await ev(`({row:document.getElementById('foot').dataset.row,shown:getComputedStyle(document.getElementById('update-line')).display,h:document.getElementById('foot').getBoundingClientRect().height,top:document.getElementById('foot-top').hidden})`);
    await ev(`document.getElementById('update-line').hidden=true;document.getElementById('update-line').textContent=''`);
    await sleep(300);
    await frames();
    const shut = await ev(`({open:document.getElementById('foot').dataset.open,h:document.getElementById('foot').getBoundingClientRect().height})`);
    check('J: a click moves on: the refusal goes and the row it hid comes back; with nothing else to say, the update line has the row; then the band closes', back.verdict === '12 other clips selected' && back.actions.join() === 'scan' && alone.row === 'update' && alone.shown === 'flex' && alone.h === 36 && alone.top && shut.open === 'false' && shut.h === 0, { back, alone, shut });
    // What a scan didn't read whole is in the bar's count and its tooltip, never a second row.
    await ev(`__mock.items=${JSON.stringify(items(400).concat([{ id: 'w1', path: '/Volumes/Field SSD/Audio/room tone.wav', name: 'room tone.wav', bin: 'Footage/DAY 2' }]))};SelectApp.state.selected.clear();SelectApp.applyView()`);
    await ev(`__mock.selection={kind:'bins',items:__mock.items.slice(72,144).concat(__mock.items.slice(-1)),places:['DAY 4']};SelectApp.askTarget()`);
    await sleep(300);
    const exits = b.engineLog.exited.length;
    await ev(`document.getElementById('scan').click()`);
    while (b.engineLog.exited.length === exits) { await sleep(10); }
    await b.waitFor(`SelectApp.state.scan.state==='Done'`, 'scan', 30000);
    await sleep(300);
    const skipped = await footNow(), skippedBand = await ev(`document.getElementById('foot').getBoundingClientRect().height`);
    check('J: after a scan that skipped an audio file and couldn\'t read some clips, the band is closed; the bar says how many weren\'t read, and its tooltip says why and what was skipped', !skipped.open && skippedBand === 0 && skipped.count === '72 clips' && /^\d+ not read$/.test(skipped.notRead) && /\n1 item skipped: not video\.\n72 clips \u00b7 \d+ not read$/.test(skipped.countTip) && /could not be read/.test(skipped.countTip), skipped);
    await ev(`SelectApp.state.selected.clear();SelectApp.applyView()`);

    // -------- one margin on every edge, at every width, in every row that is there
    await ev(`__mock.selection={kind:'clips',items:__mock.items.slice(200,212),places:['DAY 3']};SelectApp.askTarget()`);
    await b.waitFor(`!document.getElementById('foot-top').hidden`, 'band row', 4000);
    const edges = {}, overs = {};
    for (const w of WIDTHS) {
      await b.size(w, 560);
      await ev(FRAME);
      await sleep(250);
      edges[w] = await ev(EDGES);
      overs[w] = await ev(OVER);
    }
    await ev(`SelectApp.setMode('list')`);
    await sleep(200);
    for (const w of WIDTHS) {
      await b.size(w, 560);
      await ev(FRAME);
      await sleep(150);
      const e = await ev(EDGES);
      edges[w].thumb = e.thumb;
      edges[w].listRight = await ev(`(function(){var g=document.getElementById('grid'),c=document.querySelector('#body .r[data-at="0"] .c:last-child'),cs=getComputedStyle(c),r=c.getBoundingClientRect();return Math.round((innerWidth-(r.right-parseFloat(cs.paddingRight)))*2)/2;})()`);
      edges[w].wide = await ev(`document.getElementById('body').offsetWidth>document.getElementById('grid').clientWidth`);
    }
    await ev(`SelectApp.setMode('grid')`);
    const offLeft = (e, k) => e[k] === null || e[k] === undefined || Math.abs(e[k] - 14) <= 1;
    const leftBad = WIDTHS.filter(w => !['word', 'mark', 'list', 'tile', 'thumb'].every(k => offLeft(edges[w], k)));
    const rightBad = WIDTHS.filter(w => !['more', 'pill', 'bins', 'lastTile'].every(k => offLeft(edges[w], k)));
    check('J: one margin: the toolbar\'s first word, the band\'s icon, the bar\'s first icon, the first tile and the list\'s first column all start 14 px in, within 1 px, at 300, 420, 559, 760 and 1,100 px', !leftBad.length && WIDTHS.every(w => edges[w].mark !== null && edges[w].tile !== null && edges[w].thumb !== null), { leftBad, edges });
    check('J: and on the right, ···, the band\'s Scan, the last tile and Sort into Bins all end 14 px from the edge, within 1 px', !rightBad.length && WIDTHS.every(w => edges[w].pill !== null && edges[w].lastTile !== null), { rightBad, edges });
    check('J: the list\'s last column ends 14 px from the edge too, the scrollbar inside the margin, scrolling or not', WIDTHS.every(w => edges[w].wide || Math.abs(edges[w].listRight - 14) <= 1), WIDTHS.map(w => [w, edges[w].listRight, edges[w].wide]));
    check('J: nothing passes the panel\'s edges and nothing wraps, down to 300 px: the toolbar, the band and the bar each one line, every pill whole', WIDTHS.every(w => !overs[w].over.length && overs[w].toolbar === 1 && overs[w].bottom === 1 && !overs[w].cut.length && overs[w].page <= w), overs);
    const narrow = await (async () => { await b.size(300, 560); await sleep(200); return ev(`({show:document.querySelector('#show .v').textContent,showCut:document.querySelector('#show .v').scrollWidth>document.querySelector('#show .v').clientWidth,showW:Math.round(document.querySelector('#show .v').getBoundingClientRect().width),countW:document.getElementById('count').getBoundingClientRect().width,countShown:document.getElementById('count').getBoundingClientRect().top<document.getElementById('count-box').getBoundingClientRect().bottom,seq:document.getElementById('do-sequence').innerText,bins:document.getElementById('do-bins').innerText,dot:document.querySelector('#families button').offsetWidth})`); })();
    check('J: at 300 px the dots come closer (10 px), the picks keep a word\'s worth, and the bar reads Sequence and Bins', narrow.dot === 10 && narrow.showW >= 40 && narrow.seq === 'Sequence' && narrow.bins === 'Bins', narrow);

    // -------- the one blue stays on Sort into Bins: the default view has none
    await b.size(760, 560);
    await sleep(150);
    await ev(`SelectApp.state.selected.clear();SelectApp.state.view={show:null,sort:[],families:[]};SelectApp.applyView()`);
    await frames();
    const blue = `(function(){var c=function(id){var e=document.getElementById(id),s=getComputedStyle(e);return {primary:e.classList.contains('primary'),off:e.disabled,bg:s.backgroundColor};};return {seq:c('do-sequence'),bins:c('do-bins'),cobalt:Array.prototype.filter.call(document.querySelectorAll('#bottom *'),function(e){return getComputedStyle(e).backgroundColor==='rgb(47, 111, 230)';}).length};})()`;
    const plain = await ev(blue);
    await H.pickSort(b, 'sharpness');
    await frames();
    const sorted = await ev(blue);
    await H.pickSort(b, null);
    check('J: the blue never hops: Sort into Bins is the one blue when it can act, the grey plate when it can\'t, and Make Sequence is never blue, so the default view has no blue at all',
      !plain.seq.primary && !plain.seq.off && plain.bins.primary && plain.bins.off && plain.bins.bg === 'rgba(255, 255, 255, 0.05)' && plain.cobalt === 0 && !sorted.seq.primary && sorted.bins.primary && !sorted.bins.off && sorted.bins.bg === 'rgb(47, 111, 230)' && sorted.cobalt === 1, { plain, sorted });
    // ··· hangs its menu from its own edge.
    await b.click('#more');
    const edge = await ev(`({menu:Math.round(innerWidth-document.getElementById('menu').getBoundingClientRect().right),button:Math.round(innerWidth-document.getElementById('more').getBoundingClientRect().right)})`);
    await H.press(b, 'Escape');
    check('J: the ··· menu\'s right edge is its button\'s', edge.menu === edge.button && edge.menu === 8, edge);

    // -------- 300 px: a partial write keeps its count, Details gives way; a search with a colour keeps Show and Sort readable; the list puts the sorted column by the name
    await b.size(300, 560);
    await sleep(150);
    await ev(`SelectApp.state.outcome=SelectCore.writeOutcome('sequence',{items:[['1','/a'],['2','/b'],['3','/c']]},{made:true,clips:71,inOrder:true,failed:[],skipped:[]});SelectApp.state.outcome.verdict='71 of 72 clips in the sequence';SelectApp.state.outcome.failed=[{name:'1 clip',error:'not in the sequence'}];SelectApp.applyView()`);
    await frames();
    const part = await ev(`({verdict:document.getElementById('foot-verdict').textContent,shown:Array.from(document.querySelectorAll('#foot-actions .action')).filter(function(x){return x.offsetWidth>0;}).map(function(x){return x.id;}).join(),seen:document.getElementById('foot-verdict').clientWidth,whole:document.getElementById('foot-verdict').scrollWidth<=document.getElementById('foot-verdict').clientWidth+1,tip:document.getElementById('foot-words').title})`);
    await b.size(420, 560);
    await sleep(150);
    await frames();
    const part420 = await ev(`Array.from(document.querySelectorAll('#foot-actions .action')).filter(function(x){return x.offsetWidth>0;}).map(function(x){return x.id;}).join()`);
    await ev(`SelectApp.state.outcome=null;SelectApp.applyView()`);
    check('J: under 400 px a partial write keeps its count in view: Details gives way before the words are cut, and comes back with the room', part.shown === 'undo-write' && part.whole && /^71 of 72 clips/.test(part.verdict) && part420 === 'foot-details,undo-write', { part, part420 });
    await b.size(300, 560);
    await sleep(150);
    await b.click('#families [data-family="red"]');
    await b.click('#search-box');
    await b.send('Input.insertText', { text: 'c0' });
    await frames();
    const searched = await ev(`(function(){var m=function(id){var v=document.querySelector(id+' .v');return {w:Math.round(v.getBoundingClientRect().width),text:v.textContent};};return {show:m('#show'),sort:m('#sort')};})()`);
    const dots = await ev(`Array.prototype.filter.call(document.querySelectorAll('#families button'),function(x){return x.offsetWidth>0;}).map(function(x){return x.dataset.family;}).join()`);
    const room = await ev(OVER);
    // The typed text stays on the field's one line, in view, after the glass and before the clear.
    const field = await ev(`(function(){var box=document.getElementById('search-box').getBoundingClientRect(),s=document.getElementById('search'),r=s.getBoundingClientRect(),c=document.getElementById('search-clear').getBoundingClientRect();return {box:Math.round(box.width),w:Math.round(r.width),top:Math.round(r.top-box.top),inside:r.bottom<=box.bottom+0.5&&r.right<=c.left+0.5,fits:s.scrollWidth<=s.clientWidth+1,value:s.value};})()`);
    await ev(`(function(){var s=document.getElementById('search');s.value='';s.dispatchEvent(new Event('input'));s.blur();})()`);
    await b.click('#families [data-family="red"]');
    check('J: at 300 px, searching with a colour on, only that colour stays and Show and Sort keep at least three letters; the typed text stays in view in the field; nothing passes the edge', dots === 'red' && searched.show.w >= 24 && searched.sort.w >= 24 && field.value === 'c0' && field.top === 0 && field.inside && field.fits && field.w >= 24 && !room.over.length && room.toolbar === 1, { searched, dots, field, room });
    await ev(`SelectApp.setMode('list')`);
    await H.pickSort(b, 'luma');
    await frames();
    const heads = await ev(`Array.from(document.querySelectorAll('#head .h')).map(function(h){return h.dataset.key;}).slice(0,4).join()`);
    await b.size(760, 560);
    await sleep(150);
    await frames();
    const wide = await ev(`Array.from(document.querySelectorAll('#head .h')).map(function(h){return h.dataset.key;}).slice(0,4).join()`);
    await H.pickSort(b, null);
    await ev(`SelectApp.setMode('grid')`);
    check('J: under 400 px the list puts the sorted column right after Name, so it reads in the first screen; wider, the columns are back in their order', heads === 'thumb,name,luma,durationS' && wide === 'thumb,name,durationS,sharpness', { heads, wide });

    // -------- the colour dots: one stop for Tab, arrows move, Space picks, Shift-Space adds
    await b.size(760, 560);
    await sleep(150);
    await ev(`SelectApp.state.selected.clear();SelectApp.applyView();document.querySelector('#families button').focus()`);
    const key = async (k, mods) => { const code = { ArrowRight: 39, ArrowLeft: 37, ' ': 32 }[k]; await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k === ' ' ? 'Space' : k, windowsVirtualKeyCode: code, modifiers: mods || 0 }); await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k === ' ' ? 'Space' : k, windowsVirtualKeyCode: code, modifiers: mods || 0 }); };
    const stops = await ev(`Array.from(document.querySelectorAll('#families button')).filter(function(x){return x.tabIndex===0;}).length`);
    await key('ArrowRight'); await key('ArrowRight');
    const focused = await ev(`document.activeElement.dataset.family`);
    await key(' ');
    const one = await ev(`SelectApp.state.view.families.join()`);
    await key('ArrowRight');
    await key(' ', 8);
    const two = await ev(`({families:SelectApp.state.view.families.join(),stops:Array.from(document.querySelectorAll('#families button')).filter(function(x){return x.tabIndex===0;}).map(function(x){return x.dataset.family;}).join()})`);
    check('J: the nine dots are one Tab stop: Right moves, Space picks one alone, Shift-Space adds', stops === 1 && focused === 'yellow' && one === 'yellow' && two.families === 'yellow,green' && two.stops === 'green', { stops, focused, one, two });
    await ev(`SelectApp.state.view={show:null,sort:[],families:[]};SelectApp.applyView()`);
    // Nothing grows on hover or press: a dot gets a ring.
    const dot = await ev(`(function(){var b=document.querySelector('#families [data-family="blue"]'),r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dot.x, y: dot.y });
    await sleep(200);
    const hover = await ev(`(function(){var i=getComputedStyle(document.querySelector('#families [data-family="blue"] i'));return {transform:i.transform,ring:i.boxShadow};})()`);
    check('J: a dot under the pointer gets a 1 px ring, and does not grow', hover.transform === 'none' && /0px 0px 0px 2px/.test(hover.ring), hover);

    // -------- the band opening and closing over 1,000 tiles: frames, and the clip at the top kept
    await b.size(1100, 700);
    await ev(`__mock.selection=null;__mock.items=${JSON.stringify(items(1000))};SelectApp.askTarget()`);
    await sleep(200);
    await ev(`SelectApp.startScan({whole:true})`);
    await b.waitFor(`SelectApp.state.scan&&SelectApp.state.scan.state==='Done'&&SelectApp.state.store.rows.length===1000`, '1,000 clips', 60000);
    await ev(`SelectApp.state.selected.clear();SelectApp.applyView();(function(){var g=document.getElementById('grid');g.scrollTop=Math.round(g.scrollHeight*0.3);g.dispatchEvent(new Event('scroll'));})()`);
    await sleep(900);
    await ev(FRAME);
    const motion = async (show) => ev(`new Promise(function(resolve){var g=document.getElementById('grid'),S=SelectApp.state,gaps=[],last=performance.now(),n=0,drift=0,screen=0;
      var top=function(){var gr=g.getBoundingClientRect(),best=null;document.querySelectorAll('#tiles .t').forEach(function(el){if(el.style.display==='none'){return;}var r=el.getBoundingClientRect();if(r.top+r.height/2>=gr.top&&(best===null||Number(el.dataset.at)<best.at)){best={at:Number(el.dataset.at),y:r.top-gr.top,abs:r.top};}});return best;};
      var t0=top();${show}
      function step(now){gaps.push(now-last);last=now;var t=top();if(t&&t.at===t0.at){drift=Math.max(drift,Math.abs(t.y-t0.y));}else{drift=99;}screen=t?t.abs-t0.abs:screen;if(++n<24){requestAnimationFrame(step);}else{gaps.shift();gaps.sort(function(a,b){return a-b;});resolve({p99:gaps[Math.floor(gaps.length*.99)],max:gaps[gaps.length-1],median:gaps[gaps.length>>1],drift:drift,screen:Math.round(screen),at:t0.at,band:document.getElementById('foot').getBoundingClientRect().height});}}
      requestAnimationFrame(step);})`);
    const opening = await motion(`SelectApp.state.outcome={kind:'undone',verdict:'Undone',sentence:'',undo:false,none:false,failed:[]};SelectApp.applyView();`);
    const closing = await motion(`SelectApp.state.outcome=null;SelectApp.applyView();`);
    check('J: over 1,000 tiles the band opens and closes in 150 ms at about 60 fps (headless, software), and the clip at the top stays on the top row within 1 px of its place in the grid',
      opening.band === 36 && closing.band === 0 && opening.p99 <= 34 && closing.p99 <= 34 && opening.drift <= 1 && closing.drift <= 1, { opening, closing });
    check('J: no script errors', b.problems.length === 0, b.problems.slice(0, 5));
  } catch (e) {
    check('J: harness-j ran to the end', false, e.stack);
    await b.shot('zz-failure-j').catch(() => {});
  }
  await b.close();
}

module.exports = { run };
if (require.main === module) {
  const H = require('./harness.js');
  H.setDeadline(300000);
  run(H.check).then(() => { H.stopEverything(); process.exit(0); });
}
