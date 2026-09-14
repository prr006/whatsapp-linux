/**
 * M14 — Deterministic banner policy for the WhatsApp for Linux GNOME Shell
 * extension (pure logic, no GJS/GI imports — unit-testable under Node).
 *
 * Background (verified against the GNOME Shell 50.1 sources, tag 50.1 of
 * GNOME/gnome-shell — see README "M14" for the full citation):
 *
 *   - js/ui/notificationDaemon.js:136 — NotifyAsync destructures the
 *     client-supplied expire_timeout into `timeout_` and never reads it.
 *     No daemon-side control of banner lifetime exists.
 *   - js/ui/messageTray.js — the banner's lifetime is entirely the shell's
 *     own policy:
 *       line 19   NOTIFICATION_TIMEOUT = 4000 (stock; GNOME's own value)
 *       line 1122 _showNotification() records
 *                 _userActiveWhileNotificationShown = (idletime <= 1000 ms)
 *       line 1086 the banner only expires when
 *                 (_userActiveWhileNotificationShown && state === SHOWN &&
 *                  _notificationTimeoutId === 0 && urgency !== CRITICAL &&
 *                  !_pointerInNotification) || _notificationExpired
 *     i.e. an idle desktop, a pointer drift toward the banner (line 1230
 *     re-arms +1000 ms), or a hover (line 1095 keeps it up) all move the
 *     expiry away from the nominal 4 s. That is the root cause of the
 *     non-deterministic banner lifetime observed in M10/M13.
 *
 * The governor does NOT hide banners itself and NEVER destroys or closes
 * notifications: it only (a) marks the banner as "user active" so the
 * shell's own expiry path is not gated by the idle monitor, and (b)
 * redirects every timer arm the shell requests for the governed banner to
 * the SAME fixed deadline. All hide decisions then happen through the
 * shell's standard expiry path (messageTray.js `_updateState` ->
 * `_hideNotification` -> `_hideNotificationCompleted`), which for
 * non-transient notifications:
 *   - leaves the notification in `source.notifications` (history),
 *   - emits NO 'destroy' signal -> the daemon emits NO
 *     NotificationClosed (verified in notificationDaemon.js: the signal is
 *     emitted exclusively from the notification's 'destroy' handler).
 */

// Target banner lifetime, measured from the moment the shell arms the
// banner's first timeout (i.e. when the banner has finished its 200 ms
// show-in animation and is fully visible).
export const BANNER_TIMEOUT_MS = 5000;

// The desktop application id (`.desktop` file name without suffix) whose
// notifications are governed. GNOME resolves the `desktop-entry` hint (set
// by Electron/libnotify from CHROME_DESKTOP) to a Shell.App; the governor
// matches on that app id and leaves every other application completely
// untouched.
export const MATCHED_APP_IDS = Object.freeze(['whatsapp-linux']);

/**
 * Best-effort read of the source's resolved application id.
 * FdoNotificationDaemonSource.app is a Shell.App or null (null when the
 * desktop entry could not be resolved, e.g. dev runs without the .desktop
 * installed).
 */
export function sourceAppId(source) {
  try {
    return source && source.app && typeof source.app.get_id === 'function'
      ? source.app.get_id()
      : null;
  } catch (e) {
    return null;
  }
}

/**
 * Scoping decision: true only for notifications whose source is the
 * WhatsApp for Linux desktop application. Everything else must keep stock
 * GNOME behavior (requirement: do not globally break notification
 * behaviour for every application).
 */
export function isScopedSource(source) {
  const id = sourceAppId(source);
  return id !== null && MATCHED_APP_IDS.includes(id);
}

/**
 * The single governor decision, for one `_updateNotificationTimeout(t)`
 * call observed on the message tray.
 *
 * @param {object} args
 * @param {boolean} args.inScope      the active banner belongs to a matched app
 * @param {number}  args.requestedMs  the timeout the shell asked to arm (ms;
 *                                    0 means "clear the timer")
 * @param {number|undefined} args.deadlineMs  the banner's fixed deadline
 *                                    (epoch ms) once it was established
 * @param {number}  args.nowMs        current time (epoch ms)
 * @returns {{kind: 'passthrough', ms: number} |
 *           {kind: 'establish', ms: number, deadlineMs: number} |
 *           {kind: 'converge', ms: number} |
 *           {kind: 'expire-now'}}
 *
 * Kinds:
 *   passthrough — the governor does not interfere (out-of-scope banner, or
 *                 the shell is clearing its timer; clearing must always be
 *                 honoured or the shell's own bookkeeping desyncs).
 *   establish   — first positive arm of a governed banner (the shell's
 *                 NOTIFICATION_TIMEOUT arm at show completion): the
 *                 deadline is born `now + BANNER_TIMEOUT_MS`.
 *   converge    — a later arm (idle-active re-arm, pointer re-arm, hover
 *                 refresh, in-place update): instead of a fresh
 *                 `requestedMs` timer, arm `deadline - now` so EVERY arm
 *                 fires at the same instant. This is what makes the expiry
 *                 deterministic: stock GNOME re-arms a *fresh* interval on
 *                 every interaction, which is why banners linger on idle
 *                 desktops, under a drifting pointer, or in bursts.
 *   expire-now  — the deadline has been reached (a re-arm raced it): clear
 *                 the timer and let the shell expire the banner through its
 *                 standard path right now.
 */
export function governorDecision({ inScope, requestedMs, deadlineMs, nowMs }) {
  if (!inScope) return { kind: 'passthrough', ms: requestedMs };
  if (requestedMs <= 0) return { kind: 'passthrough', ms: 0 };
  if (deadlineMs === undefined || deadlineMs === null) {
    const deadline = nowMs + BANNER_TIMEOUT_MS;
    return { kind: 'establish', ms: deadline - nowMs, deadlineMs: deadline };
  }
  const remaining = deadlineMs - nowMs;
  if (remaining <= 0) return { kind: 'expire-now' };
  return { kind: 'converge', ms: remaining };
}

/**
 * Pure deterministic-lifetime simulation of the governor's arm
 * bookkeeping. Used by the Node tests to prove the convergence property
 * ("no interaction sequence can push the expiry past the deadline")
 * without a shell runtime.
 *
 * @param {object} args
 * @param {boolean} args.inScope
 * @param {number}  args.nowMs
 * @param {Array<{atMs: number, requestedMs: number}>} args.arms
 * @returns {{deadlineMs: number|null, fires: Array<{atMs: number, ms: number}|null>,
 *            expired: boolean|null}}
 */
export function simulateArms({ inScope, nowMs, arms }) {
  let deadlineMs = null;
  let now = nowMs;
  const fires = [];
  for (const arm of arms) {
    now = Math.max(now, arm.atMs);
    const decision = governorDecision({
      inScope,
      requestedMs: arm.requestedMs,
      deadlineMs,
      nowMs: now
    });
    if (decision.kind === 'establish') {
      deadlineMs = decision.deadlineMs;
      fires.push({ atMs: now + decision.ms, ms: decision.ms });
    } else if (decision.kind === 'converge') {
      fires.push({ atMs: now + decision.ms, ms: decision.ms });
    } else if (decision.kind === 'expire-now') {
      return { deadlineMs, fires, expired: true };
    } else {
      fires.push(null); // passthrough: whatever the shell does
    }
  }
  return { deadlineMs, fires, expired: false };
}
