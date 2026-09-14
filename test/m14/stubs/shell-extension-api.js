/**
 * M14 test stub — stands in for the shell's extension API module
 * (resource:///org/gnome/shell/extensions/extension.js).
 *
 * `Extension` is a minimal base (the real one adds gettext/uuid plumbing
 * the governor does not use). `InjectionManager` below is the **verbatim**
 * class from the 50.1 `js/extensions/extension.js` (see
 * vendor/PROVENANCE.md), with only its GJS `imports._gi` binding replaced
 * by stub symbols — the vfunc branch is present but never exercised, since
 * the governor overrides plain JS methods. This means the shipped
 * extension's override/restore bookkeeping is the real shell code.
 */

// Stand-in for the GJS `imports._gi` symbols (only used by the vfunc
// branch, which the governor never hits).
const Gi = {
  gobject_prototype_symbol: Symbol.for('gjs-gobject-prototype'),
  hook_up_vfunc_symbol: Symbol.for('gjs-hook-up-vfunc')
};

export class Extension {
  constructor(metadata) {
    this.metadata = metadata || {};
  }

  get uuid() {
    return this.metadata['uuid'] || 'test-extension';
  }

  enable() {}

  disable() {}

  getLogger() {
    return {
      log: (...args) => console.log('[m14-ext]', ...args),
      warn: (...args) => console.warn('[m14-ext]', ...args),
      error: (...args) => console.error('[m14-ext]', ...args),
      debug: () => {},
      trace: () => {}
    };
  }
}

export class InjectionManager {
  #savedMethods = new Map();

  /**
   * @callback CreateOverrideFunc
   * @param {Function?} originalMethod - the original method if it exists
   * @returns {Function} - a function to be used as override
   */

  /**
   * Modify, replace or inject a method
   *
   * @param {object} prototype - the object (or prototype) that is modified
   * @param {string} methodName - the name of the overwritten method
   * @param {CreateOverrideFunc} createOverrideFunc - function to call to create the override
   */
  overrideMethod(prototype, methodName, createOverrideFunc) {
    const originalMethod = this._saveMethod(prototype, methodName);
    this._installMethod(prototype, methodName, createOverrideFunc(originalMethod));
  }

  /**
   * Restore the original method
   *
   * @param {object} prototype - the object (or prototype) that is modified
   * @param {string} methodName - the name of the overwritten method
   */
  restoreMethod(prototype, methodName) {
    const savedProtoMethods = this.#savedMethods.get(prototype);
    if (!savedProtoMethods)
      return;

    const originalMethod = savedProtoMethods.get(methodName);
    if (originalMethod === undefined)
      delete prototype[methodName];
    else
      this._installMethod(prototype, methodName, originalMethod);

    savedProtoMethods.delete(methodName);
    if (savedProtoMethods.size === 0)
      this.#savedMethods.delete(prototype);
  }

  /**
   * Restore all original methods and clear overrides
   */
  clear() {
    for (const [proto, map] of this.#savedMethods) {
      map.forEach(
        (_, methodName) => this.restoreMethod(proto, methodName));
    }
    console.assert(this.#savedMethods.size === 0,
      `${this.#savedMethods.size} overrides left after clear()`);
  }

  _saveMethod(prototype, methodName) {
    let savedProtoMethods = this.#savedMethods.get(prototype);
    if (!savedProtoMethods) {
      savedProtoMethods = new Map();
      this.#savedMethods.set(prototype, savedProtoMethods);
    }

    const originalMethod = prototype[methodName];
    savedProtoMethods.set(methodName, originalMethod);
    return originalMethod;
  }

  _installMethod(prototype, methodName, method) {
    if (methodName.startsWith('vfunc_')) {
      const giPrototype = prototype[Gi.gobject_prototype_symbol];
      giPrototype[Gi.hook_up_vfunc_symbol](methodName.slice(6), method);
    } else {
      prototype[methodName] = method;
    }
  }
}

export default { Extension, InjectionManager };
