/**
 * M14 — Deterministic banner governor for WhatsApp for Linux.
 *
 * GNOME Shell extension (target: GNOME 49/50, verified against the 50.1
 * sources) that makes the GNOME notification banner for THIS app only
 * disappear after a fixed ~5 s, regardless of:
 *   - idle desktop (stock: banner never expires while idle),
 *   - pointer movement toward the banner (stock: re-arms +1 s per check),
 *   - notification queue position / bursts (stock: one banner per
 *     stock timeout, each independently gated by the above),
 * while the notification itself REMAINS in the GNOME notification list
 * (history) and keeps full click semantics.
 *
 * HOW IT WORKS (see policy.js for the cited 50.1 source lines):
 *   1. `_showNotification` (the single choke point where a queued
 *      notification becomes the active banner) is wrapped: for banners
 *      whose source is the matched app the tray's
 *      `_userActiveWhileNotificationShown` flag is set, so the shell's own
 *      expiry check is no longer gated by the idle monitor.
 *   2. `_updateNotificationTimeout` (the single choke point where the
 *      banner timer is armed/re-armed — called from show completion, the
 *      idle->active watch, the pointer-toward check, the hover refresh and
 *      the "pointer left" timeout) is wrapped: for the governed banner,
 *      the first positive arm establishes a fixed deadline
 *      (now + BANNER_TIMEOUT_MS) and every later arm is redirected to
 *      `deadline - now`, so no interaction can move the expiry. When a
 *      re-arm arrives after the deadline, the timer is cleared and the
 *      shell's standard expiry path is triggered.
 *   3. `_hideNotificationCompleted` (the single completion point of a
 *      banner hide) is wrapped for LOGGING ONLY — one line per governed
 *      banner hide (reason + history-retention status + age) so the
 *      banner lifetime is measurable in the journal
 *      (scripts/verify-m14.sh). It also drops the governor's WeakMap
 *      entry eagerly. It changes no behavior.
 *
 * What this extension deliberately does NOT do (history-safety):
 *   - it never destroys or closes a notification,
 *   - it never sends or triggers any D-Bus close traffic of its own,
 *   - it never touches queue order, history eviction or urgency,
 *   - it never changes behaviour for any other application (scoping via
 *     the notification source's resolved desktop app id).
 * The banner is hidden exclusively through the shell's own expiry path,
 * which for non-transient notifications keeps the notification in history
 * and stays silent on the D-Bus close signal (messageTray.js
 * `_hideNotificationCompleted` destroys only `isTransient` notifications;
 * notificationDaemon.js emits the close signal only on `destroy`).
 *
 * Mechanism note: the overrides use the shell's own `InjectionManager`
 * (js/extensions/extension.js), the supported extension API for method
 * replacement with automatic restore on disable — no ad-hoc monkey
 * patching. The same two choke points are used by the widely installed
 * "Notification Timeout" extension (targets GNOME 49/50), which confirms
 * they are stable, production-used internals; this governor only differs
 * in that it is scoped to one app and converges on a fixed deadline
 * instead of re-arming a fresh interval on every interaction.
 */

import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import { Extension, InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    BANNER_TIMEOUT_MS,
    governorDecision,
    isScopedSource,
    sourceAppId,
} from './policy.js';

function nowMs() {
    return Date.now();
}

export default class WhatsAppDeterministicBannerExtension extends Extension {
    enable() {
        // deadline (epoch ms) per currently-governed banner. WeakMap: when
        // the shell drops a notification from history the governor's only
        // reference disappears with it (no retention, no leaks).
        this._deadlines = new WeakMap();
        this._injection = new InjectionManager();
        const proto = MessageTray.MessageTray.prototype;
        const ext = this;

        this._injection.overrideMethod(proto, '_showNotification', (original) =>
            function () {
                original.call(this);
                const notification = this._notification;
                if (!notification || !isScopedSource(notification.source))
                    return;
                // Deterministic expiry must not be gated by the idle
                // monitor (messageTray.js:1122 / :1086). Setting the flag
                // mirrors what the shell itself does when the user is
                // active; it changes nothing else (the flag has no other
                // reader in 50.1).
                if (!this._userActiveWhileNotificationShown) {
                    this._userActiveWhileNotificationShown = true;
                    ext._log('banner shown while idle — expiry un-gated (deterministic mode)', notification);
                }
            });

        this._injection.overrideMethod(proto, '_updateNotificationTimeout', (original) =>
            function (timeout) {
                const notification = this._notification;
                if (!notification || !isScopedSource(notification.source)) {
                    original.call(this, timeout);
                    return;
                }

                const decision = governorDecision({
                    inScope: true,
                    requestedMs: timeout,
                    deadlineMs: ext._deadlines.get(notification),
                    nowMs: nowMs(),
                });

                if (decision.kind === 'passthrough') {
                    original.call(this, decision.ms);
                    return;
                }

                if (decision.kind === 'establish') {
                    ext._deadlines.set(notification, decision.deadlineMs);
                    ext._log(`banner timer established — fixed deadline in ${decision.ms} ms (deterministic mode)`, notification);
                    original.call(this, decision.ms);
                    return;
                }

                if (decision.kind === 'converge') {
                    // Interaction happened (idle->active, pointer motion,
                    // hover refresh, in-place update): keep the SAME
                    // deadline instead of re-arming a fresh interval.
                    original.call(this, decision.ms);
                    return;
                }

                // decision.kind === 'expire-now': the deadline has been
                // reached. Mirror the shell's own no-re-arm branch
                // (messageTray.js `_notificationTimeout`): clear the timer
                // and let `_updateState` expire the banner through the
                // standard path. History is preserved by that path.
                original.call(this, 0);
                this._notificationTimeoutId = 0;
                ext._log('deadline reached — expiring banner via standard shell path', notification);
                this._updateState();
            });

        // Logging-only wrap (see header): precise hide timestamps in the
        // journal + eager WeakMap cleanup. No behavior change: the original
        // runs unmodified, the wrapper only observes its inputs/outputs.
        this._injection.overrideMethod(proto, '_hideNotificationCompleted', (original) =>
            function () {
                const notification = this._notification;
                const governed = !!notification
                    && isScopedSource(notification.source)
                    && ext._deadlines.has(notification);
                const removed = this._notificationRemoved;
                original.call(this);
                if (!governed)
                    return;
                ext._deadlines.delete(notification);
                const inHistory = !!(notification.source
                    && notification.source.notifications
                        .includes(notification));
                ext._log(`banner hidden — path: ${removed ? 'removed-while-showing (click/close)' : 'standard-expiry'}, history: ${inHistory ? 'retained' : 'removed with the notification'}`, notification);
            });

        this._log(`enabled — governing banners for app id(s): ${'whatsapp-linux'} (timeout ${BANNER_TIMEOUT_MS} ms; other apps keep stock GNOME behaviour)`);
    }

    disable() {
        if (this._injection) {
            this._injection.clear();
            this._injection = null;
        }
        this._deadlines = null;
        this._log('disabled — stock GNOME banner behaviour restored');
    }

    _log(message, notification) {
        try {
            const details = notification
                ? ` (banner: "${notification.title || ''}", source: ${sourceAppId(notification.source)})`
                : '';
            this.getLogger().log(`[m14] ${message}${details}`);
        } catch (e) {
            // Logging must never disturb the tray.
        }
    }
}
