/**
 * M11 — dock badge must survive a tray-init failure (isolated regression test).
 *
 * Before M11, `updateUnreadIndicator()` began with `if (!tray) return;`, so any
 * failure in `createTray()` (missing icon, no AppIndicator/status-notifier host,
 * a compositor without a tray) silently disabled EVERY unread indicator — the
 * tray tooltip, the window overlay and, had it existed, the dock badge.
 *
 * The dock badge is now pushed before the tray is touched, so a broken tray
 * degrades only the tray. This test runs in its own process (node --test runs
 * each file separately) so it can load src/main.js with a Tray constructor that
 * throws, without disturbing the shared instance in m11-dock-badge.test.js.
 *
 * Run with: node --test test/m11-dock-badge-no-tray.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-m11-notray-userdata-'));
const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-m11-notray-appdata-'));
const MAIN_JS = path.join(__dirname, '..', 'src', 'main.js');

const electronMock = {
  __windows: [],
  __mainWindow: null,
  __notifications: [],
  __trayTooltip: null,
  __badgeCalls: [],
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
  show() { this.shown = true; }
  close() { this.closeCount++; }
  __emit(ev, ...args) { (this.__handlers[ev] || []).forEach((cb) => cb(...args)); }
  __click() { this.__emit('click'); }
}

// Tray creation always fails -> main.js catches and leaves `tray === null`.
class BrokenTray {
  constructor() { throw new Error('no status-notifier host available'); }
}

const appMock = {
  isPackaged: false,
  __handlers: {},
  setName() {},
  setBadgeCount(count) { electronMock.__badgeCalls.push(count); return true; },
  setDesktopName() {},
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
electronMock.Tray = BrokenTray;
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
  assert.ok(win, 'main window created even though the tray failed');
});

after(() => {
  Module._load = originalLoad;
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(appDataDir, { recursive: true, force: true }); } catch {}
});

test('M11: tray init failure must not disable the dock badge', () => {
  assert.strictEqual(electronMock.__trayTooltip, null, 'no tray exists to have a tooltip');

  win.__visible = false;
  win.__focused = false;

  electronMock.__ipcListeners['wa-web-notification'](
    { sender: win.webContents }, { title: 'Alice', body: 'no tray here', tag: '' });
  electronMock.__ipcListeners['wa-web-notification'](
    { sender: win.webContents }, { title: 'Bob', body: 'still no tray', tag: '' });

  assert.deepStrictEqual(electronMock.__badgeCalls, [1, 2],
    'the dock badge updates even when tray === null (the old `if (!tray) return;` ' +
    'guard would have suppressed it)');
  assert.strictEqual(main.__getUnreadCount(), 2);
  assert.strictEqual(electronMock.__notifications.length, 2, 'banners still shown');

  win.__emit('focus');
  assert.deepStrictEqual(electronMock.__badgeCalls, [1, 2, 0], 'and still clears on focus');
});
