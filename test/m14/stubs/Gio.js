/**
 * M14 test stub — Gio replacement: inert Settings/Icon classes (the
 * vendored messageTray.js constructs Gio.Settings for keybindings and
 * notification-policy schemas; policy getters default to "banners on").
 */

export class Settings {
  constructor(opts = {}) {
    this.schema_id = opts.schema_id || null;
    this.path = opts.path || null;
  }
  connect() {}
  get_boolean() { return true; }
  get_strv() { return []; }
  get_string() { return ''; }
  get_value() { return null; }
  is_writable() { return true; }
  run_dispose() {}
}

export const BindingFlags = { SYNC_CREATE: 1, DEFAULT: 0 };

export class Icon {}

export class ThemedIcon {
  constructor(opts = {}) { this.iconName = opts.name || null; }
}

export class FileIcon {
  constructor(opts = {}) { this.file = opts.file || null; }
}

export const File = {
  new_for_path: () => ({})
};

export function icon_deserialize() {
  return {};
}

export default {
  Settings,
  BindingFlags,
  Icon,
  ThemedIcon,
  FileIcon,
  File,
  icon_deserialize
};
