#!/usr/bin/env bash
#
# M8: cold-start measurement harness for WhatsApp for Linux.
#
# Launches the app (dev build or packaged binary) with a unique marker in its
# argv, captures stdout — where src/main.js logs its [perf] startup lines —
# waits for "first meaningful WhatsApp UI ready", then reports:
#   - a timeline of the 9 measured startup points (from process spawn)
#   - key metrics: bootstrap, tray visible, window visible, page loaded,
#     usable — compared against the < 3 s cold-start goal (TARGET_MS)
#
# Measured points (src/main.js):
#   main process started, app ready, BrowserWindow created, loadURL start,
#   dom-ready, ready-to-show, tray created, did-finish-load,
#   first meaningful WhatsApp UI ready (chat-list | qr-code)
#
# "Cold start" = no other instance running + a fresh process. The persistent
# login session is preserved (it is part of the real-world scenario); use
# --clear-cache to additionally drop the Chromium HTTP cache for a worst-case
# run (cookies / IndexedDB — i.e. the login — are never touched).
#
# Notes:
#   - Offsets in the [perf] lines are relative to main.js module load, so the
#     reported "from process spawn" times add the bootstrap offset (the
#     +ms of the first line) on top. This is an estimate accurate to a few ms.
#   - If another instance is running, the app's single-instance lock makes the
#     fresh process exit immediately; the harness detects that as an early
#     exit and tells you.
#
# Usage:
#   scripts/measure-startup.sh [options]
#
# Options:
#   --app PATH     packaged binary to measure (AppImage or installed binary)
#   --dev          measure the repo dev build (electron .) — default when
#                  --app is not given
#   --runs N       repeat N times, fully quitting the app between runs (1)
#   --clear-cache  delete the Chromium HTTP cache before each run
#   --kill         terminate a possibly-running instance first (default: abort)
#   --timeout S    seconds to wait for the app to become usable (90)
#   --user-data D  Electron userData dir (~/.config/whatsapp-linux)
#   -h, --help     show this help
#
# Exit codes: 0 = at least one run measured "usable", 1 = usage error,
#             2 = no run reached "usable".

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---- defaults / flags --------------------------------------------------------
APP_BIN=""
MODE="dev"
RUNS=1
CLEAR_CACHE=0
KILL_EXISTING=0
TIMEOUT=90
USER_DATA="${XDG_CONFIG_HOME:-$HOME/.config}/whatsapp-linux"
TARGET_MS=3000   # M8 goal: cold start usable in under 3 s

usage() {
  sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app)        APP_BIN="${2:?--app needs a path}"; MODE="app"; shift 2 ;;
    --dev)        MODE="dev"; shift ;;
    --runs)       RUNS="${2:?--runs needs a number}"; shift 2 ;;
    --clear-cache) CLEAR_CACHE=1; shift ;;
    --kill)       KILL_EXISTING=1; shift ;;
    --timeout)    TIMEOUT="${2:?--timeout needs a number}"; shift 2 ;;
    --user-data)  USER_DATA="${2:?--user-data needs a path}"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "error: unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
done

case "$RUNS" in ''|*[!0-9]*) echo "error: --runs must be a positive integer" >&2; exit 1 ;; esac
case "$TIMEOUT" in ''|*[!0-9]*) echo "error: --timeout must be a positive integer" >&2; exit 1 ;; esac
[ "$RUNS" -ge 1 ] || { echo "error: --runs must be >= 1" >&2; exit 1; }
[ "$TIMEOUT" -ge 1 ] || { echo "error: --timeout must be >= 1" >&2; exit 1; }

# ---- resolve the app command -------------------------------------------------
# Escape a string for use as an ERE (pgrep -f) — binary paths may contain
# dots/parens.
ere_escape() { printf '%s' "$1" | sed -e 's/[][\.*^$/(){}+?|\\]/\\&/g'; }

APP_CMD=()
INSTANCE_PATTERNS=()   # anchored EREs identifying a real running instance
if [ "$MODE" = "app" ]; then
  [ -x "$APP_BIN" ] || { echo "error: app binary not found or not executable: $APP_BIN" >&2; exit 1; }
  APP_CMD=("$APP_BIN")
  BIN_ABS="$(readlink -f "$APP_BIN")"
  INSTANCE_PATTERNS=("^$(ere_escape "$BIN_ABS")( |$)")
  if [ "$APP_BIN" != "$BIN_ABS" ]; then
    INSTANCE_PATTERNS+=("^$(ere_escape "$APP_BIN")( |$)")
  fi
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

HAVE_PGREP=0
command -v pgrep >/dev/null 2>&1 && HAVE_PGREP=1

# PIDs of OUR launched app (unique marker in argv).
# NOTE: the $$ (PID) and the $(...) substitution must not be adjacent, or bash
# parses "$$(" as the PID and leaves the rest literal.
RUN_ID="wsm-$$-$(date +%s%N)"
MARKER="measure-startup-run=$RUN_ID"
APP_PID=""

app_pids() {
  if [ "$HAVE_PGREP" -eq 1 ]; then
    { pgrep -f "$MARKER" 2>/dev/null || true; } | grep -vx "$$" || true
  else
    if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then echo "$APP_PID"; fi
  fi
}

# PIDs of a PRE-EXISTING instance. Patterns are anchored on the full binary
# path, so this script's own argv (which merely contains the path as an
# option value) can never self-match.
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
    kill_wait=0
    while [ "$kill_wait" -lt 10 ] && [ -n "$(instance_pids)" ]; do
      sleep 0.5
      kill_wait=$((kill_wait + 1))
    done
  else
    echo "error: a possibly-running instance was detected (pids: $EXISTING)." >&2
    echo "       Quit it, or re-run with --kill to let the harness terminate it." >&2
    exit 1
  fi
fi

PARTITION_DIR="$USER_DATA/Partitions/whatsapp-linux"
clear_http_cache() {
  if [ -d "$PARTITION_DIR" ]; then
    rm -rf "$PARTITION_DIR/Cache" "$PARTITION_DIR/Code Cache"
    echo "cleared Chromium HTTP cache: $PARTITION_DIR/{Cache,Code Cache}"
  else
    echo "note: $PARTITION_DIR not found yet — first run builds a fresh cache"
  fi
}

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wa-startup-XXXXXX")"
trap 'echo "raw logs kept in: $TMP_DIR" >&2' EXIT

stop_app() {
  [ -n "$APP_PID" ] || return 0
  pkill -TERM -f "$MARKER" 2>/dev/null || true
  [ -n "$APP_PID" ] && kill -TERM "$APP_PID" 2>/dev/null || true
  local i
  for i in $(seq 1 20); do
    [ -z "$(app_pids)" ] && return 0
    sleep 0.5
  done
  echo "warning: app did not exit on SIGTERM, sending SIGKILL" >&2
  pkill -KILL -f "$MARKER" 2>/dev/null || true
  [ -n "$APP_PID" ] && kill -KILL "$APP_PID" 2>/dev/null || true
  sleep 0.5
}

wait_usable() {
  local log=$1
  local deadline=$(( $(date +%s) + TIMEOUT ))
  while true; do
    if grep -qF 'first meaningful UI ready' "$log"; then return 0; fi
    if [ -z "$(app_pids)" ]; then return 1; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then return 1; fi
    sleep 0.3
  done
}

# Emits "offset_ms<TAB>label" for each [perf] line in the log
# (line format: "[perf] <label>  (+<ms>ms)").
perf_rows() {
  sed -n -E 's/^\[perf\] (.*[^ ]) +\(\+([0-9]+)ms\)[[:space:]]*$/\2\t\1/p' "$1"
}

# Cold start is about the FIRST occurrence of each point (a later reload may
# repeat some events), so metrics take the first match.
metric_exact() {  # $1 rows, $2 exact label
  awk -F'\t' -v l="$2" '$2 == l { print $1; exit }' <<<"$1"
}
metric_prefix() { # $1 rows, $2 label prefix
  awk -F'\t' -v p="$2" 'index($2, p) == 1 { print $1; exit }' <<<"$1"
}

# ---- header ------------------------------------------------------------------
echo "=================================================================="
echo " WhatsApp for Linux — cold-start measurement (M8)"
if [ "$MODE" = "app" ]; then
  echo " app     : $APP_BIN"
else
  echo " app     : dev build ($ELECTRON_BIN .)"
fi
echo " runs    : $RUNS   timeout: ${TIMEOUT}s   goal: usable < ${TARGET_MS}ms"
echo " cache   : $([ "$CLEAR_CACHE" -eq 1 ] && echo 'cleared before each run' || echo 'as-is (login session preserved)')"
echo " display : ${DISPLAY:-none} / wayland=${WAYLAND_DISPLAY:-none}"
echo "=================================================================="

USABLE_MS_LIST=""
OK_RUNS=0

for run_no in $(seq 1 "$RUNS"); do
  LOG="$TMP_DIR/run-$run_no.log"
  echo ""
  echo "──────── run $run_no/$RUNS ────────"
  if [ "$CLEAR_CACHE" -eq 1 ]; then clear_http_cache; fi

  T0=$(date +%s%3N)
  ( cd "$REPO_ROOT" && exec "${APP_CMD[@]}" "--$MARKER" >"$LOG" 2>&1 ) &
  APP_PID=$!

  USABLE=0
  if wait_usable "$LOG"; then USABLE=1; fi
  # M8 measurement fix: STOPPED_AT used to be stamped here — before the app
  # was actually stopped — so "wall clock to stop" really measured "time to
  # usable-line/early-exit/timeout". Keep that instant under its true name and
  # stamp the stop time only after stop_app returns.
  DETECTED_AT=$(date +%s%3N)

  stop_app
  APP_PID=""
  STOPPED_AT=$(date +%s%3N)

  ROWS="$(perf_rows "$LOG")"
  if [ -z "$ROWS" ]; then
    echo "  no [perf] lines found — the app may have exited early."
    echo "  (a pre-existing instance intercepts the launch via the single-instance"
    echo "   lock, or the app failed to start — check display/permissions)."
    echo "  raw log ($LOG), last 20 lines:"
    sed 's/^/    | /' "$LOG" | tail -n 20
    continue
  fi

  BOOT="$(head -n1 <<<"$ROWS" | cut -f1)"
  echo "  timeline (estimated, from process spawn @ $T0):"
  while IFS=$'\t' read -r off label; do
    printf '    %7dms  %s\n' $((BOOT + off)) "$label"
  done <<<"$ROWS"

  TRAY="$(metric_exact "$ROWS" 'tray created')"
  SHOWN="$(metric_exact "$ROWS" 'ready-to-show')"
  LOADED="$(metric_prefix "$ROWS" 'did-finish-load')"
  USABLE_OFF="$(metric_prefix "$ROWS" 'first meaningful UI ready')"

  echo "  key metrics (from process spawn):"
  printf '    electron/node bootstrap : %7dms\n' "$BOOT"
  if [ -n "$TRAY" ];   then printf '    tray visible            : %7dms\n' $((BOOT + TRAY)); fi
  if [ -n "$SHOWN" ];  then printf '    window visible          : %7dms\n' $((BOOT + SHOWN)); fi
  if [ -n "$LOADED" ]; then printf '    page loaded             : %7dms\n' $((BOOT + LOADED)); fi
  if [ -n "$USABLE_OFF" ]; then
    U=$((BOOT + USABLE_OFF))
    if [ "$U" -lt "$TARGET_MS" ]; then
      printf '    USABLE (first UI ready) : %7dms   target < %dms  -> WITHIN TARGET\n' "$U" "$TARGET_MS"
    else
      printf '    USABLE (first UI ready) : %7dms   target < %dms  -> OVER TARGET by %dms\n' "$U" "$TARGET_MS" $((U - TARGET_MS))
    fi
    USABLE_MS_LIST="$USABLE_MS_LIST $U"
    OK_RUNS=$((OK_RUNS + 1))
  else
    printf '    USABLE (first UI ready) : NOT REACHED in %ss\n' "$TIMEOUT"
  fi
  printf '    (wall clock to detection : %7dms)\n' $((DETECTED_AT - T0))
  printf '    (wall clock to stop      : %7dms)\n' $((STOPPED_AT - T0))
done

echo ""
echo "=================================================================="
if [ "$OK_RUNS" -ge 1 ]; then
  USABLE_SORTED="$(printf '%s\n' $USABLE_MS_LIST | sort -n | tr '\n' ' ')"
  MIN_U="$(printf '%s\n' $USABLE_MS_LIST | sort -n | head -n1)"
  SUM_U=0
  for u in $USABLE_MS_LIST; do SUM_U=$((SUM_U + u)); done
  AVG_U=$((SUM_U / OK_RUNS))
  echo " usable runs: $OK_RUNS/$RUNS   min: ${MIN_U}ms   avg: ${AVG_U}ms"
  echo " values: $USABLE_SORTED"
  if [ "$MIN_U" -lt "$TARGET_MS" ]; then
    echo " verdict: BEST RUN WITHIN the ${TARGET_MS}ms cold-start goal."
  else
    echo " verdict: BEST RUN OVER the ${TARGET_MS}ms cold-start goal by $((MIN_U - TARGET_MS))ms."
  fi
  echo "=================================================================="
  exit 0
else
  echo " no run reached 'first meaningful UI ready' — see logs in $TMP_DIR"
  echo "=================================================================="
  exit 2
fi
