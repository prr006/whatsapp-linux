/**
 * M7 lifecycle smoke test — runs WITHOUT Electron or a display.
 *
 * It loads src/main.js with a mocked `electron` module and exercises the
 * changed code paths (Part 1 notification UX + Part 2 lifecycle fixes) so the
 * logic is verified even though a real GUI launch is impossible in this sandbox
 * (no Electron binary, no display server, no web.whatsapp.com route).
 *
 * Run with:  node --test test/m7-lifecycle.test.js
 *
 * IMPORTANT: tests are order-dependent by design (single shared main-process
 * state). The close-to-tray test must run before the quit test.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-m7-test-'));

// ---- electron mock -----------------------------------------------------------
const electronMock = {
  __windows: [],
  __mainWindow: null,
  __notifications: [],
  __quitCalls: 0,
  __menuTemplate: null,
  __tray: null,
  __trayTooltip: null,
  __notificationHandler: null,
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
    this.webContents = {
      on: (ev, cb) => {
        if (ev === 'notification') electronMock.__notificationHandler = cb;
      },
      setWindowOpenHandler: () => {},
    };
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
  show() { this.shown = true; }
  close() { this.closeCount++; }
  __click() { (this.__handlers['click'] || []).forEach((cb) => cb()); }
}

class MockTray {
  constructor() { electronMock.__tray = this; }
  setToolTip(s) { electronMock.__trayTooltip = s; }
  setContextMenu(m) { electronMock.__menuTemplate = m; }
  on() {}
}

const appMock = {
  isPackaged: false,
  __handlers: {},
  setName() {},
  getPath() { return userDataDir; },
  requestSingleInstanceLock() { return true; },
  on(ev, cb) { (this.__handlers[ev] = this.__handlers[ev] || []).push(cb); },
  whenReady() { return Promise.resolve(); },
  // Mimic Electron: quit() fires 'before-quit' before closing windows.
  quit() {
    electronMock.__quitCalls++;
    (this.__handlers['before-quit'] || []).forEach((cb) => cb());
  },
};

electronMock.app = appMock;
electronMock.BrowserWindow = MockBrowserWindow;
electronMock.Tray = MockTray;
electronMock.Menu = { buildFromTemplate(t) { return t; } };
electronMock.Notification = MockNotification;
electronMock.ipcMain = { handle() {} };
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
  require(path.join(__dirname, '..', 'src', 'main.js'));
  // Flush the whenReady().then() microtask so createWindow/createTray run.
  await new Promise((r) => setImmediate(r));
  win = electronMock.__mainWindow;
  assert.ok(win, 'main window created');
  assert.ok(electronMock.__notificationHandler, 'notification handler registered');
});

after(() => {
  Module._load = originalLoad;
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
});

function fireNotification(title, body) {
  let prevented = false;
  electronMock.__notificationHandler(
    { preventDefault: () => { prevented = true; } },
    { title, body }
  );
  assert.ok(prevented, 'web notification default must be prevented');
}

test('close-to-tray: X hides the window instead of closing it', () => {
  win.__visible = true;
  let prevented = false;
  win.__handlers['close'][0]({ preventDefault: () => { prevented = true; } });
  assert.strictEqual(prevented, true, 'close must be intercepted');
  assert.strictEqual(win.__visible, false, 'window hidden to tray');
  assert.strictEqual(win.__destroyed, false, 'window NOT destroyed (WebView alive)');
});

test('notification: suppressed when the app is already focused', () => {
  win.__visible = true;
  win.__focused = true;
  const before = electronMock.__notifications.length;
  fireNotification('Alice', 'hello there');
  assert.strictEqual(electronMock.__notifications.length, before, 'no banner while focused');
});

test('notification: shown when hidden; click restores + focuses the SAME window', () => {
  win.__visible = false;
  win.__focused = false;
  electronMock.__notifications.length = 0;

  // Capture the auto-dismiss timer instead of waiting 5s.
  const timers = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return 1; };
  try {
    fireNotification('Bob', 'meeting at 5');
  } finally {
    global.setTimeout = realSetTimeout;
  }

  assert.strictEqual(electronMock.__notifications.length, 1);
  const n = electronMock.__notifications[0];
  assert.strictEqual(n.shown, true, 'notification shown');
  assert.strictEqual(timers.length, 1, 'one auto-dismiss timer scheduled');
  assert.strictEqual(timers[0].ms, 5000, 'auto-dismiss at the ~5s default');
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — 1 unread', 'unread bumped while hidden');

  // Auto-dismiss fires -> close() is called (notification no longer visible).
  timers[0].fn();
  assert.ok(n.closeCount >= 1, 'auto-dismiss calls close()');

  // Click -> dismiss again (idempotent) + restore/focus the existing window.
  const windowsBefore = electronMock.__windows.length;
  n.__click();
  assert.ok(n.closeCount >= 2, 'click calls close()');
  assert.strictEqual(win.__visible, true, 'window restored');
  assert.strictEqual(win.__focused, true, 'window focused');
  assert.strictEqual(electronMock.__windows.length, windowsBefore, 'no new window created');
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp for Linux', 'unread cleared on restore');
});

test('notification: duplicate within the dedup window is suppressed', () => {
  win.__visible = false;
  win.__focused = false;
  electronMock.__notifications.length = 0;
  fireNotification('Carol', 'same message twice');
  fireNotification('Carol', 'same message twice');
  assert.strictEqual(electronMock.__notifications.length, 1, 'only one banner for duplicates');
});

test('notification: disabled by setting -> no banner, unread still counted', () => {
  fs.writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify({ notificationsEnabled: false }));
  win.__visible = false;
  win.__focused = false;
  electronMock.__notifications.length = 0;
  fireNotification('Dan', 'unique disabled message');
  assert.strictEqual(electronMock.__notifications.length, 0, 'no banner when disabled');
  assert.ok(electronMock.__trayTooltip.includes('unread'), 'unread still tracked for tray badge');
  fs.unlinkSync(path.join(userDataDir, 'settings.json'));
});

test('second instance: focuses existing window, no new BrowserWindow', () => {
  const before = electronMock.__windows.length;
  electronMock.app.__handlers['second-instance'][0]();
  assert.strictEqual(electronMock.__windows.length, before, 'no second window');
  assert.strictEqual(win.__visible, true, 'window shown');
  assert.strictEqual(win.__focused, true, 'window focused');
});

// Must run LAST: sets isQuitting=true via the before-quit path.
test('tray Quit: before-quit lets the window close (regression guard)', () => {
  const quitItem = electronMock.__menuTemplate.find((i) => i.label === 'Quit');
  assert.ok(quitItem, 'tray Quit item exists');
  quitItem.click();
  assert.strictEqual(electronMock.__quitCalls, 1, 'app.quit called');

  let prevented = false;
  win.__handlers['close'][0]({ preventDefault: () => { prevented = true; } });
  assert.strictEqual(prevented, false, 'close must NOT be intercepted during quit');
});
