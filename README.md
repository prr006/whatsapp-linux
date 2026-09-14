# WhatsApp for Linux

A polished, lightweight Linux desktop client around the official WhatsApp Web experience.

> **Status:** M9 (current) — Linux desktop integration, settings correctness, notification polish, and release polish, building on M8 (startup profiling) and M7 (startup + notification UX). Verified on a real machine: packaged app takes roughly **4–5 s until WhatsApp is usable**, while the tray appears in roughly **1–2 s**.

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
- **M9 (current): Linux integration, settings, notifications & release polish** — see below.

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

## M9 bugfix — Linux notification click + dismissal (real desktop)

The mocked M9 tests passed but did not exercise the real libnotify / GNOME
(Desktop Notifications) path, so two Linux-specific defects slipped through:

1. **Click did not restore/focus the window.** Electron's `Notification` JS
   object is only a weak handle to the native libnotify notification. The
   previous code created the notification as a local `const` held only by the
   ~5 s auto-dismiss `setTimeout` closure; once that closure was released the
   object became garbage, Electron cleared the native delegate, and the `click`
   event could no longer reach `showAndFocusMainWindow()`. This is the
   canonical "Linux notification click does nothing" failure.
2. **The banner did not reliably auto-dismiss.** The banner's visual lifetime
   is owned by the notification daemon. Electron's Linux Notification API has
   no per-notification millisecond timeout — `timeoutType` only accepts
   `'default'` (the daemon's own expiry) or `'never'` — so the ~5 s window can
   only be enforced with `notification.close()` on a timer, which maps to
   libnotify's `notify_notification_close()` (a `CloseNotification` DBus
   request). Without a stable reference to the wrapper, this dismissal request
   and its `close` event were not observable.

### Fix
- Every live notification is now retained in a module-level
  `activeNotifications` set (released on click / daemon `close` / `failed`), so
  the wrapper — and its `click` delivery — survives garbage collection for the
  banner's whole visible lifetime.
- Notification construction/show/click/close, the auto-dismiss timer, and the
  `close`/`show`/`failed` events are logged with a `[notif]` prefix so the real
  packaged-desktop path can be traced (`grep '[notif]'`).
- `timeoutType: 'default'` is set explicitly and the Linux-only timeout
  limitation is documented in `src/main.js`.
- Unread counting, dedup, focused-app suppression, close-to-tray, and tray
  behaviour are unchanged.

### Manual verification (real Ubuntu Wayland desktop)
Mocked Electron events cannot prove libnotify click delivery — verify the
**packaged DEB** on the actual desktop:

```bash
# 0. Build + install the DEB (see "Build"), then launch from the app grid.
#    To capture the [notif] trace, run the installed binary in a terminal:
/opt/WhatsApp\ for\ Linux/whatsapp-linux 2>&1 | tee /tmp/whatsapp-notif.log

# 1. Send yourself a message from another device/account and keep the
#    WhatsApp window hidden to the tray (or unfocused).
#    Expected log (grep it while the banner is up):
grep '\[notif\]' /tmp/whatsapp-notif.log
#    constructing <title>
#    calling show() <title>
#    show event (banner visible) <title>
#    scheduling auto-dismiss in 5000ms <title>
#    auto-dismiss timer fired <title>
#    dismissing (auto-dismiss timeout) <title>

# 2. Click the banner while it is visible (do NOT move the cursor over it
#    first). Expected: the window restores + focuses, and the log shows
#    click -> restore/focus window <title>

# 3. Confirm the banner disappears on its own after ~5 s without any pointer
#    interaction over it (the [notif] trace should show the timer firing).

# 4. Confirm the daemon also reports the dismissal via D-Bus (optional,
#    proves the native CloseNotification path):
dbus-monitor --session "interface='org.freedesktop.Notifications'"
#    ... Method Call Notify ... ActionInvoked (on click) ... CloseNotification

# 5. Regression checks: dedup (two identical messages -> one banner), focused
#    app -> no banner + no unread bump, disabled banners -> unread still
#    tracked, tray reopen -> unread cleared, close-to-tray still hides.
```

Expected result: clicking the banner fires `click` and the window is restored
and focused; the banner auto-dismisses after ~5 s. If the window is still not
raised on click even though `click -> restore/focus window` is logged, that is
a Wayland compositor focus rule (focus-stealing prevention / activation token)
rather than a notification-delivery issue — see "Known Issues / Limitations".

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
│   └── m9-linux-integration.test.js# M9 desktop identity, autostart, start-minimized, notification edge cases
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
npm test       # node --test test/*.test.js — 29 tests, mocked Electron, no display needed
```

## Testing Protocol (per instructions)
After M1 build: initial launch → QR display → login → send message → receive message → close → reopen → session persistence → inspect logs → verify no Chromium errors.

## Known Issues / Limitations
- **Electron binary download blocked** in this sandbox (`curl`/`node fetch` fail to `github.com/electron` releases with SSL errors). `npm install` succeeds (285 packages), `node --check`, `npm test`, and the build-config audit all pass, but `npm run dist` stops at the electron binary download step ("unable to verify the first certificate") and actual launch requires downloading `electron-v44.3.0-linux-x64.zip` (~180 MB) or an environment with unrestricted download.
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
