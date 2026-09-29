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

/** One side's current breach run: first breaching reading to the latest one. */
interface BreachRun {
  hours: number;
  samples: number;
}

/**
 * How long each device has been continuously outside each bound, up to NOW.
 *
 * The band handed to `bandDwell` is the COMPLEMENT of the allowed range — being "in
 * band" here means being in breach. A two-sided threshold has two disjoint breach
 * regions (below min, above max) which no single band can express, so each side is
 * measured separately and the caller reads only the side the latest reading actually
 * broke. Taking the longer of the two would let a heat spike borrow the duration of
 * last night's frost.
 *
 * `current` mode, not `longest`: the run must include the device's latest reading. A
 * three-hour frost yesterday followed by a warm day and one corrupt −5 °C sample now is
 * a single-sample breach, which is exactly what `sustainMinutes` exists to refuse; the
 * longest run in the window would have vouched for it.
 *
 * `strict`, because the breach test is strict (`value < min`, `value > max`). A reading
 * resting exactly on the bound is not in breach, so it must not extend a breach run
 * either — otherwise three hours at exactly 1.5 °C followed by one 1.4 °C reading would
 * be a three-hour frost.
 */
async function sustainedBreach(
  ctx: Parameters<NonNullable<Rule['run']>>[0],
  paths: string[][],
  bounds: { min: number | null; max: number | null },
  lookbackHours: number,
  maxGapHours: number,
  scope: ReturnType<typeof resolveScope>,
): Promise<Map<string, { below?: BreachRun; above?: BreachRun }>> {
  const out = new Map<string, { below?: BreachRun; above?: BreachRun }>();

  const sides: Array<{ key: 'below' | 'above'; min: number | null; max: number | null }> = [];
  if (bounds.min !== null) sides.push({ key: 'below', min: null, max: bounds.min });
  if (bounds.max !== null) sides.push({ key: 'above', min: bounds.max, max: null });

  for (const side of sides) {
    const runs = await bandDwell(
      ctx, paths, { min: side.min, max: side.max, strict: true },
      lookbackHours, maxGapHours, null, scope, 'current',
    );
    for (const r of runs) {
      const entry = out.get(r.devEui) ?? {};
      entry[side.key] = { hours: r.hours, samples: r.samples };
      out.set(r.devEui, entry);
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
     * Measured as the CURRENT unbroken run past the bound the latest reading broke —
     * first breaching reading to the latest one, which must itself be in breach. An
     * earlier breach that ended does not count, and neither does time on the other
     * side of a two-sided threshold. The run uses the same strict test as the breach:
     * a reading exactly on the bound breaks it. First-to-last understates by up to one
     * reporting interval, which errs toward not paging. Set it to a small multiple of
     * the uplink interval — 30 minutes on a 5-minute reporter, not 6 on an hourly one.
     */
    sustainMinutes: 0,
    /**
     * Ignore a breach whose current run holds fewer than this many readings. Only
     * consulted when `sustainMinutes` is set, since a duration measured from one
     * sample is not a measured duration.
     */
    minSamples: 2,
    /**
     * A reporting gap longer than this breaks the sustain run. A device that went quiet
     * was not observed to be in breach while silent, whatever it said either side of
     * the silence. Set it a little above the uplink interval — 90 minutes suits an
     * hourly reporter, 15 a 5-minute one. Only consulted when `sustainMinutes` is set.
     */
    maxGapMinutes: 90,
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
    const maxGapMinutes = optNum(ctx.params, 'maxGapMinutes') ?? 90;
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
    if (!(maxGapMinutes > 0)) {
      throw new Error(
        `maxGapMinutes must be positive (got ${maxGapMinutes}) — at 0 every pair of ` +
          'readings is a gap, so no breach could ever be sustained',
      );
    }
    if (lookbackHours <= 0) {
      throw new Error(
        'lookbackHours must be positive — an empty window holds no readings, so this ' +
          'check could never fire',
      );
    }
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
      ? await sustainedBreach(ctx, paths, { min, max }, lookbackHours, maxGapMinutes / 60, scope)
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

      // Widen the bounds for devices already in breach — that is the hysteresis.
      const lower = min === null ? null : open ? min + clearMargin : min;
      const upper = max === null ? null : open ? max - clearMargin : max;

      const belowMin = lower !== null && r.value < lower;
      const aboveMax = upper !== null && r.value > upper;
      if (!belowMin && !aboveMax) continue;

      // The sustain run is read on the side this reading broke, and only after the
      // breach test, so the side is known rather than guessed.
      const run = sustained?.get(r.devEui)?.[belowMin ? 'below' : 'above'];
      if (sustained) {
        // An open alert keeps its raise: the breach already proved it could hold, and
        // re-imposing the duration every sounding would flap it off on the first
        // reading that briefly recovered.
        if (!open) {
          if (!run || run.samples < minSamples) continue;
          if (run.hours * 60 < sustainMinutes) continue;
        }
      }

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
            ? { sustainedMinutes: round((run?.hours ?? 0) * 60, 1),
                requiredMinutes: sustainMinutes,
                maxGapMinutes }
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
