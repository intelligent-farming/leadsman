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
import type { RaisedAlert, Store } from './db';
import type { Logger, NotifyConfig } from './types';
export interface NotifyOutcome {
    attempted: number;
    delivered: number;
    failed: number;
}
/**
 * Deliver newly-raised alerts. Failures are logged and left un-stamped, so the
 * alert stays pending and a later sounding retries it — no separate retry queue.
 */
export declare function notifyRaised(alerts: RaisedAlert[], config: NotifyConfig | undefined, store: Store, log: Logger): Promise<NotifyOutcome>;
//# sourceMappingURL=notify.d.ts.map