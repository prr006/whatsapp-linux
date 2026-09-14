/**
 * M14 test harness — loads the REAL GNOME Shell 50.1 messageTray.js
 * (vendored, unmodified) and the REAL shipped extension
 * (gnome-extension/extension.js + policy.js) under Node, with only the
 * GI/GTK display layer stubbed (see test/m14/stubs/).
 *
 * Usage:
 *   const H = await import('./m14/harness.js');
 *   const world = H.createWorld();          // fresh tray + environment
 *   H.startGovernor(world);                 // enable the shipped extension
 *   const src = H.makeSource(world, 'WhatsApp for Linux', 'whatsapp-linux');
 *   H.tray.add(src);
 *   const n = H.makeNotification(world, src, 'Alice', 'hello');
 *   src.addNotification(n);                 // what the real daemon does
 *   ...await scenarios on wall clock...
 *   world.teardown();
 */

import { register } from 'node:module';

import * as shared from './shared.js';
import GLibStub from './stubs/GLib.js';

// Register the import hooks BEFORE importing any vendored/extension module.
register(new URL('./loader-hooks.js', import.meta.url));
shared.installGlobal();

// The REAL 50.1 banner state machine (identical module instance to the one
// the shipped extension imports — both go through the resource:// URI the
// loader maps to the vendored file).
export const MessageTray = await import(
  'resource:///org/gnome/shell/ui/messageTray.js'
);

const { Extension } = await import(
  new URL('./stubs/shell-extension-api.js', import.meta.url).href
);

// The REAL shipped extension (gnome-extension/extension.js).
const extensionModule = await import(
  new URL('../../gnome-extension/extension.js', import.meta.url).href
);
export const ShippedExtension = extensionModule.default;

let idSeq = 0;
const notifIds = new WeakMap();

export function createWorld() {
  const tray = new MessageTray.MessageTray();
  shared.resetEnvironment();
  const world = {
    tray,
    State: MessageTray.State,
    idle: {
      set(ms) { shared.idleState.idletimeMs = ms; },
      makeIdle() { shared.idleState.idletimeMs = 60000; },
      triggerActive() { shared.triggerUserActivity(); }
    },
    // Raw idletime the shell code will read next (for assertions).
    idleStateIdletime() { return shared.idleState.idletimeMs; },
    pointer: {
      set(x, y) { shared.pointerState.x = x; shared.pointerState.y = y; },
      get() { return [shared.pointerState.x, shared.pointerState.y]; }
    },
    fullscreen: {
      set(v) {
        shared.monitor.inFullscreen = v;
        tray._updateState();
      }
    },
    busy: {
      set(v) {
        // The real presence handler (org.gnome.Session.StatusChanged):
        // BUSY=1, AVAILABLE=2.
        tray._onStatusChanged(v ? 1 : 2);
      }
    },
    governor: null,
    teardown() {
      if (world.governor) {
        world.governor.stop();
        world.governor = null;
      }
      // Cancel any pending banner machinery of this world so its timers
      // cannot fire against the disposed tray later in the process.
      try {
        if (world.tray._notificationTimeoutId) {
          world.tray._updateNotificationTimeout(0);
        }
        if (world.tray._notificationLeftTimeoutId) {
          GLibStub.source_remove(world.tray._notificationLeftTimeoutId);
        }
        if (world.tray._bannerBin) {
          world.tray._bannerBin.remove_all_transitions();
        }
      } catch (e) {
        // best-effort cleanup only
      }
      shared.resetEnvironment();
    }
  };
  return world;
}

/** Enable the shipped extension (real enable() with real InjectionManager). */
export function startGovernor(world) {
  const ext = new ShippedExtension({});
  ext.enable();
  world.governor = {
    ext,
    stop() {
      ext.disable();
      if (world.governor === this) world.governor = null;
    }
  };
  return world.governor;
}

/**
 * Create a notification SOURCE like the real daemon does:
 * FdoNotificationDaemonSource keeps the resolved Shell.App in `.app`
 * (null when the desktop entry did not resolve); messageTray.js scoping
 * reads exactly that.
 */
export function makeSource(world, title, appId) {
  const source = new MessageTray.Source({
    title,
    policy: new MessageTray.NotificationGenericPolicy()
  });
  source.app = appId ? { get_id: () => appId } : null;
  return source;
}

/**
 * Create a notification like the real daemon's NotifyAsync does for a
 * standard (non-transient, NORMAL urgency) message notification.
 */
export function makeNotification(world, source, title, body) {
  const n = new MessageTray.Notification({ source });
  n.__m14Id = `n${++idSeq}`;
  notifIds.set(n, n.__m14Id);
  n.set({
    title,
    body,
    acknowledged: false
  });
  n.urgency = MessageTray.Urgency.NORMAL;
  n.resident = false;
  n.isTransient = false;
  return n;
}

export function notifId(n) {
  return n ? (notifIds.get(n) || null) : null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sample the real tray state on the wall clock and derive per-notification
 * banner show/hide times.
 * @returns {Promise<{samples: Array, shows: Map, hides: Map}>}
 *   shows/hides map notification -> first sample time (ms from t0) where
 *   it was the active banner / where it stopped being the active banner
 *   with the tray in HIDDEN state.
 */
export async function trackTimeline(world, durationMs, intervalMs = 10) {
  const t0 = Date.now();
  const samples = [];
  const shows = new Map(); // notification -> first sample time as active banner
  const hides = new Map(); // notification -> sample time it stopped being active
  let prevActive = null;
  while (Date.now() - t0 < durationMs) {
    const t = Date.now() - t0;
    const tray = world.tray;
    const active = tray._notification;
    samples.push({
      t,
      state: tray._notificationState,
      active: active ? notifId(active) : null,
      queue: tray.queueCount
    });
    if (active && !shows.has(active) &&
        (tray._notificationState === world.State.SHOWN ||
         tray._notificationState === world.State.SHOWING)) {
      shows.set(active, t);
    }
    // Transition-based hide detection: the moment the active banner
    // changes (queue advance, click, or expiry) the previous banner has
    // finished its banner presentation.
    if (prevActive && prevActive !== active &&
        !hides.has(prevActive)) {
      hides.set(prevActive, t);
    }
    prevActive = active;
    await sleep(intervalMs);
  }
  return { samples, shows, hides, t0 };
}

/** Hover the banner actor in/out (real code path: `notify::hover`). */
export function setBannerHover(world, hovered) {
  const bin = world.tray._bannerBin;
  if (bin.hover === hovered) return;
  bin.hover = hovered;
  bin.notify('hover');
}

/** Click the active banner (real path: NotificationMessage.vfunc_clicked
 * -> notification.activate()). */
export function clickActiveBanner(world) {
  const banner = world.tray._banner;
  if (!banner) throw new Error('no active banner to click');
  banner.__simulateClick();
}

/** Escape key on the banner (real path: _onNotificationKeyRelease ->
 * _expireNotification()). */
export function pressEscape(world) {
  world.tray._expireNotification();
}

export { shared };
