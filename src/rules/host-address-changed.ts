/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * host-address-changed — this host is no longer at the address the gateways were told.
 *
 * A LoRaWAN gateway does not discover its network server. It is configured, once, with an
 * address — the Gateway Bridge's host on UDP :1700, or ws://<host>:3001 for Basics Station
 * — and from then on it forwards there and nowhere else. Nothing renegotiates. Nothing
 * retries elsewhere. If the host comes back on a different DHCP lease after a power cut,
 * every gateway on the site is still faithfully forwarding to an address that no longer
 * answers, and will keep doing so indefinitely.
 *
 * From the inside this is invisible in the most misleading way possible: the gateways are
 * healthy and online, the network server is healthy, the database is healthy, every
 * process is running, and no uplinks arrive. `fleet-silent` reports the symptom within one
 * sounding, which is the important part. This check reports the *cause*, which is the
 * difference between "the site is dark, go and investigate" and "the address changed from
 * 192.168.1.42 to 192.168.1.57; re-point the gateways".
 *
 * Leadsman cannot discover the address itself — see src/host.ts for why a bridged
 * container structurally cannot see its host's LAN address. It is injected, and the
 * default source is the file intelligent-farming-stack's provisioner already writes on
 * every start, whose `gatewayBridgeHost` is literally the value the stack hands to
 * leftenant's Add-Gateway wizard. Comparing it against what was there last sounding is
 * therefore comparing "where the host is now" against "where the gateways were told to
 * go", which is exactly the question.
 *
 * Two honest limits, both handled by treating unknown as unknown rather than guessing:
 *
 *   - The shared file is refreshed when the stack is brought up through setup.sh. A bare
 *     `docker compose up` can leave a stale value, in which case this check compares two
 *     stale values, sees no change, and stays quiet. It under-reports; it does not
 *     invent.
 *   - With no address source configured there is nothing to compare, so the check
 *     declares `needs: ['hostAddress']` and is skipped rather than run — a skip is
 *     visible in `leadsman.run`, whereas a check that ran and found nothing is not
 *     distinguishable from a healthy one.
 */

import { int } from '../params';
import { engineSubject } from '../subject';
import type { Rule } from '../types';

const rule: Rule = {
  id: 'host-address-changed',
  description:
    "Flags a change in the host's gateway-forwarding address since the previous sounding. " +
    'Gateways are configured with a fixed address and never rediscover it, so a new DHCP ' +
    'lease silently orphans every one of them.',
  defaultSeverity: 'critical',
  /**
   * A fact, and an unusually actionable one: the summary contains both addresses, and the
   * job is to put the new one into each gateway.
   */
  defaultRouting: 'fact',
  defaultParams: {
    /**
     * Keep the alert open this long after the change.
     *
     * Re-pointing gateways is manual work — into a web UI per gateway, or a site visit —
     * so the alert has to outlive the moment of detection by long enough to still be
     * open when someone gets to it. It resolves on its own afterwards; the address is
     * already recorded either way.
     */
    openForHours: 72,
  },
  /**
   * Reads no telemetry at all — the comparison is between two scalars in Leadsman's own
   * state, reached through ctx.state rather than SQL. `requires` still has to name
   * something real, and engine_state is what that access actually touches.
   */
  requires: [{ table: 'leadsman.engine_state', columns: ['key', 'value', 'seen_at'] }],
  needs: ['hostAddress'],

  async run(ctx) {
    const openForHours = int(ctx.params, 'openForHours');

    // Guaranteed non-null by `needs`; the guard is here because a rule should not depend
    // on the engine having honoured its own contract.
    const current = ctx.engine.hostAddress;
    if (!current) return [];

    const seen = await ctx.state.get(ADDRESS_KEY);

    // First sighting. Record it and say nothing: with no previous address there is no
    // change, and a fresh install must not open with a critical alert.
    if (!seen || !seen.value) {
      await ctx.state.set(ADDRESS_KEY, current);
      ctx.log.info('recorded the gateway-forwarding address for the first time', {
        address: current,
      });
      return [];
    }

    if (seen.value !== current) {
      // Record both sides before reporting. The address moves to the new value so a
      // subsequent change is detected against the right baseline, and the change itself
      // is written down separately — because the alert has to stay open for hours while
      // somebody re-points gateways, and a check is only asked "what is wrong now".
      // Without the record, the next sounding would see no difference, report nothing,
      // and the alert would auto-resolve minutes after being raised.
      await ctx.state.set(ADDRESS_KEY, current);
      await ctx.state.set(
        CHANGE_KEY,
        JSON.stringify({ previous: seen.value, current, at: new Date().toISOString() }),
      );
      ctx.log.warn('gateway-forwarding address changed', {
        previous: seen.value,
        current,
      });
    }

    const change = parseChange(await ctx.state.get(CHANGE_KEY));
    if (!change) return [];

    // Stale changes stop being news. The alert resolves itself once the window passes;
    // the addresses stay in engine_state either way.
    const ageHours = (Date.now() - Date.parse(change.at)) / 3_600_000;
    if (!Number.isFinite(ageHours) || ageHours > openForHours) return [];

    // A change recorded earlier, followed by the address moving back on its own — the
    // lease came back — is no longer a fault to act on.
    if (change.current !== current) return [];

    return [
      {
        subject: engineSubject(),
        summary:
          `host address changed from ${change.previous} to ${current} — every gateway is ` +
          `still forwarding to ${change.previous} and must be re-pointed`,
        detail: {
          previousAddress: change.previous,
          currentAddress: current,
          changedAt: change.at,
          // Named so the fix is unambiguous: these are the two endpoints a gateway is
          // configured with, and both move with the host address.
          gatewayBridgePorts: { semtechUdp: 1700, basicsStation: 3001 },
          openForHours,
        },
      },
    ];
  },
};

/** Keys within this check's own namespace — see SoundingContext.state. */
const ADDRESS_KEY = 'address';
const CHANGE_KEY = 'change';

interface AddressChange {
  previous: string;
  current: string;
  at: string;
}

/**
 * Read back the recorded change.
 *
 * Tolerant on purpose: this is Leadsman's own state, but a value written by an older
 * version, or hand-edited during an incident, must not abort a sounding. An unreadable
 * record is treated as no record.
 */
function parseChange(entry: { value: string | null } | null): AddressChange | null {
  if (!entry?.value) return null;
  try {
    const parsed: unknown = JSON.parse(entry.value);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { previous, current, at } = parsed as Record<string, unknown>;
    if (typeof previous !== 'string' || typeof current !== 'string' || typeof at !== 'string') {
      return null;
    }
    return { previous, current, at };
  } catch {
    return null;
  }
}

export default rule;
