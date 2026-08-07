/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * downlink-unacked — confirmed downlinks are not being acknowledged.
 *
 * Every other check in this engine watches data coming *from* devices. This one watches
 * whether the commands you sent *to* them actually landed, which is the difference
 * between monitoring and control.
 *
 * On a farm the downlinks that matter are the ones that move something: open a valve,
 * start a pump, change a setpoint, retune a reporting interval. Those are normally sent
 * confirmed, and ChirpStack records the outcome in `event_ack` — `acknowledged = true`
 * when the device confirmed it, `false` when the confirmation never came.
 *
 * An unacknowledged downlink is genuinely dangerous, because the failure is silent in
 * both directions. Nothing in the telemetry says "the valve did not open"; the sensor
 * keeps reporting the same reading it would have reported anyway, and a scheduler that
 * assumes its command was applied will happily move on. If you act on downlinks at all,
 * this is the check that tells you when you only think you did.
 *
 * Usual causes are downlink-path problems: the device is not listening at the right time
 * (Class A receive windows missed), it cannot hear the gateway (see
 * `status-margin-low`), the session was reset between send and ack (see `join-churn`),
 * or the payload was too large for the current data rate — which ChirpStack also logs to
 * `event_log`, so `device-log-error` often fires alongside.
 *
 * Note `event_ack` only receives rows for *confirmed* downlinks. A deployment that never
 * sends confirmed downlinks will have an empty table and this check will correctly stay
 * silent forever, which is why it ships disabled in the example config.
 */
import type { Rule } from '../types';
declare const rule: Rule;
export default rule;
//# sourceMappingURL=downlink-unacked.d.ts.map