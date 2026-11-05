#!/usr/bin/env node
// Browser checks for the panel changing size: the grid's tiles and pictures kept through a sweep of widths, the clip at
// the top kept, the layout at the usual widths, plain and grouped, the list's columns, and the hover scrub, the
// right-click menu and a lifted column through a resize. harness.js runs them in a browser of their own after its own
// checks; alone: node harness-resize.js
'use strict';

const HT = 620;
const WIDTHS = [300, 420, 559, 877, 1400];
const COLS = { 300: 2, 420: 2, 559: 3, 877: 5, 1400: 8 };

// Counters, there before the panel's own scripts: picture addresses set, tiles and rows made, and an id for each
// picture element, so a clip can be followed from one frame to the next.
const PROBE = `(function(){
  var M = window.__rs = { src: 0, tiles: 0, rows: 0, ids: new WeakMap(), next: 0 };
  var d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', { configurable: true, get: d.get, set: function (v) { M.src++; d.set.call(this, v); } });
  M.id = function (el) { if (!M.ids.has(el)) { M.ids.set(el, ++M.next); } return M.ids.get(el); };
  new MutationObserver(function (list) {
    list.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1 && n.classList.contains('t')) { M.tiles++; } else if (n.nodeType === 1 && n.classList.contains('r')) { M.rows++; } }); });
  }).observe(document, { childList: true, subtree: true });
})();`;

const FRAME = `new Promise(function(r){requestAnimationFrame(function(){var c=new MessageChannel();c.port1.onmessage=function(){r(true);};c.port2.postMessage(0);});})`;

// What the grid shows: each tile in view with its clip, its picture element and its box, the group headings in view,
// and whether the clip that was at the top (anchor) is on the top row: the first whose picture is half in view or more.
const LOOK = anchor => `(function(anchor){
  var S = SelectApp.state, g = document.getElementById('grid'), gr = g.getBoundingClientRect(), tr = document.getElementById('tiles').getBoundingClientRect();
  var tiles = [], first = null, firstTop = null, anchorTop = null;
  document.querySelectorAll('#tiles .t').forEach(function (el) {
    if (el.style.display === 'none') { return; }
    var r = el.getBoundingClientRect(), p = el.querySelector('.pic').getBoundingClientRect(), at = Number(el.dataset.at);
    if (r.bottom <= gr.top || r.top >= gr.bottom) { return; }
    var img = el.querySelector('img'), row = S.store.rows[S.order[at]];
    tiles.push({ at: at, rowId: S.order[at], img: __rs.id(img), x: r.left - tr.left, y: r.top - tr.top, w: r.width, h: r.height, ph: p.height, src: img.getAttribute('src') || '', want: row && row.thumb ? 1 : 0,
      blank: row && row.thumb && (img.hidden || !img.complete || !img.naturalWidth) ? 1 : 0 });
    if (p.top + p.height / 2 >= gr.top && (first === null || at < first)) { first = at; firstTop = p.top; }
    if (S.order[at] === anchor) { anchorTop = p.top; }
  });
  var heads = Array.prototype.filter.call(document.querySelectorAll('#tiles .gh'), function (h) { return !h.hidden; }).map(function (h) {
    var r = h.getBoundingClientRect(); return { x: r.left - tr.left, y: r.top - tr.top, w: r.width, h: r.height, text: h.textContent };
  }).filter(function (h) { return h.y + tr.top < gr.bottom && h.y + h.h + tr.top > gr.top; });
  var srcs = {};
  document.querySelectorAll('#tiles img').forEach(function (img) { srcs[__rs.id(img)] = img.getAttribute('src') || ''; });
  return { srcs: srcs, tiles: tiles, heads: heads, top: first === null ? null : S.order[first], kept: anchorTop !== null && firstTop !== null && Math.abs(anchorTop - firstTop) < 1,
    cols: S.L.cols, tileW: S.L.tileW, picH: S.L.picH, pitch: S.L.pitch, room: g.clientWidth, scroll: g.scrollTop, ring: S.tiles.length, viewBottom: gr.bottom - tr.top,
    columns: Array.apply(null, Array(S.L.cols)).map(function (_, c) { return 14 + SelectCore.gridColumnX(S.L.fit, c); }) };
})(${anchor === undefined ? -1 : anchor})`;

function overlaps(boxes) {
  let n = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const p = boxes[i], q = boxes[j];
      if (Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x) > 0.5 && Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y) > 0.5) { n++; }
    }
  }
  return n;
}

// A plain grid at one width: as many columns as the rule says, tiles the same size with 16:9 pictures, 14 or 15 px
// apart (the pixels whole tiles leave over go to the gaps), on the panel's 14 px margin at the left, the row ending on
// the same margin at the right (the scrollbar sits inside it), every clip from the first in view to the last there,
// rows evenly spaced, and nothing on top of anything.
function plainProblems(v, cols) {
  const out = [], t = v.tiles.slice().sort((a, b) => a.at - b.at);
  if (v.cols !== cols) { out.push('cols ' + v.cols + ' not ' + cols); }
  if (!t.length) { return out.concat('no tiles'); }
  const lefts = [...new Set(t.map(x => Math.round(x.x * 2) / 2))].sort((a, b) => a - b);
  if (lefts.length !== cols) { out.push('lefts ' + lefts.length); }
  if (Math.abs(lefts[0] - 14) > 0.5) { out.push('first left ' + lefts[0]); }
  for (let i = 1; i < lefts.length; i++) { const gap = lefts[i] - lefts[i - 1] - v.tileW; if (gap < 13.5 || gap > 15.5) { out.push('spacing ' + (lefts[i] - lefts[i - 1])); } }
  const right = lefts[lefts.length - 1] + v.tileW, edge = v.room - 3;
  if (Math.abs(right - edge) > 0.5) { out.push('row ends at ' + right + ' of ' + edge); }
  for (const x of t) {
    if (Math.abs(x.w - v.tileW) > 0.5 || Math.abs(x.ph - Math.round(x.w * 9 / 16)) > 0.5) { out.push('tile ' + x.at + ' ' + x.w + 'x' + x.ph); break; }
    if (x.want && !x.src) { out.push('no picture on ' + x.at); break; }
  }
  for (let i = 1; i < t.length; i++) { if (t[i].at !== t[i - 1].at + 1) { out.push('gap after ' + t[i - 1].at); break; } }
  const tops = [...new Set(t.map(x => Math.round(x.y * 2) / 2))].sort((a, b) => a - b);
  for (let i = 1; i < tops.length; i++) { if (Math.abs(tops[i] - tops[i - 1] - v.pitch) > 0.5) { out.push('row spacing ' + (tops[i] - tops[i - 1])); break; } }
  const o = overlaps(t);
  if (o) { out.push(o + ' overlaps'); }
  return out;
}

// A grouped grid: tiles on the same columns, the same size, each group's clips one after another under its heading,
// and no tile or heading on top of another.
function groupedProblems(v, cols) {
  const out = [], t = v.tiles.slice().sort((a, b) => a.at - b.at);
  if (v.cols !== cols) { out.push('cols ' + v.cols + ' not ' + cols); }
  if (!t.length || !v.heads.length) { return out.concat('no tiles or headings'); }
  const columns = v.columns;
  for (const x of t) {
    if (!columns.some(c => Math.abs(c - x.x) < 0.5)) { out.push('off the columns ' + x.at + ' at ' + x.x); break; }
    if (Math.abs(x.w - v.tileW) > 0.5 || Math.abs(x.ph - Math.round(x.w * 9 / 16)) > 0.5) { out.push('tile ' + x.at + ' ' + x.w + 'x' + x.ph); break; }
  }
  for (let i = 1; i < t.length; i++) { if (t[i].at !== t[i - 1].at + 1) { out.push('gap after ' + t[i - 1].at); break; } }
  const o = overlaps(t.concat(v.heads));
  if (o) { out.push(o + ' overlaps'); }
  // Each heading in view has its group's first clip right under it, at its left edge, and spans its clips' columns.
  for (const h of v.heads) {
    if (h.y + h.h + 2 >= v.viewBottom) { continue; }
    const under = t.find(x => Math.abs(x.y - (h.y + h.h)) < 1 && Math.abs(x.x - h.x) < 1);
    if (!under) { out.push('heading "' + h.text + '" with nothing under it'); continue; }
    const n = Number((h.text.match(/· ([\d,]+) clip/) || [])[1]), span = Math.min(n, cols);
    const from = columns.findIndex(c => Math.abs(c - h.x) < 0.5);
    if (n && (from < 0 || Math.abs(h.w - (columns[from + span - 1] + v.tileW - h.x)) > 0.5)) { out.push('heading "' + h.text + '" ' + h.w + ' wide'); }
  }
  return out;
}

async function run(check) {
  const { launch, sleep, setItems, scanAndWait, pickShow } = require('./harness.js');
  const { ensureThumbs } = require('./build_fixture.js');
  const b = await launch();
  b.engineEnv.FAKE_THUMBS = ensureThumbs();
  const ev = e => b.evalIn(e);
  const width = async w => { await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: HT, deviceScaleFactor: 2, mobile: false }); await ev(FRAME); };
  const counts = () => ev(`({src:__rs.src,tiles:__rs.tiles,rows:__rs.rows})`);
  const look = anchor => ev(LOOK(anchor));
  const steps = [];
  for (let w = 312; w < 1400; w += 12) { steps.push(w); }
  for (let w = 1400; w > 300; w -= 12) { steps.push(w); }
  steps.push(300);

  // 300 -> 1,400 -> 300 px: follows each clip in view from one step to the next.
  async function sweep() {
    await width(300);
    await sleep(100);
    const start = await look(), c0 = await counts();
    let lost = 0, swapped = 0, overlapped = 0, blank = 0, srcInView = 0, peak = start.ring, prev = start;
    for (const w of steps) {
      await width(w);
      const v = await look(start.top);
      if (!v.kept) { lost++; }
      if (overlaps(v.tiles)) { overlapped++; }
      const before = new Map(prev.tiles.map(x => [x.rowId, x.img]));
      for (const x of v.tiles) {
        if (before.has(x.rowId) && before.get(x.rowId) !== x.img) { swapped++; }
        if (x.blank) { blank++; }
        if (x.src && prev.srcs[x.img] !== x.src) { srcInView++; }
      }
      peak = Math.max(peak, v.ring);
      prev = v;
    }
    const c1 = await counts();
    return { lost, swapped, overlapped, blank, srcInView, start: start.ring, peak, tiles: c1.tiles - c0.tiles, rows: c1.rows - c0.rows, src: c1.src - c0.src, top: start.top, endTop: prev.top, scroll: [start.scroll, prev.scroll], steps: steps.length };
  }

  try {
    await b.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
    await b.size(900, HT);
    await b.open();
    await ev(`window.__disk && __disk.clear()`);
    await b.open();
    await setItems(b, 400);
    await scanAndWait(b);
    await ev(`SelectApp.setMode('grid')`);
    await b.waitFor(`Array.from(document.querySelectorAll('#tiles .t')).filter(function(t){return t.style.display!=='none';}).every(function(t){var i=t.querySelector('img');return i.hidden||(i.complete&&i.naturalWidth>0);})`, 'pictures', 10000);

    // -------- the grid, plain
    await width(300);
    // Headless Chromium sends the scroll event only with its next frame, which may not come while nothing moves: so it
    // is sent here, as harness.js does.
    await ev(`(function(){var g=document.getElementById('grid');g.scrollTop=Math.round(g.scrollHeight*0.4);g.dispatchEvent(new Event('scroll'));})()`);
    await sleep(900);     // scrolling down tucks the band away: the grid's height settles first
    await ev(FRAME);
    await b.waitFor(`(function(){var g=document.getElementById('grid'),gr=g.getBoundingClientRect(),n=0,ok=true;document.querySelectorAll('#tiles .t').forEach(function(el){if(el.style.display==='none'){return;}var r=el.getBoundingClientRect();if(r.bottom<=gr.top||r.top>=gr.bottom){return;}n++;var i=el.querySelector('img');if(!i.hidden&&!(i.complete&&i.naturalWidth>0)){ok=false;}});return n>0&&ok;})()`, 'the pictures in view at 40 %', 5000);
    const one = await sweep();
    check('resize: a sweep of the grid 300 -> 1,400 -> 300 px makes no tile beyond the ring\'s own growth', one.tiles === one.peak - one.start, one);
    check('resize: through the sweep each clip in view keeps its picture element, and nothing overlaps', one.swapped === 0 && one.overlapped === 0, one);
    check('resize: the clip at the top stays on the top row at every step, and the place comes back where it was', one.lost === 0 && one.endTop === one.top && one.scroll[0] === one.scroll[1], one);
    const two = await sweep();
    // The first time the panel widens, clips that come into view for the first time get their pictures; that is all.
    check('resize: no picture in view loads again or shows blank at any step; the same sweep again makes no tile, and any picture it sets is for a tile out of view',
      one.blank === 0 && one.srcInView <= one.tiles && two.tiles === 0 && two.swapped === 0 && two.blank === 0 && two.srcInView === 0 && two.lost === 0, { one, two });
    const plain = {};
    for (const w of WIDTHS) {
      await width(w);
      await sleep(60);
      const v = await look();
      plain[w] = { cols: v.cols, tile: v.tileW + 'x' + v.picH, problems: plainProblems(v, COLS[w]) };
    }
    check('resize: the grid at 300, 420, 559, 877 and 1,400 px: 2, 2, 3, 5 and 8 columns of 16:9 tiles, the row filled, no gap, no overlap',
      WIDTHS.every(w => !plain[w].problems.length), plain);
    check('resize: tiles stay near 165 px on the 14 px margin (420: 2 x 189, 559: 3 x 167, 877: 5 x 158)',
      plain[420].tile === '189x106' && plain[559].tile === '167x94' && plain[877].tile === '158x89' && plain[1400].tile === '159x89' && plain[300].tile === '129x73', plain);

    // -------- grouped: Similar shots, its headings and shelves
    await width(900);
    await ev(`(function(){var g=document.getElementById('grid');g.scrollTop=0;})()`);
    await pickShow(b, 'similar');
    await sleep(200);
    const groups = await ev(`SelectApp.state.breaks.length`);
    await width(300);
    await ev(`(function(){var g=document.getElementById('grid');g.scrollTop=Math.round(g.scrollHeight*0.3);})()`);
    await sleep(900);
    const gs = await sweep();
    check('resize: in Similar shots the clip at the top stays on the top row through the sweep, no picture in view changes or shows blank, nothing overlaps',
      groups > 3 && gs.lost === 0 && gs.swapped === 0 && gs.blank === 0 && gs.srcInView === 0 && gs.overlapped === 0 && gs.endTop === gs.top && gs.scroll[0] === gs.scroll[1], { groups, gs });
    const grouped = {};
    for (const w of WIDTHS) {
      await width(w);
      await sleep(60);
      const v = await look();
      grouped[w] = { cols: v.cols, heads: v.heads.length, problems: groupedProblems(v, COLS[w]) };
    }
    check('resize: Similar shots at 300, 420, 559, 877 and 1,400 px: tiles on the columns, each group together under its heading, no overlap',
      WIDTHS.every(w => !grouped[w].problems.length && grouped[w].heads > 0), grouped);
    await pickShow(b, null);

    // -------- the list
    await width(900);
    await ev(`SelectApp.setMode('list')`);
    await sleep(150);
    const cells = `(function(){
      var head = Array.prototype.map.call(document.querySelectorAll('#head .h'), function (h) { var r = h.getBoundingClientRect(); return { key: h.dataset.key, l: r.left, w: r.width, grow: h.classList.contains('grow') }; });
      var row = Array.prototype.filter.call(document.querySelectorAll('#body .r'), function (r) { return r.style.display !== 'none'; })[2];
      var body = Array.prototype.map.call(row.children, function (c) { var r = c.getBoundingClientRect(); return { l: r.left, w: r.width }; });
      return { head: head, body: body };
    })()`;
    const list = {}, c0 = await counts();
    for (const w of [900, 300, 559, 1400, 420]) {
      await width(w);
      list[w] = await ev(cells);
    }
    const c1 = await counts();
    const aligned = Object.values(list).every(v => v.head.length === v.body.length && v.head.every((h, i) => Math.abs(h.l - v.body[i].l) < 0.6 && Math.abs(h.w - v.body[i].w) < 0.6));
    const fixed = Object.values(list).every(v => v.head.every((h, i) => h.grow || Math.abs(h.w - list[900].head[i].w) < 0.6));
    check('resize: the list keeps its columns at every width, the header over its cells, and makes no row when only the width changes',
      aligned && fixed && c1.rows === c0.rows && c1.src === c0.src, { aligned, fixed, rows: c1.rows - c0.rows, src: c1.src - c0.src, at300: list[300].head.map(h => h.key + ':' + Math.round(h.w)).join(' ') });

    // A taller and shorter panel: the list's rows are added and taken off, and the ones in view keep what they show.
    const rowsAt = h => b.send('Emulation.setDeviceMetricsOverride', { width: 900, height: h, deviceScaleFactor: 2, mobile: false }).then(() => ev(FRAME));
    await rowsAt(HT);
    const p0 = await ev(`SelectApp.state.pool.length`), r0 = await counts();
    await rowsAt(900);
    const p1 = await ev(`SelectApp.state.pool.length`), r1 = await counts();
    await rowsAt(HT);
    const p2 = await ev(`SelectApp.state.pool.length`);
    check('resize: a taller panel adds only the list rows it needs, and a shorter one takes them off', p1 > p0 && r1.rows - r0.rows === p1 - p0 && p2 === p0, { p0, p1, p2, made: r1.rows - r0.rows });

    // -------- a lifted column follows the resize
    const hd = await ev(`(function(){var h=document.querySelector('#head .h[data-key="durationS"]');var r=h.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hd.x, y: hd.y });
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hd.x, y: hd.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 4; i++) { await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hd.x + 10 * i, y: hd.y, button: 'left', buttons: 1 }); await sleep(16); }
    await width(420);
    const pill = await ev(`(function(){var p=document.querySelector('.lifted'),l=document.querySelector('.drop'),g=document.getElementById('grid').getBoundingClientRect();if(!p){return null;}var r=p.getBoundingClientRect(),d=l.getBoundingClientRect();return {inside:r.left>=g.left-0.5&&r.right<=g.right+0.5&&d.left>=g.left-0.5&&d.right<=g.right+0.5,on:!!SelectApp.state.drag&&SelectApp.state.drag.on};})()`);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hd.x + 40, y: hd.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(50);
    const after = await ev(`({drag:SelectApp.state.drag,pills:document.querySelectorAll('.lifted').length})`);
    check('resize: a lifted column header stays inside the narrower panel, its line too, and lets go as usual', !!pill && pill.on && pill.inside && after.drag === null && after.pills === 0, { pill, after });

    // -------- the hover scrub and the right-click menu, in the grid
    await width(900);
    await ev(`SelectApp.setMode('grid')`);
    await ev(`(function(){var g=document.getElementById('grid');g.scrollTop=0;})()`);
    await sleep(200);
    const pic = await ev(`(function(){var t=document.querySelector('#tiles .t[data-at="0"] .pic').getBoundingClientRect();return {x:t.left+t.width*0.4,y:t.top+t.height/2};})()`);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pic.x, y: pic.y });
    await sleep(100);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pic.x + 2, y: pic.y });
    await b.waitFor(`!!SelectApp.state.scrub&&!!SelectApp.state.scrub.strip`, 'scrub', 4000).catch(() => {});
    const scrubbing = await ev(`!!SelectApp.state.scrub&&!!SelectApp.state.scrub.strip`);
    await width(880);
    const stuck = await ev(`({scrub:SelectApp.state.scrub,shown:Array.prototype.filter.call(document.querySelectorAll('#tiles .scrub, #tiles .pos'),function(e){return !e.hidden;}).length,title:document.querySelector('#tiles .t[data-at="0"]').title})`);
    check('resize: a hover scrub ends when the size changes: the picture is back, no line, the tooltip back', scrubbing && stuck.scrub === null && stuck.shown === 0 && stuck.title !== '', { scrubbing, stuck });

    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
    const tile = await ev(`(function(){var t=document.querySelector('#tiles .t[data-at="2"] .pic').getBoundingClientRect();return {x:t.left+10,y:t.top+t.height/2};})()`);
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tile.x, y: tile.y, button: 'right', buttons: 2, clickCount: 1 });
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tile.x, y: tile.y, button: 'right', buttons: 0, clickCount: 1 });
    await b.waitFor(`!!SelectApp.state.ctx`, 'menu', 3000).catch(() => {});
    const menu = await ev(`(function(){var m=document.querySelector('.ctx');if(!m){return null;}var r=m.getBoundingClientRect();return {right:r.right,bottom:r.bottom};})()`);
    // Still fits: it stays where it is.
    await width(Math.ceil(menu ? menu.right + 4 : 880));
    const stays = await ev(`!!SelectApp.state.ctx&&!!document.querySelector('.ctx')`);
    // Would sit off the panel: it closes.
    await width(Math.floor(menu ? menu.right - 40 : 600));
    const gone = await ev(`!SelectApp.state.ctx&&!document.querySelector('.ctx')`);
    check('resize: the right-click menu stays while it fits in the panel, and closes when the panel gets too narrow for it', !!menu && stays && gone, { menu, stays, gone });
    check('resize: no script errors', b.problems.length === 0, b.problems.slice(0, 5));
  } finally {
    await b.close();
  }
}

if (require.main === module) {
  const { setDeadline, stopEverything } = require('./harness.js');
  setDeadline(120000);
  let failed = 0, all = 0;
  run((name, ok, detail) => { all++; if (!ok) { failed++; } console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' : ' + JSON.stringify(detail) : '')); })
    .catch(e => { failed++; console.log('FAIL harness-resize ran to the end : ' + e.stack); })
    .then(() => { stopEverything(); console.log(`\n${all} checks, ${failed} failed`); process.exit(failed ? 1 : 0); });
}

module.exports = { run };
