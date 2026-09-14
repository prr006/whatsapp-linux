/**
 * M14 test stub — minimal GObject replacement for running the REAL 50.1
 * js/ui/messageTray.js under Node.
 *
 * Implements only what messageTray.js (and its test driver) rely on:
 *   - GObject.Object: construction with a params object, property
 *     assignment, `set()`, the signal connection model (including
 *     property signals `notify::<prop>` and the GJS convention that
 *     signal callbacks receive the emitting object as the FIRST argument),
 *     connectObject/disconnectObject lifetime tracking, run_dispose.
 *   - registerClass: records spec and assigns `$gtype` (enough for the
 *     source's `X.$gtype` references).
 *   - ParamSpec/ParamFlags/TypeFlags/BindingFlags/TYPE_*: inert tokens.
 *
 * The banner state machine logic under test is 100% the vendored upstream
 * code; this file only models the object/signal container semantics.
 */

let gtypeSeq = 1;

// The class below shadows the built-in `Object` name within this
// module (and its TDZ covers the whole module scope); reach the real
// built-in through the global object for static helpers.
const BuiltInObject = globalThis.Object;

export const ParamFlags = {
  READABLE: 1,
  WRITABLE: 2,
  READWRITE: 3,
  CONSTRUCT: 4,
  CONSTRUCT_ONLY: 8
};

export const TypeFlags = { ABSTRACT: 1 };

export const BindingFlags = { SYNC_CREATE: 1, DEFAULT: 0 };

export const TYPE_UINT = Symbol.for('m14-stub:TYPE_UINT');
export const TYPE_INT = Symbol.for('m14-stub:TYPE_INT');
export const TYPE_STRING = Symbol.for('m14-stub:TYPE_STRING');
export const TYPE_BOOLEAN = Symbol.for('m14-stub:TYPE_BOOLEAN');
export const TYPE_OBJECT = Symbol.for('m14-stub:TYPE_OBJECT');
export const TYPE_BOXED = Symbol.for('m14-stub:TYPE_BOXED');

function paramSpec(kind, args) {
  return { kind, args };
}

export const ParamSpec = {
  int: (...a) => paramSpec('int', a),
  string: (...a) => paramSpec('string', a),
  boolean: (...a) => paramSpec('boolean', a),
  object: (...a) => paramSpec('object', a),
  boxed: (...a) => paramSpec('boxed', a)
};

export class Object {
  constructor(params) {
    this.__conns = new Map();
    this.__ownedConns = new Map();
    this.__disposed = false;
    if (params && typeof params === 'object') {
      for (const [k, v] of BuiltInObject.entries(params)) this[k] = v;
    }
    // GJS calls a class-defined `_init()` from the GObject machinery for
    // classes that do not define an explicit JS constructor. Emulate that:
    // St.Widget subclasses (e.g. the real MessageTray) rely on it.
    if (typeof this._init === 'function' && this._init !== Object.prototype._init) {
      this._init(params);
    }
  }

  _init() {}

  set(params) {
    if (params && typeof params === 'object') {
      for (const [k, v] of BuiltInObject.entries(params)) this[k] = v;
    }
  }

  connect(signal, cb) {
    if (!this.__conns.has(signal)) this.__conns.set(signal, []);
    this.__conns.get(signal).push(cb);
    return this.__conns.get(signal).length - 1;
  }

  /** GJS `connectObject(sig, cb, sig2, cb2, ..., owner)` — same callbacks,
   * auto-disconnected when `owner` is disposed. */
  connectObject(...args) {
    let owner = null;
    if (args.length % 2 === 1) owner = args.pop();
    for (let i = 0; i < args.length; i += 2) this.connect(args[i], args[i + 1]);
    if (owner) {
      if (!this.__ownedConns.has(owner)) this.__ownedConns.set(owner, new Set());
      const set = this.__ownedConns.get(owner);
      for (let i = 0; i < args.length; i += 2) set.add(args[i]);
    }
  }

  disconnectObject(owner) {
    const set = this.__ownedConns.get(owner);
    if (!set) return;
    for (const sig of set) this.__conns.delete(sig);
    this.__ownedConns.delete(owner);
  }

  /** GJS signal emission: callbacks receive (thisObject, ...emitArgs). */
  emit(signal, ...args) {
    const list = this.__conns.get(signal);
    if (!list) return;
    list.slice().forEach((cb) => cb(this, ...args));
  }

  /** GObject property notification (property signals). */
  notify(prop) {
    this.emit('notify', { name: prop });
    this.emit('notify::' + prop);
  }

  run_dispose() {
    if (this.__disposed) return;
    this.__disposed = true;
    this.__conns.clear();
  }
}

// GJS allows both registerClass(spec, class) and registerClass(class).
export function registerClass(a, b) {
  const spec = b === undefined ? {} : a;
  const Klass = b === undefined ? a : b;
  if (!Klass.$gtype) Klass.$gtype = gtypeSeq++;
  Klass.__gjsSpec = spec;
  return Klass;
}

export default {
  Object,
  registerClass,
  ParamSpec,
  ParamFlags,
  TypeFlags,
  BindingFlags,
  TYPE_UINT,
  TYPE_INT,
  TYPE_STRING,
  TYPE_BOOLEAN,
  TYPE_OBJECT,
  TYPE_BOXED
};
