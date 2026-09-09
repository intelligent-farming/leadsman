/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * fleet-silent — nothing is arriving from anything.
 *
 * `device-silent` already reports a node that stopped reporting, and it is the most
 * useful check in the catalogue. It is also the wrong tool for an outage, for two
 * reasons that only show up when one happens.
 *
 * It is late. Its threshold has to be tolerant of the slowest device in the fleet — an
 * hourly logger cannot be called silent after twenty minutes — so the default is three
 * hours. That is the right number for one dead node and far too long for a site that
 * went dark, where the answer is already known within one sounding.
 *
 * And it names the wrong thing. Twelve devices behind a gateway all go silent together,
 * so twelve alerts arrive, each identifying a sensor, each of them working perfectly. The
 * one thing they have in common — the gateway, the backhaul, the network server, the box
 * — is the only thing that is actually broken, and it is the one thing none of them
 * mentions. On a deployment with a single SMS destination that is twelve texts at 3am
 * about the wrong subject.
 *
 * So this check asks a different question: is *anything* arriving? A whole fleet does not
 * fail at once. If every device is silent, the fault is in the one path they share, and
 * that is worth exactly one alert against the site rather than one per device.
 *
 * What the alert cannot do is say which link in that path broke, because from inside the
 * event store they look identical — a gateway that lost power, a gateway still forwarding
 * to an address the host no longer has, an unplugged backhaul, a stopped Gateway Bridge,
 * a stopped ChirpStack, a broken PostgreSQL integration. So `detail` carries the
 * discriminators that are available (are joins still landing? did the database just
 * restart? what is the host's forwarding address?) and the summary leads with the cause
 * that is overwhelmingly the most common in the field: the gateway can no longer reach
 * the network server.
 */

import { forDuration } from '../gateway';
import { int } from '../params';
import { resolveScope, scopeClause, SCOPE_PARAMS } from '../scope';
import { siteSubject } from '../subject';
import type { Rule } from '../types';

interface FleetRow {
  devices: string;
  last_uplink: string | null;
  silent_minutes: string | null;
  uplinks_in_window: string;
}

interface JoinRow {
  last_join: string | null;
  joins_recent: string;
}

const rule: Rule = {
  id: 'fleet-silent',
  description:
    'Flags the site when no device at all has sent an uplink within the threshold, while ' +
    'devices are known to be in service. One alert for a gateway, backhaul, network-server ' +
    'or host outage, instead of one per device.',
  defaultSeverity: 'critical',
  /**
   * A fact, and the reason this rule exists. `device-silent` is a situation because one
   * silent node is ambiguous — the reader has to work out whether it is the node or the
   * infrastructure. This check has already answered that question, so there is nothing
   * left to interpret and no reason to spend a model invocation on it.
   */
  defaultRouting: 'fact',
  defaultParams: {
    /**
     * No uplink from anything for this long → alert.
     *
     * Much shorter than device-silent's threshold on purpose: it does not have to
     * accommodate the slowest device in the fleet, because it is not asking about any
     * single device. It only has to be longer than the longest interval at which the
     * *fleet as a whole* reports, which on any real deployment is minutes.
     */
    silentMinutes: 30,
    /** A DevEUI seen within this window counts as in service — same as device-silent. */
    inventoryHours: 168,
    /**
     * Do not raise a site alert unless at least this many devices are in service.
     *
     * With one device, "the fleet is silent" and "that device is silent" are the same
     * statement, and device-silent says it better. Two is where a shared cause becomes
     * the more likely explanation than coincidence.
     */
    minDevices: 2,
    /** Narrow the fleet this check considers — see src/scope.ts. */
    ...SCOPE_PARAMS,
  },
  requires: [
    { table: 'event_up', columns: ['dev_eui', 'time'] },
    { table: 'event_join', columns: ['dev_eui', 'time'] },
  ],

  async run(ctx) {
    const silentMinutes = int(ctx.params, 'silentMinutes');
    const inventoryHours = int(ctx.params, 'inventoryHours');
    const minDevices = int(ctx.params, 'minDevices');
    const scope = resolveScope(ctx.params);
    // $1 inventoryHours, $2 silentMinutes, then the two the scope always consumes.
    const sc = scopeClause(scope, 3);

    // One row, always. The inventory and the silence are the same question at fleet
    // scale, so there is no reason for two round trips.
    const rows = await ctx.query<FleetRow>(
      `SELECT count(DISTINCT dev_eui)                                     AS devices,
              max(time)                                                   AS last_uplink,
              round(EXTRACT(EPOCH FROM (now() - max(time))) / 60)         AS silent_minutes,
              count(*) FILTER (
                WHERE time > now() - make_interval(mins => $2::int))      AS uplinks_in_window
         FROM event_up
        WHERE time > now() - make_interval(hours => $1::int)
          ${sc.sql}`,
      [inventoryHours, silentMinutes, ...sc.values],
    );

    const fleet = rows[0];
    if (!fleet) return [];

    const devices = Number(fleet.devices);
    const uplinksInWindow = Number(fleet.uplinks_in_window);

    // Nothing in the inventory at all is not silence — it is a deployment that has never
    // reported, or a scope that matches nothing. Saying "the whole fleet is down" about
    // an empty fleet would be a false alarm on every fresh install.
    if (devices < minDevices) return [];
    if (uplinksInWindow > 0) return [];

    const silent = fleet.silent_minutes === null ? null : Number(fleet.silent_minutes);
    if (silent === null) return [];

    // Are joins still landing? A device joining is a device whose uplinks reached the
    // network server, so joins-without-uplinks is a completely different fault from
    // silence on both — it points at the application layer or the codec, not the radio
    // path. Worth one extra query to avoid sending the operator to check the wrong thing.
    const joinRows = await ctx.query<JoinRow>(
      `SELECT max(time)                                                AS last_join,
              count(*) FILTER (
                WHERE time > now() - make_interval(mins => $1::int))   AS joins_recent
         FROM event_join
        WHERE time > now() - make_interval(hours => $2::int)`,
      [silentMinutes, inventoryHours],
    );
    const joinsRecent = Number(joinRows[0]?.joins_recent ?? 0);

    // The engine facts are gathered once per sounding; reading them costs nothing here
    // and they are exactly what someone triaging this needs in the first thirty seconds.
    const restartedRecently =
      ctx.engine.postmasterStartTime !== null &&
      Date.parse(ctx.engine.postmasterStartTime) > Date.now() - silentMinutes * 60_000;

    const cause = joinsRecent > 0
      ? 'joins are still arriving, so the radio path is up — suspect the payload path or the application'
      : 'check that the gateways can still reach this host';

    const where = ctx.engine.hostAddress ? ` at ${ctx.engine.hostAddress}` : '';

    return [
      {
        subject: siteSubject(),
        summary:
          `no uplinks from any of ${devices} devices for ${forDuration(silent)} ` +
          `(threshold ${silentMinutes}m) — ${cause}${joinsRecent > 0 ? '' : where}`,
        detail: {
          devicesInService: devices,
          lastUplinkAt: fleet.last_uplink,
          silentMinutes: silent,
          thresholdMinutes: silentMinutes,
          // The discriminators, in the order someone triaging would want them.
          joinsSinceThreshold: joinsRecent,
          lastJoinAt: joinRows[0]?.last_join ?? null,
          databaseRestartedRecently: restartedRecently,
          databaseStartedAt: ctx.engine.postmasterStartTime,
          hostForwardAddress: ctx.engine.hostAddress,
          inventoryHours,
        },
      },
    ];
  },
};

export default rule;
