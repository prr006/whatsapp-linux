#!/usr/bin/env bash
#
# M9: lightweight resource baseline for WhatsApp for Linux.
#
# Measures (on a real Linux desktop — NOT guesswork):
#   - idle RAM after startup (sum of RSS across the whole Electron process tree)
#   - idle CPU (average % across the process tree over a sampling window)
#   - tray-hidden idle state (same measurements with the window hidden to tray)
#
# It launches the app (dev build or packaged binary) with a unique marker in
# argv, waits for the app to become usable ("first meaningful UI ready"), lets
# it settle, then samples /proc for RSS + CPU jiffies. The tray-hidden state is
# obtained by launching with --start-minimized (src/main.js hides the window
# after ready-to-show while the tray stays alive).
#
# This script only MEASURES. It deliberately performs no tuning and adds no
# Chromium flags — numbers come first, optimisation decisions come later.
#
# Usage:
#   scripts/measure-resources.sh [options]
#
# Options:
#   --app PATH          packaged binary to measure (AppImage or installed binary)
#   --dev               measure the repo dev build (electron .) — default
#   --start-minimized   measure the tray-hidden idle state (hidden after start)
#   --settle S          seconds to let the app go idle after it is usable (10)
#   --sample S          CPU sampling window in seconds (5)
#   --timeout S         max seconds to wait for the app to be usable (90)
#   --user-data D       Electron userData dir (~/.config/whatsapp-linux)
#   --kill              terminate a possibly-running instance first (default: abort)
#   -h, --help          show this help
#
# Exit codes: 0 = measured, 1 = usage error, 2 = app never became usable.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---- defaults / flags --------------------------------------------------------
APP_BIN=""
MODE="dev"
START_MINIMIZED=0
SETTLE=10
SAMPLE=5
TIMEOUT=90
USER_DATA="${XDG_CONFIG_HOME:-$HOME/.config}/whatsapp-linux"
KILL_EXISTING=0

usage() {
  sed -n '2,46p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app)             APP_BIN="${2:?--app needs a path}"; MODE="app"; shift 2 ;;
    --dev)             MODE="dev"; shift ;;
    --start-minimized) START_MINIMIZED=1; shift ;;
    --settle)          SETTLE="${2:?--settle needs a number}"; shift 2 ;;
    --sample)          SAMPLE="${2:?--sample needs a number}"; shift 2 ;;
    --timeout)         TIMEOUT="${2:?--timeout needs a number}"; shift 2 ;;
    --user-data)       USER_DATA="${2:?--user-data needs a path}"; shift 2 ;;
    --kill)            KILL_EXISTING=1; shift ;;
    -h|--help)         usage; exit 0 ;;
    *) echo "error: unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
done

for n in SETTLE SAMPLE TIMEOUT; do
  eval "case \"\$$n\" in ''|*[!0-9]*) echo \"error: --$(echo $n | tr A-Z a-z) must be a positive integer\" >&2; exit 1 ;; esac"
done
[ "$SETTLE" -ge 0 ] || { echo "error: --settle must be >= 0" >&2; exit 1; }
[ "$SAMPLE" -ge 1 ] || { echo "error: --sample must be >= 1" >&2; exit 1; }
[ "$TIMEOUT" -ge 1 ] || { echo "error: --timeout must be >= 1" >&2; exit 1; }

# ---- resolve the app command -------------------------------------------------
ere_escape() { printf '%s' "$1" | sed -e 's/[][\\.*^$/(){}+?|\\\\]/\\&/g'; }

APP_CMD=()
INSTANCE_PATTERNS=()
if [ "$MODE" = "app" ]; then
  [ -x "$APP_BIN" ] || { echo "error: app binary not found or not executable: $APP_BIN" >&2; exit 1; }
  APP_CMD=("$APP_BIN")
  BIN_ABS="$(readlink -f "$APP_BIN")"
  INSTANCE_PATTERNS=("^$(ere_escape "$BIN_ABS")( |$)")
  [ "$APP_BIN" = "$BIN_ABS" ] || INSTANCE_PATTERNS+=("^$(ere_escape "$APP_BIN")( |$)")
else
  ELECTRON_BIN="$REPO_ROOT/node_modules/electron/dist/electron"
  [ -x "$ELECTRON_BIN" ] || {
    echo "error: $ELECTRON_BIN not found — run 'npm install' first," >&2
    echo "       or pass --app PATH to measure a packaged binary instead." >&2
    exit 1
  }
  APP_CMD=("$ELECTRON_BIN" ".")
  ELECTRON_ABS="$(readlink -f "$ELECTRON_BIN")"
  INSTANCE_PATTERNS=(
    "^$(ere_escape "$ELECTRON_ABS")( |$)"
    "^$(ere_escape "$ELECTRON_BIN")( |$)"
    "node $(ere_escape "$REPO_ROOT/node_modules/electron/cli.js")( |$)"
    "node $(ere_escape "$REPO_ROOT/node_modules/.bin/electron")( |$)"
  )
fi

if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  echo "warning: no DISPLAY/WAYLAND_DISPLAY set — a GUI launch will likely fail." >&2
fi

command -v pgrep >/dev/null 2>&1 || { echo "error: pgrep required" >&2; exit 1; }

# NOTE: the $$ (PID) and the $(...) substitution must not be adjacent, or bash
# parses "$$(" as the PID and leaves the rest literal.
RUN_ID="wsm-$$-$(date +%s%N)"
MARKER="measure-resources-run=$RUN_ID"

app_pids() {
  { pgrep -f "$MARKER" 2>/dev/null || true; } | grep -vx "$$" || true
}
instance_pids() {
  local pat
  for pat in "${INSTANCE_PATTERNS[@]}"; do
    pgrep -f "$pat" 2>/dev/null || true
  done | sort -u
}
kill_instances() {
  local pat
  for pat in "${INSTANCE_PATTERNS[@]}"; do
    pkill -f "$pat" 2>/dev/null || true
  done
}

EXISTING="$(instance_pids | tr '\n' ' ')"
if [ -n "$EXISTING" ]; then
  if [ "$KILL_EXISTING" -eq 1 ]; then
    echo "killing possibly-running instance(s): $EXISTING"
    kill_instances
    for _ in $(seq 1 20); do [ -z "$(instance_pids)" ] && break; sleep 0.5; done
  else
    echo "error: a possibly-running instance was detected (pids: $EXISTING)." >&2
    echo "       Quit it, or re-run with --kill to let the harness terminate it." >&2
    exit 1
  fi
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wa-resources-XXXXXX")"
trap 'echo "raw log kept in: $TMP_DIR" >&2' EXIT
LOG="$TMP_DIR/run.log"

stop_app() {
  pkill -TERM -f "$MARKER" 2>/dev/null || true
  for _ in $(seq 1 20); do [ -z "$(app_pids)" ] && return 0; sleep 0.5; done
  pkill -KILL -f "$MARKER" 2>/dev/null || true
  sleep 0.5
}

wait_usable() {
  local deadline=$(( $(date +%s) + TIMEOUT ))
  while true; do
    grep -qF 'first meaningful UI ready' "$LOG" && return 0
    [ -z "$(app_pids)" ] && return 1
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    sleep 0.3
  done
}

# /proc/<pid>/stat: "pid (comm) state ppid ..." — utime is field 14, stime 15.
proc_jiffies() { # pid -> utime+stime
  local pid=$1 line rest
  [ -r "/proc/$pid/stat" ] || return 1
  line="$(cat "/proc/$pid/stat")"
  rest="${line#*) }"          # strip "pid (comm) "
  set -- $rest                # $1 = field 3 (state) ...
  echo "$(( ${12:-0} + ${13:-0} ))"
}

proc_rss_kb() { # pid -> VmRSS in kB
  local pid=$1
  [ -r "/proc/$pid/status" ] || return 1
  awk '/^VmRSS:/{print $2}' "/proc/$pid/status"
}

CLK_TCK="$(getconf CLK_TCK 2>/dev/null || echo 100)"

sample_cpu() { # duration_s -> total cpu% (one decimal)
  local dur=$1 pids before after t0 t1 j0 j1 total
  pids="$(app_pids | sort -u)"
  [ -n "$pids" ] || { echo 0.0; return 0; }

  j0=0
  for p in $pids; do j0=$(( j0 + $(proc_jiffies "$p" 2>/dev/null || echo 0) )); done
  t0=$(date +%s%N)
  sleep "$dur"
  t1=$(date +%s%N)

  j1=0
  pids="$(app_pids | sort -u)"
  for p in $pids; do j1=$(( j1 + $(proc_jiffies "$p" 2>/dev/null || echo 0) )); done

  total=0
  elapsed_ns=$(( t1 - t0 ))
  [ "$elapsed_ns" -gt 0 ] || { echo 0.0; return 0; }
  # %cpu = delta_jiffies / CLK_TCK / elapsed_seconds * 100
  awk -v dj="$(( j1 - j0 ))" -v hz="$CLK_TCK" -v ns="$elapsed_ns" \
      'BEGIN { printf "%.1f\n", (dj / hz) / (ns / 1000000000) * 100 }'
}

sample_rss() { # -> total RSS in MB (one decimal)
  local pids total=0
  pids="$(app_pids | sort -u)"
  for p in $pids; do
    total=$(( total + $(proc_rss_kb "$p" 2>/dev/null || echo 0) ))
  done
  awk -v kb="$total" 'BEGIN { printf "%.1f\n", kb / 1024 }'
}

# ---- header ------------------------------------------------------------------
echo "=================================================================="
echo " WhatsApp for Linux — resource baseline (M9, measurement only)"
if [ "$MODE" = "app" ]; then
  echo " app     : $APP_BIN"
else
  echo " app     : dev build ($ELECTRON_BIN .)"
fi
echo " state   : $([ "$START_MINIMIZED" -eq 1 ] && echo 'hidden to tray (start minimized)' || echo 'window visible')"
echo " settle  : ${SETTLE}s after usable   sample: ${SAMPLE}s   timeout: ${TIMEOUT}s"
echo " display : ${DISPLAY:-none} / wayland=${WAYLAND_DISPLAY:-none}"
echo "=================================================================="

CMD=("${APP_CMD[@]}")
[ "$START_MINIMIZED" -eq 1 ] && CMD+=("--start-minimized")

( cd "$REPO_ROOT" && exec "${CMD[@]}" "--$MARKER" >"$LOG" 2>&1 ) &

if ! wait_usable; then
  echo "error: app did not reach 'first meaningful UI ready' in ${TIMEOUT}s." >&2
  echo "raw log ($LOG), last 20 lines:" >&2
  sed 's/^/  | /' "$LOG" | tail -n 20 >&2
  stop_app
  exit 2
fi

echo "app usable; settling ${SETTLE}s to reach idle..."
sleep "$SETTLE"

PIDS="$(app_pids | sort -u | tr '\n' ' ')"
[ -n "$PIDS" ] || { echo "error: app exited during settle" >&2; exit 2; }
echo "processes: $PIDS"
echo ""
echo "sampling for ${SAMPLE}s..."
CPU="$(sample_cpu "$SAMPLE")"
RSS="$(sample_rss)"

echo ""
echo "=================================================================="
printf ' idle RAM  : %8s MB   (whole Electron process tree)\n' "$RSS"
printf ' idle CPU  : %8s %%   (average over %ss)\n' "$CPU" "$SAMPLE"
if [ "$START_MINIMIZED" -eq 1 ]; then
  echo " state     : tray-hidden (window hidden via --start-minimized)"
else
  echo " state     : window visible"
fi
echo "=================================================================="

stop_app
exit 0
