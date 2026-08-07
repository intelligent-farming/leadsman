/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * device-log-error — ChirpStack itself is reporting errors about the device.
 *
 * Every other check in this engine *infers* trouble from telemetry. This one reads what
 * the network server explicitly wrote down. ChirpStack's PostgreSQL integration logs
 * device-level problems to `event_log`: codec failures, MIC errors, frame-counter
 * resets, OTAA failures, downlink payloads too large for the data rate.
 *
 * That matters most for the case `decode-failure` can only see sideways. When a
 * normalized codec cannot parse a payload it returns `{errors: [...]}` with no `data`
 * key, so ChirpStack has nothing to store in `event_up.object` — the failure is
 * recorded here instead, with a human-readable reason. Inferring "no data" from a NULL
 * object tells you something is wrong; this tells you *what*.
 *
 * ── on level and code ───────────────────────────────────────────────────────────
 * ChirpStack's integration stores both as the *text* of a numeric enum: level is
 * '0' INFO, '1' WARNING, '2' ERROR. Codes enumerate the failure kind.
 *
 * The check filters on `level` rather than on a code allowlist, deliberately. Code
 * numbering is a ChirpStack implementation detail that can grow between versions, and a
 * check that only recognised the codes known when it was written would silently ignore
 * new failure modes. Filtering by severity and putting `description` in the alert means
 * a code this engine has never heard of still reaches a human with its own explanation.
 *
 * `excludeCodes` defaults to '7' (frame-counter retransmission). On a real store both
 * healthy devices produced nothing *but* code 7 — normal LoRaWAN behaviour when an ack
 * is lost and the device repeats a frame. Alerting on it would fire constantly, which is
 * how operators learn to ignore alerts.
 */
import type { Rule } from '../types';
declare const rule: Rule;
export default rule;
//# sourceMappingURL=device-log-error.d.ts.map