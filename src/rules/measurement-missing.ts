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
 * The check works by comparison against the device's own history. Every candidate
 * path is tracked on its own: a path counts as established for a device once it has
 * been seen `minHistoricalSightings` times in `lookbackHours`, and it is missing when
 * the device has sent decodable uplinks in `recentHours` but none carrying it. One
 * finding per device names every established path that vanished — so a four-element
 * soil probe losing only its EC channel is caught, not just one losing its first
 * listed field.
 *
 * Listing aliases for one concept (`battery`, `power.voltage`) is still safe: a device
 * only reports the alias its codec emits, so the others never become established for
 * it. A device whose codec switched from one alias to another IS reported — the
 * re-provisioned-codec case above, which is what this check is for.
 *
 * "Decodable" means the uplink's `object` is a JSON object. Frames the codec failed on
 * are decode-failure's evidence; counting them here would raise a second alert for
 * the same fault, worded as if the codec were still working.
 */

import { int } from '../params';
import { pathPresence, pathsLabel, resolvePaths } from '../measurement';
import { resolveScope, SCOPE_PARAMS } from '../scope';
import type { Finding, Rule } from '../types';

const rule: Rule = {
  id: 'measurement-missing',
  description:
    'Flags devices that reported any of the listed measurements earlier in the window but ' +
    'have stopped, while still sending decodable uplinks — usually a codec or ' +
    'device-profile change. Each path is tracked separately and every vanished one is ' +
    'named. Catches the case where checks on that field go silently blind.',
  defaultSeverity: 'warning',
  /** A field that used to decode and stopped. The cause is nearly always the device
   *  profile's codec, so the action is known.
   */
  defaultRouting: 'fact',
  defaultParams: {
    /**
     * Vocabulary paths the device is expected to keep reporting. Each is checked on its
     * own — list every field of a multi-element probe, and aliases from different
     * codecs, in one entry.
     */
    paths: ['soil.moisture'],
    /** History window used to establish that the device ever reported the field. */
    lookbackHours: 168,
    /** Recent window in which the field is expected to still appear. */
    recentHours: 12,
    /** Require this many recent decodable uplinks before concluding a field is gone. */
    minRecentUplinks: 5,
    /**
     * Require this many historical sightings of a path, per device, so a one-off decode
     * is not a baseline.
     */
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

    if (recentHours <= 0) {
      throw new Error(
        'recentHours must be positive — an empty recent window holds no uplinks, so this ' +
          'check could never fire',
      );
    }
    if (recentHours >= lookbackHours) {
      throw new Error(
        `recentHours (${recentHours}) must be less than lookbackHours (${lookbackHours}) — ` +
          'the check compares a recent window against a longer history',
      );
    }

    const scope = resolveScope(ctx.params);
    const presence = await pathPresence(ctx, paths, lookbackHours, recentHours, scope);

    // Rows arrive per (device, path) in candidate order; group them per device so one
    // probe losing three fields is one alert naming three, not three alerts.
    const byDevice = new Map<string, typeof presence>();
    for (const p of presence) {
      const list = byDevice.get(p.devEui) ?? [];
      list.push(p);
      byDevice.set(p.devEui, list);
    }

    const findings: Finding[] = [];

    for (const [devEui, rows] of byDevice) {
      // Only paths with an established history of being reported by this device.
      const established = rows.filter((p) => p.everSeen >= minHistorical);
      if (established.length === 0) continue;
      // Only devices we know are still talking — otherwise this is device-silent's job.
      const recentUplinks = rows[0].recentUplinks;
      if (recentUplinks < minRecentUplinks) continue;
      // The fields still arriving are fine; the rest have vanished.
      const missing = established.filter((p) => p.recentSeen === 0);
      if (missing.length === 0) continue;

      const deviceName = rows[0].deviceName;
      const name = deviceName ?? devEui;
      const labels = missing.map((p) => p.matchedPath);
      findings.push({
        devEui,
        deviceName,
        summary:
          `${name} stopped reporting ${labels.join(', ')}: ${recentUplinks} uplinks in the ` +
          `last ${recentHours}h, none carrying ${missing.length > 1 ? 'them' : 'it'} — ` +
          "check the device profile's codec",
        detail: {
          // The first vanished path, kept under the single-path key for consumers that
          // read one measurement per alert; `measurements` is the full list.
          measurement: labels[0],
          measurements: labels,
          missing: missing.map((p) => ({
            measurement: p.matchedPath,
            historicalSightings: p.everSeen,
            lastSeenAt: p.lastSeenAt,
          })),
          stillReporting: established
            .filter((p) => p.recentSeen > 0)
            .map((p) => p.matchedPath),
          recentUplinks,
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
