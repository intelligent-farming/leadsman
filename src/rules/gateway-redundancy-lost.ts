/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * gateway-redundancy-lost — a device that used to be heard by several gateways is now
 * heard by one.
 *
 * Every other check here reports a fault. This one reports that a fault has *already
 * happened* and has not yet had a consequence — which on a farm is the only kind of alert
 * that saves a drive.
 *
 * A device heard by three gateways survives losing two of them. The same device heard by
 * one is one gateway failure away from silence, and nothing in the telemetry looks any
 * different: uplinks arrive, they decode, the values are fine, RSSI on the surviving link
 * may be excellent. `signal-degraded` cannot see it, because the best link is still good;
 * it measures the quality of the connection that carried the uplink, not how many
 * connections there were. It already computes the gateway count per uplink and reports it
 * as `avgGatewaysPerUplink` — informational only, thresholded by nothing. This is that
 * number given a threshold.
 *
 * Maximum rather than average, deliberately. An average falls whenever a distant gateway
 * starts hearing a device intermittently, which is a gain in coverage showing up as a
 * loss in the metric. The maximum only falls when a gateway that used to hear the device
 * reliably has stopped — which is the actual event.
 *
 * Disabled by default because the right threshold is a property of the site plan. Two
 * gateways is comfortable redundancy on a compact block and nowhere near enough across a
 * valley, and a single-gateway deployment would raise this for its entire fleet on the
 * first sounding.
 */

import { gatewayRedundancy } from '../gateway';
import { int } from '../params';
import { resolveScope, SCOPE_PARAMS } from '../scope';
import type { Finding, Rule } from '../types';

const rule: Rule = {
  id: 'gateway-redundancy-lost',
  description:
    'Flags devices that used to be received by several gateways and are now received by ' +
    'fewer than the minimum. A leading indicator: the coverage is already gone, the ' +
    'device just has not been cut off yet.',
  defaultSeverity: 'info',
  /**
   * A fact, and an informational one. Routed to null by any config that sends info
   * nowhere, which is the right default — this is a check to read when planning a site
   * visit, not one to be woken by.
   */
  defaultRouting: 'fact',
  defaultParams: {
    /**
     * Gateways a device should currently be heard by. Below this → alert.
     *
     * Two is the smallest number that means anything: it is the difference between "a
     * gateway failure loses this device" and "a gateway failure does not".
     */
    minGateways: 2,
    /** Window establishing what the device's coverage used to be. */
    historyHours: 336,
    /** Recent window judged against that history. */
    recentHours: 24,
    /**
     * The device must previously have reached at least this many gateways.
     *
     * Without it, every device that has only ever had one gateway is reported as having
     * lost redundancy it never had — which on a single-gateway site is the whole fleet.
     * This check is about a decline, so there has to have been something to decline from.
     */
    minHistoricalGateways: 2,
    /** Skip devices with fewer recent uplinks than this — too few to conclude anything. */
    minRecentUplinks: 10,
    /** Skip devices with fewer historical uplinks than this. */
    minHistoricalUplinks: 50,
    /** Narrow this check to part of the fleet — see src/scope.ts. */
    ...SCOPE_PARAMS,
  },
  requires: [{ table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'rx_info'] }],

  async run(ctx) {
    const minGateways = int(ctx.params, 'minGateways');
    const historyHours = int(ctx.params, 'historyHours');
    const recentHours = int(ctx.params, 'recentHours');
    const minHistoricalGateways = int(ctx.params, 'minHistoricalGateways');
    const minRecentUplinks = int(ctx.params, 'minRecentUplinks');
    const minHistoricalUplinks = int(ctx.params, 'minHistoricalUplinks');

    if (recentHours >= historyHours) {
      throw new Error(
        `recentHours (${recentHours}) must be shorter than historyHours (${historyHours}) — ` +
          'the recent window is compared against the history that contains it',
      );
    }
    if (minHistoricalGateways < minGateways) {
      throw new Error(
        `minHistoricalGateways (${minHistoricalGateways}) must be at least minGateways ` +
          `(${minGateways}) — a device cannot lose redundancy it never had`,
      );
    }

    const scope = resolveScope(ctx.params);
    const rows = await gatewayRedundancy(ctx, historyHours, recentHours, scope);

    const findings: Finding[] = [];
    for (const d of rows) {
      if (d.recentUplinks < minRecentUplinks) continue;
      if (d.historicalUplinks < minHistoricalUplinks) continue;
      if (d.historicalMax < minHistoricalGateways) continue;
      if (d.recentMax >= minGateways) continue;

      const label = d.deviceName ?? d.devEui;
      findings.push({
        devEui: d.devEui,
        deviceName: d.deviceName,
        summary:
          `${label} is now reaching ${d.recentMax} gateway${d.recentMax === 1 ? '' : 's'} ` +
          `(was ${d.historicalMax} over ${Math.round(historyHours / 24)}d) — ` +
          `${d.recentMax === 1 ? 'one gateway failure will cut it off' : 'redundancy reduced'}`,
        detail: {
          recentMaxGateways: d.recentMax,
          historicalMaxGateways: d.historicalMax,
          minGateways,
          recentUplinks: d.recentUplinks,
          historicalUplinks: d.historicalUplinks,
          recentHours,
          historyHours,
        },
      });
    }

    return findings;
  },
};

export default rule;
