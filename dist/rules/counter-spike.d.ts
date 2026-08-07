/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * counter-spike — a monotonic total is advancing far faster than it should.
 *
 * The counterpart to `counter-stalled`, and the more expensive failure. On a water
 * meter this is a burst pipe, a stuck float valve, or a trough left running: the
 * total climbs steadily, every threshold check on every other field stays quiet, and
 * nobody notices until the tank is empty or the bill arrives.
 *
 *   metering.water.total   litres per hour above the plausible maximum
 *   metering.energy.total  watt-hours per hour — a heater or pump stuck on
 *   pulse.total            raw pulses, when the meter's unit is unknown
 *
 * Rate is the advance across the window divided by its span, so it is an average.
 * That deliberately misses a brief spike and reliably catches sustained flow, which
 * is the failure that actually drains a tank overnight. For genuinely instantaneous
 * limits, threshold a flow field if the device provides one.
 *
 * `minSpanHours` guards the division: three uplinks two minutes apart would otherwise
 * extrapolate to an enormous hourly rate and alert on nothing.
 */
import type { Rule } from '../types';
declare const rule: Rule;
export default rule;
//# sourceMappingURL=counter-spike.d.ts.map