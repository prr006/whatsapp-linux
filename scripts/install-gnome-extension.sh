#!/usr/bin/env bash
# M14 — install/uninstall the "deterministic banner" GNOME Shell extension
# for WhatsApp for Linux (user-local, no root required).
#
# The extension makes the GNOME notification banner for THIS app disappear
# after a fixed ~5 s (deterministic, independent of idle state / pointer /
# queue position) while keeping the notification in the notification list.
# All other applications keep stock GNOME behaviour.
#
# Usage:
#   scripts/install-gnome-extension.sh            # install (or refresh) + enable
#   scripts/install-gnome-extension.sh --uninstall   # disable + remove
#   scripts/install-gnome-extension.sh --prefix /some/dir   # test prefix
#
# Idempotent: re-running upgrades in place when the version changed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${REPO_ROOT}/gnome-extension"
UUID="whatsapp-deterministic-banner@prr006"

UNINSTALL=0
PREFIX="${XDG_DATA_HOME:-${HOME}/.local/share}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) UNINSTALL=1; shift ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

DEST_DIR="${PREFIX}/gnome-shell/extensions/${UUID}"

version_of() { # $1 = source or dest dir
  if [[ -f "$1/metadata.json" ]]; then
    python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("version","?"))' "$1/metadata.json" 2>/dev/null || echo '?'
  else
    echo '?'
  fi
}

copy_extension() {
  mkdir -p "$DEST_DIR"
  local f
  for f in metadata.json extension.js policy.js package.json; do
    if [[ ! -f "${SRC_DIR}/${f}" ]]; then
      echo "error: ${SRC_DIR}/${f} not found (run from the repository checkout)" >&2
      return 1
    fi
    cp -f "${SRC_DIR}/${f}" "${DEST_DIR}/${f}"
  done
  # Version stamp: lets the app's first-run installer detect an up-to-date
  # install without diffing every file.
  version_of "$SRC_DIR" > "${DEST_DIR}/.m14-install-version"
}

enable_extension() {
  if command -v gnome-extensions >/dev/null 2>&1; then
    if gnome-extensions enable "$UUID" 2>/dev/null; then
      echo "extension enabled: ${UUID} (loaded immediately if GNOME Shell is running)"
    else
      echo "warning: 'gnome-extensions enable ${UUID}' failed (is GNOME running?)" >&2
      echo "         you can enable it later from the Extensions app." >&2
    fi
  else
    echo "note: gnome-extensions CLI not found; enabling skipped."
    echo "      enable '${UUID}' from GNOME Settings > Extensions next time you log in."
  fi
}

disable_extension() {
  if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions disable "$UUID" 2>/dev/null || true
  fi
}

if [[ $UNINSTALL -eq 1 ]]; then
  disable_extension
  if [[ -d "$DEST_DIR" ]]; then
    rm -rf "$DEST_DIR"
    echo "removed ${DEST_DIR}"
  else
    echo "not installed at ${DEST_DIR}"
  fi
  exit 0
fi

if [[ ! -d "$SRC_DIR" ]]; then
  echo "error: extension source ${SRC_DIR} not found" >&2
  exit 1
fi

SRC_VERSION="$(version_of "$SRC_DIR")"
DEST_VERSION="$(version_of "$DEST_DIR" 2>/dev/null || true)"

if [[ -f "${DEST_DIR}/.m14-install-version" ]] && \
   [[ "$(cat "${DEST_DIR}/.m14-install-version")" == "$SRC_VERSION" ]] && \
   [[ -f "${DEST_DIR}/extension.js" ]]; then
  echo "already installed (version ${SRC_VERSION}) at ${DEST_DIR}"
else
  copy_extension
  echo "installed ${UUID} (version ${SRC_VERSION}) at ${DEST_DIR}"
fi

enable_extension
