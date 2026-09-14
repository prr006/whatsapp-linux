# WhatsApp for Linux

A polished, lightweight Linux desktop client around the official WhatsApp Web experience.

> **Status:** M14 (current) — deterministic ~5 s GNOME banner presentation with notification-list history preserved, building on M13 (GNOME banner expiry root cause + lifecycle state machine), M12 (notification contract / per-notification identity), M11 (Linux dock/app-icon unread badge), M10 (GNOME banner persistence), M9 (Linux desktop integration, settings, notification polish, release polish), M8 (startup profiling) and M7 (startup + notification UX). The 4–5 s usable / 1–2 s tray figures were measured on a real machine during M8/M9; the on-device M14 confirmation is the documented *M14 → Verification* matrix (this sandbox has no display).

## Project Goals (from specification)
- WhatsApp Web login via QR
- Persistent login/session
- Chats and groups
- Native Linux notifications, unread indicators, system tray
- Minimize-to-tray, close-to-tray, start with system
- Keyboard shortcuts, desktop entry, icons, AppImage/DEB/RPM
- Dark/light integration where possible

## Technology Decision (M1)
**Electron 44 + Chromium** (via npm)
- Full WhatsApp Web compatibility guaranteed (Chrome-class engine)
- Session persistence via `persist:` partition (IndexedDB, cookies, cache)
- Zero dependency on system WebKitGTK versions (critical on Linux)
- Full WebRTC support for future voice/video calls

**Phase 2 recommendation:** Tauri v2 + WebKitGTK if target distributions provide `webkit2gtk-4.1 >= 2.46.1` and WebRTC is not required. Tauri is lighter binary (~50 MB vs ~180 MB) but requires rustc + GTK dev libs not present here.

## Milestone Plan
- M1 (this branch): Proof of concept — window loads WhatsApp Web, QR login, session persistence, tray, build scaffold.
- M2 (after approval): Notifications, unread badges, drag/drop, keyboard shortcuts, settings.
- M3: Full tray/menu integration, close-to-tray, start minimized, packaging.
- M4 (optional): Voice/video calls, app lock, updater.
- M7 (merged): Startup + notification UX polish — see below.
- M8 (merged): Startup profiling / cold-start measurement — see below.
- M9 (merged): Linux integration, settings, notifications & release polish — see below.
- M10 (merged): GNOME banner persistence fix (`test/m10-gnome-persistence.test.js`).
- M11 (merged): Linux dock / app-icon unread badge — see below.
- M12 (merged): notification contract — per-notification identity & dedup (`test/m12-notification-contract.test.js`).
- M13 (merged): GNOME native banner expiration/dismissal — root cause + lifecycle state machine — see below.
- **M14 (current): deterministic ~5 s GNOME banner presentation, history preserved** — see below.

## M7 — Startup & Notification UX
- **Notifications** (see `webContents.on('notification')` in `src/main.js`):
  - Banners only appear when the app is **not** already focused.
  - Banners auto-dismiss after a bounded ~5 s (`NOTIFICATION_TIMEOUT_MS`), for
    daemons that otherwise keep them up indefinitely.
  - Clicking a banner dismisses it and restores/focuses the **same** window
    (single-instance lock guarantees no second process).
  - Duplicate suppression is preserved.
  - Notifications are disabled gracefully by the existing settings toggle.
- **Startup / resume**:
  - A genuine quit (`before-quit` → `isQuitting`) now lets the window close,
    so tray "Quit" is no longer blocked by the close-to-tray handler.
  - Every activation path (tray, notification click, second instance, macOS
    `activate`) routes through one `showAndFocusMainWindow()` helper that
    reuses the existing BrowserWindow/webContents — the WhatsApp Web instance
    is never destroyed or reloaded while hidden in the tray.
  - `[perf]` log lines timestamp main-process start → `BrowserWindow created` →
    `ready-to-show` → `did-finish-load` → `tray created`, and log tray-resume
    restores, so cold-start and resume cost can be measured on a real machine.
    M8 completes this to a full 9-point instrumented timeline (below).
- **Tests**: `npm test` runs every `test/*.test.js` with a mocked Electron (no
  display needed) covering close-to-tray, focused/hidden notification
  behaviour, auto-dismiss, click-to-restore, dedup, disabled toggle,
  single-instance, quit-cascade, and the M8 instrumentation timeline.

## M8 — Startup Profiling / Cold-Start Measurement

Goal: measure real cold-start cost per stage and determine whether the app
can get **usable in under 3 seconds**. M8 adds **measurement only — no
performance changes** (analysis and any optimisation come after data exists).

### What is measured (9 points, `[perf]` lines in stdout)

| # | Point | Meaning |
|---|-------|---------|
| 1 | `main process started` | main.js module load (≈ process start; true spawn is captured by the harness) |
| 2 | `app ready` | Electron `app.whenReady()` resolved |
| 3 | `BrowserWindow created` | window object constructed |
| 4 | `loadURL start` | `loadURL(web.whatsapp.com)` issued |
| 5 | `dom-ready` | first DOM of the page available |
| 6 | `ready-to-show` | window painted, safe to show |
| 7 | `tray created` | tray icon + menu ready (the "1–2 s" user-visible point) |
| 8 | `did-finish-load` | initial load finished |
| 9 | `first meaningful UI ready` | user can actually use WhatsApp |

Point 9 is detected with a **read-only probe** (no DOM injection / CSS / JS
overrides — the M1 principle stays intact): after `dom-ready` (with
`did-finish-load` as a fallback trigger — packaged runs were observed to
deliver the latter without the former), every 500 ms the renderer is asked
whether any known usable element exists — `#side`, `#pane-side` or
`[data-testid="chat-list"]` (logged-in session), `[data-testid="qrcode"]`,
`.qr-code` or `canvas[aria-label]` (login screen); the first match is logged
as `first meaningful UI ready (chat-list | qr-code)`.

### Running the measurement

```bash
# dev build (needs a display; `npm install` first)
npm run measure:startup

# packaged binary (AppImage or installed binary)
npm run measure:startup -- --app /path/to/WhatsApp\ for\ Linux.AppImage

# three runs, report min/avg
npm run measure:startup -- --runs 3

# worst case: drop the Chromium HTTP cache first (login/session untouched)
npm run measure:startup -- --clear-cache

# all options: --app, --dev, --runs N, --clear-cache, --kill,
#              --timeout S, --user-data DIR
```

The harness (`scripts/measure-startup.sh`) launches the app with a unique
marker, waits for point 9 (default 90 s), quits the app, and prints a
timeline of all 9 points **relative to process spawn** plus key metrics:

```
key metrics (from process spawn):
  electron/node bootstrap :     180ms
  tray visible            :     980ms
  window visible          :    2150ms
  page loaded             :    2900ms
  USABLE (first UI ready) :    3400ms   target < 3000ms  -> OVER TARGET by 400ms
```

Notes:
- "Cold" = no running instance + fresh process. The **persistent login
  session is kept** (it is part of the real scenario); `--clear-cache`
  additionally clears only the HTTP cache (`Cache` + `Code Cache` under
  `userData/Partitions/whatsapp-linux`) — cookies/IndexedDB are never touched.
- Offsets in the `[perf]` lines are relative to main.js load, so the harness
  adds the bootstrap offset to report spawn-relative times (± a few ms).
- If another instance is running, the single-instance lock makes the fresh
  process exit early and the harness reports that instead of garbage numbers
  (or pass `--kill` to terminate it first).
- Raw per-run logs are kept in a temp dir (path printed on exit) for
  debugging.

### Current baseline (real machine, packaged app)

- Usable (first meaningful UI): **~4–5 s**
- Tray visible: **~1–2 s**

Next step (after collecting runs with the harness): identify the dominant
cost stage(s) and evaluate optimisations against the **< 3 s** goal.

## M9 — Linux Integration, Settings, Notifications & Release Polish

### 1. Linux desktop identity / association
- `desktopName: "whatsapp-linux"` is set in `package.json` (root) and
  `linux.syncDesktopName: true` in the build config. This removes the
  electron-builder *"desktopName is not set in package.json"* warning and makes
  the installed `.desktop` filename (`whatsapp-linux.desktop`),
  `StartupWMClass`, and Electron's runtime `app_id`/`WM_CLASS` all agree, so
  GNOME/KDE associate the running window with the correct launcher entry (no
  duplicate/generic dock entry, correct taskbar icon).
- Verified generated entry (electron-builder v26, `syncDesktopName: true`):
  ```
  [Desktop Entry]
  Name=WhatsApp for Linux
  Exec=/opt/WhatsApp for Linux/whatsapp-linux
  Terminal=false
  Type=Application
  Icon=whatsapp-linux
  StartupWMClass=whatsapp-linux
  Categories=Network;
  ```
- Clicking the launcher while the app is hidden to tray still restores the
  existing window: a re-launch hits the single-instance lock and routes through
  `showAndFocusMainWindow()`, and the corrected `WM_CLASS` lets the desktop
  environment activate the existing window directly.

### 2. Start with system / Start minimized
- **Start minimized** (already honoured at startup) now has explicit tests and a
  `--start-minimized` / `--hidden` CLI flag (used by the autostart path and the
  resource harness). The window is created off-screen and stays hidden in the
  tray; the WhatsApp Web instance is never reloaded.
- **Start with system** is now genuinely functional via the proper XDG
  autostart mechanism: enabling the setting writes
  `~/.config/autostart/whatsapp-linux.desktop` (pointing at the AppImage file
  when run as an AppImage, the installed executable when packaged, or the dev
  Electron binary + app dir); disabling it removes the file. No cron/hack.
- Close-to-tray, tray notifications, and single-instance behaviour are
  unchanged.

### 3. Notification edge-case polish (M7 audit)
No design changes were needed — M7 already suppressed banners while focused,
deduplicated, auto-dismissed, and restored the window on click. M9 locks the
edge cases down with tests: focused app → no banner **and** no unread bump;
hidden app → native banner; duplicates → fully suppressed (banner + unread);
auto-dismiss → banner closed but unread kept; click → same window restored and
unread cleared; multiple messages → one banner/unread each; notifications
disabled → no banner but unread still tracked; tray reopen → unread cleared.
No separate background notification daemon.

### 4. Settings UI polish
`src/settings.html` was restyled as a native-feeling desktop settings page
(sectioned cards, switch toggles, Adwaita-inspired dark/light palettes via
`prefers-color-scheme`). Pure CSS — no UI framework. All five settings and the
save/close behaviour are unchanged.

### 5. Packaging / release audit
- DEB and AppImage builds are unchanged and still configured (`npm run dist`).
- The installed `.desktop` entry and icons are generated from `desktopName` +
  `build/icons` as above.
- Persistent login/session and settings live in `~/.config/whatsapp-linux`
  (unchanged `persist:whatsapp-linux` partition + `settings.json`), so they
  survive reinstall/upgrade of the package (package removal does not touch
  per-user data — intentional, like most desktop apps).
- The autostart entry is per-user and managed by the setting; after uninstall
  it simply becomes inert (its `Exec` target is gone).

### 6. Resource baseline (measurement only — no optimisation)
`scripts/measure-resources.sh` (run via `npm run measure:resources`) samples the
**whole Electron process tree** via `/proc` and reports idle RAM, idle CPU, and
the tray-hidden idle state (launched with `--start-minimized`):

```bash
npm run measure:resources -- --dev                    # idle after startup (window visible)
npm run measure:resources -- --dev --start-minimized  # tray-hidden idle state
npm run measure:resources -- --app "/path/to/WhatsApp for Linux.AppImage"
# options: --settle S, --sample S, --timeout S, --user-data DIR, --kill
```

This requires a real Linux desktop session (display + Electron binary), which is
not available in the Arena sandbox — see Known Issues. **Report the numbers
before optimising anything.**

## M9 bugfix — Linux notification click (real desktop, root cause)

### Symptom
On Ubuntu GNOME/Wayland, `dbus-monitor` showed GNOME Shell doing everything
right on a banner click — `ActivationToken`, `ActionInvoked (id, "default")`,
`NotificationClosed (id, 2)` — yet the packaged app never logged
`[notif] click -> restore/focus window` and the window did not come back.

### Root cause (verified against the Electron v44.3.0 sources)
1. **`webContents` has no `'notification'` event.** The previous
   `mainWindow.webContents.on('notification', ...)` handler was dead code: it
   is not emitted anywhere in `shell/browser/api/electron_api_web_contents.cc`,
   `lib/browser/api/web-contents.ts`, or documented in `web-contents.md`. As a
   result the main process **never** constructed a `Notification`, so none of
   the `[notif]` lines could ever appear — not just the click line.
2. **The banners were WhatsApp Web's own `new Notification()`**, rendered by
   Chromium's `PlatformNotificationService`. Electron's Linux bridge
   (`libnotify_notification.cc`) adds the `"default"` action, forwards the
   activation token and handles `ActionInvoked` correctly — but
   `NotificationDelegateImpl::NotificationClick()` dispatches the click **to
   the renderer** (the page's `onclick`), never to the main process. WhatsApp
   Web then calls `window.focus()`, which reaches
   `WebContents::ActivateContents` → `BrowserWindow::OnActivateContents`; that
   only hides an auto-hide menu bar and does not restore a hidden window.
3. The earlier "GC / weak reference" theory was wrong: a JS `Notification`
   object that is never created cannot be garbage collected. The
   `activeNotifications` retention is harmless and is kept.
4. The mocked tests fabricated the non-existent `'notification'` event, which
   is why they passed.

`timeoutType: 'default'`, the icon, `desktop-entry`, actions and other
notification options have no effect on click delivery.

### Fix
There is no main-process API that observes web-page notifications, so the
only correct route is a **main-world `window.Notification` shim** installed by
`src/preload.js` (via `webFrame.executeJavaScript`, `contextIsolation` stays
on). The shim forwards `{ title, body, tag }` on the one-way
`wa-web-notification` IPC channel and returns an inert stub; `Notification.
permission` / `requestPermission` are delegated to the real implementation so
WhatsApp Web's own settings UI keeps working. WhatsApp Web's code is not
modified, no DOM selectors or CSS are touched.

In `src/main.js`, `handleWebNotification()` receives that IPC (sender-checked
to the main window) and runs the **unchanged** policy: focused-app
suppression, dedup, unread counting, the settings toggles, then
`showNativeNotification()` — whose `click` event now genuinely reaches JS and
calls `showAndFocusMainWindow()`. Auto-dismiss, tray behaviour and single
instance are untouched.

### Manual verification (real Ubuntu Wayland desktop)
```bash
/opt/WhatsApp\ for\ Linux/whatsapp-linux 2>&1 | tee /tmp/whatsapp-notif.log
# 1. Hide the window to the tray and send yourself a message. Expected:
grep '\[notif\]' /tmp/whatsapp-notif.log
#    constructing <title> / calling show() / show event / scheduling auto-dismiss ...
# 2. Click the banner. Expected: window restored + focused and
#    click -> restore/focus window <title>
# 3. dbus-monitor --session "interface='org.freedesktop.Notifications'"
#    now shows the Notify call coming from OUR notification (app_name
#    "whatsapp-linux", hint desktop-entry) followed by ActionInvoked "default".
```

## M11 — Linux dock / app-icon unread badge

Goal: show the unread count on the **`whatsapp-linux` application icon** in the
dock/launcher (not inside the window, not only in the tray), updated as messages
arrive, cleared when the user focuses/reopens WhatsApp.

### What is actually supported (verified 2026-09-14)

| Question | Answer | Evidence |
|---|---|---|
| Does **stock GNOME Shell 50** render app-icon badges? | **No.** There is no GNOME-native badge API. | [gnome-shell#511](https://gitlab.gnome.org/GNOME/gnome-shell/-/work_items/511) "Attention badges on icons in application switcher and activities dock" is still **Open** (labels `1. Feature`, `2. Needs Design`, unassigned). The related [#319 "Favourites should use notification badges"](https://gitlab.gnome.org/GNOME/gnome-shell/-/work_items/319) was **Closed — `3. Out of Scope`**. GNOME 50 "Tokyo" shipped 2026-03-18 with no badge feature. |
| Is there a supported cross-desktop protocol? | **Yes** — Canonical's **Unity Launcher API**, `com.canonical.Unity.LauncherEntry`. It is a plain **session-bus D-Bus signal**, so X11 vs Wayland makes no difference (no X11 property, no window handle). | [wiki.ubuntu.com/Unity/LauncherAPI](https://wiki.ubuntu.com/Unity/LauncherAPI) |
| Which docks implement it? | Dash to Dock **and** its Ubuntu Dock fork (both verified in source this milestone), plus Dash to Panel, plank, gershwin-workspace. It is the protocol Firefox/Thunderbird/Telegram/Evolution use. | Dash to Dock `master` (v106) `launcherAPI.js`: `signal_subscribe(null, 'com.canonical.Unity.LauncherEntry', 'Update', null, …)` and `own_name('com.canonical.Unity', …)`. Its `metadata.json` declares `shell-version: 45…51`, so **GNOME 50 is covered**. |
| Does the **current dock** show it by default? | **Yes.** | Dash to Dock gschema defaults: `show-icons-emblems=true`, `show-icons-notifications-counter=true`, `application-counter-overrides-notifications=true`. `appIconIndicators.js::_updateNotificationsCount()` uses the app-provided `count` whenever it is > 0. |
| Does **Electron 44** support it? | **Yes, natively — no libunity, no hand-rolled D-Bus.** | electron#52895 "Restored `app.setBadgeCount` and `win.setProgressBar` for Linux … These APIs now support any dock or taskbar which implements the LauncherEntry D-Bus API, and they no longer require libunity" — in **44.0.0**, and this app pins **44.3.0**. Locally confirmed in `node_modules/electron/electron.d.ts`: `setBadgeCount(count?: number): boolean` and `badgeCount: number`, both `@platform linux,darwin`; `isUnityRunning` is **gone** (0 occurrences), matching the Electron 44 breaking change "Removed: Unity desktop environment support on Linux". |

**Conclusion.** The correct mechanism is `app.setBadgeCount(n)` — a supported
Electron API — which emits on the session bus:

```
signal com.canonical.Unity.LauncherEntry.Update
path   /com/canonical/unity/launcherentry
args   ("application://<CHROME_DESKTOP>",
        {"count": <x int64>, "count-visible": <b bool = count != 0>})
```

Nothing else was considered acceptable: drawing a badge inside the BrowserWindow
is a fake, `setOverlayIcon` is `@platform win32` (a no-op on Linux), swapping the
tray/window icon is not a dock badge, and hand-rolling the D-Bus signal would
duplicate code Electron already ships.

### The one thing that silently breaks it: the `.desktop` suffix

`launcher_entry.cc` builds the URI as `"application://" + platform_util::
GetDesktopName()`, and `GetDesktopName()` is literally `getenv("CHROME_DESKTOP")`
— **the suffix is not added**. Electron seeds `CHROME_DESKTOP` from
`package.json`'s `desktopName` verbatim (`lib/browser/init.ts`:
`app.setDesktopName(packageJson.desktopName || defaultDesktopName(app.name))`).
With this repo's `desktopName: "whatsapp-linux"` the emitted URI would be
`application://whatsapp-linux`, while docks match it against `Shell.App.id`,
which GNOME sets to the **`.desktop` filename** (`whatsapp-linux.desktop`) — so
the badge would never appear, and `app.setBadgeCount()` would still "succeed".

Fix: `src/main.js` calls `app.setDesktopName('whatsapp-linux.desktop')` at module
load (before `ready`, as Electron documents). Verified consequences:

- `GetXdgAppId()` strips `.desktop` → **still `whatsapp-linux`**, so the Wayland
  `app_id`/`WM_CLASS` and the `desktop-entry` notification hint used by M9/M10
  are byte-for-byte unchanged.
- `version_info::nix::GetAppName()`/`GetSessionNamePrefix()` strip `.desktop` →
  app_id and DBus object-path prefix unchanged.
- `Browser::IsDefaultProtocolClient()`/`SetDefaultWebClient()` build a
  `GDesktopAppInfo` from `CHROME_DESKTOP`, which *requires* the suffix → now
  correct instead of broken.
- `package.json` keeps the bare `desktopName` the M9 tests assert on;
  electron-builder strips a trailing `.desktop` anyway
  (`LinuxTargetHelper.getDesktopFileName`).

Running the **real** electron-builder 26.15.3 from this repo confirms both sides
agree (this is what `test/m11-dock-badge.test.js` executes, not a re-derivation):

```
getDesktopFileName() -> whatsapp-linux.desktop
[Desktop Entry]
Name=WhatsApp for Linux
Exec=/opt/whatsapp-linux/whatsapp-linux %U
Terminal=false
Type=Application
Icon=whatsapp-linux
StartupWMClass=whatsapp-linux
```

### Implementation (`src/main.js`)

- `DESKTOP_FILE_ID = 'whatsapp-linux.desktop'` + `app.setDesktopName(...)` before
  `ready` (above).
- `pushDockBadge(count, reason)` — normalises to a non-negative integer, calls
  `app.setBadgeCount(count)` (0 ⇒ `count-visible=false` ⇒ badge hidden), records
  `{count, reason, delivered, ok, error, at}` in `__badgeUpdates`, and logs a
  `[badge]` line. A `false`/throwing call is recorded, never propagated, and
  never touches unread state.
- `updateDockBadge(reason)` — derives the count from the **existing**
  `unreadCount` and deduplicates, so an unchanged value does not re-emit a
  fire-and-forget signal.
- `updateUnreadIndicator(reason)` — now calls the dock badge **first**, then the
  tray tooltip, then the Windows-only overlay. The old leading
  `if (!tray) return;` guard is gone: it silently disabled *every* indicator
  whenever tray creation failed (`test/m11-dock-badge-no-tray.test.js` guards
  this — it fails if the guard is restored).
- `before-quit` forces a final `count=0` (only if a non-zero badge is showing),
  so no dock keeps a stale badge for an exited app.

**Unchanged:** the unread counter, its clear-on-focus/clear-on-show semantics,
the tray tooltip/icon, single-instance restore, the preload `Notification` shim,
notification dedup and the settings toggles, and the whole M10 history model
(still no auto-dismiss timer — asserted in the M11 suite). The badge is purely
additive on top of the same counter.

### Behaviour

| Event | `unreadCount` | Dock badge |
|---|---|---|
| Message while hidden/backgrounded | +1 | `setBadgeCount(n)` |
| Further messages | +1 each | `setBadgeCount(n+1)` |
| Duplicate (same title+body within 3 s) | unchanged | no signal |
| Message while the window is focused | unchanged | no signal, no banner |
| Notifications disabled in Settings | +1 | `setBadgeCount(n)` (no banner) |
| Window focused, or reopened from tray, or notification clicked | 0 | `setBadgeCount(0)` → hidden |
| Quit with a badge showing | — | final `setBadgeCount(0)` |

### Known limitation of the protocol (not worked around)

The Unity launcher API is **signal-only** — there is no state for a dock to
re-query. If the dock is disabled or restarted while the app is idle (GNOME Shell
disables extensions on screen lock — [dash-to-dock#708](https://github.com/micheleg/dash-to-dock/issues/708)),
a badge set during that window is lost until the count next changes. We re-emit
on every change and force one clear on quit, and deliberately do **not** add a
polling re-announce loop.

### Tests

```bash
node --check src/main.js
npm test          # 60 tests, mocked Electron, no display needed
```

- `test/m11-dock-badge.test.js` (18 tests) — desktop identity (incl. the real
  electron-builder filename/`StartupWMClass` check), every transition above,
  badge/tray lockstep, dedup of unchanged pushes, non-negative integer
  normalisation, rejected-call handling, M10 history invariants, quit clear.
- `test/m11-dock-badge-no-tray.test.js` (1 test) — badge survives a tray-init
  failure. Mutation-checked: restoring `if (!tray) return;` makes it fail.

### Packaged-app verification (real Ubuntu GNOME/Wayland desktop)

This cannot run in the sandbox (no display server, and the Electron binary
download is blocked — see Known Issues). On a real machine:

```bash
npm run dist                       # or: npm run pack  (dist/linux-unpacked/, no installer)
sudo apt install ./dist/*.deb      # or run dist/linux-unpacked/whatsapp-linux directly

# 0. Confirm the desktop identity the badge is keyed on:
ls /usr/share/applications/ | grep -i whatsapp      # -> whatsapp-linux.desktop

# 1. Watch the actual D-Bus traffic in one terminal:
dbus-monitor --session "interface='com.canonical.Unity.LauncherEntry'"

# 2. Run the packaged app and log it:
"/opt/WhatsApp for Linux/whatsapp-linux" 2>&1 | tee /tmp/whatsapp-badge.log

# 3. Pin the launcher entry to the dock, then hide the window to the tray
#    and send yourself a message.
#    dbus-monitor must show, once per unread message:
#      signal ... path=/com/canonical/unity/launcherentry;
#        interface=com.canonical.Unity.LauncherEntry; member=Update
#        string "application://whatsapp-linux.desktop"
#        array [ dict entry("count", int64 1)
#                dict entry("count-visible", boolean true) ]
#    and the app must log:
grep '\[badge\]' /tmp/whatsapp-badge.log
#      [badge] app.setBadgeCount(1) -> emitted | message received (unread=1)

# 4. Send a second message -> count int64 2, badge updates in place.
# 5. Click the dock icon (or the banner, or the tray "Show WhatsApp"):
#      [badge] app.setBadgeCount(0) -> emitted | window focused
#    -> count-visible boolean false, badge gone, tray tooltip back to
#       "WhatsApp for Linux".
# 6. Quit while a badge is showing -> one final count 0 signal.
```

If step 3 shows the signal but **no number is painted**, check the dock, in this
order:

```bash
gnome-shell --version
gnome-extensions list --enabled | grep -E 'dash-to-dock|ubuntu-dock'
gsettings get org.gnome.shell.extensions.dash-to-dock show-icons-emblems
gsettings get org.gnome.shell.extensions.dash-to-dock application-counter-overrides-notifications
```

On a **vanilla GNOME session with no dock extension** the signal is emitted and
correctly ignored — that is the upstream limitation described above, not a bug in
this app.

Reading the app's own trace is enough to tell the two failure modes apart
without a dock at all:

```bash
grep '\[badge\]' /tmp/whatsapp-badge.log
# "app.setBadgeCount(1) -> emitted"                        -> Electron sent the
#                                                              signal; anything
#                                                              missing is the dock.
# "app.setBadgeCount(1) -> REJECTED (desktop id unresolved?)"
#                                                          -> CHROME_DESKTOP is
#                                                              unset, i.e.
#                                                              app.setDesktopName()
#                                                              did not take effect;
#                                                              no dock can ever show it.
# "skip app.setBadgeCount(1): not linux (...)"             -> not running on Linux.
```

## M13 — GNOME native banner expiration/dismissal (root cause + lifecycle state machine)

### Symptom

With the packaged Electron 44.3.0 app on GNOME Shell (Wayland, notification
timeout extension ≈ 5 s), native notifications use `timeoutType: 'default'`
and the app never calls `close()` on a timer. Intended flow: message →
banner → GNOME's configured timeout expires → banner disappears naturally →
notification stays in the GNOME notification list. Observed: *some* banners
expire on time, others sometimes linger indefinitely. Intermittent, hard to
reproduce deterministically.

### Root cause (verified against sources, 2026-09-14)

**The inconsistency originates in GNOME Shell's banner-timeout policy, not in
Electron, libnotify, ids/tags, replacement/append, GC, or our callbacks.**
Sources read: Electron v44.3.0
`shell/browser/notifications/linux/libnotify_notification.cc` +
`shell/browser/api/electron_api_notification.cc` +
`shell/browser/notifications/notification{,_presenter}.cc`, libnotify
`notification.c`/`notify.c`, GNOME Shell `js/ui/messageTray.js` +
`js/ui/notificationDaemon.js`.

1. **GNOME never reads the client timeout.** `NotifyAsync()` destructures the
   `expire_timeout` argument into `timeout_` and never uses it. Banner
   lifetime is the shell's own `NOTIFICATION_TIMEOUT` (stock ≈ 4 s; the
   notification-timeout extension is what makes it ≈ 5 s here). So
   `timeoutType: 'default'` (→ `NOTIFY_EXPIRES_DEFAULT`) is still correct —
   it simply means "GNOME decides".
2. **The timeout only runs while the user is ACTIVE.**
   `MessageTray._showNotification()` arms it only when
   `idleMonitor.get_idletime() <= 1000 ms`
   (`_userActiveWhileNotificationShown`). If the user is idle when the banner
   pops, **no timer is armed at all** — the banner stays visible indefinitely
   and disappears only ~2 s after input resumes
   (`_onIdleMonitorBecameActive → _updateNotificationTimeout(2000)`).
3. **Pointer behaviour pauses/refreshes the timer**: hovering the banner
   keeps it expanded; the timer re-arms +1 s while the pointer moves towards
   it (`_notificationTimeout()`). Banners are also deferred while the session
   is BUSY or the monitor fullscreen.
4. **Banners queue**: one banner at a time plus a queue of
   `MAX_NOTIFICATIONS_IN_QUEUE = 3`; a burst of messages plays banners
   back-to-back (looks like one banner "that won't go away"); beyond the
   queue only a panel indicator appears.
5. **Expiration is unobservable by design.** When the banner hides,
   `_hideNotificationCompleted()` destroys only *transient* notifications;
   persistent ones stay in the source's list and **no `NotificationClosed`
   D-Bus signal is emitted** — so libnotify emits no `closed` GObject signal
   and Electron can deliver no JS event. The `NotificationClosed` signal (and
   therefore Electron's `'close'` event) arrives only for: user
   dismissal/clear from the notification list (reason 2), our own
   `CloseNotification` (reason 3), and GNOME evicting the oldest once a
   source accumulates > `MAX_NOTIFICATIONS_PER_SOURCE = 10` entries
   (reason 1). The reason code itself never reaches JS on the Linux path.

Ruled out along the way: *replacement/append* (Electron only sets a replaces
id from `options.tag`, which its `Show()` never populates from any JS option,
and GNOME doesn't advertise the `append` capability Electron checks for —
every message is an independent notification with a fresh server id); *GC*
(collecting the gin-weak JS wrapper only calls `set_delegate(nullptr)`, which
kills JS event delivery but sends nothing to the daemon — hence the M9 strong
references remain necessary for clicks); *our callbacks* (none can delay a
GNOME timer).

### Why the M10 model was insufficient

M10 correctly removed the blind `setTimeout(() => close(), 5000)` (which
issued `CloseNotification` and wiped history) and kept strong references for
click delivery — that part is preserved. But it retained every notification
in an **unbounded `Set` with no state**:

- no way to tell *why* a notification ended (user dismissal vs our close vs
  click), so a lingering banner could not be diagnosed from `[notif]` logs;
- no bound on retention: notifications whose `close` event never arrives
  (user never clears them; shell/extension restarts drop in-flight state;
  non-GNOME daemons without a 10-per-source cap) leaked wrappers forever;
- the fact that banner expiration is fundamentally unobservable was never
  documented, inviting misdiagnosis (e.g. "re-add a timer").

### Implementation (`src/main.js`)

- **Per-notification lifecycle state machine** (`NOTIF_STATE`):
  `created → shown`, then exactly one terminal outcome among
  `clicked`, `closed-programmatic`, `closed-user-or-daemon`, `failed` —
  plus `evicted` for retention-cap releases. There is deliberately **no
  `expired` state**: absence of events is never claimed as expiration.
- **Close-origin classification**: `dismissNotification()` marks the record
  (`closingByUs`/`closeReason`) before `close()`, so a `'close'` event is
  read as either the echo of our own `CloseNotification` or — if we never
  called `close()` — a user dismissal / daemon eviction. Late events after
  release are logged no-ops; nothing is double-counted.
- **Bounded retention**: `activeNotifications` is now a `Map(wrapper →
  record)` capped at `MAX_ACTIVE_NOTIFICATIONS = 50`, oldest-first eviction
  (`enforceActiveNotificationCap`). On GNOME the daemon's own 10-per-source
  cap keeps steady state around 10 live wrappers; the app-side cap is the
  backstop against daemons with unlimited history and against lost `close`
  events. Evicted wrappers keep their GNOME entry but lose JS click delivery
  (documented trade-off).
- **`[notif]` diagnostics** around creation, `show()` call, native `show`
  event, click, close (with origin), failed, eviction, and renderer recalls;
  plus a bounded in-memory transition ring (`__notificationLifecycleLog`).
- Preserved: `timeoutType: 'default'`, no timers anywhere in `main.js`, no
  `resident`/`transient` hints, M12 renderer-id dedup (tags stay metadata),
  click → restore/focus, unread semantics, renderer `Notification.close()`
  recall.

### Manual verification (packaged app, real GNOME desktop)

The prebuilt Electron binary cannot be downloaded in this sandbox
(see Known Issues), so run this on a machine with normal egress and a real
GNOME session:

```bash
npm run dist            # or: npm run pack
./dist/<binary> 2>&1 | tee /tmp/wa-m13.log
grep '\[notif\]' /tmp/wa-m13.log
```

Scenarios (compare runs instead of trusting a single observation):

- **A — one notification, expires normally**: send one message while you keep
  moving the mouse / stay active. Banner appears and hides after the
  configured timeout. Log: `native created … calling native show … native
  show event … banner expires via GNOME timeout; history retained …` and then
  **nothing** (no `native closed`, no `close()` — that is correct).
- **B — several notifications close together**: send 3–4 messages quickly.
  GNOME shows one banner at a time and plays the rest from its queue; each
  hides after its own timeout. Log: one created/shown chain per message.
- **C — different texts close together**: as B with different senders/bodies;
  verify no coalescing (`native created id=…` once per message, distinct ids).
- **D — repeated identical messages**: same text twice. With the preload shim
  each renderer event has a unique id → two independent notifications (no
  collapse). Only a *replayed* renderer id logs `duplicate suppressed id=…`.
- **E — click one notification while others exist**: click a banner while
  more are queued/in history. Window restores+focuses, `native clicked id=…`
  + `dismissing id=… (click)` for that id only; the other ids are untouched.
- **F — history retention**: after a banner expires naturally, open the GNOME
  notification list (Super+V / clock) — the notification is still there.
  Dismiss it there → log shows `native closed id=… origin=user-or-daemon`
  (no `close()` from us). A renderer-side recall instead logs
  `programmatic close id=… (renderer close)`.

**Reproducing the "stuck banner" case on purpose** — and proving it is GNOME
policy, not the app: send a message, then do not touch mouse/keyboard for
30+ s. The banner lingers (GNOME arms no timeout for an idle user). Now wiggle
the mouse: the banner hides ~2 s later. The `[notif]` log throughout shows no
`close()` and no `close` event — exactly the unobservable-expiration design.
Contrast with the normal run (A): identical app-side log lines; the only
difference is GNOME's idle state at pop-out. That comparison is the proof the
fix is on the right layer — the app cannot and must not force expiration,
because `CloseNotification` would remove the notification from history (the
pre-M10 bug).

Useful extra dials while diagnosing on the real desktop:
`ELECTRON_DEBUG_NOTIFICATIONS=1` (Electron's own notification tracing) and
`dbus-monitor --session "interface='org.freedesktop.Notifications'"`
(a lingering banner shows NO `CloseNotification`/`NotificationClosed`
traffic — the giveaway that GNOME's idle/hover policy is holding it).

## M14 — Deterministic GNOME banner presentation (~5 s) with history preserved

### Requirement

WhatsApp notifications must appear as native GNOME notifications whose
banner disappears after a fixed ~5 s **regardless of** idle state, queue
position, rapid bursts or pointer movement — and after the banner
disappears naturally the notification MUST remain in the GNOME
notification list. Click still removes exactly that notification and
focuses WhatsApp. No blind app-side close timer (the M10 regression), no
custom browser-style popup.

### Investigation (performed in this order, per the mandated plan)

The target desktop is Ubuntu 25.10 → **GNOME Shell 50.1** (Wayland). All
evidence below is from the **actual 50.1 sources** (GNOME/gnome-shell tag
`50.1`; the banner file is vendored unmodified at
`test/m14/vendor/gnome-shell-50.1/messageTray.js`, MD5
`7ba22e95b5e0c4027a9585567e1bde0b`) and from the **actual Electron
44.3.0** libnotify sources.

**A) Is there a native GNOME mechanism to control banner lifetime only,
keeping history?**

- `js/ui/notificationDaemon.js:136` — `NotifyAsync()` destructures the
  client `expire_timeout` into `timeout_` and **never reads it**. The
  `org.freedesktop.Notifications` interface (50.1 D-Bus XML) contains only
  Notify / CloseNotification / GetCapabilities / GetServerInformation and
  the three signals. **There is no daemon-side knob for banner lifetime.**
- The `persistence` / `transient` hints (the only per-notification
  lifetime hints that exist) change **history membership**, not banner
  timing — and `transient` would *remove* history, violating the
  requirement. Both are already at the correct values (non-transient).
- So banner presentation is owned by **GNOME Shell's own message-tray
  policy** (`js/ui/messageTray.js`), which is not configurable through any
  public D-Bus or settings API. The shell's own **extension mechanism**
  is the supported route into it.

**B) What exactly makes the stock lifetime non-deterministic (50.1 lines):**

| Behavior | 50.1 location | Effect |
| --- | --- | --- |
| Banner expiry gate | `messageTray.js:1086` | expires only when `_userActiveWhileNotificationShown && state==SHOWN && timerId==0 && urgency!=CRITICAL && !_pointerInNotification` (or `_notificationExpired`) |
| Idle gate | `messageTray.js:1122` | flag = `idletime <= 1000 ms` at show time → **an idle desktop never expires the banner** (the 4 s timer fires, `_updateState` refuses to hide); it hides ~2 s after the *first* user input |
| Stock timer value | `messageTray.js:19,1207` | `NOTIFICATION_TIMEOUT = 4000`, armed at show completion |
| Pointer drift | `messageTray.js:1224-1236` | each timeout check re-arms **+1000 ms** while the pointer is drifting toward the banner / was inside it |
| Hover | `messageTray.js:985-1011,1095` | pointer inside the expanded banner blocks expiry until it leaves (200/600 ms grace) |
| Bursts | `messageTray.js:949-971` | queue holds 3 incl. the active banner; overflow is history-only |
| History on natural hide | `messageTray.js:1273-1284` | `_hideNotificationCompleted` destroys **only `isTransient`** notifications → non-transient banners stay in `source.notifications`; the daemon emits its close signal **only on `destroy`** (`notificationDaemon.js`) |
| Click | `messageList.js` `vfunc_clicked` | `notification.activate()` → daemon emits `ActionInvoked("default")` + (non-resident) `destroy(DISMISSED)` → close signal for that id only |

This is the layer that was responsible in M10/M13: **the client
(Electron/libnotify) has no call that changes any of the rows above.**
M10's blind close timer fixed the symptom by removing history (the
regression M10 itself removed and M13 pinned); M13 correctly stopped the
app from touching banner lifetime at all — which is also why the app
alone can never *guarantee* the ~5 s. The guarantee must come from the
shell layer.

**C) Can the existing "notification-timeout" extension be reused as-is?**

The widely installed `notification-timeout` extension (targets GNOME
49/50 — same generation) wraps exactly the choke point below
(`_updateNotificationTimeout` + the same idle flag), which **confirms the
hook is stable in production use**. But as shipped it (i) applies to
*every* application, and (ii) re-arms a **fresh full interval on every
interaction** (its wrapper unconditionally sets `timeout = newTimeout`),
so pointer drift / idle→active transitions still push the expiry back —
not deterministic. So it was used as evidence, not as the solution.

**D) App-owned presentation layer** — rejected: it would be the custom
popup the requirement forbids, and everything needed turns out to be
achievable natively.

### Solution (chosen): a small, app-owned GNOME Shell **system extension**

`gnome-extension/` ships `whatsapp-deterministic-banner@prr006`, a
user-local extension (GNOME 49/50) that governs **only this app's**
banners — matched on the notification source's resolved desktop app id
(`whatsapp-linux`, from the `desktop-entry` hint Electron/libnotify set —
verified in the Electron 44.3.0 sources). It uses the shell's supported
`InjectionManager` override API on three methods, all of which are the
shell's own choke points:

1. `_showNotification` (the single point where a queued notification
   becomes the active banner): for in-scope banners, set
   `_userActiveWhileNotificationShown = true` — the shell's own flag — so
   the expiry check is no longer gated by the idle monitor. (Same flag the
   production extension above sets.)
2. `_updateNotificationTimeout` (the single point where the banner timer
   is armed/re-armed — show completion, idle→active watch, pointer
   checks, hover refresh, pointer-left grace): the **first** positive arm
   establishes a fixed deadline (`now + 5000 ms`); **every later arm is
   redirected to `deadline − now`**. All of the shell's interaction-driven
   re-arms therefore converge on the same instant — no interaction (idle,
   pointer drift, hover refresh, in-place update) can move the expiry. A
   re-arm arriving at/after the deadline clears the timer and triggers
   the shell's own no-re-arm branch.
3. `_hideNotificationCompleted` (logging only): one journal line per
   governed banner hide — `path: standard-expiry | removed-while-showing
   (click/close), history: retained | removed` — plus eager WeakMap
   cleanup. Zero behavior change; makes the lifetime measurable in the
   journal (see verification below).

The banner is hidden **exclusively through the shell's standard expiry
path**, which for non-transient notifications keeps the notification in
the notification list and stays silent on D-Bus (no close signal) — so
history, click→`ActionInvoked`→focus, per-notification identity (M12),
unread accounting, bounded retention (M13), and `timeoutType: 'default'`
are all untouched. The extension never destroys/closes anything, never
sends close traffic, and never touches other applications (verified by
test, both in simulation and by source contract).

**Determinism properties (all asserted in tests):**

- active desktop, no pointer: banner visible ~5.0 s (5.2 s from the
  D-Bus `Notify` — 200 ms show animation included),
- idle desktop: same ~5.0 s (the idle gate is lifted by the extension,
  not by fake activity),
- burst: at most 3 banners present at once (GNOME's own queue rule); each
  presented banner holds exactly one 5 s slot, back-to-back; overflow
  notifications never banner but stay in history,
- pointer drifting toward the banner at the deadline: still expires at
  the deadline (the +1 s re-arm is collapsed),
- hover **at** the deadline: the banner is held while the pointer is
  inside the expanded banner (GNOME's interaction model — yanking a
  banner from under an actively reading pointer would break expand/
  collapse), and hides immediately when the pointer leaves (200/600 ms
  grace). This is the single documented exemption, bounded by the pointer
  position, not by time;
- other applications: byte-for-byte stock behavior (scoping),
- Escape: still hides the current banner early (user control preserved),
- click: removes exactly the clicked notification (`ActionInvoked` +
  `destroy(DISMISSED)` → close signal for that id), the rest keep their
  banners/history,
- session BUSY: the current banner hides early (this is *stock* behavior
  for active users too — BUSY clears the banner timer) and the queue is
  deferred; history is retained,
- memory: the governor's per-banner state is a `WeakMap` keyed by the
  notification object — when the shell evicts a notification (GNOME caps
  history at 10 per source, unchanged), the governor entry dies with it.

### Files changed (M14)

| File | Change |
| --- | --- |
| `gnome-extension/extension.js` | **new** — the governor (3 InjectionManager overrides, scoping, logging) |
| `gnome-extension/policy.js` | **new** — pure decision logic (scope match, deadline math), Node-testable |
| `gnome-extension/metadata.json` | **new** — uuid, name, GNOME 49/50, version |
| `gnome-extension/package.json` | **new** — Node-only `type: module` marker (GJS ignores it) |
| `src/main.js` | M14 section: best-effort user-local installer (copy + `gnome-extensions enable`) at `app ready`; `__m14` test exports. No timers added anywhere (M13 guard re-asserted) |
| `package.json` | `extraResources`: ship `gnome-extension/` into packaged apps |
| `scripts/install-gnome-extension.sh` | **new** — manual install/refresh/uninstall (idempotent) |
| `scripts/verify-m14.sh` | **new** — on-device verification matrix driver |
| `test/m14-deterministic-banner.test.js` | **new** — policy unit tests, extension source contracts, installer integration (14 tests) |
| `test/m14-gnome501-simulation.test.js` | **new** — behavior tests executing the REAL vendored 50.1 `messageTray.js` + the REAL shipped extension (12 tests) |
| `test/m14/**` | **new** — vendored 50.1 source (with provenance) + GI stubs + harness |
| `README.md` | this section |

No changes to `src/preload.js`, the renderer, WhatsApp Web DOM/CSS,
M12 identity, M13 lifecycle state machine, or `timeoutType`.

### Test report (run in this environment)

- `npm test` → **109/109 pass** (97 pre-existing M7–M13 tests + 14 M14
  contract/installer tests + 12 M14 simulation tests).
- `node --check src/main.js` → OK; `node --check src/preload.js` → OK;
  `node --check gnome-extension/{extension.js,policy.js}` → OK.
- The simulation suite first **calibrates on stock behavior** (governor
  off): active desktop hides at ~4.4 s; idle desktop does not hide until
  user activity (+~2 s) — reproducing the exact field reports on the
  exact 50.1 banner code — and then asserts the governed behavior on the
  same code. The only stubbed layer is GI/GTK (actors, timers on Node's
  real event loop, pointer, idle monitor); the state machine, the queue,
  the history, and the extension are the real code.
- Honest boundary: this sandbox has no display/GNOME, so the final
  on-device confirmation is the manual matrix below. The on-device step
  exercises the same governor code that the simulation runs; the
  extension's shell-side load (GJS import of `./policy.js`,
  `InjectionManager` registration) is standard GNOME 49/50 extension
  behavior but must be confirmed once on the machine.

### Verification on the real machine (A–F matrix)

`scripts/verify-m14.sh` automates B/D/E/F + the out-of-scope control by
sending notifications through the same D-Bus path the app uses
(`Notify` with the `desktop-entry: whatsapp-linux` hint) and reads the
extension's `[m14]` journal lines (exact show/hide timestamps). Run it
with GNOME up; the gold-standard case is manual:

| # | Scenario | Procedure | Expected |
| --- | --- | --- | --- |
| A | **Gold standard** — real message | In the app, receive/send one real chat message | Banner up ~5 s; entry remains in the notification list; clicking it focuses WhatsApp and removes only that entry; journal shows `banner timer established … 5000 ms` then `banner hidden — path: standard-expiry, history: retained` ~5.0–5.3 s apart |
| B | Single, active desktop | script B (or case A) | one governed banner, ~5.0–5.3 s, history retained |
| C | Two immediate | send two messages back-to-back (script D covers 3) | two banners, each its own ~5.2 s slot, both in history |
| D | 3+ burst | script D | three banners (GNOME's 3-slot queue), slots ~5.2 s; a 4th+ is history-only, never banners |
| E | Idle desktop | script E (don't touch the machine 10 s) | still expires at ~5 s — stock GNOME would keep it until you move |
| F | Active + pointer motion | script F (mouse drifts toward the banner) | still ~5 s — stock adds ~1 s per pointer check |
| G | Out-of-scope control | script control (or any other app's notification) | stock ~4.2 s behavior, **no** `[m14]` lines |
| H | History & click | after any natural expiry: open the notification list | entry present; click removes only it; other entries untouched |
| I | No regression | use the app as normal for a while | unread badges (M11), per-message identity/dedup (M12), tray quit semantics (M7/M13) all unchanged |

Journal access during the matrix:
`journalctl --user --since "5 min ago" | grep '\[m14\]'` (the shell logs
its `log()` output to the user journal on Ubuntu Wayland).

### Disabling / uninstalling

- Temporary: `gnome-extensions disable whatsapp-deterministic-banner@prr006`
  (stock behavior returns immediately; a running shell picks it up live).
- Full removal: `scripts/install-gnome-extension.sh --uninstall`.
- The app re-installs/refreshes the extension on each start **only when
  the version changed**; a user-disabled but current install is left
  alone (re-enable it from GNOME Settings → Extensions if needed).
- Non-GNOME sessions are never touched by the installer.

### Why this is the least-invasive architecture that works

- No app-side timers, no D-Bus spoofing, no custom UI, no DOM changes —
  the banner is a real GNOME banner, timed by the shell's own expiry path.
- Scoped to one desktop app id; every other application is untouched
  (source-verified + tested).
- Reversible with one command; ships as a plain-file user extension.
- The alternative — forcing determinism from the client — is impossible
  on GNOME (the daemon ignores `expire_timeout`; the only client lever,
  CloseNotification, removes history — the M10 bug). GNOME *can* provide
  deterministic per-app banner expiration with history preserved; the
  shell extension mechanism is where that capability lives.

## Directory Structure
```
whatsapp-linux/
├── src/
│   ├── main.js         # Electron main (window, tray, session, settings/autostart, events, [perf] instrumentation)
│   ├── preload.js      # Safe bridge (empty in M1 per principles)
│   ├── preload-settings.js
│   └── settings.html   # Native-feeling settings page (M9)
├── scripts/
│   ├── measure-startup.sh    # M8 cold-start measurement harness
│   └── measure-resources.sh  # M9 idle RAM/CPU baseline (measurement only)
├── test/
│   ├── m7-lifecycle.test.js        # Mocked-Electron lifecycle/notification tests
│   ├── m9-linux-integration.test.js# M9 desktop identity, autostart, start-minimized, notification edge cases
│   ├── m10-gnome-persistence.test.js # M10 banner expiration vs GNOME history removal
│   ├── m11-dock-badge.test.js      # M11 dock badge state transitions + desktop identity
│   ├── m11-dock-badge-no-tray.test.js # M11 badge survives a tray-init failure
│   ├── m12-notification-contract.test.js # M12 renderer-event identity + lifecycle contracts
│   └── m13-banner-lifecycle.test.js # M13 banner expiration/dismissal state machine
├── build/
│   ├── icons/icon.png  # App icon (AI-generated)
│   └── whatsapp-linux.desktop
├── package.json        # Dependencies, build config (desktopName, syncDesktopName), scripts
├── .gitignore
└── README.md
```

## Quick Start (once binary available)
```bash
npm install
npm start
```

## Build
```bash
npm run dist   # AppImage / deb (electron-builder)
```

## Test
```bash
npm test       # node --test test/*.test.js — 83 tests, mocked Electron, no display needed
```

## Testing Protocol (per instructions)
After M1 build: initial launch → QR display → login → send message → receive message → close → reopen → session persistence → inspect logs → verify no Chromium errors.

## Known Issues / Limitations
- **Electron binary download blocked** in this sandbox. `npm install` succeeds (284 packages, `electron@44.3.0` + `electron-builder@26.15.3` metadata and typings present) and `node --check` / `npm test` pass, but the prebuilt runtime is not obtainable: `node node_modules/electron/install.js` fails with `TypeError: fetch failed`, and `npm run dist` stops at `packaging … electron=44.3.0` with `RequestError: unable to verify the first certificate`. Root cause measured directly — `github.com` answers (302) but the release asset host `release-assets.githubusercontent.com` / `objects.githubusercontent.com` is reset before the TLS handshake completes (`ECONNRESET`, also with `-k` and with the sandbox CA in `NODE_EXTRA_CA_CERTS`); the usual mirrors (`registry.npmmirror.com`, `cdn.npmmirror.com`, `download.electronjs.org`, `mirrors.tuna.tsinghua.edu.cn`) are unreachable too. So the M11 packaged-app verification below must run on a machine with normal egress.
- **M11 dock badge not yet observed on a real desktop.** The D-Bus payload, the `CHROME_DESKTOP` plumbing and the dock-side matching logic are all verified against Electron 44.3.0 / Dash to Dock v106 sources and by the mocked tests, but no badge has been seen painted (no display server here). Follow *M11 → Packaged-app verification*.
- **No display server** (Xvfb) installed; launch would require `DISPLAY=:99` or a real X11/Wayland session. This also means the M9 resource baseline (`npm run measure:resources`) and any dock/taskbar/WM_CLASS observation must run on a real desktop — the script is provided and measurement-only.
- **No system browsers** installed for independent WhatsApp Web verification (not required since Electron bundles Chromium).
- **Tray/dock behaviour untested at runtime** in this sandbox; code uses standard Electron `Tray`, `Menu`, single-instance and XDG autostart APIs, verified by mocked tests and the build-config audit.
- **Notification click focus on Wayland**: libnotify click delivery (`click` → `showAndFocusMainWindow()`) is verified by the mocked tests, but the final window *raise/focus* is governed by the Wayland compositor's focus rules (focus-stealing prevention; Electron 44 forwards the libnotify activation token only when running on the native Wayland ozone platform, not under XWayland). Confirm the raise on the real desktop using the M9-bugfix manual verification procedure above.
- **WebRTC calls** expected to work (Electron = Chromium) but not explicitly tested yet.

## Principles Followed
- No WhatsApp Web DOM injection, CSS, or JavaScript override (M1 loads URL directly)
- Minimal preload bridge (only placeholder APIs)
- Security: `nodeIntegration: false`, `contextIsolation: true`
- Single-instance lock with second-instance restore
- Persistent session via named partition, not fragile cookie manipulation
- Clean module separation; no unnecessary abstractions
