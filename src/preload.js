/**
 * Preload script — minimal for M1.
 * No DOM selectors, no injection, no custom APIs exposed yet.
 * When M2 needs safe bridge (notifications, unread counts), expose here
 * using contextBridge rather than nodeIntegration.
 */

const { contextBridge } = require('electron');

// Intentionally empty in M1 to respect the principle:
// "Do not inject JavaScript into WhatsApp Web unless there is a demonstrated need."
// All M1 functionality is delivered by the main process (window, tray, session).

contextBridge.exposeInMainWorld('whatsappLinux', {
  // Placeholder: safe APIs can be added here after a demonstrated need.
  version: '0.1.0',
  platform: process.platform
});
