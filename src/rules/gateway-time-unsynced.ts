/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * gateway-time-unsynced — a gateway has stopped keeping accurate time.
 *
 * A gateway with a GPS lock stamps every reception with GPS time, accurate to
 * microseconds. That timestamp is not decoration: it is what schedules Class-B beacons,
 * what places a downlink inside the RX1/RX2 window the device is actually listening in,
 * and what makes TDOA geolocation possible at all. Lose the lock — antenna knocked out of
 * the sky, coax gone green at the connector, receiver module failed, or the unit simply
 * moved indoors — and the gateway falls back to its own clock, or stops stamping.
 *
 * Uplinks keep flowing perfectly throughout. Every check in this engine stays quiet:
 * devices report, payloads decode, RSSI is unchanged, the gateway is online and forwarding.
 * Meanwhile downlinks start missing their windows, so confirmed uplinks go unacked, ADR
 * cannot retune anything, actuator commands stop landing, and Class-B devices drift out of
 * their schedule. The symptoms surface as `downlink-unacked` and `join-churn` — one layer
 * up from the cause, on the wrong devices, with no indication that a gateway's clock is
 * the reason.
 *
 * Two signals, either sufficient:
 *
 *   - the gateway stopped supplying a timestamp at all, having previously supplied one.
 *     `time_since_gps_epoch` is only present with a lock, which makes its disappearance
 *     the cleanest available evidence.
 *   - the timestamp it supplies has diverged from the network server's clock beyond a
 *     tolerance no propagation delay can explain.
 *
 * Disabled by default, for an honest reason: which time fields ChirpStack's PostgreSQL
 * integration writes into `rx_info` varies with version and with the gateway's own
 * firmware, and a deployment where none is present would see this raise nothing (harmless)
 * or read a field that means something else (not harmless). Confirm what your rx_info
 * actually carries before enabling it:
 *
 *   SELECT DISTINCT jsonb_object_keys(g)
 *     FROM event_up, jsonb_array_elements(rx_info) g
 *    WHERE time > now() - interval '1 day';
 */

import { gatewayTimekeeping, RX_INFO_REQUIREMENT } from '../gateway';
import { int, num } from '../params';
import { GATEWAY_SCOPE_PARAMS, resolveGatewayScope } from '../scope';
import { gatewaySubject } from '../subject';
import type { Finding, Rule } from '../types';

const rule: Rule = {
  id: 'gateway-time-unsynced',
  description:
    "Flags a gateway that has stopped supplying accurate timestamps with its receptions, " +
    'by GPS or otherwise. Breaks Class-B, downlink windows and geolocation while uplinks ' +
    'keep arriving normally. Confirm your rx_info time fields before enabling.',
  defaultSeverity: 'warning',
  /** A fact: the gateway is named and the fault is its timing source. */
  defaultRouting: 'fact',
  defaultParams: {
    /** Window to judge over. */
    lookbackHours: 24,
    /**
     * Fraction of receptions that must carry a usable timestamp (0–1).
     *
     * Not 1.0: a gateway briefly losing lock as satellites move is normal, and a check
     * that fires on it would fire on every healthy gateway eventually.
     */
    minTimestampedRatio: 0.5,
    /**
     * Divergence between the gateway's clock and the event time that counts as unsynced,
     * in seconds.
     *
     * Generous on purpose. The comparison is against ChirpStack's own event timestamp,
     * which includes network-server queueing and the write to Postgres, so a second or
     * two of apparent skew is normal on a loaded box and means nothing. Ten seconds is
     * past anything the pipeline can account for.
     */
    maxSkewSeconds: 10,
    /** Ignore gateways with fewer receptions than this — too few to judge. */
    minReceptions: 50,
    /** Narrow to specific gateways — see src/scope.ts. */
    ...GATEWAY_SCOPE_PARAMS,
  },
  requires: [RX_INFO_REQUIREMENT],

  async run(ctx) {
    const lookbackHours = int(ctx.params, 'lookbackHours');
    const minTimestampedRatio = num(ctx.params, 'minTimestampedRatio');
    const maxSkewSeconds = num(ctx.params, 'maxSkewSeconds');
    const minReceptions = int(ctx.params, 'minReceptions');

    if (!(minTimestampedRatio > 0) || minTimestampedRatio > 1) {
      throw new Error(`minTimestampedRatio must be in (0, 1] (got ${minTimestampedRatio})`);
    }

    const scope = resolveGatewayScope(ctx.params);
    const rows = await gatewayTimekeeping(ctx, lookbackHours, scope);

    const findings: Finding[] = [];
    for (const gw of rows) {
      if (gw.receptions < minReceptions) continue;

      const ratio = gw.timestamped / gw.receptions;

      // A gateway that has never supplied a timestamp is not a gateway that lost its
      // lock — it is a model that does not report one, or a ChirpStack version that does
      // not store it. Reporting that as a fault would flag every gateway on such a
      // deployment, forever, which is exactly the false-positive this check must not have.
      if (gw.timestamped === 0) {
        ctx.log.debug('gateway supplies no reception timestamps at all — not a sync fault', {
          gateway: gw.gatewayId,
        });
        continue;
      }

      const missing = ratio < minTimestampedRatio;
      const skewed = gw.maxSkewSeconds !== null && gw.maxSkewSeconds > maxSkewSeconds;
      if (!missing && !skewed) continue;

      const reason = missing
        ? `only ${Math.round(ratio * 100)}% of receptions carried a timestamp ` +
          `(threshold ${Math.round(minTimestampedRatio * 100)}%)`
        : `clock diverged by up to ${gw.maxSkewSeconds}s (threshold ${maxSkewSeconds}s)`;

      findings.push({
        subject: gatewaySubject(gw.gatewayId),
        summary:
          `gateway ${gw.gatewayId} is not keeping accurate time: ${reason} — ` +
          'check its GPS antenna; downlinks and Class-B depend on this',
        detail: {
          receptionsInWindow: gw.receptions,
          timestampedReceptions: gw.timestamped,
          timestampedRatio: Math.round(ratio * 1000) / 1000,
          maxSkewSeconds: gw.maxSkewSeconds,
          avgSkewSeconds: gw.avgSkewSeconds,
          thresholdSkewSeconds: maxSkewSeconds,
          thresholdTimestampedRatio: minTimestampedRatio,
          // Which of the two signals fired, since they point at slightly different
          // things: a lost lock versus a drifting fallback clock.
          trigger: missing ? 'missing-timestamps' : 'clock-skew',
          lastSeenAt: gw.lastSeen,
          lookbackHours,
        },
      });
    }

    return findings;
  },
};

export default rule;
