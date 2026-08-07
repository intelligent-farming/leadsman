/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * status-margin-low — the device is barely hearing the gateway.
 *
 * `signal-degraded` measures the link from the *gateway's* side: how well the network
 * received the device's uplinks. This measures the opposite direction. `margin` in
 * `DevStatusAns` is the device's own demodulation margin in dB for the last downlink it
 * decoded — its report on how well it can hear the network.
 *
 * The two are not interchangeable, and asymmetry is common. A device on a hilltop with a
 * good antenna may be heard perfectly (fine RSSI) while its own receiver is swamped by
 * local noise or sitting behind a lossy connector, so downlinks fail. Anything that
 * needs the downlink path breaks quietly:
 *
 *   - ADR cannot move the device to a better data rate, so it burns battery and airtime
 *   - Confirmed uplinks never get their ack, so the device retransmits (and logs code 7)
 *   - Actuator commands — a valve, a relay, a setpoint — never arrive
 *   - Rejoin and MAC commands fail, which shows up later as join churn
 *
 * A low margin is therefore an early warning for `downlink-unacked` and `join-churn`,
 * and it arrives from a path no codec touches.
 *
 * Margin is a signed dB value (roughly -32..31). Positive is headroom above the
 * demodulation floor; at or below ~5 dB the link has little to spare, and below 0 the
 * device decoded that downlink essentially by luck.
 *
 * Like `status-battery-low`, this reads `event_status`, which arrives only on the device
 * profile's DevStatusReq interval — so the default window is two weeks, not hours.
 */
import type { Rule } from '../types';
declare const rule: Rule;
export default rule;
//# sourceMappingURL=status-margin-low.d.ts.map