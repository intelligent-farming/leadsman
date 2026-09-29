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
 *
 * ── the baseline ────────────────────────────────────────────────────────────────
 * The comparison is against a *baseline* — the address the gateways are forwarding to —
 * not against whatever was seen last sounding. The two differ as soon as the address
 * moves twice, and only the baseline gives the right answer:
 *
 *   A → B        raise "from A to B"; the gateways are on A
 *   A → B → A    resolve; the lease came back and the gateways never stopped working
 *   A → B → C    raise "from A to C"; the gateways are still on A, not B
 *
 * The baseline is the first address recorded. It only moves when a change has been open
 * for `openForHours`: by then the alert has had its window, and the working assumption is
 * that the gateways were re-pointed to the new address (had they not been, fleet-silent
 * would have been reporting a dark site the whole time). So the new address becomes the
 * baseline, the alert resolves, and a later move — including back to the old address —
 * is reported as a fresh change from the new one.
 */

import { int } from '../params';
import { engineSubject } from '../subject';
import type { Rule } from '../types';

const rule: Rule = {
  id: 'host-address-changed',
  description:
    "Flags the host's gateway-forwarding address differing from the address the gateways " +
    'were given (the first one recorded). Gateways are configured with a fixed address ' +
    'and never rediscover it, so a new DHCP lease silently orphans every one of them.',
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
     * open when someone gets to it. It resolves earlier if the address moves back to the
     * one the gateways were given. Once this long has passed the new address is taken
     * as the one the gateways now forward to (assumed re-pointed) and the alert
     * resolves; a later move is measured from it.
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
    let change = parseChange(await ctx.state.get(CHANGE_KEY));

    // First sighting. Record it and say nothing: with no previous address there is no
    // change, and a fresh install must not open with a critical alert.
    if (!change && (!seen || !seen.value)) {
      await ctx.state.set(ADDRESS_KEY, current);
      ctx.log.info('recorded the gateway-forwarding address for the first time', {
        address: current,
      });
      return [];
    }

    // The baseline is where the gateways forward. An open change record names it as
    // `previous`; that takes precedence over ADDRESS_KEY, which versions before the
    // baseline model overwrote with the latest address on every change — so an open
    // change written by one of those still resolves against the right address.
    const baseline = change ? change.previous : (seen?.value as string);

    if (current === baseline) {
      // Back where the gateways were told to go — the lease came back. Nothing to act
      // on, so clear the record and let the alert resolve.
      if (change) {
        await ctx.state.set(CHANGE_KEY, null);
        await ctx.state.set(ADDRESS_KEY, baseline);
        ctx.log.info('gateway-forwarding address moved back to the baseline', {
          address: current,
          wasAt: change.current,
        });
      }
      return [];
    }

    if (!change || change.current !== current) {
      // A new departure from the baseline — the first, or a second move (A → B → C)
      // while the gateways are still on A. `previous` stays the baseline; the clock
      // restarts, because C is new information somebody has to act on.
      //
      // The record is kept separately from the baseline because the alert has to stay
      // open for hours while somebody re-points gateways, and a check is only asked
      // "what is wrong now".
      change = { previous: baseline, current, at: new Date().toISOString() };
      await ctx.state.set(ADDRESS_KEY, baseline);
      await ctx.state.set(CHANGE_KEY, JSON.stringify(change));
      ctx.log.warn('gateway-forwarding address changed', { previous: baseline, current });
    }

    // Stale changes stop being news. After openForHours the gateways are assumed to have
    // been re-pointed (see "the baseline" above): the new address becomes the baseline
    // and the alert resolves. An unreadable timestamp is treated the same way rather
    // than holding a critical alert open forever.
    const ageHours = (Date.now() - Date.parse(change.at)) / 3_600_000;
    if (!Number.isFinite(ageHours) || ageHours > openForHours) {
      await ctx.state.set(ADDRESS_KEY, current);
      await ctx.state.set(CHANGE_KEY, null);
      ctx.log.info('address change aged out; adopting the new address as the baseline', {
        previous: change.previous,
        current,
        openForHours,
      });
      return [];
    }

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
