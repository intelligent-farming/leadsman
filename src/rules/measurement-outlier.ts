/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * measurement-outlier — one device disagreeing with its neighbours.
 *
 * Every other check here is longitudinal: one device compared against its own past.
 * This is the cross-sectional one, and it catches a fault class the others
 * structurally cannot — the device that is *plausibly wrong*.
 *
 *   - A drifting probe. `measurement-stuck` catches one that died and
 *     `measurement-implausible` catches one reading nonsense. A probe reading 8 % low
 *     does neither: it passes every threshold, varies convincingly with the weather,
 *     and quietly biases every decision made from it. Its neighbours are the only
 *     ground truth available without a soil core.
 *   - Irrigation uniformity. Probes on one valve should move together. One that does
 *     not is a blocked line, a failed emitter, or a lateral somebody shut last season
 *     and forgot — and per-device checks cannot see it, because every probe is
 *     individually within range.
 *   - Frost inversion, which is by definition a difference between two heights.
 *
 * ## Why MAD rather than standard deviation
 *
 * The outlier being looked for would inflate a standard deviation enough to hide
 * inside it. With six probes on a valve, one bad sensor can raise σ past its own
 * error and land comfortably within two of them. The median absolute deviation does
 * not move when one member of the group goes wrong, which is the entire property
 * wanted here. The 1.4826 rescaling makes MAD comparable with σ for normal data, so a
 * threshold in "deviations" means roughly the usual thing.
 *
 * ## The group is the scope
 *
 * There is no separate grouping syntax: the group is whatever `deviceProfiles` or
 * `deviceNamePattern` selects, which is how every other check narrows a fleet.
 * Comparing a greenhouse probe with a dryland one produces a true statement about two
 * unrelated numbers, so ONE INSTANCE PER COMPARABLE GROUP is the intended shape —
 * `"deviceNamePattern": "%valve-7-%"` and one entry per valve.
 *
 * ## Routing
 *
 * A situation. "This probe reads 8 % below its neighbours" is not actionable on its
 * own: it is a miscalibrated sensor, or a genuinely drier corner of the block, or the
 * one probe actually installed at the right depth — and telling those apart needs the
 * install history and the block layout, which this engine does not hold.
 */

import { int, num, round } from '../params';
import { groupDeviation, pathsLabel, resolvePaths } from '../measurement';
import { resolveScope, scopeLabel, SCOPE_PARAMS } from '../scope';
import type { Finding, Rule } from '../types';

const rule: Rule = {
  id: 'measurement-outlier',
  description:
    'Flags a device whose recent mean deviates from its peer group by more than a ' +
    'number of median-absolute-deviations — a drifting probe, a blocked irrigation ' +
    'lateral. Scope each instance to ONE comparable group.',
  /**
   * Warning, not info, and the reason is mechanical rather than editorial: routing
   * consults `notify.bySeverity` BEFORE the fact/situation class, so an `info` rule
   * under the common `{"info": null}` policy is silenced before its `situation`
   * class is ever read. A rule cannot coherently be both "worth an agent's tokens"
   * and "too trivial to deliver". It also earns the level on its own — a probe
   * reading 8 % low biases every decision made from it until someone notices.
   */
  defaultSeverity: 'warning',
  /**
   * A situation: a sensor disagreeing with its neighbours is a calibration fault, a
   * real local difference, or the only correctly-installed probe of the set, and
   * telling those apart needs history this engine does not have.
   */
  defaultRouting: 'situation',
  defaultParams: {
    /** Priority-ordered candidate vocabulary paths. */
    paths: ['soil.moisture'],
    /** Raise when |deviation| exceeds this many rescaled MADs from the group median. */
    maxDeviations: 3,
    /**
     * "either" catches any disagreement; "below" and "above" catch one side. Use a
     * side when only one direction is a fault — a probe reading drier than its
     * neighbours is a blocked emitter, wetter is usually a leak, and they are
     * different jobs for different people.
     */
    direction: 'either',
    /**
     * Ignore a deviation smaller than this in measurement units, however many MADs it
     * is. A very uniform group has a tiny MAD, and without a floor every trivial
     * difference becomes a ten-sigma event.
     */
    minAbsoluteDifference: 3,
    /**
     * Refuse to judge a group smaller than this. Three devices is the minimum at
     * which "the odd one out" means anything; with two there is no majority, only
     * disagreement, and the check would report both.
     */
    minGroupSize: 4,
    /** Averaging window per device. Long enough to smooth diurnal phase differences. */
    lookbackHours: 24,
    /** A device needs this many readings in the window to be compared. */
    minSamples: 6,
    /** Shown in the alert summary. */
    unit: '%',
    /** Narrow this check to part of the fleet — and this IS the group. See src/scope.ts. */
    ...SCOPE_PARAMS,
  },
  requires: [
    { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
  ],

  async run(ctx): Promise<Finding[]> {
    const paths = resolvePaths(ctx.params, 'paths');
    const maxDeviations = num(ctx.params, 'maxDeviations');
    const direction = typeof ctx.params.direction === 'string' ? ctx.params.direction : 'either';
    const minAbsolute = num(ctx.params, 'minAbsoluteDifference');
    const minGroupSize = int(ctx.params, 'minGroupSize');
    const lookbackHours = int(ctx.params, 'lookbackHours');
    const minSamples = int(ctx.params, 'minSamples');
    const unit = typeof ctx.params.unit === 'string' ? ctx.params.unit : '';

    if (!['either', 'above', 'below'].includes(direction)) {
      throw new Error(`direction must be "either", "above", or "below" (got "${direction}")`);
    }
    if (maxDeviations <= 0) throw new Error('maxDeviations must be positive');
    if (minAbsolute < 0) throw new Error('minAbsoluteDifference must not be negative');
    if (minGroupSize < 3) {
      throw new Error(
        `minGroupSize must be at least 3 (got ${minGroupSize}) — with two devices ` +
          'there is no majority to be the odd one out of, and both would be reported',
      );
    }

    const scope = resolveScope(ctx.params);
    const rows = await groupDeviation(ctx, paths, lookbackHours, scope);

    const comparable = rows.filter((r) => r.samples >= minSamples);
    if (comparable.length === 0) {
      ctx.log.debug('no device reports any candidate path', { paths: pathsLabel(paths) });
      return [];
    }
    if (comparable.length < minGroupSize) {
      // Said out loud, because an under-sized group is the most likely reason this
      // check silently never fires — usually a scope pattern matching less than the
      // operator thought it did.
      ctx.log.warn('group too small to judge an outlier', {
        found: comparable.length,
        minGroupSize,
        scope: scopeLabel(scope) ?? 'the whole fleet',
      });
      return [];
    }

    const findings: Finding[] = [];

    for (const r of comparable) {
      if (r.deviations === null) continue; // the group is perfectly uniform
      const difference = r.value - r.groupMedian;

      if (Math.abs(difference) < minAbsolute) continue;
      if (Math.abs(r.deviations) <= maxDeviations) continue;
      if (direction === 'above' && difference <= 0) continue;
      if (direction === 'below' && difference >= 0) continue;

      const name = r.deviceName ?? r.devEui;
      const side = difference > 0 ? 'above' : 'below';

      findings.push({
        devEui: r.devEui,
        deviceName: r.deviceName,
        summary:
          `${name} ${r.matchedPath} averaged ${round(r.value, 1)}${unit}, ` +
          `${round(Math.abs(difference), 1)}${unit} ${side} the group median ` +
          `${round(r.groupMedian, 1)}${unit} (${round(Math.abs(r.deviations), 1)} MAD, ` +
          `${r.groupSize} devices)`,
        detail: {
          measurement: r.matchedPath,
          value: round(r.value, 3),
          groupMedian: round(r.groupMedian, 3),
          difference: round(difference, 3),
          deviations: round(r.deviations, 2),
          maxDeviations,
          groupSize: r.groupSize,
          groupSpread: round(r.groupSpread, 3),
          unit: unit || null,
          samples: r.samples,
          lookbackHours,
          scope: scopeLabel(scope),
        },
      });
    }

    return findings;
  },
};

export default rule;
