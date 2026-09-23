/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * response-missing — the action happened and nothing followed.
 *
 * `downlink-unacked` catches a command that was never acknowledged. This catches the
 * worse case, and the one that costs real money: a command that WAS acknowledged, by
 * a device that is online and reporting happily, whose physical effect never arrived.
 *
 *   - The flow meter turned over 4,000 litres and the root-zone probe never moved.
 *     A blocked lateral, a failed emitter, a pressure-compensating dripper clogged
 *     with iron — or the water ran straight past the root zone down a crack.
 *   - The valve reported open and line pressure stayed at zero.
 *   - The frost fans started and the temperature kept falling.
 *   - The heater ran and the glasshouse did not warm.
 *
 * This is the expensive silent failure on a farm, because the operator believes it
 * happened — the log says so, the counter advanced, every individual check is green —
 * and finds out at harvest. It is invisible to every per-measurement mechanism, since
 * both halves look individually healthy: the counter advanced (fine) and the moisture
 * is 22 % (fine, if unremarkable). Only their relationship is wrong.
 *
 * ## The mechanism
 *
 * A lagged correlation between two paths on one device. `mold-risk` correlates two
 * measurements inside a single uplink; this correlates a trigger with a response
 * separated by however long the physics takes.
 *
 *   trigger   a numeric path that INCREASED by at least `triggerDelta`. A monotonic
 *             counter advancing is the natural case — litres delivered, pump runtime,
 *             pulse count — and a 0/1 flag rising works identically at delta 1.
 *   response  a path expected to move by `minChange` in `direction` within
 *             `responseWindowHours`.
 *
 * Only triggers old enough for the response window to have fully elapsed count.
 * Without that the check reports every irrigation the moment it starts, before the
 * water could possibly have reached the probe, and the alert is guaranteed wrong
 * rather than merely likely to be.
 *
 * ## Routing
 *
 * A situation, and unambiguously so. "Water was delivered and soil moisture did not
 * rise" has at least four causes with four different crews — blocked line, failed
 * emitter, probe fault, or water moving somewhere the probe is not — and choosing
 * between them needs the block layout, the probe depth and what was done last week.
 */

import { int, num, round, str } from '../params';
import { pathsLabel, resolvePaths, triggerResponse } from '../measurement';
import { resolveScope, SCOPE_PARAMS } from '../scope';
import type { Finding, Rule } from '../types';

const rule: Rule = {
  id: 'response-missing',
  description:
    'Flags a device where a trigger measurement advanced — litres delivered, pump ' +
    'runtime, a valve flag — but the measurement that should have responded did not ' +
    'move within the expected lag. Catches irrigation that ran and did nothing.',
  defaultSeverity: 'warning',
  /**
   * A situation: the same symptom has several causes needing different people, and
   * separating them needs block layout and install history this engine does not hold.
   */
  defaultRouting: 'situation',
  defaultParams: {
    /**
     * Priority-ordered candidate paths for the ACTION. Must be numeric — a counter, or
     * a flag that decodes as 0/1. A true/false boolean does not cast and is silently
     * ignored, so point this at the counter where there is one.
     */
    paths: ['metering.water.total', 'pulse.total', 'device.runtime'],
    /** How far the trigger path must advance to count as an action having happened. */
    triggerDelta: 100,
    /** Priority-ordered candidate paths for the EFFECT. */
    responsePaths: ['soil.moisture'],
    /** Which way the response should move: "rising" or "falling". */
    direction: 'rising',
    /**
     * The response must move at least this much, in its own units, to count as having
     * happened. Set it above the sensor's noise floor — a probe that wanders ±0.4 %
     * will "respond" to anything if this is 0.2.
     */
    minChange: 2,
    /**
     * How long the effect is allowed to take. Water reaching a 30 cm probe through
     * heavy soil is hours, not minutes; a pressure transducer on the same valve is
     * seconds. Too short reports every irrigation as failed.
     */
    responseWindowHours: 6,
    /** How far back to look for a trigger. */
    lookbackHours: 48,
    /** Narrow this check to part of the fleet — see src/scope.ts. */
    ...SCOPE_PARAMS,
  },
  requires: [
    { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
  ],

  async run(ctx): Promise<Finding[]> {
    const paths = resolvePaths(ctx.params, 'paths');
    const responsePaths = resolvePaths(ctx.params, 'responsePaths');
    const triggerDelta = num(ctx.params, 'triggerDelta');
    const direction = str(ctx.params, 'direction');
    const minChange = num(ctx.params, 'minChange');
    const responseWindowHours = num(ctx.params, 'responseWindowHours');
    const lookbackHours = int(ctx.params, 'lookbackHours');

    if (direction !== 'rising' && direction !== 'falling') {
      throw new Error(`direction must be "rising" or "falling" (got "${direction}")`);
    }
    if (triggerDelta <= 0) throw new Error('triggerDelta must be positive');
    if (minChange <= 0) throw new Error('minChange must be positive');
    if (responseWindowHours <= 0) throw new Error('responseWindowHours must be positive');
    if (responseWindowHours >= lookbackHours) {
      throw new Error(
        `responseWindowHours (${responseWindowHours}) must be less than lookbackHours ` +
          `(${lookbackHours}) — no trigger could ever be old enough to judge`,
      );
    }

    const scope = resolveScope(ctx.params);
    const rows = await triggerResponse(
      ctx, paths, responsePaths, lookbackHours, triggerDelta,
      responseWindowHours, direction, scope,
    );

    if (rows.length === 0) {
      ctx.log.debug('no device shows a completed trigger with a response to judge', {
        trigger: pathsLabel(paths),
        response: pathsLabel(responsePaths),
      });
      return [];
    }

    const findings: Finding[] = [];

    for (const r of rows) {
      // Signed movement in the expected direction. A response that moved the WRONG
      // way counts as no movement, which is right: soil drying after irrigation is
      // not a partial success.
      const moved = direction === 'rising' ? r.change : -r.change;
      if (moved >= minChange) continue;

      const name = r.deviceName ?? r.devEui;
      const hoursAgo = round(
        (ctx.now.getTime() - new Date(r.triggeredAt).getTime()) / 3_600_000,
        1,
      );

      findings.push({
        devEui: r.devEui,
        deviceName: r.deviceName,
        summary:
          `${name} ${r.triggerPath} advanced ${round(r.triggerDelta, 1)} ${hoursAgo}h ago ` +
          `but ${r.responsePath} only moved ${round(moved, 2)} in ${responseWindowHours}h ` +
          `(expected ${minChange})`,
        detail: {
          trigger: r.triggerPath,
          triggerDelta: round(r.triggerDelta, 3),
          triggeredAt: r.triggeredAt,
          response: r.responsePath,
          direction,
          baseline: round(r.baseline, 3),
          reached: round(r.extreme, 3),
          moved: round(moved, 3),
          expectedChange: minChange,
          responseWindowHours,
          responseSamples: r.responseSamples,
        },
      });
    }

    return findings;
  },
};

export default rule;
