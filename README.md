# WhatsApp for Linux

A polished, lightweight Linux desktop client around the official WhatsApp Web experience.

> **Status:** M8 (current) — startup profiling / cold-start measurement, building on the merged M7 (startup + notification UX). Verified on a real machine: packaged app takes roughly **4–5 s until WhatsApp is usable**, while the tray appears in roughly **1–2 s**.

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
- **M8 (current): Startup profiling / cold-start measurement** — see below.

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
- **Tests**: `npm test` runs `test/m7-lifecycle.test.js` (mocked Electron,
  no display needed) covering close-to-tray, focused/hidden notification
  behaviour, auto-dismiss, click-to-restore, dedup, disabled toggle,
  single-instance, and quit-cascade.

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

## Directory Structure
```
whatsapp-linux/
├── src/
│   ├── main.js         # Electron main (window, tray, session, events, M8 [perf] instrumentation)
│   ├── preload.js      # Safe bridge (empty in M1 per principles)
│   ├── preload-settings.js
│   └── settings.html
├── scripts/
│   └── measure-startup.sh  # M8 cold-start measurement harness (npm run measure:startup)
├── test/
│   └── m7-lifecycle.test.js # Mocked-Electron tests, incl. M8 instrumentation tests
├── build/
│   ├── icons/icon.png  # App icon (AI-generated)
│   └── whatsapp-linux.desktop
├── package.json        # Dependencies, build config, scripts
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
npm run dist   # AppImage / deb / rpm
```

## Testing Protocol (per instructions)
After M1 build: initial launch → QR display → login → send message → receive message → close → reopen → session persistence → inspect logs → verify no Chromium errors.

## Known Issues / Limitations (M1)
- **Electron binary download blocked** in this sandbox (`curl`/`node fetch` fail to `github.com/electron` releases with SSL errors). Build verified via `npm install` (285 packages), `node --check`, and dry-run test. Actual launch requires downloading `electron-v44.3.0-linux-x64.zip` (~180 MB) or using an environment with unrestricted download.
- **No display server** (Xvfb) installed; launch would require `DISPLAY=:99` or a real X11/Wayland session.
- **No system browsers** installed for independent WhatsApp Web verification (not required since Electron bundles Chromium).
- **Tray functionality untested** at runtime; code uses standard Electron `Tray` and `Menu` APIs.
- **Notifications / unread badges / close-to-tray / start-with-system** deferred to M2/M3 per milestone plan.
- **WebRTC calls** expected to work (Electron = Chromium) but not explicitly tested yet.

## Principles Followed
- No WhatsApp Web DOM injection, CSS, or JavaScript override (M1 loads URL directly)
- Minimal preload bridge (only placeholder APIs)
- Security: `nodeIntegration: false`, `contextIsolation: true`
- Single-instance lock with second-instance restore
- Persistent session via named partition, not fragile cookie manipulation
- Clean module separation; no unnecessary abstractions
