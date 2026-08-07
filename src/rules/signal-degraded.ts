/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * signal-degraded — link budget is deteriorating toward the edge of coverage.
 *
 * A leading indicator rather than a fault. A node whose RSSI has drifted down over
 * a season is usually telling you something physical: crop canopy grew over it, a
 * gateway antenna shifted, water got into a connector, or the enclosure moved. It
 * still works, right up until it doesn't — which is when device-silent fires and
 * someone drives out to a field.
 *
 * `rx_info` is a JSONB array with one entry per gateway that received the uplink.
 * The meaningful figure is the *best* gateway's RSSI per uplink (that is the link
 * that actually carried it), averaged over the window — not the mean across all
 * gateways, which drops as soon as a distant gateway starts hearing the device.
 */

import { int, num, round } from '../params';
import { resolveScope, scopeClause, SCOPE_PARAMS } from '../scope';
import type { Rule } from '../types';

interface Row {
  dev_eui: string;
  device_name: string | null;
  avg_rssi: string;
  min_rssi: string;
  avg_snr: string | null;
  uplinks: string;
  gateways: string;
}

const rule: Rule = {
  id: 'signal-degraded',
  description:
    'Flags devices whose average best-gateway RSSI (or SNR) over the window is at or ' +
    'below threshold. A leading indicator of coverage loss — enable it to get warning ' +
    'before a node goes silent.',
  defaultSeverity: 'info',
  defaultParams: {
    /** Window to average over. Long enough to smooth weather; short enough to notice. */
    lookbackHours: 72,
    /** Alert at or below this average RSSI, in dBm. */
    rssiThresholdDbm: -115,
    /** Alert at or below this average SNR, in dB. null disables the SNR bound. */
    snrThresholdDb: null,
    /** Skip devices with fewer uplinks than this — too few to average meaningfully. */
    minUplinks: 20,
    /** Narrow this check to part of the fleet — see src/scope.ts. */
    ...SCOPE_PARAMS,
  },
  requires: [
    { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'rx_info'] },
  ],

  async run(ctx) {
    const lookbackHours = int(ctx.params, 'lookbackHours');
    const rssiThreshold = num(ctx.params, 'rssiThresholdDbm');
    const minUplinks = int(ctx.params, 'minUplinks');
    const snrRaw = ctx.params.snrThresholdDb;
    const snrThreshold =
      snrRaw === null || snrRaw === undefined ? null : num(ctx.params, 'snrThresholdDb');

    const sc = scopeClause(resolveScope(ctx.params), 5);

    // jsonb_typeof guards against a ChirpStack version (or an integration quirk)
    // storing rx_info as something other than an array — without it, a single odd
    // row aborts the sounding.
    const rows = await ctx.query<Row>(
      `WITH per_uplink AS (
         SELECT dev_eui,
                device_name,
                (SELECT max((g->>'rssi')::numeric)
                   FROM jsonb_array_elements(rx_info) AS g
                  WHERE g ? 'rssi')                     AS best_rssi,
                (SELECT max((g->>'snr')::numeric)
                   FROM jsonb_array_elements(rx_info) AS g
                  WHERE g ? 'snr')                      AS best_snr,
                jsonb_array_length(rx_info)             AS gateway_count
           FROM event_up
          WHERE time > now() - make_interval(hours => $1::int)
            AND rx_info IS NOT NULL
            ${sc.sql}
            AND jsonb_typeof(rx_info) = 'array'
            AND jsonb_array_length(rx_info) > 0
       )
       SELECT dev_eui,
              max(device_name)          AS device_name,
              round(avg(best_rssi), 1)  AS avg_rssi,
              min(best_rssi)            AS min_rssi,
              round(avg(best_snr), 1)   AS avg_snr,
              count(*)                  AS uplinks,
              round(avg(gateway_count), 1) AS gateways
         FROM per_uplink
        WHERE best_rssi IS NOT NULL
        GROUP BY dev_eui
       HAVING count(*) >= $2::int
          AND (
                avg(best_rssi) <= $3::numeric
             OR ($4::numeric IS NOT NULL AND avg(best_snr) <= $4::numeric)
              )
        ORDER BY avg(best_rssi) ASC`,
      [lookbackHours, minUplinks, rssiThreshold, snrThreshold, ...sc.values],
    );

    return rows.map((row) => {
      const avgRssi = Number(row.avg_rssi);
      const avgSnr = row.avg_snr === null ? null : Number(row.avg_snr);
      const name = row.device_name ?? row.dev_eui;

      const snrPart = avgSnr === null ? '' : `, SNR ${avgSnr}dB`;
      return {
        devEui: row.dev_eui,
        deviceName: row.device_name,
        summary:
          `${name} link degraded: avg best-gateway RSSI ${avgRssi}dBm${snrPart} ` +
          `over ${lookbackHours}h (threshold ${rssiThreshold}dBm)`,
        detail: {
          avgRssiDbm: avgRssi,
          minRssiDbm: Number(row.min_rssi),
          avgSnrDb: avgSnr,
          rssiThresholdDbm: rssiThreshold,
          snrThresholdDb: snrThreshold,
          uplinks: Number(row.uplinks),
          avgGatewaysPerUplink: Number(row.gateways),
          lookbackHours,
        },
      };
    });
  },
};

export default rule;
