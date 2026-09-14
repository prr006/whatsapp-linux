#!/usr/bin/env bash
# M14 — on-device verification matrix: deterministic WhatsApp banners on
# GNOME (target: Ubuntu 25.10 / GNOME Shell 50.1, Wayland).
#
# The automated scenarios send notifications through the SAME D-Bus path
# the app uses (org.freedesktop.Notifications.Notify with the
# desktop-entry=whatsapp-linux hint that Electron/libnotify sets), and
# collect the extension's [m14] journal lines, which carry exact
# show/hide timestamps and the history-retention flag.
#
# The GOLD STANDARD is scenario A (a real chat message through the app);
# it is manual because it needs a real conversation.
#
# Usage: scripts/verify-m14.sh [--skip-interactive]
#   Run it on the target machine with GNOME running. A results table is
#   printed at the end; compare observed journal deltas against the
#   expected values (single: ~5.0-5.3 s; burst: slots of ~5.2 s).
#
# Preconditions:
#   - the packaged app was launched at least once (it auto-installs and
#     enables the extension), or:  scripts/install-gnome-extension.sh
#   - journal access: journalctl --user must show gnome-shell output.
set -uo pipefail

UUID="whatsapp-deterministic-banner@prr006"
WA_APP_NAME="WhatsApp for Linux"
SUFFIX=".m14"

log() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }

# --------------------------------------------------------------------------
# journal helpers: [m14] lines from the shell log after a given epoch
# --------------------------------------------------------------------------
journal_lines() { # $1 = epoch seconds
  local out
  out=$(journalctl --user --no-pager -o short-precise --since "@$1" 2>/dev/null | grep -F '[m14]')
  if [[ -z "$out" ]]; then
    # Some configurations log the shell to the system journal.
    out=$(journalctl --no-pager -o short-precise --since "@$1" 2>/dev/null | grep -F '[m14]')
  fi
  printf '%s' "$out"
}

line_time() { # "YYYY-MM-DD HH:MM:SS.uuuuuu host ..." -> epoch float
  local f1 f2 raw
  f1=$(awk '{print $1}' <<<"$1")
  f2=$(awk '{print $2}' <<<"$1")
  raw=$(date -d "$f1 $f2" +%s.%N 2>/dev/null)
  [[ -n "$raw" ]] && awk "BEGIN{printf \"%.3f\", $raw/1000000}"
}

age_s() { # epoch float, epoch int -> "N.NN"
  awk "BEGIN{printf \"%.2f\", $1-$2}"
}

# --------------------------------------------------------------------------
# notification senders (same path as Electron/libnotify)
# --------------------------------------------------------------------------
send_wa() { # $1 title, $2 body
  gdbus call --session \
    --dest org.freedesktop.Notifications \
    --object-path /org/freedesktop/Notifications \
    --method org.freedesktop.Notifications.Notify \
    "$WA_APP_NAME" 0 "" "$1" "$2" "[]" \
    '{ "desktop-entry": "<s>whatsapp-linux" }' -1
}

send_control() { # out-of-scope control (stock behavior expected)
  notify-send -a "m14-control$SUFFIX" "M14 control" "This banner is NOT governed (stock ~4.2 s)"
}

RESULTS=()
record() { RESULTS+=("$*"); }

# --------------------------------------------------------------------------
# preconditions
# --------------------------------------------------------------------------
log "Preconditions"
if [[ -z "$(command -v gnome-shell 2>/dev/null)" ]] && ! pgrep -x gnome-shell >/dev/null 2>&1; then
  echo "ERROR: GNOME Shell does not appear to be running." >&2
  exit 1
fi
if ! command -v gdbus >/dev/null 2>&1; then
  echo "ERROR: gdbus not found (install libglib2.0-0-bin / gdbus)." >&2
  exit 1
fi

EXT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
if [[ ! -f "$EXT_DIR/extension.js" ]]; then
  echo "WARNING: extension not installed at $EXT_DIR" >&2
  echo "         run: scripts/install-gnome-extension.sh  (or launch the app once)" >&2
else
  echo "extension installed: $EXT_DIR"
fi
if command -v gnome-extensions >/dev/null 2>&1; then
  echo "extension state: $(gnome-extensions info "$UUID" 2>/dev/null | head -2 | tr '\n' ' | ')"
fi

PROBE_T0=$(date +%s)
echo "probing journal [m14] lines (sending a probe notification)..."
send_wa "M14 probe" "probe — you should see a ~5 s banner"
sleep 7
PROBE_LINES=$(journal_lines "$PROBE_T0")
if [[ "$PROBE_LINES" != *"[m14]"* ]]; then
  echo "WARNING: no [m14] journal lines found. The extension may not be" >&2
  echo "         loaded (check 'gnome-extensions info $UUID', shell log" >&2
  echo "         filter: journalctl --user | grep m14)." >&2
fi
PROBE_HIDE=$(printf '%s\n' "$PROBE_LINES" | grep -F 'banner hidden' | tail -1)
PROBE_EST=$(printf '%s\n' "$PROBE_LINES" | grep -F 'banner timer established' | tail -1)
if [[ -n "$PROBE_HIDE" && -n "$PROBE_EST" ]]; then
  PE=$(line_time "$PROBE_EST"); PH=$(line_time "$PROBE_HIDE")
  D=$(age_s "$PH" "$PE")
  echo "probe banner lifetime: ${D} s (expect ~5.0-5.3 s)"
  record "PROBE    banner shown->hidden ${D} s   expect ~5.0-5.3 s, history: retained"
else
  record "PROBE    (no governor lines captured — see warning)"
fi

# --------------------------------------------------------------------------
# B: single WhatsApp-identity notification, ACTIVE desktop
# --------------------------------------------------------------------------
log "B: single notification (active desktop — keep using the machine)"
T=$(date +%s)
send_wa "M14 single" "one governed banner, expect ~5 s"
sleep 8
L=$(journal_lines "$T")
EST=$(printf '%s\n' "$L" | grep -F 'banner timer established' | tail -1)
HID=$(printf '%s\n' "$L" | grep -F 'banner hidden' | tail -1)
if [[ -n "$EST" && -n "$HID" ]]; then
  D=$(age_s "$(line_time "$HID")" "$(line_time "$EST")")
  record "B single  shown->hidden ${D} s   expect ~5.0-5.3 s, history: retained"
  [[ "$HID" == *'standard-expiry'* && "$HID" == *'retained'* ]] || record "B (!) unexpected hide line: $HID"
else
  record "B single  (no lines — check extension state)"
fi

# --------------------------------------------------------------------------
# D: rapid burst of 3 (expect three ~5.2 s slots back-to-back)
# --------------------------------------------------------------------------
log "D: rapid burst of 3 (expect 3 banners, slots of ~5.2 s each)"
T=$(date +%s)
send_wa "M14 burst 1/3" "burst"
send_wa "M14 burst 2/3" "burst"
send_wa "M14 burst 3/3" "burst"
sleep 19
L=$(journal_lines "$T")
HIDES=$(printf '%s\n' "$L" | grep -F 'banner hidden')
N=$(printf '%s\n' "$HIDES" | grep -c 'banner hidden' || true)
FIRST=$(printf '%s\n' "$HIDES" | head -1)
LAST=$(printf '%s\n' "$HIDES" | tail -1)
if [[ -n "$FIRST" && -n "$LAST" ]]; then
  D1=$(age_s "$(line_time "$FIRST")" "$T")
  D3=$(age_s "$(line_time "$LAST")" "$T")
  record "D burst   ${N}/3 banners hidden: first ${D1} s, last ${D3} s after send (expect ~5.2 / ~10.4 / ~15.6 s)"
else
  record "D burst   (no lines)"
fi
echo "burst hides captured:"; printf '%s\n' "$HIDES" | sed 's/^/    /'

# --------------------------------------------------------------------------
# E: idle (do NOT touch keyboard/mouse for 10 s after send)
# --------------------------------------------------------------------------
log "E: idle desktop (DO NOT touch keyboard/mouse for the next ~10 s)"
T=$(date +%s)
send_wa "M14 idle" "desktop idle — banner must STILL expire at ~5 s"
sleep 10
L=$(journal_lines "$T")
HID=$(printf '%s\n' "$L" | grep -F 'banner hidden' | tail -1)
if [[ -n "$HID" ]]; then
  t1=$(line_time "$HID")
  if [[ -n "$t1" ]]; then
    D=$(awk "BEGIN{printf \"%.2f\", $t1-$T}")
    record "E idle    hidden ${D} s after send   expect ~5.0-5.5 s (stock would NEVER expire while idle)"
  else
    record "E idle    hidden (could not parse journal time)"
  fi
else
  record "E idle    (still visible? stock bug — re-run and stay idle)"
fi

# --------------------------------------------------------------------------
# F: active with pointer motion toward the banner (must not extend)
# --------------------------------------------------------------------------
log "F: pointer drift toward the banner (must NOT extend past ~5 s)"
T=$(date +%s)
send_wa "M14 pointer" "drift the mouse slowly downward for 8 s"
MOUSE_PID=""
if command -v xdotool >/dev/null 2>&1 && [[ -n "${DISPLAY:-}" ]]; then
  ( for i in $(seq 1 16); do xdotool mousemove --sync 640 $((400 + i * 12)) >/dev/null 2>&1; sleep 0.5; done ) &
  MOUSE_PID=$!
fi
sleep 8
[[ -n "$MOUSE_PID" ]] && kill "$MOUSE_PID" 2>/dev/null
L=$(journal_lines "$T")
HID=$(printf '%s\n' "$L" | grep -F 'banner hidden' | tail -1)
if [[ -n "$HID" ]]; then
  t1=$(line_time "$HID")
  if [[ -n "$t1" ]]; then
    D=$(awk "BEGIN{printf \"%.2f\", $t1-$T}")
    record "F pointer hidden ${D} s after send   expect ~5.0-5.8 s (stock adds ~1 s per pointer check)"
  else
    record "F pointer hidden (could not parse journal time)"
  fi
else
  record "F pointer (no hide line captured)"
fi

# --------------------------------------------------------------------------
# A: gold standard — real chat message through the app (manual)
# --------------------------------------------------------------------------
log "A: GOLD STANDARD (manual)"
cat <<'EOF'
In the running WhatsApp for Linux app, ask a contact (or yourself) to send
one message now, then:
  1. watch the banner: it should disappear at ~5 s,
  2. open the notification list: the entry must still be there,
  3. click the entry: WhatsApp focuses, the entry is removed (and only it),
  4. check:  journalctl --user --since "2 min ago" | grep '\[m14\]'
     expected lines (in order):
       [m14] banner timer established — fixed deadline in 5000 ms ...
       [m14] banner hidden — path: standard-expiry, history: retained ...
EOF

# --------------------------------------------------------------------------
# control: an out-of-scope app must keep STOCK ~4.2 s (no [m14] lines)
# --------------------------------------------------------------------------
log "Control: out-of-scope notification (stock ~4.2 s expected, NO [m14] lines)"
T=$(date +%s)
send_control
sleep 7
L=$(journal_lines "$T")
if [[ -z "$L" ]]; then
  record "CONTROL   no [m14] lines (correct — out-of-scope banner untouched by governor)"
else
  record "CONTROL   (!) unexpected [m14] lines: $L"
fi

# --------------------------------------------------------------------------
# summary
# --------------------------------------------------------------------------
log "Results (fill the last column with your visual observation)"
printf '%-60s %s\n' "scenario / evidence" "expectation"
for r in "${RESULTS[@]}"; do
  printf '%s\n' "$r"
done
cat <<'EOF'

Also verify manually (notification list, top-right):
  [ ] after each natural expiry, the entry remains in the list
  [ ] clicking an entry removes only that entry and focuses WhatsApp
  [ ] the app icon's unread badge / conversation unread state is unchanged
  [ ] a second app's notifications (e.g. your browser) behave exactly as
      stock GNOME (no governor lines for them)
EOF
