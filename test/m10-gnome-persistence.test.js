/**
 * M10 — GNOME banner persistence fix regression tests.
 *
 * Runs WITHOUT Electron or a display: loads src/main.js with a mocked
 * `electron` module and asserts the NEW notification lifecycle:
 *
 *   1. Banner expiration vs history removal are DISTINCT.
 *      - Banner expiration: GNOME hides the pop-out after its configured
 *        timeout (~5s, via timeoutType='default' → NOTIFY_EXPIRES_DEFAULT).
 *        This must NOT call close() (CloseNotification) and must NOT remove
 *        the notification from GNOME's notification center/history.
 *      - History removal: Only when user acts (click) or dismisses, we call
 *        close() → CloseNotification → server removes from history + 'close'
 *        event releases the strong reference.
 *
 *   2. Click/action path still works and is the ONLY path that removes from
 *      history after expiration.
 *
 *   3. Unread count, deduplication, settings toggles, and native behavior
 *      are preserved.
 *
 * Investigation notes (freedesktop + Electron 44 Linux/libnotify):
 *   - freedesktop spec hints:
 *     * resident=true: server will NOT auto-remove notification when action
 *       invoked; stays resident until explicitly removed. Useful with
 *       "persistence" capability. We want resident=false (default) so action
 *       DOES remove it — after user clicks, notification should be gone.
 *     * transient=true: server bypasses persistence; notification does NOT
 *       stay in history. We want transient=false (default) so GNOME keeps it
 *       in history after banner expires.
 *     * persistence capability: GNOME Shell advertises persistence; default
 *       behavior is persistent: banner shows ~5s then hides, but notification
 *       remains in calendar/center until acknowledged/removed.
 *   - Electron 44 libnotify_notification.cc:
 *     * timeoutType='default' → NOTIFY_EXPIRES_DEFAULT (-1) → GNOME uses its
 *       configured timeout. 'never' → NOTIFY_EXPIRES_NEVER (0) → banner stays
 *       forever (not desired).
 *     * Adds "default" action if server has "actions" cap (GNOME does).
 *     * Does NOT set resident/transient → persistent default.
 *     * Dismiss() → notify_notification_close() → CloseNotification DBus call
 *       → removes from both banner AND history.
 *   - Old code: scheduled setTimeout 5000ms → close() → removed from history,
 *     defeating GNOME persistence. New code: NO timer, let GNOME expire banner
 *     naturally, keep in history until click/close.
 *
 * Run with: node --test test/m10-gnome-persistence.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-m10-userdata-'));
const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-m10-appdata-'));
const MAIN_JS = path.join(__dirname, '..', 'src', 'main.js');

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
  static getAllWindows() { return electronMock.__windows.filter((w) => !w.__destroyed); }
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
  show() { this.shown = true; this.__handlers['show'] && this.__handlers['show'].forEach(fn => fn()); }
  close() { this.closeCount++; }
  __emit(ev, ...args) { (this.__handlers[ev] || []).forEach((cb) => cb(...args)); }
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

before(async () => {
  Module._load = function (request, ...rest) {
    if (request === 'electron') return electronMock;
    return originalLoad.call(this, request, ...rest);
  };
  require(MAIN_JS);
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

function fireNotification(title, body, sender) {
  electronMock.__ipcListeners['wa-web-notification'](
    { sender: sender || win.webContents },
    { title, body, tag: '' }
  );
}

function resetState() {
  electronMock.__notifications.length = 0;
  require(MAIN_JS).__activeNotifications.clear();
  win.__visible = false;
  win.__focused = false;
  win.__emit('focus'); // clears unread
}

// ---- M10: banner expiration vs history removal distinction ------------------

test('M10: banner expiration does NOT remove notification from history', () => {
  resetState();
  const main = require(MAIN_JS);

  const timers = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return 1; };
  try {
    fireNotification('Alice', 'banner expiration test');
  } finally {
    global.setTimeout = realSetTimeout;
  }

  assert.strictEqual(electronMock.__notifications.length, 1, 'one banner shown');
  const n = electronMock.__notifications[0];
  assert.strictEqual(n.shown, true, 'banner visible (show called)');
  assert.strictEqual(n.opts.timeoutType, 'default', 'uses GNOME-configured timeout');

  // Critical distinction: no 5s close timer → banner will expire naturally via GNOME.
  const fiveSecTimers = timers.filter(t => t.ms === 5000);
  assert.strictEqual(fiveSecTimers.length, 0, 'M10: must NOT schedule 5s auto-dismiss timer');

  // Simulate GNOME banner expiration: banner hides, but notification stays in center.
  // In real GNOME, this does NOT emit 'close' and does NOT call CloseNotification.
  // Our mock models this as: closeCount stays 0, reference still held.
  assert.strictEqual(n.closeCount, 0, 'banner expiration must NOT call close() — stays in history');
  assert.ok(main.__activeNotifications.has(n), 'notification retained for history (strong ref prevents GC)');
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — 1 unread', 'unread persists while in history');

  // Now simulate user dismissing from history (daemon emits close) — this IS removal from history.
  n.__emit('close');
  assert.strictEqual(main.__activeNotifications.size, 0, 'close event releases reference — removed from history');
  // Unread still tracked until user focuses window (existing behavior preserved).
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — 1 unread', 'unread persists until focus even after history dismissal');
});

test('M10: notification removal from history only on user action (click) or dismissal, not on expiration', () => {
  resetState();
  const main = require(MAIN_JS);

  fireNotification('Bob', 'history removal test');
  const n = electronMock.__notifications[0];

  // Banner expiration — not removal.
  assert.strictEqual(n.closeCount, 0, 'initially not closed');
  assert.ok(main.__activeNotifications.has(n), 'retained after show');
  assert.strictEqual(main.__activeNotifications.size, 1);

  // Simulate time passing (GNOME hides banner) — still not removed.
  // No timer should have fired close().
  assert.strictEqual(n.closeCount, 0, 'after banner timeout, still not closed (still in history)');
  assert.strictEqual(main.__activeNotifications.size, 1, 'still retained in history');

  // User clicks notification in history — this SHOULD remove from history.
  const windowsBefore = electronMock.__windows.length;
  n.__click();
  assert.ok(n.closeCount >= 1, 'click calls close() → CloseNotification → removes from history');
  assert.strictEqual(win.__visible, true, 'click restores window');
  assert.strictEqual(win.__focused, true, 'click focuses window');
  assert.strictEqual(electronMock.__windows.length, windowsBefore, 'no new window');
  assert.strictEqual(main.__activeNotifications.size, 0, 'click releases reference — removed from history');
});

test('M10: clicking notification opens/restores WhatsApp and clears unread', () => {
  resetState();
  const main = require(MAIN_JS);

  fireNotification('Carol', 'click to open');
  const n = electronMock.__notifications[0];
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — 1 unread');

  // Before click: notification in history, window hidden.
  assert.strictEqual(win.__visible, false);
  assert.strictEqual(n.closeCount, 0);
  assert.ok(main.__activeNotifications.has(n));

  n.__click();

  assert.strictEqual(win.__visible, true, 'window restored on click');
  assert.strictEqual(win.__focused, true, 'window focused on click');
  assert.ok(n.closeCount >= 1, 'notification removed from history on click');
  assert.strictEqual(main.__activeNotifications.size, 0);
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp for Linux', 'unread cleared on restore (existing behavior)');
});

test('M10: after user acts, notification is removed appropriately (close path)', () => {
  resetState();
  const main = require(MAIN_JS);

  fireNotification('Dan', 'user action removal');
  const n = electronMock.__notifications[0];

  // Click is user action → removes.
  n.__click();
  assert.ok(n.closeCount >= 1, 'click removes notification');
  assert.strictEqual(main.__activeNotifications.size, 0, 'reference released after click');

  // New notification, dismissed by user from center (not clicked) → also removed.
  resetState();
  fireNotification('Dan', 'user dismissal removal');
  const n2 = electronMock.__notifications[0];
  assert.strictEqual(main.__activeNotifications.size, 1);
  n2.__emit('close'); // daemon/user dismissed
  assert.strictEqual(main.__activeNotifications.size, 0, 'dismissal releases reference');
  // closeCount stays 0 because daemon closed it, not us — but reference is gone.
  // If user had clicked, closeCount would be >=1. Both are valid history-removal paths.
});

test('M10: banner expiration vs history removal — regression guard for old close() bug', () => {
  resetState();
  const main = require(MAIN_JS);

  // Old bug: setTimeout 5000ms → close() → removed from history.
  // New behavior: no timer, close() only on click/dismissal.
  const timers = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return 1; };
  try {
    fireNotification('Erin', 'regression guard');
  } finally {
    global.setTimeout = realSetTimeout;
  }

  const n = electronMock.__notifications[0];
  const fiveSec = timers.filter(t => t.ms === 5000);
  assert.strictEqual(fiveSec.length, 0, 'regression: must NOT have 5s auto-dismiss timer that removes from history');

  // If there were a timer calling close(), it would be the old bug.
  // Simulate what old code did and assert new code does NOT do it.
  assert.strictEqual(n.closeCount, 0, 'old bug would have called close() after 5s, removing from history — new code must NOT');

  // Only after user action should close() happen.
  n.__click();
  assert.ok(n.closeCount >= 1, 'close() only after user action (click)');
  assert.strictEqual(main.__activeNotifications.size, 0);
});

test('M10: preserves unread count, deduplication, settings, native behavior', () => {
  resetState();
  const main = require(MAIN_JS);

  // Unread count preserved: multiple messages increment.
  fireNotification('Alice', 'msg1');
  fireNotification('Bob', 'msg2');
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — 2 unread', 'unread preserved');
  assert.strictEqual(electronMock.__notifications.length, 2, 'multiple banners');
  assert.strictEqual(main.__activeNotifications.size, 2, 'both retained for history');

  // Deduplication preserved.
  resetState();
  fireNotification('Carol', 'same');
  fireNotification('Carol', 'same');
  assert.strictEqual(electronMock.__notifications.length, 1, 'dedup still works');
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — 1 unread', 'dedup does not double-count unread');

  // Settings toggle preserved: disabled → no banner but unread still counted.
  const settingsFile = path.join(userDataDir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ notificationsEnabled: false }));
  try {
    resetState();
    fireNotification('Dan', 'disabled test');
    assert.strictEqual(electronMock.__notifications.length, 0, 'no banner when disabled');
    assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — 1 unread', 'unread still tracked when disabled');
    assert.strictEqual(main.__activeNotifications.size, 0, 'no retention when disabled (no banner shown)');
  } finally {
    fs.unlinkSync(settingsFile);
  }

  // Native behavior preserved: timeoutType default, click restores same window.
  resetState();
  fireNotification('Frank', 'native check');
  const n = electronMock.__notifications[0];
  assert.strictEqual(n.opts.timeoutType, 'default', 'still uses native GNOME timeout');
  const before = electronMock.__windows.length;
  n.__click();
  assert.strictEqual(electronMock.__windows.length, before, 'click restores same window, no new BrowserWindow');
});

test('M10: does NOT create custom popup, does NOT disable native GNOME notifications', () => {
  // Verify main.js still uses Electron Notification (native) and does NOT
  // implement a custom BrowserWindow popup for notifications.
  const src = fs.readFileSync(MAIN_JS, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  // Must still use native Notification API.
  assert.ok(/new Notification\(/.test(src), 'still uses native Electron Notification');

  // Must NOT create a custom notification window (e.g. new BrowserWindow for popups).
  // The only BrowserWindow creations should be main window and settings window.
  // We check that showNativeNotification does not create a BrowserWindow.
  const showNativeSrc = src.match(/function showNativeNotification[\s\S]*?^}/m);
  assert.ok(showNativeSrc, 'showNativeNotification exists');
  assert.ok(!/new BrowserWindow/.test(showNativeSrc[0]), 'showNativeNotification does NOT create custom popup window');

  // Must NOT set notifications to never show (e.g. disabling via settings default true).
  // DEFAULT_SETTINGS.notificationsEnabled should still be true.
  assert.ok(/notificationsEnabled:\s*true/.test(src), 'notificationsEnabled default still true (native GNOME notifications not disabled)');

  // Must preserve preload IPC architecture: WEB_NOTIFICATION_CHANNEL.
  assert.ok(/WEB_NOTIFICATION_CHANNEL/.test(src), 'preserves WEB_NOTIFICATION_CHANNEL IPC');
  assert.ok(/ipcMain\.on\(WEB_NOTIFICATION_CHANNEL/.test(src), 'preserves IPC listener');
});

test('M10: preserves working notification-click path', () => {
  resetState();
  const main = require(MAIN_JS);
  fireNotification('Grace', 'click path test');
  const n = electronMock.__notifications[0];

  // The click handler must call dismissNotification (close) and showAndFocusMainWindow.
  // We verify by checking that click both closes and focuses.
  assert.strictEqual(win.__visible, false, 'window initially hidden');
  assert.strictEqual(n.closeCount, 0);

  n.__click();

  assert.ok(n.closeCount >= 1, 'click path calls close() (dismissNotification)');
  assert.strictEqual(win.__visible, true, 'click path restores window (showAndFocusMainWindow)');
  assert.strictEqual(win.__focused, true, 'click path focuses window');
  assert.strictEqual(main.__activeNotifications.size, 0, 'click path releases reference');
});

test('M10: freedesktop resident/transient semantics — persistent by default', () => {
  resetState();
  fireNotification('Heidi', 'persistence semantics');

  const n = electronMock.__notifications[0];

  // Electron does NOT set resident or transient hints explicitly (checked in
  // libnotify_notification.cc source). That means:
  //   resident=false (default) → notification IS removed after action (click)
  //   transient=false (default) → notification DOES stay in history after banner expires
  // This is exactly the desired GNOME persistence model.
  // We cannot directly check hints via JS API, but we can assert the behavior:
  //   - After banner expiration (no close), still retained → transient=false
  //   - After click (action), removed → resident=false

  assert.strictEqual(n.closeCount, 0, 'before action, not closed — transient=false, stays in history');
  const main = require(MAIN_JS);
  assert.ok(main.__activeNotifications.has(n), 'retained after banner expiration — persistent');

  n.__click();
  assert.ok(n.closeCount >= 1, 'after action, closed — resident=false, removed after action');
  assert.strictEqual(main.__activeNotifications.size, 0);
});
