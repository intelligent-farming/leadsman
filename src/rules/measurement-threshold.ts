/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * measurement-threshold — min/max bound on the latest reading, resolved across
 * several candidate vocabulary paths.
 *
 * The workhorse. `paths` is a priority-ordered list, and per device the first path
 * actually present in that device's telemetry is used. Devices carrying none of the
 * candidates are ignored — so one entry safely covers a mixed fleet.
 *
 * That matters because the normalized vocabulary spreads one concept across several
 * paths. A frost check has to look at `temperature`, `air.temperature`,
 * `leaf.temperature`, and `water.temperature.current`, because which one a device
 * emits depends on what kind of sensor it is:
 *
 *   { "rule": "measurement-threshold", "as": "frost-risk", "severity": "critical",
 *     "params": { "paths": ["air.temperature", "temperature", "leaf.temperature"],
 *                 "min": 1.5, "unit": "C" } }
 *
 * Units are guaranteed by normalization (°C, %, m/s, hPa, …), so thresholds mean
 * the same thing on every vendor's hardware. See docs/vocabulary.md.
 */

import { int, optNum, round } from '../params';
import { bandDwell, latestReadings, pathsLabel, resolvePaths } from '../measurement';
import { resolveScope, SCOPE_PARAMS } from '../scope';
import type { Finding, Rule } from '../types';

/**
 * How long each device has been continuously outside the bound.
 *
 * The band handed to `bandDwell` is the COMPLEMENT of the allowed range — being "in
 * band" here means being in breach. A two-sided threshold has two disjoint breach
 * regions (below min, above max) which no single band can express, so the side that
 * the latest reading actually broke is the one measured; the caller already knows
 * which that is.
 */
async function sustainedBreach(
  ctx: Parameters<NonNullable<Rule['run']>>[0],
  paths: string[][],
  bounds: { min: number | null; max: number | null },
  lookbackHours: number,
  scope: ReturnType<typeof resolveScope>,
): Promise<Map<string, { hours: number; samples: number }>> {
  const out = new Map<string, { hours: number; samples: number }>();

  // A gap in reporting breaks the run: a device that went quiet for two hours was not
  // observed to be in breach for those hours, whatever it said either side of them.
  const maxGapHours = Math.max(lookbackHours / 4, 0.5);

  const sides: Array<{ min: number | null; max: number | null }> = [];
  if (bounds.min !== null) sides.push({ min: null, max: bounds.min });
  if (bounds.max !== null) sides.push({ min: bounds.max, max: null });

  for (const side of sides) {
    const runs = await bandDwell(ctx, paths, side, lookbackHours, maxGapHours, null, scope);
    for (const r of runs) {
      const best = out.get(r.devEui);
      // Longest across both sides: a device oscillating past both bounds has not held
      // either, and taking the max is the reading most generous to raising.
      if (!best || r.hours > best.hours) out.set(r.devEui, { hours: r.hours, samples: r.samples });
    }
  }
  return out;
}

const rule: Rule = {
  id: 'measurement-threshold',
  description:
    'Flags devices whose latest reading, at the first matching path from a candidate ' +
    'list, falls below min or above max. Devices reporting none of the paths are ' +
    'ignored. Enable once per measurement with a distinct "as" name.',
  defaultSeverity: 'warning',
  /** Generic: a value outside a configured band.
   */
  defaultRouting: 'fact',
  defaultParams: {
    /**
     * Priority-ordered candidate vocabulary paths. The first one present on a given
     * device wins. Dotted strings or arrays of segments.
     */
    paths: ['temperature', 'air.temperature'],
    /** Alert below this. null disables the lower bound. */
    min: null,
    /** Alert above this. null disables the upper bound. */
    max: null,
    /** Shown in the alert summary. Vocabulary units: C, %, m/s, hPa, ppm, … */
    unit: '',
    /** How far back to look for a device's most recent reading. */
    lookbackHours: 24,
    /**
     * Hysteresis, in measurement units. An open alert stays open until the reading
     * recovers this far past the bound it broke, so a value resting on the boundary
     * does not resolve and re-raise (and re-notify) every sounding.
     */
    clearMargin: 0,
    /**
     * Require the breach to have held this long before raising. 0 fires on the latest
     * reading, which is the original behaviour.
     *
     * Worth setting on anything that pages a human. This check fires on ONE reading,
     * and a single corrupted sample — a brown-out mid-transmission, a codec edge case,
     * a probe knocked in the wind — is enough to raise a critical frost alert at 04:00
     * from a block that never went below 6 °C. `clearMargin` cannot help: it damps the
     * resolve side, and the spurious page has already gone out.
     *
     * Measured as an unbroken run outside the bound, first breaching reading to last,
     * so it understates by up to one reporting interval. Set it to a small multiple of
     * the uplink interval — 30 minutes on a 5-minute reporter, not 6 on an hourly one.
     */
    sustainMinutes: 0,
    /**
     * Ignore devices with fewer than this many readings in the window. Only consulted
     * when `sustainMinutes` is set, since a duration measured from two samples is not
     * a measured duration.
     */
    minSamples: 2,
    /** Narrow this check to part of the fleet — see src/scope.ts. */
    ...SCOPE_PARAMS,
  },
  requires: [
    { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
  ],

  async run(ctx): Promise<Finding[]> {
    const paths = resolvePaths(ctx.params, 'paths');
    const min = optNum(ctx.params, 'min');
    const max = optNum(ctx.params, 'max');
    const lookbackHours = int(ctx.params, 'lookbackHours');
    const clearMargin = optNum(ctx.params, 'clearMargin') ?? 0;
    const sustainMinutes = optNum(ctx.params, 'sustainMinutes') ?? 0;
    const minSamples = int(ctx.params, 'minSamples');
    const unit = typeof ctx.params.unit === 'string' ? ctx.params.unit : '';

    if (min === null && max === null) {
      throw new Error(
        'at least one of "min" or "max" must be set — with neither bound this check ' +
          'can never fire',
      );
    }
    if (min !== null && max !== null && min > max) {
      throw new Error(`min (${min}) must not exceed max (${max})`);
    }
    if (clearMargin < 0) throw new Error('clearMargin must not be negative');
    if (sustainMinutes < 0) throw new Error('sustainMinutes must not be negative');
    if (sustainMinutes >= lookbackHours * 60) {
      throw new Error(
        `sustainMinutes (${sustainMinutes}) must be less than lookbackHours ` +
          `(${lookbackHours}h = ${lookbackHours * 60}min) — a run cannot outlast the ` +
          'window it is measured in, so this check could never fire',
      );
    }

    const scope = resolveScope(ctx.params);

    // With a sustain requirement the question stops being "what is it now" and becomes
    // "how long has it been wrong", which is a dwell measurement. Delegating to the
    // same resolver mold-risk uses keeps one implementation of "unbroken run" rather
    // than a second one that disagrees with it at the edges.
    const sustained = sustainMinutes > 0
      ? await sustainedBreach(ctx, paths, { min, max }, lookbackHours, scope)
      : null;
    const readings = await latestReadings(ctx, paths, lookbackHours, scope);
    if (readings.length === 0) {
      ctx.log.debug('no device reports any candidate path', { paths: pathsLabel(paths) });
      return [];
    }

    const suffix = unit ? `${unit}` : '';
    const findings: Finding[] = [];

    for (const r of readings) {
      const open = ctx.openDevEuis.has(r.devEui);

      if (sustained) {
        const run = sustained.get(r.devEui);
        // An open alert keeps its raise: the breach already proved it could hold, and
        // re-imposing the duration every sounding would flap it off on the first
        // reading that briefly recovered.
        if (!open) {
          if (!run || run.samples < minSamples) continue;
          if (run.hours * 60 < sustainMinutes) continue;
        }
      }
      // Widen the bounds for devices already in breach — that is the hysteresis.
      const lower = min === null ? null : open ? min + clearMargin : min;
      const upper = max === null ? null : open ? max - clearMargin : max;

      const belowMin = lower !== null && r.value < lower;
      const aboveMax = upper !== null && r.value > upper;
      if (!belowMin && !aboveMax) continue;

      const name = r.deviceName ?? r.devEui;
      const bound = belowMin ? `min ${min}${suffix}` : `max ${max}${suffix}`;

      findings.push({
        devEui: r.devEui,
        deviceName: r.deviceName,
        summary:
          `${name} ${r.matchedPath} ${round(r.value, 2)}${suffix} is ` +
          `${belowMin ? 'below' : 'above'} ${bound}`,
        detail: {
          measurement: r.matchedPath,
          value: round(r.value, 3),
          unit: unit || null,
          min,
          max,
          breached: belowMin ? 'min' : 'max',
          clearMargin,
          ...(sustained
            ? { sustainedMinutes: round((sustained.get(r.devEui)?.hours ?? 0) * 60, 1),
                requiredMinutes: sustainMinutes }
            : {}),
          candidatePaths: pathsLabel(paths),
          readingAt: r.at,
        },
      });
    }

    return findings;
  },
};

export default rule;
