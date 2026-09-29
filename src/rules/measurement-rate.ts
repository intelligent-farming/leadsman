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
 *
 * ## Two methods, and when the default is wrong
 *
 * `method: "endpoints"` is the above, and it is right for the cases this rule was
 * written for: over six hours it is steady, cheap, and reads the way an operator
 * expects. Over a season it is close to useless, because a thirty-day trend computed
 * from exactly two readings inherits every fault of those two readings — one bad
 * endpoint invents or erases a trend on its own.
 *
 * `method: "leastSquares"` fits every reading in the window and reports `r2` alongside
 * the slope, so a caller can insist the line actually describes the data before
 * believing it. Use it for anything measured in weeks: salinity creeping up under
 * deficit irrigation, a water table falling year on year, a probe slowly
 * decalibrating. Those are real agronomic conditions that no threshold catches until
 * the damage is done and no six-hour slope can see at all.
 *
 * ## Projection
 *
 * `projectToBound` turns a rate into a deadline. "Falling 8 %/h" is a fact an operator
 * has to do arithmetic on; "reaches the 15 % refill point in 5.2 h" is a scheduling
 * input. The projection is linear and says so — it assumes the current slope holds,
 * which it will not exactly, and it is still the difference between an alert that
 * informs and one that plans.
 */

import { int, num, optNum, round, str } from '../params';
import { pathsLabel, resolvePaths, windowStats, windowTrend } from '../measurement';
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
    /**
     * How the slope is computed: "endpoints" is (last - first) / span, "leastSquares"
     * fits every reading. See the header — endpoints for hours, leastSquares for weeks.
     */
    method: 'endpoints',
    /**
     * Least squares only: ignore a fit worse than this (0-1). A slope through a cloud
     * of points is a confident number describing nothing, and at seasonal timescales
     * it is the usual outcome. null accepts any fit.
     */
    minR2: 0.5,
    /**
     * Report how long until the value reaches this bound at the current rate, and put
     * it in the summary. null omits the projection.
     *
     * Only ever reported for a value heading TOWARD the bound — a rising tank with a
     * low-water bound projects to nothing, rather than to a negative number of hours
     * that reads like a deadline in the past.
     */
    projectToBound: null,
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
    const method = str(ctx.params, 'method');
    const minR2 = optNum(ctx.params, 'minR2');
    const projectToBound = optNum(ctx.params, 'projectToBound');
    const maxRate = num(ctx.params, 'maxRatePerHour');
    const lookbackHours = int(ctx.params, 'lookbackHours');
    const minSamples = int(ctx.params, 'minSamples');
    const minSpanHours = num(ctx.params, 'minSpanHours');
    const unit = typeof ctx.params.unit === 'string' ? ctx.params.unit : '';

    if (!['falling', 'rising', 'either'].includes(direction)) {
      throw new Error(`direction must be "falling", "rising", or "either" (got "${direction}")`);
    }
    if (maxRate <= 0) throw new Error('maxRatePerHour must be positive');
    if (lookbackHours <= 0) {
      throw new Error(
        'lookbackHours must be positive — an empty window holds no readings, so this ' +
          'check could never fire',
      );
    }
    // The span is last reading minus first, both inside the window, so it is always
    // strictly shorter than lookbackHours. A minimum span at or past the window can
    // never be met.
    if (minSpanHours >= lookbackHours) {
      throw new Error(
        `minSpanHours (${minSpanHours}) must be less than lookbackHours (${lookbackHours}) — ` +
          'the readings in a window cannot span more than the window, so this check could never fire',
      );
    }
    if (method !== 'endpoints' && method !== 'leastSquares') {
      throw new Error(`method must be "endpoints" or "leastSquares" (got "${method}")`);
    }
    if (minR2 !== null && (minR2 < 0 || minR2 > 1)) {
      throw new Error(`minR2 must be between 0 and 1 (got ${minR2})`);
    }

    const scope = resolveScope(ctx.params);

    // Both methods produce the same shape, so everything downstream — hysteresis,
    // summary, projection — has one implementation rather than two that drift.
    const stats: Array<{
      devEui: string;
      deviceName: string | null;
      matchedPath: string;
      first: number;
      last: number;
      samples: number;
      spanHours: number;
      rate: number;
      r2: number | null;
      firstAt: string;
      lastAt: string;
    }> =
      method === 'leastSquares'
        ? (await windowTrend(ctx, paths, lookbackHours, scope)).map((t) => ({
            devEui: t.devEui,
            deviceName: t.deviceName,
            matchedPath: t.matchedPath,
            first: t.fittedFirst,
            last: t.fittedLast,
            samples: t.samples,
            spanHours: t.spanHours,
            rate: t.slopePerHour,
            r2: t.r2,
            firstAt: t.firstAt,
            lastAt: t.lastAt,
          }))
        : (await windowStats(ctx, paths, lookbackHours, null, scope)).map((w) => {
            const spanHours =
              (new Date(w.lastAt).getTime() - new Date(w.firstAt).getTime()) / 3_600_000;
            return {
              devEui: w.devEui,
              deviceName: w.deviceName,
              matchedPath: w.matchedPath,
              first: w.first,
              last: w.last,
              samples: w.samples,
              spanHours,
              rate: spanHours > 0 ? (w.last - w.first) / spanHours : 0,
              r2: null,
              firstAt: w.firstAt,
              lastAt: w.lastAt,
            };
          });

    if (stats.length === 0) {
      ctx.log.debug('no device reports any candidate path', { paths: pathsLabel(paths) });
      return [];
    }

    const findings: Finding[] = [];

    for (const s of stats) {
      if (s.samples < minSamples) continue;

      const spanHours = s.spanHours;
      // Guard against dividing by a near-zero span, which would extrapolate a tiny
      // change over seconds into an absurd hourly rate.
      if (spanHours < minSpanHours) continue;

      // A slope nobody should believe. Reported at debug rather than dropped in
      // silence, because "the trend is not measurable" is itself worth knowing when
      // someone is wondering why a seasonal check never fires.
      if (minR2 !== null && s.r2 !== null && s.r2 < minR2) {
        ctx.log.debug('trend rejected — poor fit', {
          device: s.devEui, r2: round(s.r2, 3), minR2,
        });
        continue;
      }

      const delta = s.last - s.first;
      const rate = s.rate;

      const breached =
        direction === 'falling'
          ? rate < -maxRate
          : direction === 'rising'
            ? rate > maxRate
            : Math.abs(rate) > maxRate;
      if (!breached) continue;

      const name = s.deviceName ?? s.devEui;
      const verb = rate < 0 ? 'falling' : 'rising';

      // Only project when the value is actually heading toward the bound. A rising
      // tank against a low-water bound would otherwise yield a negative lead time,
      // which reads like a deadline that has already passed.
      const gap = projectToBound === null ? null : projectToBound - s.last;
      const hoursToBound =
        gap !== null && rate !== 0 && Math.sign(gap) === Math.sign(rate)
          ? gap / rate
          : null;

      findings.push({
        devEui: s.devEui,
        deviceName: s.deviceName,
        summary:
          `${name} ${s.matchedPath} ${verb} ${round(Math.abs(rate), 2)}${unit}/h ` +
          `(${round(s.first, 1)} → ${round(s.last, 1)}${unit} over ${round(spanHours, 1)}h, ` +
          `limit ${maxRate}${unit}/h)` +
          (hoursToBound !== null
            ? ` — reaches ${projectToBound}${unit} in ${round(hoursToBound, 1)}h`
            : ''),
        detail: {
          measurement: s.matchedPath,
          ratePerHour: round(rate, 3),
          maxRatePerHour: maxRate,
          direction,
          method,
          ...(s.r2 !== null ? { r2: round(s.r2, 3) } : {}),
          unit: unit || null,
          firstValue: round(s.first, 3),
          lastValue: round(s.last, 3),
          delta: round(delta, 3),
          spanHours: round(spanHours, 2),
          ...(hoursToBound !== null
            ? { projectToBound, hoursToBound: round(hoursToBound, 2) }
            : {}),
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
