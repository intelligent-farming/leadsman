/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * gateway-deaf — the gateway is online and hearing nothing.
 *
 * This is the gateway fault that no amount of SQL over the event store can find, and the
 * reason src/chirpstack.ts exists at all.
 *
 * A gateway has two halves. The backhaul half talks to the network server over IP, sends
 * its stats, keeps its connection alive, and reports itself present. The radio half
 * listens for LoRa frames on the concentrator. When the second half fails — a dead SX130x,
 * an antenna knocked off its mount, a coax connector full of water, a lightning-arrestor
 * that took a hit — the first half carries on perfectly. ChirpStack shows the gateway
 * ONLINE. The web UI is green. And not one uplink is being received.
 *
 * Every rx_info-derived check is structurally blind to this, because a gateway that
 * receives nothing writes nothing into rx_info: it is simply absent from the telemetry,
 * exactly like a gateway that was never installed. Absence is the symptom, and absence is
 * unobservable from the data alone. You need something that knows the gateway is supposed
 * to be there, which is the network server's own registry.
 *
 * So: `lastSeenAt` fresh (ChirpStack heard from it recently — the backhaul is fine)
 * combined with no receptions in rx_info (the radio is not delivering) is the signature.
 *
 * One genuine ambiguity, handled by `minPeerReceptions`: a gateway can be perfectly
 * healthy and hear nothing because there is nothing in range to hear — a unit sited ahead
 * of the devices that will eventually sit under it, or one covering a field that is out of
 * season. Alerting on that would be crying wolf about a gateway doing its job. The
 * discriminator is whether the *rest* of the site is hearing traffic: if other gateways
 * are busy and this one has heard nothing at all, coverage is not the explanation.
 */

import { forDuration, gatewayActivity, gatewayLabel, RX_INFO_REQUIREMENT } from '../gateway';
import { int } from '../params';
import { GATEWAY_SCOPE_PARAMS, inGatewayScope, resolveGatewayScope } from '../scope';
import { gatewaySubject } from '../subject';
import type { Finding, Rule } from '../types';

const rule: Rule = {
  id: 'gateway-deaf',
  description:
    'Flags a gateway that ChirpStack has heard from recently but which has forwarded no ' +
    'uplinks. Catches a dead concentrator, a disconnected antenna, or water in the feeder ' +
    '— faults that leave the gateway showing online and every other check blind.',
  defaultSeverity: 'critical',
  /** A fact: the gateway is named and the fault is in its radio path. */
  defaultRouting: 'fact',
  defaultParams: {
    /**
     * How recently ChirpStack must have heard from the gateway for it to count as online.
     *
     * ChirpStack updates last-seen from the gateway's stats interval, commonly 30
     * seconds. Fifteen minutes tolerates a missed interval or two without treating a
     * genuinely disconnected gateway as merely deaf — that one is gateway-silent's, and
     * the two should not both fire for the same unit.
     */
    onlineWithinMinutes: 15,
    /** Window over which the gateway must have forwarded nothing. */
    lookbackHours: 6,
    /**
     * Receptions the gateway may have forwarded and still count as deaf.
     *
     * Zero is the honest default: a gateway hearing even occasionally has a working
     * receiver, and the problem is then coverage or siting rather than hardware. Raise it
     * only if you want to catch a partially-failed receiver, and expect overlap with
     * signal-degraded.
     */
    maxReceptions: 0,
    /**
     * Receptions the rest of the site must have forwarded before this fires.
     *
     * The coverage discriminator described above. If the whole site is quiet, this
     * gateway hearing nothing is not evidence of anything.
     */
    minPeerReceptions: 20,
    /** Narrow to specific gateways, or ignore ones known to have nothing in range. */
    ...GATEWAY_SCOPE_PARAMS,
  },
  requires: [RX_INFO_REQUIREMENT],
  needs: ['chirpstack'],

  async run(ctx) {
    const onlineWithinMinutes = int(ctx.params, 'onlineWithinMinutes');
    const lookbackHours = int(ctx.params, 'lookbackHours');
    const maxReceptions = int(ctx.params, 'maxReceptions');
    const minPeerReceptions = int(ctx.params, 'minPeerReceptions');
    const scope = resolveGatewayScope(ctx.params);

    // Guaranteed by `needs`; guarded so the rule does not rely on the engine having
    // honoured its own contract.
    if (!ctx.gateways) return [];

    const registered = await ctx.gateways.listGateways();
    const activity = await gatewayActivity(ctx, lookbackHours, scope);

    const receptionsBy = new Map(activity.map((g) => [g.gatewayId, g.receptions]));
    const sitewide = activity.reduce((n, g) => n + g.receptions, 0);

    const findings: Finding[] = [];
    for (const gw of registered) {
      if (!inGatewayScope(scope, gw.gatewayId)) continue;

      // Never seen at all is gateway-never-seen's subject, not this one's. Reporting it
      // here as well would give one fault two alerts with two different diagnoses.
      if (!gw.lastSeenAt) continue;

      const lastSeenMs = Date.parse(gw.lastSeenAt);
      if (Number.isNaN(lastSeenMs)) continue;

      const offlineMinutes = (Date.now() - lastSeenMs) / 60_000;
      // Not currently online: whatever is wrong with it, "deaf" is the wrong diagnosis.
      if (offlineMinutes > onlineWithinMinutes) continue;

      const received = receptionsBy.get(gw.gatewayId) ?? 0;
      if (received > maxReceptions) continue;

      // Peer traffic excludes this gateway's own, which is zero here anyway — written
      // this way so the comparison stays correct if maxReceptions is raised above zero.
      const peer = sitewide - received;
      if (peer < minPeerReceptions) {
        ctx.log.debug('gateway heard nothing, but neither did the site — not reporting', {
          gateway: gw.gatewayId,
          peerReceptions: peer,
        });
        continue;
      }

      findings.push({
        subject: gatewaySubject(gw.gatewayId, gw.name),
        summary:
          `gateway ${gatewayLabel(gw.gatewayId, gw.name)} is online (last seen ` +
          `${forDuration(offlineMinutes)} ago) but has received nothing in ${lookbackHours}h ` +
          `while other gateways received ${peer} — check the antenna and concentrator`,
        detail: {
          lastSeenAt: gw.lastSeenAt,
          chirpstackState: gw.state,
          receptionsInWindow: received,
          peerReceptionsInWindow: peer,
          lookbackHours,
          // The distinction the summary is making, spelled out for anything parsing this
          // rather than reading it: IP up, radio down.
          backhaul: 'up',
          radio: 'no receptions',
        },
      });
    }

    return findings;
  },
};

export default rule;
