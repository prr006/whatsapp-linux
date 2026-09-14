/**
 * M14 TEST STUB (not upstream code) — minimal stand-in for 50.1
 * js/ui/main.js: only the surface the vendored messageTray.js touches at
 * construction/run time.
 */

import * as shared from '../../shared.js';

export const layoutManager = {
  panelBox: { bind_property() {} },
  // The shared fake monitor: the harness can flip `inFullscreen` to
  // exercise the busy/fullscreen gating in the REAL _updateState code.
  primaryMonitor: shared.monitor,
  addChrome() {},
  trackChrome() {}
};

export const sessionMode = {
  hasNotifications: true,
  connect() {}
};

export const overview = {
  connect() {},
  hide() {}
};

export const xdndHandler = {
  connect() {}
};

export const wm = {
  addKeybinding() {}
};

export let messageTray = null;
