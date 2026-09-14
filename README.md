# WhatsApp for Linux

A polished, lightweight Linux desktop client around the official WhatsApp Web experience.

> **Status:** M11 (current) — Linux dock/app-icon unread badge, building on M10 (GNOME banner persistence), M9 (Linux desktop integration, settings, notification polish, release polish), M8 (startup profiling) and M7 (startup + notification UX). The 4–5 s usable / 1–2 s tray figures below were measured on a real machine during M8/M9; **M11 has not yet been run on a real desktop** — see *M11 → Packaged-app verification* for the procedure.

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
- **M11 (current): Linux dock / app-icon unread badge** — see below.

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
│   └── m11-dock-badge-no-tray.test.js # M11 badge survives a tray-init failure
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
npm test       # node --test test/*.test.js — 60 tests, mocked Electron, no display needed
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
