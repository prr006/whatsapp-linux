/**
 * WhatsApp for Linux — Main Process
 * M1 Proof of Concept: loads WhatsApp Web with persistent session.
 */

const { app, BrowserWindow, Tray, Menu, dialog, shell, Notification, ipcMain, nativeImage } = require('electron');
const fs = require('fs');

app.setName('whatsapp-linux');
const path = require('path');

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
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
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

  // Load WhatsApp Web directly — NO DOM injection, NO custom CSS per principles
  mainWindow.loadURL('https://web.whatsapp.com', {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  });

  // Show when ready to reduce visual flicker
  const settings = loadSettings();
  mainWindow.once('ready-to-show', () => {
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

  // M2 fix: close-to-tray — prevent window destruction on X, hide instead
  mainWindow.on('close', (e) => {
    const s = loadSettings();
    if (s.closeToTray) {
      e.preventDefault();
      mainWindow.hide();
      console.log('Window hidden to tray (close prevented)');
    }
  });

  // Window actually destroyed (e.g., app quit), clean up reference
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Log navigation for debugging compatibility
  mainWindow.webContents.on('did-navigate', (event, url) => {
    console.log('Navigated to:', url);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('Page loaded successfully');
  });

  // M2: Native Linux desktop notifications via Electron Notification API
  // We listen to WhatsApp Web's standard web Notification events and
  // replace them with native notifications to work when hidden/minimized.
  mainWindow.webContents.on('notification', (event, notification, actions) => {
    // Prevent the default web notification from also showing (avoid duplicates)
    event.preventDefault();

    const title = notification.title || 'WhatsApp';
    const body = notification.body || '';
    const iconPath = getRuntimeIconFile('icon.png');

    // Dedup key: title + first 50 chars of body
    const dedupKey = title + '|' + body.substring(0, 50);
    if (isDuplicate(dedupKey)) {
      console.log('Notification suppressed (duplicate):', title);
      return;
    }

    const s = loadSettings();
    if (s.notificationsEnabled) {
      unreadCount++;
      updateUnreadIndicator();
      if (mainWindow && mainWindow.isFocused()) {
        unreadCount = 0;
        updateUnreadIndicator();
      }
      const previewBody = s.notificationPreview ? body : '';
      const nativeNotif = new Notification({
        title: title,
        body: previewBody,
        icon: iconPath,
        hasReply: false,
        silent: false
      });
      nativeNotif.on('click', () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }
      });
      nativeNotif.show();
      console.log('Native notification shown:', title, '| unread=', unreadCount);
    } else {
      // Notifications disabled: don't show native, but still count for unread if message arrives
      unreadCount++;
      updateUnreadIndicator();
      if (mainWindow && mainWindow.isFocused()) {
        unreadCount = 0;
        updateUnreadIndicator();
      }
      console.log('Notification suppressed (disabled by setting):', title);
    }
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
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
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
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  try {
    createTray();
  } catch (err) {
    tray = null;
    console.error('Tray initialization failed:', err && err.message ? err.message : err);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
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
  // Clean log before exit
  console.log('WhatsApp for Linux shutting down');
});
