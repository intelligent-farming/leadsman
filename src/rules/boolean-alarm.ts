/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * boolean-alarm — a flag in the telemetry is asserted.
 *
 * The vocabulary has a cluster of boolean and enum states that mean "something has
 * happened" rather than "here is a number":
 *
 *   water.leak                 a leak detector tripped
 *   air.gasAlarm               gas detected / abnormal
 *   action.smoke.detected      smoke detector tripped
 *   action.motion.detected     motion where there should be none
 *   action.switch.state        a switch or relay changed
 *   action.occupancy.occupied  space occupied
 *   action.button.pressed      a panic or acknowledge button
 *   action.contactState        "open" / "closed" — a gate or hatch
 *
 * Codecs express truth inconsistently even after normalization, because the
 * vocabulary allows `additionalProperties` and vendor codecs differ: `true`, `"true"`,
 * `1`, and `"open"` all occur. `trueValues` is therefore configurable, and matching
 * is case-insensitive.
 *
 * The alert clears when the flag reads false again, so a leak detector that trips and
 * is then dried out resolves on its own — while a detector that stays wet keeps one
 * open alert rather than notifying on every uplink.
 */

import { int, optNum, round } from '../params';
import { booleanDwell, latestBooleans, pathsLabel, resolvePaths } from '../measurement';
import { resolveScope, SCOPE_PARAMS } from '../scope';
import type { Finding, Rule } from '../types';

const rule: Rule = {
  id: 'boolean-alarm',
  description:
    'Flags devices whose latest reading at a candidate path is an asserted flag — ' +
    'leak, gas, smoke, motion, switch, occupancy, button, or an open contact. ' +
    'Resolves when the flag reads false again.',
  defaultSeverity: 'critical',
  /** A device asserted its own alarm flag. The device has already done the interpreting.
   */
  defaultRouting: 'fact',
  defaultParams: {
    /** Priority-ordered candidate vocabulary paths holding the flag. */
    paths: ['water.leak'],
    /**
     * Values that count as asserted, compared case-insensitively as text. Covers
     * JSON booleans, numeric flags, and the contactState enum.
     */
    trueValues: ['true', '1', 'open', 'detected', 'on', 'yes'],
    /** How far back to look for a device's most recent reading. */
    lookbackHours: 24,
    /** Wording for the alert summary, e.g. "leak detected". */
    label: 'alarm asserted',
    /**
     * Require the flag to have been asserted continuously this long before raising.
     * 0 fires on the latest reading, which is the original behaviour and the right one
     * for a leak or smoke detector — those are worth a text the instant they assert.
     *
     * Set it for everything that is normal briefly and expensive for long: a cold-store
     * door, a pump, an irrigation valve. Three minutes open is someone fetching a
     * pallet; three hours open is a ruined load, and the flag reads the same in both.
     *
     * Measured from the first asserted reading of the CURRENT run, so it understates by
     * up to one reporting interval, and a flag asserted in a single reading is zero.
     */
    minDurationMinutes: 0,
    /**
     * A reporting gap longer than this breaks the run. A device that went silent and
     * came back asserted was not observed asserted throughout. Only consulted when
     * `minDurationMinutes` is set.
     */
    maxGapHours: 1,
    /** Narrow this check to part of the fleet — see src/scope.ts. */
    ...SCOPE_PARAMS,
  },
  requires: [
    { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
  ],

  async run(ctx): Promise<Finding[]> {
    const paths = resolvePaths(ctx.params, 'paths');
    const lookbackHours = int(ctx.params, 'lookbackHours');
    const label = typeof ctx.params.label === 'string' ? ctx.params.label : 'alarm asserted';

    const rawTrue = ctx.params.trueValues;
    if (!Array.isArray(rawTrue) || rawTrue.length === 0) {
      throw new Error('trueValues must be a non-empty array of strings');
    }
    const trueValues = rawTrue.map((v) => String(v));

    const minDurationMinutes = optNum(ctx.params, 'minDurationMinutes') ?? 0;
    const maxGapHours = optNum(ctx.params, 'maxGapHours') ?? 1;
    if (minDurationMinutes < 0) throw new Error('minDurationMinutes must not be negative');
    if (maxGapHours <= 0) throw new Error('maxGapHours must be positive');
    if (minDurationMinutes >= lookbackHours * 60) {
      throw new Error(
        `minDurationMinutes (${minDurationMinutes}) must be less than lookbackHours ` +
          `(${lookbackHours}h) — a run cannot outlast the window it is measured in`,
      );
    }

    const scope = resolveScope(ctx.params);

    // Without a duration requirement this stays the one-query check it has always
    // been. The dwell path costs a second scan of the window, so it is not paid for
    // by deployments that did not ask for it.
    if (minDurationMinutes === 0) {
      const readings = await latestBooleans(ctx, paths, lookbackHours, trueValues, scope);
      if (readings.length === 0) {
        ctx.log.debug('no device reports any candidate path', { paths: pathsLabel(paths) });
        return [];
      }

      return readings
        .filter((r) => r.value)
        .map((r) => {
          const name = r.deviceName ?? r.devEui;
          return {
            devEui: r.devEui,
            deviceName: r.deviceName,
            summary: `${name}: ${label} (${r.matchedPath} = ${r.raw})`,
            detail: {
              measurement: r.matchedPath,
              rawValue: r.raw,
              trueValues,
              candidatePaths: pathsLabel(paths),
              readingAt: r.at,
            },
          };
        });
    }

    const runs = await booleanDwell(ctx, paths, lookbackHours, trueValues, maxGapHours, scope);
    if (runs.length === 0) {
      ctx.log.debug('no device reports any candidate path', { paths: pathsLabel(paths) });
      return [];
    }

    const findings: Finding[] = [];
    for (const r of runs) {
      if (!r.asserted) continue;
      const minutes = r.hours * 60;
      // An open alert keeps its raise. The flag already proved it could hold, and
      // re-imposing the duration every sounding would clear it the moment the run is
      // recomputed a sample short.
      if (!ctx.openDevEuis.has(r.devEui) && minutes < minDurationMinutes) continue;

      const name = r.deviceName ?? r.devEui;
      findings.push({
        devEui: r.devEui,
        deviceName: r.deviceName,
        summary:
          `${name}: ${label} for ${round(minutes, 0)} min ` +
          `(${r.matchedPath} = ${r.raw}, raises at ${minDurationMinutes} min)`,
        detail: {
          measurement: r.matchedPath,
          rawValue: r.raw,
          assertedMinutes: round(minutes, 1),
          requiredMinutes: minDurationMinutes,
          samples: r.samples,
          startedAt: r.startedAt,
          candidatePaths: pathsLabel(paths),
          readingAt: r.lastAt,
        },
      });
    }
    return findings;
  },
};

export default rule;
