/**
 * M9 — Linux integration, settings correctness & notification edge cases.
 *
 * Runs WITHOUT Electron or a display: loads src/main.js with a mocked
 * `electron` module and asserts the behaviours added in M9:
 *   - Linux desktop identity config (desktopName / syncDesktopName) that fixes
 *     the electron-builder "desktopName is not set" warning and the
 *     WM_CLASS <-> .desktop association,
 *   - XDG autostart ("Start with system") — file written/removed on toggle,
 *   - Start minimized (hidden to tray) at startup + --start-minimized flag,
 *   - Notification edge cases (focused suppression without unread bump,
 *     multi-message, duplicates, disabled-but-unread, auto-dismiss, click,
 *     tray-reopen clearing unread).
 *
 * Run with:  node --test test/m9-linux-integration.test.js
 *            (or `npm test`, which runs every test/*.test.js file)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-m9-userdata-'));
const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-m9-appdata-'));
const MAIN_JS = path.join(__dirname, '..', 'src', 'main.js');

// ---- electron mock -----------------------------------------------------------
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
      on: (ev, cb) => {
        wc.__handlers[ev] = (wc.__handlers[ev] || []).concat([cb]);
      },
      __emit: (ev, ...args) => {
        (wc.__handlers[ev] || []).slice().forEach((cb) => cb(...args));
      },
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

class MockTray {
  constructor() { }
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
  delete process.env.APPIMAGE; // deterministic Exec path in autostart tests
  // "Start minimized" is on from the very first launch, so the created window
  // must stay hidden after ready-to-show (asserted in the first test).
  fs.writeFileSync(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify({ startMinimized: true })
  );

  Module._load = function (request, ...rest) {
    if (request === 'electron') return electronMock;
    return originalLoad.call(this, request, ...rest);
  };
  require(MAIN_JS);
  await new Promise((r) => setImmediate(r));
  win = electronMock.__mainWindow;
  assert.ok(win, 'main window created');
  assert.ok(electronMock.__ipcListeners['wa-web-notification'],
    'wa-web-notification IPC listener registered (real Electron entry point)');
  assert.ok(win.opts.webPreferences && /preload\.js$/.test(win.opts.webPreferences.preload),
    'main window loads src/preload.js (installs the Notification shim)');
});

after(() => {
  Module._load = originalLoad;
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(appDataDir, { recursive: true, force: true }); } catch {}
});

// Drive the REAL entry point: the 'wa-web-notification' IPC message that
// src/preload.js sends from its main-world `window.Notification` shim.
// (Electron's webContents has no 'notification' event — the old harness
// fabricated one and masked the bug.)
function fireNotification(title, body, sender) {
  electronMock.__ipcListeners['wa-web-notification'](
    { sender: sender || win.webContents },
    { title, body, tag: '' }
  );
}

// Reset the shared notification state (banner list, window hidden/unfocused,
// any leftover unread, and the M9-bugfix active-notification references) so
// each test starts from a clean slate.
function resetState() {
  electronMock.__notifications.length = 0;
  require(MAIN_JS).__activeNotifications.clear();
  win.__visible = false;
  win.__focused = false;
  win.__emit('focus'); // focus handler clears unread if it was > 0
}

// ---- 1. Linux desktop identity (packaging warning fix) ----------------------

test('desktop integration: package.json carries a consistent desktopName / syncDesktopName', () => {
  const pkg = require(path.join(__dirname, '..', 'package.json'));
  assert.strictEqual(pkg.desktopName, 'whatsapp-linux',
    'desktopName must be set (fixes the electron-builder warning and WM_CLASS association)');
  assert.strictEqual(pkg.build.linux.syncDesktopName, true,
    'linux.syncDesktopName must be true so the .desktop filename follows desktopName');
  // Electron derives app_id (=> WM_CLASS) from desktopName; the installed
  // .desktop filename and StartupWMClass must match it. Keep the identity
  // aligned with the executable/icon name.
  assert.strictEqual(pkg.desktopName, pkg.name,
    'desktopName matches package name so Exec/icon/desktop stay aligned');
  const template = fs.readFileSync(
    path.join(__dirname, '..', 'build', 'whatsapp-linux.desktop'), 'utf8');
  assert.match(template, /StartupWMClass=whatsapp-linux/,
    'dev .desktop template StartupWMClass matches desktopName');
  assert.match(template, /Exec=whatsapp-linux/,
    'dev .desktop template Exec matches the executable name');
});

// ---- 2. Start minimized -----------------------------------------------------

test('start minimized: window stays hidden after ready-to-show', () => {
  // The window was created with startMinimized=true (see before()).
  assert.strictEqual(win.__visible, false, 'window not shown before ready-to-show');
  win.__emit('ready-to-show');
  assert.strictEqual(win.__visible, false, 'window hidden to tray after ready-to-show');
});

test('start minimized: shouldStartHidden reflects setting and flag', () => {
  const main = require(MAIN_JS);
  assert.strictEqual(main.__shouldStartHidden({ startMinimized: true }), true);
  assert.strictEqual(main.__shouldStartHidden({ startMinimized: false }), false);
  assert.strictEqual(main.__shouldStartHidden({}), false);
  assert.strictEqual(main.__startHiddenOverride, false,
    'no --start-minimized/--hidden flag in this process');
});

test('start minimized: --start-minimized flag overrides the setting', () => {
  // Boot a fresh copy of main.js in a child with --start-minimized in argv
  // (a real `node -e 'code' --start-minimized` puts the flag into argv[1..]).
  const mockSrc = `
    ({ app: {
         isPackaged: false, setName() {},
         getPath() { return '/tmp/wa-m9-flag'; },
         getAppPath() { return '/app'; },
         requestSingleInstanceLock() { return true; },
         on() {},
         whenReady() { return new Promise(() => {}); },
         quit() {}
       },
       BrowserWindow: class {},
       Tray: class {},
       Menu: { buildFromTemplate: (t) => t },
       dialog: {},
       shell: { openExternal() {} },
       Notification: class {},
       ipcMain: { handle() {}, on() {} },
       nativeImage: {
         createFromPath: () => ({ isEmpty: () => false }),
         createFromBuffer: () => ({ isEmpty: () => false }),
         createEmpty: () => ({ isEmpty: () => true })
       } })`;
  const snippet = `
    const Module = require('module');
    const orig = Module._load;
    const electronMock = ${mockSrc};
    Module._load = function (req, ...rest) {
      if (req === 'electron') return electronMock;
      return orig.call(this, req, ...rest);
    };
    const main = require(${JSON.stringify(MAIN_JS)});
    console.log('FLAG_RESULT:' + JSON.stringify({
      override: main.__startHiddenOverride,
      hiddenWhenOff: main.__shouldStartHidden({ startMinimized: false })
    }));`;

  const res = spawnSync(process.execPath, ['-e', snippet, '--', '--start-minimized'], {
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.strictEqual(res.status, 0, 'child booted main.js cleanly: ' + (res.stderr || ''));
  const line = res.stdout.split('\n').find((l) => l.startsWith('FLAG_RESULT:'));
  assert.ok(line, 'child reported the flag result');
  const parsed = JSON.parse(line.slice('FLAG_RESULT:'.length));
  assert.strictEqual(parsed.override, true, '--start-minimized flag recognized at startup');
  assert.strictEqual(parsed.hiddenWhenOff, true, 'flag overrides a false setting');
});

// ---- 3. Start with system (XDG autostart) ----------------------------------

test('start with system: autostart entry written and removed', () => {
  const main = require(MAIN_JS);
  const desktopFile = path.join(appDataDir, 'autostart', 'whatsapp-linux.desktop');

  assert.strictEqual(main.__getAutostartDesktopPath(), desktopFile);
  assert.ok(main.__getAutostartExec().includes(process.execPath),
    'autostart Exec points at the real binary path');

  assert.strictEqual(main.__setStartWithSystem(true), true);
  assert.ok(fs.existsSync(desktopFile), 'autostart .desktop created');
  const content = fs.readFileSync(desktopFile, 'utf8');
  assert.match(content, /^\[Desktop Entry\]/m);
  assert.match(content, /^Type=Application$/m);
  assert.match(content, /^Exec=/m);
  assert.match(content, /X-GNOME-Autostart-enabled=true/);
  assert.ok(content.includes(process.execPath), 'Exec contains the dev binary path');

  assert.strictEqual(main.__setStartWithSystem(false), true);
  assert.ok(!fs.existsSync(desktopFile), 'autostart .desktop removed');
});

test('start with system: settings IPC applies the toggle immediately', () => {
  const setSettings = electronMock.__ipcHandlers['set-settings'];
  assert.ok(setSettings, 'set-settings IPC handler registered');
  const desktopFile = path.join(appDataDir, 'autostart', 'whatsapp-linux.desktop');

  setSettings(null, { startWithSystem: true });
  assert.ok(fs.existsSync(desktopFile), 'enabling the setting writes the autostart entry');

  setSettings(null, { startWithSystem: false });
  assert.ok(!fs.existsSync(desktopFile), 'disabling the setting removes the autostart entry');
});

// ---- 4. Notification edge cases --------------------------------------------

test('notification: focused app shows no banner and does not bump unread', () => {
  resetState();
  win.__visible = true;
  win.__focused = true;
  fireNotification('Alice', 'hello there');
  assert.strictEqual(electronMock.__notifications.length, 0, 'no banner while focused');
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp for Linux',
    'unread NOT bumped while the chat is already visible');
});

test('notification: multiple distinct messages behave sensibly (one banner + one unread each)', () => {
  resetState();
  fireNotification('Alice', 'first message');
  fireNotification('Bob', 'second message');
  assert.strictEqual(electronMock.__notifications.length, 2, 'two banners for two senders');
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — 2 unread');
});

test('notification: duplicate within the dedup window stays fully suppressed', () => {
  resetState();
  fireNotification('Carol', 'same message twice');
  fireNotification('Carol', 'same message twice');
  assert.strictEqual(electronMock.__notifications.length, 1, 'one banner only');
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — 1 unread',
    'duplicate does not double-count unread');
});

test('notification: disabled banners preserve unread; focus clears it', () => {
  const settingsFile = path.join(userDataDir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ notificationsEnabled: false }));
  try {
    resetState();
    fireNotification('Dan', 'unique disabled message');
    assert.strictEqual(electronMock.__notifications.length, 0, 'no banner when disabled');
    assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — 1 unread',
      'unread still tracked for the tray badge');
    win.__emit('focus');
    assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp for Linux',
      'focus clears unread');
  } finally {
    fs.unlinkSync(settingsFile);
  }
});

test('notification: banner expires naturally but stays in history and keeps unread (M10)', () => {
  resetState();
  const main = require(MAIN_JS);
  const timers = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return 1; };
  try {
    fireNotification('Erin', 'banner expiration test');
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.strictEqual(electronMock.__notifications.length, 1);
  // M10: no auto-dismiss timer — GNOME handles banner timeout.
  const closeTimers = timers.filter(t => t.ms === 5000);
  assert.strictEqual(closeTimers.length, 0, 'M10: no 5s auto-dismiss timer (banner expires naturally)');
  const n = electronMock.__notifications[0];
  assert.strictEqual(n.closeCount, 0, 'banner expiration does NOT call close() — stays in history');
  assert.ok(main.__activeNotifications.has(n), 'retained for history after banner expiration');
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — 1 unread',
    'unread persists after banner expiration (still in history)');
});

test('notification: click restores and focuses the existing window, clearing unread', () => {
  resetState();
  fireNotification('Frank', 'click me');
  assert.strictEqual(electronMock.__notifications.length, 1);
  const n = electronMock.__notifications[0];
  const windowsBefore = electronMock.__windows.length;
  n.__click();
  assert.ok(n.closeCount >= 1, 'click dismisses the banner');
  assert.strictEqual(win.__visible, true, 'window restored');
  assert.strictEqual(win.__focused, true, 'window focused');
  assert.strictEqual(electronMock.__windows.length, windowsBefore, 'no new window created');
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp for Linux', 'unread cleared on restore');
});

test('notification: tray reopen (show) clears unread state', () => {
  resetState();
  fireNotification('Grace', 'tray reopen test');
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — 1 unread');
  win.show(); // mock emits 'show', matching the tray "Show WhatsApp" path
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp for Linux', 'unread cleared on show');
});

// ---- 5. M9 bugfix: Linux notification click + dismissal --------------------

// The mocked tests previously only verified that a click handler was attached
// and would fire when invoked manually — they never proved the Notification
// object stays alive long enough for Electron (libnotify) to deliver the real
// click. Electron's Notification wrapper holds only a WeakPtr to the native
// notification; once the JS object is collected, Electron clears the native
// delegate and `click` stops reaching JS. These tests pin the retention fix.

test('notification (bugfix): live notification is retained against GC until dismissed', () => {
  resetState();
  const main = require(MAIN_JS);
  fireNotification('Hank', 'retain me');
  assert.strictEqual(main.__activeNotifications.size, 1,
    'exactly one live notification is retained');
  const n = electronMock.__notifications[0];
  assert.strictEqual(main.__activeNotifications.has(n), true,
    'the retained object is the shown notification');
});

test('notification (bugfix): click still restores/focuses the same window and releases the reference', () => {
  resetState();
  const main = require(MAIN_JS);
  fireNotification('Frank', 'click me after being retained');
  const n = electronMock.__notifications[0];
  const windowsBefore = electronMock.__windows.length;
  n.__click();
  assert.ok(n.closeCount >= 1, 'click dismisses the banner');
  assert.strictEqual(win.__visible, true, 'window restored');
  assert.strictEqual(win.__focused, true, 'window focused');
  assert.strictEqual(electronMock.__windows.length, windowsBefore, 'no new window created');
  assert.strictEqual(main.__activeNotifications.size, 0,
    'click releases the retained reference');
});

test('notification (bugfix): banner expiration keeps reference, close releases it (M10)', () => {
  resetState();
  const main = require(MAIN_JS);
  const timers = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return 1; };
  try {
    fireNotification('Ivy', 'banner expiration retains');
  } finally {
    global.setTimeout = realSetTimeout;
  }
  const n = electronMock.__notifications[0];
  assert.strictEqual(main.__activeNotifications.has(n), true,
    'retained while banner visible and after expiration (in history)');
  const closeTimers = timers.filter(t => t.ms === 5000);
  assert.strictEqual(closeTimers.length, 0, 'M10: no auto-dismiss timer');
  // Simulate GNOME banner expiration: banner hides but notification stays in center.
  // No close() called, reference still held.
  assert.strictEqual(n.closeCount, 0, 'banner expiration does NOT call close()');
  assert.strictEqual(main.__activeNotifications.size, 1, 'still retained after banner expiration');
  // Now user dismisses from center (daemon emits close) -> reference released.
  n.__emit('close');
  assert.strictEqual(main.__activeNotifications.size, 0,
    'daemon/user close releases the retained reference');
});

test('notification (bugfix): daemon/user close event releases the reference', () => {
  resetState();
  const main = require(MAIN_JS);
  fireNotification('Jack', 'the daemon dismisses me');
  const n = electronMock.__notifications[0];
  assert.strictEqual(main.__activeNotifications.has(n), true);
  n.__emit('close'); // daemon/user dismissed it (Electron emits 'close' on libnotify close)
  assert.strictEqual(main.__activeNotifications.size, 0,
    'close event releases the retained reference');
});

test('notification (bugfix): Linux options use timeoutType default (GNOME handles timeout)', () => {
  resetState();
  fireNotification('Kai', 'timeout option check');
  const n = electronMock.__notifications[0];
  assert.strictEqual(n.opts.timeoutType, 'default',
    'Electron Linux only supports default/never; GNOME handles ~5s banner timeout, notification stays in history');
});

// ---- M9 root-cause regression: real delivery path ---------------------------
//
// The banners on the real desktop were WhatsApp Web's OWN `new Notification()`
// rendered by Chromium; Electron delivers their click to the renderer, not to
// the main process, and `webContents` has no 'notification' event. The fix is
// a main-world `window.Notification` shim in src/preload.js that forwards to
// the 'wa-web-notification' IPC channel. These tests pin both halves.

test('notification (root cause): main.js does NOT rely on a webContents "notification" event', () => {
  // Strip comments so the check applies to executable code only.
  const src = fs.readFileSync(MAIN_JS, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/webContents\.on\(\s*['"]notification['"]/.test(src),
    "webContents has no 'notification' event in Electron 44 — handler would be dead code");
  assert.ok(/ipcMain\.on\(\s*WEB_NOTIFICATION_CHANNEL/.test(src),
    'notifications must arrive over the wa-web-notification IPC channel');
});

test('notification (root cause): IPC from a foreign sender is ignored', () => {
  resetState();
  const main = require(MAIN_JS);
  fireNotification('Mallory', 'not from the WhatsApp window', { id: 'other-webcontents' });
  assert.strictEqual(electronMock.__notifications.length, 0, 'no banner for foreign sender');
  assert.strictEqual(main.__activeNotifications.size, 0);
  assert.notStrictEqual(electronMock.__trayTooltip, 'WhatsApp — 1 unread', 'no unread bump for foreign sender');
});

test('notification (root cause): preload shim intercepts window.Notification and forwards title/body over IPC', () => {
  const vm = require('vm');
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');

  // Fake page world.
  const sent = [];
  const exposed = {};
  class FakeNativeNotification {
    constructor() { throw new Error('native Notification must NOT be constructed'); }
    static get permission() { return 'granted'; }
    static requestPermission() { return Promise.resolve('granted'); }
    static get maxActions() { return 2; }
  }
  const pageWindow = { Notification: FakeNativeNotification, setTimeout: (fn) => fn() };
  pageWindow.window = pageWindow;
  pageWindow.Event = class { constructor(type) { this.type = type; } };
  const pageCtx = vm.createContext(pageWindow);

  // Fake isolated (preload) world with the electron renderer modules.
  const electronRenderer = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        exposed[name] = value;
        pageWindow[name] = value; // what contextBridge does for the page
      }
    },
    ipcRenderer: { send(channel, payload) { sent.push({ channel, payload }); } },
    webFrame: { executeJavaScript(code) { return vm.runInContext(code, pageCtx); } }
  };
  const m = new Module(path.join(__dirname, '..', 'src', 'preload.js'));
  m.filename = m.id;
  m.paths = [];
  const origLoad = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'electron') return electronRenderer;
    return origLoad.call(this, req, ...rest);
  };
  try {
    m._compile(preloadSrc, m.id);
  } finally {
    Module._load = origLoad;
  }

  assert.strictEqual(typeof exposed.__whatsappLinuxNotify, 'function', 'bridge function exposed');
  assert.notStrictEqual(pageWindow.Notification, FakeNativeNotification, 'Notification global replaced');
  assert.strictEqual(pageWindow.Notification.__whatsappLinuxShim, true);
  assert.strictEqual(pageWindow.Notification.permission, 'granted', 'permission delegated to native');

  // What WhatsApp Web does:
  const n = vm.runInContext(
    "new Notification('Alice', { body: 'hello from the page', tag: 'chat-1' })", pageCtx);
  assert.strictEqual(sent.length, 1, 'exactly one IPC message');
  assert.deepStrictEqual(sent[0], {
    channel: 'wa-web-notification',
    payload: { title: 'Alice', body: 'hello from the page', tag: 'chat-1' }
  });
  assert.strictEqual(typeof n.close, 'function', 'stub keeps the Notification surface');
  n.close();

  // Bad input must never throw into the page.
  vm.runInContext("new Notification(undefined, { body: 42 })", pageCtx);
  assert.strictEqual(sent[1].payload.title, '');
  assert.strictEqual(sent[1].payload.body, '');
});
