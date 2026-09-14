/**
 * M14 TEST STUB (not upstream code) — minimal stand-in for 50.1
 * js/misc/gnomeSession.js: the org.gnome.Session presence proxy. The
 * MessageTray constructor takes a callback and connects
 * 'StatusChanged'; the harness never fires D-Bus signals here (busy state
 * is exercised by calling the real `tray._onStatusChanged()` directly).
 */

export class Presence {
  constructor(callback) {
    this.status = PresenceStatus.AVAILABLE;
    this._callback = callback;
  }

  connectSignal() {}
}

// org.gnome.Session.Status values (GnomeSession.PresenceStatus).
export const PresenceStatus = {
  IDLE: 0,
  BUSY: 1,
  AVAILABLE: 2
};
