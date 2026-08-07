/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * join-churn — the device keeps rejoining the network.
 *
 * A healthy OTAA device joins once and then runs for months on that session. Repeated
 * joins mean the session keeps being lost, and every rejoin is expensive:
 *
 *   - The session resets, so queued downlinks are discarded — an actuator command
 *     silently disappears
 *   - ADR history is lost, so the device restarts at its slowest data rate, burning
 *     battery and airtime until it re-converges
 *   - A new DevAddr is issued each time, which breaks anything keyed on DevAddr
 *
 * Common causes, roughly in order of how often they turn out to be the answer: the device
 * is power-cycling (flat battery, loose terminal, watchdog reset); it cannot hear the
 * join-accept, so it retries forever while the network thinks it joined (see
 * `status-margin-low`); a frame-counter or key mismatch after the device was
 * re-provisioned elsewhere; or a duplicate DevEUI, with two units fighting over one
 * identity.
 *
 * The tell that distinguishes churn from a normal deployment burst is the ratio of joins
 * to uplinks. A device that joins nine times and delivers seven uplinks is not
 * commissioning — it is failing. That pattern showed up on a real store, and no other
 * check in this engine could see it: `device-silent` was quiet because uplinks were
 * arriving, and `decode-failure` only saw the payload problem.
 */

import { int, num, round } from '../params';
import { resolveScope, scopeClause, SCOPE_PARAMS } from '../scope';
import type { Rule } from '../types';

interface Row {
  dev_eui: string;
  device_name: string | null;
  joins: string;
  dev_addrs: string;
  uplinks: string;
  first_at: string;
  latest_at: string;
}

const rule: Rule = {
  id: 'join-churn',
  description:
    'Flags devices that rejoined the network more than a few times in the window, or ' +
    'whose joins are high relative to the uplinks they delivered. Each rejoin discards ' +
    'queued downlinks and resets ADR. Invisible to every other check.',
  defaultSeverity: 'warning',
  defaultParams: {
    /** Window to count joins over. */
    lookbackHours: 168,
    /** Alert above this many joins in the window. */
    maxJoins: 3,
    /**
     * Alert when joins/uplinks exceeds this, however few joins there were. A device
     * delivering fewer than ~10 uplinks per join is spending its life rejoining.
     * null disables the ratio test and leaves only maxJoins.
     */
    maxJoinsPerUplinkRatio: 0.1,
    /**
     * Ignore devices with fewer uplinks than this when applying the ratio test, so a
     * genuinely new device mid-commissioning is not flagged on its first day.
     */
    minUplinksForRatio: 5,
    /** Narrow this check to part of the fleet — see src/scope.ts. */
    ...SCOPE_PARAMS,
  },
  requires: [
    { table: 'event_join', columns: ['dev_eui', 'device_name', 'time', 'dev_addr'] },
    { table: 'event_up', columns: ['dev_eui', 'time'] },
  ],

  async run(ctx) {
    const lookbackHours = int(ctx.params, 'lookbackHours');
    const maxJoins = int(ctx.params, 'maxJoins');
    const minUplinksForRatio = int(ctx.params, 'minUplinksForRatio');
    const ratioRaw = ctx.params.maxJoinsPerUplinkRatio;
    const maxRatio =
      ratioRaw === null || ratioRaw === undefined ? null : num(ctx.params, 'maxJoinsPerUplinkRatio');

    if (maxJoins < 1) throw new Error('maxJoins must be at least 1');
    if (maxRatio !== null && maxRatio <= 0) {
      throw new Error('maxJoinsPerUplinkRatio must be positive, or null to disable');
    }

    // Scope params bind last, so the rule's own placeholders keep a stable order.
    const sc = scopeClause(resolveScope(ctx.params), 5);

    // Uplinks are counted in a correlated subquery rather than a join, so a device that
    // joined but has sent no uplinks at all still appears (with uplinks = 0) instead of
    // being dropped — that device is the worst case, not an absent one.
    const rows = await ctx.query<Row>(
      `SELECT j.dev_eui,
              max(j.device_name)              AS device_name,
              count(*)                        AS joins,
              count(DISTINCT j.dev_addr)      AS dev_addrs,
              (SELECT count(*) FROM event_up u
                WHERE u.dev_eui = j.dev_eui
                  AND u.time > now() - make_interval(hours => $1::int)) AS uplinks,
              min(j.time)                     AS first_at,
              max(j.time)                     AS latest_at
         FROM event_join j
        WHERE j.time > now() - make_interval(hours => $1::int)
          ${sc.sql}
        GROUP BY j.dev_eui
       HAVING count(*) > $2::int
          OR (
               $3::numeric IS NOT NULL
               AND (SELECT count(*) FROM event_up u
                     WHERE u.dev_eui = j.dev_eui
                       AND u.time > now() - make_interval(hours => $1::int)) >= $4::int
               AND count(*)::numeric
                   / GREATEST((SELECT count(*) FROM event_up u
                                WHERE u.dev_eui = j.dev_eui
                                  AND u.time > now() - make_interval(hours => $1::int)), 1)
                   > $3::numeric
             )
        ORDER BY count(*) DESC`,
      [lookbackHours, maxJoins, maxRatio, minUplinksForRatio, ...sc.values],
    );

    return rows.map((row) => {
      const joins = Number(row.joins);
      const uplinks = Number(row.uplinks);
      const addrs = Number(row.dev_addrs);
      const name = row.device_name ?? row.dev_eui;
      const ratio = uplinks > 0 ? joins / uplinks : null;

      // Distinct DevAddrs confirm these were real new sessions rather than repeated
      // join attempts the network rejected.
      const addrNote = addrs === joins ? `${addrs} new sessions` : `${addrs} distinct DevAddrs`;

      return {
        devEui: row.dev_eui,
        deviceName: row.device_name,
        summary:
          `${name} rejoined ${joins}× in ${lookbackHours}h (${addrNote}, ` +
          `${uplinks} uplinks) — session keeps dropping`,
        // Joining more often than it delivers data means the device is effectively down.
        severity: uplinks === 0 || (ratio !== null && ratio >= 1) ? 'critical' : undefined,
        detail: {
          joins,
          distinctDevAddrs: addrs,
          uplinksInWindow: uplinks,
          joinsPerUplink: ratio === null ? null : round(ratio, 3),
          maxJoins,
          maxJoinsPerUplinkRatio: maxRatio,
          firstJoinAt: row.first_at,
          latestJoinAt: row.latest_at,
          lookbackHours,
        },
      };
    });
  },
};

export default rule;
