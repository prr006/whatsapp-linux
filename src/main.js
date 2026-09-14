/**
 * WhatsApp for Linux — Main Process
 * M1 Proof of Concept: loads WhatsApp Web with persistent session.
 */

const { app, BrowserWindow, Tray, Menu, dialog, shell, Notification, ipcMain, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

app.setName('whatsapp-linux');
const path = require('path');

// M11: the `.desktop` file ID this app owns at runtime.
//
// Why the suffix matters (verified against Electron 44.3.0 sources):
//   * lib/browser/init.ts does
//       app.setDesktopName(packageJson.desktopName || defaultDesktopName(app.name))
//     i.e. CHROME_DESKTOP is taken verbatim from package.json's `desktopName`.
//   * shell/common/platform_util_linux.cc: `GetDesktopName()` == getenv("CHROME_DESKTOP").
//   * shell/browser/linux/launcher_entry.cc: the launcher-entry app URI is
//       "application://" + GetDesktopName()          <-- the suffix is NOT added
//     so with `desktopName: "whatsapp-linux"` Electron would emit
//     `application://whatsapp-linux`, which no dock can match.
//   * Docks compare that URI against the running app's desktop ID *with* the
//     suffix. Dash to Dock (launcherAPI.js) strips only the `application://`
//     scheme and looks the result up by `Shell.App.id`, which GNOME sets to the
//     `.desktop` filename (`whatsapp-linux.desktop`).
//
// electron-builder derives the packaged filename with
// `desktopName.replace(/\.desktop$/, '') + '.desktop'` (LinuxTargetHelper.
// getDesktopFileName), so package.json can keep the bare `desktopName` that the
// M9 tests assert on, while the runtime ID used for the launcher entry must
// carry the suffix. Set it explicitly here so the two cannot drift silently —
// test/m11-dock-badge.test.js pins both sides together.
//
// This also leaves every other CHROME_DESKTOP consumer unchanged or better:
//   * GetXdgAppId() strips `.desktop` -> still `whatsapp-linux` (Wayland app_id
//     and the `desktop-entry` notification hint are untouched).
//   * version_info::nix::GetAppName()/GetSessionNamePrefix() strip `.desktop`
//     -> unchanged app_id / DBus object-path prefix.
//   * Browser::IsDefaultProtocolClient()/SetDefaultWebClient() build a
//     GDesktopAppInfo from CHROME_DESKTOP, which *requires* the suffix.
const DESKTOP_FILE_ID = 'whatsapp-linux.desktop';
if (process.platform === 'linux' && typeof app.setDesktopName === 'function') {
  app.setDesktopName(DESKTOP_FILE_ID);
}


// M7: startup/resume timing instrumentation (cheap, consistent with existing
// console logging). Logs elapsed ms since main-process start at key lifecycle
// points so cold-start and tray-resume cost can be measured on a real machine.
// M8: events are also kept in memory (PERF_EVENTS) so the mocked-Electron
// tests can assert on the recorded timeline, and scripts/measure-startup.sh
// parses the [perf] stdout lines to build a full cold-start report (9 measured
// startup points — see README, M8 section).
const PERF_START_MS = Date.now();
const PERF_EVENTS = [];
function perfLog(label) {
  const elapsedMs = Date.now() - PERF_START_MS;
  PERF_EVENTS.push({ label: label, ms: elapsedMs });
  console.log(`[perf] ${label}  (+${elapsedMs}ms)`);
}
perfLog('main process started');

// M9: --start-minimized / --hidden CLI flag — start the window hidden to the
// tray. Used by the XDG autostart path (a login launch is non-intrusive) and
// by the resource-measurement harness to sample the tray-hidden idle state
// without a manual click.
const START_HIDDEN_OVERRIDE =
  process.argv.includes('--start-minimized') || process.argv.includes('--hidden');

/**
 * Resolve a runtime icon that native APIs (Tray, Notification) can load.
 *
 * Packaged Electron cannot feed asar paths to native image loaders:
 *   app.getAppPath() -> .../resources/app.asar
 *   .../app.asar/build/icons/icon.png  <-- native Tray fails
 *
 * extraResources copies the icon outside asar:
 *   process.resourcesPath/icons/icon.png
 */
function getRuntimeIconFile(filename) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'icons', filename);
  }
  return path.join(__dirname, '..', 'build', 'icons', filename);
}

function loadNativeIcon(filename) {
  const filePath = getRuntimeIconFile(filename);

  try {
    if (fs.existsSync(filePath)) {
      const fromPath = nativeImage.createFromPath(filePath);
      if (!fromPath.isEmpty()) {
        return { image: fromPath, filePath };
      }
    }
  } catch (err) {
    console.error('nativeImage.createFromPath failed:', filePath, err);
  }

  // Node fs is asar-aware; native path loading is not. Use this only as fallback.
  const asarFallback = path.join(__dirname, '..', 'build', 'icons', filename);
  try {
    const buf = fs.readFileSync(asarFallback);
    const fromBuffer = nativeImage.createFromBuffer(buf);
    if (!fromBuffer.isEmpty()) {
      console.warn('Loaded icon from asar buffer fallback:', asarFallback);
      return { image: fromBuffer, filePath: asarFallback };
    }
  } catch (err) {
    console.error('Failed to read icon buffer:', asarFallback, err);
  }

  console.error('Icon missing or invalid:', filePath);
  return { image: nativeImage.createEmpty(), filePath };
}

// Keep references to avoid GC
let mainWindow = null;
let tray = null;

// M2: lightweight dedup tracker for native notifications
const recentNotifications = new Map();
const NOTIFICATION_DEDUP_WINDOW_MS = 3000;
let unreadCount = 0;
// Renderer constructor identities are the only reliable duplicate key. Tags
// are useful metadata, but WhatsApp reuses them for a chat, so they never
// identify a message by themselves.
const notificationEvents = new Map();
const seenRendererEvents = new Map();
let nextFallbackNotificationId = 0;
const MAX_EVENT_RECORDS = 1000;

// ---------------------------------------------------------------------------
// M13 — native notification lifecycle state machine (banner expiration
// investigation + bounded retention). Replaces M9/M10's bare Set of strong
// references with per-notification state, so that the four terminal outcomes
// are explicitly distinguished:
//
//   banner expiration      — GNOME hides the pop-out after ITS OWN timeout.
//                            No event exists for this anywhere in the
//                            Electron/libnotify/GNOME chain (verified below);
//                            the notification moves to the history list. We
//                            must NOT infer expiration from a missing event.
//   user dismissal         — the user dismisses/clears it from GNOME's
//                            notification list -> the daemon emits
//                            NotificationClosed -> Electron 'close' event
//                            WITHOUT any close() call on our side.
//   programmatic close     — WE called close() (renderer-side
//                            Notification.close() recall, or the close we
//                            issue as part of handling a click).
//   click-triggered close  — ActionInvoked "default" -> Electron 'click';
//                            GNOME itself removes non-resident notifications
//                            on activation, and we additionally issue close().
//
// INVESTIGATION (Electron 44.3.0 + libnotify + GNOME Shell, sources read):
//
// 1. Electron shell/browser/notifications/linux/libnotify_notification.cc
//    (v44.3.0):
//      - Show(): notify_notification_new() + set_timeout(NOTIFY_EXPIRES_DEFAULT
//        for timeoutType 'default') + notify_notification_show(). The replaces
//        id is only set when `options.tag` is non-empty (g_quark_from_string
//        -> g_object_set "id"), but electron_api_notification.cc Show() never
//        populates NotificationOptions::tag from any JS option, so every
//        Electron notification is sent with replaces_id = 0 => GNOME always
//        allocates a NEW server id. There is no replacement/reuse of ids.
//      - The "append" hint is only set when the server advertises the
//        "append" capability; GNOME Shell does not (its GetCapabilities lists
//        actions/body/body-markup/icon-static/persistence/sound only), so no
//        appending/coalescing happens on GNOME either.
//      - OnNotificationClosed -> NotificationDismissed(!on_dismissing_) ->
//        JS 'close'. OnNotificationView -> JS 'click'. notify_notification_show
//        error -> NotificationFailed -> JS 'failed'.
// 2. libnotify (notification.c / notify.c):
//      - notify_notification_show() sends Notify with replaces_id = priv->id
//        (0 for a fresh object) and the client timeout as the last argument.
//      - notify_notification_close() is a synchronous CloseNotification D-Bus
//        call; it does NOT emit the "closed" GObject signal itself.
//      - The "closed" signal is emitted ONLY when the daemon's
//        NotificationClosed D-Bus signal is routed to the matching id
//        (proxy_g_signal_cb -> close_notification()), guarded so it fires at
//        most once per notification. Consequences: (a) our own close() can be
//        echoed by a single late 'close' event; (b) anything GNOME never
//        closes never produces 'closed'.
// 3. GNOME Shell (js/ui/notificationDaemon.js + js/ui/messageTray.js):
//      - NotifyAsync() destructures the client timeout into `timeout_` and
//        NEVER READS IT. Banner lifetime is entirely GNOME's own
//        NOTIFICATION_TIMEOUT (~4s stock; the notification-timeout extension
//        is what sets the ~5s on the test machine). timeoutType 'default' is
//        still correct — it just means "GNOME decides".
//      - MessageTray only arms that timeout when the user is ACTIVE:
//        _showNotification() records _userActiveWhileNotificationShown =
//        (idleMonitor.get_idletime() <= IDLE_TIME /* 1000 ms */). If the user
//        is idle when the banner pops, NO expiration timer is armed — the
//        banner stays visible indefinitely and is hidden only ~2s after input
//        resumes (_onIdleMonitorBecameActive -> _updateNotificationTimeout(2000)).
//      - The timer is also refreshed/paused while the pointer hovers the
//        banner or moves towards it (_notificationTimeout() re-arms +1000 ms;
//        hover keeps it expanded), and banners are suppressed/deferred while
//        the session is BUSY or the monitor is fullscreen.
//      - Only ONE banner shows at a time; further notifications are QUEUED
//        (MAX_NOTIFICATIONS_IN_QUEUE = 3) and shown back-to-back, each with
//        its own timeout. Beyond the queue only a panel indicator appears.
//      - Banner expiration of a NON-transient notification destroys NOTHING:
//        _hideNotificationCompleted() only destroys isTransient ones. The
//        notification stays in the source's list (history) and NO
//        NotificationClosed is emitted. NotificationClosed is emitted only
//        when the notification object is destroyed: user dismissal/clear
//        (reason DISMISSED=2), our CloseNotification (reason APP_CLOSED=3),
//        or GNOME evicting the oldest once a source accumulates more than
//        MAX_NOTIFICATIONS_PER_SOURCE = 10 notifications (reason EXPIRED=1).
//
// ROOT CAUSE of the inconsistent banner expiration seen on the real packaged
// app: GNOME Shell's timeout policy (item 3). With identical app behaviour the
// banner expires normally in one case (user active, pointer elsewhere) but
// lingers indefinitely in another (user idle at pop-out, pointer hovering /
// drifting towards the banner, session busy, or the notification is deep in
// the banner queue behind a burst of messages). That intermittency is by
// GNOME design; no client call can change it, and — critically — it must NOT
// be "fixed" with CloseNotification, which would remove the notification from
// history (the original M10 bug).
//
// WHY THE M10 MODEL WAS INSUFFICIENT (although its tests passed):
//   - It had no per-notification state: every outcome other than "reference
//     present" was invisible, so a lingering banner could not be diagnosed
//     from [notif] logs and close origins were indistinguishable.
//   - activeNotifications was an UNBOUNDED Set held until click/close. On
//     GNOME the daemon's own 10-per-source cap normally recycles entries via
//     real 'close' events, but the app-side retention had no bound and no
//     defence against daemons without such a cap or against close events that
//     never arrive (shell/extension restart, name-owner churn) — a slow
//     main-process memory leak.
//   - It never documented that banner expiration is fundamentally
//     unobservable, inviting exactly the misdiagnosis this milestone settles.
//
// WHY THE OTHER SUSPECTS WERE RULED OUT:
//   - GC / wrapper lifetime: Electron's JS Notification wrapper is
//     gin-wrapped (weak); collecting it only calls set_delegate(nullptr)
//     (electron_api_notification.cc ~Notification). That breaks JS event
//     delivery but sends nothing to the daemon, so it cannot hold a banner.
//     (M9's strong references remain necessary for click delivery.)
//   - Replacement/append/id/tag: verified impossible above (replaces_id is
//     always 0; no append hint on GNOME; tag never reaches libnotify).
//   - Our lifecycle callbacks: none of them can delay a GNOME timer, and M10
//     already removed the only thing that actively harmed history (the blind
//     5 s close() timer). The remaining app-side gaps were observability and
//     unbounded retention, which this milestone fixes.
//
// DESIGN (around OBSERVABLE behaviour — no invented expiration event, no
// blind timers):
//   - Each native notification gets a lifecycle record (state machine below).
//   - 'show' / 'click' / 'close' / 'failed' map to explicit transitions; the
//     close origin is classified by whether WE initiated close().
//   - Banner expiration produces no transition; the record simply stays
//     'shown' and the reference is retained so a later click from GNOME's
//     history list still restores the window. We never claim expiration.
//   - Retention is BOUNDED (MAX_ACTIVE_NOTIFICATIONS): oldest tracked
//     wrappers are evicted when the cap is exceeded. On GNOME this cap is a
//     backstop only (the daemon keeps at most 10 of ours alive anyway); on
//     daemons with unlimited retention it trades click-to-restore for very
//     old history entries against unbounded memory growth.
// ---------------------------------------------------------------------------

// M9 bugfix (kept, now bounded): strong references to every live native
// notification, so the gin-weak Electron wrapper cannot be GC'd while the
// banner/history entry is still clickable (GC -> set_delegate(nullptr) ->
// click never reaches JS -> showAndFocusMainWindow() never runs). Keyed
// wrapper -> lifecycle record (M13); .has/.size/.clear/.delete semantics are
// unchanged for callers/tests.
const activeNotifications = new Map();

// Defensive upper bound on simultaneously retained native notifications.
// GNOME itself retains at most 10 notifications per source
// (MAX_NOTIFICATIONS_PER_SOURCE in messageTray.js, oldest evicted with a real
// NotificationClosed), so on the target desktop steady-state retention is
// ~10; the cap protects against daemons with unlimited history and against
// close events that are lost (shell restart/extension reload).
const MAX_ACTIVE_NOTIFICATIONS = 50;

// Lifecycle states for a native notification. EXPIRED deliberately does NOT
// exist: expiration is unobservable on GNOME and we do not fabricate it.
const NOTIF_STATE = Object.freeze({
  CREATED: 'created',                         // Notification constructed
  SHOWN: 'shown',                             // 'show' event: delivered to daemon
  CLICKED: 'clicked',                         // 'click' event (terminal)
  CLOSED_PROGRAMMATIC: 'closed-programmatic', // we called close() (terminal)
  CLOSED_USER_OR_DAEMON: 'closed-user-or-daemon', // daemon 'close' w/o our close() (terminal)
  FAILED: 'failed',                           // 'failed' event (terminal)
  EVICTED: 'evicted'                          // released by the retention cap
});

// Diagnostic logging for the notification path. Prefixed `[notif]` so the real
// packaged-desktop run can be traced with `grep '\[notif\]'` (see the manual
// verification procedure in the README M13 section).
function notifLog(...args) {
  console.log('[notif]', ...args);
}

// Bounded, in-memory ring of lifecycle transitions. Lets the mocked tests
// assert the exact transition sequence and gives on-device debugging a
// machine-readable trail without parsing log lines. Newest last.
const NOTIFICATION_LIFECYCLE_LOG = [];
const MAX_LIFECYCLE_LOG_ENTRIES = 256;

function recordLifecycle(eventId, transition, detail) {
  const entry = {
    eventId: eventId,
    transition: transition,
    detail: detail || '',
    atMs: Date.now()
  };
  NOTIFICATION_LIFECYCLE_LOG.push(entry);
  if (NOTIFICATION_LIFECYCLE_LOG.length > MAX_LIFECYCLE_LOG_ENTRIES) {
    NOTIFICATION_LIFECYCLE_LOG.splice(
      0, NOTIFICATION_LIFECYCLE_LOG.length - MAX_LIFECYCLE_LOG_ENTRIES);
  }
  return entry;
}

// Release the oldest tracked wrappers once the cap is exceeded. Eviction only
// drops OUR reference: the daemon still owns whatever it is showing/storing.
// The trade-off (documented on the M13 block above) is that a wrapper evicted
// while its history entry still exists can no longer deliver 'click' to JS.
function enforceActiveNotificationCap() {
  while (activeNotifications.size > MAX_ACTIVE_NOTIFICATIONS) {
    const oldest = activeNotifications.keys().next().value;
    const meta = activeNotifications.get(oldest);
    activeNotifications.delete(oldest);
    if (meta) {
      meta.state = NOTIF_STATE.EVICTED;
      meta.endedAtMs = Date.now();
      recordLifecycle(meta.eventId, 'evicted',
        'retention cap ' + MAX_ACTIVE_NOTIFICATIONS + ' reached; reference released');
      notifLog('evicted from tracking id=' + meta.eventId +
        ' reason=retention-cap active=' + activeNotifications.size +
        ' (GNOME still owns its banner/history; JS click delivery dropped)');
    }
  }
}

// Single place that closes a native notification and releases its strong
// reference. `close()` maps to libnotify's notify_notification_close()
// (a CloseNotification DBus request) on Linux, so the daemon owns the final
// visual removal; it is idempotent and safe to call after a click/daemon
// close has already destroyed the native object. M13: also finalizes the
// lifecycle state as 'closed-programmatic' (unless a click already claimed
// the terminal state) and marks the record so a synchronous 'close' echo from
// libnotify is classified correctly instead of looking like a user dismissal.
function dismissNotification(nativeNotif, title, reason) {
  notifLog('dismissing id=' + title + ' (' + reason + ')');
  const meta = activeNotifications.get(nativeNotif);
  if (meta) {
    meta.closingByUs = true;
    meta.closeReason = reason;
    if (meta.state !== NOTIF_STATE.CLICKED && meta.state !== NOTIF_STATE.FAILED) {
      meta.state = NOTIF_STATE.CLOSED_PROGRAMMATIC;
      meta.endedAtMs = meta.endedAtMs || Date.now();
      recordLifecycle(meta.eventId, 'closed-programmatic',
        reason + ' — CloseNotification sent by the app');
      notifLog('programmatic close id=' + meta.eventId + ' (' + reason + ')' +
        ' — this removes it from GNOME history, unlike banner expiration');
    }
  }
  try {
    nativeNotif.close();
  } catch (e) {
    notifLog('close() error', title, e && e.message ? e.message : e);
  }
  activeNotifications.delete(nativeNotif);
}

// M10 (kept) + M13: GNOME banner persistence semantics.
//
// Desired behaviour, unchanged from M10 and now enforced by the lifecycle
// state machine above:
//   1. Message arrives -> native GNOME notification via Electron/libnotify.
//   2. Banner shows for GNOME's OWN timeout (timeoutType 'default' ->
//      NOTIFY_EXPIRES_DEFAULT; note GNOME Shell never even reads the client
//      timeout — see the M13 investigation block).
//   3. Banner disappears naturally. This is pure GNOME-side UI: no
//      CloseNotification, no NotificationClosed D-Bus signal, hence NO JS
//      event — not 'close', not anything else. We therefore do not (and
//      cannot) react to expiration, and we never call close() on a timer.
//      Calling close() here would be CloseNotification and would remove the
//      notification from history: the original pre-M10 bug.
//   4. Notification remains in GNOME's notification list/history because it
//      is neither transient nor resident and nobody closed it
//      (resident=false -> it DOES go away once the user finally acts).
//   5. Click (banner or history) -> ActionInvoked "default" -> JS 'click' ->
//      restore/focus window + close() + reference release.
//   6. User dismissal from the list / daemon eviction -> NotificationClosed
//      -> JS 'close' WITHOUT our close() -> reference release.
//
// What M13 adds on top:
//   - per-notification state + [notif] diagnostics distinguishing the four
//     outcomes (see NOTIF_STATE / dismissNotification / the handlers below);
//   - bounded retention (enforceActiveNotificationCap) instead of the
//     unbounded Set, so history-pinned notifications cannot grow the main
//     process without limit;
//   - an explicit statement, in logs and code, that banner expiration is
//     unobservable: absence of events is NOT evidence of expiration.
function showNativeNotification(title, body, eventRecord) {
  const eventId = eventRecord && eventRecord.id ? eventRecord.id : 'native-' + (++nextFallbackNotificationId);
  const tag = eventRecord && eventRecord.tag ? eventRecord.tag : '';
  notifLog('native created id=' + eventId + (tag ? ' tag=' + tag : ''));
  const nativeNotif = new Notification({
    title: title,
    body: body,
    icon: getRuntimeIconFile('icon.png'),
    silent: false,
    // Linux-only: Electron exposes only 'default' (server's own expiry) or
    // 'never' here — there is NO per-notification millisecond timeout, and
    // GNOME Shell ignores the value entirely anyway (M13 investigation).
    // 'default' -> NOTIFY_EXPIRES_DEFAULT (-1) -> GNOME applies its own
    // configured banner timeout (~5s here via the notification-timeout
    // extension). The banner then expires naturally; the notification stays
    // in history because we never call close() in response (that would be
    // CloseNotification and would remove it). Freedesktop persistence model.
    timeoutType: 'default'
    // Deliberately NOT passed (Electron 44 does not wire a JS option into
    // libnotify's replaces-id anyway): no resident/transient/append hints,
    // no replaces-id -> every message stays an independent GNOME
    // notification, persistent (in history) and removed on activation.
  });

  // M13: per-notification lifecycle record (see NOTIF_STATE). All handlers
  // below close over THIS record only — one notification's lifecycle can
  // never touch another's.
  const meta = {
    eventId: eventId,
    tag: tag,
    title: title,
    state: NOTIF_STATE.CREATED,
    closingByUs: false,
    closeReason: null,
    createdAtMs: Date.now(),
    shownAtMs: null,
    endedAtMs: null
  };
  recordLifecycle(eventId, 'created',
    'Notification constructed (timeoutType=default, no timers)' + (tag ? ', tag=' + tag : ''));

  // Keep the wrapper alive against V8 GC for the banner's whole lifetime AND
  // for its persistence in GNOME's notification list. Released only on click,
  // close, failure, or retention-cap eviction. Bounded via the cap below.
  activeNotifications.set(nativeNotif, meta);
  enforceActiveNotificationCap();

  nativeNotif.on('click', () => {
    notifLog('native clicked id=' + eventId + ' (ActionInvoked "default")');
    meta.state = NOTIF_STATE.CLICKED;
    meta.endedAtMs = Date.now();
    recordLifecycle(eventId, 'click',
      'click-triggered close; GNOME also auto-removes non-resident notifications on activation');
    markNotificationRead(eventId, 'native click');
    dismissNotification(nativeNotif, eventId, 'click');
    showAndFocusMainWindow();
  });

  // 'close' is emitted when the daemon reports NotificationClosed for this
  // notification. Verified observable sources of that signal on GNOME:
  //   * the user dismissed/cleared it from the notification list (reason 2);
  //   * WE sent CloseNotification (reason 3) — libnotify may deliver the
  //     echo during or after our close() call, so dismissNotification marks
  //     the record and this handler treats marked records as echoes;
  //   * GNOME evicted it: a source keeps at most 10 notifications, the
  //     oldest is destroyed with reason 1 when the 11th arrives.
  // What NEVER produces this event: banner expiration. A missing event is
  // therefore never logged as expiration — it just means the notification is
  // presumably still in history.
  nativeNotif.on('close', () => {
    const tracked = activeNotifications.get(nativeNotif);
    if (!tracked) {
      // Already released: click path, programmatic close, failure, or
      // retention-cap eviction got there first. Idempotent no-op.
      notifLog('native closed id=' + eventId +
        ' after release — expected echo/no-op, state unchanged');
      recordLifecycle(eventId, 'close-after-release',
        'NotificationClosed arrived after the reference was released');
      return;
    }
    activeNotifications.delete(nativeNotif);
    tracked.endedAtMs = Date.now();
    if (tracked.closingByUs) {
      // Synchronous echo of our own CloseNotification (libnotify routes the
      // daemon's NotificationClosed back into the "closed" GObject signal).
      // dismissNotification already finalized the state.
      notifLog('native closed id=' + eventId + ' origin=programmatic echo (' +
        (tracked.closeReason || 'unknown') + ') active=' + activeNotifications.size);
      return;
    }
    tracked.state = NOTIF_STATE.CLOSED_USER_OR_DAEMON;
    recordLifecycle(eventId, 'closed-user-or-daemon',
      'daemon NotificationClosed without app close(): user dismissal/clear or daemon eviction (10/source cap)');
    notifLog('native closed id=' + eventId +
      ' origin=user-or-daemon (no close() from us; NOT banner expiration) active=' +
      activeNotifications.size);
    // A daemon/user dismissal is not evidence that the WhatsApp message was
    // read; it only releases the native wrapper. Renderer close is handled by
    // its own lifecycle event in handleWebNotification.
  });

  nativeNotif.on('show', () => {
    if (meta.state === NOTIF_STATE.CREATED) {
      meta.state = NOTIF_STATE.SHOWN;
      meta.shownAtMs = Date.now();
      recordLifecycle(eventId, 'shown',
        'delivered to the notification daemon (Electron "show"; banner visibility itself is GNOME-owned)');
    }
    notifLog('native show event id=' + eventId);
  });

  // Surface daemon delivery problems instead of failing silently. Electron
  // destroys the platform notification after 'failed', so no further events
  // can arrive for it; release the reference.
  nativeNotif.on('failed', (ev, error) => {
    meta.state = NOTIF_STATE.FAILED;
    meta.endedAtMs = Date.now();
    activeNotifications.delete(nativeNotif);
    recordLifecycle(eventId, 'failed',
      String(error && error.message ? error.message : (error === undefined ? '' : error)));
    console.error('[notif] failed to display id=' + eventId + ':', error);
    notifLog('failed path released reference id=' + eventId +
      ' active=' + activeNotifications.size);
  });

  notifLog('calling native show id=' + eventId);
  recordLifecycle(eventId, 'show-requested', 'Notification.show() -> notify_notification_show');
  nativeNotif.show();

  // No auto-dismiss timer (M10, kept): GNOME hides the banner on its own
  // timeout and we must not interfere. NOTE the honesty constraint (M13):
  // this line states OWNERSHIP, not an observation — no JS event will ever
  // tell us the banner expired, and we never claim it did.
  notifLog('banner expires via GNOME timeout; history retained id=' + eventId +
    ' (expiration is unobservable by design: no JS event arrives for it)');

  return nativeNotif;
}

// M9 bugfix: single entry point for a notification raised by WhatsApp Web.
//
// ROOT CAUSE (Electron 44.3.0, verified against upstream sources):
//   * `webContents` emits NO 'notification' event, so the former
//     `mainWindow.webContents.on('notification', ...)` handler was dead code:
//     no main-process Notification was ever constructed and no `[notif]` line
//     could ever be logged.
//   * The banners the user saw were WhatsApp Web's own `new Notification()`
//     rendered by Chromium's PlatformNotificationService. GNOME did emit
//     ActionInvoked "default" for them and Electron's libnotify bridge handled
//     it correctly — but NotificationDelegateImpl::NotificationClick() delivers
//     that click to the RENDERER (the page's onclick), not to the main
//     process, and the page's window.focus() does not restore a hidden
//     BrowserWindow (WebContents::ActivateContents only hides an auto-hide
//     menu bar).
//
// FIX: src/preload.js installs a main-world `window.Notification` shim that
// forwards {title, body} over IPC to this function, which runs the SAME
// policy as before (focused-suppression, dedup, unread, settings toggles) and
// then shows OUR native Notification whose `click` event reaches JS here and
// restores/focuses the window.
const WEB_NOTIFICATION_CHANNEL = 'wa-web-notification';

function pruneNotificationEvents() {
  if (notificationEvents.size <= MAX_EVENT_RECORDS) return;
  for (const [id, record] of notificationEvents) {
    if (record.read || notificationEvents.size > MAX_EVENT_RECORDS) notificationEvents.delete(id);
  }
}

function markNotificationRead(id, reason) {
  const record = notificationEvents.get(id);
  if (!record || record.read) return false;
  record.read = true;
  unreadCount = Math.max(0, unreadCount - 1);
  notifLog('unread transition id=' + id + ' -> read (' + reason + '), count=' + unreadCount);
  updateUnreadIndicator(reason + ' (unread=' + unreadCount + ')');
  pruneNotificationEvents();
  return true;
}

function handleRendererNotificationClose(notification) {
  const id = notification && notification.eventId;
  if (!id) return;
  const record = notificationEvents.get(id);
  notifLog('renderer Notification.close received id=' + id);
  if (record && record.native) {
    // This is an explicit sender recall, not a banner timeout. It is therefore
    // correct to remove only this native history item.
    dismissNotification(record.native, id, 'renderer close');
    record.native = null;
  }
  markNotificationRead(id, 'renderer close');
}

function handleWebNotification(notification) {
  const lifecycle = notification && notification.lifecycle ? notification.lifecycle : 'constructor';
  if (lifecycle === 'close') {
    handleRendererNotificationClose(notification);
    return;
  }

  // User is already looking at the app: no banner and no unread event. This is
  // a real read-state signal, unlike focusing a hidden window later.
  if (isMainWindowFocused()) return;

  const title = (notification && notification.title) || 'WhatsApp';
  const body = (notification && notification.body) || '';
  const rendererId = notification && typeof notification.eventId === 'string'
    ? notification.eventId : '';
  const tag = notification && typeof notification.tag === 'string' ? notification.tag : '';

  // Only an explicitly repeated renderer event is a proven duplicate. The
  // legacy no-ID path retains M11 compatibility; it is intentionally not used
  // by the preload shim, which assigns every constructor a unique id.
  if (rendererId && seenRendererEvents.has(rendererId)) {
    notifLog('duplicate suppressed id=' + rendererId + (tag ? ' tag=' + tag : ''));
    return;
  }
  if (rendererId) {
    const now = Date.now();
    seenRendererEvents.set(rendererId, now);
    for (const [seenId, seenAt] of seenRendererEvents) {
      if (now - seenAt > NOTIFICATION_DEDUP_WINDOW_MS) seenRendererEvents.delete(seenId);
    }
  } else if (isDuplicate(title + '|' + body.substring(0, 50))) {
    notifLog('legacy duplicate suppressed (no renderer id)');
    return;
  }

  const id = rendererId || 'fallback-' + (++nextFallbackNotificationId);
  const record = { id: id, tag: tag, title: title, read: false, native: null, hasRendererId: !!rendererId };
  notificationEvents.set(id, record);
  unreadCount++;
  notifLog('renderer event received id=' + id + (tag ? ' tag=' + tag : '') +
    ', unread transition -> ' + unreadCount);
  updateUnreadIndicator('message received (unread=' + unreadCount + ')');

  const s = loadSettings();
  if (!s.notificationsEnabled) {
    notifLog('native suppressed by settings id=' + id);
    return;
  }
  record.native = showNativeNotification(title, s.notificationPreview ? body : '', record);
  pruneNotificationEvents();
}


// Only accept notifications from the WhatsApp Web window itself (the settings
// window has a different preload and never sends on this channel).
ipcMain.on(WEB_NOTIFICATION_CHANNEL, (event, payload) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    return;
  }
  handleWebNotification(payload || {});
});

// ---------------------------------------------------------------------------
// M14 — deterministic GNOME banner expiration
// ---------------------------------------------------------------------------
//
// ROOT CAUSE (settled by M13; re-verified against GNOME Shell 50.1 sources,
// tag 50.1 of GNOME/gnome-shell — see README "M14" for the line-level
// citations):
//
//   Banner presentation and its lifetime are owned by GNOME Shell, not by
//   the notification daemon protocol, not by Electron/libnotify, and not by
//   this app:
//     * js/ui/notificationDaemon.js:136 — NotifyAsync() destructures the
//       client expire_timeout and NEVER reads it. No supported daemon-side
//       knob for banner lifetime exists on GNOME (the `persistence`/
//       `transient` hints change HISTORY membership, not banner timing —
//       transient would even violate "stay in history").
//     * js/ui/messageTray.js — the banner is hidden only when its own
//       NOTIFICATION_TIMEOUT (4000 ms stock) has fired AND the user was
//       active (line 1122/1086: `_userActiveWhileNotificationShown` gate).
//       An idle desktop therefore NEVER expires the banner; a pointer
//       drifting toward it re-arms +1000 ms per check (line 1230); a hover
//       keeps it up (line 1095). Bursts queue (at most 3 banner candidates
//       in total — 1 active + 2 queued; overflow is history-only) and each
//       presented banner gets its own gated timeout. Identical app behaviour,
//       different shell-side policy outcomes — that is the intermittent
//       "banner never disappears" behaviour reported since M10, reproduced
//       with plain notify-send (not WhatsApp-specific).
//   M10/M13 could not guarantee deterministic banners because no client
//   call can change that shell-side policy, and the only client-side lever
//   (CloseNotification / close()) removes the notification from history —
//   the exact regression M10 removed and M13 pinned against.
//
// M14 SOLUTION (least-invasive native mechanism that DOES work):
//
//   A small user-local GNOME Shell extension
//   (whatsapp-deterministic-banner@prr006 — see gnome-extension/) that
//   governs ONLY this app's banners, using the shell's own supported
//   extension API (InjectionManager) on the shell's two banner-timer
//   choke points:
//     1. _showNotification: for banners whose source is the
//        `whatsapp-linux` desktop app, mark the user-active flag so the
//        shell's own expiry check is not gated by the idle monitor;
//     2. _updateNotificationTimeout: establish a fixed deadline
//        (~5 s from when the banner becomes fully visible) and redirect
//        every later re-arm (idle->active, pointer motion, hover refresh)
//        to that same deadline, so no interaction can move the expiry.
//   The banner is hidden exclusively through the shell's standard expiry
//   path, which for non-transient notifications (ours are) keeps the
//   notification in the notification list and emits NO NotificationClosed
//   (messageTray.js `_hideNotificationCompleted` destroys only transient
//   notifications; notificationDaemon.js emits NotificationClosed only on
//   `destroy`). Click semantics (ActionInvoked -> restore/focus, removal
//   from history) are untouched, as is M12 renderer identity, unread
//   accounting, timeoutType 'default', and bounded retention from M13.
//
//   Why an extension and not anything in-process: GNOME Shell exposes no
//   D-Bus or settings API for per-app banner lifetime (verified: the
//   org.freedesktop.Notifications interface is Notify/CloseNotification/
//   GetCapabilities/GetServerInformation + the three signals, nothing
//   else); the shell's own extension mechanism is the supported route, and
//   the same two choke points are used in production by the widely
//   installed "Notification Timeout" extension (GNOME 49/50), which this
//   governor supersedes (scoped to this app; deadline-convergent instead
//   of re-arming fresh intervals on every interaction).
//
// INSTALL (this app, best-effort, user-local, no root):
//   * source: packaged -> resources/gnome-extension (extraResources),
//     dev -> repo gnome-extension/
//   * target: $XDG_DATA_HOME/gnome-shell/extensions/<uuid>
//             (default ~/.local/share/gnome-shell/extensions/<uuid>)
//   * enabled via `gnome-extensions enable <uuid>` (idempotent; a running
//     shell picks it up immediately).
//   Manual: scripts/install-gnome-extension.sh (--uninstall to remove).
//   Scope note: on non-GNOME sessions nothing is installed and the stock
//   banner policy simply applies. The extension matches on the source's
//   resolved desktop app id (`whatsapp-linux`), so notifications from any
//   other application keep their stock behaviour.

const M14_EXTENSION_UUID = 'whatsapp-deterministic-banner@prr006';
const M14_EXTENSION_VERSION = '1.0.0';
const M14_EXTENSION_FILES = ['metadata.json', 'extension.js', 'policy.js', 'package.json'];
const M14_STAMP_FILE = '.m14-install-version';

function m14Log(...args) {
  console.log('[m14]', ...args);
}

// Where the extension files ship from. Packaged apps carry them via
// electron-builder extraResources (see package.json); dev runs use the
// repository directory.
function m14ExtensionSourceDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath || '', 'gnome-extension');
  }
  return path.join(__dirname, '..', 'gnome-extension');
}

// Only act on real GNOME sessions; never touch other desktops.
function m14IsGnomeSession() {
  if (process.platform !== 'linux') return false;
  const desktops = [process.env.XDG_CURRENT_DESKTOP, process.env.XDG_SESSION_DESKTOP].join(' ');
  if (/gnome/i.test(desktops)) return true;
  if (process.env.GNOME_SHELL_VERSION) return true;
  return false;
}

function m14ExtensionTargetDir() {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'gnome-shell', 'extensions', M14_EXTENSION_UUID);
}

function m14ReadStamp(dir) {
  try {
    return fs.readFileSync(path.join(dir, M14_STAMP_FILE), 'utf8').trim();
  } catch (e) {
    return null;
  }
}

function m14EnableExtension() {
  // Best-effort: enable idempotently. A running shell reacts to the
  // enabled-extensions change immediately (no logout required). Errors are
  // logged, never fatal — the extension can always be enabled manually.
  execFile('gnome-extensions', ['enable', M14_EXTENSION_UUID], (err, stdout, stderr) => {
    if (err) {
      m14Log('enable skipped/failed:', err.code === 'ENOENT'
        ? 'gnome-extensions CLI not found (enable from Settings > Extensions)'
        : (err.message || String(err)), (stderr || '').toString().trim());
    } else {
      m14Log('enabled:', M14_EXTENSION_UUID);
    }
  });
}

/**
 * Install (or refresh) the deterministic-banner extension and enable it.
 * Returns a small result object for logging/tests:
 *   { action: 'installed' | 'up-to-date' | 'skipped', reason?, dir? }
 * Safe to call more than once; idempotent per version.
 */
function m14EnsureBannerExtension(reason) {
  if (!m14IsGnomeSession()) {
    return { action: 'skipped', reason: 'not a GNOME session' };
  }
  const srcDir = m14ExtensionSourceDir();
  const entry = path.join(srcDir, 'extension.js');
  if (!fs.existsSync(entry)) {
    m14Log('extension source missing at', srcDir, '(packaging error?)');
    return { action: 'skipped', reason: 'source missing: ' + srcDir };
  }
  const dir = m14ExtensionTargetDir();
  const upToDate =
    m14ReadStamp(dir) === M14_EXTENSION_VERSION &&
    M14_EXTENSION_FILES.every((f) => fs.existsSync(path.join(dir, f)));
  if (upToDate) {
    m14Log('banner extension up-to-date (' + M14_EXTENSION_VERSION + ') at ' + dir, '(reason: ' + (reason || 'startup') + ')');
    return { action: 'up-to-date', dir };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of M14_EXTENSION_FILES) {
      fs.copyFileSync(path.join(srcDir, f), path.join(dir, f));
    }
    fs.writeFileSync(path.join(dir, M14_STAMP_FILE), M14_EXTENSION_VERSION + '\n');
    m14Log('installed banner extension ' + M14_EXTENSION_UUID +
      ' v' + M14_EXTENSION_VERSION + ' at ' + dir + ' (reason: ' + (reason || 'startup') + ')');
    m14EnableExtension();
    return { action: 'installed', dir };
  } catch (e) {
    m14Log('install failed (manual: scripts/install-gnome-extension.sh):',
      e && e.message ? e.message : e);
    return { action: 'skipped', reason: 'install failed: ' + (e && e.message || e) };
  }
}

// M7: set true once the app is genuinely quitting so the close-to-tray handler
// does not intercept the final window close (which would abort the quit).
let isQuitting = false;

const DEFAULT_SETTINGS = {
  closeToTray: true,
  startWithSystem: false,
  startMinimized: false,
  notificationsEnabled: true,
  notificationPreview: true
};

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const data = fs.readFileSync(getSettingsPath(), 'utf8');
    return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(data));
  } catch (e) {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

function saveSettings(s) {
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(s, null, 2));
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

// M9: XDG autostart ("Start with system"). A proper Linux desktop mechanism —
// a .desktop entry in ~/.config/autostart — rather than a cron/hack. The entry
// is written/removed when the setting changes, so the toggle is immediately
// effective and survives logout/login.
function getAutostartDesktopPath() {
  return path.join(app.getPath('appData'), 'autostart', 'whatsapp-linux.desktop');
}

function getAutostartExec() {
  // AppImage: point at the AppImage file itself (APPIMAGE env var is set by the
  // AppImage runtime and survives relocation better than a mutable mount path).
  if (process.env.APPIMAGE) {
    return '"' + process.env.APPIMAGE + '"';
  }
  // Packaged (deb): the real installed executable path.
  if (app.isPackaged) {
    return '"' + process.execPath + '"';
  }
  // Dev: the Electron binary plus the app directory.
  return '"' + process.execPath + '" "' + app.getAppPath() + '"';
}

function setStartWithSystem(enabled) {
  const file = getAutostartDesktopPath();
  try {
    if (enabled) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const lines = [
        '[Desktop Entry]',
        'Type=Application',
        'Version=1.0',
        'Name=WhatsApp for Linux',
        'Comment=Start WhatsApp for Linux when you log in',
        'Exec=' + getAutostartExec(),
        'Terminal=false',
        'X-GNOME-Autostart-enabled=true'
      ];
      fs.writeFileSync(file, lines.join('\n') + '\n');
    } else {
      fs.rmSync(file, { force: true });
    }
    return true;
  } catch (err) {
    console.error('Failed to update autostart entry:', err);
    return false;
  }
}

// M9: whether the window should start hidden (tray only). Honors the persisted
// startMinimized setting; the --start-minimized / --hidden CLI flag overrides it.
function shouldStartHidden(settings) {
  return START_HIDDEN_OVERRIDE || settings.startMinimized === true;
}
function isDuplicate(key) {
  const now = Date.now();
  const last = recentNotifications.get(key);
  if (last && (now - last) < NOTIFICATION_DEDUP_WINDOW_MS) {
    return true;
  }
  recentNotifications.set(key, now);
  // clean old entries to avoid unbounded growth
  for (const [k, v] of recentNotifications) {
    if ((now - v) > NOTIFICATION_DEDUP_WINDOW_MS) {
      recentNotifications.delete(k);
    }
  }
  return false;
}

// M7: single place that restores + shows + focuses the main window. Used by
// notification clicks, the tray "Show WhatsApp" item, second-instance and
// activate, so every path reuses the SAME window/WebView instead of recreating
// WhatsApp Web (requirement: no unnecessary reloads, near-instant resume).
function showAndFocusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  const wasVisible = mainWindow.isVisible();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (!wasVisible) {
    perfLog('resume: restored hidden window');
  }
}

// M7: true when the user is actively looking at the window. A notification
// banner is redundant on top of a chat the user can already see.
function isMainWindowFocused() {
  return !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused());
}


// ---------------------------------------------------------------------------
// M11 — Linux dock / app-icon unread badge
// ---------------------------------------------------------------------------
//
// WHAT IS ACTUALLY SUPPORTED ON GNOME/Wayland (verified 2026-09-14)
//
// * Stock GNOME Shell (including GNOME 50 "Tokyo", released 2026-03-18) has NO
//   app-icon badge/counter. The upstream request is still open and unassigned:
//   gitlab.gnome.org/GNOME/gnome-shell/-/work_items/511 ("Attention badges on
//   icons in application switcher and activities dock", status **Open**,
//   labels "1. Feature" + "2. Needs Design"); the related #319 "Favourites
//   should use notification badges" was closed **"3. Out of Scope"**. So there
//   is no GNOME-native badge API to call — nothing we can do will put a number
//   on the dash of a vanilla GNOME 50 session.
//
// * The de-facto protocol every Linux dock implements is Canonical's
//   **Unity Launcher API** (`com.canonical.Unity.LauncherEntry`). It is a plain
//   session-bus D-Bus signal, so it works identically under X11 and Wayland
//   (no X11 property, no window handle, nothing Wayland-specific). Confirmed in
//   source this milestone for Dash to Dock (launcherAPI.js + gschema) and its
//   Ubuntu Dock fork; Dash to Panel, plank and gershwin-workspace implement it
//   too, and it is the protocol Firefox/Thunderbird/Telegram/Evolution use.
//
// * **Electron 44 supports it natively.** electron#52895 ("Restored
//   app.setBadgeCount and win.setProgressBar for Linux") landed in 44.0.0 and
//   is in the 44.3.0 this app pins. `Browser::SetBadgeCount()` calls
//   `electron::launcher_entry::SetBadgeCount()`, which emits on the session
//   bus:
//       signal com.canonical.Unity.LauncherEntry.Update
//       path   /com/canonical/unity/launcherentry
//       args   ("application://<CHROME_DESKTOP>",
//               {"count": <x int64>, "count-visible": <b bool = count != 0>})
//   It no longer needs libunity (the old implementation dlopen'd
//   libunity.so.9, which no GNOME system ships), and `app.isUnityRunning()` was
//   removed. This is a *supported Electron API*, not a hack — so we use it and
//   do NOT hand-roll the D-Bus traffic ourselves.
//
// * Dash to Dock renders it by default. Its gschema defaults are
//   `show-icons-emblems=true`, `show-icons-notifications-counter=true` and
//   `application-counter-overrides-notifications=true`, and
//   appIconIndicators.js `_updateNotificationsCount()` prefers the app-provided
//   `count` whenever it is > 0. launcherAPI.js subscribes with `path = null`,
//   so Electron's object path is accepted.
//
// CONSEQUENCE: emitting the signal is correct and unconditional; whether a
// number is *painted* is the dock's decision. On a bare GNOME 50 session
// nothing is painted, on Ubuntu Dock / Dash to Dock the unread count appears.
// That is the honest ceiling — the app must not fake a badge inside its own
// window to compensate, and must not depend on a dock we cannot detect.
//
// Known protocol limitation (dash-to-dock#708): the API is signal-only, there
// is no state to re-query, so if the dock is disabled/restarted (GNOME Shell
// disables extensions on screen lock) a badge set while it was away is lost
// until the count next changes. We re-emit on every change and force one final
// clear on quit; we deliberately do NOT add a polling re-announce loop.
// ---------------------------------------------------------------------------

// `[badge]`-prefixed log lines, mirroring the `[notif]` convention so a real
// packaged-desktop run can be traced with `grep '\[badge\]'`.
function badgeLog(...args) {
  console.log('[badge]', ...args);
}

// Every badge state transition, newest last. Exported for the mocked-Electron
// tests. `delivered` is true only when Electron actually emitted the D-Bus
// signal (Linux + working setBadgeCount); `count` is what we *intended*, which
// is the part the unread state machine is responsible for on every platform.
const BADGE_UPDATES = [];

// Last count handed to Electron. `null` = nothing pushed yet, so the very first
// update is always emitted (including a "0" that confirms a clean start).
let lastPushedBadgeCount = null;

function dockBadgeSupported() {
  return process.platform === 'linux' && typeof app.setBadgeCount === 'function';
}

// Unconditionally push `count` to the dock (0 hides the badge: Electron sends
// `count-visible = count != 0`).
function pushDockBadge(count, reason) {
  const normalized = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  const entry = {
    count: normalized,
    reason: reason || 'unknown',
    delivered: false,
    ok: null,
    error: null,
    at: Date.now()
  };

  lastPushedBadgeCount = normalized;

  if (!dockBadgeSupported()) {
    entry.error = process.platform === 'linux'
      ? 'app.setBadgeCount unavailable (Electron < 44?)'
      : 'not linux (' + process.platform + ')';
    BADGE_UPDATES.push(entry);
    badgeLog('skip app.setBadgeCount(' + normalized + '):', entry.error, '|', entry.reason);
    return entry;
  }

  try {
    // Returns false when Electron could not resolve the app's desktop ID
    // (CHROME_DESKTOP unset) — see DESKTOP_FILE_ID above, which is why we call
    // app.setDesktopName() at startup.
    entry.ok = app.setBadgeCount(normalized) === true;
    entry.delivered = entry.ok;
    badgeLog(
      'app.setBadgeCount(' + normalized + ') ->',
      entry.ok ? 'emitted' : 'REJECTED (desktop id unresolved?)',
      '|', entry.reason
    );
  } catch (err) {
    entry.error = err && err.message ? err.message : String(err);
    badgeLog('app.setBadgeCount(' + normalized + ') threw:', entry.error, '|', entry.reason);
  }

  BADGE_UPDATES.push(entry);
  return entry;
}

// Sync the dock badge with the existing unread state. Deduplicated: the Unity
// launcher protocol is fire-and-forget, so re-sending an unchanged count would
// only add session-bus noise (and would re-trigger a badge animation).
function updateDockBadge(reason) {
  const count = unreadCount > 0 ? unreadCount : 0;
  if (lastPushedBadgeCount === count) {
    return null;
  }
  return pushDockBadge(count, reason);
}

function updateUnreadIndicator(reason) {
  // M11: the dock badge is the primary Linux indicator and must NOT depend on
  // the tray having been created successfully (the old `if (!tray) return;`
  // guard silently disabled every indicator when tray init failed).
  updateDockBadge(reason);

  // Tray tooltip + tray icon unread state (unchanged from M2/M3).
  if (tray) {
    if (unreadCount > 0) {
      tray.setToolTip('WhatsApp — ' + unreadCount + ' unread');
    } else {
      tray.setToolTip('WhatsApp for Linux');
    }
  }

  // Windows-only taskbar overlay (win.setOverlayIcon is @platform win32, so on
  // Linux this was always a no-op). Kept for Windows; the Linux badge above is
  // the real dock indicator.
  if (mainWindow && process.platform === 'win32') {
    const badgePath = getRuntimeIconFile('icon-badge.png');
    try {
      mainWindow.setOverlayIcon(unreadCount > 0 ? badgePath : null);
    } catch (e) { /* overlay not critical */ }
  }
}

// Lock to single instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, argv, workingDirectory) => {
    // Reuse the existing window (also works when hidden to tray) instead of
    // creating a second one. Single-instance lock already guarantees only one
    // process exists.
    showAndFocusMainWindow();
  });
}

// M8: "first meaningful WhatsApp UI ready" detection.
//
// Read-only probe — the M1 principle (no DOM injection, no CSS, no JS
// overrides) stays intact: nothing is written into the page. We only ask the
// renderer whether any known "usable" element exists:
//   logged-in session: #side, #pane-side, [data-testid="chat-list"]
//   fresh session:     [data-testid="qrcode"], .qr-code, canvas[aria-label]
// Either side is the point at which the user can actually use WhatsApp, so
// the first match is the "usable" timestamp for cold-start measurement.
// Multiple selectors per side: a single WhatsApp DOM rename must not silently
// break the measurement (M8 measurement fix — the old single selectors
// #side / .qr-code no longer cover the real page on their own).
const UI_READY_PROBE = [
  '(function () {',
  "  if (document.querySelector('#side') ||",
  "      document.querySelector('#pane-side') ||",
  '      document.querySelector(\'[data-testid="chat-list"]\')) return \'chat-list\';',
  '  if (document.querySelector(\'[data-testid="qrcode"]\') ||',
  "      document.querySelector('.qr-code') ||",
  "      document.querySelector('canvas[aria-label]')) return 'qr-code';",
  '  return null;',
  '})()'
].join('\n');
const UI_READY_POLL_INTERVAL_MS = 500;
let uiReadyTimer = null;

function stopFirstUIReadyProbe() {
  if (uiReadyTimer !== null) {
    clearInterval(uiReadyTimer);
    uiReadyTimer = null;
  }
}

// Idempotent (guarded): 'dom-ready' can fire again on reloads, but the probe
// is (re)started only when it is not already running, and stops after the
// first match — the first meaningful UI after startup is what gets recorded.
function startFirstUIReadyProbe() {
  if (uiReadyTimer !== null) return;
  uiReadyTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() ||
        mainWindow.webContents.isDestroyed()) {
      stopFirstUIReadyProbe();
      return;
    }
    mainWindow.webContents
      .executeJavaScript(UI_READY_PROBE, false)
      .then((result) => {
        if (result) {
          perfLog('first meaningful UI ready (' + result + ')');
          stopFirstUIReadyProbe();
        }
      })
      .catch(() => {
        // Renderer mid-navigation/reload: just retry on the next tick.
      });
  }, UI_READY_POLL_INTERVAL_MS);
}

function createWindow () {
  // Default session already persists cookies / IndexedDB to userData
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'WhatsApp for Linux',
    icon: getRuntimeIconFile('icon.png'),
    webPreferences: {
      // Minimal safe settings; no node integration exposed
      nodeIntegration: false,
      contextIsolation: true,
      allowRunningInsecureContent: false,
      webSecurity: true,
      // M9 bugfix: preload installs the main-world `window.Notification`
      // shim that forwards WhatsApp Web's notifications to the main process
      // (see src/preload.js and handleWebNotification above).
      preload: path.join(__dirname, 'preload.js'),
      // Preserve session data (cookies, localStorage, IndexedDB)
      partition: 'persist:whatsapp-linux'
    },
    show: false,
    backgroundColor: '#111b21'
  });
  perfLog('BrowserWindow created');

  // M8: mark loadURL start; the gap from here to 'dom-ready' below is the
  // network + page-boot cost.
  perfLog('loadURL start');

  // Load WhatsApp Web directly — NO DOM injection, NO custom CSS per principles
  mainWindow.loadURL('https://web.whatsapp.com', {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  });

  // Show when ready to reduce visual flicker
  const settings = loadSettings();
  const startHidden = shouldStartHidden(settings);
  mainWindow.once('ready-to-show', () => {
    perfLog('ready-to-show');
    if (startHidden) {
      // Start minimized (or --start-minimized): stay in the tray.
      mainWindow.hide();
      console.log('Starting hidden to tray (start minimized)');
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Handle external links gracefully (open in default browser)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url && !url.includes('web.whatsapp.com')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Before unload — not blocking; just logging for debug
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('Load failed:', validatedURL, errorCode, errorDescription);
  });

  // M8: DOM-level load stage, and start the read-only first-meaningful-UI
  // probe (see UI_READY_PROBE above). Primary trigger; did-finish-load below
  // re-starts the (idempotent) probe as a fallback for runs where dom-ready
  // is never delivered (observed in packaged runs).
  mainWindow.webContents.on('dom-ready', () => {
    perfLog('dom-ready');
    startFirstUIReadyProbe();
  });

  // M2 fix: close-to-tray — prevent window destruction on X, hide instead.
  // M7: during a real quit (isQuitting) the window must be allowed to close,
  // otherwise app.quit() would be aborted by the very handler meant to keep
  // the app alive in the tray.
  mainWindow.on('close', (e) => {
    const s = loadSettings();
    if (s.closeToTray && !isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      console.log('Window hidden to tray (close prevented)');
    }
  });

  // Window actually destroyed (e.g., app quit), clean up reference
  mainWindow.on('closed', () => {
    stopFirstUIReadyProbe();
    mainWindow = null;
  });

  // Log navigation for debugging compatibility
  mainWindow.webContents.on('did-navigate', (event, url) => {
    console.log('Navigated to:', url);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    perfLog('did-finish-load (WhatsApp Web loaded)');
    console.log('Page loaded successfully');
    // M8 measurement fix: fallback probe start. Packaged runs were observed
    // to log did-finish-load (and ready-to-show) without ever logging
    // dom-ready, which left the first-meaningful-UI probe idle and the run
    // stuck at "USABLE NOT REACHED". did-finish-load demonstrably fires in
    // those runs, so (re)start the probe here too. startFirstUIReadyProbe is
    // idempotent, so the normal dom-ready-first path is unchanged: no extra
    // polling, no startup behaviour change — measurement only.
    startFirstUIReadyProbe();
  });

  // M7/M9: WhatsApp Web's notifications are routed to handleWebNotification()
  // via the WEB_NOTIFICATION_CHANNEL IPC (registered once at module scope,
  // see handleWebNotification above). Electron's webContents has no 'notification' event — the
  // previous `webContents.on('notification', ...)` handler never fired.

  // M3: reset unread when user returns to app
  // M11: clearing unread here is also what clears the dock badge — the badge is
  // derived from the same counter, so "focus the app" and "badge disappears"
  // stay in lockstep with the tray tooltip.
  function clearLegacyUnread(reason) {
    let changed = false;
    for (const record of notificationEvents.values()) {
      if (!record.hasRendererId && !record.read) {
        record.read = true;
        changed = true;
      }
    }
    if (changed) {
      unreadCount = 0;
      updateUnreadIndicator(reason);
      badgeLog('legacy unread cleared by', reason);
    }
  }
  mainWindow.on('focus', () => {
    // Do not infer read state for shim-generated events. WhatsApp's renderer
    // lifecycle (close) or a notification click must clear those individually.
    clearLegacyUnread('window focused');
  });
  mainWindow.on('show', () => {
    clearLegacyUnread('window shown from tray');
  });
}

function createSettingsWindow () {
  const settingsWindow = new BrowserWindow({
    width: 560,
    height: 640,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'WhatsApp for Linux — Settings',
    icon: getRuntimeIconFile('icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-settings.js')
    },
    show: false,
    backgroundColor: '#111b21'
  });
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
    settingsWindow.focus();
  });
  settingsWindow.on('closed', () => {
    // clean reference if needed; not critical
  });
}


// M4: Settings IPC
ipcMain.handle('get-settings', () => loadSettings());
ipcMain.handle('set-settings', (event, settings) => {
  saveSettings(settings);
  applySettings(settings);
  return true;
});

function applySettings(s) {
  // Start with system: applied immediately via the XDG autostart entry.
  setStartWithSystem(s.startWithSystem === true);
  // closeToTray / notificationsEnabled / notificationPreview are re-read from
  // disk at each use (window close handler, notification handler), so they
  // apply immediately too.
  // startMinimized only affects the NEXT launch (hidden on startup).
  console.log('Settings applied:', s);
}

function createTray () {
  const { image, filePath } = loadNativeIcon('icon.png');
  if (image.isEmpty()) {
    throw new Error('Failed to load tray icon from path \'' + filePath + '\'');
  }

  tray = new Tray(image);
  tray.setToolTip('WhatsApp for Linux');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show WhatsApp',
      click: () => {
        showAndFocusMainWindow();
      }
    },
    {
      label: 'Settings',
      click: () => {
        createSettingsWindow();
      }
    },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
  perfLog('tray created');
}

app.whenReady().then(() => {
  perfLog('app ready');
  // M14: install/refresh the deterministic-banner GNOME extension before the
  // first notification can arrive. Best-effort and fast (a few tiny file
  // copies at most); non-GNOME sessions are skipped. Never blocks startup.
  m14EnsureBannerExtension('app ready');
  createWindow();
  try {
    createTray();
  } catch (err) {
    tray = null;
    console.error('Tray initialization failed:', err && err.message ? err.message : err);
  }

  // M7: reuse the single helper so every activation path restores the same
  // window (createWindow() is called lazily only if it no longer exists).
  app.on('activate', () => {
    showAndFocusMainWindow();
  });
}).catch((err) => {
  console.error('App ready failed:', err && err.message ? err.message : err);
});

app.on('window-all-closed', () => {
  // On Linux, keep app running in tray if tray exists (standard desktop behavior)
  if (process.platform !== 'darwin' && tray) {
    // Keep running; don't quit
    return;
  }
  app.quit();
});

app.on('before-quit', () => {
  // M7: mark a genuine quit so the close-to-tray handler lets the window close.
  isQuitting = true;
  stopFirstUIReadyProbe();
  // M11: force a final count=0 so no dock is left showing a stale badge for an
  // app that is gone. Most docks also drop the entry when our session-bus name
  // disappears (Dash to Dock tracks it via NameOwnerChanged), but that is the
  // dock's behaviour, not a contract we should rely on.
  if (lastPushedBadgeCount !== null && lastPushedBadgeCount !== 0) {
    pushDockBadge(0, 'app quitting');
  }
  // Clean log before exit
  console.log('WhatsApp for Linux shutting down');
});

// M8/M9/M11/M13/M14: export internals for the mocked-Electron test harness
// (test/m7-lifecycle.test.js, test/m9-linux-integration.test.js,
//  test/m10-gnome-persistence.test.js, test/m11-dock-badge.test.js,
//  test/m13-banner-lifecycle.test.js, test/m14-deterministic-banner.test.js).
// Electron ignores main-process exports.
module.exports = {
  __perfStartMs: PERF_START_MS,
  __perfEvents: PERF_EVENTS,
  __uiReadyProbe: UI_READY_PROBE,
  __startHiddenOverride: START_HIDDEN_OVERRIDE,
  __shouldStartHidden: shouldStartHidden,
  __getAutostartDesktopPath: getAutostartDesktopPath,
  __getAutostartExec: getAutostartExec,
  __setStartWithSystem: setStartWithSystem,
  __activeNotifications: activeNotifications,
  __showNativeNotification: showNativeNotification,
  __dismissNotification: dismissNotification,
  __notificationEvents: notificationEvents,
  __markNotificationRead: markNotificationRead,
  // M13: lifecycle state machine / bounded retention
  __notifState: NOTIF_STATE,
  __maxActiveNotifications: MAX_ACTIVE_NOTIFICATIONS,
  __notificationLifecycleLog: NOTIFICATION_LIFECYCLE_LOG,
  __enforceActiveNotificationCap: enforceActiveNotificationCap,
  __recordLifecycle: recordLifecycle,
  // M14: deterministic GNOME banner expiration (extension install)
  __m14: {
    extensionUuid: M14_EXTENSION_UUID,
    extensionVersion: M14_EXTENSION_VERSION,
    extensionFiles: M14_EXTENSION_FILES,
    stampFile: M14_STAMP_FILE,
    isGnomeSession: m14IsGnomeSession,
    extensionSourceDir: m14ExtensionSourceDir,
    extensionTargetDir: m14ExtensionTargetDir,
    ensureBannerExtension: m14EnsureBannerExtension
  },
  // M11: dock/app-icon unread badge
  __desktopFileId: DESKTOP_FILE_ID,
  __badgeUpdates: BADGE_UPDATES,
  __dockBadgeSupported: dockBadgeSupported,
  __pushDockBadge: pushDockBadge,
  __updateDockBadge: updateDockBadge,
  __getUnreadCount: () => unreadCount
};
