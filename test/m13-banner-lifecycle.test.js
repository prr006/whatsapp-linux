/**
 * M13 — GNOME native banner expiration/dismissal lifecycle regression tests.
 *
 * Runs WITHOUT Electron or a display: loads src/main.js with a mocked
 * `electron` module and pins the new per-notification state machine that
 * replaces M10's bare retention Set.
 *
 * What the investigation established (sources: Electron v44.3.0
 * libnotify_notification.cc / electron_api_notification.cc, libnotify
 * notification.c, GNOME Shell messageTray.js / notificationDaemon.js):
 *
 *   - GNOME Shell NEVER reads the client expire_timeout; banner lifetime is
 *     the shell's own NOTIFICATION_TIMEOUT (only gated by user activity,
 *     pointer hover, busy/fullscreen state and a 3-deep banner queue).
 *     That is the root cause of the intermittent "banner never disappears"
 *     observations: identical app behaviour, different GNOME-side policy
 *     outcomes.
 *   - Banner expiration of a persistent (non-transient) notification emits
 *     NO NotificationClosed D-Bus signal, so Electron delivers NO JS event
 *     for it. Absence of events must never be logged/claimed as expiration.
 *   - The JS 'close' event arrives only for: user dismissal/clear from the
 *     notification list, our own CloseNotification (possibly echoed back
 *     through libnotify), and daemon eviction (GNOME keeps at most 10
 *     notifications per source).
 *
 * The tests therefore pin:
 *   1. explicit lifecycle transitions (created -> show-requested -> shown)
 *      and per-notification isolation;
 *   2. the four terminal outcomes are distinguishable:
 *      banner expiration (NO event, no close(), reference retained),
 *      user dismissal ('close' without our close()),
 *      programmatic close (renderer recall -> close()),
 *      click-triggered close ('click' -> close() + focus);
 *   3. history semantics stay intact (no timer close, no invented
 *      expiration event);
 *   4. retention is bounded (cap + oldest-first eviction) without leaks;
 *   5. failure path and late/duplicate events are safe no-ops.
 *
 * Run with: node --test test/m13-banner-lifecycle.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-m13-userdata-'));
const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-m13-appdata-'));
const MAIN_JS = path.join(__dirname, '..', 'src', 'main.js');

// ---- electron mock ---------------------------------------------------------
const electronMock = {
  __windows: [],
  __mainWindow: null,
  __notifications: [],
  __trayTooltip: null,
  __ipcListeners: {},
  __ipcHandlers: {},
};

class MockBrowserWindow {
  constructor(opts) {
    this.opts = opts;
    this.__handlers = {};
    this.__onceHandlers = {};
    this.__visible = false;
    this.__focused = false;
    this.__minimized = false;
    this.__destroyed = false;
    const wc = {
      __handlers: {},
      on: (ev, cb) => { wc.__handlers[ev] = (wc.__handlers[ev] || []).concat([cb]); },
      __emit: (ev, ...args) => { (wc.__handlers[ev] || []).slice().forEach((cb) => cb(...args)); },
      setWindowOpenHandler: () => {},
      executeJavaScript: async () => null,
      isDestroyed: () => this.__destroyed,
    };
    this.webContents = wc;
    electronMock.__windows.push(this);
    if (!electronMock.__mainWindow) electronMock.__mainWindow = this;
  }
  loadURL() {}
  loadFile() {}
  once(ev, cb) { (this.__onceHandlers[ev] = this.__onceHandlers[ev] || []).push(cb); }
  on(ev, cb) { (this.__handlers[ev] = this.__handlers[ev] || []).push(cb); }
  __emit(ev, ...args) {
    const once = (this.__onceHandlers[ev] || []).splice(0);
    once.forEach((cb) => cb(...args));
    (this.__handlers[ev] || []).slice().forEach((cb) => cb(...args));
  }
  show() { this.__visible = true; this.__emit('show'); }
  hide() { this.__visible = false; this.__emit('hide'); }
  focus() { this.__focused = true; this.__emit('focus'); }
  isVisible() { return this.__visible; }
  isFocused() { return this.__focused; }
  isMinimized() { return this.__minimized; }
  restore() { this.__minimized = false; }
  minimize() { this.__minimized = true; }
  isDestroyed() { return this.__destroyed; }
  destroy() { this.__destroyed = true; this.__emit('closed'); }
  setOverlayIcon() {}
}

class MockNotification {
  constructor(opts) {
    this.opts = opts;
    this.__handlers = {};
    this.shown = false;
    this.closeCount = 0;
    electronMock.__notifications.push(this);
  }
  on(ev, cb) { (this.__handlers[ev] = this.__handlers[ev] || []).push(cb); }
  // Mirrors Electron's NotificationDisplayed(): emitted right after
  // notify_notification_show() succeeds. Banner visibility itself is
  // GNOME-owned and has no JS event.
  show() { this.shown = true; (this.__handlers['show'] || []).slice().forEach((fn) => fn()); }
  close() { this.closeCount++; }
  __emit(ev, ...args) { (this.__handlers[ev] || []).slice().forEach((cb) => cb(...args)); }
  __click() { this.__emit('click'); }
}

class MockTray {
  constructor() {}
  setToolTip(s) { electronMock.__trayTooltip = s; }
  setContextMenu() {}
  on() {}
}

const appMock = {
  isPackaged: false,
  __handlers: {},
  setName() {},
  getPath(name) {
    if (name === 'userData') return userDataDir;
    if (name === 'appData') return appDataDir;
    return os.tmpdir();
  },
  getAppPath() { return path.join(__dirname, '..'); },
  requestSingleInstanceLock() { return true; },
  on(ev, cb) { (this.__handlers[ev] = this.__handlers[ev] || []).push(cb); },
  whenReady() { return Promise.resolve(); },
  quit() { (this.__handlers['before-quit'] || []).forEach((cb) => cb()); },
};

electronMock.app = appMock;
electronMock.BrowserWindow = MockBrowserWindow;
electronMock.Tray = MockTray;
electronMock.Menu = { buildFromTemplate(t) { return t; } };
electronMock.Notification = MockNotification;
electronMock.ipcMain = {
  handle(channel, fn) { electronMock.__ipcHandlers[channel] = fn; },
  on(channel, fn) { electronMock.__ipcListeners[channel] = fn; },
};
electronMock.nativeImage = {
  createFromPath: () => ({ isEmpty: () => false }),
  createFromBuffer: () => ({ isEmpty: () => false }),
  createEmpty: () => ({ isEmpty: () => true }),
};
electronMock.shell = { openExternal() {} };
electronMock.dialog = {};

const originalLoad = Module._load;
let win;
let main;

before(async () => {
  Module._load = function (request, ...rest) {
    if (request === 'electron') return electronMock;
    return originalLoad.call(this, request, ...rest);
  };
  main = require(MAIN_JS);
  await new Promise((r) => setImmediate(r));
  win = electronMock.__mainWindow;
  assert.ok(win, 'main window created');
  assert.ok(electronMock.__ipcListeners['wa-web-notification'], 'IPC listener registered');
});

after(() => {
  Module._load = originalLoad;
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(appDataDir, { recursive: true, force: true }); } catch {}
});

// Drive the REAL entry point: the IPC message the preload shim sends.
function fireNotification(title, body, extra) {
  electronMock.__ipcListeners['wa-web-notification'](
    { sender: win.webContents },
    Object.assign({ title, body, tag: '' }, extra || {})
  );
}

function lifecycleFor(eventId) {
  return main.__notificationLifecycleLog.filter((e) => e.eventId === eventId);
}

function transitionsFor(eventId) {
  return lifecycleFor(eventId).map((e) => e.transition);
}

// Reset shared state between tests. Unread is cleared through the production
// path (markNotificationRead per record) because — by M12 semantics — simply
// focusing the window only clears legacy (no renderer id) events.
function resetState() {
  electronMock.__notifications.length = 0;
  for (const [id, record] of Array.from(main.__notificationEvents.entries())) {
    if (!record.read) main.__markNotificationRead(id, 'm13 test reset');
  }
  main.__activeNotifications.clear();
  main.__notificationLifecycleLog.length = 0;
  win.__visible = false;
  win.__focused = false;
}

// ---- 1. state machine basics ----------------------------------------------

test('M13: creation and delivery record created -> show-requested -> shown', () => {
  resetState();
  fireNotification('Alice', 'lifecycle basics', { eventId: 'm13-t1-a' });

  assert.strictEqual(electronMock.__notifications.length, 1);
  const n = electronMock.__notifications[0];
  assert.strictEqual(n.shown, true);
  assert.strictEqual(main.__activeNotifications.size, 1, 'wrapper retained');
  assert.deepStrictEqual(
    transitionsFor('m13-t1-a'),
    ['created', 'show-requested', 'shown'],
    'exact transition order for a delivered notification');

  const meta = main.__activeNotifications.get(n);
  assert.strictEqual(meta.state, main.__notifState.SHOWN);
  assert.strictEqual(meta.eventId, 'm13-t1-a');
  assert.ok(meta.shownAtMs >= meta.createdAtMs, 'timestamps recorded');
});

test('M13: banner expiration is unobservable — nothing happens, nothing is claimed', () => {
  resetState();
  const timers = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return 1; };
  try {
    fireNotification('Bob', 'expiration must not be invented', { eventId: 'm13-t2-a' });
  } finally {
    global.setTimeout = realSetTimeout;
  }

  const n = electronMock.__notifications[0];
  // M10 regression: no blind timer that would call close().
  assert.strictEqual(timers.filter((t) => t.ms === 5000).length, 0, 'no 5s timer');
  assert.strictEqual(timers.length, 0, 'no timers at all on the notification path');

  // Simulate the banner expiring naturally: GNOME hides the pop-out and the
  // notification moves to the history list. NO event exists for this, so the
  // test simulates it by doing nothing.
  assert.strictEqual(n.closeCount, 0, 'expiration must NOT call close()');
  assert.strictEqual(main.__activeNotifications.size, 1, 'reference retained for history');
  const meta = main.__activeNotifications.get(n);
  assert.strictEqual(meta.state, main.__notifState.SHOWN,
    'state stays shown — we never fabricate an expired state');

  // No invented terminal transition may appear in the log.
  const ts = transitionsFor('m13-t2-a');
  assert.ok(!ts.some((t) => /expir/i.test(t)),
    'no transition may claim expiration (absence of events is not evidence)');
  assert.deepStrictEqual(ts, ['created', 'show-requested', 'shown']);

  // Unread persists while the notification sits in history.
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — 1 unread');
});

// ---- 2. terminal outcomes are distinguishable ------------------------------

test('M13: user dismissal (daemon close, no close() by us) is classified user-or-daemon', () => {
  resetState();
  fireNotification('Carol', 'user dismisses from the list', { eventId: 'm13-t3-a' });
  const n = electronMock.__notifications[0];

  n.__emit('close'); // GNOME NotificationClosed, we never called close()

  assert.strictEqual(n.closeCount, 0, 'we must not have called close()');
  assert.strictEqual(main.__activeNotifications.size, 0, 'reference released');
  assert.deepStrictEqual(
    transitionsFor('m13-t3-a'),
    ['created', 'show-requested', 'shown', 'closed-user-or-daemon']);
});

test('M13: renderer Notification.close is a programmatic recall (CloseNotification)', () => {
  resetState();
  fireNotification('Dan', 'renderer recalls me', { eventId: 'm13-t4-a' });
  const n = electronMock.__notifications[0];
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — 1 unread');

  // The preload shim forwards lifecycle 'close' for the same eventId.
  fireNotification('Dan', 'renderer recalls me', { eventId: 'm13-t4-a', lifecycle: 'close' });

  assert.strictEqual(n.closeCount, 1, 'recall sends CloseNotification exactly once');
  assert.strictEqual(main.__activeNotifications.size, 0, 'reference released');
  const closed = lifecycleFor('m13-t4-a').find((e) => e.transition === 'closed-programmatic');
  assert.ok(closed, 'classified as programmatic close');
  assert.match(closed.detail, /renderer close/);
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp for Linux',
    'renderer close marks the message read');
});

test('M13: click is a distinct terminal outcome — close + restore/focus + read', () => {
  resetState();
  fireNotification('Erin', 'click me', { eventId: 'm13-t5-a' });
  const n = electronMock.__notifications[0];
  assert.strictEqual(win.__visible, false);

  n.__click();

  assert.ok(n.closeCount >= 1, 'click path issues close()');
  assert.strictEqual(win.__visible, true, 'window restored');
  assert.strictEqual(win.__focused, true, 'window focused');
  assert.strictEqual(main.__activeNotifications.size, 0, 'reference released');
  const meta = main.__activeNotifications.get(n);
  assert.strictEqual(meta, undefined);
  const ts = transitionsFor('m13-t5-a');
  assert.ok(ts.includes('click'), 'click transition recorded');
  assert.ok(!ts.includes('closed-user-or-daemon'),
    'click must never be misclassified as a user dismissal');
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp for Linux', 'unread cleared');
});

test('M13: synchronous close echo of our own close() stays programmatic', () => {
  resetState();
  fireNotification('Frank', 'echo test', { eventId: 'm13-t6-a' });
  const n = electronMock.__notifications[0];

  // Real Electron/libnotify may deliver the daemon's NotificationClosed
  // synchronously inside our close() call. Emulate that: close() emits
  // 'close' before returning.
  const realClose = n.close.bind(n);
  n.close = () => { realClose(); n.__emit('close'); };

  fireNotification('Frank', 'echo test', { eventId: 'm13-t6-a', lifecycle: 'close' });

  assert.strictEqual(n.closeCount, 1, 'close() called exactly once');
  assert.strictEqual(main.__activeNotifications.size, 0, 'released exactly once');
  const ts = transitionsFor('m13-t6-a');
  assert.ok(ts.includes('closed-programmatic'), 'classified programmatic');
  assert.ok(!ts.includes('closed-user-or-daemon'),
    'echo must NOT be misread as a user dismissal');
});

test('M13: late close event after release is a safe no-op', () => {
  resetState();
  fireNotification('Grace', 'late close', { eventId: 'm13-t7-a' });
  const n = electronMock.__notifications[0];

  n.__click(); // releases the reference
  assert.strictEqual(main.__activeNotifications.size, 0);

  // Some daemons deliver NotificationClosed after activation; must not throw,
  // must not resurrect state, must not touch other notifications.
  n.__emit('close');
  assert.strictEqual(main.__activeNotifications.size, 0);
  assert.ok(transitionsFor('m13-t7-a').includes('close-after-release'),
    'late close is logged, not ignored silently');
});

test('M13: failure is terminal, releases the reference, never calls close()', () => {
  resetState();
  fireNotification('Heidi', 'daemon unreachable', { eventId: 'm13-t8-a' });
  const n = electronMock.__notifications[0];

  n.__emit('failed', {}, new Error('notify_notification_show failed'));

  assert.strictEqual(main.__activeNotifications.size, 0, 'failed releases reference');
  assert.strictEqual(n.closeCount, 0, 'no close() on failure');
  const failed = lifecycleFor('m13-t8-a').find((e) => e.transition === 'failed');
  assert.ok(failed, 'failed transition recorded');
  assert.match(failed.detail, /notify_notification_show failed/);
});

// ---- 3. per-notification isolation ------------------------------------------

test('M13: notifications close together are fully independent (dismiss one)', () => {
  resetState();
  fireNotification('Alice', 'burst one', { eventId: 'm13-t9-a' });
  fireNotification('Bob', 'burst two', { eventId: 'm13-t9-b' });

  assert.strictEqual(electronMock.__notifications.length, 2);
  assert.strictEqual(main.__activeNotifications.size, 2);
  const [a, b] = electronMock.__notifications;
  assert.notStrictEqual(
    main.__activeNotifications.get(a), main.__activeNotifications.get(b),
    'each notification owns its own lifecycle record');

  a.__emit('close'); // user dismisses only A

  assert.strictEqual(main.__activeNotifications.size, 1);
  assert.ok(main.__activeNotifications.has(b), 'B still retained');
  assert.strictEqual(main.__activeNotifications.get(b).state, main.__notifState.SHOWN,
    "B's state is untouched by A's dismissal");
  assert.strictEqual(b.closeCount, 0);
  assert.deepStrictEqual(
    transitionsFor('m13-t9-b'), ['created', 'show-requested', 'shown'],
    'no cross-contamination of lifecycle logs');
});

test('M13: clicking or failing one notification cannot affect another', () => {
  resetState();
  fireNotification('Carol', 'iso A', { eventId: 'm13-t10-a' });
  fireNotification('Dan', 'iso B', { eventId: 'm13-t10-b' });
  const [a, b] = electronMock.__notifications;

  a.__click();
  assert.strictEqual(main.__activeNotifications.size, 1);
  assert.ok(main.__activeNotifications.has(b), 'B survives A being clicked');
  assert.strictEqual(b.closeCount, 0);

  b.__emit('failed', {}, new Error('boom'));
  assert.strictEqual(main.__activeNotifications.size, 0);
  assert.strictEqual(a.closeCount, 1, 'A keeps its own history');
  assert.deepStrictEqual(transitionsFor('m13-t10-a').slice(-1), ['click']);
  assert.deepStrictEqual(transitionsFor('m13-t10-b').slice(-1), ['failed']);
});

test('M13: different texts close together do not collapse into one banner', () => {
  resetState();
  fireNotification('Alice', 'message one', { eventId: 'm13-t11-a' });
  fireNotification('Bob', 'message two', { eventId: 'm13-t11-b' });
  fireNotification('Carol', 'message three', { eventId: 'm13-t11-c' });
  fireNotification('Alice', 'message four', { eventId: 'm13-t11-d' });

  assert.strictEqual(electronMock.__notifications.length, 4,
    'every message gets its own native notification (no tag/id coalescing)');
  assert.strictEqual(main.__activeNotifications.size, 4);
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — 4 unread');
  for (const id of ['m13-t11-a', 'm13-t11-b', 'm13-t11-c', 'm13-t11-d']) {
    assert.deepStrictEqual(transitionsFor(id), ['created', 'show-requested', 'shown']);
  }
});

test('M13: identical texts with distinct renderer ids stay separate; same id dedups', () => {
  resetState();
  // M12 identity: renderer event ids are authoritative, text is not a key.
  fireNotification('Alice', 'same text', { eventId: 'm13-t12-a' });
  fireNotification('Alice', 'same text', { eventId: 'm13-t12-b' });
  assert.strictEqual(electronMock.__notifications.length, 2,
    'same text, different renderer events -> two independent notifications');
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — 2 unread');

  // A repeated renderer event (same id) is the only proven duplicate.
  fireNotification('Alice', 'same text', { eventId: 'm13-t12-a' });
  assert.strictEqual(electronMock.__notifications.length, 2, 'replayed event suppressed');
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — 2 unread',
    'suppressed duplicate does not bump unread');
});

// ---- 4. history / persistence semantics ------------------------------------

test('M13: history semantics — expired banners stay until the user acts', () => {
  resetState();
  fireNotification('Eve', 'history A', { eventId: 'm13-t13-a' });
  fireNotification('Mallory', 'history B', { eventId: 'm13-t13-b' });
  const [a, b] = electronMock.__notifications;

  // Both banners expire naturally (no events, no close) — both stay in
  // history with their references retained for click delivery.
  assert.strictEqual(a.closeCount, 0);
  assert.strictEqual(b.closeCount, 0);
  assert.strictEqual(main.__activeNotifications.size, 2);
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — 2 unread');

  // User dismisses A from the notification list: A removed, B untouched.
  a.__emit('close');
  assert.strictEqual(main.__activeNotifications.size, 1);
  assert.ok(main.__activeNotifications.has(b), 'B still in history');
  assert.strictEqual(b.closeCount, 0, 'B never closed — still in history');

  // User clicks B (from the list): restore/focus + removal via close().
  const windowsBefore = electronMock.__windows.length;
  b.__click();
  assert.strictEqual(win.__visible, true);
  assert.strictEqual(win.__focused, true);
  assert.strictEqual(electronMock.__windows.length, windowsBefore, 'same window reused');
  assert.ok(b.closeCount >= 1);
  assert.strictEqual(main.__activeNotifications.size, 0);
});

// ---- 5. bounded retention ---------------------------------------------------

test('M13: retention is bounded — oldest evicted first, eviction is memory-only', () => {
  resetState();
  const cap = main.__maxActiveNotifications;
  const total = cap + 5;
  for (let i = 0; i < total; i++) {
    fireNotification('Spam ' + i, 'cap test ' + i, { eventId: 'm13-t14-' + i });
  }

  assert.strictEqual(main.__activeNotifications.size, cap,
    'active set never exceeds the cap');

  const evictedIds = main.__notificationLifecycleLog
    .filter((e) => e.transition === 'evicted')
    .map((e) => e.eventId);
  assert.strictEqual(evictedIds.length, 5, 'exactly the excess was evicted');
  for (let i = 0; i < 5; i++) {
    assert.ok(evictedIds.includes('m13-t14-' + i),
      'oldest notifications evicted first (m13-t14-' + i + ')');
  }

  // Newest wrappers are still tracked (click delivery preserved for them).
  const newest = electronMock.__notifications[total - 1];
  assert.ok(main.__activeNotifications.has(newest), 'newest retained');

  // Eviction must not disturb unread accounting (it is memory management,
  // not a read-state signal).
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — ' + total + ' unread');

  // A late daemon close for an evicted wrapper is a harmless no-op.
  const evictedWrapper = electronMock.__notifications[0];
  evictedWrapper.__emit('close');
  assert.strictEqual(main.__activeNotifications.size, cap,
    'late close of evicted notification changes nothing');

  // Terminal events still work after eviction happened.
  newest.__click();
  assert.strictEqual(main.__activeNotifications.size, cap - 1);
  assert.strictEqual(win.__visible, true);
});

// ---- 6. renderer recall isolation -------------------------------------------

test('M13: renderer close of one notification cannot recall another', () => {
  resetState();
  fireNotification('Trent', 'recall isolation A', { eventId: 'm13-t15-a' });
  fireNotification('Walter', 'recall isolation B', { eventId: 'm13-t15-b' });
  const [a, b] = electronMock.__notifications;

  fireNotification('Trent', 'recall isolation A', { eventId: 'm13-t15-a', lifecycle: 'close' });

  assert.strictEqual(a.closeCount, 1, 'A recalled');
  assert.strictEqual(main.__activeNotifications.size, 1);
  assert.ok(main.__activeNotifications.has(b), 'B not recalled');
  assert.strictEqual(b.closeCount, 0, 'no CloseNotification for B');
  assert.deepStrictEqual(
    transitionsFor('m13-t15-b'), ['created', 'show-requested', 'shown']);
});

// ---- 7. regression guards ----------------------------------------------------

test('M13: regression — no timer-driven close, GNOME default timeout, no expiration fabrication', () => {
  resetState();
  fireNotification('Yvonne', 'guard', { eventId: 'm13-t16-a' });
  const n = electronMock.__notifications[0];
  assert.strictEqual(n.opts.timeoutType, 'default',
    'GNOME still owns the timeout via NOTIFY_EXPIRES_DEFAULT');

  const src = fs.readFileSync(MAIN_JS, 'utf8');
  assert.doesNotMatch(src, /setTimeout\(/,
    'main process must not schedule any timer (no blind close, no fake expiration)');
  assert.match(src, /MAX_ACTIVE_NOTIFICATIONS = 50/);
  assert.match(src, /expiration is unobservable/i);
  assert.match(src, /NOTIFICATION_CLOSED|closed-user-or-daemon/);

  // The lifecycle log must never contain an invented expiration outcome.
  assert.ok(!main.__notificationLifecycleLog.some((e) => /expir/i.test(e.transition)),
    'no fabricated expiration transitions');
});

test('M13: diagnostics distinguish all four outcomes in the [notif] trail', () => {
  resetState();
  // Exercise every outcome once and check the machine-readable trail.
  fireNotification('Zed', 'trail 1', { eventId: 'm13-t17-a' }); // will expire (no event)
  fireNotification('Zed', 'trail 2', { eventId: 'm13-t17-b' }); // user dismissal
  fireNotification('Zed', 'trail 3', { eventId: 'm13-t17-c' }); // programmatic
  fireNotification('Zed', 'trail 4', { eventId: 'm13-t17-d' }); // click
  const [a, b, c, d] = electronMock.__notifications;

  b.__emit('close');
  fireNotification('Zed', 'trail 3', { eventId: 'm13-t17-c', lifecycle: 'close' });
  d.__click();

  assert.deepStrictEqual(
    transitionsFor('m13-t17-a'), ['created', 'show-requested', 'shown'],
    'expired banner: no terminal event recorded (we do not know, so we say nothing)');
  assert.deepStrictEqual(
    transitionsFor('m13-t17-b'),
    ['created', 'show-requested', 'shown', 'closed-user-or-daemon']);
  assert.deepStrictEqual(
    transitionsFor('m13-t17-c'),
    ['created', 'show-requested', 'shown', 'closed-programmatic']);
  assert.ok(transitionsFor('m13-t17-d').includes('click'));

  // Every transition is attributed to exactly one notification id.
  for (const entry of main.__notificationLifecycleLog) {
    assert.ok(typeof entry.eventId === 'string' && entry.eventId.length > 0);
    assert.ok(typeof entry.atMs === 'number');
  }
  // Exactly ONE wrapper remains: the expired banner (a). It received no event
  // (none exists), so it is still presumed in GNOME history and retained for
  // click delivery — retention with a bound, not a leak.
  assert.strictEqual(main.__activeNotifications.size, 1,
    'only the expired (eventless) banner stays retained');
  assert.ok(main.__activeNotifications.has(a),
    'the retained wrapper is the expired one');
  assert.strictEqual(main.__activeNotifications.get(a).state, main.__notifState.SHOWN);
});
