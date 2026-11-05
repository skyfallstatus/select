// The watch poll in the real page, on a clock of its own: once the pointer has left Select, watch runs at 1, 2, 4, 6,
// 10, 18, 33, 48, 63, 78 and 93 s, and not while the pointer is back, Premiere is behind another app, the panel is
// hidden, no project is open or something else talks to Premiere; a new selection starts the times again, a big one
// waits 10 s between polls, and an hour holds at most 300. A bin selected in Premiere reaches the band with no pointer
// in Select, and back in Select a new selection's band waits 300 ms unless the pointer is over the toolbar.
// Run by harness.js, in its own browser.
'use strict';

// A clock the test moves on by hand, in the page, put in the panel's place (SelectApp.time). It starts at the real time,
// so what the watch did before keeps its place on it.
const CLOCK = `(function(){var now=Date.now(),timers=[],id=0;window.__clock={now:function(){return now;},
  setTimeout:function(f,ms){var t={id:++id,at:now+Math.max(0,ms||0),f:f};timers.push(t);return t.id;},
  clearTimeout:function(i){timers=timers.filter(function(t){return t.id!==i;});},
  advance:function(ms){var end=now+ms;for(;;){timers.sort(function(a,b){return a.at-b.at||a.id-b.id;});var t=timers[0];if(!t||t.at>end){break;}timers.shift();now=t.at;t.f();}now=end;}};
  SelectApp.time.now=__clock.now;SelectApp.time.setTimeout=__clock.setTimeout;SelectApp.time.clearTimeout=__clock.clearTimeout;return true;})()`;

async function run(check) {
  const H = require('./harness.js');
  const { launch, sleep, clips, foot } = H;
  const b = await launch();
  const ev = e => b.evalIn(e);
  const items = (n, from, bin) => clips(n).slice(from || 0).map(it => ({ ...it, bin: bin || 'Footage/DAY 2' }));
  const watches = () => ev(`__mock.calls.filter(function(c){return c.fn==='watch';}).length`);
  const leave = () => ev(`document.documentElement.dispatchEvent(new MouseEvent('mouseleave'));true`);
  const enter = () => ev(`document.documentElement.dispatchEvent(new MouseEvent('mouseenter'));true`);
  const fire = type => ev(`(__mock.listeners[${JSON.stringify(type)}]||[]).forEach(function(f){f();});true`);
  // Moves the clock on by `seconds`, half a second at a time, letting Premiere's answers in after each step; says at
  // which second, from now, each watch went.
  async function runFor(seconds) {
    const t0 = await ev(`__clock.now()`), at = [];
    let seen = await watches();
    for (let i = 0; i < seconds * 2; i++) {
      await ev(`__clock.advance(500)`);
      await sleep(12);
      const n = await watches();
      for (; seen < n; seen++) { at.push(Math.round((await ev(`__clock.now()`) - t0) / 100) / 10); }
    }
    return at;
  }
  const state = () => ev(`({polls:SelectApp.state.polls,items:SelectApp.state.pollItems})`);
  try {
    await b.size(420, 560);
    await b.open();
    await ev(`__disk.clear();__mock.items=${JSON.stringify(items(400))};__mock.selection=null;SelectApp.askTarget()`);
    await b.waitFor(`document.getElementById('foot-verdict').textContent==='Whole project'`, 'whole project', 4000);
    await sleep(1200);
    await ev(CLOCK);

    // -------- the times, from the pointer leaving
    let s0 = await state();
    await leave();
    const times = await runFor(120);
    let s1 = await state();
    check('poll: once the pointer leaves Select, watch runs at 1, 2, 4, 6, 10, 18, 33, 48, 63, 78 and 93 s (no gap over 15 s), then not again', times.join() === '1,2,4,6,10,18,33,48,63,78,93' && s1.polls - s0.polls === 11, { times, s0, s1 });

    // -------- nothing while the pointer is in Select: the hover path does it
    await enter();
    await sleep(50);
    const inside = await runFor(120);
    check('poll: with the pointer in Select nothing runs on the clock: the one watch is the pointer coming in', inside.join() === '0' || inside.length === 0, inside);

    // -------- nothing while Premiere is behind another app, and it starts again when Premiere comes to the front
    await leave();
    await fire('com.adobe.csxs.events.ApplicationDeactivate');
    const behind = await runFor(120);
    await fire('com.adobe.csxs.events.ApplicationActivate');
    const front = await runFor(11);
    check('poll: nothing while Premiere is behind another app; back in front with the pointer still away, the times start again', behind.length === 0 && front.join() === '1,2,4,6,10', { behind, front });

    // -------- nothing while the panel is hidden
    await ev(`Object.defineProperty(document,'hidden',{configurable:true,get:function(){return true;}});document.dispatchEvent(new Event('visibilitychange'));true`);
    const hidden = await runFor(120);
    await ev(`Object.defineProperty(document,'hidden',{configurable:true,get:function(){return false;}});document.dispatchEvent(new Event('visibilitychange'));true`);
    await sleep(30);
    const shown = await runFor(11);
    check('poll: nothing while the panel is hidden; shown again, one watch at once and the times again', hidden.length === 0 && shown.join() === '1,2,4,6,10', { hidden, shown });

    // -------- nothing while something else talks to Premiere, or with no project open
    await leave();
    await ev(`SelectApp.state.busy='Labelling 3 clips'`);
    const busy = await runFor(120);
    await ev(`SelectApp.state.busy=null`);
    await leave();
    await ev(`window.__keep=SelectApp.state.project;SelectApp.state.project=null`);
    const noProject = await runFor(120);
    await ev(`SelectApp.state.project=window.__keep`);
    check('poll: nothing while a write runs, and nothing with no project open', busy.length === 0 && noProject.length === 0, { busy, noProject });

    // -------- a bin selected in Premiere reaches the band, with no pointer in Select, and starts the times again
    await ev(`window.__entered=0;document.documentElement.addEventListener('mouseenter',function(){__entered++;});true`);
    await leave();
    const before = await runFor(11);
    // One bin selected is one item in the Project panel, whatever it holds: its signature says 1.
    await ev(`__mock.calls.length=0;__mock.selection={kind:'bins',items:__mock.items.slice(0,40),places:['DAY 2'],sig:'1:b2'}`);
    const after = await runFor(20);
    const band = await ev(`(function(){var f=${foot};f.targets=__mock.calls.filter(function(c){return c.fn==='target';}).length;f.entered=__entered;return f;})()`);
    check('poll: a bin selected in Premiere shows in the band at the next poll, with no pointer in Select, and target runs once for it', before.join() === '1,2,4,6,10' && band.verdict === 'DAY 2' && band.sentence === '40 clips' && band.mark === 'bin' && band.targets === 1 && band.entered === 0, { before, after, band });
    check('poll: the poll that sees the selection change starts the times again from that moment', after.join() === '7,8,9,11,13,17', after);

    // -------- a big selection: no more than every 10 s, and what the polls hand out is counted
    await ev(`__mock.selection={kind:'clips',items:__mock.items.slice(100,112),places:['DAY 3']}`);
    await enter();
    await sleep(60);
    s0 = await state();
    await leave();
    const big = await runFor(120);
    s1 = await state();
    check('poll: 12 clips selected: polls at 10, 33, 48, 63, 78 and 93 s, 6 in all, handing out 72 items, counted in SelectApp.state.pollItems', big.join() === '10,33,48,63,78,93' && s1.polls - s0.polls === 6 && s1.items - s0.items === 72, { big, s0, s1 });

    // -------- at most 300 in an hour, however often the selection changes
    await ev(`SelectApp.poll.stamps.length=0;__mock.selection={kind:'bins',items:__mock.items.slice(0,40),places:['DAY 2'],sig:'1:b1'}`);
    await enter();
    await sleep(60);
    s0 = await state();
    await leave();
    let polls = 0;
    for (let i = 0; i < 330; i++) {
      // A different bin every second, so every poll sees a change and starts the times again from 1 s.
      await ev(`__mock.selection={kind:'bins',items:__mock.items.slice(${i % 2 ? 0 : 1},40),places:['DAY ${i % 2 ? 2 : 4}'],sig:'1:b${i % 2}'}`);
      polls += (await runFor(1)).length;
    }
    const capped = await runFor(120);
    s1 = await state();
    check('poll: with the selection changing every second, 300 polls in the hour and then none', s1.polls - s0.polls === 300 && polls === 300 && capped.length === 0, { polls, capped: capped.length, s0, s1 });
    // -------- back in Select: a new selection's band waits 300 ms unless the pointer is in the top zone
    await ev(`SelectApp.poll.stamps.length=0;SelectApp.poll.items.length=0;__mock.selection={kind:'bins',items:__mock.items.slice(0,40),places:['DAY 2'],sig:'1:b1'};SelectApp.askTarget()`);
    const ex = b.engineLog.exited.length;
    await ev(`document.getElementById('scan').click()`);
    while (b.engineLog.exited.length === ex) { await sleep(10); }
    await b.waitFor(`SelectApp.state.scan.state==='Done'&&!SelectApp.state.scan.handle`, 'scan', 20000);
    await sleep(100);
    const reenter = async (y, sig) => {
      await leave();
      await ev(`__mock.selection={kind:'bins',items:__mock.items.slice(200,240),places:['DAY 5'],sig:${JSON.stringify(sig)}}`);
      await ev(`__clock.advance(1100)`);
      await ev(`document.documentElement.dispatchEvent(new MouseEvent('mouseenter',{clientY:${y}}));true`);
      await sleep(80);
      const at0 = await ev(`document.getElementById('foot').dataset.open`);
      await ev(`__clock.advance(150)`);
      const at150 = await ev(`document.getElementById('foot').dataset.open`);
      await ev(`__clock.advance(200)`);
      await sleep(20);
      const at350 = await ev(`document.getElementById('foot').dataset.open`);
      const verdict = await ev(`document.getElementById('foot-verdict').textContent`);
      await ev(`__mock.selection={kind:'bins',items:__mock.items.slice(0,40),places:['DAY 2'],sig:'1:b1'};SelectApp.askTarget()`);
      await sleep(80);
      return { at0, at150, at350, verdict };
    };
    // The poll is let go here, so the pointer coming back is what finds the new selection.
    await ev(`SelectApp.poll.active=false`);
    const low = await reenter(300, '1:c1'), high = await reenter(20, '1:c2');
    await ev(`SelectApp.poll.active=true`);
    check('poll: back in Select over the clips, a new selection\'s band opens 300 ms later, so a click lands where it was aimed; over the toolbar it opens at once', low.at0 === 'false' && low.at150 === 'false' && low.at350 === 'true' && low.verdict === 'DAY 5' && high.at0 === 'true', { low, high });
    check('poll: no script errors', b.problems.length === 0, b.problems.slice(0, 5));
  } catch (e) {
    check('poll: harness-poll ran to the end', false, e.stack);
  }
  await b.close();
}

module.exports = { run };
if (require.main === module) {
  const H = require('./harness.js');
  H.setDeadline(300000);
  run(H.check).then(() => { H.stopEverything(); process.exit(0); });
}
