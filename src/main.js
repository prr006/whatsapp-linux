/**
 * WhatsApp for Linux — Main Process
 * M1 Proof of Concept: loads WhatsApp Web with persistent session.
 */

const { app, BrowserWindow, Tray, Menu, dialog, shell, Notification, ipcMain, nativeImage } = require('electron');
const fs = require('fs');

app.setName('whatsapp-linux');
const path = require('path');

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

// M7: bounded auto-dismiss for native notifications. Some Linux notification
// daemons keep banners up indefinitely when no expiry is specified; we enforce
// a short window so behaviour is consistent with a polished desktop UX.
const NOTIFICATION_TIMEOUT_MS = 5000;

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


function updateUnreadIndicator() {
  if (!tray) return;
  const badgePath = getRuntimeIconFile('icon-badge.png');
  if (unreadCount > 0) {
    tray.setToolTip('WhatsApp — ' + unreadCount + ' unread');
    if (mainWindow) {
      try { mainWindow.setOverlayIcon(badgePath); } catch (e) { /* overlay not critical */ }
    }
  } else {
    tray.setToolTip('WhatsApp for Linux');
    if (mainWindow) {
      try { mainWindow.setOverlayIcon(null); } catch (e) { /* overlay not critical */ }
    }
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
// renderer whether one of two long-standing stable selectors exists:
//   #side    -> chat list sidebar (existing, logged-in session)
//   .qr-code -> QR container on the login screen (fresh session)
// Either one is the point at which the user can actually use WhatsApp, so it
// is the "usable" timestamp for cold-start measurement.
const UI_READY_PROBE = [
  '(function () {',
  "  if (document.querySelector('#side')) return 'chat-list';",
  "  if (document.querySelector('.qr-code')) return 'qr-code';",
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
  mainWindow.once('ready-to-show', () => {
    perfLog('ready-to-show');
    if (settings.startMinimized) {
      mainWindow.hide();
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
  // probe (see UI_READY_PROBE above).
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
  });

  // M7: Native Linux desktop notifications via Electron Notification API.
  // We listen to WhatsApp Web's standard web Notification events and replace
  // them with controlled native notifications so they:
  //   - only appear when the user is NOT already looking at the chat,
  //   - auto-dismiss after a short bounded time (NOTIFICATION_TIMEOUT_MS),
  //   - restore/focus the SAME window on click (single-instance guarantees no
  //     second process is created),
  //   - are deduplicated (isDuplicate), and
  //   - are removed after a click (nativeNotif.close()).
  mainWindow.webContents.on('notification', (event, notification) => {
    // Prevent Chromium's own rendering of the web notification (avoid duplicates).
    event.preventDefault();

    // User is already looking at the app: no banner, no unread bump.
    if (isMainWindowFocused()) {
      return;
    }

    const title = notification.title || 'WhatsApp';
    const body = notification.body || '';

    // Dedup key: title + first 50 chars of body.
    const dedupKey = title + '|' + body.substring(0, 50);
    if (isDuplicate(dedupKey)) {
      console.log('Notification suppressed (duplicate):', title);
      return;
    }

    // Count as unread regardless of the notification toggle (keeps M2/M3
    // tray badge/tooltip behaviour intact even when banners are disabled).
    unreadCount++;
    updateUnreadIndicator();

    const s = loadSettings();
    if (!s.notificationsEnabled) {
      console.log('Notification suppressed (disabled by setting):', title, '| unread=', unreadCount);
      return;
    }

    const nativeNotif = new Notification({
      title: title,
      body: s.notificationPreview ? body : '',
      icon: getRuntimeIconFile('icon.png'),
      silent: false
    });

    // Click -> dismiss the banner and restore/focus the existing window.
    nativeNotif.on('click', () => {
      nativeNotif.close();
      showAndFocusMainWindow();
    });

    // Surface daemon delivery problems instead of failing silently.
    nativeNotif.on('failed', (ev, error) => {
      console.error('Native notification failed to display:', error);
    });

    nativeNotif.show();

    // Bounded auto-dismiss (~5s). On daemons that already honour a short
    // default expiry this is a harmless no-op; on daemons that keep banners
    // up indefinitely it enforces the requirement.
    setTimeout(() => {
      try { nativeNotif.close(); } catch (e) { /* already gone */ }
    }, NOTIFICATION_TIMEOUT_MS);

    console.log('Native notification shown:', title, '| unread=', unreadCount);
  });

  // M3: reset unread when user returns to app
  mainWindow.on('focus', () => {
    if (unreadCount > 0) {
      unreadCount = 0;
      updateUnreadIndicator();
      console.log('Unread cleared (focus)');
    }
  });
  mainWindow.on('show', () => {
    if (unreadCount > 0) {
      unreadCount = 0;
      updateUnreadIndicator();
      console.log('Unread cleared (show from tray)');
    }
  });
}

function createSettingsWindow () {
  const settingsWindow = new BrowserWindow({
    width: 500,
    height: 420,
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
  // Apply close-to-tray immediately
  // Apply notification toggle immediately (handled in notification handler via loadSettings)
  // Apply start minimized for future restarts
  if (mainWindow && s.startMinimized && mainWindow.isVisible()) {
    // If already visible and user sets startMinimized, don't hide immediately
  }
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
  // Clean log before exit
  console.log('WhatsApp for Linux shutting down');
});

// M8: export internals for the mocked-Electron test harness
// (test/m7-lifecycle.test.js). Electron ignores main-process exports.
module.exports = {
  __perfStartMs: PERF_START_MS,
  __perfEvents: PERF_EVENTS
};
