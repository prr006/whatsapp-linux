/**
 * M15 — WhatsApp read-state synchronization regression tests.
 *
 * Covers:
 *   1. Incoming messages while hidden create notification records and increment unread count.
 *   2. When user reads a chat normally in WhatsApp Web (wa-read-state), corresponding
 *      notification records clear and dock/tray unread count decreases to 0.
 *   3. Multiple chats remain independent (Chat A + Chat B = 2; read Chat A = 1; read Chat B = 0).
 *   4. Multiple messages in the same chat increment unread count per message; reading that
 *      chat clears all messages for that chat in one transition.
 *   5. Interleaved messages across multiple chats track and clear independently.
 *   6. Clicking a native notification restores/focuses WhatsApp, sends navigation IPC
 *      (wa-notification-click) with chat metadata, and clears only that chat's records.
 *   7. Notification click on Chat A leaves Chat B unread and preserves Chat B's badge count.
 *   8. Window focus (mainWindow.on('focus')) does NOT clear unread state for shim-correlated events.
 *   9. Window show / restore from tray does NOT clear unread state for shim-correlated events.
 *  10. App activate (app.on('activate')) does NOT clear unread state.
 *  11. Identity decoupling: title/body and tags do not define message identity; distinct eventIds
 *      are retained even with identical title/body; replayed eventIds are deduped.
 *  12. Idempotence, unknown chats, case-insensitivity, and malformed payload resilience.
 *
 * Plus renderer preload integration contracts for notification metadata and click navigation.
 *
 * Run with: node --test test/m15-read-state-sync.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');
const vm = require('node:vm');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-m15-userdata-'));
const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-m15-appdata-'));
const MAIN_JS = path.join(__dirname, '..', 'src', 'main.js');
const PRELOAD_JS = path.join(__dirname, '..', 'src', 'preload.js');

// ---- Electron Mock Environment ----------------------------------------------
const electronMock = {
  __windows: [],
  __mainWindow: null,
  __notifications: [],
  __trayTooltip: null,
  __ipcListeners: {},
  __ipcHandlers: {},
  __badgeCalls: [],
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
      __sent: [],
      on: (ev, cb) => { wc.__handlers[ev] = (wc.__handlers[ev] || []).concat([cb]); },
      __emit: (ev, ...args) => { (wc.__handlers[ev] || []).slice().forEach((cb) => cb(...args)); },
      send: (channel, ...args) => { wc.__sent.push({ channel, args }); },
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
  show() { this.shown = true; (this.__handlers['show'] || []).slice().forEach((fn) => fn()); }
  close() { this.closeCount++; (this.__handlers['close'] || []).slice().forEach((fn) => fn()); }
  __emit(ev, ...args) { (this.__handlers[ev] || []).slice().forEach((cb) => cb(...args)); }
  __click() { (this.__handlers['click'] || []).slice().forEach((cb) => cb()); }
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
  setBadgeCount(count) {
    electronMock.__badgeCalls.push(count);
    return true;
  },
  getBadgeCount() {
    return electronMock.__badgeCalls.length > 0
      ? electronMock.__badgeCalls[electronMock.__badgeCalls.length - 1]
      : 0;
  },
  setDesktopName() {},
  getPath(name) {
    if (name === 'userData') return userDataDir;
    if (name === 'appData') return appDataDir;
    return os.tmpdir();
  },
  getAppPath() { return path.join(__dirname, '..'); },
  requestSingleInstanceLock() { return true; },
  on(ev, cb) { (this.__handlers[ev] = this.__handlers[ev] || []).push(cb); },
  __emit(ev, ...args) { (this.__handlers[ev] || []).slice().forEach((cb) => cb(...args)); },
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
  assert.ok(electronMock.__ipcListeners['wa-web-notification'], 'wa-web-notification listener exists');
  assert.ok(electronMock.__ipcListeners['wa-read-state'], 'wa-read-state listener exists');
});

after(() => {
  Module._load = originalLoad;
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(appDataDir, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  // Reset window state to hidden & unfocused
  win.__visible = false;
  win.__focused = false;
  win.__minimized = false;
  win.webContents.__sent = [];

  // Reset notifications and unread state
  main.__notificationEvents.clear();
  main.__activeNotifications.clear();
  main.__seenRendererEvents.clear();
  main.__recomputeUnreadCount('test setup');
  electronMock.__notifications = [];
  electronMock.__badgeCalls = [];
});

// Helper: simulate notification coming from renderer preload
function fireNotification(payload) {
  const handler = electronMock.__ipcListeners['wa-web-notification'];
  handler({ sender: win.webContents }, payload);
}

// Helper: simulate read-state coming from renderer preload
function fireReadState(payload) {
  const handler = electronMock.__ipcListeners['wa-read-state'];
  handler({ sender: win.webContents }, payload);
}

// -----------------------------------------------------------------------------
// Test Scenarios
// -----------------------------------------------------------------------------

test('M15 Scenario 1: incoming message while hidden creates notification record and increments unread count (dock & tray)', () => {
  assert.strictEqual(main.__getUnreadCount(), 0);

  fireNotification({
    title: 'Alice',
    body: 'Hello there!',
    tag: 'chat_alice@c.us_msg101',
    eventId: 'ev-sc1-01',
    chatId: 'alice@c.us',
    messageId: 'msg101'
  });

  assert.strictEqual(main.__getUnreadCount(), 1, 'unread count increments to 1');
  assert.strictEqual(electronMock.__notifications.length, 1, 'native notification created');
  assert.strictEqual(electronMock.__notifications[0].shown, true, 'native notification shown');
  assert.strictEqual(electronMock.__badgeCalls.slice(-1)[0], 1, 'dock badge set to 1');
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — 1 unread', 'tray tooltip shows 1 unread');

  const record = main.__notificationEvents.get('ev-sc1-01');
  assert.ok(record, 'event record stored');
  assert.strictEqual(record.read, false, 'record marked unread');
  assert.strictEqual(record.chatId, 'alice@c.us', 'chatId captured');
});

test('M15 Scenario 2: reading chat normally in WhatsApp Web (wa-read-state) clears notification records and decrements dock/tray badge count to 0', () => {
  fireNotification({
    title: 'Alice',
    body: 'How are you?',
    tag: 'chat_alice@c.us_msg102',
    eventId: 'ev-sc2-01',
    chatId: 'alice@c.us',
    messageId: 'msg102'
  });
  assert.strictEqual(main.__getUnreadCount(), 1);

  // User reads Alice's chat in WhatsApp Web
  fireReadState({ chatId: 'alice@c.us', unreadCount: 0 });

  assert.strictEqual(main.__getUnreadCount(), 0, 'unread count decrements to 0');
  assert.strictEqual(electronMock.__badgeCalls.slice(-1)[0], 0, 'dock badge cleared to 0');
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp for Linux', 'tray tooltip restored to WhatsApp for Linux');

  const record = main.__notificationEvents.get('ev-sc2-01');
  assert.strictEqual(record.read, true, 'notification event marked read');
});

test('M15 Scenario 3: multiple chats remain independent (Chat A + Chat B = 2; read Chat A = 1; read Chat B = 0)', () => {
  // Chat A arrives
  fireNotification({
    title: 'Alice',
    body: 'Message from Alice',
    tag: 'chat_alice@c.us_1',
    eventId: 'ev-sc3-a1',
    chatId: 'alice@c.us',
    messageId: 'msgA1'
  });
  assert.strictEqual(main.__getUnreadCount(), 1);

  // Chat B arrives
  fireNotification({
    title: 'Bob',
    body: 'Message from Bob',
    tag: 'chat_bob@c.us_1',
    eventId: 'ev-sc3-b1',
    chatId: 'bob@c.us',
    messageId: 'msgB1'
  });
  assert.strictEqual(main.__getUnreadCount(), 2, 'unread count is 2 for two chats');
  assert.strictEqual(electronMock.__badgeCalls.slice(-1)[0], 2);

  // User reads Chat A in WhatsApp Web
  fireReadState({ chatId: 'alice@c.us', unreadCount: 0 });

  assert.strictEqual(main.__getUnreadCount(), 1, 'reading Chat A leaves Chat B unread (count=1)');
  assert.strictEqual(electronMock.__badgeCalls.slice(-1)[0], 1, 'badge count drops to 1');
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp — 1 unread');

  const recordA = main.__notificationEvents.get('ev-sc3-a1');
  const recordB = main.__notificationEvents.get('ev-sc3-b1');
  assert.strictEqual(recordA.read, true, 'Chat A is read');
  assert.strictEqual(recordB.read, false, 'Chat B is still unread');

  // User reads Chat B in WhatsApp Web
  fireReadState({ chatId: 'bob@c.us', unreadCount: 0 });

  assert.strictEqual(main.__getUnreadCount(), 0, 'reading Chat B brings unread to 0');
  assert.strictEqual(electronMock.__badgeCalls.slice(-1)[0], 0);
  assert.strictEqual(electronMock.__trayTooltip, 'WhatsApp for Linux');
  assert.strictEqual(recordB.read, true, 'Chat B is now read');
});

test('M15 Scenario 4: multiple messages in the same chat increment count per message; reading that chat clears all records for that chat', () => {
  // 3 messages from Charlie
  fireNotification({
    title: 'Charlie',
    body: 'First message',
    eventId: 'ev-sc4-c1',
    chatId: 'charlie@c.us',
    messageId: 'm1'
  });
  fireNotification({
    title: 'Charlie',
    body: 'Second message',
    eventId: 'ev-sc4-c2',
    chatId: 'charlie@c.us',
    messageId: 'm2'
  });
  fireNotification({
    title: 'Charlie',
    body: 'Third message',
    eventId: 'ev-sc4-c3',
    chatId: 'charlie@c.us',
    messageId: 'm3'
  });

  assert.strictEqual(main.__getUnreadCount(), 3, '3 unread messages in Charlie chat');
  assert.strictEqual(electronMock.__badgeCalls.slice(-1)[0], 3);

  // Read Charlie chat once
  fireReadState({ chatId: 'charlie@c.us', unreadCount: 0 });

  assert.strictEqual(main.__getUnreadCount(), 0, 'all 3 messages cleared in single read transition');
  assert.strictEqual(electronMock.__badgeCalls.slice(-1)[0], 0);
  assert.strictEqual(main.__notificationEvents.get('ev-sc4-c1').read, true);
  assert.strictEqual(main.__notificationEvents.get('ev-sc4-c2').read, true);
  assert.strictEqual(main.__notificationEvents.get('ev-sc4-c3').read, true);
});

test('M15 Scenario 5: interleaved messages across multiple chats track and clear independently', () => {
  // Chat 1: msg 1
  fireNotification({
    title: 'Chat 1',
    body: 'c1-m1',
    eventId: 'ev-sc5-1',
    chatId: 'chat1@c.us'
  });
  // Chat 2: msg 1
  fireNotification({
    title: 'Chat 2',
    body: 'c2-m1',
    eventId: 'ev-sc5-2',
    chatId: 'chat2@c.us'
  });
  // Chat 1: msg 2
  fireNotification({
    title: 'Chat 1',
    body: 'c1-m2',
    eventId: 'ev-sc5-3',
    chatId: 'chat1@c.us'
  });

  assert.strictEqual(main.__getUnreadCount(), 3);

  // User opens and reads Chat 1
  fireReadState({ chatId: 'chat1@c.us', unreadCount: 0 });
  assert.strictEqual(main.__getUnreadCount(), 1, 'only Chat 2 remains unread');
  assert.strictEqual(main.__notificationEvents.get('ev-sc5-1').read, true);
  assert.strictEqual(main.__notificationEvents.get('ev-sc5-2').read, false);
  assert.strictEqual(main.__notificationEvents.get('ev-sc5-3').read, true);

  // New message for Chat 2 arrives
  fireNotification({
    title: 'Chat 2',
    body: 'c2-m2',
    eventId: 'ev-sc5-4',
    chatId: 'chat2@c.us'
  });
  assert.strictEqual(main.__getUnreadCount(), 2, 'Chat 2 now has 2 unread messages');

  // User reads Chat 2
  fireReadState({ chatId: 'chat2@c.us', unreadCount: 0 });
  assert.strictEqual(main.__getUnreadCount(), 0, 'all chats now read');
});

test('M15 Scenario 6: clicking notification focuses WhatsApp, navigates to originating chat, and clears only that chat notification records', () => {
  win.__visible = false;
  win.__focused = false;
  win.__minimized = true;

  fireNotification({
    title: 'Project Group',
    body: 'Meeting starting now',
    eventId: 'ev-sc6-grp',
    chatId: '123456789-987654@g.us',
    messageId: 'msg-grp-1',
    tag: 'chat_123456789-987654@g.us_msg-grp-1'
  });

  assert.strictEqual(main.__getUnreadCount(), 1);
  const nativeNotif = electronMock.__notifications[0];
  assert.ok(nativeNotif, 'native notification exists');

  // User clicks native notification
  nativeNotif.__click();

  // 1. Window is restored, shown, and focused
  assert.strictEqual(win.isMinimized(), false, 'window restored from minimized');
  assert.strictEqual(win.isVisible(), true, 'window made visible');
  assert.strictEqual(win.isFocused(), true, 'window focused');

  // 2. Native notification was dismissed
  assert.strictEqual(nativeNotif.closeCount, 1, 'notification dismissed on click');

  // 3. Renderer received navigation instruction
  const navMsg = win.webContents.__sent.find((s) => s.channel === 'wa-notification-click');
  assert.ok(navMsg, 'wa-notification-click sent to renderer');
  assert.strictEqual(navMsg.args[0].chatId, '123456789-987654@g.us', 'correct chatId sent');

  // 4. Chat records cleared
  assert.strictEqual(main.__getUnreadCount(), 0, 'unread count cleared for clicked chat');
  assert.strictEqual(main.__notificationEvents.get('ev-sc6-grp').read, true);
});

test('M15 Scenario 7: notification click on Chat A leaves Chat B unread and preserves Chat B badge count', () => {
  win.__visible = false;

  fireNotification({
    title: 'Chat A',
    body: 'Message in A',
    eventId: 'ev-sc7-a',
    chatId: 'chatA@c.us'
  });
  const notifA = electronMock.__notifications[0];

  fireNotification({
    title: 'Chat B',
    body: 'Message in B',
    eventId: 'ev-sc7-b',
    chatId: 'chatB@c.us'
  });

  assert.strictEqual(main.__getUnreadCount(), 2);
  assert.strictEqual(electronMock.__badgeCalls.slice(-1)[0], 2);

  // Click notification for Chat A only
  notifA.__click();

  assert.strictEqual(main.__getUnreadCount(), 1, 'unread count drops to 1');
  assert.strictEqual(electronMock.__badgeCalls.slice(-1)[0], 1, 'dock badge stays at 1');
  assert.strictEqual(main.__notificationEvents.get('ev-sc7-a').read, true, 'Chat A is read');
  assert.strictEqual(main.__notificationEvents.get('ev-sc7-b').read, false, 'Chat B is unread');
});

test('M15 Scenario 8: window focus does NOT clear unread state for shim-correlated notifications', () => {
  fireNotification({
    title: 'Alice',
    body: 'Important message',
    eventId: 'ev-sc8-foc',
    chatId: 'alice@c.us'
  });
  assert.strictEqual(main.__getUnreadCount(), 1);

  // Window gains focus without notification click or WhatsApp read
  win.__emit('focus');

  assert.strictEqual(main.__getUnreadCount(), 1, 'focus alone must not clear shim unread count');
  assert.strictEqual(electronMock.__badgeCalls.slice(-1)[0], 1, 'badge count remains 1');
  assert.strictEqual(main.__notificationEvents.get('ev-sc8-foc').read, false, 'record remains unread');
});

test('M15 Scenario 9: tray restore and window show do NOT clear unread state for shim-correlated notifications', () => {
  fireNotification({
    title: 'Alice',
    body: 'Still unread',
    eventId: 'ev-sc9-show',
    chatId: 'alice@c.us'
  });
  assert.strictEqual(main.__getUnreadCount(), 1);

  // App is shown from tray / un-hidden
  win.show();
  win.__emit('show');

  assert.strictEqual(main.__getUnreadCount(), 1, 'show alone must not clear shim unread count');
  assert.strictEqual(electronMock.__badgeCalls.slice(-1)[0], 1, 'badge count remains 1');
  assert.strictEqual(main.__notificationEvents.get('ev-sc9-show').read, false, 'record remains unread');
});

test('M15 Scenario 10: app activate does NOT clear unread state for shim-correlated notifications', () => {
  fireNotification({
    title: 'Alice',
    body: 'Unread message',
    eventId: 'ev-sc10-act',
    chatId: 'alice@c.us'
  });
  assert.strictEqual(main.__getUnreadCount(), 1);

  // OS sends 'activate' signal
  appMock.__emit('activate');

  assert.strictEqual(main.__getUnreadCount(), 1, 'app activate must not clear shim unread count');
  assert.strictEqual(electronMock.__badgeCalls.slice(-1)[0], 1, 'badge count remains 1');
  assert.strictEqual(main.__notificationEvents.get('ev-sc10-act').read, false, 'record remains unread');
});

test('M15 Scenario 11: identity decoupling: identical title/body messages are tracked independently, tag is metadata', () => {
  // Two distinct incoming notifications with identical title and body
  fireNotification({
    title: 'Alice',
    body: 'Hey',
    eventId: 'ev-sc11-01',
    chatId: 'alice@c.us'
  });
  fireNotification({
    title: 'Alice',
    body: 'Hey',
    eventId: 'ev-sc11-02',
    chatId: 'alice@c.us'
  });

  assert.strictEqual(main.__getUnreadCount(), 2, 'both messages are counted independently');

  // Exact duplicate with the SAME eventId (e.g. re-emitted) is suppressed (M12 duplicate contract)
  fireNotification({
    title: 'Alice',
    body: 'Hey',
    eventId: 'ev-sc11-01',
    chatId: 'alice@c.us'
  });
  assert.strictEqual(main.__getUnreadCount(), 2, 'replayed eventId suppressed');

  // Verify chatId extraction helper from tag formats
  assert.strictEqual(main.__extractChatIdFromTag('chat:12345@c.us'), '12345@c.us');
  assert.strictEqual(main.__extractChatIdFromTag('chat_98765@s.whatsapp.net_msg99'), '98765@s.whatsapp.net');
  assert.strictEqual(main.__extractChatIdFromTag('111-222@g.us'), '111-222@g.us');
  assert.strictEqual(main.__extractChatIdFromTag('newsletter:channel123@newsletter'), 'channel123@newsletter');
});

test('M15 Scenario 12: idempotence, unknown chats, case-insensitivity, and malformed payload resilience', () => {
  // Reading an unknown or non-existent chat
  fireReadState({ chatId: 'unknown@c.us', unreadCount: 0 });
  assert.strictEqual(main.__getUnreadCount(), 0, 'reading unknown chat is safe no-op');

  // Malformed payloads do not throw
  fireReadState(null);
  fireReadState(undefined);
  fireReadState({});
  fireReadState({ chatId: '' });
  assert.strictEqual(main.__getUnreadCount(), 0, 'malformed payloads do not crash');

  // Case-insensitivity and formatting normalization
  fireNotification({
    title: 'Alice',
    body: 'Case test',
    eventId: 'ev-sc12-case',
    chatId: 'ALICE@C.US'
  });
  assert.strictEqual(main.__getUnreadCount(), 1);

  // Read with lowercase or whitespace or prefix
  fireReadState({ chatId: ' alice@c.us ', unreadCount: 0 });
  assert.strictEqual(main.__getUnreadCount(), 0, 'case and whitespace normalized correctly');

  // Duplicate read of already read chat
  fireReadState({ chatId: 'alice@c.us', unreadCount: 0 });
  assert.strictEqual(main.__getUnreadCount(), 0, 'repeated read remains 0');
});

// -----------------------------------------------------------------------------
// Preload Script Integration Tests
// -----------------------------------------------------------------------------

test('M15 Preload: ShimNotification extracts chatId/messageId and exposes __whatsappLinuxReadState', () => {
  const sent = [];
  const exposed = {};
  const ipcListeners = {};

  class FakeNativeNotification {
    constructor() { throw new Error('native Notification must NOT be constructed'); }
    static get permission() { return 'granted'; }
    static requestPermission() { return Promise.resolve('granted'); }
    static get maxActions() { return 2; }
  }

  const messageListeners = [];
  const pageWindow = {
    Notification: FakeNativeNotification,
    setTimeout: (fn) => fn(),
    setInterval: () => 1,
    clearInterval: () => {},
    addEventListener: (ev, fn) => {
      if (ev === 'message') messageListeners.push(fn);
    },
    removeEventListener: () => {},
    postMessage: (data) => {
      messageListeners.forEach((fn) => fn({ data, origin: '*', source: pageWindow }));
    },
    location: { href: 'https://web.whatsapp.com' }
  };
  pageWindow.window = pageWindow;
  pageWindow.Event = class { constructor(type) { this.type = type; } };
  const pageCtx = vm.createContext(pageWindow);

  const electronRenderer = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        exposed[name] = value;
        pageWindow[name] = value;
      }
    },
    ipcRenderer: {
      send(channel, payload) { sent.push({ channel, payload }); },
      on(channel, fn) { ipcListeners[channel] = fn; }
    },
    webFrame: {
      executeJavaScript(code) { return vm.runInContext(code, pageCtx); }
    }
  };

  const preloadSrc = fs.readFileSync(PRELOAD_JS, 'utf8');
  const m = new Module(PRELOAD_JS);
  m.filename = m.id;
  m.paths = [];
  const origLoad = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'electron') return electronRenderer;
    return origLoad.call(this, req, ...rest);
  };
  global.window = pageWindow;
  try {
    m._compile(preloadSrc, m.id);

    // 1. Verify ShimNotification extracted chatId from tag and options.data
    assert.strictEqual(pageWindow.Notification.__whatsappLinuxShim, true);

    const n = vm.runInContext(
      "new Notification('Alice', { body: 'Test msg', tag: 'chat_alice123@c.us_msg55', data: { chatId: 'alice123@c.us', messageId: 'msg55' } })",
      pageCtx
    );

    assert.strictEqual(n.chatId, 'alice123@c.us');
    assert.strictEqual(n.messageId, 'msg55');

    // Verify IPC sent on construction
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].channel, 'wa-web-notification');
    assert.strictEqual(sent[0].payload.chatId, 'alice123@c.us');
    assert.strictEqual(sent[0].payload.messageId, 'msg55');

    // 2. Verify __whatsappLinuxReadState exposed and sends IPC
    assert.strictEqual(typeof exposed.__whatsappLinuxReadState, 'function');
    exposed.__whatsappLinuxReadState({ chatId: 'alice123@c.us', reason: 'test manual' });

    assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[1].channel, 'wa-read-state');
    assert.strictEqual(sent[1].payload.chatId, 'alice123@c.us');
    assert.strictEqual(sent[1].payload.reason, 'test manual');

    // 3. Verify wa-notification-click invokes notif.onclick
    let onclickInvoked = false;
    n.onclick = () => { onclickInvoked = true; };

    assert.ok(ipcListeners['wa-notification-click'], 'wa-notification-click IPC listener registered');
    ipcListeners['wa-notification-click']({}, {
      chatId: 'alice123@c.us',
      eventId: n._eventId,
      tag: n.tag
    });

    assert.strictEqual(onclickInvoked, true, 'notification.onclick called on notification click');
  } finally {
    Module._load = origLoad;
    delete global.window;
  }
});
