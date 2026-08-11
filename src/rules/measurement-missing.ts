/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * measurement-missing — a device that used to report a field has stopped, while its
 * uplinks keep arriving and decoding.
 *
 * `decode-failure` catches a codec producing nothing at all. This catches the subtler
 * case where the codec still decodes but a field has silently disappeared from the
 * output. Causes worth knowing about:
 *
 *   - A device profile re-provisioned with a different (or upstream, non-normalized)
 *     codec, so `soil.moisture` became `moisture` and every check on it went quiet.
 *   - A codec-version rollback that dropped a measurement.
 *   - A multi-probe node where one probe was unplugged and its field vanished
 *     rather than reading zero.
 *   - Firmware changing the payload so one sensor block no longer parses.
 *
 * This is the failure mode that makes an entire monitoring config quietly useless:
 * every check on the missing field simply stops matching that device, and — because
 * checks ignore devices that report none of their candidate paths — nothing fires.
 * Silence looks identical to health.
 *
 * The check works by comparison against the device's own history: it only considers
 * devices that reported one of the paths earlier in `lookbackHours`, and alerts when
 * they have uplinks in `recentHours` but none carrying the field.
 */

import { int } from '../params';
import { pathPresence, pathsLabel, resolvePaths } from '../measurement';
import { resolveScope, SCOPE_PARAMS } from '../scope';
import type { Finding, Rule } from '../types';

const rule: Rule = {
  id: 'measurement-missing',
  description:
    'Flags devices that reported a measurement earlier in the window but have stopped, ' +
    'while still sending decodable uplinks — usually a codec or device-profile change. ' +
    'Catches the case where checks on that field go silently blind.',
  defaultSeverity: 'warning',
  /** A field that used to decode and stopped. The cause is nearly always the device
   *  profile's codec, so the action is known.
   */
  defaultRouting: 'fact',
  defaultParams: {
    /** Candidate vocabulary paths the device is expected to keep reporting. */
    paths: ['soil.moisture'],
    /** History window used to establish that the device ever reported the field. */
    lookbackHours: 168,
    /** Recent window in which the field is expected to still appear. */
    recentHours: 12,
    /** Require this many recent uplinks before concluding the field is gone. */
    minRecentUplinks: 5,
    /** Require this many historical sightings, so a one-off decode is not a baseline. */
    minHistoricalSightings: 10,
    /** Narrow this check to part of the fleet — see src/scope.ts. */
    ...SCOPE_PARAMS,
  },
  requires: [
    { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
  ],

  async run(ctx): Promise<Finding[]> {
    const paths = resolvePaths(ctx.params, 'paths');
    const lookbackHours = int(ctx.params, 'lookbackHours');
    const recentHours = int(ctx.params, 'recentHours');
    const minRecentUplinks = int(ctx.params, 'minRecentUplinks');
    const minHistorical = int(ctx.params, 'minHistoricalSightings');

    if (recentHours >= lookbackHours) {
      throw new Error(
        `recentHours (${recentHours}) must be less than lookbackHours (${lookbackHours}) — ` +
          'the check compares a recent window against a longer history',
      );
    }

    const scope = resolveScope(ctx.params);
    const presence = await pathPresence(ctx, paths, lookbackHours, recentHours, scope);
    const findings: Finding[] = [];

    for (const p of presence) {
      // Only devices with an established history of reporting this field.
      if (p.everSeen < minHistorical) continue;
      // Only devices we know are still talking — otherwise this is device-silent's job.
      if (p.recentUplinks < minRecentUplinks) continue;
      // The field is still arriving; nothing to report.
      if (p.recentSeen > 0) continue;

      const name = p.deviceName ?? p.devEui;
      findings.push({
        devEui: p.devEui,
        deviceName: p.deviceName,
        summary:
          `${name} stopped reporting ${p.matchedPath}: ${p.recentUplinks} uplinks in the ` +
          `last ${recentHours}h, none carrying it — check the device profile's codec`,
        detail: {
          measurement: p.matchedPath,
          historicalSightings: p.everSeen,
          recentSightings: p.recentSeen,
          recentUplinks: p.recentUplinks,
          lastSeenAt: p.lastSeenAt,
          lookbackHours,
          recentHours,
          candidatePaths: pathsLabel(paths),
        },
      });
    }

    return findings;
  },
};

export default rule;
