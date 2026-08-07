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