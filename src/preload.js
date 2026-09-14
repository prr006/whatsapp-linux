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
      lifecycle: { value: payload && typeof payload.lifecycle === 'string' ? payload.lifecycle : 'constructor', enumerable: false }
    });
    ipcRenderer.send(NOTIFY_CHANNEL, event);
  } catch (e) {
    // Never let a bridge failure surface into the page.
  }
});

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

    if (typeof forward === 'function') {
      try {
        const event = { title: this.title, body: this.body, tag: this.tag };
        Object.defineProperties(event, {
          eventId: { value: this._eventId, enumerable: false },
          lifecycle: { value: 'constructor', enumerable: false }
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
    if (typeof forward === 'function') {
      try {
        const event = { title: this.title, body: this.body, tag: this.tag };
        Object.defineProperties(event, {
          eventId: { value: this._eventId, enumerable: false },
          lifecycle: { value: 'close', enumerable: false }
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
})();`;

try {
  webFrame.executeJavaScript(SHIM);
} catch (e) {
  // If the shim cannot be installed the page falls back to Chromium's own
  // notifications (the pre-fix behaviour); log so it is visible in traces.
  console.error('[notif] failed to install Notification shim:', e);
}
