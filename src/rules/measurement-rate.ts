/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * measurement-rate — the value is changing too fast, in either direction.
 *
 * Thresholds catch a bad state; this catches a bad trajectory, often hours earlier.
 * The value can be comfortably inside its bounds and still be heading somewhere
 * expensive:
 *
 *   - A tank falling 8 %/hour is a leak or an open valve; at 40 % it is still
 *     "fine" by any threshold, and by morning it is dry.
 *   - Soil moisture dropping fast after irrigation means the water went somewhere
 *     other than the root zone.
 *   - Air temperature falling 3 °C/hour at dusk is the shape of a frost event
 *     before the temperature itself is alarming.
 *   - A dendrometer or sap-flow reading collapsing indicates plant stress.
 *
 * Rate is computed as (last - first) / hours across the window, so it is an average
 * slope rather than an instantaneous derivative. That is deliberate: LoRaWAN
 * sampling is sparse and irregular, and a slope over several samples is far less
 * jumpy than a difference between two adjacent uplinks.
 */

import { int, num, round, str } from '../params';
import { pathsLabel, resolvePaths, windowStats } from '../measurement';
import { resolveScope, SCOPE_PARAMS } from '../scope';
import type { Finding, Rule } from '../types';

const rule: Rule = {
  id: 'measurement-rate',
  description:
    'Flags devices whose reading is changing faster than a per-hour limit, computed as ' +
    'the average slope across the window. Catches a bad trajectory (draining tank, ' +
    'plunging temperature, collapsing soil moisture) while the value is still in bounds.',
  defaultSeverity: 'warning',
  /** Generic: a value changing faster than a limit.
   */
  defaultRouting: 'fact',
  defaultParams: {
    /** Priority-ordered candidate vocabulary paths. */
    paths: ['tank.level', 'water.level', 'tank.volume'],
    /**
     * "falling" alerts on a decrease, "rising" on an increase, "either" on the
     * absolute rate regardless of sign.
     */
    direction: 'falling',
    /** Alert when |rate| exceeds this, in measurement units per hour. */
    maxRatePerHour: 5,
    /** Shown in the alert summary. */
    unit: '%',
    /** Window across which the slope is measured. */
    lookbackHours: 6,
    /** Need at least this many readings for the slope to mean anything. */
    minSamples: 4,
    /**
     * Ignore windows shorter than this. Prevents a device that sent three uplinks in
     * two minutes from producing an enormous extrapolated hourly rate.
     */
    minSpanHours: 1,
    /** Narrow this check to part of the fleet — see src/scope.ts. */
    ...SCOPE_PARAMS,
  },
  requires: [
    { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
  ],

  async run(ctx): Promise<Finding[]> {
    const paths = resolvePaths(ctx.params, 'paths');
    const direction = str(ctx.params, 'direction');
    const maxRate = num(ctx.params, 'maxRatePerHour');
    const lookbackHours = int(ctx.params, 'lookbackHours');
    const minSamples = int(ctx.params, 'minSamples');
    const minSpanHours = num(ctx.params, 'minSpanHours');
    const unit = typeof ctx.params.unit === 'string' ? ctx.params.unit : '';

    if (!['falling', 'rising', 'either'].includes(direction)) {
      throw new Error(`direction must be "falling", "rising", or "either" (got "${direction}")`);
    }
    if (maxRate <= 0) throw new Error('maxRatePerHour must be positive');

    const scope = resolveScope(ctx.params);
    const stats = await windowStats(ctx, paths, lookbackHours, null, scope);
    if (stats.length === 0) {
      ctx.log.debug('no device reports any candidate path', { paths: pathsLabel(paths) });
      return [];
    }

    const findings: Finding[] = [];

    for (const s of stats) {
      if (s.samples < minSamples) continue;

      const spanHours =
        (new Date(s.lastAt).getTime() - new Date(s.firstAt).getTime()) / 3_600_000;
      // Guard against dividing by a near-zero span, which would extrapolate a tiny
      // change over seconds into an absurd hourly rate.
      if (spanHours < minSpanHours) continue;

      const delta = s.last - s.first;
      const rate = delta / spanHours;

      const breached =
        direction === 'falling'
          ? rate < -maxRate
          : direction === 'rising'
            ? rate > maxRate
            : Math.abs(rate) > maxRate;
      if (!breached) continue;

      const name = s.deviceName ?? s.devEui;
      const verb = rate < 0 ? 'falling' : 'rising';

      findings.push({
        devEui: s.devEui,
        deviceName: s.deviceName,
        summary:
          `${name} ${s.matchedPath} ${verb} ${round(Math.abs(rate), 2)}${unit}/h ` +
          `(${round(s.first, 1)} → ${round(s.last, 1)}${unit} over ${round(spanHours, 1)}h, ` +
          `limit ${maxRate}${unit}/h)`,
        detail: {
          measurement: s.matchedPath,
          ratePerHour: round(rate, 3),
          maxRatePerHour: maxRate,
          direction,
          unit: unit || null,
          firstValue: round(s.first, 3),
          lastValue: round(s.last, 3),
          delta: round(delta, 3),
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
