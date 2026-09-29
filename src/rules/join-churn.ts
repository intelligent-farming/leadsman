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
 *
 * ── what fires ──────────────────────────────────────────────────────────────────
 * Three tests, any one of which raises:
 *
 *   joins > maxJoins                         absolute churn, whatever the uplinks
 *   joins > uplinks                          the device rejoins more often than it
 *                                            reports — effectively down. Runs however
 *                                            few uplinks there are, including none;
 *                                            minUplinksForRatio does not gate it
 *   joins / uplinks > maxJoinsPerUplinkRatio the softer, relative signal, only once the
 *                                            device has minUplinksForRatio uplinks
 *
 * The two relative tests need at least minJoinsForRatio joins (default 2). A single
 * join is how every OTAA session starts: a device commissioned an hour ago has one join
 * and perhaps no uplink yet, and a device on a daily interval that joined once this
 * week sits at one join per seven uplinks. Neither is churn. Two joins with fewer
 * uplinks than joins is — typically a device that never hears its join-accept and
 * keeps retrying, which is exactly the case nothing else in the engine sees.
 *
 * Severity escalates to critical when joins >= uplinks (uplinks = 0 included): the
 * device is joining at least as often as it delivers data.
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
    'Flags devices that rejoined the network more than a few times in the window, that ' +
    'joined more often than they delivered uplinks (including none at all), or whose ' +
    'joins are high relative to their uplinks. Each rejoin discards queued downlinks ' +
    'and resets ADR. Invisible to every other check.',
  defaultSeverity: 'warning',
  /** Repeated rejoins are a symptom, not a cause — failing battery under TX load, a
   *  coverage edge, or a gateway flapping. Worth correlating with signal and battery
   *  alerts on the same node before anyone is dispatched.
   */
  defaultRouting: 'situation',
  defaultParams: {
    /** Window to count joins over. */
    lookbackHours: 168,
    /** Alert above this many joins in the window, regardless of uplinks. */
    maxJoins: 3,
    /**
     * Alert when joins/uplinks exceeds this — at the default 0.1, more than one join per
     * ten uplinks. This is the soft, relative signal: a device delivering fewer than ~10
     * uplinks per session is spending much of its life rejoining. It is gated by
     * minUplinksForRatio and minJoinsForRatio. null disables it; maxJoins and the
     * joins-exceed-uplinks test still apply.
     *
     * Separately, and not gated by minUplinksForRatio, a device whose joins exceed its
     * uplinks in the window always raises (critical), provided it has at least
     * minJoinsForRatio joins — including a device with no uplinks at all.
     */
    maxJoinsPerUplinkRatio: 0.1,
    /**
     * Apply the maxJoinsPerUplinkRatio test only once the device has at least this many
     * uplinks in the window, so a genuinely new device mid-commissioning is not flagged
     * on its first day. Does not gate the joins-exceed-uplinks test.
     */
    minUplinksForRatio: 5,
    /**
     * Both relative tests (joins exceed uplinks, and maxJoinsPerUplinkRatio) need at
     * least this many joins. A single join is how every session starts, so it is never
     * churn on its own — 1 join / 0 uplinks is a device between its join-accept and its
     * first uplink. At least 1.
     */
    minJoinsForRatio: 2,
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
    // Absent from configs written before the parameter existed; the registry merges
    // defaults, but a direct caller may not.
    const minJoinsForRatio =
      ctx.params.minJoinsForRatio === undefined ? 2 : int(ctx.params, 'minJoinsForRatio');
    const ratioRaw = ctx.params.maxJoinsPerUplinkRatio;
    const maxRatio =
      ratioRaw === null || ratioRaw === undefined ? null : num(ctx.params, 'maxJoinsPerUplinkRatio');

    if (maxJoins < 1) throw new Error('maxJoins must be at least 1');
    if (minJoinsForRatio < 1) throw new Error('minJoinsForRatio must be at least 1');
    if (maxRatio !== null && maxRatio <= 0) {
      throw new Error('maxJoinsPerUplinkRatio must be positive, or null to disable');
    }

    // Scope params bind last, so the rule's own placeholders keep a stable order.
    const sc = scopeClause(resolveScope(ctx.params), 6);

    // Uplinks are counted in a correlated subquery rather than a join, so a device that
    // joined but has sent no uplinks at all still appears (with uplinks = 0) instead of
    // being dropped — that device is the worst case, not an absent one, and the
    // `joins > uplinks` arm below is what makes it fire.
    const rows = await ctx.query<Row>(
      `WITH j AS (
         SELECT j.dev_eui,
                max(j.device_name)              AS device_name,
                count(*)                        AS joins,
                count(DISTINCT j.dev_addr)      AS dev_addrs,
                min(j.time)                     AS first_at,
                max(j.time)                     AS latest_at
           FROM event_join j
          WHERE j.time > now() - make_interval(secs => $1::float8 * 3600)
            ${sc.sql}
          GROUP BY j.dev_eui
       ), c AS (
         SELECT j.*,
                (SELECT count(*) FROM event_up u
                  WHERE u.dev_eui = j.dev_eui
                    AND u.time > now() - make_interval(secs => $1::float8 * 3600)) AS uplinks
           FROM j
       )
       SELECT dev_eui, device_name, joins, dev_addrs, uplinks, first_at, latest_at
         FROM c
        WHERE joins > $2::int
           OR (joins >= $5::int
               AND (joins > uplinks
                    OR ($3::numeric IS NOT NULL
                        AND uplinks >= $4::int
                        AND joins::numeric / GREATEST(uplinks, 1) > $3::numeric)))
        ORDER BY joins DESC`,
      [lookbackHours, maxJoins, maxRatio, minUplinksForRatio, minJoinsForRatio, ...sc.values],
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
        // Joining at least as often as it delivers data means the device is effectively
        // down. uplinks = 0 is the limit of that, not a separate case.
        severity: joins >= uplinks ? 'critical' : undefined,
        detail: {
          joins,
          distinctDevAddrs: addrs,
          uplinksInWindow: uplinks,
          joinsPerUplink: ratio === null ? null : round(ratio, 3),
          maxJoins,
          maxJoinsPerUplinkRatio: maxRatio,
          minUplinksForRatio,
          minJoinsForRatio,
          trigger:
            joins > maxJoins ? 'maxJoins' : joins > uplinks ? 'joinsExceedUplinks' : 'ratio',
          firstJoinAt: row.first_at,
          latestJoinAt: row.latest_at,
          lookbackHours,
        },
      };
    });
  },
};

export default rule;
