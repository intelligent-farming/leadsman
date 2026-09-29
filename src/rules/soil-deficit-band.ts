/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * soil-deficit-band — a managed deficit drifting out of its band, and which way.
 *
 * Written for post-veraison regulated deficit irrigation in winegrapes, and useful
 * for any programme where the target is a band the block is meant to *live in*
 * rather than a line it must not cross: deficit irrigation in almonds and olives,
 * a controlled dry-down before harvest, a saturated-zone target in rice.
 *
 * After veraison a grower deliberately holds soil moisture below field capacity —
 * enough stress to concentrate colour and flavour, check berry size and stop
 * vegetative growth, not so much that the vine shuts down. Both ways out of that
 * band are expensive and they are opposite mistakes:
 *
 *   too dry    photosynthesis stops, sugar accumulation stalls, berries shrivel,
 *              and a badly stressed vine will drop leaves and expose fruit
 *   too wet    berries swell and can split, flavour dilutes, ripening is delayed,
 *              lateral growth restarts, and a dense wet canopy invites bunch rot
 *
 * ## Why a threshold is not enough
 *
 * `measurement-threshold` with `min` and `max` already catches both directions, and
 * for many deployments that is the right tool — it is cheaper and its summary names
 * the bound that broke. Reach for this rule instead when *persistence and asymmetry*
 * are the signal, because a threshold reports an instant and a deficit programme is
 * judged over days. These three break the same bounds and mean different things:
 *
 *   62 % of three days below the floor      under-watered — the set is too small
 *   30 % below and 30 % above               pulsed too hard — the set is too big and
 *                                           too infrequent; MORE water makes it worse
 *   one reading below at 04:00, back by 06  nothing happened
 *
 * Only a residency measurement separates them, and the middle case is the one an
 * operator most often gets backwards.
 *
 * ## What this rule does not know
 *
 * It does not know it is post-veraison. Leadsman has no crop, no phenology and no
 * growth stage — the only handles are `activeMonths` for the ripening window and a
 * scope pattern for the block. That is a real limit, not an oversight: the calendar
 * is a proxy for veraison and a warm year will move the date by weeks. Treat the
 * window as "roughly the right part of the season" and expect the agent, or the
 * grower, to supply the stage.
 *
 * It also does not know the soil. A floor of 18 % VWC is dry in clay and wet in
 * sand, so `fieldCapacity` and `wiltingPoint` are optional and, when supplied, add
 * the depletion fraction to the alert — the portable number an agronomist actually
 * reasons in. They do not change what fires; the band is always in measured units,
 * because a rule that silently reinterpreted its own bounds would be worse than one
 * that reports in the units of the sensor.
 *
 * ## Routing
 *
 * A situation, and clearly so. "Block 7 spent 62 % of three days below its deficit
 * floor" is true and not actionable on its own: whether to correct it depends on how
 * far off harvest is, the target wine style, crop load, and what the weather does
 * next — and late in the season the right answer is quite often to do nothing.
 */

import { int, num, optNum, round } from '../params';
import { bandResidency, pathsLabel, resolvePaths } from '../measurement';
import { resolveScope, SCOPE_PARAMS } from '../scope';
import type { Finding, Rule } from '../types';

/** Depletion as a fraction of total available water. 0 = field capacity, 1 = wilting. */
function depletion(value: number, fieldCapacity: number, wiltingPoint: number): number {
  const taw = fieldCapacity - wiltingPoint;
  return (fieldCapacity - value) / taw;
}

const rule: Rule = {
  id: 'soil-deficit-band',
  description:
    'Flags a block whose soil moisture is spending too much of the window outside its ' +
    'target deficit band, and reports which side and how persistently — under-watered, ' +
    'over-watered, or oscillating across both. For post-veraison RDI and similar.',
  defaultSeverity: 'warning',
  /**
   * A situation: correcting a deficit miss needs the harvest date, the target style,
   * the crop load and the forecast, and late in the season the answer is often to do
   * nothing. None of that is in the event store.
   */
  defaultRouting: 'situation',
  defaultParams: {
    /** Priority-ordered candidate vocabulary paths. Volumetric water content, %. */
    paths: ['soil.moisture'],
    /** Bottom of the target band, in the measurement's own units. */
    floor: 18,
    /** Top of the target band. Above it the deficit has been lost. */
    ceiling: 28,
    /**
     * The accounting window. Days, not hours — a deficit programme is judged over
     * irrigation cycles, and a window shorter than one set reports the set itself as
     * an excursion.
     */
    lookbackHours: 72,
    /**
     * Raise when more than this fraction of the OBSERVED time was outside the band.
     * Distinct from minCoverage below: this is a fraction of what was measured, that
     * is a fraction of the window that was measured at all.
     */
    maxOutOfBandFraction: 0.25,
    /**
     * Refuse to judge when less than this fraction of the window is accounted for
     * (above 0, at most 1). A block that reported for six hours of three days has not
     * demonstrated anything about its deficit, and saying so beats guessing. A block
     * with no attributed time at all is never judged, whatever this is set to.
     */
    minCoverage: 0.6,
    /** A reporting gap longer than this is attributed to no state at all. */
    maxGapHours: 6,
    /** A block needs this many readings before its residency means anything. */
    minSamples: 12,
    /**
     * Hysteresis, as a fraction. An open alert stays open until the out-of-band
     * fraction falls this far below the raise line, so a block sitting on the
     * boundary does not resolve and re-raise — and re-invoke the agent — every
     * sounding.
     */
    clearMarginFraction: 0.05,
    /**
     * Optional, and enrichment only: volumetric water content at field capacity and
     * at permanent wilting point, for this block's soil. Supplying both adds the
     * depletion fraction to the alert — the number that transfers between blocks,
     * where a raw VWC does not. Neither changes what fires.
     */
    fieldCapacity: null,
    wiltingPoint: null,
    /** Shown in the alert summary. */
    unit: '%',
    /** Narrow this check to ONE block — see src/scope.ts. */
    ...SCOPE_PARAMS,
  },
  requires: [
    { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
  ],

  async run(ctx): Promise<Finding[]> {
    const paths = resolvePaths(ctx.params, 'paths');
    const floor = num(ctx.params, 'floor');
    const ceiling = num(ctx.params, 'ceiling');
    const lookbackHours = int(ctx.params, 'lookbackHours');
    const maxOutOfBand = num(ctx.params, 'maxOutOfBandFraction');
    const minCoverage = num(ctx.params, 'minCoverage');
    const maxGapHours = num(ctx.params, 'maxGapHours');
    const minSamples = int(ctx.params, 'minSamples');
    const clearMarginFraction = optNum(ctx.params, 'clearMarginFraction') ?? 0;
    const fieldCapacity = optNum(ctx.params, 'fieldCapacity');
    const wiltingPoint = optNum(ctx.params, 'wiltingPoint');
    const unit = typeof ctx.params.unit === 'string' ? ctx.params.unit : '';

    if (floor >= ceiling) {
      throw new Error(
        `floor (${floor}) must be below ceiling (${ceiling}) — a band needs room ` +
          'between its bounds, and equal bounds would put every reading outside it',
      );
    }
    if (maxOutOfBand < 0 || maxOutOfBand >= 1) {
      throw new Error(
        `maxOutOfBandFraction must be at least 0 and below 1 (got ${maxOutOfBand}) — ` +
          'at 1 no amount of time outside the band could ever raise',
      );
    }
    if (!(minCoverage > 0) || minCoverage > 1) {
      throw new Error(
        `minCoverage must be between 0 and 1, and above 0 (got ${minCoverage}) — the ` +
          'fractions judged are of observed time, and at 0 a block observed for no time ' +
          'at all would be judged on 0/0',
      );
    }
    if (maxGapHours <= 0) throw new Error('maxGapHours must be positive');
    // Strictly less: an equal margin puts the hold line at 0, so an open alert could
    // never resolve while a single reading sat outside the band.
    if (clearMarginFraction < 0 || clearMarginFraction >= maxOutOfBand) {
      throw new Error(
        `clearMarginFraction (${clearMarginFraction}) must be at least 0 and less ` +
          `than maxOutOfBandFraction (${maxOutOfBand})`,
      );
    }
    // Both or neither: one alone cannot produce a depletion fraction, and silently
    // ignoring a half-configured pair would hide a config mistake.
    if ((fieldCapacity === null) !== (wiltingPoint === null)) {
      throw new Error(
        'fieldCapacity and wiltingPoint must be set together, or both left null',
      );
    }
    if (fieldCapacity !== null && wiltingPoint !== null && fieldCapacity <= wiltingPoint) {
      throw new Error(
        `fieldCapacity (${fieldCapacity}) must be above wiltingPoint (${wiltingPoint})`,
      );
    }

    const scope = resolveScope(ctx.params);
    const rows = await bandResidency(
      ctx, paths, floor, ceiling, lookbackHours, maxGapHours, scope,
    );
    if (rows.length === 0) {
      ctx.log.debug('no device reports any candidate path', { paths: pathsLabel(paths) });
      return [];
    }

    const findings: Finding[] = [];
    let judged = 0;
    let thin = 0;

    for (const r of rows) {
      if (r.samples < minSamples) continue;

      const coverage = r.coveredHours / lookbackHours;
      // coveredHours is 0 for a device whose readings are all one reading, or all
      // separated by gaps; the fractions below would be 0/0. Never judged.
      if (!(r.coveredHours > 0) || coverage < minCoverage) {
        thin += 1;
        ctx.log.debug('deficit band not judged — too little of the window is covered', {
          device: r.devEui, coverage: round(coverage, 2), minCoverage,
          gapHours: round(r.gapHours, 1),
        });
        continue;
      }
      judged += 1;

      // Fractions of OBSERVED time, not of the window: a gap is an absence of
      // evidence, and dividing by wall clock would let one quiet day dilute a real
      // excursion into looking acceptable.
      const belowFraction = r.hoursBelow / r.coveredHours;
      const aboveFraction = r.hoursAbove / r.coveredHours;
      const outFraction = belowFraction + aboveFraction;

      const open = ctx.openDevEuis.has(r.devEui);
      const threshold = open ? maxOutOfBand - clearMarginFraction : maxOutOfBand;
      if (outFraction <= threshold) continue;

      // Which fault this is. Both sides materially represented is a different
      // problem from either alone, and it is the one most often corrected backwards:
      // the instinct is to add water, and more water makes an oscillation worse.
      const bothSides =
        belowFraction > 0.1 && aboveFraction > 0.1 &&
        Math.min(belowFraction, aboveFraction) / Math.max(belowFraction, aboveFraction) > 0.4;
      const pattern = bothSides
        ? 'oscillating'
        : belowFraction >= aboveFraction
          ? 'below'
          : 'above';

      const verdict = bothSides
        ? `swinging across the band (${Math.round(belowFraction * 100)}% below, ` +
          `${Math.round(aboveFraction * 100)}% above) — sets too large and too far apart`
        : pattern === 'below'
          ? `${Math.round(belowFraction * 100)}% of the time below the ${floor}${unit} floor`
          : `${Math.round(aboveFraction * 100)}% of the time above the ${ceiling}${unit} ceiling`;

      const name = r.deviceName ?? r.devEui;
      const depletionNow =
        fieldCapacity !== null && wiltingPoint !== null
          ? depletion(r.lastValue, fieldCapacity, wiltingPoint)
          : null;

      findings.push({
        devEui: r.devEui,
        deviceName: r.deviceName,
        summary:
          `${name} ${r.matchedPath} out of its ${floor}-${ceiling}${unit} deficit band ` +
          `for ${Math.round(outFraction * 100)}% of the observed ` +
          `${round(r.coveredHours, 1)}h of the ${lookbackHours}h window: ${verdict}. ` +
          `Now ${round(r.lastValue, 1)}${unit}` +
          (depletionNow !== null ? ` (${Math.round(depletionNow * 100)}% depletion)` : '') +
          `, ${r.lastState === 'in' ? 'back in band' : r.lastState + ' band'}`,
        detail: {
          measurement: r.matchedPath,
          pattern,
          floor,
          ceiling,
          unit: unit || null,
          hoursBelow: round(r.hoursBelow, 1),
          hoursInBand: round(r.hoursInBand, 1),
          hoursAbove: round(r.hoursAbove, 1),
          outOfBandFraction: round(outFraction, 3),
          raisesAbove: maxOutOfBand,
          current: round(r.lastValue, 2),
          currentState: r.lastState,
          ...(depletionNow !== null
            ? {
                depletionFraction: round(depletionNow, 3),
                floorDepletion: round(depletion(floor, fieldCapacity!, wiltingPoint!), 3),
                ceilingDepletion: round(depletion(ceiling, fieldCapacity!, wiltingPoint!), 3),
              }
            : {}),
          coverage: round(coverage, 3),
          observedHours: round(r.coveredHours, 1),
          lookbackHours,
          samples: r.samples,
          lastAt: r.lastAt,
        },
      });
    }

    // Said once, and only when the check is inert. A deficit programme that is never
    // judged looks exactly like one that is on target.
    if (judged === 0 && thin > 0) {
      ctx.log.warn(
        'no block had enough of the window covered to judge its deficit band — this ' +
          'check is currently measuring nothing. Lower minCoverage, shorten ' +
          'lookbackHours, or raise maxGapHours to match the reporting interval',
        { devices: thin, minCoverage, lookbackHours },
      );
    }

    return findings;
  },
};

export default rule;
