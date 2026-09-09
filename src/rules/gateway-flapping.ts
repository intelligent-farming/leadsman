/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * gateway-flapping — a gateway that keeps dropping out and coming back.
 *
 * `gateway-silent` catches a gateway that stopped. This catches the one that never quite
 * stops, which is both more common in the field and much harder to notice. A PoE injector
 * on a failing capacitor, a rodent-chewed ethernet run, a solar-and-battery site browning
 * out at dawn, a 4G backhaul with marginal signal — each produces minutes of downtime at a
 * time, repeatedly, and no single gap is ever long enough to trip a silence threshold.
 *
 * The damage is not the downtime. It is that every uplink arriving during a gap is simply
 * gone: LoRaWAN uplinks are fire-and-forget, so a device transmitting into a dead gateway
 * has no idea and never retries. Data loss is silent, spread thin, and shows up much later
 * as gaps in a season's readings that nobody can account for.
 *
 * Counting *runs* of empty buckets rather than empty buckets is what makes this a
 * different check from silence rather than a fuzzier one: one clean ten-minute outage and
 * ten scattered one-minute outages have identical downtime and completely different
 * causes. Only the second is flapping, and only the second means the hardware is failing
 * rather than something having happened to it.
 */

import { forDuration, gatewayContinuity, RX_INFO_REQUIREMENT } from '../gateway';
import { int } from '../params';
import { GATEWAY_SCOPE_PARAMS, resolveGatewayScope } from '../scope';
import { gatewaySubject } from '../subject';
import type { Finding, Rule } from '../types';

const rule: Rule = {
  id: 'gateway-flapping',
  description:
    'Flags a gateway whose reception record has repeated gaps rather than one continuous ' +
    'run. Catches failing power, marginal backhaul, and intermittent hardware, none of ' +
    'which stay down long enough for a silence threshold to notice.',
  defaultSeverity: 'warning',
  /**
   * A fact: the gateway is named and the dropout count is the evidence. Warning rather
   * than critical because the site is still working — this is the alert you want a week
   * before gateway-silent fires for real.
   */
  defaultRouting: 'fact',
  defaultParams: {
    /**
     * Window to judge continuity over. Long enough to see a pattern, short enough that a
     * gateway fixed last week is not still being reported.
     */
    lookbackHours: 24,
    /**
     * Bucket width, in minutes.
     *
     * This is the resolution of the whole check and it has a floor: it must be
     * comfortably longer than the fleet's uplink interval, or normal quiet between
     * uplinks reads as a dropout. Fifteen minutes suits the common 5–10 minute reporting
     * intervals. Raise it for a fleet that reports hourly, or this will flap about
     * flapping.
     */
    bucketMinutes: 15,
    /** Dropout-and-recovery cycles in the window before alerting. */
    minDropouts: 4,
    /**
     * Require the gateway to have been present for at least this fraction of the buckets
     * between its first and last reception (0–1).
     *
     * Separates flapping from mostly-absent. A gateway present in 5% of buckets is not
     * flapping, it is broken or was never really installed, and gateway-silent or a site
     * visit is the right answer rather than this.
     */
    minPresenceRatio: 0.3,
    /** Ignore gateways with fewer receptions than this — too little to judge. */
    minReceptions: 20,
    /** Narrow to specific gateways, or ignore known-transient ones — see src/scope.ts. */
    ...GATEWAY_SCOPE_PARAMS,
  },
  requires: [RX_INFO_REQUIREMENT],

  async run(ctx) {
    const lookbackHours = int(ctx.params, 'lookbackHours');
    const bucketMinutes = int(ctx.params, 'bucketMinutes');
    const minDropouts = int(ctx.params, 'minDropouts');
    const minPresenceRatio = Number(ctx.params.minPresenceRatio);
    const minReceptions = int(ctx.params, 'minReceptions');

    if (!(minPresenceRatio > 0) || minPresenceRatio > 1) {
      throw new Error(`minPresenceRatio must be in (0, 1] (got ${String(ctx.params.minPresenceRatio)})`);
    }
    if (bucketMinutes <= 0) throw new Error(`bucketMinutes must be positive (got ${bucketMinutes})`);

    const scope = resolveGatewayScope(ctx.params);
    const rows = await gatewayContinuity(ctx, lookbackHours, bucketMinutes, scope);

    const findings: Finding[] = [];
    for (const gw of rows) {
      if (gw.receptions < minReceptions) continue;
      if (gw.dropouts < minDropouts) continue;

      // Buckets spanned between first and last reception: the active ones plus the gaps
      // between them. A gateway commissioned midway through the window is judged only on
      // the part of the window it existed for.
      const spanned = gw.activeBuckets + gw.gapBuckets;
      if (spanned === 0) continue;
      const presence = gw.activeBuckets / spanned;
      if (presence < minPresenceRatio) continue;

      const lostMinutes = gw.gapBuckets * bucketMinutes;

      findings.push({
        subject: gatewaySubject(gw.gatewayId),
        summary:
          `gateway ${gw.gatewayId} dropped out ${gw.dropouts} times in ${lookbackHours}h ` +
          `(${Math.round(presence * 100)}% present, about ${forDuration(lostMinutes)} of ` +
          `lost reception) — check its power and backhaul`,
        detail: {
          dropouts: gw.dropouts,
          bucketMinutes,
          activeBuckets: gw.activeBuckets,
          gapBuckets: gw.gapBuckets,
          presenceRatio: Math.round(presence * 1000) / 1000,
          // Approximate by construction — bucket resolution, not measured downtime —
          // and named that way so nobody quotes it as a figure.
          approxLostMinutes: lostMinutes,
          receptionsInWindow: gw.receptions,
          lastSeenAt: gw.lastSeen,
          lookbackHours,
        },
      });
    }

    return findings;
  },
};

export default rule;
