/**
 * M14 test stub — GLib replacement (timer/idle abstractions on top of
 * Node's real event loop, so the vendored 50.1 code runs with REAL timing
 * semantics; the harness asserts on wall-clock outcomes).
 */

export const PRIORITY_DEFAULT = 200;
export const MAXINT32 = 2147483647;

export const DateTime = {
  new_now_local: () => ({
    to_unix: () => Math.floor(Date.now() / 1000),
    format: () => ''
  })
};

// GLib.timeout_add_once(priority, ms, fn) -> source id
export function timeout_add_once(_priority, ms, fn) {
  return setTimeout(() => fn(), Math.max(0, ms));
}

export function source_remove(id) {
  if (id === null || id === undefined) return;
  clearTimeout(id);
}

// GLib.idle_add_once(priority, fn) -> source id (run on next microtask)
export function idle_add_once(_priority, fn) {
  const node = setTimeout(fn, 0);
  return node;
}

export const Source = {
  set_name_by_id: () => {}
};

export default {
  PRIORITY_DEFAULT,
  MAXINT32,
  DateTime,
  timeout_add_once,
  source_remove,
  idle_add_once,
  Source
};
