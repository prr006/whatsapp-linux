/**
 * M14 TEST STUB (not upstream code) — minimal stand-in for 50.1
 * js/ui/messageList.js. The real module builds the banner/list row actors;
 * the vendored messageTray.js only needs:
 *   - MessageList.Source: the GObject base class of MessageTray.Source,
 *   - MessageList.NotificationMessage: the banner actor, with exactly the
 *     surface messageTray.js touches (can_focus, _header.expandButton,
 *     add_style_class_name, expand/expanded, destroy, disconnectObject)
 *     plus a __simulateClick() that mirrors the real `vfunc_clicked()`
 *     (which calls `this.notification?.activate()`).
 */

import GObject from 'gi://GObject';

export class Source extends GObject.Object {
  _init() {}
}

export class NotificationMessage extends GObject.Object {
  constructor(notification) {
    super();
    this.notification = notification;
    this.can_focus = false;
    this.expanded = false;
    this._header = {
      expandButton: { visible: false },
      closeButton: { visible: false }
    };
  }

  add_style_class_name() {}

  expand(v) {
    this.expanded = v === true;
  }

  // The real banner actor is an St actor; the tray calls destroy() on it in
  // _hideNotificationCompleted.
  destroy() {
    this.run_dispose();
  }

  // Mirrors the real 50.1 vfunc_clicked(): banner click activates the
  // notification (daemon then emits ActionInvoked and, for non-resident
  // notifications, destroys it with reason DISMISSED).
  __simulateClick() {
    if (this.notification) this.notification.activate();
  }
}
