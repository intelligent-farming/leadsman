/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * decode-failure — uplinks are arriving but the payload codec is not decoding them.
 *
 * ChirpStack decodes server-side: the device profile's codec runs at ingest, and the
 * uplink event's `object` column holds the result. When `object` is NULL or empty,
 * the radio link is fine and the device is transmitting — but the measurement is
 * being thrown away.
 *
 * This is the failure mode that looks like nothing is wrong. Threshold checks stay
 * quiet because there is no value to compare, and device-silent stays quiet because
 * uplinks are still arriving. Without this check, a device profile provisioned with
 * a missing or broken codec can log data-free uplinks for months.
 *
 * Common causes: device onboarded before its codec existed, a codec-version rollback
 * that lost the decoder, or a firmware change altering the payload format.
 */

import { int, num, round } from '../params';
import { resolveScope, scopeClause, SCOPE_PARAMS } from '../scope';
import type { Rule } from '../types';

interface Row {
  dev_eui: string;
  device_name: string | null;
  device_profile_name: string | null;
  failed: string;
  total: string;
  last_failure: string;
}

const rule: Rule = {
  id: 'decode-failure',
  description:
    'Flags devices whose uplinks arrive with a NULL, JSON-null, or empty decoded ' +
    'object, meaning the device profile has a missing or broken payload codec. Silent ' +
    'under every other check, because the radio link is healthy.',
  defaultSeverity: 'warning',
  defaultParams: {
    /** Window to evaluate. */
    lookbackHours: 24,
    /** Need at least this many undecoded uplinks before alerting. */
    minFailures: 5,
    /**
     * Fraction of uplinks in the window that must be undecoded (0–1). Set to 1 to
     * alert only when nothing at all decodes; lower it to catch intermittent
     * decoder failures on variable-format payloads.
     */
    minFailureRatio: 0.5,
    /** Narrow this check to part of the fleet — see src/scope.ts. */
    ...SCOPE_PARAMS,
  },
  requires: [
    {
      table: 'event_up',
      columns: ['dev_eui', 'device_name', 'device_profile_name', 'time', 'object'],
    },
  ],

  async run(ctx) {
    const lookbackHours = int(ctx.params, 'lookbackHours');
    const minFailures = int(ctx.params, 'minFailures');
    const minFailureRatio = num(ctx.params, 'minFailureRatio');

    if (minFailureRatio <= 0 || minFailureRatio > 1) {
      throw new Error(`minFailureRatio must be in (0, 1] (got ${minFailureRatio})`);
    }

    const sc = scopeClause(resolveScope(ctx.params), 4);

    // Three distinct ways a codec can produce no data, all the same operational
    // problem:
    //   object IS NULL               no codec ran at all
    //   jsonb_typeof(object)='null'  the codec ran and returned JSON null. This is a
    //                                JSONB null, NOT a SQL NULL, so `IS NULL` misses
    //                                it — found on real ChirpStack data, where a device
    //                                with a stub decoder logged uplinks no check saw.
    //   object = '{}'                the codec returned an empty object
    const rows = await ctx.query<Row>(
      `SELECT dev_eui,
              max(device_name)         AS device_name,
              max(device_profile_name) AS device_profile_name,
              count(*) FILTER (WHERE object IS NULL OR jsonb_typeof(object) = 'null' OR object = '{}'::jsonb) AS failed,
              count(*)                 AS total,
              max(time) FILTER (WHERE object IS NULL OR jsonb_typeof(object) = 'null' OR object = '{}'::jsonb) AS last_failure
         FROM event_up
        WHERE time > now() - make_interval(hours => $1::int)
          ${sc.sql}
        GROUP BY dev_eui
       HAVING count(*) FILTER (WHERE object IS NULL OR jsonb_typeof(object) = 'null' OR object = '{}'::jsonb) >= $2::int
          AND count(*) FILTER (WHERE object IS NULL OR jsonb_typeof(object) = 'null' OR object = '{}'::jsonb)::numeric
              / count(*)::numeric >= $3::numeric
        ORDER BY failed DESC`,
      [lookbackHours, minFailures, minFailureRatio, ...sc.values],
    );

    return rows.map((row) => {
      const failed = Number(row.failed);
      const total = Number(row.total);
      const ratio = total > 0 ? failed / total : 0;
      const name = row.device_name ?? row.dev_eui;
      const profile = row.device_profile_name
        ? ` (profile "${row.device_profile_name}")`
        : '';

      return {
        devEui: row.dev_eui,
        deviceName: row.device_name,
        summary:
          `${name}${profile}: ${failed} of ${total} uplinks did not decode ` +
          `(${round(ratio * 100, 0)}%) — check the payload codec`,
        // Nothing decoding at all is a provisioning error; partial failure is more
        // likely a payload-format change worth looking at but not an outage.
        severity: ratio >= 0.99 ? 'critical' : undefined,
        detail: {
          deviceProfileName: row.device_profile_name,
          undecodedUplinks: failed,
          totalUplinks: total,
          failureRatio: round(ratio, 3),
          lastFailureAt: row.last_failure,
          lookbackHours,
        },
      };
    });
  },
};

export default rule;
