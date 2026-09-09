/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * gateway-silent — a gateway that was forwarding uplinks has stopped.
 *
 * Between "one node is dead" and "the whole site is dark" sits the case that used to be
 * invisible: one gateway of several has gone, and the devices only it could hear went
 * with it. `fleet-silent` stays quiet because the rest of the fleet is fine.
 * `device-silent` fires once per orphaned device, none of which is broken. Nothing named
 * the gateway, because until now no check in this engine read a gateway identifier at all.
 *
 * The inventory comes from `rx_info`, so a gateway is in service if it has forwarded
 * anything inside `inventoryHours` — the same derivation `device-silent` uses for devices,
 * with the same trade-off: a gateway silent longer than the window drops out and stops
 * being reported, by which point it has been reported for a week or was never really
 * installed. Two consequences specific to gateways are worth knowing:
 *
 *   - A gateway with no devices in range never appears here at all. It has nothing to
 *     forward, so it leaves no trace in the event store however healthy it is. Detecting
 *     that one needs the network server's own record — see gateway-deaf.
 *   - A test gateway that appeared once during commissioning is, by this definition, a
 *     gateway that was in service and has stopped. `ignoreGateways` is how you say
 *     otherwise, and the alert detail names the EUI so it can be added.
 *
 * Silence here is measured against the gateway's own last reception, not the fleet's, so
 * a quiet night on a small deployment does not read as a gateway fault: if no device
 * transmitted, no gateway received, and the check has no evidence either way. That is
 * what `minReceptions` and the fleet-wide comparison below are for.
 */

import { forDuration, gatewayActivity, RX_INFO_REQUIREMENT } from '../gateway';
import { int } from '../params';
import { GATEWAY_SCOPE_PARAMS, resolveGatewayScope } from '../scope';
import { gatewaySubject } from '../subject';
import type { Finding, Rule } from '../types';

const rule: Rule = {
  id: 'gateway-silent',
  description:
    'Flags a gateway that was forwarding uplinks and has stopped, while other gateways ' +
    'are still forwarding. Catches a gateway that lost power, backhaul, or its route to ' +
    'the network server, and names the gateway instead of the devices behind it.',
  defaultSeverity: 'critical',
  /**
   * A fact: the summary names the gateway and how long it has been gone, and the action
   * is the same every time — go and look at that gateway.
   */
  defaultRouting: 'fact',
  defaultParams: {
    /** No reception forwarded by this gateway for this long → alert. */
    silentMinutes: 60,
    /** A gateway seen within this window counts as in service. */
    inventoryHours: 168,
    /**
     * Ignore gateways that forwarded fewer than this many receptions in the window.
     *
     * Filters out a gateway that appeared briefly — a neighbour's unit passing through
     * range, a handheld used during a survey — which was never part of this deployment
     * and would otherwise be reported silent from then until the inventory window
     * forgets it.
     */
    minReceptions: 20,
    /**
     * Require at least one other gateway to still be forwarding.
     *
     * Without this, a quiet fleet reads as every gateway failing simultaneously: no
     * device transmitted, so no gateway received, so all of them look silent. With it,
     * silence across every gateway at once falls through to fleet-silent, which is the
     * check that can actually tell the difference. Set false on a single-gateway site,
     * where there is no second opinion available and fleet-silent is the only backstop.
     */
    requireAnotherActive: true,
    /** Narrow to specific gateways, or ignore known-transient ones — see src/scope.ts. */
    ...GATEWAY_SCOPE_PARAMS,
  },
  requires: [RX_INFO_REQUIREMENT],

  async run(ctx) {
    const silentMinutes = int(ctx.params, 'silentMinutes');
    const inventoryHours = int(ctx.params, 'inventoryHours');
    const minReceptions = int(ctx.params, 'minReceptions');
    const requireAnotherActive = ctx.params.requireAnotherActive !== false;
    const scope = resolveGatewayScope(ctx.params);

    const activity = await gatewayActivity(ctx, inventoryHours, scope);
    const inService = activity.filter((g) => g.receptions >= minReceptions);
    if (inService.length === 0) return [];

    const silent = inService.filter((g) => g.silentMinutes >= silentMinutes);
    const active = inService.filter((g) => g.silentMinutes < silentMinutes);

    // Every gateway silent at once is a site-level event, not N gateway faults. Leaving
    // it to fleet-silent keeps one outage to one alert.
    if (requireAnotherActive && active.length === 0) {
      ctx.log.debug('every gateway is silent — leaving this to fleet-silent', {
        gateways: silent.length,
      });
      return [];
    }

    const findings: Finding[] = [];
    for (const gw of silent) {
      findings.push({
        subject: gatewaySubject(gw.gatewayId),
        summary:
          `gateway ${gw.gatewayId} has forwarded nothing for ${forDuration(gw.silentMinutes)} ` +
          `(threshold ${silentMinutes}m) — it was carrying ${gw.devices} ` +
          `device${gw.devices === 1 ? '' : 's'}` +
          (active.length > 0 ? `, ${active.length} other gateway(s) still forwarding` : ''),
        detail: {
          lastSeenAt: gw.lastSeen,
          firstSeenAt: gw.firstSeen,
          silentMinutes: gw.silentMinutes,
          thresholdMinutes: silentMinutes,
          // The count of devices this gateway was the receiver for is the blast radius,
          // and the number worth deciding urgency on.
          devicesHeard: gw.devices,
          receptionsInWindow: gw.receptions,
          gatewaysStillActive: active.length,
          inventoryHours,
        },
      });
    }

    return findings;
  },
};

export default rule;
