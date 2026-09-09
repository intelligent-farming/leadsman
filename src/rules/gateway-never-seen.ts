/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * gateway-never-seen — registered in ChirpStack, never actually connected.
 *
 * The commissioning failure, and the one that most often ends an afternoon in a field.
 * Adding a gateway is two independent steps: register it in ChirpStack, and configure the
 * gateway itself to forward to the Gateway Bridge. The first is a form in a browser and
 * always succeeds. The second happens in the gateway's own web UI or config file, over a
 * different network, and fails quietly — a mistyped address, the wrong port, the LNS URI
 * left on the vendor default, a firewall between them, the wrong sub-band.
 *
 * Nothing reports the mismatch. ChirpStack shows the gateway it was told about. The
 * gateway shows itself forwarding. Neither knows the other exists, and the only visible
 * symptom is an absence of data that looks exactly like a quiet site.
 *
 * This is also the state a re-pointed gateway lands in after a host address change: told
 * a new address, given a typo, and now indistinguishable from one that was never
 * commissioned. So host-address-changed says the address moved, and this says which
 * gateway did not make it back — the pair covers the incident end to end.
 *
 * `graceMinutes` exists because registering a gateway before installing it is a perfectly
 * normal order of operations. An alert the moment a row appears in ChirpStack would fire
 * on every correct commissioning, which is the fastest way to teach someone to ignore
 * this check.
 */

import { forDuration, gatewayLabel } from '../gateway';
import { int } from '../params';
import { GATEWAY_SCOPE_PARAMS, inGatewayScope, resolveGatewayScope } from '../scope';
import { gatewaySubject } from '../subject';
import type { Finding, Rule } from '../types';

const rule: Rule = {
  id: 'gateway-never-seen',
  description:
    'Flags a gateway registered in ChirpStack that has never connected. Catches a gateway ' +
    'pointed at the wrong address or port during commissioning — including one that failed ' +
    'to come back after the host address changed.',
  defaultSeverity: 'warning',
  /**
   * A fact: the gateway is named, and the action is to check its forwarding
   * configuration. Warning rather than critical because nothing is being lost that was
   * ever working — this is an installation that has not finished.
   */
  defaultRouting: 'fact',
  defaultParams: {
    /**
     * How long after registration to stay quiet.
     *
     * Registering the gateway first and mounting it afterwards is normal, and a mast, a
     * ladder and a drive to the far side of a field take longer than an afternoon.
     * Twenty-four hours is late enough that a still-unconnected gateway means something
     * went wrong rather than that nobody has got to it yet.
     */
    graceMinutes: 1440,
    /** Narrow to specific gateways, or ignore ones registered ahead of installation. */
    ...GATEWAY_SCOPE_PARAMS,
  },
  /**
   * Reads no telemetry — the whole answer is in ChirpStack's registry. `requires` still
   * has to name a real table, and event_up is what the engine verifies it can read
   * before running any check at all.
   */
  requires: [{ table: 'event_up', columns: ['dev_eui', 'time'] }],
  needs: ['chirpstack'],

  async run(ctx) {
    const graceMinutes = int(ctx.params, 'graceMinutes');
    const scope = resolveGatewayScope(ctx.params);

    if (!ctx.gateways) return [];

    const findings: Finding[] = [];
    for (const gw of await ctx.gateways.listGateways()) {
      if (!inGatewayScope(scope, gw.gatewayId)) continue;

      // Has been heard from at some point: whatever is wrong now, it is not this. A
      // gateway that connected and then stopped belongs to gateway-silent or
      // gateway-deaf, which can say something more specific.
      if (gw.lastSeenAt) continue;

      // No creation time means no way to tell a gateway registered this minute from one
      // registered last year, and the grace period is the whole thing that keeps this
      // check from firing on correct commissioning. Without it, stay quiet.
      if (!gw.createdAt) {
        ctx.log.debug('gateway never seen but has no createdAt — cannot apply the grace period', {
          gateway: gw.gatewayId,
        });
        continue;
      }

      const createdMs = Date.parse(gw.createdAt);
      if (Number.isNaN(createdMs)) continue;

      const ageMinutes = (Date.now() - createdMs) / 60_000;
      if (ageMinutes < graceMinutes) continue;

      findings.push({
        subject: gatewaySubject(gw.gatewayId, gw.name),
        summary:
          `gateway ${gatewayLabel(gw.gatewayId, gw.name)} was registered ` +
          `${forDuration(ageMinutes)} ago and has never connected — check the address and ` +
          `port it is forwarding to` +
          (ctx.engine.hostAddress ? ` (this host is at ${ctx.engine.hostAddress})` : ''),
        detail: {
          registeredAt: gw.createdAt,
          registeredMinutesAgo: Math.round(ageMinutes),
          chirpstackState: gw.state,
          gracePeriodMinutes: graceMinutes,
          // The two things to check, and the address to check them against. Whoever
          // reads this alert is about to open the gateway's config UI.
          expectedHost: ctx.engine.hostAddress,
          gatewayBridgePorts: { semtechUdp: 1700, basicsStation: 3001 },
        },
      });
    }

    return findings;
  },
};

export default rule;
