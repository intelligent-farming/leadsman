/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * measurement-dwell — how long a value spent inside a band.
 *
 * The generic form of the mechanism `mold-risk` uses for infection periods. That rule
 * keeps its own name and its own `situation` routing because acting on it needs crop
 * stage and spray history; this one is the bare mechanism, for every other question
 * whose answer is a number of hours rather than a value.
 *
 *   - chill accumulation — hours between 0 and 7.2 °C since dormancy. A warm winter
 *     that fails to break dormancy in almonds or cherries shows up as poor, uneven
 *     bloom months later, when nothing can be done about it.
 *   - cold-chain dwell — hours a load spent above its limit, which is what determines
 *     whether it is still saleable, not the peak it touched for ten minutes.
 *   - heat-hours above a stress threshold, for crops where duration does the damage.
 *   - hours a greenhouse spent outside its VPD band overnight.
 *
 * ## The two axes that make it four different questions
 *
 *   mode: longest   the longest UNBROKEN run. Infection, exposure, anything where the
 *                   damage needs continuity.
 *   mode: total     all time in band added together. Accumulation — chill does not care
 *                   whether the cold came in one stretch or twelve, and reporting the
 *                   longest run would under-count a normal winter tenfold.
 *
 *   comparison: atLeast   raise when the dwell reaches the target. "It has been wet
 *                         long enough to infect."
 *   comparison: atMost    raise when the dwell FAILS to reach it. "It has not been
 *                         cold enough for long enough." This is the direction no other
 *                         rule in the engine can express, because a thing that did not
 *                         happen often enough leaves no reading for a threshold to
 *                         catch, and it is where chill, vernalization and every other
 *                         accumulate-or-fail condition lives.
 *
 * `atMost` only makes sense once the window has had a fair chance to fill, so it waits
 * until the device has covered `minSamples` readings and refuses to judge a device
 * that has barely reported — otherwise every newly-installed sensor is instantly short
 * of its chill target.
 *
 * ## Which way each mode rounds
 *
 * The two modes credit time differently, so they err in different directions, and
 * the direction matters most for `atMost`, where under-counting RAISES:
 *
 *   longest   first in-band reading to last. Understates a run by up to one reporting
 *             interval at each end. Toward not raising for `atLeast` (the infection
 *             question, which is why mold-risk keeps it); toward raising for `atMost`,
 *             so leave some slack in a "longest run must reach N hours" target.
 *   total     last observation carried forward: every in-band reading is credited with
 *             the time to the next reading, and the latest with the time up to now,
 *             each capped at `maxGapHours`. No interval is lost per run, so seven
 *             fragmented nights of six hourly readings bank 42 h rather than 35 h —
 *             first-to-last per run would call that a chill shortfall. The cap credits a
 *             device that went quiet mid-band with up to `maxGapHours` it was not
 *             observed for, which errs toward more dwell: toward not raising for
 *             `atMost` (chill), toward raising for `atLeast`.
 */

import { int, num, optNum, round, str } from '../params';
import { bandDwell, pathsLabel, resolvePaths, type Band } from '../measurement';
import { resolveScope, SCOPE_PARAMS } from '../scope';
import type { Finding, Rule } from '../types';

/** Human-readable band: "≥85%", "≤7.2C", "0–7.2C". */
function bandLabel(band: Band, unit: string): string {
  if (band.min !== null && band.max !== null) return `${band.min}–${band.max}${unit}`;
  if (band.min !== null) return `≥${band.min}${unit}`;
  return `≤${band.max}${unit}`;
}

function optionalPaths(params: Record<string, unknown>, key: string): string[][] | null {
  const raw = params[key];
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw) && raw.length === 0) return null;
  return resolvePaths(params, key);
}

const rule: Rule = {
  id: 'measurement-dwell',
  description:
    'Flags devices by how long a measurement stayed inside a band — the longest ' +
    'unbroken run, or the total across the window — against a target it must reach or ' +
    'must not exceed. Chill hours, cold-chain dwell, heat-hours, exposure.',
  defaultSeverity: 'warning',
  /** Generic: a duration against a target. Set notifyTo per instance to escalate. */
  defaultRouting: 'fact',
  defaultParams: {
    /** Priority-ordered candidate vocabulary paths. */
    paths: ['air.temperature', 'temperature'],
    /** Bottom of the band. null opens it downward. */
    min: 0,
    /** Top of the band. null opens it upward. */
    max: 7.2,
    /** "longest" for an unbroken run, "total" for an accumulation. See the header. */
    mode: 'total',
    /** "atLeast" raises when the dwell reaches dwellHours, "atMost" when it falls short. */
    comparison: 'atMost',
    /** The target, in hours. */
    dwellHours: 100,
    /** Optional second measurement that must also be in band on the SAME uplink. */
    gatePaths: null,
    gateMin: null,
    gateMax: null,
    /** The window the dwell is measured over. */
    lookbackHours: 168,
    /**
     * The longest a reading is trusted to speak for. A reporting gap longer than this
     * breaks a run; in "total" mode each reading is credited with the time to the next
     * one (or to now) but never more than this.
     */
    maxGapHours: 3,
    /**
     * A device needs this many in-band readings (atLeast) or window readings (atMost)
     * before it is judged. Without it, a sensor installed yesterday is instantly short
     * of its chill target.
     */
    minSamples: 24,
    /** Hysteresis in hours — see mold-risk. */
    clearDwellHours: 10,
    /** Shown in the alert summary. */
    unit: 'C',
    /** Narrow this check to part of the fleet — see src/scope.ts. */
    ...SCOPE_PARAMS,
  },
  requires: [
    { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
  ],

  async run(ctx): Promise<Finding[]> {
    const paths = resolvePaths(ctx.params, 'paths');
    const band: Band = { min: optNum(ctx.params, 'min'), max: optNum(ctx.params, 'max') };
    const mode = str(ctx.params, 'mode');
    const comparison = str(ctx.params, 'comparison');
    const dwellHours = num(ctx.params, 'dwellHours');
    const lookbackHours = int(ctx.params, 'lookbackHours');
    const maxGapHours = num(ctx.params, 'maxGapHours');
    const minSamples = int(ctx.params, 'minSamples');
    const clearDwellHours = optNum(ctx.params, 'clearDwellHours') ?? 0;
    const unit = typeof ctx.params.unit === 'string' ? ctx.params.unit : '';

    const gatePaths = optionalPaths(ctx.params, 'gatePaths');
    const gateBand: Band = {
      min: optNum(ctx.params, 'gateMin'),
      max: optNum(ctx.params, 'gateMax'),
    };

    if (mode !== 'longest' && mode !== 'total') {
      throw new Error(`mode must be "longest" or "total" (got "${mode}")`);
    }
    if (comparison !== 'atLeast' && comparison !== 'atMost') {
      throw new Error(`comparison must be "atLeast" or "atMost" (got "${comparison}")`);
    }
    if (band.min === null && band.max === null) {
      throw new Error(
        'at least one of "min" or "max" must be set — with neither bound every reading ' +
          'is inside the band',
      );
    }
    if (band.min !== null && band.max !== null && band.min > band.max) {
      throw new Error(`min (${band.min}) must not exceed max (${band.max})`);
    }
    if (gatePaths && gateBand.min === null && gateBand.max === null) {
      throw new Error(
        'gatePaths is set but neither "gateMin" nor "gateMax" is — the gate would ' +
          'admit every reading. Set a bound, or set gatePaths to null',
      );
    }
    if (dwellHours <= 0) throw new Error('dwellHours must be positive');
    // Only "atLeast" is capped by the window: a total that must merely FAIL to reach a
    // target is perfectly sensible against a target larger than the window, and in
    // fact that is the normal shape of a seasonal chill requirement.
    if (comparison === 'atLeast' && dwellHours >= lookbackHours) {
      throw new Error(
        `dwellHours (${dwellHours}) must be less than lookbackHours (${lookbackHours}) ` +
          'for comparison "atLeast" — a dwell cannot outlast the window it is measured ' +
          'in, so this check could never fire',
      );
    }
    if (maxGapHours <= 0) throw new Error('maxGapHours must be positive');
    if (clearDwellHours < 0) throw new Error('clearDwellHours must not be negative');

    const scope = resolveScope(ctx.params);
    const gate = gatePaths ? { paths: gatePaths, band: gateBand } : null;
    const rows = await bandDwell(
      ctx, paths, band, lookbackHours, maxGapHours, gate, scope, mode,
    );

    if (rows.length === 0) {
      ctx.log.debug('no device reports any candidate path', { paths: pathsLabel(paths) });
      return [];
    }

    const label = bandLabel(band, unit);
    const findings: Finding[] = [];

    for (const r of rows) {
      const open = ctx.openDevEuis.has(r.devEui);

      // Which sample count matters depends on the direction of the question. For
      // "did it accumulate enough" the evidence is how much of the window was
      // observed at all; for "has it been in band long enough" it is the run itself.
      const evidence = comparison === 'atMost' ? r.windowSamples : r.samples;
      if (evidence < minSamples) {
        if (comparison === 'atMost') {
          ctx.log.debug('not judged — too few readings to call a shortfall', {
            device: r.devEui, windowSamples: r.windowSamples, minSamples,
          });
        }
        continue;
      }

      // Hysteresis widens the target in whichever direction keeps an open alert open.
      const target =
        comparison === 'atLeast'
          ? open ? dwellHours - clearDwellHours : dwellHours
          : open ? dwellHours + clearDwellHours : dwellHours;

      const breached = comparison === 'atLeast' ? r.hours >= target : r.hours < target;
      if (!breached) continue;

      const name = r.deviceName ?? r.devEui;
      const word = mode === 'total' ? 'accumulated' : 'held';

      findings.push({
        devEui: r.devEui,
        deviceName: r.deviceName,
        summary:
          comparison === 'atLeast'
            ? `${name} ${r.matchedPath} ${word} ${label} for ${round(r.hours, 1)}h ` +
              `over ${lookbackHours}h (raises at ${dwellHours}h)`
            : `${name} ${r.matchedPath} only ${word} ${label} for ${round(r.hours, 1)}h ` +
              `over ${lookbackHours}h — short of ${dwellHours}h`,
        detail: {
          measurement: r.matchedPath,
          dwellHours: round(r.hours, 2),
          targetHours: dwellHours,
          comparison,
          mode,
          band: label,
          ...(mode === 'longest'
            ? { startedAt: r.startedAt, endedAt: r.endedAt }
            : {}),
          samples: r.samples,
          windowSamples: r.windowSamples,
          lookbackHours,
        },
      });
    }

    return findings;
  },
};

export default rule;
