/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * counter-stalled — a monotonic total has stopped advancing.
 *
 * The vocabulary's cumulative fields need different treatment from instantaneous
 * readings, because for a counter "unchanged" is normal most of the time:
 *
 *   metering.water.total   litres through a water meter
 *   metering.energy.total  watt-hours through an energy meter
 *   pulse.total            raw pulse count
 *   rain.cumulative        millimetres of rain
 *   device.runtime         seconds a machine has run
 *
 * `measurement-stuck` would report every one of these constantly, since an idle
 * meter legitimately reports the same total for hours. So this check is explicitly
 * opt-in per meter and asks a narrower question: has the counter failed to advance
 * over a window in which you *expect* consumption?
 *
 * Useful for irrigation and stock water, where "no water used in 12 hours" during a
 * scheduled irrigation window means a failed pump, a closed valve, or a seized meter
 * — not a quiet day. Do not enable it on `rain.cumulative`, where a flat counter is
 * simply dry weather.
 *
 * A counter going *backwards* is also reported: that is a meter reset, a replacement
 * without re-provisioning, or a rollover, and it will silently corrupt any
 * consumption figure derived from the series.
 */
import type { Rule } from '../types';
declare const rule: Rule;
export default rule;
//# sourceMappingURL=counter-stalled.d.ts.map