/**
 * M14 test stub — the fake GNOME Shell `global` object and the
 * controllable environment (idle monitor, pointer, fullscreen monitor)
 * that the vendored REAL 50.1 messageTray.js reads.
 *
 * Only environment/IO is faked; every banner decision comes from the
 * vendored upstream code.
 */

// The primary monitor object the real code checks (`inFullscreen`).
export const monitor = { inFullscreen: false };

// Controllable idle monitor state. `idletimeMs` is what
// idleMonitor.get_idletime() returns; `watches` are the user-active
// watches registered by the real _showNotification code.
export const idleState = {
  idletimeMs: 0,
  watches: new Set()
};

// Controllable pointer position (real code: global.get_pointer()).
export const pointerState = { x: 600, y: 500 };

const stage = {
  get_key_focus: () => null,
  set_key_focus: () => {},
  connectObject: () => {},
  disconnectObject: () => {},
  get_actor_at_pos: () => null
};

const display = {
  get_sound_player: () => ({
    play_from_theme: () => {},
    play_from_file: () => {}
  }),
  connectObject: () => {}
};

const compositor = {
  disable_unredirect: () => {},
  enable_unredirect: () => {}
};

const backend = {
  get_core_idle_monitor: () => ({
    get_idletime: () => idleState.idletimeMs,
    add_user_active_watch: (cb) => idleState.watches.add(cb),
    remove_user_active_watch: (cb) => idleState.watches.delete(cb)
  })
};

export function installGlobal() {
  const fakeGlobal = {
    stage,
    display,
    compositor,
    backend,
    get_pointer: () => [pointerState.x, pointerState.y],
    create_app_launch_context: () => ({ get_startup_notify_id: () => '' }),
    settings: {
      get_boolean: () => false,
      get_strv: () => [],
      is_writable: () => false
    }
  };
  globalThis.global = fakeGlobal;
  globalThis._ = (s) => s;
  globalThis.log = (...a) => console.log('[shell]', ...a);
  globalThis.logError = (...a) => console.error('[shell]', ...a);
  return fakeGlobal;
}

export function triggerUserActivity() {
  // Mirrors the real idle monitor: the user became active; every pending
  // user-active watch fires exactly once and is removed.
  const watches = [...idleState.watches];
  idleState.watches.clear();
  idleState.idletimeMs = 0;
  watches.forEach((cb) => cb());
}

export function resetEnvironment() {
  idleState.idletimeMs = 0;
  idleState.watches.clear();
  pointerState.x = 600;
  pointerState.y = 500;
  monitor.inFullscreen = false;
}
