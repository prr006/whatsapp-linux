/**
 * M14 — deterministic banner governor: behavior tests against the REAL
 * GNOME Shell 50.1 banner state machine.
 *
 * HOW THIS SUITE WORKS
 * -------------------
 * test/m14/vendor/gnome-shell-50.1/messageTray.js is a verbatim copy of
 * GNOME Shell 50.1's js/ui/messageTray.js (the exact version of the target
 * desktop; see test/m14/vendor/PROVENANCE.md). The harness
 * (test/m14/harness.js) executes that unmodified file under Node, stubbing
 * only the GI/GTK display layer (actors, timers on Node's real event
 * loop, pointer, idle monitor). The governor under test is the REAL
 * shipped extension (gnome-extension/extension.js + policy.js) enabled
 * through the real shell InjectionManager.
 *
 * Calibration: the first two tests run the stock (governor-less) code and
 * reproduce the documented real-world behavior — active desktop ~4.2-4.5 s
 * banner lifetime; idle desktop = banner never expires until user activity
 * (+~2 s after). Those observations match the M10-M13 field reports (and
 * plain `notify-send` on the target machine), validating the harness before
 * the governor assertions.
 *
 * This is runtime evidence for the mechanism (hook points, deadline
 * convergence, history preservation, D-Bus-destroy semantics) on the exact
 * 50.1 banner code; the final on-device check (A-F matrix in the README)
 * remains a manual step on the real machine.
 *
 * Run with: node --test test/m14-gnome501-simulation.test.js
 * (wall-clock based; ~2 minutes total)
 */

const { test, before } = require('node:test');
const assert = require('node:assert');

let H;
let world;

function newWorld() {
  if (world) world.teardown();
  world = H.createWorld();
  return world;
}

function makeWhatsAppSource(w) {
  const src = H.makeSource(w, 'WhatsApp for Linux', 'whatsapp-linux');
  w.tray.add(src);
  return src;
}

function addNotif(w, src, title) {
  const n = H.makeNotification(w, src, title, 'M14 simulation message');
  src.addNotification(n);
  return n;
}

function historyCount(src) {
  return src.notifications.length;
}

/** Collect the real `destroy` reasons (the daemon emits
 * NotificationClosed for exactly these — notificationDaemon.js). */
function trackDestroys(n) {
  const reasons = [];
  n.connect('destroy', (obj, reason) => reasons.push(reason));
  return reasons;
}

const inWindow = (v, lo, hi) => v >= lo && v <= hi;

before(async () => {
  H = await import('./m14/harness.js');
});

// ---------------------------------------------------------------------------
// Calibration: the STOCK 50.1 behavior (governor off)
// ---------------------------------------------------------------------------

test('M14/sim: stock code — active desktop hides the banner in ~4.2-4.5 s and keeps history', async () => {
  const w = newWorld();
  const src = makeWhatsAppSource(w);
  const a = addNotif(w, src, 'Calibrate active');
  const destroys = trackDestroys(a);

  const tl = await H.trackTimeline(w, 5500);

  assert.ok(tl.shows.has(a), 'banner was shown');
  const hideAt = tl.hides.get(a);
  assert.ok(hideAt !== undefined, 'banner hid on its own (active desktop)');
  assert.ok(inWindow(hideAt, 4000, 5100),
    `stock active hide at ${hideAt} ms (expected ~4400: 200 anim + 4000 timer + 200 anim)`);
  assert.strictEqual(historyCount(src), 1, 'history retained after natural expiry');
  assert.deepStrictEqual(destroys, [], 'no destroy -> daemon would emit no NotificationClosed');
  w.teardown();
});

test('M14/sim: stock code — idle desktop NEVER expires the banner until activity (the reported bug)', async () => {
  const w = newWorld();
  const src = makeWhatsAppSource(w);
  w.idle.makeIdle();
  const a = addNotif(w, src, 'Calibrate idle');
  const destroys = trackDestroys(a);

  const timers = [];
  // User becomes active at t=6000 ms.
  timers.push(setTimeout(() => w.idle.triggerActive(), 6000));

  const tl = await H.trackTimeline(w, 9500);
  timers.forEach(clearTimeout);

  // Still up well past the stock 4 s timeout, while idle:
  const midSamples = tl.samples.filter((s) => s.t >= 4500 && s.t <= 5990);
  assert.ok(midSamples.length > 0, 'samples exist mid-idle');
  assert.ok(midSamples.every((s) => s.state === w.State.SHOWN),
    'banner still SHOWN from 4.5 s to 6 s on an idle desktop (stock: no expiry while idle)');

  // After the user becomes active, stock hides ~2 s later.
  const hideAt = tl.hides.get(a);
  assert.ok(hideAt !== undefined, 'banner hid after user activity');
  assert.ok(inWindow(hideAt, 8100, 9400),
    `stock idle->active hide at ${hideAt} ms (expected ~8200: 6000 + 2000 + 200 anim)`);
  assert.strictEqual(historyCount(src), 1, 'history retained');
  assert.deepStrictEqual(destroys, []);
  w.teardown();
});

// ---------------------------------------------------------------------------
// Governed: determinism (governor on, scoped to this app)
// ---------------------------------------------------------------------------

test('M14/sim: governed — active desktop hides at the fixed ~5 s deadline', async () => {
  const w = newWorld();
  H.startGovernor(w);
  const src = makeWhatsAppSource(w);
  const a = addNotif(w, src, 'Governed active');
  const destroys = trackDestroys(a);

  const tl = await H.trackTimeline(w, 6500);

  const hideAt = tl.hides.get(a);
  assert.ok(hideAt !== undefined, 'banner hid');
  assert.ok(inWindow(hideAt, 5050, 6100),
    `governed active hide at ${hideAt} ms (deadline = 200 anim + 5000 + 200 anim ≈ 5400)`);
  assert.strictEqual(historyCount(src), 1, 'history retained after natural expiry');
  assert.deepStrictEqual(destroys, [], 'no NotificationClosed for natural expiry');
  w.teardown();
});

test('M14/sim: governed — idle desktop still expires at the fixed ~5 s deadline', async () => {
  const w = newWorld();
  H.startGovernor(w);
  const src = makeWhatsAppSource(w);
  w.idle.makeIdle();
  const a = addNotif(w, src, 'Governed idle');
  const destroys = trackDestroys(a);

  const tl = await H.trackTimeline(w, 6500);

  // No user activity ever occurred:
  assert.strictEqual(w.idleStateIdletime(), 60000);
  const hideAt = tl.hides.get(a);
  assert.ok(hideAt !== undefined, 'banner hid while the desktop stayed idle');
  assert.ok(inWindow(hideAt, 5050, 6100),
    `governed idle hide at ${hideAt} ms (same deadline as the active case)`);
  assert.strictEqual(historyCount(src), 1, 'history retained');
  assert.deepStrictEqual(destroys, []);
  w.teardown();
});

test('M14/sim: governed — burst of 5: three 5 s slots advance back-to-back; overflow stays in history, never banners', async () => {
  const w = newWorld();
  H.startGovernor(w);
  const src = makeWhatsAppSource(w);
  const destroysAll = [];
  const notifs = [];
  for (let i = 1; i <= 5; i++) {
    const n = addNotif(w, src, `Burst ${i}`);
    notifs.push(n);
    trackDestroys(n).forEach((r) => destroysAll.push(r));
  }
  const [a, b, c, d, e] = notifs;

  const tl = await H.trackTimeline(w, 19000);

  // GNOME's banner queue holds at most 3 entries INCLUDING the active one
  // (messageTray.js: `full = queueCount + bannerCount >= MAX_NOTIFICATIONS_IN_QUEUE
  //  (3)`): A presents, B+C wait, D and E are history-only — deterministic
  // per the shell's own queue rules.
  assert.ok(tl.shows.has(a) && tl.shows.has(b) && tl.shows.has(c),
    'first three all got banners in order');
  assert.ok(!tl.shows.has(d), 'fourth notification never got a banner (queue full)');
  assert.ok(!tl.shows.has(e), 'fifth notification never got a banner (queue full)');

  // Back-to-back slots, each ~5.2 s (5000 deadline + 200 hide anim + handoff).
  const gap = (x, y) => tl.shows.get(y) - tl.shows.get(x);
  assert.ok(inWindow(gap(a, b), 4400, 6100), `slot A->B ${gap(a, b)} ms`);
  assert.ok(inWindow(gap(b, c), 4400, 6100), `slot B->C ${gap(b, c)} ms`);

  // Every presented banner completes its own slot; nothing destroyed.
  for (const n of [a, b, c]) {
    assert.ok(tl.hides.get(n) !== undefined, `banner for ${n.__m14Id} completed`);
  }
  assert.strictEqual(historyCount(src), 5, 'all five stay in history');
  assert.deepStrictEqual(destroysAll, [], 'no NotificationClosed for natural expiry');
  w.teardown();
});

test('M14/sim: governed — banner held while hovered, released the moment the pointer leaves (bounded, not extended)', async () => {
  const w = newWorld();
  H.startGovernor(w);
  const src = makeWhatsAppSource(w);
  const a = addNotif(w, src, 'Hovered');
  const destroys = trackDestroys(a);

  const timers = [];
  // Hover the banner shortly after it is fully shown; pointer leaves at 6500.
  timers.push(setTimeout(() => H.setBannerHover(w, true), 400));
  timers.push(setTimeout(() => H.setBannerHover(w, false), 6500));

  const tl = await H.trackTimeline(w, 9000);
  timers.forEach(clearTimeout);

  // Past the deadline while hovered: still up (documented hover exemption —
  // a banner actively being read is not yanked from under the pointer).
  const atHold = tl.samples.find((s) => s.t >= 6100 && s.t <= 6300);
  assert.ok(atHold, 'sample while hovered past deadline');
  assert.strictEqual(atHold.state, w.State.SHOWN, 'hovered banner held past deadline');

  // Once the pointer leaves: the 200+600 ms grace, then the standard expiry
  // path hides it — no indefinite extension.
  const hideAt = tl.hides.get(a);
  assert.ok(hideAt !== undefined, 'banner hid after pointer left');
  assert.ok(inWindow(hideAt, 6600, 8400), `hide at ${hideAt} ms after 6500 ms pointer leave`);
  assert.strictEqual(historyCount(src), 1, 'history retained');
  assert.deepStrictEqual(destroys, []);
  w.teardown();
});

test('M14/sim: governed — pointer moving TOWARD the banner at the deadline cannot extend it', async () => {
  const w = newWorld();
  H.startGovernor(w);
  const src = makeWhatsAppSource(w);
  const a = addNotif(w, src, 'Pointer drift');
  const destroys = trackDestroys(a);

  const timers = [];
  // At t=4800 the pointer starts drifting toward the banner (banner is at
  // the top of the screen; stock re-arms +1000 ms whenever the pointer is
  // closer at check time).
  timers.push(setTimeout(() => w.pointer.set(600, 400), 4800));

  const tl = await H.trackTimeline(w, 7000);
  timers.forEach(clearTimeout);

  const hideAt = tl.hides.get(a);
  assert.ok(hideAt !== undefined, 'banner hid');
  assert.ok(inWindow(hideAt, 5050, 6200),
    `hide at ${hideAt} ms — the re-arm was collapsed into the fixed deadline (stock would add ~1 s)`);
  assert.strictEqual(historyCount(src), 1, 'history retained');
  assert.deepStrictEqual(destroys, []);
  w.teardown();
});

test('M14/sim: governed — other applications keep STOCK behavior (scoping)', async () => {
  const w = newWorld();
  H.startGovernor(w);
  // An out-of-scope app (no whatsapp-linux desktop entry resolution).
  const src = H.makeSource(w, 'Some Other App', 'org.example.Other');
  w.tray.add(src);
  const a = addNotif(w, src, 'Not ours');
  const destroys = trackDestroys(a);

  const tl = await H.trackTimeline(w, 6000);

  const hideAt = tl.hides.get(a);
  assert.ok(hideAt !== undefined, 'banner hid');
  assert.ok(inWindow(hideAt, 4000, 5100),
    `out-of-scope hide at ${hideAt} ms — stock ~4400, NOT the governed 5200 deadline`);
  assert.strictEqual(historyCount(src), 1);
  assert.deepStrictEqual(destroys, []);
  w.teardown();
});

test('M14/sim: governed — Escape still hides early (user control preserved) and keeps history', async () => {
  const w = newWorld();
  H.startGovernor(w);
  const src = makeWhatsAppSource(w);
  const a = addNotif(w, src, 'Escapable');
  const destroys = trackDestroys(a);

  const timers = [];
  timers.push(setTimeout(() => H.pressEscape(w), 1000));

  const tl = await H.trackTimeline(w, 4000);
  timers.forEach(clearTimeout);

  const hideAt = tl.hides.get(a);
  assert.ok(hideAt !== undefined, 'banner hid on Escape');
  assert.ok(inWindow(hideAt, 950, 2500), `escape hide at ${hideAt} ms (well before the 5200 deadline)`);
  assert.strictEqual(historyCount(src), 1, 'Escape = banner expiry, history untouched');
  assert.deepStrictEqual(destroys, [], 'no NotificationClosed');
  w.teardown();
});

test('M14/sim: governed — clicking one notification of a burst removes ONLY that one (M12 identity intact)', async () => {
  const w = newWorld();
  H.startGovernor(w);
  const src = makeWhatsAppSource(w);
  const a = addNotif(w, src, 'Click me');
  const b = addNotif(w, src, 'Keep me');
  const c = addNotif(w, src, 'Keep me too');
  const destroysA = trackDestroys(a);
  const destroysB = trackDestroys(b);
  const destroysC = trackDestroys(c);

  let activated = [];
  for (const n of [a, b, c]) n.connect('activated', (obj) => activated.push(n.__m14Id));

  const timers = [];
  timers.push(setTimeout(() => H.clickActiveBanner(w), 1200));

  const tl = await H.trackTimeline(w, 5000);
  timers.forEach(clearTimeout);

  // Click -> activate() -> ActionInvoked (the daemon emits it) + destroy
  // with reason DISMISSED -> the daemon emits NotificationClosed for A only.
  assert.deepStrictEqual(activated, [a.__m14Id], 'only the clicked banner activated');
  assert.deepStrictEqual(destroysA, [2], 'A destroyed with DISMISSED (reason 2)');
  assert.deepStrictEqual(destroysB, [], 'B untouched by A\'s click');
  assert.deepStrictEqual(destroysC, [], 'C untouched by A\'s click');
  assert.ok(!src.notifications.includes(a), 'A removed from history');
  assert.ok(src.notifications.includes(b), 'B still in history');
  assert.ok(src.notifications.includes(c), 'C still in history');

  // The burst continues deterministically: B now has the banner.
  const midSample = tl.samples.find((s) => s.t >= 3000 && s.t <= 4000);
  assert.ok(midSample, 'sample mid-scenario');
  assert.strictEqual(midSample.active, b.__m14Id, 'B is presenting while A was clicked away');
  w.teardown();
});

test('M14/sim: governed — busy state hides the current banner early (stock for active users) and defers the queue', async () => {
  const w = newWorld();
  H.startGovernor(w);
  const src = makeWhatsAppSource(w);
  const a = addNotif(w, src, 'Busy A');
  const b = addNotif(w, src, 'Busy B');

  const timers = [];
  timers.push(setTimeout(() => w.busy.set(true), 1000));
  timers.push(setTimeout(() => w.busy.set(false), 2200));

  const tl = await H.trackTimeline(w, 11000);
  timers.forEach(clearTimeout);

  // BUSY clears the banner timer (shell behavior, active-user stock too):
  const hideAtA = tl.hides.get(a);
  assert.ok(hideAtA !== undefined, 'A hid when session went busy');
  assert.ok(inWindow(hideAtA, 950, 2600), `A hid at ${hideAtA} ms on BUSY`);

  // The queued B does not present while busy...
  const duringBusy = tl.samples.filter((s) => s.t >= 1000 && s.t <= 2100);
  assert.ok(duringBusy.length > 0, 'samples exist during busy window');
  assert.ok(duringBusy.every((s) => s.active !== b.__m14Id), 'B suppressed while busy');

  // ...and after AVAILABLE, B gets its own full 5 s slot.
  const showAtB = tl.shows.get(b);
  assert.ok(showAtB !== undefined && showAtB > 2000, `B shown at ${showAtB} ms (after busy ended)`);
  const hideAtB = tl.hides.get(b);
  assert.ok(hideAtB !== undefined, 'B hid');
  assert.ok(inWindow(hideAtB - showAtB, 4800, 5900),
    `B slot length ${hideAtB - showAtB} ms (its own deadline, not A\'s)`);
  assert.strictEqual(historyCount(src), 2, 'both remain in history');
  w.teardown();
});

test('M14/sim: governed — GNOME history eviction cap (10/source) is untouched; governor keeps no strong refs', async () => {
  const w = newWorld();
  const governor = H.startGovernor(w);
  const src = makeWhatsAppSource(w);

  const all = [];
  const firstDestroys = trackDestroys(addNotif(w, src, 'Evicted'));
  for (let i = 2; i <= 11; i++) {
    all.push(addNotif(w, src, `Cap ${i}`));
  }

  // The 11th arrival evicts the oldest with reason EXPIRED (reason 1) —
  // the daemon would emit NotificationClosed EXPIRED for it.
  assert.strictEqual(historyCount(src), 10, 'source capped at 10 (stock behavior)');
  assert.deepStrictEqual(firstDestroys, [1], 'oldest evicted with EXPIRED reason');

  // The governor holds deadlines in a WeakMap only — no strong retention
  // beyond the shell's own bounded structures.
  assert.ok(governor.ext._deadlines instanceof WeakMap,
    'governor retention is a WeakMap (GC-able, no unbounded growth)');

  // The surviving notifications keep their normal lifecycle: the banner
  // queue advances (n2 presents next) without disturbing eviction.
  await H.sleep(800);
  assert.strictEqual(w.tray._notification, all[0], 'second notification now presenting');
  w.teardown();
});
