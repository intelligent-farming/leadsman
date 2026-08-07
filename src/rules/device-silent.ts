/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * device-silent — a device that was reporting has stopped.
 *
 * This is the check an uplink-driven rule engine structurally cannot do: you
 * cannot trigger on the absence of a message. It needs a periodic sounding, which
 * is the main reason Leadsman runs on a schedule at all.
 *
 * The device inventory is derived from the event store itself — any DevEUI seen
 * within `inventoryHours` is considered in service. That avoids maintaining a
 * separate device list, at the cost of eventually forgetting a device that has
 * been silent longer than the inventory window (by then it is decommissioned or
 * someone has already noticed).
 */

import { int, round } from '../params';
import { resolveScope, scopeClause, SCOPE_PARAMS } from '../scope';
import type { Rule } from '../types';

interface Row {
  dev_eui: string;
  device_name: string | null;
  last_seen: string;
  silent_minutes: string;
  uplinks: string;
}

const rule: Rule = {
  id: 'device-silent',
  description:
    'Flags devices that reported recently enough to be considered in service but ' +
    'have not sent an uplink within the silence threshold. Catches dead batteries, ' +
    'gateway coverage loss, and physically damaged nodes.',
  defaultSeverity: 'critical',
  defaultParams: {
    /** No uplink for this long → alert. */
    silentMinutes: 180,
    /** A DevEUI seen within this window counts as in service. */
    inventoryHours: 168,
    /** Ignore devices with fewer than this many uplinks — filters out one-off joins. */
    minUplinks: 5,
    /**
     * Narrow this check to part of the fleet — see src/scope.ts. Useful when hardware
     * families have very different reporting intervals, since a single silence
     * threshold cannot suit a 15-minute soil probe and an hourly pressure logger.
     */
    ...SCOPE_PARAMS,
  },
  requires: [{ table: 'event_up', columns: ['dev_eui', 'device_name', 'time'] }],

  async run(ctx) {
    const silentMinutes = int(ctx.params, 'silentMinutes');
    const inventoryHours = int(ctx.params, 'inventoryHours');
    const minUplinks = int(ctx.params, 'minUplinks');
    const sc = scopeClause(resolveScope(ctx.params), 4);

    // One aggregate query, bounded by time, grouped server-side. The HAVING clause
    // does the comparison in Postgres so only breaching devices cross the wire.
    const rows = await ctx.query<Row>(
      `SELECT dev_eui,
              max(device_name)                                        AS device_name,
              max(time)                                               AS last_seen,
              round(EXTRACT(EPOCH FROM (now() - max(time))) / 60)     AS silent_minutes,
              count(*)                                                AS uplinks
         FROM event_up
        WHERE time > now() - make_interval(hours => $1::int)
          ${sc.sql}
        GROUP BY dev_eui
       HAVING count(*) >= $2::int
          AND max(time) < now() - make_interval(mins => $3::int)
        ORDER BY max(time) ASC`,
      [inventoryHours, minUplinks, silentMinutes, ...sc.values],
    );

    return rows.map((row) => {
      const minutes = Number(row.silent_minutes);
      const label = row.device_name ?? row.dev_eui;
      const forText =
        minutes >= 1440
          ? `${round(minutes / 1440, 1)}d`
          : minutes >= 60
            ? `${round(minutes / 60, 1)}h`
            : `${minutes}m`;

      return {
        devEui: row.dev_eui,
        deviceName: row.device_name,
        summary: `${label} has not reported for ${forText} (threshold ${silentMinutes}m)`,
        detail: {
          lastSeen: row.last_seen,
          silentMinutes: minutes,
          thresholdMinutes: silentMinutes,
          uplinksInWindow: Number(row.uplinks),
        },
      };
    });
  },
};

export default rule;
