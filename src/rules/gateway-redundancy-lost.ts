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
 * connections there were. It already reports an average gateway count per uplink as
 * `avgGatewaysPerUplink` — informational only, thresholded by nothing, and counted as
 * rx_info entries. This check counts distinct gateway ids per uplink instead, so a
 * gateway reporting one uplink through two boards or antennas is one gateway.
 *
 * The two windows use different statistics on purpose (see gatewayRedundancy):
 *
 *   history  a *typical* level — the device "used to reach N" only if at least
 *            `minHistoricalShare` of its historical uplinks reached N or more gateways.
 *            Not the maximum: one stray double reception in fourteen days would set a
 *            maximum of 2 on a device that has only ever really had one gateway.
 *   recent   the maximum. It only has to say whether any recent uplink still reached
 *            N, and a gateway that still hears the device now and then has not been
 *            lost — which errs toward not raising.
 *
 * Disabled by default because the right threshold is a property of the site plan. Two
 * gateways is comfortable redundancy on a compact block and nowhere near enough across a
 * valley, and a single-gateway deployment would raise this for its entire fleet on the
 * first sounding.
 */

import { gatewayRedundancy } from '../gateway';
import { int, num } from '../params';
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
    /**
     * Share of historical uplinks (0–1) that must have reached a gateway count for it to
     * count as the device's historical level.
     *
     * 0.5 means "at least half its uplinks reached N gateways" — a typical level rather
     * than a best-ever one. Lower it for a device whose second gateway was always
     * marginal but still counted on; 1.0 demands every historical uplink reached N.
     */
    minHistoricalShare: 0.5,
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
    const minHistoricalShare = num(ctx.params, 'minHistoricalShare');

    if (!(minHistoricalShare > 0) || minHistoricalShare > 1) {
      throw new Error(`minHistoricalShare must be in (0, 1] (got ${minHistoricalShare})`);
    }

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
    const rows = await gatewayRedundancy(ctx, historyHours, recentHours, minHistoricalShare, scope);

    const findings: Finding[] = [];
    for (const d of rows) {
      if (d.recentUplinks < minRecentUplinks) continue;
      if (d.historicalUplinks < minHistoricalUplinks) continue;
      if (d.historicalLevel < minHistoricalGateways) continue;
      if (d.recentMax >= minGateways) continue;

      const label = d.deviceName ?? d.devEui;
      findings.push({
        devEui: d.devEui,
        deviceName: d.deviceName,
        summary:
          `${label} is now reaching ${d.recentMax} gateway${d.recentMax === 1 ? '' : 's'} ` +
          `(was ${d.historicalLevel} over ${Math.round(historyHours / 24)}d) — ` +
          `${d.recentMax === 1 ? 'one gateway failure will cut it off' : 'redundancy reduced'}`,
        detail: {
          recentMaxGateways: d.recentMax,
          // The level the decline is measured from, and the share that defines it.
          historicalGateways: d.historicalLevel,
          minHistoricalShare,
          // Best-ever, for context only — not what the comparison uses.
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
