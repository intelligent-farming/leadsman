/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * battery-low — supply voltage has fallen below a threshold.
 *
 * Almost every category in the normalized vocabulary lists `battery` (volts) in its
 * `provides`, which makes this the one check that meaningfully covers a whole fleet
 * from a single entry. Mains- or analog-powered nodes report `power.voltage`
 * instead, so both are candidates by default.
 *
 * Demonstrates hysteresis, which matters more than it sounds. A cell sitting on the
 * threshold drifts above and below it with temperature, and because the engine
 * notifies on *newly raised* alerts, a naive check would send an SMS on every
 * crossing. Two thresholds fix it: raise at `raiseAtVolts`, and hold the alert open
 * until the reading recovers past the looser `clearAtVolts`. `ctx.openDevEuis` is
 * what lets the check do that without keeping state of its own.
 */
import type { Rule } from '../types';
declare const rule: Rule;
export default rule;
//# sourceMappingURL=battery-low.d.ts.map