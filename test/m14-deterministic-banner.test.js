/**
 * M14 — deterministic banner governor: policy unit tests, extension
 * source contracts, and app-side installer tests.
 *
 * (The real 50.1 banner state machine + real extension behavior tests
 * live in test/m14-gnome501-simulation.test.js.)
 *
 * Run with: node --test test/m14-deterministic-banner.test.js
 */

const { test, before } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const POLICY_JS = path.join(ROOT, 'gnome-extension', 'policy.js');
const EXTENSION_JS = path.join(ROOT, 'gnome-extension', 'extension.js');
const METADATA_JSON = path.join(ROOT, 'gnome-extension', 'metadata.json');
const MAIN_JS = path.join(ROOT, 'src', 'main.js');
const PKG_JSON = path.join(ROOT, 'package.json');
const INSTALL_SH = path.join(ROOT, 'scripts', 'install-gnome-extension.sh');

// ---------------------------------------------------------------------------
// 1. policy.js — the governor decision logic (real code, unit-tested)
// ---------------------------------------------------------------------------

let P;
before(async () => {
  P = await import(POLICY_JS);
});

test('M14/policy: out-of-scope banners are pure passthrough (no app may be affected)', () => {
  const d1 = P.governorDecision({ inScope: false, requestedMs: 4000, deadlineMs: undefined, nowMs: 1000 });
  assert.deepStrictEqual(d1, { kind: 'passthrough', ms: 4000 });
  const d2 = P.governorDecision({ inScope: false, requestedMs: 0, deadlineMs: 99999, nowMs: 1000 });
  assert.deepStrictEqual(d2, { kind: 'passthrough', ms: 0 });
});

test('M14/policy: first positive arm establishes the fixed ~5 s deadline', () => {
  const d = P.governorDecision({ inScope: true, requestedMs: 4000, deadlineMs: undefined, nowMs: 1000 });
  assert.strictEqual(d.kind, 'establish');
  assert.strictEqual(d.ms, 5000);
  assert.strictEqual(d.deadlineMs, 6000, 'deadline = now + BANNER_TIMEOUT_MS (5000)');
  assert.strictEqual(P.BANNER_TIMEOUT_MS, 5000);
});

test('M14/policy: every later arm converges on the SAME deadline (no interaction can move the expiry)', () => {
  const deadline = 6000;
  // Show completion arm, then idle->active re-arm, then pointer re-arm,
  // then hover refresh — each must fire at t=6000, never later.
  const arms = [
    { atMs: 1000, requestedMs: 4000 },
    { atMs: 3000, requestedMs: 2000 },
    { atMs: 5000, requestedMs: 1000 },
    { atMs: 5900, requestedMs: 1000 }
  ];
  const { fires, expired } = P.simulateArms({ inScope: true, nowMs: 0, arms });
  assert.strictEqual(fires.length, arms.length);
  for (const f of fires) {
    assert.ok(f, 'arm produced a timer');
    assert.strictEqual(f.atMs, deadline, 'each re-arm still fires at the original deadline');
  }
  assert.strictEqual(expired, false);
});

test('M14/policy: a re-arm arriving at/after the deadline expires the banner now (no fresh interval)', () => {
  const d = P.governorDecision({ inScope: true, requestedMs: 1000, deadlineMs: 6000, nowMs: 6000 });
  assert.strictEqual(d.kind, 'expire-now');
  const dLate = P.governorDecision({ inScope: true, requestedMs: 1000, deadlineMs: 6000, nowMs: 6500 });
  assert.strictEqual(dLate.kind, 'expire-now');
});

test('M14/policy: clear requests (timeout 0) always pass through for governed banners', () => {
  const d = P.governorDecision({ inScope: true, requestedMs: 0, deadlineMs: 6000, nowMs: 3000 });
  assert.deepStrictEqual(d, { kind: 'passthrough', ms: 0 });
});

test('M14/policy: adversarial re-arm storm can never push expiry past the deadline', () => {
  const arms = [];
  for (let t = 1000; t <= 6000; t += 250) arms.push({ atMs: t, requestedMs: 1000 });
  const { fires, expired } = P.simulateArms({ inScope: true, nowMs: 0, arms });
  // All arms before the deadline converge onto it; the arm at the deadline
  // triggers expire-now. Either way: nothing fires past the deadline.
  for (const f of fires) {
    if (f) assert.ok(f.atMs <= 6000, `fire at ${f.atMs} never exceeds the deadline`);
  }
  assert.strictEqual(expired, true, 'deadline reached -> expire-now, not another 1000 ms');
});

test('M14/policy: scoping matches only the whatsapp-linux desktop app id', () => {
  assert.strictEqual(P.isScopedSource({ app: { get_id: () => 'whatsapp-linux' } }), true);
  assert.strictEqual(P.isScopedSource({ app: { get_id: () => 'org.example.Other' } }), false);
  assert.strictEqual(P.isScopedSource({ app: null }), false, 'unresolved desktop entry -> not governed');
  assert.strictEqual(P.isScopedSource(null), false);
  assert.strictEqual(P.isScopedSource({}), false);
  // Defensive: a broken source must not throw out of the governor.
  assert.strictEqual(P.isScopedSource({ app: { get_id() { throw new Error('boom'); } } }), false);
  assert.deepStrictEqual([...P.MATCHED_APP_IDS], ['whatsapp-linux']);
});

// ---------------------------------------------------------------------------
// 2. extension.js — source contracts (the real file, checked statically)
// ---------------------------------------------------------------------------

test('M14/extension: parses as an ES module (GNOME 49/50 extension format)', () => {
  for (const f of [EXTENSION_JS, POLICY_JS]) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }),
      `node --check failed for ${f}`);
  }
});

test('M14/extension: uses the shell-supported InjectionManager for the banner choke points and restores on disable', () => {
  const src = fs.readFileSync(EXTENSION_JS, 'utf8');
  assert.match(src, /InjectionManager/, 'imports/uses the shell\'s supported override API');
  assert.match(src, /new InjectionManager\(\)/);
  assert.match(src, /overrideMethod\(proto, '_showNotification'/);
  assert.match(src, /overrideMethod\(proto, '_updateNotificationTimeout'/);
  assert.match(src, /overrideMethod\(proto, '_hideNotificationCompleted'/,
    'hide-completion wrap exists (logging only)');
  assert.match(src, /this\._injection\.clear\(\)/, 'disable() restores the originals');
  assert.match(src, /resource:\/\/\/org\/gnome\/shell\/ui\/messageTray\.js/);
  assert.match(src, /resource:\/\/\/org\/gnome\/shell\/extensions\/extension\.js/);
  assert.match(src, /export default class/);
  // The hide wrap must call the original (behavior preserved) and only log.
  const hideWrap = src.split("overrideMethod(proto, '_hideNotificationCompleted'")[1] || '';
  assert.match(hideWrap, /original\.call\(this\)/, 'original hide completion always runs');
});

test('M14/extension: history-safety — never destroys/closes notifications, never emits close signals', () => {
  const src = fs.readFileSync(EXTENSION_JS, 'utf8');
  assert.doesNotMatch(src, /\.destroy\(/, 'no notification destruction');
  assert.doesNotMatch(src, /CloseNotification/, 'no D-Bus CloseNotification traffic');
  assert.doesNotMatch(src, /NotificationClosed/, 'no close-signal involvement');
  assert.doesNotMatch(src, /\.close\(\)/, 'no Electron-style close analogues');
  assert.match(src, /new WeakMap\(\)/, 'per-banner state is weakly referenced (no retention)');
  assert.match(src, /governorDecision/);
  assert.match(src, /isScopedSource/, 'both wrappers are scoped to the matched app');
  assert.match(src, /_userActiveWhileNotificationShown = true/);
  assert.match(src, /_updateState\(\)/, 'expiry goes through the shell\'s standard path');
});

test('M14/extension: metadata pins the uuid, GNOME 49/50, and the app-side version', () => {
  const meta = JSON.parse(fs.readFileSync(METADATA_JSON, 'utf8'));
  assert.strictEqual(meta.uuid, 'whatsapp-deterministic-banner@prr006');
  assert.ok(meta['shell-version'].includes('50'), 'target shell major 50 declared');
  assert.ok(meta['shell-version'].includes('49'), '49 declared (functionally identical banner code, verified by diff)');
  assert.ok(!meta['shell-version'].includes('48'), 'no unverified older majors');

  const mainSrc = fs.readFileSync(MAIN_JS, 'utf8');
  const uuidInMain = mainSrc.match(/M14_EXTENSION_UUID = '([^']+)'/);
  const verInMain = mainSrc.match(/M14_EXTENSION_VERSION = '([^']+)'/);
  assert.ok(uuidInMain && verInMain, 'main.js carries the uuid + version');
  assert.strictEqual(meta.uuid, uuidInMain[1], 'uuid cannot drift between app and extension');
  assert.strictEqual(meta.version, verInMain[1], 'version stamp cannot drift between app and extension');
});

// ---------------------------------------------------------------------------
// 3. app side — installer in main.js + packaging + regression guards
// ---------------------------------------------------------------------------

test('M14/main: ships the extension (extraResources) and keeps every M12/M13 notification contract', () => {
  const pkg = JSON.parse(fs.readFileSync(PKG_JSON, 'utf8'));
  const res = (pkg.build.extraResources || []);
  assert.ok(res.some((r) => r.from === 'gnome-extension' && r.to === 'gnome-extension'),
    'electron-builder ships gnome-extension/ as extraResources');

  const src = fs.readFileSync(MAIN_JS, 'utf8');
  // M13 guard still holds after M14: the main process schedules no timers.
  assert.doesNotMatch(src, /setTimeout\(/, 'no timer scheduling anywhere in main.js');
  // M12/M13 anchors untouched.
  assert.match(src, /timeoutType: 'default'/);
  assert.match(src, /banner expires via GNOME timeout; history retained/);
  assert.match(src, /MAX_ACTIVE_NOTIFICATIONS = 50/);
  // M14 installer present and best-effort.
  assert.match(src, /execFile\('gnome-extensions', \['enable', M14_EXTENSION_UUID\]/);
  assert.match(src, /m14EnsureBannerExtension\('app ready'\)/);
  assert.match(src, /XDG_DATA_HOME/);
});

// ---------------------------------------------------------------------------
// 4. installer integration (mocked Electron, temp XDG dirs, no GNOME needed)
// ---------------------------------------------------------------------------

const electronMock = {
  __windows: [],
  app: {
    isPackaged: false,
    __handlers: {},
    setName() {},
    setDesktopName() {},
    getPath(name) {
      if (name === 'userData') return os.tmpdir();
      return os.tmpdir();
    },
    getAppPath() { return ROOT; },
    requestSingleInstanceLock() { return true; },
    on(ev, cb) { (this.__handlers[ev] = this.__handlers[ev] || []).push(cb); },
    whenReady() { return Promise.resolve(); },
    quit() {}
  },
  BrowserWindow: class {
    constructor() {
      this.__handlers = {};
      this.webContents = {
        __handlers: {},
        on: (ev, cb) => { (this.__handlers[ev] = this.__handlers[ev] || []).push(cb); },
        setWindowOpenHandler: () => {},
        executeJavaScript: async () => null,
        isDestroyed: () => false
      };
      electronMock.__windows.push(this);
    }
    loadURL() {}
    loadFile() {}
    once() {}
    on() {}
    show() {}
    hide() {}
    focus() {}
    isVisible() { return false; }
    isFocused() { return false; }
    isMinimized() { return false; }
    restore() {}
    minimize() {}
    isDestroyed() { return false; }
    destroy() {}
    setOverlayIcon() {}
  },
  Tray: class {
    constructor() {}
    setToolTip() {}
    setContextMenu() {}
    on() {}
  },
  Menu: { buildFromTemplate: (t) => t },
  Notification: class {
    constructor() {}
    on() {}
    show() {}
    close() {}
  },
  ipcMain: { handle() {}, on() {} },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => false }),
    createFromBuffer: () => ({ isEmpty: () => false }),
    createEmpty: () => ({ isEmpty: () => true })
  },
  shell: { openExternal() {} },
  dialog: {}
};

test('M14/install: first run installs the extension into the user-local shell dir and stays idempotent', async () => {
  const originalLoad = Module._load;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-m14-home-'));
  const tmpData = path.join(tmpHome, '.local', 'share');
  const prev = {
    HOME: process.env.HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CURRENT_DESKTOP: process.env.XDG_CURRENT_DESKTOP,
    XDG_SESSION_DESKTOP: process.env.XDG_SESSION_DESKTOP,
    GNOME_SHELL_VERSION: process.env.GNOME_SHELL_VERSION
  };
  process.env.HOME = tmpHome;
  process.env.XDG_DATA_HOME = tmpData;
  process.env.XDG_CURRENT_DESKTOP = 'ubuntu:GNOME';
  delete process.env.XDG_SESSION_DESKTOP;
  delete process.env.GNOME_SHELL_VERSION;

  let main;
  try {
    Module._load = function (request, ...rest) {
      if (request === 'electron') return electronMock;
      return originalLoad.call(this, request, ...rest);
    };
    main = require(MAIN_JS);
    // whenReady already resolved in the mock: give the microtasks a tick so
    // the startup installer (m14EnsureBannerExtension('app ready')) has run.
    await new Promise((r) => setImmediate(r));
  } finally {
    Module._load = originalLoad;
  }

  const dest = path.join(tmpData, 'gnome-shell', 'extensions', 'whatsapp-deterministic-banner@prr006');
  for (const f of ['metadata.json', 'extension.js', 'policy.js', 'package.json', '.m14-install-version']) {
    assert.ok(fs.existsSync(path.join(dest, f)), `installed file present: ${f}`);
  }
  assert.strictEqual(
    fs.readFileSync(path.join(dest, 'extension.js'), 'utf8'),
    fs.readFileSync(EXTENSION_JS, 'utf8'),
    'installed extension.js is byte-identical to the repo source');
  assert.match(fs.readFileSync(path.join(dest, '.m14-install-version'), 'utf8'), /1\.0\.0/);

  // Direct calls: idempotent when up-to-date, reinstalls into a new prefix.
  const again = main.__m14.ensureBannerExtension('test');
  assert.strictEqual(again.action, 'up-to-date');

  process.env.XDG_DATA_HOME = path.join(tmpHome, 'other-share');
  const moved = main.__m14.ensureBannerExtension('test');
  assert.strictEqual(moved.action, 'installed');
  assert.ok(fs.existsSync(
    path.join(process.env.XDG_DATA_HOME, 'gnome-shell', 'extensions', 'whatsapp-deterministic-banner@prr006', 'extension.js')));

  // Non-GNOME sessions are never touched.
  delete process.env.XDG_CURRENT_DESKTOP;
  process.env.XDG_DATA_HOME = path.join(tmpHome, 'kde-share');
  const skipped = main.__m14.ensureBannerExtension('test');
  assert.strictEqual(skipped.action, 'skipped');
  assert.match(skipped.reason, /GNOME/);
  assert.ok(!fs.existsSync(path.join(process.env.XDG_DATA_HOME, 'gnome-shell')),
    'nothing written for non-GNOME desktops');

  // Restore the environment (the gnome-extensions spawn from 'installed'
  // above is best-effort async; let it settle so no late error escapes).
  process.env.HOME = prev.HOME;
  process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
  process.env.XDG_CURRENT_DESKTOP = prev.XDG_CURRENT_DESKTOP;
  process.env.XDG_SESSION_DESKTOP = prev.XDG_SESSION_DESKTOP;
  process.env.GNOME_SHELL_VERSION = prev.GNOME_SHELL_VERSION;
  await new Promise((r) => setTimeout(r, 100));
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('M14/install: shell script installs/refreshes/uninstalls into a prefix (idempotent)', () => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-m14-prefix-'));
  const run = (extra) => execFileSync('bash', [INSTALL_SH, '--prefix', prefix, ...extra], {
    encoding: 'utf8',
    env: { ...process.env, HOME: prefix, XDG_DATA_HOME: undefined }
  });
  const uuid = 'whatsapp-deterministic-banner@prr006';
  const dest = path.join(prefix, 'gnome-shell', 'extensions', uuid);

  const out1 = run([]);
  assert.match(out1, /installed/);
  for (const f of ['metadata.json', 'extension.js', 'policy.js', 'package.json', '.m14-install-version']) {
    assert.ok(fs.existsSync(path.join(dest, f)), `script installed ${f}`);
  }

  const out2 = run([]);
  assert.match(out2, /already installed/);

  const out3 = run(['--uninstall']);
  assert.match(out3, /removed/);
  assert.ok(!fs.existsSync(dest), 'uninstall removed the extension dir');
  fs.rmSync(prefix, { recursive: true, force: true });
});
