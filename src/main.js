/**
 * WhatsApp for Linux — Main Process
 * M1 Proof of Concept: loads WhatsApp Web with persistent session.
 */

const { app, BrowserWindow, Tray, Menu, dialog, shell, Notification, ipcMain, nativeImage } = require('electron');
const fs = require('fs');

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

// M9 bugfix: strong references to every live native notification.
//
// Electron's `Notification` is a thin JS wrapper around the libnotify object;
// the JS wrapper only holds a WeakPtr to the native side. If the JS object is
// garbage collected, Electron calls `set_delegate(nullptr)` on the native
// notification, after which the `click` event can no longer be delivered to JS
// (so `showAndFocusMainWindow()` never runs) — the canonical "Linux
// notification click does nothing" failure. Retaining each notification here,
// and releasing it only on click / daemon close / failure, keeps click
// delivery alive for the banner's entire visible lifetime (and now for the
// full GNOME history lifetime, see M10 below).
const activeNotifications = new Set();

// Diagnostic logging for the notification path. Prefixed `[notif]` so the real
// packaged-desktop run can be traced with `grep '[notif]'` (see the manual
// verification procedure in the M9 bugfix notes / README).
function notifLog(...args) {
  console.log('[notif]', ...args);
}

// Single place that closes a native notification and releases its strong
// reference. `close()` maps to libnotify's notify_notification_close()
// (a CloseNotification DBus request) on Linux, so the daemon owns the final
// visual dismissal; it is idempotent and safe to call after a click/daemon
// close has already destroyed the native object.
function dismissNotification(nativeNotif, title, reason) {
  notifLog('dismissing (' + reason + ')', title);
  try {
    nativeNotif.close();
  } catch (e) {
    notifLog('close() error', title, e && e.message ? e.message : e);
  }
  activeNotifications.delete(nativeNotif);
}

// M10: GNOME banner persistence fix — investigation and new semantics.
//
// freedesktop.org Desktop Notifications spec (hints table):
//   - "resident" BOOLEAN: When set the server will NOT automatically remove
//     the notification when an action has been invoked. The notification will
//     remain resident in the server until it is explicitly removed by the user
//     or by the sender. Useful when server has "persistence" capability.
//   - "transient" BOOLEAN: When set the server will treat the notification as
//     transient and by-pass the server's persistence capability, if it should
//     exist. Transient notifications do NOT stay in history.
//   - "persistence" capability: The server supports persistence of
//     notifications. Notifications will be retained until they are acknowledged
//     or removed by the user or recalled by the sender.
//
// GNOME Shell (https://blogs.gnome.org/marina/2011/01/07/notifications-with-character/):
//   - Enables persistent notifications by default.
//   - A new notification is first shown as a pop-out (banner) for a certain
//     time period (GNOME-configured, ~5s). When the pop-out is hidden, the
//     notification is still available in the message tray / notification center.
//   - The notification is only removed when the user interacts with it or
//     switches to the application that sent it. This default persistent behavior
//     ensures notifications are less disruptive.
//   - Resident notifications stay even after interaction (e.g. Rhythmbox with
//     playback controls). Transient notifications are NOT kept at all after
//     being shown (e.g. non-critical battery info).
//
// Electron 44.3.0 Linux implementation (shell/browser/notifications/linux/libnotify_notification.cc):
//   - Show():
//     * notify_notification_new(title, body)
//     * timeout = NOTIFY_EXPIRES_DEFAULT (-1) when timeoutType='default',
//       NOTIFY_EXPIRES_NEVER (0) when timeoutType='never'. DEFAULT lets the
//       server (GNOME) decide the banner timeout (~5s via gsettings).
//     * Adds action "default" ("View") if server has "actions" capability.
//     * Does NOT set "resident" or "transient" hints → defaults to
//       resident=false, transient=false → persistent: banner expires naturally,
//       stays in history, removed on action/invocation.
//     * Sets "append" hint if server supports it, plus desktop-entry and sender-pid.
//   - Dismiss():
//     * notify_notification_close() → CloseNotification DBus method → server
//       explicitly removes notification from both banner AND history.
//   - OnNotificationClosed signal → NotificationDismissed(!on_dismissing_)
//     distinguishes client-initiated close vs server/user dismissal.
//   - OnNotificationView → NotificationClicked → our 'click' handler.
//
// Previous behavior (M7-M9):
//   - Created Notification with timeoutType='default' (correct for GNOME timeout)
//   - BUT also scheduled setTimeout 5000ms → close() → CloseNotification → removed
//     from history entirely, defeating GNOME persistence.
//   - User saw banner for 5s, then it vanished with no trace in notification center.
//
// Desired (M10):
//   1. Message arrives → native GNOME notification via Electron/libnotify.
//   2. Banner remains for GNOME-configured timeout (~5s) via timeoutType='default'.
//   3. Banner disappears naturally (server hides pop-out, NOT CloseNotification).
//   4. Notification remains in GNOME notification center/history because it has
//      NOT been acted upon and we did NOT call CloseNotification.
//   5. Clicking the notification (banner or history) → ActionInvoked "default"
//      → Electron click event → restore/focus window + close() to remove from history.
//   6. After user acts/clicks, notification is removed appropriately via close().
//   7. Preserve unread count, deduplication, settings, native behavior.
//
// Implementation: Do NOT call close() on a timer. Keep strong reference in
// activeNotifications until click / close / failed, so click delivery stays alive
// for the full history lifetime (GNOME keeps notification until dismissed).
function showNativeNotification(title, body) {
  notifLog('constructing', title);
  const nativeNotif = new Notification({
    title: title,
    body: body,
    icon: getRuntimeIconFile('icon.png'),
    silent: false,
    // Linux-only: Electron exposes only 'default' (server's own expiry) or
    // 'never' here — there is NO per-notification millisecond timeout.
    // 'default' → NOTIFY_EXPIRES_DEFAULT (-1) → GNOME uses its configured
    // timeout (~5s, gsettings org.gnome.desktop.notifications). The banner
    // then expires naturally but the notification stays in the center because
    // we do NOT call close() (which would be CloseNotification and would remove
    // it from history). This is the freedesktop persistence model.
    timeoutType: 'default'
  });

  // Keep the wrapper alive against V8 GC for the banner's whole lifetime AND
  // for its persistence in GNOME's notification center. Released only on click
  // (user acted), daemon/user close, or failure.
  activeNotifications.add(nativeNotif);

  nativeNotif.on('click', () => {
    notifLog('click -> restore/focus window', title);
    dismissNotification(nativeNotif, title, 'click');
    showAndFocusMainWindow();
  });

  // 'close' is emitted when the notification is dismissed — by our close()
  // on click, by the user dismissing from the center, or by the daemon.
  // It is NOT emitted when the banner merely expires in GNOME's persistent
  // model (banner hides but notification stays in history). We release the
  // reference here so activeNotifications does not grow without bound.
  nativeNotif.on('close', () => {
    notifLog('close event (dismissed by user/daemon or after click)', title);
    activeNotifications.delete(nativeNotif);
  });

  nativeNotif.on('show', () => {
    notifLog('show event (banner visible)', title);
  });

  // Surface daemon delivery problems instead of failing silently.
  nativeNotif.on('failed', (ev, error) => {
    console.error('[notif] failed to display:', title, error);
    activeNotifications.delete(nativeNotif);
  });

  notifLog('calling show()', title);
  nativeNotif.show();

  // No auto-dismiss timer: let GNOME's own timeout hide the banner naturally.
  // The notification remains in the notification center/history until the user
  // acts on it (click) or dismisses it, at which point 'close' fires and we
  // release the reference. Calling close() here would be CloseNotification and
  // would remove it from history, which is the bug we are fixing.
  notifLog('banner will expire via GNOME-configured timeout, remains in history until acted upon', title);

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

function handleWebNotification(notification) {
  // User is already looking at the app: no banner, no unread bump.
  if (isMainWindowFocused()) {
    return;
  }

  const title = (notification && notification.title) || 'WhatsApp';
  const body = (notification && notification.body) || '';

  // Dedup key: title + first 50 chars of body.
  const dedupKey = title + '|' + body.substring(0, 50);
  if (isDuplicate(dedupKey)) {
    console.log('Notification suppressed (duplicate):', title);
    return;
  }

  // Count as unread regardless of the notification toggle (keeps M2/M3
  // tray badge/tooltip behaviour intact even when banners are disabled, and
  // M11 keeps the dock badge on the same counter).
  unreadCount++;
  updateUnreadIndicator('message received (unread=' + unreadCount + ')');

  const s = loadSettings();
  if (!s.notificationsEnabled) {
    console.log('Notification suppressed (disabled by setting):', title, '| unread=', unreadCount);
    return;
  }

  showNativeNotification(title, s.notificationPreview ? body : '');
  console.log('Native notification shown:', title, '| unread=', unreadCount);
}

// Only accept notifications from the WhatsApp Web window itself (the settings
// window has a different preload and never sends on this channel).
ipcMain.on(WEB_NOTIFICATION_CHANNEL, (event, payload) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    return;
  }
  handleWebNotification(payload || {});
});

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
  mainWindow.on('focus', () => {
    if (unreadCount > 0) {
      unreadCount = 0;
      updateUnreadIndicator('window focused');
      console.log('Unread cleared (focus)');
    }
  });
  mainWindow.on('show', () => {
    if (unreadCount > 0) {
      unreadCount = 0;
      updateUnreadIndicator('window shown from tray');
      console.log('Unread cleared (show from tray)');
    }
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

// M8/M9/M11: export internals for the mocked-Electron test harness
// (test/m7-lifecycle.test.js, test/m9-linux-integration.test.js,
//  test/m10-gnome-persistence.test.js, test/m11-dock-badge.test.js).
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
  // M11: dock/app-icon unread badge
  __desktopFileId: DESKTOP_FILE_ID,
  __badgeUpdates: BADGE_UPDATES,
  __dockBadgeSupported: dockBadgeSupported,
  __pushDockBadge: pushDockBadge,
  __updateDockBadge: updateDockBadge,
  __getUnreadCount: () => unreadCount
};
