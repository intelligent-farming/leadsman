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
 * The advance is the sum of the upward steps (see src/counter.ts), not last − first:
 * a burst followed by a meter reset — 100 → 5000 → 0 → 200 — has last − first of
 * +100 and would pass as a quiet meter, while the 4900 that ran through it before the
 * reset is exactly the water this check exists to notice. The drop itself contributes
 * nothing to the rate, and counter-stalled reports it as a decrease.
 * That deliberately misses a brief spike and reliably catches sustained flow, which
 * is the failure that actually drains a tank overnight. For genuinely instantaneous
 * limits, threshold a flow field if the device provides one.
 *
 * `minSpanHours` guards the division: three uplinks two minutes apart would otherwise
 * extrapolate to an enormous hourly rate and alert on nothing.
 */

import { int, num, round } from '../params';
import { counterWindows } from '../counter';
import { pathsLabel, resolvePaths } from '../measurement';
import { resolveScope, SCOPE_PARAMS } from '../scope';
import type { Finding, Rule } from '../types';

const rule: Rule = {
  id: 'counter-spike',
  description:
    'Flags monotonic totals (water, energy, pulses) advancing faster than a per-hour ' +
    'limit — a burst pipe, stuck valve, or equipment left running. Catches sustained ' +
    'consumption that every threshold check ignores.',
  defaultSeverity: 'critical',
  /** Generic: a counter advancing faster than a limit.
   */
  defaultRouting: 'fact',
  defaultParams: {
    /** Priority-ordered candidate vocabulary paths holding the total. */
    paths: ['metering.water.total', 'pulse.total'],
    /** Alert above this advance per hour, in the counter's own units (L, Wh, counts). */
    maxRatePerHour: 500,
    /** Shown in the alert summary. */
    unit: 'L',
    /** Window across which the rate is averaged. */
    lookbackHours: 3,
    /** Need at least this many readings for the rate to mean anything. */
    minSamples: 3,
    /** Ignore windows shorter than this, so the division cannot explode. */
    minSpanHours: 0.5,
    /** Narrow this check to part of the fleet — see src/scope.ts. */
    ...SCOPE_PARAMS,
  },
  requires: [
    { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
  ],

  async run(ctx): Promise<Finding[]> {
    const paths = resolvePaths(ctx.params, 'paths');
    const maxRate = num(ctx.params, 'maxRatePerHour');
    const lookbackHours = int(ctx.params, 'lookbackHours');
    const minSamples = int(ctx.params, 'minSamples');
    const minSpanHours = num(ctx.params, 'minSpanHours');
    const unit = typeof ctx.params.unit === 'string' ? ctx.params.unit : '';

    if (maxRate <= 0) throw new Error('maxRatePerHour must be positive');
    if (minSpanHours <= 0) throw new Error('minSpanHours must be positive');

    const scope = resolveScope(ctx.params);
    const stats = await counterWindows(ctx, paths, lookbackHours, scope);
    if (stats.length === 0) {
      ctx.log.debug('no device reports any candidate path', { paths: pathsLabel(paths) });
      return [];
    }

    const findings: Finding[] = [];

    for (const s of stats) {
      if (s.samples < minSamples) continue;

      const spanHours =
        (new Date(s.lastAt).getTime() - new Date(s.firstAt).getTime()) / 3_600_000;
      if (spanHours < minSpanHours) continue;

      // Upward steps only. A decrease is a meter reset, not consumption, so it neither
      // cancels what ran through the meter before it nor counts as flow itself —
      // counter-stalled reports the reset.
      const advance = s.rise;

      const rate = advance / spanHours;
      if (rate <= maxRate) continue;

      const name = s.deviceName ?? s.devEui;
      findings.push({
        devEui: s.devEui,
        deviceName: s.deviceName,
        summary:
          `${name} ${s.matchedPath} consuming ${round(rate, 1)}${unit}/h ` +
          `(${round(advance, 1)}${unit} over ${round(spanHours, 1)}h, limit ${maxRate}${unit}/h)` +
          (s.drops > 0 ? ' — counted across a counter reset' : ''),
        detail: {
          measurement: s.matchedPath,
          ratePerHour: round(rate, 2),
          maxRatePerHour: maxRate,
          advance: round(advance, 2),
          unit: unit || null,
          firstValue: round(s.first, 2),
          lastValue: round(s.last, 2),
          drops: s.drops,
          spanHours: round(spanHours, 2),
          samples: s.samples,
          candidatePaths: pathsLabel(paths),
          firstAt: s.firstAt,
          lastAt: s.lastAt,
        },
      });
    }

    return findings;
  },
};

export default rule;
