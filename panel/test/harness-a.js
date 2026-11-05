// Package A of 0.4 in the real page: the status row without its card, the scan target live, last results, the project
// tie, the right-click menu, Make Sequence, one bin and Other, and the text cut. Run by harness.js, in its own browser.
'use strict';

async function run(check) {
  const H = require('./harness.js');
  const { launch, setItems, clips, scanAndWait, pickSort, sleep, foot, PROJECT, press, labelFromMenu } = H;
  const { ensureThumbs } = require('./build_fixture.js');
  const b = await launch();
  // Every state the status takes in this run, page after page, with the buttons it shows: none of them is Label.
  const footSeen = new Map();
  await b.send('Runtime.addBinding', { name: 'slFootSeen' });
  b.listen(m => { if (m.method === 'Runtime.bindingCalled' && m.params.name === 'slFootSeen') { const s = JSON.parse(m.params.payload); footSeen.set(s.kind + '|' + s.buttons, s); } });
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `document.addEventListener('DOMContentLoaded',function(){var f=document.getElementById('foot'),last='';if(!f||!window.slFootSeen){return;}
    function seen(){var k=f.className.split(' ')[0],on=Array.prototype.filter.call(f.querySelectorAll('button'),function(x){return !x.hidden&&x.offsetWidth>0;}).map(function(x){return x.id+':'+x.textContent.trim();}).join(',');
      if(k+'|'+on!==last){last=k+'|'+on;window.slFootSeen(JSON.stringify({kind:k,buttons:on,label:!!document.getElementById('do-label')}));}}
    new MutationObserver(seen).observe(f,{subtree:true,childList:true,attributes:true,characterData:true});seen();});` });
  b.engineEnv.FAKE_THUMBS = ensureThumbs();
  b.engineEnv.FAKE_DELAY_MS = '0';
  const ev = expr => b.evalIn(expr);
  const footNow = () => ev(foot);
  const calls = name => ev(`__mock.calls.filter(function(c){return c.fn===${JSON.stringify(name)};}).map(function(c){return c.args;})`);
  const noteText = () => ev(`document.getElementById('status-note').textContent`);
  const modalOpen = () => ev(`!document.getElementById('modal').hidden`);
  const waitModal = () => b.waitFor(`!document.getElementById('modal').hidden`, 'a sheet');
  const sheet = () => ev(`({title:document.getElementById('dialog-title').textContent,body:document.getElementById('dialog-body').innerText,field:(document.getElementById('sheet-name')||{}).value,ok:document.getElementById('dialog-ok').textContent,okTip:document.getElementById('dialog-ok').title,focus:document.activeElement.id,
    selected:document.activeElement&&document.activeElement.id==='sheet-name'?document.activeElement.selectionEnd-document.activeElement.selectionStart:-1})`);
  const at = (sel, dx, dy) => ev(`(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e){return null;}var r=e.getBoundingClientRect();return {x:r.left+${dx === undefined ? 'r.width/2' : dx},y:r.top+${dy === undefined ? 'r.height/2' : dy}};})()`);
  async function rightClick(sel) {
    const p = await at(sel, 30, 12);
    if (!p) { throw new Error('no element ' + sel); }
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'right', clickCount: 1 });
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'right', clickCount: 1 });
    await sleep(60);
  }
  async function hover(sel) {
    const p = await at(sel);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  }
  const ctxNow = () => ev(`(function(){var m=document.querySelector('.ctx:not(.labels)');if(!m){return null;}return {title:(m.querySelector('.title')||{}).textContent,items:Array.from(m.querySelectorAll('button')).map(function(x){return [x.dataset.ctx,x.textContent,x.disabled?x.title:''];})};})()`);
  // The panel asks Premiere on its own when the editor comes to it: what a check counts leaves those out, unless it is
  // about them.
  const own = fn => fn !== 'status' && fn !== 'watch' && fn !== 'target';
  const items = (n, from, place) => clips(n).slice(from || 0).map(it => ({ ...it, bin: place || 'Footage/Day 2' }));
  const focusPanel = () => ev(`window.dispatchEvent(new Event('focus'))`);
  try {
    await b.size(420, 640);
    await b.open();
    await ev(`__disk.clear();SelectApp.setMode('grid')`);

    // -------- the band: a shade lighter than the panel, no line, its icon on the toolbar's first word, one line
    await ev(`__mock.items=${JSON.stringify(items(60))}`);
    await ev(`SelectApp.askTarget()`);
    await b.waitFor(`document.getElementById('foot-verdict').textContent==='Whole project'`, 'whole project');
    const whole = await ev(`(function(){var f=${foot};f.scanTip=document.getElementById('scan').title;f.tip=document.getElementById('foot-words').title;return f;})()`);
    check('A: before a scan with nothing selected: Whole project, its clips, a blue Scan whose tooltip is what it reads, the project in the tooltip', whole.verdict === 'Whole project' && whole.sentence === '60 clips' && whole.actions.join() === 'scan*' && whole.scanTip === 'Whole project \u00b7 60 clips' && whole.tip === 'lantern-spring', whole);
    await ev(`__mock.selection={kind:'clips',items:__mock.items.slice(0,12),places:['Day 2']}`);
    await focusPanel();
    await b.waitFor(`document.getElementById('foot-verdict').textContent==='12 clips selected'`, '12 clips selected', 4000);
    await sleep(200);
    const look = await ev(`(function(){var f=document.getElementById('foot'),cs=getComputedStyle(f),top=document.getElementById('foot-top').getBoundingClientRect(),mark=document.getElementById('foot-mark').getBoundingClientRect(),
      word=document.querySelector('#show .v').getBoundingClientRect(),dot=getComputedStyle(document.getElementById('foot-sentence'),'::before').content,band=getComputedStyle(document.documentElement).getPropertyValue('--band').trim(),scan=document.getElementById('scan').getBoundingClientRect();
      return {sentence:document.getElementById('foot-sentence').textContent,dot:dot,bg:cs.backgroundColor,band:band,radius:cs.borderRadius,shadow:cs.boxShadow,sides:cs.borderLeftStyle+cs.borderTopStyle+cs.borderRightStyle+cs.borderBottomStyle,
        row:Math.round(top.height),height:Math.round(f.getBoundingClientRect().height),mark:mark.left,word:word.left,right:innerWidth-scan.right,margin:cs.marginLeft+cs.marginRight,width:Math.round(f.getBoundingClientRect().width)};})()`);
    check('A: the band is full width, a shade lighter than the panel (from Premiere\'s grey), with no line, no radius and no shadow', look.bg === 'rgb(46, 46, 46)' && look.band === '#2E2E2E' && look.radius === '0px' && look.shadow === 'none' && look.sides === 'nonenonenonenone' && look.margin === '0px0px' && look.width === 420, look);
    check('A: one row is 36 px; the icon\'s ink starts on the toolbar\'s first word, 14 px in, and Scan ends 14 px from the right', look.height === 36 && look.row === 32 && Math.abs(look.mark + 1 - 14) <= 0.5 && Math.abs(look.word - 14) <= 0.5 && Math.abs(look.right - 14) <= 0.5, look);
    check('A: 12 clips selected · Day 2, the place after a dot', look.sentence === 'Day 2' && /\u00b7/.test(look.dot), look);
    // Before any scan the list is as bare as the grid. Read with the colour's transition off: headless Chromium moves a
    // transition on only as it draws frames.
    await ev(`SelectApp.setMode('list')`);
    const bare = await ev(`(function(){var f=document.getElementById('foot'),g=document.getElementById('grid'),h=document.getElementById('head');
      return {rows:SelectApp.state.store.rows.length,head:h.hidden&&!h.offsetHeight,body:document.getElementById('body').offsetWidth,wide:g.scrollWidth-g.clientWidth,tall:g.scrollHeight-g.clientHeight,bar:g.offsetHeight-g.clientHeight,line:getComputedStyle(f).borderBottomStyle,bottom:document.getElementById('bottom').hidden,list:document.getElementById('app').classList.contains('is-list')};})()`);
    await ev(`SelectApp.setMode('grid')`);
    check('A: before a scan the list is as bare as the grid: no column header, no table, no sideways scrollbar, no bar at the bottom, and the band draws no line', bare.rows === 0 && bare.head && bare.body === 0 && bare.wide <= 0 && bare.tall <= 0 && bare.bar === 0 && bare.line === 'none' && bare.bottom && !bare.list, bare);
    await ev(`__mock.selection={kind:'clips',name:'C0167.MP4',items:__mock.items.slice(0,1),places:['Day 2']}`);
    await sleep(1050);
    await focusPanel();
    await b.waitFor(`document.getElementById('foot-verdict').textContent==='1 clip selected'`, 'one clip', 4000);
    const one = await footNow();
    await ev(`__mock.selection={kind:'bins',items:__mock.items.slice(0,40),places:['Day 2']}`);
    await sleep(1050);
    await focusPanel();
    await b.waitFor(`document.getElementById('foot-sentence').textContent==='40 clips'`, 'a bin', 4000);
    const bin = await footNow();
    await ev(`__mock.several=true`);
    await sleep(1050);
    await focusPanel();
    await b.waitFor(`/Project panels/.test(document.getElementById('foot-verdict').textContent)`, 'two panels', 4000);
    const two = await footNow();
    await ev(`__mock.several=false`);
    check('A: one clip, a bin, and two Project panels each read as the table says', one.verdict === '1 clip selected' && one.sentence === 'C0167.MP4' && bin.verdict === 'Day 2' && bin.sentence === '40 clips' && two.verdict === 'Selections in 2 Project panels' && two.actions.join() === '', { one, bin, two });

    // -------- watch: only when the editor comes to the panel, at most once a second, never on a timer
    await sleep(1100);
    await ev(`__mock.calls.length=0`);
    await sleep(2600);
    const idle = (await ev(`__mock.calls.map(function(c){return c.fn;})`)).length;
    await ev(`document.documentElement.dispatchEvent(new MouseEvent('mouseenter'));window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'))`);
    await sleep(300);
    const burst = (await calls('watch')).length;
    await sleep(1000);
    const after = { watch: (await calls('watch')).length, target: (await calls('target')).length, fresh: (await calls('target')).map(a => !!a.fresh) };
    check('A: with the pointer never gone from the panel, watch runs on no timer; a burst of focus, pointer and visibility asks once and once more a second later, and target waits for the selection to change', idle === 0 && burst === 1 && after.watch === 2 && after.target === 1 && after.fresh.join() === 'false', { idle, burst, after });
    await ev(`__mock.calls.length=0`);
    await sleep(1100);
    await focusPanel();
    await sleep(200);
    check('A: with the selection unchanged, target is not asked again', (await calls('watch')).length === 1 && (await calls('target')).length === 0, await ev(`__mock.calls.map(function(c){return c.fn;})`));

    // -------- a scan of the selection, then a new Premiere selection: a grey Scan, and the words stay
    await ev(`__mock.selection={kind:'clips',items:__mock.items.slice(0,12),places:['Day 2']}`);
    await sleep(1100);
    await focusPanel();
    await b.waitFor(`document.getElementById('foot-verdict').textContent==='12 clips selected'`, '12 again', 4000);
    b.engineEnv.FAKE_DELAY_MS = '120';
    await ev(`__mock.calls.length=0`);
    await b.click('#scan');
    await b.waitFor(`SelectApp.state.scan&&SelectApp.state.scan.handle`, 'scan running');
    check('A: a pressed Scan asks for the clips afresh, where a watch may use the host\'s last walk', (await calls('target')).map(a => a.fresh === true && !a.whole).join() === 'true', await calls('target'));
    await ev(`__mock.calls.length=0`);
    await sleep(1100);
    await focusPanel();
    await sleep(150);
    const during = (await calls('watch')).length;
    await b.waitFor(`SelectApp.state.scan.state==='Done'`, 'scan done', 30000);
    await sleep(150);
    check('A: no watch while a scan runs; one waits for its end', during === 0 && (await calls('watch')).length >= 1, { during, afterScan: (await calls('watch')).length });
    b.engineEnv.FAKE_DELAY_MS = '0';
    const scanned = await footNow();
    await ev(`__mock.selection={kind:'clips',items:__mock.items.slice(20,29),places:['Day 3']}`);
    await sleep(1100);
    await focusPanel();
    await b.waitFor(`!document.getElementById('scan').hidden`, 'grey Scan', 4000);
    const moved = await ev(`(function(){var f=${foot};f.scanTip=document.getElementById('scan').title;return f;})()`);
    check('A: after a scan, a selection outside the results opens the band: its clips, where they are, and an outlined Scan whose tooltip says the same; the bar and its blue stay', scanned.mark === '' && moved.open && moved.mark === 'clips' && moved.verdict === '9 other clips selected' && moved.sentence === 'Day 3' && moved.actions.join() === 'scan' && moved.scanTip === '9 other clips selected \u00b7 Day 3' && moved.bar.join() === scanned.bar.join() && scanned.bar.join() === 'do-sequence', { scanned, moved });
    await ev(`__mock.selection={kind:'clips',items:__mock.items.slice(2,6),places:['Day 2']}`);
    await sleep(1100);
    await focusPanel();
    await b.waitFor(`document.getElementById('scan').hidden`, 'Scan gone', 4000).catch(() => {});
    const inside = await footNow();
    check('A: a selection inside the results is no news: the band\'s row goes, the bar stays as it was', inside.mark === '' && inside.actions.join() === '' && inside.bar.join() === 'do-sequence', inside);
    await b.click('#more');
    const menuNow = await ev(`({items:Array.from(document.querySelectorAll('#menu button')).filter(function(x){return !x.hidden;}).map(function(x){return x.textContent;}),whole:document.querySelector('[data-menu="scan-whole"]').title,rescan:document.querySelector('[data-menu="rescan"]').title,folder:document.querySelector('[data-menu="scan-folder"]').title,title:document.getElementById('menu-title').textContent})`);
    check('A: with something selected, ··· holds the project\'s name, Rescan (the same clips), Scan Whole Project (its count) and Scan a Folder…', menuNow.title === 'lantern-spring' && menuNow.items.slice(0, 3).join('|') === 'Rescan|Scan Whole Project|Scan a Folder\u2026' && menuNow.rescan === 'The same 12 clips' && menuNow.whole === '60 clips' && menuNow.folder === 'Not tied to a project' && !menuNow.items.includes('Columns\u2026'), menuNow);
    await ev(`__mock.calls.length=0`);
    await b.click('[data-menu="rescan"]');
    await b.waitFor(`SelectApp.state.scan.state==='Done'&&!SelectApp.state.scan.handle`, 'rescan');
    const rescanned = { rows: await ev(`SelectApp.state.store.rows.length`), asked: (await ev(`__mock.calls.map(function(c){return c.fn;})`)).filter(own) };
    await b.click('#more');
    await b.click('[data-menu="scan-whole"]');
    await b.waitFor(`SelectApp.state.store.rows.length===60&&SelectApp.state.scan.state==='Done'`, 'whole project');
    const wholeCall = (await calls('target')).pop();
    check('A: Rescan reads the same clips without asking Premiere; Scan Whole Project reads every clip whatever is selected, walked afresh', rescanned.rows === 12 && rescanned.asked.length === 0 && wholeCall.whole === true && wholeCall.fresh === true, { rescanned, wholeCall });

    // -------- while the scan looks closer, under 560 px: its count, whole, and Stop; Sequence and Bins at its
    // end. The engine is paused in that stage, so what is read is where the scan is.
    await b.waitFor(`SelectApp.state.scan.state==='Done'&&!SelectApp.state.scan.handle`, 'whole project done');
    b.engineEnv.FAKE_DELAY_MS = '25';
    await b.click('#more');
    await b.click('[data-menu="rescan"]');
    await b.waitFor(`SelectApp.state.scan.handle&&document.getElementById('foot').className==='understanding'&&SelectApp.state.store.tier2>=10`, 'looking closer', 30000);
    const shownActions = `Array.from(document.querySelectorAll('#foot-actions .action, #bottom-actions .action')).filter(function(x){return x.offsetWidth>0;}).map(function(x){return x.id+(x.closest('#bottom')?':'+x.innerText:'');}).join()`;
    const closer = {};
    b.signalEngines('SIGSTOP');
    try {
      closer.narrow = await ev(`(function(){var v=document.getElementById('foot-verdict');return {kind:document.getElementById('foot').className,text:v.textContent,whole:v.scrollWidth<=v.clientWidth,shown:${shownActions},row:Math.round(document.getElementById('foot-top').getBoundingClientRect().height)};})()`);
      await rightClick('#tiles .t[data-at="2"] .pic');
      closer.ctx = await ctxNow();
      await press(b, 'Escape');
      await ev(`SelectApp.state.selected.clear();SelectApp.applyView()`);
      await b.size(900, 640);
      closer.wide = await ev(shownActions);
      await b.size(420, 640);
    } finally {
      b.signalEngines('SIGCONT');
    }
    await b.waitFor(`SelectApp.state.scan.state==='Done'&&!SelectApp.state.scan.handle`, 'rescan done', 30000);
    b.engineEnv.FAKE_DELAY_MS = '0';
    closer.after = await ev(shownActions);
    check('A: under 560 px, while the scan looks closer, the band holds its count, whole, and Stop, on one line; the bar keeps Sequence and Bins in their places, short under 560 px, long when wide, and after the scan',
      closer.narrow.kind === 'understanding' && /^Looking closer \d{2} of \d{2}$/.test(closer.narrow.text) && closer.narrow.whole && closer.narrow.shown === 'stop,do-sequence:Sequence,do-bins:Bins' && closer.narrow.row === 32 && closer.wide === 'stop,do-sequence:Make Sequence,do-bins:Sort into Bins' && closer.after === 'do-sequence:Sequence,do-bins:Bins', closer);
    check('A: meanwhile the right-click menu still offers Label and Make Sequence…', !!closer.ctx && closer.ctx.items.filter(x => (x[0] === 'label' || x[0] === 'sequence') && !x[2]).length === 2, closer.ctx);

    // -------- no browser menu anywhere; text fields keep theirs
    await ev(`window.__ctx=[];window.addEventListener('contextmenu',function(e){__ctx.push({on:e.target.id||e.target.className,prevented:e.defaultPrevented});})`);
    await rightClick('#toolbar');
    await rightClick('#count');
    await ev(`document.getElementById('search-box').classList.add('open')`);
    await rightClick('#search');
    await press(b, 'Escape');
    const menus = await ev(`({log:__ctx,ctx:!!document.querySelector('.ctx')})`);
    check('A: a right-click outside the clips shows no menu at all, and in a text field Chromium keeps its own (Cut, Copy, Paste)', menus.log.length === 3 && menus.log[0].prevented && menus.log[1].prevented && !menus.log[2].prevented && !menus.ctx, menus);
    await ev(`document.getElementById('search').blur();document.getElementById('search-box').classList.remove('open');document.getElementById('toolbar').classList.remove('searching')`);

    // -------- the right-click menu on clips: picks first, the items, Label in two columns
    await ev(`SelectApp.setMode('grid')`);
    await sleep(150);
    await ev(`SelectApp.state.selected.clear();SelectApp.applyView()`);
    await rightClick('#tiles .t[data-at="4"] .pic');
    const lone = { ctx: await ctxNow(), sel: await ev(`Array.from(SelectApp.state.selected).map(function(i){return SelectApp.state.order.indexOf(i);})`), count: await ev(`document.getElementById('count').textContent.replace(/ \u00b7 [\\d,]+ not read$/,'')`) };
    const name4 = await ev(`SelectApp.state.store.rows[SelectApp.state.order[4]].name`);
    check('A: a right-click on a clip not picked picks it alone, the menu (no title since round 5) acts on it, and the bar counts it', lone.sel.join() === '4' && lone.ctx && lone.ctx.title === undefined && !!name4 && /^1 of 60 clips selected$/.test(lone.count), lone);
    check('A: the menu holds Open in Source Monitor, Reveal in Project, Reveal in Finder, Label, Make Sequence…', JSON.stringify(lone.ctx.items.map(x => x[1])) === JSON.stringify(['Open in Source Monitor', 'Reveal in Project', 'Reveal in Finder', 'Label', 'Make Sequence\u2026']) && lone.ctx.items.every(x => !x[2]), lone.ctx);
    await press(b, 'Escape');
    check('A: Escape closes it', !(await ev(`!!document.querySelector('.ctx')`)));
    await b.click('#tiles .t[data-at="1"] .pic');
    await b.click('#tiles .t[data-at="2"] .pic', { meta: true });
    await b.click('#tiles .t[data-at="3"] .pic', { meta: true });
    await rightClick('#tiles .t[data-at="2"] .pic');
    const three = { ctx: await ctxNow(), n: await ev(`SelectApp.state.selected.size`) };
    check('A: a right-click on a picked clip keeps the picks, and the menu acts on them (no title since round 5)', three.n === 3 && three.ctx.title === undefined, three);
    await hover('.ctx [data-ctx="label"]');
    await b.waitFor(`!!document.querySelector('.ctx.labels')`, 'colours', 1500);
    const sub = await ev(`(function(){var s=document.querySelector('.ctx.labels'),r=s.getBoundingClientRect(),bs=Array.from(s.querySelectorAll('button')).map(function(x){var q=x.getBoundingClientRect();return {t:x.textContent,x:Math.round(q.left),y:Math.round(q.top),right:q.right};});
      return {n:bs.length,first:bs.slice(0,8).map(function(x){return x.t;}).join(),second:bs.slice(8).map(function(x){return x.t;}).join(),col1:new Set(bs.slice(0,8).map(function(x){return x.x;})).size,col2:new Set(bs.slice(8).map(function(x){return x.x;})).size,
        down:bs.slice(0,8).every(function(x,i,a){return !i||x.y>a[i-1].y;}),beside:bs[8].x>bs[0].x,left:r.left,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight,cut:bs.some(function(x){return x.right>r.right+1;})};})()`);
    check('A: Label opens its colours a moment after the pointer rests on it: two columns of 8, Premiere\'s order down each, inside a narrow panel', sub.n === 16 && sub.first === 'Violet,Iris,Caribbean,Lavender,Cerulean,Forest,Rose,Mango' && sub.second === 'Purple,Blue,Teal,Magenta,Tan,Green,Brown,Yellow' && sub.col1 === 1 && sub.col2 === 1 && sub.down && sub.beside && sub.left >= 6 && sub.right <= sub.w - 6 && sub.bottom <= sub.h - 6 && !sub.cut, sub);
    await b.shot('a-ctx-label');
    await ev(`__mock.calls.length=0`);
    await b.click('.ctx.labels [data-ctx="color-7"]');
    await b.waitFor(`/^Labelled 3 clips Mango$/.test(document.getElementById('foot-verdict').textContent)&&!SelectApp.state.busy`, 'labelled', 5000);
    await sleep(320);
    const labelled = { modal: await modalOpen(), label: await calls('label'), foot: await footNow(), records: await ev(`Object.keys(__disk.files()).filter(function(k){return /\\/undo\\//.test(k);}).length`), note: await noteText() };
    check('A: a colour labels the picked clips at once: no sheet, the preflight, an Undo record, the read-back and the green all there', !labelled.modal && labelled.label.length === 1 && labelled.label[0].color === 7 && labelled.label[0].items.length === 3 && labelled.foot.green && labelled.records >= 1 && labelled.note === '' && (await calls('status')).length >= 1, labelled);
    await ev(`SelectApp.state.outcome=null;SelectApp.applyView()`);
    // keys: down, right into the colours, left back, Escape
    await rightClick('#tiles .t[data-at="2"] .pic');
    await press(b, 'ArrowDown');
    const firstKey = await ev(`document.activeElement.dataset.ctx`);
    for (let i = 0; i < 3; i++) { await press(b, 'ArrowDown'); }
    const onLabel = await ev(`document.activeElement.dataset.ctx`);
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    const inColours = await ev(`({sub:!!document.querySelector('.ctx.labels'),focus:document.activeElement.dataset.ctx})`);
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    const back = await ev(`({sub:!!document.querySelector('.ctx.labels'),focus:document.activeElement.dataset.ctx})`);
    await press(b, 'Escape');
    const gone = !(await ev(`!!document.querySelector('.ctx')`));
    check('A: keys move through the menu: down, right into the colours, left back to Label, Escape closes', firstKey === 'open' && onLabel === 'label' && inColours.sub && inColours.focus === 'color-0' && !back.sub && back.focus === 'label' && gone, { firstKey, onLabel, inColours, back, gone });
    // Open, Reveal in Project, Reveal in Finder, on the three picked
    const picked = await ev(`SelectApp.state.order.filter(function(i){return SelectApp.state.selected.has(i);}).map(function(i){var r=SelectApp.state.store.rows[i];return [r.ids[0],r.path];})`);
    await ev(`__mock.calls.length=0;__mock.execs.length=0;__mock.missing=[${JSON.stringify(picked[1][1])}]`);
    await rightClick('#tiles .t[data-at="2"] .pic');
    await b.click('.ctx [data-ctx="open"]');
    await b.waitFor(`__mock.calls.filter(function(c){return c.fn==='open';}).length===3`, 'three opens', 4000);
    await sleep(100);
    const opened = (await calls('open')).map(a => a.id), openNote = await noteText();
    await rightClick('#tiles .t[data-at="2"] .pic');
    await b.click('.ctx [data-ctx="reveal"]');
    await b.waitFor(`__mock.calls.some(function(c){return c.fn==='reveal';})`, 'reveal', 4000);
    const revealed = (await calls('reveal'))[0];
    await rightClick('#tiles .t[data-at="2"] .pic');
    await b.click('.ctx [data-ctx="finder"]');
    await b.waitFor(`__mock.execs.length>0`, 'the Finder', 4000);
    await sleep(150);
    const finder = await ev(`__mock.execs[0]`);
    check('A: Open in Source Monitor opens each picked clip by its id, last to first so the first ends in front, and says nothing', opened.join() === picked.map(p => p[0]).reverse().join() && openNote === '', { opened, picked, openNote });
    check('A: Reveal in Project selects the picked clips in the Project panel, by id and path, with no lookup first', JSON.stringify(revealed.items) === JSON.stringify(picked) && revealed.project === PROJECT.path && !(await calls('find')).length, revealed);
    check('A: Reveal in Finder shows the picked files on disk through the engine\'s reveal, every one selected, a missing one left out, and says nothing', /\/bin\/select-engine$/.test(finder.bin) && JSON.stringify(finder.args) === JSON.stringify(['reveal', picked[0][1], picked[2][1]]) && (await ev(`__mock.execs.length`)) === 1 && (await noteText()) === '', finder);
    // An engine that ends badly: open -R on the first, so Reveal never does nothing.
    await ev(`__mock.execs.length=0;__mock.revealFail=true`);
    await rightClick('#tiles .t[data-at="2"] .pic');
    await b.click('.ctx [data-ctx="finder"]');
    await b.waitFor(`__mock.execs.length>1`, 'open -R', 4000);
    await sleep(150);
    const fallback = await ev(`__mock.execs.map(function(x){return [x.bin.split('/').pop()].concat(x.args).join(' ');})`);
    check('A: Reveal in Finder with an engine that fails: open -R on the first, and nothing said', fallback.join('|') === `select-engine reveal ${picked[0][1]} ${picked[2][1]}|open -R ${picked[0][1]}` && (await noteText()) === '', fallback);
    await ev(`__mock.missing=[];__mock.revealFail=false`);
    // more than 50 picked: the Label sheet, on the colour chosen
    await ev(`SelectApp.state.order.slice(0,55).forEach(function(i){SelectApp.state.selected.add(i);});SelectApp.state.paintKey++;SelectApp.applyView()`);
    await rightClick('#tiles .t[data-at="2"] .pic');
    await hover('.ctx [data-ctx="label"]');
    await b.waitFor(`!!document.querySelector('.ctx.labels')`, 'colours', 1500);
    await b.click('.ctx.labels [data-ctx="color-2"]');
    await waitModal();
    const big = await sheet();
    check('A: past 50 clips a colour opens the Label sheet with that colour chosen', /^Label 55 clips\?/.test(big.title) && /Caribbean/.test(big.body) && (await ev(`document.querySelector('#dialog-body [data-color="2"]').classList.contains('on')`)), big);
    await b.click('#dialog-cancel');
    await rightClick('#tiles .t[data-at="2"] .pic');
    const many = await ctxNow();
    await press(b, 'Escape');
    check('A: above 50 clips Reveal in Project is off, its tooltip says why, and the rest stay on', many.title === undefined && many.items.find(x => x[0] === 'reveal')[2] === 'At most 50 clips' && many.items.filter(x => x[0] !== 'reveal').every(x => !x[2]), many);
    await ev(`SelectApp.state.selected.clear();SelectApp.applyView()`);
    // -------- a right-click Label that leaves clips out says so, on one line, and stays: 2 of 5 picked aren't in the project
    const pick = async ats => {
      await ev(`SelectApp.state.selected.clear();SelectApp.state.outcome=null;SelectApp.applyView()`);
      await b.click(`#tiles .t[data-at="${ats[0]}"] .pic`);
      for (const at of ats.slice(1)) { await b.click(`#tiles .t[data-at="${at}"] .pic`, { meta: true }); }
    };
    const dropFromProject = ats => ev(`(function(){var S=SelectApp.state,gone=${JSON.stringify(ats)}.map(function(i){return S.store.rows[S.order[i]].path;});window.__allItems=window.__allItems||__mock.items;__mock.items=__mock.items.filter(function(it){return gone.indexOf(it.path)<0;});return gone.length;})()`);
    const records = () => ev(`Object.keys(__disk.files()).filter(function(k){return /\\/undo\\/.*[.]json$/.test(k);}).length`);
    await pick([1, 2, 3, 4, 5]);
    await dropFromProject([2, 4]);
    await ev(`__mock.calls.length=0;SelectApp.timeouts.settle=300`);
    await labelFromMenu(b, 7);
    await b.waitFor(`SelectApp.state.outcome&&!SelectApp.state.busy`, 'labelled, two left out', 5000);
    await sleep(320);
    const leftOut = { modal: await modalOpen(), sent: (await calls('label')).map(a => a.items.length), foot: await footNow(),
      line: await ev(`(function(){var t=document.getElementById('foot-top'),s=document.getElementById('foot-sentence');return {row:Math.round(t.getBoundingClientRect().height),ws:getComputedStyle(s).whiteSpace,tip:document.getElementById('foot-words').title};})()`) };
    await sleep(900);
    const stillThere = await footNow();
    await b.shot('a-label-left-out');
    check('A: a right-click Label with 2 of 5 picked clips not in the project labels the 3, at once, and the status says the shared line on one line, its whole words in the tooltip',
      !leftOut.modal && leftOut.sent.join() === '3' && leftOut.foot.verdict === 'Labelled 3 clips Mango' && leftOut.foot.sentence === '2 clips aren\'t in this project.' && leftOut.foot.green && leftOut.foot.actions.join() === 'undo-write' &&
      leftOut.line.row === 32 && leftOut.line.ws === 'nowrap' && leftOut.line.tip.indexOf('Labelled 3 clips Mango \u00b7 2 clips aren\'t in this project.') === 0, leftOut);
    check('A: and it stays: something to read doesn\'t go by itself, long after a plain success would have', stillThere.verdict === 'Labelled 3 clips Mango' && stillThere.sentence === '2 clips aren\'t in this project.' && !stillThere.close, stillThere);
    // none of them in the project: refused, nothing written
    await ev(`__mock.items=window.__allItems;SelectApp.timeouts.settle=6000`);
    await pick([6, 7]);
    await dropFromProject([6, 7]);
    const recordsBefore = await records();
    await ev(`__mock.calls.length=0;document.getElementById('status-note').textContent=''`);
    await labelFromMenu(b, 7);
    await b.waitFor(`document.getElementById('status-note').textContent!==''`, 'the refusal', 3000).catch(() => {});
    const refusedAll = { note: await noteText(), modal: await modalOpen(), label: (await calls('label')).length, outcome: await ev(`!!SelectApp.state.outcome`), records: (await records()) - recordsBefore };
    check('A: a right-click Label on clips none of which are in the project is refused before anything is written', refusedAll.note === 'None of these clips are in this project' && !refusedAll.modal && refusedAll.label === 0 && !refusedAll.outcome && refusedAll.records === 0, refusedAll);
    await ev(`__mock.items=window.__allItems;window.__allItems=null;SelectApp.state.selected.clear();SelectApp.state.outcome=null;SelectApp.applyView()`);
    // in the list too, and the menu goes on a scroll
    await ev(`SelectApp.setMode('list')`);
    await sleep(120);
    const listLine = await ev(`(function(){var f=document.getElementById('foot'),h=document.getElementById('head');return {rows:SelectApp.state.store.rows.length,head:!h.hidden&&h.offsetHeight,body:document.getElementById('body').offsetWidth>0,foot:getComputedStyle(f).borderBottomStyle,line:getComputedStyle(h).borderBottomStyle};})()`);
    check('A: with rows, the list has its column header with its own hairline, and the band draws none', listLine.rows > 0 && listLine.head === 24 && listLine.body && listLine.foot === 'none' && listLine.line === 'solid', listLine);
    await rightClick('#body .r[data-at="3"] .c-name');
    const inList = await ctxNow();
    await ev(`document.getElementById('grid').scrollTop=200`);
    await b.waitFor(`!document.querySelector('.ctx')`, 'menu closes on scroll', 2000).catch(() => {});
    check('A: rows in the list have the same menu, and it closes when the clips scroll', inList && inList.items.length === 5 && !(await ev(`!!document.querySelector('.ctx')`)), inList);
    await ev(`document.getElementById('grid').scrollTop=0;SelectApp.setMode('grid')`);

    // -------- Make Sequence
    await ev(`SelectApp.state.selected.clear();SelectApp.state.outcome=null;SelectApp.applyView()`);
    await pickSort(b, 'durationS');
    const today = await ev(`SelectCore.localDate(new Date())`);
    const buttons = await ev(`({seq:document.getElementById('do-sequence').innerText,bins:document.getElementById('do-bins').innerText,tip:document.getElementById('do-sequence').title,binsTip:document.getElementById('do-bins').title,gap:getComputedStyle(document.getElementById('bottom-actions')).columnGap,pad:getComputedStyle(document.getElementById('do-sequence')).paddingLeft})`);
    check('A: under 560 px the bar\'s buttons read Sequence, Bins, 8 px apart, and their tooltips say what they take', buttons.seq === 'Sequence' && buttons.bins === 'Bins' && buttons.tip === 'Selected clips, or every clip shown, in this order' && buttons.binsTip === 'New bins from this view' && buttons.gap === '8px' && buttons.pad === '12px', buttons);
    await b.click('#do-sequence');
    await waitModal();
    const seqSheet = await sheet();
    const first = await ev(`(function(){var r=SelectApp.state.store.rows[SelectApp.state.order[0]];return r.width+'\u00d7'+r.height+', '+Number(r.fps.toFixed(2))+' fps, from the first clip';})()`);
    check('A: the Make Sequence sheet is a title, the name selected in its field, and the buttons; the settings are only in the button\'s tooltip', seqSheet.title === 'Make a sequence of 60 clips?' && seqSheet.field === `SELECT ${today} Longest first` && seqSheet.focus === 'sheet-name' && seqSheet.selected === seqSheet.field.length && seqSheet.body.trim() === '' && seqSheet.ok === 'Make Sequence' && seqSheet.okTip === first, { seqSheet, first });
    await b.shot('a-sequence-sheet');
    await b.send('Input.insertText', { text: 'Pick of the day' });
    await ev(`__mock.calls.length=0;__mock.slow={sequence:400}`);
    await press(b, 'Enter');
    await b.waitFor(`/^Making a sequence of 60 clips$/.test(document.getElementById('foot-verdict').textContent)`, 'making', 3000);
    const making = await footNow();
    await b.waitFor(`/^Made a sequence of 60 clips$/.test(document.getElementById('foot-verdict').textContent)&&!SelectApp.state.busy`, 'made', 5000);
    await ev(`__mock.slow={}`);
    await sleep(320);
    const made = { foot: await footNow(), call: (await calls('sequence'))[0], order: await ev(`SelectApp.state.order.map(function(i){return SelectApp.state.store.rows[i].path;})`) };
    check('A: Enter makes it: one call, every clip on screen in the order shown, the name typed, opened in the Timeline; while Premiere works, the spinner, the count and no Stop, the bar\'s writes off', making.mark === 'spinner' && making.actions.join() === '' && making.bar.join() === '' && (await calls('sequence')).length === 1 && made.call.name === 'Pick of the day' && made.call.open === true && made.call.items.map(p => p[1]).join() === made.order.join(), { making, call: made.call && made.call.name });
    check('A: proved: a green check, the words in ink, an outlined Undo, and no ×', made.foot.green && made.foot.mark === 'check-circle' && made.foot.tone === 'safe' && made.foot.actions.join() === 'undo-write' && !made.foot.close, made.foot);
    await b.shot('a-sequence-made');
    await b.click('#undo-write');
    await waitModal();
    const undoSeq = await sheet();
    check('A: Undo says it removes the sequence, by its name, and nothing else for a write made today; Enter confirms it (the focus is on the blue Undo)', undoSeq.title === 'Undo?' && undoSeq.body.trim() === 'Removes the sequence Pick of the day.' && undoSeq.focus === 'dialog-ok', undoSeq);
    await b.click('#dialog-ok');
    await b.waitFor(`SelectApp.state.outcome&&SelectApp.state.outcome.kind==='undone'&&!SelectApp.state.busy`, 'undone', 5000);
    const undoneSeq = (await calls('restore')).pop();
    check('A: and it removes exactly that sequence', undoneSeq.restore.kind === 'sequence' && undoneSeq.restore.items.length === 1 && undoneSeq.restore.items[0][2] === 'Pick of the day', undoneSeq);
    // Undone at 300 px, as the real-Premiere pass found it: the verdict stays, and every button stays inside the panel.
    await b.size(300, 640);
    await sleep(150);
    const narrowUndone = await ev(`(function(){var W=innerWidth,v=document.getElementById('foot-verdict'),acts=Array.from(document.querySelectorAll('#foot-actions button, #bottom-actions button')).filter(function(x){return !x.hidden&&x.offsetWidth>0;});
      return {kind:document.getElementById('foot').className,verdict:v.textContent,vw:Math.round(v.getBoundingClientRect().width),whole:v.scrollWidth<=v.clientWidth,acts:acts.map(function(x){return x.id;}).join(),
        right:Math.round(Math.max.apply(null,acts.map(function(x){return x.getBoundingClientRect().right;}))),W:W,cut:acts.filter(function(x){return x.scrollWidth>x.clientWidth+1;}).map(function(x){return x.id;}),
        page:document.documentElement.scrollWidth,row:Math.round(document.getElementById('foot-top').getBoundingClientRect().height)};})()`);
    await b.shot('a-undone-300');
    await b.size(420, 640);
    check('A: Undone at 300 px: the verdict stays whole, with no Undo, and the bar\'s Sequence and Bins stay inside the panel, on its margin', narrowUndone.kind === 'undone' && narrowUndone.verdict === 'Undone' && narrowUndone.whole && narrowUndone.vw >= 36 && narrowUndone.acts === 'do-sequence,do-bins' && Math.abs(narrowUndone.right - (narrowUndone.W - 14)) <= 0.5 && !narrowUndone.cut.length && narrowUndone.page <= 300 && narrowUndone.row === 32, narrowUndone);
    // After an Undo the status offers no Undo, so a second click can't take back an older write; ··· › Undo still can.
    await b.click('#more');
    const afterUndo = await ev(`(function(){var m=document.querySelector('#menu [data-menu="undo"]');return {status:document.getElementById('undo-write').hidden,menu:!m.hidden&&!m.disabled,older:m.title};})()`);
    await press(b, 'Escape');
    check('A: after Undo, no Undo on the status, and ··· › Undo still reaches the older write', afterUndo.status && afterUndo.menu && !!afterUndo.older && !/Pick of the day/.test(afterUndo.older), afterUndo);
    // an empty name falls back; clips not in the project are said once; a short V1 is not green
    await ev(`SelectApp.state.outcome=null;SelectApp.applyView();__mock.calls.length=0;__mock.seqShort=1;__mock.items=__mock.items.slice(3)`);
    await b.click('#do-sequence');
    await waitModal();
    const skipped = await sheet();
    await ev(`document.getElementById('sheet-name').value='  '`);
    await b.click('#dialog-ok');
    await b.waitFor(`SelectApp.state.outcome&&!SelectApp.state.busy`, 'made, partly', 5000);
    const partly = { foot: await footNow(), call: (await calls('sequence'))[0] };
    const oneLine = await ev(`(function(){var v=document.getElementById('foot-verdict'),cs=getComputedStyle(v);return {h:Math.round(v.getBoundingClientRect().height),ws:cs.whiteSpace,cut:v.scrollWidth>v.clientWidth,tip:document.getElementById('foot-words').title};})()`);
    check('A: a partial verdict stays on one line, cut like any other, its whole words in the tooltip', oneLine.h <= 18 && oneLine.ws === 'nowrap' && (!oneLine.cut || oneLine.tip.indexOf('56 of 57 clips in the sequence') === 0), oneLine);
    check('A: clips not in the project: the one extra line, and the title counts the rest', skipped.title === 'Make a sequence of 57 clips?' && skipped.body.trim() === '3 clips aren\'t in this project.', skipped);
    check('A: an empty name falls back to the default; a sequence short of a clip says so, with Details and Undo, never green', partly.call.name === `SELECT ${today} Longest first` && partly.foot.verdict === '56 of 57 clips in the sequence' && !partly.foot.green && partly.foot.mark === 'alert' && partly.foot.tone === 'warn' && partly.foot.actions.join() === 'foot-details,undo-write', partly);
    await ev(`__mock.seqShort=0;__mock.items=${JSON.stringify(items(60))};SelectApp.state.outcome=null;SelectApp.applyView()`);
    await ev(`SelectApp.state.order=Array.apply(null,Array(2001)).map(function(){return 0;})`);
    await ev(`document.getElementById('do-sequence').click()`);
    await sleep(80);
    const capped = { note: await noteText(), modal: await modalOpen() };
    await ev(`SelectApp.applyView()`);
    check('A: above 2,000 clips, a note and no sheet', capped.note === 'At most 2,000 clips in a sequence' && !capped.modal, capped);

    // -------- one bin from a search, and Other
    await pickSort(b, null);
    await ev(`localStorage.removeItem('select.binsOther');SelectApp.state.outcome=null;__mock.calls.length=0`);
    await b.click('#search-box');
    await b.send('Input.insertText', { text: 'bread' });
    await b.waitFor(`SelectApp.state.query==='bread'`);
    const found = await ev(`SelectApp.state.order.length`);
    await b.click('#do-bins');
    await waitModal();
    const disc = `(function(){var c=document.querySelector('[data-choice="other"]'),d=getComputedStyle(c,'::before');return d.width+'x'+d.height;})()`;
    const oneBin = await sheet(), choice = await ev(`(function(){var c=document.querySelector('[data-choice="other"]');return c?{on:c.classList.contains('on'),text:c.innerText,tip:c.title}:null;})()`), offDisc = await ev(disc);
    check('A: a search makes one bin, named from the query in its field, with Other off', oneBin.title === `Move ${found} clips into a bin?` && oneBin.field === `SELECT ${today} \u201cbread\u201d` && oneBin.ok === 'Move into Bin' && choice && !choice.on && choice.text.replace(/\s+/g, '') === `Otherbin${60 - found}` && choice.tip === 'The clips this view leaves out', { oneBin, choice });
    await b.shot('a-bin-search');
    await b.click('[data-choice="other"]');
    const otherOn = { sheet: await sheet(), on: await ev(`document.querySelector('[data-choice="other"]').classList.contains('on')`), kept: await ev(`localStorage.getItem('select.binsOther')`), disc: await ev(disc), offDisc };
    check('A: Other on: Sort 60 clips into bins, remembered', otherOn.on && otherOn.sheet.title === 'Sort 60 clips into bins?' && otherOn.sheet.ok === 'Sort into Bins' && otherOn.kept === 'true', otherOn);
    check('A: Other is one control: the ring off, the ring with its tick on, the same 16 px either way', otherOn.disc === '16px x 16px'.replace(/ /g, '') && otherOn.offDisc === otherOn.disc, otherOn);
    await b.shot('a-bin-other');
    await b.click('[data-choice="other"]');
    await b.click('#dialog-ok');
    await b.waitFor(`/^Moved \\d+ clips into a bin$/.test(document.getElementById('foot-verdict').textContent)&&!SelectApp.state.busy`, 'one bin', 5000);
    await sleep(320);
    const single = { bins: (await calls('bins'))[0], check: (await calls('binsCheck'))[0], foot: await footNow() };
    const onScreen = (await calls('find')).map(a => a.paths.length);
    check('A: with Other off, Premiere is asked only for the clips on screen', JSON.stringify(onScreen) === JSON.stringify([found]), { onScreen, found });
    check('A: one bin goes in one call to a single bin named as the field said, read back, green', single.bins.single === true && single.bins.root === `SELECT ${today} \u201cbread\u201d` && single.bins.buckets.length === 1 && single.bins.buckets[0].name === single.bins.root && single.check.single === true && single.foot.green, { single: single.bins.single, root: single.bins.root, n: single.bins.buckets.length, check: single.check, foot: single.foot });
    await ev(`SelectApp.state.outcome=null;SelectApp.applyView();__mock.calls.length=0;localStorage.setItem('select.binsOther','true')`);
    await b.click('#do-bins');
    await waitModal();
    const remembered = await ev(`document.querySelector('[data-choice="other"]').classList.contains('on')`);
    await b.click('#dialog-ok');
    await b.waitFor(`/^Sorted into 2 bins$/.test(document.getElementById('foot-verdict').textContent)&&!SelectApp.state.busy`, 'two bins', 5000);
    const withOther = (await calls('bins')).flatMap(a => a.buckets.map(x => x.name + ':' + x.items.length)), otherFinds = (await calls('find')).map(a => a.paths.length);
    check('A: with Other on, the clips the view leaves out are looked up once OK is pressed', JSON.stringify(otherFinds) === JSON.stringify([found, 60 - found]), otherFinds);
    check('A: Other comes back on as it was left, and makes the last bin, 02 Other, of the clips the view leaves out', remembered && withOther.join() === `01 \u201cbread\u201d:${found},02 Other:${60 - found}`, withOther);
    await ev(`localStorage.removeItem('select.binsOther');SelectApp.state.outcome=null;document.getElementById('search').value='';document.getElementById('search').dispatchEvent(new Event('input'))`);
    await ev(`SelectApp.state.selected.clear();[0,1].forEach(function(i){SelectApp.state.selected.add(SelectApp.state.order[i]);});SelectApp.applyView()`);
    await b.click('#do-bins');
    await waitModal();
    const picks = { sheet: await sheet(), other: await ev(`!!document.querySelector('[data-choice]')`) };
    await b.click('#dialog-cancel');
    check('A: picked clips make one bin named Selects, with no Other', picks.sheet.title === 'Move 2 clips into a bin?' && picks.sheet.field === `SELECT ${today} Selects` && !picks.other, picks);
    await ev(`SelectApp.state.selected.clear();SelectApp.applyView()`);

    // -------- last results on reopen, from the cache only
    await ev(`__mock.selection=null;__mock.items=${JSON.stringify(items(60).map((it, i) => (i < 5 ? { ...it, path: it.path.replace(/\.MP4$/i, '.uncached.MP4') } : it)))}`);
    await scanAndWait(b);
    await pickSort(b, 'sharpness');
    await sleep(1300);
    const saved = await ev(`(function(){var k=Object.keys(__disk.files()).filter(function(x){return /\\/last\\/[0-9a-f]{16}\\.json$/.test(x);});return k.length===1?JSON.parse(__disk.files()[k[0]]):null;})()`);
    check('A: the last results are saved per project with each clip\'s bins and the view, and no search', saved && saved.project === PROJECT.path && saved.paths.length === 60 && saved.binPaths.every(x => JSON.stringify(x) === '["Footage/Day 2"]') && saved.view.sort[0].key === 'sharpness' && !('query' in saved), saved && { project: saved.project, n: saved.paths.length, view: saved.view });
    const spawned = b.engineLog.spawned, lastItems = await ev(`JSON.stringify(__mock.items)`);
    await b.open();
    await ev(`__mock.items=${lastItems}`);
    await b.waitFor(`SelectApp.state.restoring||SelectApp.state.store.rows.length===60`, 'last results', 5000);
    await b.waitFor(`!SelectApp.state.restoring&&SelectApp.state.store.rows.length===60`, 'last results back', 10000);
    await sleep(120);
    const restored = { args: b.engineLog.lastArgs, spawned: b.engineLog.spawned - spawned, view: await ev(`SelectApp.state.view`), foot: await ev(`(function(){var f=${foot};f.tip=document.getElementById('foot-words').title;f.scanTip=document.getElementById('scan').title;f.countTip=document.getElementById('count').title;return f;})()`),
      bins: await ev(`SelectApp.state.store.rows.every(function(r){return JSON.stringify(r.binPaths)==='["Footage/Day 2"]';})`), notRead: await ev(`SelectApp.state.store.rows.filter(function(r){return r.notRead;}).length`) };
    check('A: reopened, the panel reads the last results from the cache only (--cached-only), with the saved view and bins', restored.spawned === 1 && restored.args.includes('--cached-only') && restored.view.sort[0].key === 'sharpness' && restored.bins, restored);
    check('A: when they were scanned is in the count\'s tooltip only; clips the cache lacks open the band, 5 not read, and an outlined Scan reads them; the bar keeps its writes', /^(.+\n)*60 clips \u00b7 \d+ not read\nScanned today at \d\d:\d\d$/.test(restored.foot.countTip) && restored.foot.count === '60 clips' && /^\d+ not read$/.test(restored.foot.notRead) && restored.foot.verdict === '5 not read' && restored.foot.mark === 'info' && restored.foot.actions.join() === 'scan' && restored.foot.bar.join() === 'do-sequence,do-bins*' && restored.foot.scanTip === 'The same 60 clips' && restored.notRead === 5, restored.foot);
    await ev(`SelectApp.setMode('list')`);
    await ev(`(function(){var S=SelectApp.state,i=S.order.findIndex(function(at){return S.store.rows[at].notRead;});document.getElementById('grid').scrollTop=Math.max(0,i*40-80);})()`);
    await b.waitFor(`Array.from(document.querySelectorAll('#body .r.two')).some(function(x){return x.style.display!=='none'&&/uncached/.test(x.querySelector('.n').textContent);})`, 'a row not read', 3000).catch(() => {});
    const why = await ev(`(function(){var r=Array.from(document.querySelectorAll('#body .r.two')).filter(function(x){return x.style.display!=='none'&&/uncached/.test(x.querySelector('.n').textContent);})[0];return r?r.querySelector('.why').textContent:null;})()`);
    await ev(`document.getElementById('grid').scrollTop=0`);
    check('A: a clip not read says so under its name', why === 'Not read', why);
    await pickSort(b, 'luma');
    check('A: the tooltip\'s "Scanned" goes once the view changes', !/Scanned/.test(await ev(`document.getElementById('count').title`)) && /(^|\n)60 clips/.test(await ev(`document.getElementById('count').title`)));
    // 0.3's promise holds for last results too: a scan that read a bin wrote to the clips it found there, and a second
    // copy of a file elsewhere in the project stays put, whatever ids Premiere has given them since.
    const dayTwo = await ev(`JSON.stringify(__mock.items)`);
    await ev(`(function(){var it=__mock.items[6];__mock.selection={kind:'bins',items:__mock.items.slice(),places:['Day 2']};__mock.items=__mock.items.concat([{id:'dup6',path:it.path,name:it.name,bin:'Selects'}]);})()`);
    await b.evalIn(`SelectApp.startScan()`);
    await b.waitFor(`SelectApp.state.scan.state==='Done'&&!SelectApp.state.scan.handle&&SelectApp.state.scan.source==='selection'`, 'a scan of Day 2', 10000);
    await sleep(1300);
    const dupItems = await ev(`JSON.stringify(__mock.items.map(function(it){return it.id==='dup6'?it:{id:'re'+it.id,path:it.path,name:it.name,bin:it.bin};}))`);
    await b.open();
    await ev(`__mock.items=${dupItems}`);
    await b.waitFor(`!SelectApp.state.restoring&&SelectApp.state.store.rows.length===60`, 'Day 2 back', 10000);
    const labelOne = async () => {
      await ev(`(function(){var S=SelectApp.state,p=__mock.items.filter(function(it){return it.id==='dup6';})[0].path;S.selected.clear();S.selected.add(S.store.byKey.get(p).rowId);S.outcome=null;SelectApp.applyView();__mock.calls.length=0;})()`);
      await labelFromMenu(b);
      await b.waitFor(`__mock.calls.some(function(c){return c.fn==='label';})&&!SelectApp.state.busy`, 'a label', 5000);
      return (await calls('label'))[0].items.map(x => x[0]);
    };
    const restoredWrite = await labelOne();
    await b.click('#more');
    await b.click('[data-menu="rescan"]');
    await b.waitFor(`SelectApp.state.scan.state==='Done'&&!SelectApp.state.scan.handle`, 'rescan of last results', 10000);
    const rescannedWrite = await labelOne();
    check('A: last results of a bin, back after a reopen with new ids and Rescanned, write to the copy in that bin only: a second copy elsewhere stays put', JSON.stringify(restoredWrite) === '["reid6"]' && JSON.stringify(rescannedWrite) === '["reid6"]', { restoredWrite, rescannedWrite });
    await ev(`__mock.selection=null;__mock.items=${dayTwo};SelectApp.state.outcome=null;SelectApp.state.selected.clear();SelectApp.applyView()`);
    await scanAndWait(b);
    if ((await ev(`document.querySelector('#sort .v').textContent`)) !== 'Brightest first') { await pickSort(b, 'luma'); }
    await sleep(1300);
    // Another project comes to the front, and the watch that would say so is held back: the panel still believes
    // lantern-spring is in front. Open, Open of several and Reveal in Project ask Premiere which project is in front,
    // then refuse, before any open, import or reveal reaches it.
    await ev(`__mock.slow={watch:3000};__mock.project={path:'/Volumes/Field SSD/Projects/testt2.prproj',name:'testt2.prproj'}`);
    await sleep(1100);
    await focusPanel();
    const raced = [];
    for (const how of ['open', 'open several', 'reveal']) {
      await ev(`SelectApp.state.project=${JSON.stringify(PROJECT)};SelectApp.state.selected.clear();SelectApp.applyView();__mock.calls.length=0;document.getElementById('status-note').textContent=''`);
      if (how === 'open') {
        await b.click('#body .r[data-at="1"] .c-name', { count: 2 });
      } else {
        await ev(`[1,2,3].forEach(function(i){SelectApp.state.selected.add(SelectApp.state.order[i]);});SelectApp.state.paintKey++;SelectApp.applyView()`);
        await rightClick('#body .r[data-at="2"] .c-name');
        await b.click(how === 'reveal' ? '.ctx [data-ctx="reveal"]' : '.ctx [data-ctx="open"]');
      }
      await b.waitFor(`document.getElementById('status-note').textContent!==''`, 'the refusal', 3000).catch(() => {});
      raced.push({ how, note: await noteText(), asked: (await ev(`__mock.calls.map(function(c){return c.fn;})`)).filter(own), modal: await modalOpen() });
    }
    await ev(`__mock.slow={};SelectApp.state.selected.clear();SelectApp.applyView()`);
    check('A: with another project in front and the watch that says so still on its way, Open, Open of several and Reveal in Project refuse once Premiere says which project is in front, and nothing reaches it', raced.every(r => r.note === 'From lantern-spring' && !r.asked.length && !r.modal), raced);
    // another project in front, with no record: the tie
    await ev(`__mock.project={path:'/Volumes/Field SSD/Projects/testt2.prproj',name:'testt2.prproj'}`);
    await sleep(1100);
    await focusPanel();
    await b.waitFor(`/^From /.test(document.getElementById('foot-verdict').textContent)`, 'from', 4000);
    await sleep(200);
    const tied = await ev(`(function(){var f=${foot},t=SelectApp.state.target;f.scanTip=document.getElementById('scan').title;f.target=t&&{kind:t.kind,n:t.items.length,project:t.project&&t.project.name};f.project=SelectApp.state.project&&SelectApp.state.project.name;f.calling=SelectApp.state.calling;return f;})()`);
    // The refusals just above left their note, which holds the band's row, with the blue Scan of the row it outranks.
    check('A: results from another project say From it, with a blue Scan only, its tooltip what it would read here; the bar\'s writes are off', /^From lantern-spring\.?$/.test(tied.verdict) && tied.actions.join() === 'scan*' && tied.scanTip === 'testt2 \u00b7 Whole project \u00b7 60 clips' && tied.bar.join() === '', tied);
    await b.shot('a-from-other');
    await rightClick('#body .r[data-at="1"] .c-name');
    const tiedMenu = await ctxNow();
    await press(b, 'Escape');
    await ev(`SelectApp.state.selected.clear();SelectApp.applyView()`);
    check('A: in the right-click menu only Reveal in Finder works for them; the rest say From lantern-spring', tiedMenu.items.filter(x => x[2] === 'From lantern-spring').map(x => x[0]).join() === 'open,reveal,label,sequence' && tiedMenu.items.find(x => x[0] === 'finder')[2] === '', tiedMenu);
    // Forced: the right-click Label turned on, and a colour pressed.
    await rightClick('#body .r[data-at="1"] .c-name');
    await ev(`__mock.calls.length=0;document.querySelector('.ctx [data-ctx="label"]').disabled=false`);
    await b.click('.ctx [data-ctx="label"]');
    await b.waitFor(`!!document.querySelector('.ctx.labels')`, 'colours', 1500);
    await b.click('.ctx.labels [data-ctx="color-7"]');
    await sleep(200);
    check('A: even forced, a write in another project is refused before any sheet', !(await modalOpen()) && (await noteText()) === 'From lantern-spring' && !(await calls('label')).length && !(await calls('find')).length, await noteText());
    await ev(`SelectApp.state.selected.clear();SelectApp.applyView()`);
    // back in its own project, then a scan there, and the first project's record comes back when it is in front again
    await ev(`__mock.project=${JSON.stringify(PROJECT)}`);
    await sleep(1100);
    await focusPanel();
    await b.waitFor(`document.querySelector('#sort .v').textContent==='Brightest first'&&SelectApp.foot().kind==='finished'`, 'back home', 4000).catch(async () => { throw new Error('back home: ' + JSON.stringify(await ev(`(function(){var f=${foot};f.sortWords=document.querySelector('#sort .v').textContent;f.view=SelectApp.state.view;f.project=SelectApp.state.project&&SelectApp.state.project.name;f.calling=SelectApp.state.calling;f.late=SelectApp.state.hostLate;f.log=SelectApp.state.hostLog.slice(-6);return f;})()`))); });
    await ev(`__mock.project={path:'/Volumes/Field SSD/Projects/testt2.prproj',name:'testt2.prproj'};__mock.items=${JSON.stringify(items(20))}`);
    await sleep(1100);
    await focusPanel();
    await b.waitFor(`/^From /.test(document.getElementById('foot-verdict').textContent)`, 'from again', 4000);
    await scanAndWait(b);
    await ev(`__mock.project=${JSON.stringify(PROJECT)}`);
    await sleep(1100);
    await focusPanel();
    await b.waitFor(`SelectApp.state.store.rows.length===60&&!SelectApp.state.restoring`, 'lantern-spring\'s last results', 8000);
    check('A: with another project\'s results on screen, the project in front brings its own last results back', (await ev(`SelectApp.state.view.sort[0].key`)) === 'luma' && /^From /.test(await ev(`document.getElementById('foot-verdict').textContent`)) === false, await footNow());
    // Last results that take too long: Stop while they come back, and a deadline. Both end as a failed restore does.
    b.engineEnv.FAKE_DELAY_MS = '150';
    await ev(`__mock.project={path:'/Volumes/Field SSD/Projects/testt2.prproj',name:'testt2.prproj'};__mock.items=${JSON.stringify(items(20))}`);
    await sleep(1100);
    await focusPanel();
    await b.waitFor(`SelectApp.state.restoring`, 'testt2\'s last results coming back', 4000);
    const coming = await footNow(), exits = b.engineLog.exited.length;
    await b.click('#stop');
    await b.waitFor(`!SelectApp.state.restoring`, 'stopped', 2000);
    await b.waitFor(`document.getElementById('foot-verdict').textContent==='Whole project'`, 'the target again', 3000).catch(() => {});
    const stopped = { foot: await footNow(), rows: await ev(`SelectApp.state.store.rows.length`) };
    await sleep(400);
    check('A: while last results come back the status offers Stop, and Stop ends them at once: the engine goes, and the target shows', coming.verdict === 'Last results' && coming.actions.join() === 'stop' && stopped.rows === 0 && stopped.foot.verdict === 'Whole project' && stopped.foot.actions.join() === 'scan*' && b.engineLog.exited.length > exits, { coming, stopped });
    await ev(`SelectApp.timeouts.lastResults=700;__mock.project=${JSON.stringify(PROJECT)};__mock.items=${dayTwo}`);
    await sleep(1100);
    await focusPanel();
    await b.waitFor(`SelectApp.state.restoring`, 'lantern-spring\'s last results coming back', 4000);
    const t0 = Date.now();
    await b.waitFor(`!SelectApp.state.restoring`, 'the deadline', 4000);
    const late = { ms: Date.now() - t0, foot: await footNow(), rows: await ev(`SelectApp.state.store.rows.length`) };
    check('A: last results past their deadline end as a failed restore: nothing kept, the target shows, nothing blocked', late.ms < 2500 && late.rows === 0 && late.foot.verdict === 'Whole project' && late.foot.actions.join() === 'scan*', late);
    await ev(`SelectApp.timeouts.lastResults=20000`);
    b.engineEnv.FAKE_DELAY_MS = '0';
    await sleep(300);
    // a folder's scan leaves no record
    const before = await ev(`Object.keys(__disk.files()).filter(function(x){return /\\/last\\/[0-9a-f]{16}\\.json$/.test(x);}).length`);
    await ev(`__mock.folderFiles=['A1.MP4','B2.MP4'];__mock.pickedFolder='/Volumes/Field SSD/folder'`);
    await b.click('#more');
    await b.click('[data-menu="scan-folder"]');
    await b.waitFor(`SelectApp.state.store.rows.length===2&&SelectApp.state.scan.state==='Done'`, 'folder', 5000);
    await sleep(1300);
    const afterFolder = await ev(`(function(){var k=Object.keys(__disk.files()).filter(function(x){return /\\/last\\/[0-9a-f]{16}\\.json$/.test(x);});return {n:k.length,lantern:k.map(function(x){return JSON.parse(__disk.files()[x]).paths.length;})};})()`);
    check('A: a folder scan leaves the project\'s record as it was', afterFolder.n === before && afterFolder.lantern.indexOf(2) === -1, { before, afterFolder });

    // -------- a scan asked for as an installed update restarts the page: the new page runs that same scan. The stand-in
    // for update.js's catch stops a press of Scan or Rescan, as update.js does once it has installed; the page then
    // reloads, and the new one calls startScan() with nothing, as update.js does after its restart.
    const hook = `document.addEventListener('click',function(e){var t=e.target&&e.target.closest&&e.target.closest('#scan, #menu [data-menu="rescan"]');if(!t||t.disabled){return;}e.stopPropagation();e.preventDefault();document.getElementById('menu').hidden=true;window.__caught=t.id||t.getAttribute('data-menu');},true)`;
    const intent = () => ev(`(function(){var v=localStorage.getItem('select.scanIntent');return v?JSON.parse(v).scan:null;})()`);
    // Scan Whole Project shows only while the Project panel has a selection.
    const selectSome = async () => {
      await ev(`__mock.selection={kind:'clips',items:__mock.items.slice(0,5),places:['Day 2']}`);
      await ev(`SelectApp.askTarget()`);
      await b.waitFor(`SelectApp.state.target&&SelectApp.state.target.kind==='clips'`, 'a selection', 3000);
    };
    const restartFrom = async (item, setup) => {
      if (item === 'scan-whole') { await selectSome(); }
      await ev(`window.__caught=null;${hook}`);
      await ev(`__mock.calls.length=0`);
      await b.click('#more');
      const menu = await ev(`Array.from(document.querySelectorAll('#menu button')).filter(function(x){return !x.hidden;}).map(function(x){return x.dataset.menu+(x.disabled?'(off)':'');}).join()`);
      await b.click(`[data-menu="${item}"]`);
      await sleep(80);
      const asked = { caught: await ev(`window.__caught`), kind: await intent(), scans: (await calls('target')).filter(a => a.fresh).length, menu };
      const spawned = b.engineLog.spawned;
      await b.open();
      await ev(`__mock.items=${dayTwo};${setup || ''}__mock.calls.length=0`);
      await ev(`SelectApp.startScan()`);
      return { asked, spawned };
    };
    await ev(`__mock.selection=null;__mock.items=${dayTwo};__mock.project=${JSON.stringify(PROJECT)}`);
    await scanAndWait(b);
    const wholeRun = await restartFrom('scan-whole');
    await b.waitFor(`__mock.calls.some(function(c){return c.fn==='target'&&c.args.whole;})&&!SelectApp.state.listing&&!SelectApp.state.restoring&&SelectApp.state.scan&&!SelectApp.state.scan.cachedOnly&&SelectApp.state.scan.state==='Done'&&!SelectApp.state.scan.handle`, 'the whole project after the restart', 10000).catch(async e => { throw new Error(e.message + ' ' + JSON.stringify(await ev(`({wholeRun:${JSON.stringify(JSON.stringify(wholeRun))},restoring:SelectApp.state.restoring,scan:SelectApp.state.scan&&{state:SelectApp.state.scan.state,h:!!SelectApp.state.scan.handle},rows:SelectApp.state.store.rows.length,intent:localStorage.getItem('select.scanIntent'),calls:__mock.calls.map(function(c){return c.fn+(c.args&&c.args.whole?':whole':'');}),log:SelectApp.state.hostLog.map(function(x){return x.fn;})})`))); });
    const rescanRun = await restartFrom('rescan');
    await b.waitFor(`!SelectApp.state.restoring&&SelectApp.state.scan&&SelectApp.state.scan.state==='Done'&&!SelectApp.state.scan.handle&&!SelectApp.state.scan.cachedOnly`, 'the same clips after the restart', 10000).catch(async e => { throw new Error(e.message + ' ' + JSON.stringify(await ev(`({run:${JSON.stringify(JSON.stringify(rescanRun))},restoring:SelectApp.state.restoring,scan:SelectApp.state.scan&&{state:SelectApp.state.scan.state,h:!!SelectApp.state.scan.handle,c:SelectApp.state.scan.cachedOnly},rows:SelectApp.state.store.rows.length,intent:localStorage.getItem('select.scanIntent'),calls:__mock.calls.map(function(c){return c.fn;}),foot:SelectApp.foot().verdict})`))); });
    const rescanAfter = { spawned: b.engineLog.spawned - rescanRun.spawned, args: b.engineLog.lastArgs, fresh: (await calls('target')).filter(a => a.fresh).length, rows: await ev(`SelectApp.state.store.rows.length`), left: await intent() };
    const folderRun = await restartFrom('scan-folder', `__mock.folderFiles=['A1.MP4','B2.MP4'];__mock.pickedFolder='/Volumes/Field SSD/folder';__mock.execs.length=0;`);
    await b.waitFor(`SelectApp.state.store.rows.length===2&&SelectApp.state.scan&&SelectApp.state.scan.state==='Done'`, 'the folder after the restart', 10000);
    const folderAfter = await ev(`__mock.execs.map(function(x){return x.bin;})`);
    check('A: Scan Whole Project goes through Scan, so an installed update\'s restart catches it, and the new page scans the whole project', wholeRun.asked.caught === 'scan' && wholeRun.asked.kind === 'whole' && wholeRun.asked.scans === 0, wholeRun);
    check('A: Rescan caught by the restart: the new page waits for the last results, then reads those same clips, not what is selected', rescanRun.asked.caught === 'rescan' && rescanRun.asked.kind === 'same' && rescanAfter.spawned === 2 && !rescanAfter.args.includes('--cached-only') && rescanAfter.fresh === 0 && rescanAfter.rows === 60 && rescanAfter.left === null, { rescanRun, rescanAfter });
    check('A: Scan a Folder… caught by the restart: the new page opens the folder dialog and scans the folder', folderRun.asked.caught === 'scan' && folderRun.asked.kind === 'folder' && folderAfter.join() === '/usr/bin/osascript', { folderRun, folderAfter });
    await ev(`__mock.selection=null;__mock.items=${dayTwo};__mock.folderFiles=[]`);
    await selectSome();
    await b.click('#more');
    await b.click('[data-menu="scan-whole"]');
    await b.waitFor(`SelectApp.state.scan&&SelectApp.state.scan.state==='Done'&&!SelectApp.state.scan.handle&&SelectApp.state.store.rows.length===60`, 'whole project here', 10000);
    check('A: with no restart waiting, Scan Whole Project scans here, and no note of it is left behind', (await intent()) === null && (await calls('target')).some(a => a.whole && a.fresh), await intent());
    await ev(`__mock.selection=null`);

    // -------- the text cut: About, no note after a write that worked, and the green on Premiere's light grey
    await b.click('#more');
    await b.click('[data-menu="about"]');
    await waitModal();
    const about = await sheet();
    await b.click('#dialog-ok');
    check('A: About is the version and one line', /^Version /.test(about.body.trim()) && about.body.trim().split('\n').filter(Boolean).length === 2 && /Everything runs on this Mac\. Once a day Select asks GitHub for a new version\.$/.test(about.body.trim()), about.body);
    await ev(`__mock.skin={red:230,green:230,blue:230};__mock.listeners['com.adobe.csxs.events.ThemeColorChanged'].forEach(function(f){f();})`);
    await ev(`__mock.items=${JSON.stringify(items(60))};SelectApp.state.selected.clear();SelectApp.state.outcome=null`);
    await scanAndWait(b);
    await pickSort(b, 'durationS');
    await b.click('#do-sequence');
    await waitModal();
    await press(b, 'Enter');
    await b.waitFor(`/^Made a sequence/.test(document.getElementById('foot-verdict').textContent)&&!SelectApp.state.busy`, 'made, light', 5000);
    await sleep(320);
    const light = await ev(`(function(){var f=${foot},ink=getComputedStyle(document.documentElement).getPropertyValue('--safe-ink').trim(),ground=getComputedStyle(document.getElementById('foot')).backgroundColor;f.ink=ink;f.ground=ground;f.note=document.getElementById('status-note').textContent;return f;})()`);
    const hex = c => '#' + c.match(/\d+/g).slice(0, 3).map(v => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase();
    const ratio = H.contrast(light.ink.toUpperCase(), hex(light.ground));
    check('A: on Premiere\'s light grey the green check reads at 4.5:1 or more on the band, the words in ink, and a write that worked says nothing more', light.green && ratio >= 4.5 && light.ground === 'rgb(218, 218, 218)' && light.note === '' && light.sentence === '', { light, ratio: ratio.toFixed(2) });
    await b.shot('a-light-made');
    const states = Array.from(footSeen.values()), kinds = Array.from(new Set(states.map(s => s.kind))).sort();
    check('A: no state of the status shows a Label button, from before a scan, through reading, looking closer and writing, to after a write', states.length > 10 && ['target', 'scanning', 'understanding', 'finished', 'writing', 'proved'].every(k => kinds.includes(k)) && !states.some(s => s.label || /Label/.test(s.buttons)), { kinds, n: states.length, label: states.filter(s => s.label || /Label/.test(s.buttons)) });
    check('A: no script errors', b.problems.length === 0, b.problems.slice(0, 5));
  } catch (e) {
    check('A: harness-a ran to the end', false, e.stack);
    await b.shot('zz-a-failure').catch(() => {});
  }
  await b.close();
}

module.exports = { run };
