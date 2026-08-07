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
 *
 * ── authenticating to the receiver ─────────────────────────────────────────────
 * Three modes, because receivers disagree about how a webhook should prove itself:
 *
 *   hmac    X-Webhook-Signature-V2 + X-Webhook-Timestamp, where the signature is an
 *           HMAC-SHA256 hex digest of `<unix-seconds>.<body>`. The timestamp is part of
 *           the signed string, so a captured request cannot be replayed later — the
 *           receiver rejects a stale timestamp and the attacker cannot re-sign a fresh
 *           one without the secret. This is what Hermes' generic webhook route expects,
 *           and it is the right default for anything reachable off the loopback.
 *   token   A plain shared secret in a configurable header. Simpler, and what several
 *           receivers accept (Hermes' GitLab-shaped route matches X-Gitlab-Token this
 *           way). No replay protection.
 *   bearer  Authorization: Bearer <secret>. The original behaviour, kept for receivers
 *           that treat the webhook as an ordinary authenticated API call.
 *
 * All three read the secret from LEADSMAN_WEBHOOK_TOKEN, so it never enters the config
 * file.
 */

import { createHmac } from 'node:crypto';
import type { RaisedAlert, Store } from './db';
import type { Logger, NotifyConfig } from './types';

export interface NotifyOutcome {
  attempted: number;
  delivered: number;
  failed: number;
}

/** Body posted per alert. Flat and small — a receiver can map it straight to a template. */
function payload(alert: RaisedAlert): Record<string, unknown> {
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
export async function notifyRaised(
  alerts: RaisedAlert[],
  config: NotifyConfig | undefined,
  store: Store,
  log: Logger,
): Promise<NotifyOutcome> {
  const outcome: NotifyOutcome = { attempted: 0, delivered: 0, failed: 0 };

  if (!config?.webhookUrl) {
    if (alerts.length > 0) {
      log.debug('no notify.webhookUrl configured — alerts recorded but not delivered', {
        pending: alerts.length,
      });
    }
    return outcome;
  }
  if (alerts.length === 0) return outcome;

  const timeoutMs = config.timeoutMs ?? 5_000;
  const auth = config.webhookAuth ?? 'bearer';

  if (auth !== 'bearer' && !config.webhookToken) {
    log.warn(
      `notify.webhookAuth is "${auth}" but no secret is set — set LEADSMAN_WEBHOOK_TOKEN ` +
        'or the receiver will reject every delivery',
    );
  }

  for (const alert of alerts) {
    outcome.attempted += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Serialize once: the signature covers these exact bytes, so re-stringifying for
      // the request body could produce a different string and a signature that never
      // validates.
      const body = JSON.stringify(payload(alert));
      const headers: Record<string, string> = { 'content-type': 'application/json' };

      if (config.webhookToken) {
        if (auth === 'hmac') {
          const timestamp = Math.floor(Date.now() / 1000).toString();
          headers['x-webhook-timestamp'] = timestamp;
          headers['x-webhook-signature-v2'] = createHmac('sha256', config.webhookToken)
            .update(`${timestamp}.${body}`)
            .digest('hex');
        } else if (auth === 'token') {
          headers[(config.webhookTokenHeader ?? 'x-webhook-token').toLowerCase()] =
            config.webhookToken;
        } else {
          headers.authorization = `Bearer ${config.webhookToken}`;
        }
      }

      const res = await fetch(config.webhookUrl, {
        method: 'POST',
        headers,
        body,
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
    } catch (err) {
      outcome.failed += 1;
      const aborted = (err as Error).name === 'AbortError';
      log.warn(aborted ? 'notify timed out' : 'notify errored', {
        alertId: alert.id,
        kind: alert.kind,
        error: (err as Error).message,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return outcome;
}
