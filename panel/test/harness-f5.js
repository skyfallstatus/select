// The fifth round of feedback on 0.4, in the real page: drag select over the clips (grid and list, replace, add and turn
// around, the edges scrolling, Escape, 1,000 clips), the right-click menu with no title, a selected clip's name keeping
// its weight, every row of the band's life, and Show, Sort and ··· whole on their first frame. Run by harness.js, in
// its own browser.
'use strict';

const FRAME = `new Promise(function(r){requestAnimationFrame(function(){var c=new MessageChannel();c.port1.onmessage=function(){r(true);};c.port2.postMessage(0);});})`;
// The picks as places on screen, in view order.
const PICKED = `Array.from(SelectApp.state.selected).map(function(i){return SelectApp.state.order.indexOf(i);}).sort(function(a,b){return a-b;})`;
// Each frame from now: the menu's state, the button's plate and words, the focus. Stopped by window.__fOn=false.
const FRAMES = (button, menu) => `window.__f=[];window.__fOn=true;(function f(){var m=document.getElementById(${JSON.stringify(menu)}),r=m.getBoundingClientRect(),b=document.getElementById(${JSON.stringify(button)}),v=b.querySelector('.v'),a=document.activeElement;
  __f.push({hidden:m.hidden,op:getComputedStyle(m).opacity,anims:m.getAnimations().length,r:[r.left,r.top,r.width,r.height].join(),plate:getComputedStyle(b).backgroundColor,weight:v?getComputedStyle(v).fontWeight:'',width:b.getBoundingClientRect().width,ring:!!a&&a.matches(':focus-visible')});
  if(window.__fOn){requestAnimationFrame(f);}})()`;

async function run(check) {
  const H = require('./harness.js');
  const { launch, sleep, clips, foot, PROJECT, rightClick, press } = H;
  const { ensureThumbs } = require('./build_fixture.js');
  const b = await launch();
  b.engineEnv.FAKE_THUMBS = ensureThumbs();
  b.engineEnv.FAKE_DELAY_MS = '0';
  const ev = e => b.evalIn(e);
  const P = b.send;
  const frames = async n => { for (let i = 0; i < (n || 3); i++) { await ev(FRAME); } };
  const footNow = async () => { await frames(15); return ev(foot); };
  // A real press, moves with the button held, and a release, with Shift (8) or Cmd (4).
  const mods = o => (o && o.shift ? 8 : 0) | (o && o.meta ? 4 : 0);
  const down = async (x, y, o) => { await P('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: mods(o) }); await P('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, modifiers: mods(o) }); };
  const move = async (x, y, o, steps) => {
    const from = await ev(`window.__at||null`);
    const n = steps || 6;
    for (let i = 1; i <= n; i++) {
      const px = from ? from[0] + (x - from[0]) * i / n : x, py = from ? from[1] + (y - from[1]) * i / n : y;
      await P('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'left', buttons: 1, modifiers: mods(o) });
      await ev(FRAME);
    }
    await ev(`window.__at=[${x},${y}]`);
  };
  const up = async (x, y, o) => { await P('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, modifiers: mods(o) }); await ev(`window.__at=null`); await frames(2); };
  const drag = async (a, z, o) => { await down(a[0], a[1], o); await ev(`window.__at=[${a[0]},${a[1]}]`); await move(z[0], z[1], o); };
  const clickAt = async (p, o) => { await down(p[0], p[1], o); await up(p[0], p[1], o); };
  // A point in a tile, or a list row's name, by its place on screen: dx, dy from its top left.
  const tile = (at, dx, dy) => ev(`(function(){var t=document.querySelector('#tiles .t[data-at="${at}"]');if(!t||t.style.display==='none'){return null;}var r=t.getBoundingClientRect();return [r.left+${dx === undefined ? 20 : dx},r.top+${dy === undefined ? 20 : dy}];})()`);
  const row = (at, dx) => ev(`(function(){var t=document.querySelector('#body .r[data-at="${at}"]');if(!t||t.style.display==='none'){return null;}var r=t.getBoundingClientRect();return [r.left+${dx === undefined ? 90 : dx},r.top+20];})()`);
  // The tiles drawn on screen that a client rectangle touches: what the page's own hits must match.
  const drawnHits = (x0, y0, x1, y1) => ev(`Array.from(document.querySelectorAll('#tiles .t')).filter(function(t){if(t.style.display==='none'){return false;}var r=t.getBoundingClientRect();return r.left<=${Math.max(x0, x1)}&&r.right>=${Math.min(x0, x1)}&&r.top<=${Math.max(y0, y1)}&&r.bottom>=${Math.min(y0, y1)};}).map(function(t){return Number(t.dataset.at);}).sort(function(a,b){return a-b;})`);
  const mq = () => ev(`(function(){var m=document.getElementById('marquee'),s=m&&getComputedStyle(m);return {on:SelectApp.marquee().on,last:SelectApp.marquee().last,el:!!m,cls:document.getElementById('grid').classList.contains('marqueeing'),
    pos:m?m.style.backgroundPosition:'',size:m?m.style.backgroundSize:'',image:m?m.style.backgroundImage:'',box:m?[m.offsetLeft,m.offsetTop,m.offsetWidth,m.offsetHeight].join():'',z:s?s.zIndex:'',pe:s?s.pointerEvents:''};})()`);
  const metric = async name => (await P('Performance.getMetrics')).metrics.find(m => m.name === name).value;
  const items = (n, from, bin) => clips(n + (from || 0)).slice(from || 0).map(it => ({ ...it, bin: bin || 'Footage/DAY 2' }));
  try {
    // ======== drag select in the grid, over 1,000 clips
    await b.size(760, 640);
    await b.open();
    await P('Performance.enable');
    await ev(`__disk.clear();SelectApp.setMode('grid');SelectApp.timeouts.settle=1e9`);
    await ev(`__mock.items=${JSON.stringify(clips(1000))};__mock.selection=null;SelectApp.askTarget()`);
    await b.waitFor(`document.getElementById('foot-verdict').textContent==='Whole project'`, 'the whole project', 5000);
    await H.scanAndWait(b);
    await sleep(400);
    await frames(10);
    const cols = await ev(`SelectApp.state.L.cols`);

    // A press that moves less than 4 px is a click.
    const t5 = await tile(5);
    await down(t5[0], t5[1]);
    await move(t5[0] + 3, t5[1] + 2, null, 2);
    const still = await mq();
    await up(t5[0] + 3, t5[1] + 2);
    check('F5: a press that moves under 4 px is a click: that clip alone, and no rectangle', !still.on && !still.el && (await ev(PICKED)).join() === '5' && (await ev(`SelectApp.marquee().last`)) === null, { still, picked: await ev(PICKED) });

    // A plain drag from inside one tile to another: the rectangle's clips, live, then kept.
    const a0 = await tile(0, 10, 10), z5 = await tile(5, 10, 10);
    await drag(a0, z5);
    await sleep(150);    // the bar's count follows at most ten times a second
    const mid = { m: await mq(), picked: await ev(PICKED), drawn: await drawnHits(a0[0], a0[1], z5[0], z5[1]), count: await ev(`document.getElementById('count').textContent`),
      hover: await ev(`(function(){var e=document.elementFromPoint(${z5[0]},${z5[1]});return {tile:!!(e&&e.closest('.t')),pe:getComputedStyle(document.querySelector('#tiles .t')).pointerEvents};})()`), scrub: await ev(`SelectApp.state.scrub`) };
    check('F5: a drag draws one rectangle over the clips and picks every clip it touches, live, from the layout: the same clips as the tiles drawn there', mid.m.on && mid.m.el && mid.m.cls && mid.picked.join() === '0,1,' + cols + ',' + (cols + 1) && mid.picked.join() === mid.drawn.join() && /^4 of 1,000 clips selected/.test(mid.count), mid);
    check('F5: while it runs nothing else reacts: the tiles hear no pointer (no hover, no tooltip), and no scrub', !mid.hover.tile && mid.hover.pe === 'none' && mid.scrub === null && mid.m.pe === 'none', mid.hover);
    const lineColor = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--focus-ring').trim()`);
    const parts = mid.m.pos.split(',').concat(mid.m.size.split(',')).join(' ').match(/-?[\d.]+(?=px)/g).map(Number);
    check('F5: the rectangle: 1 px lines in the accent and a fill of it at 12 %, square, on whole pixels (crisp at 1x and 2x), above the clips and under the menus', /linear-gradient/.test(mid.m.image) && (mid.m.image.match(/linear-gradient/g) || []).length === 5 && /rgba\(\d+, \d+, \d+, 0\.12\)/.test(mid.m.image) &&
      / 1px/.test(mid.m.size) && parts.every(v => Number.isInteger(v)) && mid.m.z === '2', { image: mid.m.image, pos: mid.m.pos, size: mid.m.size, lineColor });
    await up(z5[0], z5[1]);
    const after = { m: await mq(), picked: await ev(PICKED), anchor: await ev(`SelectApp.state.order.indexOf(SelectApp.state.anchor)`), count: await ev(`document.getElementById('count').textContent`) };
    check('F5: released, the clips stay picked, the rectangle goes, and the bar counts them', !after.m.on && !after.m.el && !after.m.cls && after.picked.join() === mid.picked.join() && after.anchor === 0 && /^4 of 1,000 clips selected/.test(after.count) && after.m.last.ticks > 0, after);
    // The anchor for a later Shift-click is the clip where the drag started.
    await clickAt(await tile(cols * 2 + 1), { shift: true });
    check('F5: a Shift-click after a drag reaches from the clip the drag started on', (await ev(PICKED)).join() === Array.from({ length: cols * 2 + 2 }, (_, i) => i).join(), await ev(PICKED));

    // Replace, add, turn around.
    const r2 = await tile(cols * 2 + 2), r3 = await tile(cols * 3 + 2);
    await drag(r2, r3);
    await up(r3[0], r3[1]);
    const replaced = await ev(PICKED);
    check('F5: a plain drag replaces the picks with what it holds', replaced.join() === [cols * 2 + 2, cols * 3 + 2].join(), replaced);
    const s0 = await tile(0), s1 = await tile(1);
    await down(s0[0], s0[1], { shift: true });
    await frames(2);
    const heldBack = await ev(PICKED);
    await ev(`window.__at=[${s0[0]},${s0[1]}]`);
    await move(s1[0], s1[1], { shift: true });
    await up(s1[0], s1[1], { shift: true });
    const added = await ev(PICKED);
    check('F5: Shift-drag adds the rectangle\'s clips to the picks there were; the Shift-press shows no click first', heldBack.join() === replaced.join() && added.join() === [0, 1].concat(replaced).join(), { heldBack, added });
    const s2 = await tile(2);
    await drag(s1, s2, { meta: true });
    const flipping = await ev(PICKED);
    await up(s2[0], s2[1], { meta: true });
    const flipped = await ev(PICKED);
    check('F5: Cmd-drag turns each clip it touches the other way, as the Finder does: a picked one goes, the others come', flipping.join() === flipped.join() && flipped.join() === [0, 2].concat(replaced).join(), { flipping, flipped });
    await clickAt(await tile(0), { meta: true });
    const cmdClick = await ev(PICKED);
    await clickAt(await tile(3));
    const plainClick = await ev(PICKED);
    await clickAt(await tile(6), { shift: true });
    const shiftClick = await ev(PICKED);
    check('F5: clicks as before: Cmd-click turns one clip, a click picks one, Shift-click a range from it', cmdClick.join() === [2].concat(replaced).join() && plainClick.join() === '3' && shiftClick.join() === '3,4,5,6', { cmdClick, plainClick, shiftClick });

    // Escape puts the picks back as they were before the press.
    const e4 = await tile(cols), e9 = await tile(cols * 2 + 1);
    await drag(e4, e9);
    const escMid = await ev(PICKED);
    await press(b, 'Escape');
    await frames(2);
    const escaped = { picked: await ev(PICKED), m: await mq(), anchor: await ev(`SelectApp.state.order.indexOf(SelectApp.state.anchor)`) };
    await up(e9[0], e9[1]);
    const escUp = await ev(PICKED);
    check('F5: Escape ends a drag and puts the picks back as they were', escMid.join() === [cols, cols + 1, cols * 2, cols * 2 + 1].join() && escaped.picked.join() === '3,4,5,6' && !escaped.m.on && !escaped.m.el && escaped.anchor === 3 && escUp.join() === '3,4,5,6', { escMid, escaped, escUp });

    // A moving rectangle repaints one element and lays nothing out.
    const l0 = await tile(0, 6, 6);
    await drag(l0, [l0[0] + 30, l0[1] + 20]);
    await sleep(160);    // the bar's count, ten times a second at most, has followed
    await frames(3);
    const layout0 = await metric('LayoutCount'), style0 = await metric('RecalcStyleCount');
    for (let i = 1; i <= 12; i++) {
      await P('Input.dispatchMouseEvent', { type: 'mouseMoved', x: l0[0] + 30 + i * 6, y: l0[1] + 20 + i * 3, button: 'left', buttons: 1 });
      await ev(FRAME);
    }
    const layout1 = await metric('LayoutCount'), style1 = await metric('RecalcStyleCount'), noLayout = await mq();
    await up(l0[0] + 102, l0[1] + 56);
    check('F5: twelve frames of a moving rectangle over the same clips lay nothing out (only its background moves)', layout1 - layout0 === 0 && style1 - style0 >= 1 && noLayout.on, { layout: layout1 - layout0, style: style1 - style0 });

    // At the bottom edge the clips scroll by themselves, and hits reach clips scrolled out of the tiles.
    await ev(`document.getElementById('grid').scrollTop=0`);
    await frames(4);
    const g = await ev(`(function(){var r=document.getElementById('grid').getBoundingClientRect();return {top:r.top,bottom:r.top+document.getElementById('grid').clientHeight,right:r.left+document.getElementById('grid').clientWidth};})()`);
    const top0 = await tile(0), x1 = (await tile(1))[0];
    await drag(top0, [x1, g.bottom - 20], null);
    const atEdge = await ev(`document.getElementById('grid').scrollTop`);
    await sleep(300);
    const slow = await ev(`document.getElementById('grid').scrollTop`);
    await move(x1, g.bottom + 30);
    await sleep(700);
    const auto = await ev(`(function(){var S=SelectApp.state,g=document.getElementById('grid'),r=g.getBoundingClientRect(),L=S.L,y=${g.bottom + 30}-r.top+g.scrollTop,cols=L.cols,want=[];
      y=Math.min(y,g.scrollHeight);for(var at=0;at<S.order.length;at++){if(at%cols<=1&&L.top+Math.floor(at/cols)*L.pitch<=y){want.push(at);}}
      var shown=Array.from(document.querySelectorAll('#tiles .t')).filter(function(t){return t.style.display!=='none';}).map(function(t){return Number(t.dataset.at);});
      return {scroll:g.scrollTop,want:want,picked:${PICKED},zeroDrawn:shown.indexOf(0)>=0,pos:document.getElementById('marquee').style.backgroundPosition};})()`);
    const sinceSlow = auto.scroll - slow;
    check('F5: near the bottom edge the clips scroll by themselves, faster past the edge than inside it', slow > atEdge && sinceSlow > 2 * (slow - atEdge) && auto.scroll > 600, { atEdge, slow, scroll: auto.scroll });
    check('F5: the rectangle keeps its corner in the clips: the first clip, scrolled out of the tiles, stays picked, and every clip down to the pointer in its two columns is', !auto.zeroDrawn && auto.picked.join() === auto.want.join() && auto.picked[0] === 0 && auto.picked.length > 12 && /^\d+px -\d+px/.test(auto.pos), { picked: auto.picked.length, want: auto.want.length, zeroDrawn: auto.zeroDrawn, pos: auto.pos.split(',')[0] });
    // Released below the panel: it ends there, with what it picked.
    await P('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: 700, button: 'left', buttons: 1 });
    await P('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: 700, button: 'left', buttons: 0, clickCount: 1 });
    await ev(`window.__at=null`);
    await frames(3);
    const outside = { m: await mq(), n: await ev(`SelectApp.state.selected.size`) };
    check('F5: a release outside the panel ends the drag, the picks kept; 1,000 clips stay smooth (the worst frame\'s work is short)', !outside.m.on && !outside.m.el && outside.n >= auto.picked.length && outside.m.last.worst < 8 && outside.m.last.ticks > 20, outside);

    // Not from the scrollbar; a lost focus ends it.
    await ev(`document.getElementById('grid').scrollTop=0`);
    await frames(3);
    const before = await ev(PICKED);
    await drag([g.right + 5, 200], [g.right + 5, 320]);
    const bar = await mq();
    await up(g.right + 5, 320);
    check('F5: a press on the scrollbar draws no rectangle', !bar.on && !bar.el && (await ev(PICKED)).join() === before.join(), bar);
    await ev(`document.getElementById('grid').scrollTop=0`);
    await frames(3);
    const b0 = await tile(0), b1 = await tile(1);
    await drag(b0, b1);
    await ev(`window.dispatchEvent(new Event('blur'))`);
    await frames(2);
    const blurred = await mq();
    await up(b1[0], b1[1]);
    check('F5: the panel losing focus ends a drag, the picks kept', !blurred.on && !blurred.el && (await ev(PICKED)).join() === '0,1', blurred);
    await b.shot('f5-00-grid-done');

    // A drag from the space under the last row (no tile there) starts it too; the anchor is the first clip it picks.
    await ev(`SelectApp.state.selected.clear();SelectApp.applyView()`);
    await ev(`document.getElementById('grid').scrollTop=document.getElementById('grid').scrollHeight`);
    await frames(4);
    const last = await ev(`SelectApp.state.order.length-1`);
    const lt = await tile(last, 20, 20);
    const below = await ev(`(function(){var t=document.querySelector('#tiles .t[data-at="${last}"]').getBoundingClientRect();return [t.right+40>innerWidth-20?t.left-60:t.right+20,t.bottom+6];})()`);
    await drag(below, lt);
    await up(lt[0], lt[1]);
    const empty = { picked: await ev(PICKED), anchor: await ev(`SelectApp.state.order.indexOf(SelectApp.state.anchor)`) };
    check('F5: a drag from the space between the tiles picks what it reaches, and a later Shift-click reaches from its first clip', empty.picked.indexOf(last) >= 0 && empty.anchor === empty.picked[0], empty);
    await ev(`document.getElementById('grid').scrollTop=0`);
    await frames(3);

    // 2x stills of the rectangle mid-drag, and a selected tile.
    await ev(`SelectApp.state.selected.clear();SelectApp.applyView()`);
    const p1 = await tile(1, 30, 40), p6 = await tile(cols + 2, 90, 60);
    await drag(p1, p6);
    await sleep(160);
    await b.shot('f5-01-marquee-grid');
    await up(p6[0], p6[1]);
    await clickAt(await tile(1));
    await P('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 620 });
    await b.shot('f5-03-selected-tile');

    // ======== no bold on a picked clip's name
    const weight = await ev(`(function(){var on=document.querySelector('#tiles .t.sel[data-at="1"] .n'),off=document.querySelector('#tiles .t:not(.sel)[data-at="2"] .n');return {on:getComputedStyle(on).fontWeight,off:getComputedStyle(off).fontWeight,w:on.getBoundingClientRect().width};})()`);
    await ev(`SelectApp.state.selected.clear();SelectApp.applyView()`);
    await frames(2);
    const unpicked = await ev(`document.querySelector('#tiles .t[data-at="1"] .n').getBoundingClientRect().width`);
    check('F5: a picked tile\'s name keeps its weight and its width: the plate is the only sign', weight.on === '400' && weight.off === '400' && Math.abs(weight.w - unpicked) < 0.01, { weight, unpicked });

    // ======== the right-click menu: no title, its first action at the top
    await rightClick(b, '#tiles .t[data-at="2"] .pic');
    await b.waitFor(`!!document.querySelector('.ctx:not(.labels)')`, 'the right-click menu', 2000);
    const ctx = await ev(`(function(){var m=document.querySelector('.ctx:not(.labels)'),f=m.firstElementChild,r=m.getBoundingClientRect(),q=f.getBoundingClientRect();return {first:f.tagName+':'+(f.dataset.ctx||''),title:!!m.querySelector('.title'),gap:q.top-r.top,items:Array.from(m.children).map(function(x){return x.dataset.ctx||x.tagName;}).join(),name:m.textContent.indexOf(SelectApp.state.store.rows[SelectApp.state.order[2]].name)>=0,rule:Array.from(document.styleSheets).some(function(s){try{return Array.from(s.cssRules).some(function(c){return c.selectorText==='.ctx .title';});}catch(e){return false;}})};})()`);
    await b.shot('f5-02-right-click');
    check('F5: the right-click menu has no clip name or count on top: it starts with Open in Source Monitor, 4 px in, and nothing else changed', ctx.first === 'BUTTON:open' && !ctx.title && !ctx.name && ctx.gap === 4 && ctx.items === 'open,reveal,finder,HR,label,HR,sequence' && !ctx.rule, ctx);
    await b.click('.ctx [data-ctx="label"]');
    await b.waitFor(`!!document.querySelector('.ctx.labels')`, 'the colours', 1500);
    const sub = await ev(`(function(){var l=document.querySelector('.ctx [data-ctx="label"]').getBoundingClientRect(),s=document.querySelector('.ctx.labels').getBoundingClientRect(),f=document.querySelector('.ctx.labels button').getBoundingClientRect();return {row:l.top,first:f.top};})()`);
    check('F5: Label\'s colours still open beside Label, their first row level with it', Math.abs(sub.row - sub.first) <= 1.01, sub);
    await press(b, 'Escape');
    await press(b, 'Escape');
    await frames(2);

    // ======== Show, Sort and ···: whole on their first frame, gone on the next, no pulse
    for (const [button, menu] of [['show', 'picker'], ['sort', 'picker'], ['more', 'menu']]) {
      const at = await ev(`(function(){var r=document.getElementById('${button}').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2];})()`);
      await P('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0], y: at[1] });
      await frames(3);
      await ev(FRAMES(button, menu));
      await P('Input.dispatchMouseEvent', { type: 'mousePressed', x: at[0], y: at[1], button: 'left', buttons: 1, clickCount: 1 });
      await frames(3);
      await P('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at[0], y: at[1], button: 'left', buttons: 0, clickCount: 1 });
      await frames(8);
      const focus = await ev(`(function(){var a=document.activeElement;return {inside:document.getElementById('${menu}').contains(a),on:a.dataset.id||a.dataset.menu||'',ring:a.matches(':focus-visible'),plate:getComputedStyle(a).backgroundColor};})()`);
      await P('Input.dispatchMouseEvent', { type: 'mousePressed', x: at[0], y: at[1], button: 'left', buttons: 1, clickCount: 1 });
      await frames(3);
      await P('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at[0], y: at[1], button: 'left', buttons: 0, clickCount: 1 });
      await frames(4);
      await ev(`window.__fOn=false`);
      const log = await ev(`window.__f`);
      const open = log.filter(f => !f.hidden), firstOpen = log.findIndex(f => !f.hidden), lastOpen = log.length - 1 - log.slice().reverse().findIndex(f => !f.hidden);
      const plates = [...new Set(log.map(f => f.plate))], widths = [...new Set(log.map(f => f.width))], weights = [...new Set(log.map(f => f.weight))];
      check(`F5: ${button === 'more' ? '···' : button === 'show' ? 'Show' : 'Sort'} opens on the press, whole in its final place at full strength on its first frame, stays open through the release, and closes on the next press with no animation; the button's plate never pulses, its word never changes weight, nothing shows a focus ring; the focus is on the item that is on, with no highlight, so the arrows start there`,
        firstOpen > 0 && open.length === lastOpen - firstOpen + 1 && open.every(f => f.op === '1' && f.anims === 0 && f.r === open[open.length - 1].r) && log[lastOpen + 1] && log[lastOpen + 1].hidden && log.slice(lastOpen + 1).every(f => f.hidden) &&
        plates.length === 1 && widths.length === 1 && weights.length === 1 && log.every(f => !f.ring) && focus.inside && !focus.ring && focus.plate === 'rgba(0, 0, 0, 0)' && focus.on === (button === 'more' ? 'rescan' : button === 'show' ? 'everything' : 'listed'),
        { frames: log.length, firstOpen, lastOpen, plates, widths, weights, focus, first: open[0], end: open[open.length - 1] });
    }
    // The open Show menu while a scan's counts climb: the same items, changed in place.
    b.engineEnv.FAKE_DELAY_MS = '4';
    await ev(`__mock.items=${JSON.stringify(clips(300))};SelectApp.askTarget()`);
    await frames(3);
    await ev(`SelectApp.startScan({same:false})`);
    await b.waitFor(`SelectApp.state.scan&&SelectApp.state.scan.handle&&SelectApp.state.store.tier0>5`, 'a scan', 5000);
    await b.click('#show');
    await ev(`window.__kids=Array.from(document.querySelectorAll('#picker button'));window.__hint=document.querySelector('#picker [data-id="everything"] span').textContent`);
    await sleep(500);
    const inPlace = await ev(`({same:Array.from(document.querySelectorAll('#picker button')).every(function(b,i){return b===__kids[i];}),n:__kids.length,focus:document.activeElement.dataset.id})`);
    await b.waitFor(`SelectApp.state.scan&&SelectApp.state.scan.state==='Done'`, 'the scan', 20000);
    check('F5: while a scan runs the open Show menu keeps its items and changes their counts in place, so the one under the pointer keeps its plate', inPlace.same && inPlace.n > 10 && inPlace.focus === 'everything', inPlace);
    await press(b, 'Escape');
    b.engineEnv.FAKE_DELAY_MS = '0';

    // ======== drag select in the list
    await ev(`SelectApp.setMode('list');SelectApp.state.selected.clear();SelectApp.applyView();document.getElementById('grid').scrollTop=0`);
    await frames(4);
    const w2 = await row(2), w6 = await row(6, 300);
    await drag(w2, w6);
    await sleep(160);
    const list = { picked: await ev(PICKED), m: await mq(), head: await ev(`document.getElementById('head').getBoundingClientRect().bottom-document.getElementById('app').getBoundingClientRect().top`) };
    await b.shot('f5-04-marquee-list');
    await up(w6[0], w6[1]);
    check('F5: in the list a drag from a row picks every row it spans, live; the rectangle sits under the column headers', list.picked.join() === '2,3,4,5,6' && list.m.on && Number(list.m.box.split(',')[1]) === list.head, list);
    const h = await ev(`(function(){var r=document.querySelector('#head .h[data-key="durationS"]').getBoundingClientRect();return [r.left+r.width/2,r.top+12];})()`);
    const heldPicks = await ev(PICKED);
    await drag(h, [h[0], h[1] + 120]);
    const fromHead = await mq();
    await up(h[0], h[1] + 120);
    check('F5: a press on the column headers draws no rectangle (the columns drag there)', !fromHead.on && !fromHead.el && (await ev(PICKED)).join() === heldPicks.join() && (await ev(`SelectApp.state.columns.map(function(c){return c.key;}).join()`)).indexOf('durationS') >= 0, fromHead);
    const lg = await ev(`(function(){var g=document.getElementById('grid'),r=g.getBoundingClientRect();return {top:r.top+24,bottom:r.top+g.clientHeight};})()`);
    const w1 = await row(1);
    await drag(w1, [w1[0], lg.bottom + 20]);
    await sleep(500);
    const listAuto = { scroll: await ev(`document.getElementById('grid').scrollTop`), n: await ev(`SelectApp.state.selected.size`), first: (await ev(PICKED))[0] };
    await up(w1[0], lg.bottom + 20);
    // Back up past the top edge: the rows above come back into the rectangle as the list scrolls up.
    const wb = await row(Math.ceil(listAuto.scroll / 40) + 3);
    await drag(wb, [wb[0], lg.top - 20]);
    await sleep(700);
    const up2 = { scroll: await ev(`document.getElementById('grid').scrollTop`), picked: await ev(PICKED) };
    await up(wb[0], lg.top - 20);
    check('F5: in the list too the edges scroll, down and back up, and the rectangle keeps its corner', listAuto.scroll > 200 && listAuto.n > 12 && listAuto.first === 1 && up2.scroll === 0 && up2.picked[0] === 0, { listAuto, up2: { scroll: up2.scroll, n: up2.picked.length } });
    check('F5: drag select: no script errors', b.problems.length === 0, b.problems.slice(0, 5));

    // ======== the band's life: every way it opens to offer a scan, and what closes it
    // A new page with nothing kept: the scans above left this project's last results on the fake disk.
    await ev(`__disk.clear()`);
    await b.size(420, 640);
    await b.open();
    await ev(`SelectApp.setMode('grid');SelectApp.timeouts.settle=1e9`);
    // 72 clips in DAY 2, 40 in DAY 3, 288 in DAY 1, and three the cache won't hold later.
    const day2 = items(72), day3 = items(40, 72, 'Footage/DAY 3'), day1 = items(285, 112, 'Footage/DAY 1');
    const unread = items(3, 397, 'Footage/DAY 1').map(it => ({ ...it, path: it.path.replace(/\.MP4$/i, '.uncached.MP4').replace(/\.(mov|mxf|braw|r3d)$/i, '.uncached.MP4') }));
    let project = day2.concat(day3, day1, unread);
    await ev(`__mock.items=${JSON.stringify(project)};__mock.selection=null;SelectApp.askTarget()`);
    await b.waitFor(`document.getElementById('foot-verdict').textContent==='Whole project'`, 'the whole project', 5000);
    const first = await footNow();
    check('F5 band, first run: before any results, Whole project and its clips with the one blue Scan', first.open && first.verdict === 'Whole project' && first.sentence === '400 clips' && first.actions.join() === 'scan*', first);
    const select = async sel => { await ev(`__mock.selection=${sel};SelectApp.askTarget()`); await frames(4); await sleep(60); };
    await select(`{kind:'bins',items:__mock.items.slice(0,72),places:['DAY 2']}`);
    await H.scanAndWait(b);
    const scanned = await footNow();
    await select('null');
    const letGo = await footNow();
    await b.click('#more');
    const menu1 = await ev(`({whole:!document.querySelector('[data-menu="scan-whole"]').hidden,tip:document.querySelector('[data-menu="scan-whole"]').title})`);
    await press(b, 'Escape');
    check('F5 band, new footage scanned on its own: after a scan of a selection, letting the selection go opens nothing; the whole project is in ··· › Scan Whole Project', !scanned.open && scanned.count === '72 clips' && !letGo.open && letGo.verdict === '' && (await ev(`SelectApp.state.others`)) === 0 && menu1.whole && menu1.tip === '400 clips', { scanned, letGo, menu1 });
    await select(`{kind:'bins',items:__mock.items.slice(72,112),places:['DAY 3']}`);
    const newBin = await footNow();
    await select(`{kind:'clips',items:__mock.items.slice(100,110),places:['DAY 3']}`);
    const newClips = await footNow();
    check('F5 band, a new selection: a bin or clips the results lack open it with an outlined Scan, its words as today', newBin.open && newBin.mark === 'bin' && newBin.verdict === 'DAY 3' && newBin.sentence === '40 clips' && newBin.actions.join() === 'scan' &&
      newClips.open && newClips.verdict === '10 other clips selected' && newClips.sentence === 'DAY 3' && newClips.actions.join() === 'scan', { newBin, newClips });
    const fresh = items(8, 500, 'Footage/DAY 2');
    project = project.concat(fresh);
    await ev(`__mock.items=${JSON.stringify(project)}`);
    await select(`{kind:'bins',items:__mock.items.slice(0,72).concat(__mock.items.slice(400)),places:['DAY 2']}`);
    const grown = await footNow();
    await select(`{kind:'clips',items:__mock.items.slice(0,5),places:['DAY 2']}`);
    const inside = await footNow();
    check('F5 band, a scanned bin with footage added since counts only the new clips; a selection inside the results closes the band', grown.open && grown.verdict === 'DAY 2' && grown.sentence === '8 new clips' && grown.actions.join() === 'scan' && !inside.open, { grown, inside });
    // The whole project: scanned whole, an empty selection is news only for footage imported since.
    await b.click('#more');
    await b.click('[data-menu="scan-whole"]');
    await b.waitFor(`SelectApp.state.scan&&SelectApp.state.scan.handle`, 'the whole scan', 4000);
    await b.waitFor(`SelectApp.state.scan&&!SelectApp.state.scan.handle&&SelectApp.state.scan.state==='Done'`, 'the whole scan done', 30000);
    await select('null');
    const whole = await footNow();
    await b.click('#more');
    const menu2 = await ev(`!document.querySelector('[data-menu="scan-whole"]').hidden`);
    await press(b, 'Escape');
    const imported = items(6, 600, 'Footage/DAY 4');
    project = project.concat(imported);
    await ev(`__mock.items=${JSON.stringify(project)};SelectApp.askTarget()`);
    await frames(4);
    const news = await ev(`(function(){var f=${foot};f.scanTip=document.getElementById('scan').title;return f;})()`);
    check('F5 band, the whole project: after Scan Whole Project an empty selection opens nothing, and ··· holds no Scan Whole Project', !whole.open && whole.count === '408 clips' && !menu2, { whole, menu2 });
    check('F5 band, new footage after a scan of the whole project: Whole project · 6 new clips, an outlined Scan that says the same', news.open && news.mark === 'bin' && news.verdict === 'Whole project' && news.sentence === '6 new clips' && news.actions.join() === 'scan' && news.scanTip === 'Whole project · 6 new clips', news);
    await H.scanAndWait(b);
    const rescanned = await footNow();
    check('F5 band, Scan reads the whole project again (most of it from the cache), and the band closes', !rescanned.open && rescanned.count === '414 clips' && (await ev(`SelectApp.state.from.target.kind`)) === 'project', rescanned);
    // Clips not read: the last results come back from the cache, and the three it doesn't hold are offered.
    await sleep(1300);
    await b.open();
    await b.waitFor(`SelectApp.state.store.rows.length===414&&!SelectApp.state.restoring&&SelectApp.state.scan&&!SelectApp.state.scan.handle`, 'the last results', 8000);
    const notRead = await footNow();
    check('F5 band, clips not read: the last results back, the clips the cache lacked counted, with an outlined Scan of the same clips', notRead.open && notRead.mark === 'info' && notRead.verdict === '3 not read' && notRead.actions.join() === 'scan' && (await ev(`SelectApp.foot().scanWhat`)) === 'same', notRead);
    await b.click('#scan');
    await b.waitFor(`SelectApp.state.scan&&!SelectApp.state.scan.handle&&SelectApp.state.scan.state==='Done'&&!SelectApp.state.restoring`, 'read again', 30000);
    const readAgain = await footNow();
    check('F5 band, they are read and the band closes', !readAgain.open && readAgain.count === '414 clips' && (await ev(`SelectApp.state.store.notRead`)) === 0, readAgain);
    // Another project in front.
    await ev(`__mock.project={path:'/Volumes/Field SSD/Projects/testt2.prproj',name:'testt2.prproj'};__mock.items=${JSON.stringify(clips(20))}`);
    await sleep(1100);
    await ev(`window.dispatchEvent(new Event('focus'))`);
    await b.waitFor(`/^From /.test(document.getElementById('foot-verdict').textContent)`, 'from', 4000).catch(() => {});
    const away = await footNow();
    await ev(`__mock.project=${JSON.stringify(PROJECT)};__mock.items=${JSON.stringify(project)}`);
    await sleep(1100);
    await ev(`window.dispatchEvent(new Event('focus'))`);
    await b.waitFor(`!/^From /.test(document.getElementById('foot-verdict').textContent)`, 'home', 4000).catch(() => {});
    const home = await footNow();
    check('F5 band, another project in front: From it, with the one blue Scan; back in front, it closes', away.open && away.verdict === 'From lantern-spring' && away.actions.join() === 'scan*' && !home.open, { away, home });
    check('F5 band: no script errors', b.problems.length === 0, b.problems.slice(0, 5));
  } catch (e) {
    check('F5 harness ran to the end', false, e.stack);
    await b.shot('f5-zz-failure').catch(() => {});
  }
  await b.close();
}

module.exports = { run };
