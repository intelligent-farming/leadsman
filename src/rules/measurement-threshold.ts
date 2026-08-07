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
import { latestReadings, pathsLabel, resolvePaths } from '../measurement';
import { resolveScope, SCOPE_PARAMS } from '../scope';
import type { Finding, Rule } from '../types';

const rule: Rule = {
  id: 'measurement-threshold',
  description:
    'Flags devices whose latest reading, at the first matching path from a candidate ' +
    'list, falls below min or above max. Devices reporting none of the paths are ' +
    'ignored. Enable once per measurement with a distinct "as" name.',
  defaultSeverity: 'warning',
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

    const scope = resolveScope(ctx.params);
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
          candidatePaths: pathsLabel(paths),
          readingAt: r.at,
        },
      });
    }

    return findings;
  },
};

export default rule;
