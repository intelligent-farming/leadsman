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
 *
 * ── Division of labour with gateway-deaf ──
 * A gateway silent in rx_info is one of two faults, and the network server's registry is
 * what tells them apart: offline (power, backhaul, route — this check's diagnosis) or
 * online-but-hearing-nothing (concentrator, antenna, feeder — gateway-deaf's). The two
 * must not both fire for one unit, and the one with the evidence should be the one that
 * does, so when a ChirpStack connection is configured this check consults the registry
 * too and leaves a gateway ChirpStack has heard from within `onlineWithinMinutes` to
 * gateway-deaf. The registry is optional here, not a `needs`: unconfigured, or failing on
 * a given sounding, this check runs exactly as it would without it, because a gateway
 * outage is the last thing that should go unreported for want of an API call.
 *
 * The consequence to know: gateway-deaf fires only after its own `lookbackHours` (6 h by
 * default) of zero receptions, so an online-but-silent gateway is reported that much
 * later than an offline one. That is the price of not sending someone to check the power
 * on a gateway whose power is fine. If gateway-deaf is disabled, set
 * `onlineWithinMinutes` to null here, or online-but-silent gateways go unreported.
 */

import { forDuration, gatewayActivity, RX_INFO_REQUIREMENT } from '../gateway';
import { int } from '../params';
import { GATEWAY_SCOPE_PARAMS, resolveGatewayScope } from '../scope';
import { gatewaySubject } from '../subject';
import type { Finding, Rule, SoundingContext } from '../types';

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
    /**
     * Leave a gateway to gateway-deaf when ChirpStack's registry has heard from it within
     * this many minutes. Keep it equal to gateway-deaf's `onlineWithinMinutes` so the two
     * checks draw the online/offline line in the same place. Only consulted when a
     * `chirpstack` connection is configured; null disables the deferral — do that if
     * gateway-deaf is not enabled.
     */
    onlineWithinMinutes: 15 as number | null,
    /** Narrow to specific gateways, or ignore known-transient ones — see src/scope.ts. */
    ...GATEWAY_SCOPE_PARAMS,
  },
  requires: [RX_INFO_REQUIREMENT],

  async run(ctx) {
    const silentMinutes = int(ctx.params, 'silentMinutes');
    const inventoryHours = int(ctx.params, 'inventoryHours');
    const minReceptions = int(ctx.params, 'minReceptions');
    const requireAnotherActive = ctx.params.requireAnotherActive !== false;
    const onlineRaw = ctx.params.onlineWithinMinutes;
    const onlineWithinMinutes =
      onlineRaw === null || onlineRaw === undefined ? null : int(ctx.params, 'onlineWithinMinutes');
    const scope = resolveGatewayScope(ctx.params);

    const activity = await gatewayActivity(ctx, inventoryHours, scope);
    const inService = activity.filter((g) => g.receptions >= minReceptions);
    if (inService.length === 0) return [];

    const silentAll = inService.filter((g) => g.silentMinutes >= silentMinutes);
    const active = inService.filter((g) => g.silentMinutes < silentMinutes);

    // Gateways the registry says are online are gateway-deaf's (see header). Read only
    // when there is something silent to ask about, and never fatal.
    const online = silentAll.length > 0 && onlineWithinMinutes !== null
      ? await registryOnline(ctx, onlineWithinMinutes)
      : new Set<string>();
    const silent = silentAll.filter((g) => {
      if (!online.has(g.gatewayId)) return true;
      ctx.log.debug('gateway silent in rx_info but online in ChirpStack — gateway-deaf\'s', {
        gateway: g.gatewayId,
      });
      return false;
    });

    // Every gateway silent at once is a site-level event, not N gateway faults. Leaving
    // it to fleet-silent keeps one outage to one alert — for NEW raises. A gateway whose
    // gateway-silent alert is already open (it died before the rest of the site went
    // dark) keeps being reported: returning nothing would resolve that alert in the
    // middle of the outage it is part of, and re-raise and re-deliver it when traffic
    // resumes elsewhere.
    const deferring = requireAnotherActive && active.length === 0;
    if (deferring) {
      ctx.log.debug('every gateway is silent — leaving new raises to fleet-silent', {
        gateways: silent.length,
        keptOpen: silent.filter((g) => ctx.openSubjects.has(g.gatewayId)).length,
      });
    }
    const reported = deferring ? silent.filter((g) => ctx.openSubjects.has(g.gatewayId)) : silent;

    const findings: Finding[] = [];
    for (const gw of reported) {
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
          // Held open through a site-wide outage that fleet-silent owns.
          ...(deferring ? { siteWideOutage: true } : {}),
        },
      });
    }

    return findings;
  },
};

/**
 * Gateway ids ChirpStack's registry has heard from within `withinMinutes`.
 *
 * Empty when no connection is configured or the call fails — in which case this check
 * behaves as though the registry did not exist. That is the safe direction: the same
 * failure leaves gateway-deaf unable to run, so the gateway is still reported, here,
 * under the offline diagnosis, rather than by nobody.
 */
async function registryOnline(
  ctx: SoundingContext,
  withinMinutes: number,
): Promise<Set<string>> {
  if (!ctx.gateways) return new Set();
  try {
    const registered = await ctx.gateways.listGateways();
    const out = new Set<string>();
    for (const gw of registered) {
      if (!gw.lastSeenAt) continue;
      const ms = Date.parse(gw.lastSeenAt);
      if (Number.isNaN(ms)) continue;
      if ((Date.now() - ms) / 60_000 <= withinMinutes) out.add(gw.gatewayId.toLowerCase());
    }
    return out;
  } catch (err) {
    ctx.log.warn('could not read ChirpStack gateways — reporting silence without them', {
      error: (err as Error).message,
    });
    return new Set();
  }
}

export default rule;
