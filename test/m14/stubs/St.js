/**
 * M14 test stub — St (Shell Text) actor replacement: just enough actor
 * surface for the vendored 50.1 messageTray.js: children, style classes,
 * transitions (ease with REAL durations + onComplete/onStopped), focus
 * helpers.
 */

import GObject from './GObject.js';

export class Widget extends GObject.Object {
  _init(params) {
    if (params && typeof params === 'object') Object.assign(this, params);
    if (!this.__children) this.__children = [];
    if (!this.__transitions) this.__transitions = [];
  }

  add_child(c) { this.__children.push(c); }
  add_constraint() {}
  set_pivot_point() {}
  show() { this.visible = true; }
  hide() { this.visible = false; }

  get height() { return 100; }

  remove_all_transitions() {
    (this.__transitions || []).forEach((id) => clearTimeout(id));
    this.__transitions = [];
  }

  ease(opts) {
    const duration = opts && typeof opts.duration === 'number' ? opts.duration : 0;
    const id = setTimeout(() => {
      if (opts.onComplete) opts.onComplete();
      if (opts.onStopped) opts.onStopped();
    }, duration);
    (this.__transitions = this.__transitions || []).push(id);
  }

  navigate_focus() { return true; }
  grab_key_focus() {}
  contains() { return false; }
}

export const DirectionType = {
  TAB_FORWARD: 0,
  TAB_BACKWARD: 1
};

export default { Widget, DirectionType };
