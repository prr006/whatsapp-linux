/**
 * M11 — Linux dock / app-icon unread badge regression tests.
 *
 * Runs WITHOUT Electron or a display: loads src/main.js with a mocked
 * `electron` module whose `app` implements the two Linux APIs the feature
 * depends on:
 *
 *   app.setDesktopName(name)  -> Electron sets CHROME_DESKTOP, which becomes
 *                                the `application://<name>` URI in the
 *                                com.canonical.Unity.LauncherEntry.Update
 *                                signal.
 *   app.setBadgeCount(n)      -> Electron 44+ (electron#52895, in 44.0.0/44.3.0)
 *                                emits that signal with
 *                                {"count": n, "count-visible": n != 0}.
 *                                Returns false when the desktop ID cannot be
 *                                resolved.
 *
 * What is asserted here:
 *   1. Desktop identity — the runtime desktop ID carries the `.desktop` suffix
 *      (without it Electron emits `application://whatsapp-linux`, which no dock
 *      can match) and it is set before `ready`, and it agrees with the filename
 *      electron-builder derives from package.json's `desktopName`.
 *   2. Badge state transitions — hidden -> 1 -> 2 -> focus -> 0, show-from-tray
 *      -> 0, focused app -> no bump, duplicates -> no bump, notifications
 *      disabled -> still counted.
 *   3. The badge is derived from the SAME counter as the tray tooltip, so the
 *      two can never disagree (tray behaviour preserved).
 *   4. Delivery is honest: a rejected/unsupported setBadgeCount is recorded,
 *      never thrown, and does not corrupt unread state.
 *   5. Notifications and notification history (M10) are untouched: the badge is
 *      additive, no close() timer is introduced.
 *
 * Run with: node --test test/m11-dock-badge.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-m11-userdata-'));
const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-m11-appdata-'));
const MAIN_JS = path.join(__dirname, '..', 'src', 'main.js');
const REPO_ROOT = path.join(__dirname, '..');

// ---- electron mock -----------------------------------------------------------
const electronMock = {
  __windows: [],
  __mainWindow: null,
  __notifications: [],
  __trayTooltip: null,
  __ipcListeners: {},
  __ipcHandlers: {},
  // M11 instrumentation
  __badgeCalls: [],        // every app.setBadgeCount(count) argument, in order
  __badgeReturnValue: true, // what the mock reports back to main.js
  __desktopNames: [],      // every app.setDesktopName(name) argument, in order
  __order: [],             // relative order of startup-critical calls
  __overlayCalls: [],      // win.setOverlayIcon arguments
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
  setOverlayIcon(overlay) { electronMock.__overlayCalls.push(overlay); }
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
  show() { this.shown = true; this.__emit('show'); }
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
  // M11: Electron 44 Linux badge API. Real implementation returns false when
  // the app's desktop ID cannot be resolved (CHROME_DESKTOP unset); the mock
  // honours __badgeReturnValue so the rejection path is exercisable.
  setBadgeCount(count) {
    electronMock.__badgeCalls.push(count);
    return electronMock.__badgeReturnValue;
  },
  // M11: must be called before `ready`; Electron turns it into CHROME_DESKTOP.
  setDesktopName(name) {
    electronMock.__desktopNames.push(name);
    electronMock.__order.push('setDesktopName');
  },
  getPath(name) {
    if (name === 'userData') return userDataDir;
    if (name === 'appData') return appDataDir;
    return os.tmpdir();
  },
  getAppPath() { return REPO_ROOT; },
  requestSingleInstanceLock() { return true; },
  on(ev, cb) { (this.__handlers[ev] = this.__handlers[ev] || []).push(cb); },
  whenReady() { electronMock.__order.push('whenReady'); return Promise.resolve(); },
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
  delete process.env.APPIMAGE;
  fs.writeFileSync(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify({ closeToTray: true, notificationsEnabled: true, notificationPreview: true })
  );

  Module._load = function (request, ...rest) {
    if (request === 'electron') return electronMock;
    return originalLoad.call(this, request, ...rest);
  };
  main = require(MAIN_JS);
  await new Promise((r) => setImmediate(r));
  win = electronMock.__mainWindow;
  assert.ok(win, 'main window created');
  assert.ok(electronMock.__ipcListeners['wa-web-notification'],
    'wa-web-notification IPC listener registered');
});

after(() => {
  Module._load = originalLoad;
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(appDataDir, { recursive: true, force: true }); } catch {}
});

// ---- helpers -----------------------------------------------------------------

// main.js deduplicates on `title + '|' + body.substring(0, 50)` inside a 3 s
// window (M2), and node:test runs a whole file well inside that window. Every
// message therefore gets a unique sequence suffix unless a test explicitly asks
// for a repeat.
let msgSeq = 0;

function fireRaw(title, body, sender) {
  electronMock.__ipcListeners['wa-web-notification'](
    { sender: sender || win.webContents },
    { title, body, tag: '' }
  );
}

function fireNotification(title, body, sender) {
  fireRaw(title, body + ' #' + (++msgSeq), sender);
}

// Background/hidden app, no pending unread, empty call records.
function resetState() {
  electronMock.__notifications.length = 0;
  electronMock.__badgeCalls.length = 0;
  electronMock.__overlayCalls.length = 0;
  electronMock.__badgeReturnValue = true;
  main.__activeNotifications.clear();
  fs.writeFileSync(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify({ closeToTray: true, notificationsEnabled: true, notificationPreview: true })
  );
  win.__visible = false;
  win.__focused = false;
  win.__emit('focus'); // clears any leftover unread
  electronMock.__badgeCalls.length = 0;
}

function writeSettings(s) {
  fs.writeFileSync(path.join(userDataDir, 'settings.json'), JSON.stringify(s));
}

// Last value we handed to Electron's app.setBadgeCount.
function lastBadge() {
  return electronMock.__badgeCalls[electronMock.__badgeCalls.length - 1];
}

// =============================================================================
// 1. Desktop identity — the precondition for the badge to be reachable at all
// =============================================================================

test('M11: app.setDesktopName is called with the .desktop file ID before ready', () => {
  assert.deepStrictEqual(electronMock.__desktopNames, ['whatsapp-linux.desktop'],
    'setDesktopName called exactly once, with the suffix — Electron builds the ' +
    'launcher-entry URI as "application://" + CHROME_DESKTOP and does NOT add it');
  assert.strictEqual(main.__desktopFileId, 'whatsapp-linux.desktop');

  const dn = electronMock.__order.indexOf('setDesktopName');
  const ready = electronMock.__order.indexOf('whenReady');
  assert.ok(dn !== -1, 'setDesktopName was called');
  assert.ok(ready !== -1, 'whenReady was called');
  assert.ok(dn < ready,
    'setDesktopName must run before app.whenReady() (Electron documents it as ' +
    'a pre-ready API; it is the module top-level that sets CHROME_DESKTOP)');
});

test('M11: the runtime desktop ID matches the .desktop filename electron-builder installs', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.build.linux.syncDesktopName, true,
    'linux.syncDesktopName must stay true so the packaged filename follows desktopName');
  assert.ok(pkg.desktopName, 'package.json desktopName must be set (M9 desktop identity)');

  // Ask the REAL electron-builder (app-builder-lib, the dependency pinned by
  // package.json) what filename it installs, rather than re-deriving the rule
  // here. Skipped only when node_modules is absent.
  let installed = null;
  let usedRealBuilder = false;
  try {
    const { LinuxTargetHelper } = require('app-builder-lib/out/targets/LinuxTargetHelper');
    const packager = {
      platformSpecificBuildOptions: pkg.build.linux,
      info: { metadata: pkg },
      executableName: 'whatsapp-linux',
      appInfo: { productName: pkg.build.productName, sanitizedProductName: 'whatsapp-linux' },
      config: { protocols: null },
      fileAssociations: [],
    };
    installed = LinuxTargetHelper.prototype.getDesktopFileName.call({ packager }) + '.desktop';
    usedRealBuilder = true;

    // The same helper produces StartupWMClass — it must equal the app_id Electron
    // derives from CHROME_DESKTOP (GetXdgAppId() strips the `.desktop` suffix),
    // otherwise the DE will not tie the running window to this launcher entry.
    const entry = await LinuxTargetHelper.prototype.computeDesktopEntry.call(
      { packager, getDescription: () => '' }, {}, null);
    const wmClass = /^StartupWMClass=(.*)$/m.exec(entry);
    assert.ok(wmClass, 'electron-builder emits StartupWMClass');
    assert.strictEqual(wmClass[1], main.__desktopFileId.replace(/\.desktop$/, ''),
      'StartupWMClass === XDG app_id Electron derives from CHROME_DESKTOP');
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
    installed = pkg.desktopName.replace(/\.desktop$/, '') + '.desktop';
  }
  if (require.resolve.paths('app-builder-lib')) {
    // node_modules is present, so the fallback above must not have been taken.
    try { require.resolve('app-builder-lib'); assert.strictEqual(usedRealBuilder, true,
      'electron-builder is installed — the packaged-filename assertion must run ' +
      'through its real getDesktopFileName(), not a re-implementation'); } catch (e) {
      if (e.code !== 'MODULE_NOT_FOUND') throw e;
    }
  }

  assert.strictEqual(main.__desktopFileId, installed,
    'the launcher-entry URI must address the .desktop file the DE actually has ' +
    '(GNOME Shell.App.id is the .desktop filename); a mismatch means the dock ' +
    'can never attribute the badge to this app');

  // The dev-time entry checked into the repo must use the same ID.
  const devDesktop = fs.readFileSync(
    path.join(REPO_ROOT, 'build', 'whatsapp-linux.desktop'), 'utf8');
  const devWmClass = /^StartupWMClass=(.*)$/m.exec(devDesktop);
  assert.ok(devWmClass, 'dev .desktop entry declares StartupWMClass');
  assert.strictEqual(devWmClass[1] + '.desktop', main.__desktopFileId,
    'StartupWMClass + .desktop equals the runtime desktop ID');
});

// =============================================================================
// 2. Badge state transitions
// =============================================================================

test('M11: message arriving while hidden sets the dock badge to 1', () => {
  resetState();
  fireNotification('Alice', 'first message');

  assert.deepStrictEqual(electronMock.__badgeCalls, [1],
    'exactly one app.setBadgeCount(1) — count-visible is derived by Electron');
  assert.strictEqual(main.__getUnreadCount(), 1);
});

test('M11: further messages update the count', () => {
  resetState();
  fireNotification('Alice', 'one');
  fireNotification('Bob', 'two');
  fireNotification('Carol', 'three');

  assert.deepStrictEqual(electronMock.__badgeCalls, [1, 2, 3],
    'the badge tracks each additional unread message');
  assert.strictEqual(main.__getUnreadCount(), 3);
});

test('M11: focusing the window clears the badge', () => {
  resetState();
  fireNotification('Alice', 'unread');
  fireNotification('Bob', 'unread too');
  assert.strictEqual(lastBadge(), 2);

  win.__emit('focus');

  assert.deepStrictEqual(electronMock.__badgeCalls, [1, 2, 0],
    'focus pushes 0 -> Electron sends count-visible=false -> badge hidden');
  assert.strictEqual(main.__getUnreadCount(), 0);
});

test('M11: reopening from the tray clears the badge', () => {
  resetState();
  fireNotification('Alice', 'unread');
  assert.strictEqual(lastBadge(), 1);

  win.__emit('show');

  assert.deepStrictEqual(electronMock.__badgeCalls, [1, 0],
    'show-from-tray clears the badge like focus does');
  assert.strictEqual(main.__getUnreadCount(), 0);
});

test('M11: activation via the shared helper clears the badge exactly once', () => {
  resetState();
  fireNotification('Alice', 'unread');
  assert.strictEqual(lastBadge(), 1);

  // showAndFocusMainWindow() calls restore() -> show() -> focus(); both window
  // events clear unread, so the second one must be a no-op for the dock.
  win.show();
  win.focus();

  assert.deepStrictEqual(electronMock.__badgeCalls, [1, 0],
    'the clear is idempotent — no duplicate count=0 signal');
});

test('M11: no badge while the user is already looking at the app', () => {
  resetState();
  win.__focused = true;
  fireNotification('Alice', 'seen in the open window');

  assert.deepStrictEqual(electronMock.__badgeCalls, [],
    'focused app -> no unread bump -> no badge signal');
  assert.strictEqual(main.__getUnreadCount(), 0);
  assert.strictEqual(electronMock.__notifications.length, 0, 'and no banner either');
});

test('M11: duplicate notifications do not inflate the badge', () => {
  resetState();
  // Deliberately identical payload (bypasses the unique-suffix helper) so the
  // M2 dedup window actually fires.
  fireRaw('Alice', 'same body');
  fireRaw('Alice', 'same body');

  assert.deepStrictEqual(electronMock.__badgeCalls, [1],
    'dedup window suppresses the second notification entirely (M2 behaviour)');
  assert.strictEqual(electronMock.__notifications.length, 1);
});

test('M11: badge still counts when native notifications are disabled by setting', () => {
  resetState();
  writeSettings({ notificationsEnabled: false });
  fireNotification('Alice', 'banners off');
  fireNotification('Bob', 'banners off too');

  assert.deepStrictEqual(electronMock.__badgeCalls, [1, 2],
    'the unread counter is independent of the notification toggle');
  assert.strictEqual(electronMock.__notifications.length, 0, 'no banner shown');
});

test('M11: repeated identical updates do not re-emit (fire-and-forget protocol)', () => {
  resetState();
  fireNotification('Alice', 'one');
  assert.deepStrictEqual(electronMock.__badgeCalls, [1]);

  // Same unread count -> updateDockBadge must short-circuit.
  assert.strictEqual(main.__updateDockBadge('redundant refresh'), null,
    'an unchanged count is not re-pushed');
  assert.deepStrictEqual(electronMock.__badgeCalls, [1]);

  // An explicit push always emits (used by the quit path).
  main.__pushDockBadge(1, 'forced');
  assert.deepStrictEqual(electronMock.__badgeCalls, [1, 1]);
});

test('M11: badge count is always a non-negative integer', () => {
  resetState();
  const pushed = [
    main.__pushDockBadge(0, 'zero'),
    main.__pushDockBadge(-5, 'negative clamped'),
    main.__pushDockBadge(2.7, 'fraction truncated'),
    main.__pushDockBadge(undefined, 'undefined clamped'),
    main.__pushDockBadge(NaN, 'NaN clamped'),
  ];

  assert.deepStrictEqual(pushed.map((p) => p.count), [0, 0, 2, 0, 0],
    'normalised before it ever reaches Electron');
  electronMock.__badgeCalls.forEach((c) => {
    assert.ok(Number.isInteger(c) && c >= 0, 'integer >= 0, got ' + c);
  });
});

// =============================================================================
// 3. Dock badge and tray unread stay in lockstep (tray behaviour preserved)
// =============================================================================

test('M11: dock badge and tray tooltip are derived from the same counter', () => {
  resetState();
  fireNotification('Alice', 'one');
  assert.strictEqual(lastBadge(), 1);
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — 1 unread');

  fireNotification('Bob', 'two');
  assert.strictEqual(lastBadge(), 2);
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — 2 unread');

  win.__emit('focus');
  assert.strictEqual(lastBadge(), 0);
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp for Linux',
    'tray unread behaviour unchanged from M2/M3');
});

test('M11: notification click restores the window and clears the badge, history intact', () => {
  resetState();
  fireNotification('Alice', 'click me');
  const n = electronMock.__notifications[0];
  assert.ok(n, 'banner created');
  assert.strictEqual(lastBadge(), 1);

  // M10 invariant: banner expiration is not removal, so no close() timer.
  assert.strictEqual(n.closeCount, 0, 'no auto-dismiss timer introduced by M11');
  assert.ok(main.__activeNotifications.has(n), 'strong reference retained for GNOME history');

  n.__click();

  assert.strictEqual(n.closeCount, 1, 'click closes (removes from history)');
  assert.strictEqual(main.__activeNotifications.size, 0, 'reference released');
  assert.strictEqual(lastBadge(), 0, 'badge cleared by the focus that follows');
  assert.strictEqual(win.__visible, true, 'window restored');
  assert.strictEqual(win.__focused, true, 'window focused');
});

// =============================================================================
// 4. Delivery honesty — a dock that refuses or a platform that lacks the API
// =============================================================================

test('M11: a rejected setBadgeCount is recorded, not thrown, and unread state survives', () => {
  resetState();
  electronMock.__badgeReturnValue = false; // Electron: desktop ID unresolved
  fireNotification('Alice', 'one');

  assert.strictEqual(main.__getUnreadCount(), 1, 'unread state unaffected');
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — 1 unread', 'tray unaffected');

  const entry = main.__badgeUpdates[main.__badgeUpdates.length - 1];
  assert.strictEqual(entry.count, 1);
  assert.strictEqual(entry.ok, false);
  assert.strictEqual(entry.delivered, false, 'we do not claim the badge was shown');

  // Recovery: once the call succeeds again, the next change is delivered.
  electronMock.__badgeReturnValue = true;
  fireNotification('Bob', 'two');
  const after = main.__badgeUpdates[main.__badgeUpdates.length - 1];
  assert.strictEqual(after.count, 2);
  assert.strictEqual(after.delivered, true);
});

test('M11: every transition is recorded with its reason for the [badge] trace', () => {
  resetState();
  main.__badgeUpdates.length = 0;

  fireNotification('Alice', 'one');
  fireNotification('Bob', 'two');
  win.__emit('focus');

  assert.deepStrictEqual(main.__badgeUpdates.map((u) => u.count), [1, 2, 0]);
  main.__badgeUpdates.forEach((u) => {
    assert.ok(typeof u.reason === 'string' && u.reason.length > 0, 'reason recorded');
    assert.ok(typeof u.at === 'number', 'timestamp recorded');
  });
  assert.ok(main.__badgeUpdates[0].reason.includes('message received'));
  assert.ok(main.__badgeUpdates[2].reason.includes('focused'));
});

test('M11: badge API availability is reported from the running platform', () => {
  const supported = main.__dockBadgeSupported();
  assert.strictEqual(typeof supported, 'boolean');
  if (process.platform === 'linux') {
    assert.strictEqual(supported, true,
      'Electron 44.3.0 is pinned and its app object exposes setBadgeCount on Linux');
  }
});

// =============================================================================
// 5. Quit clears the badge (runs last: sets isQuitting)
// =============================================================================

test('M11: quitting clears a non-zero badge exactly once', () => {
  resetState();
  fireNotification('Alice', 'unread at quit');
  assert.strictEqual(lastBadge(), 1);

  appMock.quit();

  assert.deepStrictEqual(electronMock.__badgeCalls, [1, 0],
    'a single final count=0 so no dock keeps a stale badge');
  const entry = main.__badgeUpdates[main.__badgeUpdates.length - 1];
  assert.strictEqual(entry.count, 0);
  assert.ok(entry.reason.includes('quit'));

  // Quitting again must not spam another signal.
  appMock.quit();
  assert.deepStrictEqual(electronMock.__badgeCalls, [1, 0]);
});
