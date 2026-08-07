/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * signal-degraded — link budget is deteriorating toward the edge of coverage.
 *
 * A leading indicator rather than a fault. A node whose RSSI has drifted down over
 * a season is usually telling you something physical: crop canopy grew over it, a
 * gateway antenna shifted, water got into a connector, or the enclosure moved. It
 * still works, right up until it doesn't — which is when device-silent fires and
 * someone drives out to a field.
 *
 * `rx_info` is a JSONB array with one entry per gateway that received the uplink.
 * The meaningful figure is the *best* gateway's RSSI per uplink (that is the link
 * that actually carried it), averaged over the window — not the mean across all
 * gateways, which drops as soon as a distant gateway starts hearing the device.
 */
import type { Rule } from '../types';
declare const rule: Rule;
export default rule;
//# sourceMappingURL=signal-degraded.d.ts.map