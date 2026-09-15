/**
 * Preload script for the WhatsApp Web window.
 *
 * M9 notification-click root cause (Electron 44.3.0, verified against the
 * upstream sources — see README "M9 bugfix"):
 *
 *   - `webContents` has NO 'notification' event. The previous
 *     `mainWindow.webContents.on('notification', ...)` handler in main.js was
 *     dead code, so the main process never created a native Notification and
 *     never received a `click`.
 *   - WhatsApp Web's own `new Notification()` is rendered by Chromium's
 *     PlatformNotificationService. Its libnotify "default" action IS invoked
 *     by GNOME (ActionInvoked "default" in the D-Bus trace), but Electron's
 *     NotificationDelegateImpl::NotificationClick() dispatches that click to
 *     the RENDERER (the page's `onclick`), never to the main process. The
 *     page's `window.focus()` then hits WebContents::ActivateContents, which
 *     does not restore/focus the BrowserWindow.
 *
 * There is no main-process API that observes web-page notifications, so the
 * only way to route them through our native path is to intercept the page's
 * `window.Notification` constructor in the MAIN WORLD. That is what this
 * shim does: it forwards { title, body } over IPC and returns an inert stub.
 * The main process keeps all the existing behaviour (focused-suppression,
 * dedup, unread, settings toggles, native banner, click -> restore/focus).
 *
 * Constraints respected:
 *   - No DOM selectors, no CSS, no changes to WhatsApp Web's own code paths
 *     other than the standard `window.Notification` global.
 *   - The page's permission model is untouched (`Notification.permission`
 *     still reports the real value so WhatsApp Web's settings UI works).
 *   - contextIsolation stays ON; the bridge is a single one-way IPC channel.
 */

const { contextBridge, ipcRenderer, webFrame } = require('electron');

const NOTIFY_CHANNEL = 'wa-web-notification';
const READ_STATE_CHANNEL = 'wa-read-state';

contextBridge.exposeInMainWorld('whatsappLinux', {
  version: '0.1.0',
  platform: process.platform
});

// One-way bridge from the main-world shim into the main process. The shim
// (below) cannot require('electron') itself because it runs in the page's
// world, so it calls this isolated-world function via the bridge.
contextBridge.exposeInMainWorld('__whatsappLinuxNotify', (payload) => {
  try {
    const event = {
      title: payload && typeof payload.title === 'string' ? payload.title : '',
      body: payload && typeof payload.body === 'string' ? payload.body : '',
      tag: payload && typeof payload.tag === 'string' ? payload.tag : ''
    };
    // Keep the historical enumerable payload stable for WhatsApp and existing
    // integrations; lifecycle metadata remains available to the main process.
    Object.defineProperties(event, {
      eventId: { value: payload && typeof payload.eventId === 'string' ? payload.eventId : '', enumerable: false },
      lifecycle: { value: payload && typeof payload.lifecycle === 'string' ? payload.lifecycle : 'constructor', enumerable: false },
      chatId: { value: payload && typeof payload.chatId === 'string' ? payload.chatId : '', enumerable: false },
      messageId: { value: payload && typeof payload.messageId === 'string' ? payload.messageId : '', enumerable: false },
      messageIds: { value: Array.isArray(payload && payload.messageIds) ? payload.messageIds : (payload && payload.messageId ? [payload.messageId] : []), enumerable: false },
      timestamp: { value: typeof (payload && payload.timestamp) === 'number' ? payload.timestamp : Date.now(), enumerable: false },
      reason: { value: payload && typeof payload.reason === 'string' ? payload.reason : '', enumerable: false }
    });
    ipcRenderer.send(NOTIFY_CHANNEL, event);
  } catch (e) {
    // Never let a bridge failure surface into the page.
  }
});

// M15: Expose read-state reporting from main world to main process
contextBridge.exposeInMainWorld('__whatsappLinuxReadState', (payload) => {
  try {
    const event = {
      chatId: payload && typeof payload.chatId === 'string' ? payload.chatId : '',
      messageId: payload && typeof payload.messageId === 'string' ? payload.messageId : '',
      reason: payload && typeof payload.reason === 'string' ? payload.reason : 'whatsapp read'
    };
    ipcRenderer.send(READ_STATE_CHANNEL, event);
  } catch (e) {}
});

// M15: Receive notification click and forward to main world for chat navigation and onclick dispatch
if (ipcRenderer && typeof ipcRenderer.on === 'function') {
  ipcRenderer.on('wa-notification-click', (event, payload) => {
    try {
      window.postMessage({
        type: '__wa_linux_notification_click',
        eventId: payload && payload.eventId,
        chatId: payload && payload.chatId,
        tag: payload && payload.tag
      }, '*');
    } catch (e) {}
  });
}

// Main-world shim. Runs inside the page context (webFrame.executeJavaScript
// executes in the main world), so it can replace the `Notification` global
// that WhatsApp Web sees. It is installed before any page script executes
// because preload runs prior to the document's own scripts.
const SHIM = `(() => {
  // A constructor is an event, not a message identity. This renderer-local
  // sequence lets the main process suppress an IPC retry of the same
  // constructor without coalescing later constructors with identical text.
  let rendererNotificationSequence = 0;
  const NativeNotification = window.Notification;
  if (!NativeNotification || NativeNotification.__whatsappLinuxShim) return;

  const forward = window.__whatsappLinuxNotify;
  const forwardReadState = window.__whatsappLinuxReadState;

  // Active notifications map: eventId -> ShimNotification
  const activeShimNotifications = new Map();

  function notifyRead(chatId, reason) {
    if (!chatId) return;
    try {
      if (typeof forwardReadState === 'function') {
        forwardReadState({ chatId: String(chatId), reason: reason || 'whatsapp read' });
      } else if (typeof forward === 'function') {
        const ev = { title: '', body: '', tag: String(chatId) };
        Object.defineProperties(ev, {
          lifecycle: { value: 'chat-read', enumerable: false },
          chatId: { value: String(chatId), enumerable: false },
          reason: { value: reason || 'whatsapp read', enumerable: false }
        });
        forward(ev);
      }
    } catch (e) {}
  }

  function extractChatId(tag, data) {
    if (data && typeof data.chatId === 'string' && data.chatId.length > 0) {
      return data.chatId;
    }
    if (data && typeof data.id === 'string') {
      const match = data.id.match(/_([0-9a-zA-Z._-]+@(c\\.us|g\\.us|s\\.whatsapp\\.net|lid|newsletter|broadcast))_/i);
      if (match) return match[1];
    }
    if (typeof tag === 'string' && tag.length > 0) {
      const jidMatch = tag.match(/([0-9a-zA-Z._-]+@(c\\.us|g\\.us|s\\.whatsapp\\.net|lid|newsletter|broadcast))/i);
      if (jidMatch) return jidMatch[1];
      const stripped = tag.replace(/^chat[:_]/i, '');
      if (stripped) return stripped;
      return tag;
    }
    return null;
  }

  function extractMessageId(data) {
    if (!data) return null;
    if (typeof data.messageId === 'string') return data.messageId;
    if (typeof data.msgId === 'string') return data.msgId;
    if (typeof data.id === 'string') return data.id;
    return null;
  }

  function ShimNotification(title, options) {
    if (!(this instanceof ShimNotification)) {
      throw new TypeError("Failed to construct 'Notification': Please use the 'new' operator");
    }
    options = options || {};
    this.title = String(title == null ? '' : title);
    this.body = typeof options.body === 'string' ? options.body : '';
    this.tag = typeof options.tag === 'string' ? options.tag : '';
    this.icon = typeof options.icon === 'string' ? options.icon : '';
    this.data = options.data === undefined ? null : options.data;
    this.silent = !!options.silent;
    this.onclick = null;
    this.onclose = null;
    this.onerror = null;
    this.onshow = null;
    this._listeners = Object.create(null);
    this._eventId = 'renderer-' + (++rendererNotificationSequence);

    const chatId = extractChatId(this.tag, this.data);
    const messageId = extractMessageId(this.data);
    this._chatId = chatId;
    this._messageId = messageId;
    this.chatId = chatId;
    this.messageId = messageId;

    activeShimNotifications.set(this._eventId, this);

    if (typeof forward === 'function') {
      try {
        const event = { title: this.title, body: this.body, tag: this.tag };
        Object.defineProperties(event, {
          eventId: { value: this._eventId, enumerable: false },
          lifecycle: { value: 'constructor', enumerable: false },
          chatId: { value: chatId || '', enumerable: false },
          messageId: { value: messageId || '', enumerable: false },
          messageIds: { value: messageId ? [messageId] : [], enumerable: false },
          timestamp: { value: Date.now(), enumerable: false }
        });
        forward(event);
      } catch (e) {}
    }

    // Emulate the spec'd async "show" so callers waiting on it don't hang.
    const self = this;
    setTimeout(() => {
      if (typeof self.onshow === 'function') { try { self.onshow(new Event('show')); } catch (e) {} }
      self._dispatch('show');
    }, 0);
  }

  ShimNotification.prototype.close = function () {
    if (this._closed) return;
    this._closed = true;
    activeShimNotifications.delete(this._eventId);
    if (typeof forward === 'function') {
      try {
        const event = { title: this.title, body: this.body, tag: this.tag };
        Object.defineProperties(event, {
          eventId: { value: this._eventId, enumerable: false },
          lifecycle: { value: 'close', enumerable: false },
          chatId: { value: this._chatId || '', enumerable: false },
          messageId: { value: this._messageId || '', enumerable: false }
        });
        // Queue recall after the constructor turn, matching the browser's
        // asynchronous event delivery and avoiding re-entrancy in page code.
        Promise.resolve().then(() => forward(event));
      } catch (e) {}
    }
    if (typeof this.onclose === 'function') { try { this.onclose(new Event('close')); } catch (e) {} }
    this._dispatch('close');
  };
  ShimNotification.prototype.addEventListener = function (type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  };
  ShimNotification.prototype.removeEventListener = function (type, fn) {
    const l = this._listeners[type];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  };
  ShimNotification.prototype.dispatchEvent = function (ev) { this._dispatch(ev && ev.type); return true; };
  ShimNotification.prototype._dispatch = function (type) {
    const l = this._listeners[type];
    if (!l) return;
    l.slice().forEach((fn) => { try { fn.call(this, new Event(type)); } catch (e) {} });
  };

  // Static surface WhatsApp Web relies on. Permission state is delegated to
  // the real implementation so the page's own permission prompt/settings UI
  // keep working; Electron grants 'notifications' by default.
  Object.defineProperty(ShimNotification, 'permission', {
    get() { return NativeNotification.permission; },
    configurable: true
  });
  ShimNotification.requestPermission = function () {
    return NativeNotification.requestPermission.apply(NativeNotification, arguments);
  };
  Object.defineProperty(ShimNotification, 'maxActions', {
    get() { return NativeNotification.maxActions; },
    configurable: true
  });
  ShimNotification.__whatsappLinuxShim = true;
  ShimNotification.__native = NativeNotification;

  try {
    Object.defineProperty(window, 'Notification', {
      value: ShimNotification,
      writable: true,
      configurable: true
    });
  } catch (e) {
    window.Notification = ShimNotification;
  }

  // --- M15: Navigation & Read State Synchronization ---

  function navigateToChat(targetId) {
    if (!targetId) return false;
    try {
      if (typeof window.require !== 'function') return false;
      const collections = window.require('WAWebCollections');
      const cmd = window.require('WAWebCmd')?.Cmd;
      if (!collections || !collections.Chat || !cmd) return false;

      const clean = String(targetId).replace(/^chat[:_]/i, '');
      const models = typeof collections.Chat.getModelsArray === 'function'
        ? collections.Chat.getModelsArray()
        : (collections.Chat.models || []);

      const chat = collections.Chat.get(clean) || models.find((c) => {
        const cid = c?.id?._serialized || c?.id?.$1 || (typeof c?.id === 'string' ? c.id : '');
        return cid === clean || cid.includes(clean) || clean.includes(cid);
      });

      if (chat) {
        if (typeof cmd.openChatBottom === 'function') {
          cmd.openChatBottom({ chat: chat });
          return true;
        } else if (typeof cmd.openChatAt === 'function') {
          cmd.openChatAt(chat);
          return true;
        } else if (typeof cmd.openChatFromUnread === 'function') {
          cmd.openChatFromUnread({ chat: chat });
          return true;
        }
      }
    } catch (e) {}
    return false;
  }

  // Handle notification click forwarded from main process
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('message', (ev) => {
      if (!ev || !ev.data || ev.data.type !== '__wa_linux_notification_click') return;
      const eventId = ev.data.eventId;
      const chatId = ev.data.chatId;
      const tag = ev.data.tag;

      // 1. Invoke the ShimNotification click handler attached by WhatsApp Web
      if (eventId && activeShimNotifications.has(eventId)) {
        const shim = activeShimNotifications.get(eventId);
        try {
          if (typeof shim.onclick === 'function') {
            shim.onclick(new Event('click'));
          }
          shim.dispatchEvent(new Event('click'));
        } catch (e) {}
      }

      // 2. Drive WhatsApp Web's internal chat navigation
      navigateToChat(chatId || tag);
    });
  }

  // Intercept IndexedDB writes for chat unreadCount updates
  try {
    if (window.IDBObjectStore && window.IDBObjectStore.prototype) {
      const origPut = window.IDBObjectStore.prototype.put;
      window.IDBObjectStore.prototype.put = function (value) {
        try {
          if (this.name === 'chat' && value && typeof value === 'object') {
            const cid = value.id?._serialized || value.id?.$1 || (typeof value.id === 'string' ? value.id : null);
            const unread = typeof value.unreadCount === 'number' ? value.unreadCount : null;
            if (cid && unread === 0) {
              notifyRead(cid, 'indexeddb');
            }
          }
        } catch (e) {}
        return origPut.apply(this, arguments);
      };
    }
  } catch (e) {}

  // Hook WhatsApp internal modules (sendSeen & change:unreadCount)
  function tryHookWhatsAppModules() {
    try {
      if (typeof window.require !== 'function') return false;
      let hookedAny = false;

      // Hook WAWebUpdateUnreadChatAction.sendSeen
      try {
        const updateAction = window.require('WAWebUpdateUnreadChatAction');
        if (updateAction && typeof updateAction.sendSeen === 'function' && !updateAction.sendSeen.__waHooked) {
          const origSendSeen = updateAction.sendSeen;
          updateAction.sendSeen = function (options) {
            try {
              const chat = options && (options.chat || options);
              const cid = chat?.id?._serialized || chat?.id?.$1 || (typeof chat?.id === 'string' ? chat.id : null);
              if (cid) notifyRead(cid, 'sendSeen');
            } catch (e) {}
            return origSendSeen.apply(this, arguments);
          };
          updateAction.sendSeen.__waHooked = true;
          hookedAny = true;
        }
      } catch (e) {}

      // Hook WAWebCollections.Chat change:unreadCount
      try {
        const collections = window.require('WAWebCollections');
        const Chat = collections && collections.Chat;
        if (Chat && typeof Chat.on === 'function' && !Chat.__waHooked) {
          Chat.on('change:unreadCount', (chat) => {
            try {
              if (chat && (chat.unreadCount === 0 || !chat.unreadCount)) {
                const cid = chat.id?._serialized || chat.id?.$1 || (typeof chat.id === 'string' ? chat.id : null);
                if (cid) notifyRead(cid, 'change:unreadCount');
              }
            } catch (e) {}
          });
          Chat.__waHooked = true;
          hookedAny = true;
        }
      } catch (e) {}

      return hookedAny;
    } catch (e) {
      return false;
    }
  }

  const safeSetInterval = typeof setInterval === 'function'
    ? setInterval
    : (typeof window !== 'undefined' && typeof window.setInterval === 'function' ? window.setInterval.bind(window) : null);
  const safeClearInterval = typeof clearInterval === 'function'
    ? clearInterval
    : (typeof window !== 'undefined' && typeof window.clearInterval === 'function' ? window.clearInterval.bind(window) : null);

  let hookAttempts = 0;
  let hookInterval = null;
  if (safeSetInterval) {
    hookInterval = safeSetInterval(() => {
      hookAttempts++;
      if (tryHookWhatsAppModules() || hookAttempts > 30) {
        if (safeClearInterval && hookInterval) safeClearInterval(hookInterval);
      }
    }, 1000);
  }

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('beforeunload', () => {
      if (safeClearInterval && hookInterval) safeClearInterval(hookInterval);
    });
  }

  // Export helpers in main world for testability / verification
  window.__whatsappLinuxNavigateChat = navigateToChat;
  window.__whatsappLinuxNotifyRead = notifyRead;
})();`;

try {
  webFrame.executeJavaScript(SHIM);
} catch (e) {
  // If the shim cannot be installed the page falls back to Chromium's own
  // notifications (the pre-fix behaviour); log so it is visible in traces.
  console.error('[notif] failed to install Notification shim:', e);
}
