/**
 * WhatsApp for Linux — Main Process
 * M1 Proof of Concept: loads WhatsApp Web with persistent session.
 */

const { app, BrowserWindow, Tray, Menu, dialog, shell, Notification } = require('electron');
const path = require('path');

// Keep references to avoid GC
let mainWindow = null;
let tray = null;

// M2: lightweight dedup tracker for native notifications
const recentNotifications = new Map();
const NOTIFICATION_DEDUP_WINDOW_MS = 3000;
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
    icon: path.join(__dirname, '..', 'build', 'icons', 'icon.png'),
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
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
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
    e.preventDefault();
    mainWindow.hide();
    console.log('Window hidden to tray (close prevented)');
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
    const iconPath = path.join(__dirname, '..', 'build', 'icons', 'icon.png');

    // Dedup key: title + first 50 chars of body
    const dedupKey = title + '|' + body.substring(0, 50);
    if (isDuplicate(dedupKey)) {
      console.log('Notification suppressed (duplicate):', title);
      return;
    }

    // Only show native notification; keep it lightweight/non-blocking
    const nativeNotif = new Notification({
      title: title,
      body: body,
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
    console.log('Native notification shown:', title, '|', body.substring(0, 60));
  });
}

function createTray () {
  // Use a simple icon for tray; fall back to app icon if needed
  const iconPath = path.join(__dirname, '..', 'build', 'icons', 'icon.png');
  tray = new Tray(iconPath);
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
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
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
