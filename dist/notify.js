"use strict";
/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Outbound notification seam.
 *
 * Leadsman does not send SMS. It POSTs newly-raised alerts to one configurable
 * URL and stamps notified_at on success. That keeps carrier credentials, A2P
 * registration, and delivery retries out of the rule engine, and lets the receiver
 * be whatever fits the deployment:
 *
 *   - a small Twilio sender you own
 *   - a Hermes webhook route with `deliver_only: true` (zero LLM tokens)
 *   - a Hermes webhook route that invokes the agent, for alerts that need context
 *
 * Only *newly raised* alerts are posted. An alert that stays open across many
 * soundings is delivered once, which is the whole point of the raise/resolve
 * lifecycle — and the reason a flapping sensor cannot generate repeated
 * notifications or repeated agent invocations.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.notifyRaised = notifyRaised;
/** Body posted per alert. Flat and small — a receiver can map it straight to a template. */
function payload(alert) {
    return {
        schema: 'leadsman.alert/1',
        id: alert.id,
        rule: alert.ruleId,
        kind: alert.kind,
        devEui: alert.devEui,
        deviceName: alert.deviceName,
        severity: alert.severity,
        summary: alert.summary,
        detail: alert.detail,
        raisedAt: alert.raisedAt,
    };
}
/**
 * Deliver newly-raised alerts. Failures are logged and left un-stamped, so the
 * alert stays pending and a later sounding retries it — no separate retry queue.
 */
async function notifyRaised(alerts, config, store, log) {
    const outcome = { attempted: 0, delivered: 0, failed: 0 };
    if (!config?.webhookUrl) {
        if (alerts.length > 0) {
            log.debug('no notify.webhookUrl configured — alerts recorded but not delivered', {
                pending: alerts.length,
            });
        }
        return outcome;
    }
    if (alerts.length === 0)
        return outcome;
    const timeoutMs = config.timeoutMs ?? 5000;
    for (const alert of alerts) {
        outcome.attempted += 1;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const headers = { 'content-type': 'application/json' };
            if (config.webhookToken)
                headers.authorization = `Bearer ${config.webhookToken}`;
            const res = await fetch(config.webhookUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload(alert)),
                signal: controller.signal,
            });
            if (!res.ok) {
                outcome.failed += 1;
                log.warn('notify failed', {
                    alertId: alert.id,
                    kind: alert.kind,
                    status: res.status,
                });
                continue;
            }
            await store.markNotified(alert.id);
            outcome.delivered += 1;
            log.info('alert delivered', {
                alertId: alert.id,
                kind: alert.kind,
                devEui: alert.devEui,
            });
        }
        catch (err) {
            outcome.failed += 1;
            const aborted = err.name === 'AbortError';
            log.warn(aborted ? 'notify timed out' : 'notify errored', {
                alertId: alert.id,
                kind: alert.kind,
                error: err.message,
            });
        }
        finally {
            clearTimeout(timer);
        }
    }
    return outcome;
}
//# sourceMappingURL=notify.js.map