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
 * Three signals, any one sufficient, reported in this order of precedence:
 *
 *   - the gateway stopped supplying a timestamp at all, having supplied one within the
 *     history window (`inventoryHours`).
 *   - it still stamps receptions (from its own clock) but GPS time is gone.
 *     `time_since_gps_epoch` / `timeSinceGpsEpoch` is only present with a lock, which
 *     makes its disappearance the cleanest available evidence — so it is counted on its
 *     own, and a gateway that carried it within the history window and has now mostly
 *     lost it raises "GPS time lost" even though every reception still has a `gwTime`.
 *   - the timestamp it supplies has diverged from the network server's clock (`nsTime`)
 *     beyond a tolerance no propagation delay can explain.
 *
 * "Previously" is judged over `inventoryHours`, not over the evaluation window: judged
 * inside the window, a gateway that stops stamping entirely looks like a model that never
 * stamped once the window has rolled past the last good reception, and the alert would
 * resolve while the gateway is still broken. The same inventory trade-off as
 * gateway-silent applies — a fault older than `inventoryHours` is forgotten.
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
     * History establishing whether the gateway has ever supplied a timestamp, and GPS time
     * in particular. Must be at least `lookbackHours`.
     *
     * The "never supplied one" exemption below is judged over this window rather than the
     * evaluation window, so a gateway that has stopped stamping stays in breach for this
     * long instead of resolving one lookback after the fault began.
     */
    inventoryHours: 168,
    /**
     * Fraction of receptions that must carry a usable timestamp (0–1). Applied twice: to
     * any timestamp, and to GPS time for a gateway that has carried GPS time within
     * `inventoryHours`.
     *
     * Not 1.0: a gateway briefly losing lock as satellites move is normal, and a check
     * that fires on it would fire on every healthy gateway eventually.
     */
    minTimestampedRatio: 0.5,
    /**
     * Divergence between the gateway's clock and the network server's that counts as
     * unsynced, in seconds.
     *
     * The comparison is `gwTime` against rx_info's `nsTime` — the network server's own
     * receive clock — which carries backhaul latency and gateway-bridge queueing, so a
     * second or two of apparent skew is normal and means nothing; ten seconds is past
     * anything the path can account for. A reception without `nsTime` falls back to
     * `event_up.time`, which is a much weaker reference: ChirpStack v4 derives it from the
     * gateway's own time whenever that is within `rx_timestamp_max_drift` (30 s by
     * default), so against it drift under that bound reads as roughly zero. The alert
     * detail says which reference was used.
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
    const inventoryHours = int(ctx.params, 'inventoryHours');
    const minTimestampedRatio = num(ctx.params, 'minTimestampedRatio');
    const maxSkewSeconds = num(ctx.params, 'maxSkewSeconds');
    const minReceptions = int(ctx.params, 'minReceptions');

    if (!(minTimestampedRatio > 0) || minTimestampedRatio > 1) {
      throw new Error(`minTimestampedRatio must be in (0, 1] (got ${minTimestampedRatio})`);
    }
    if (inventoryHours < lookbackHours) {
      throw new Error(
        `inventoryHours (${inventoryHours}) must be at least lookbackHours (${lookbackHours}) — ` +
          'it is the history the evaluation window is judged against',
      );
    }

    const scope = resolveGatewayScope(ctx.params);
    const rows = await gatewayTimekeeping(ctx, lookbackHours, inventoryHours, scope);

    const findings: Finding[] = [];
    for (const gw of rows) {
      if (gw.receptions < minReceptions) continue;

      // A gateway that has never supplied a timestamp is not a gateway that lost its
      // lock — it is a model that does not report one, or a ChirpStack version that does
      // not store it. Reporting that as a fault would flag every gateway on such a
      // deployment, forever, which is exactly the false-positive this check must not have.
      // "Never" means across the whole history window, not just this one.
      if (gw.historyTimestamped === 0) {
        ctx.log.debug('gateway supplies no reception timestamps at all — not a sync fault', {
          gateway: gw.gatewayId,
        });
        continue;
      }

      const ratio = gw.timestamped / gw.receptions;
      const gpsRatio = gw.gpsTimed / gw.receptions;

      const missing = ratio < minTimestampedRatio;
      // Only a gateway that has had GPS time can lose it; one without a GPS receiver
      // stamping from its clock alone is judged on skew.
      const gpsLost = !missing && gw.historyGpsTimed > 0 && gpsRatio < minTimestampedRatio;
      const skewed = gw.maxSkewSeconds !== null && gw.maxSkewSeconds > maxSkewSeconds;
      if (!missing && !gpsLost && !skewed) continue;

      const skewReference =
        gw.skewCompared === 0
          ? null
          : gw.skewAgainstNsTime === gw.skewCompared
            ? 'nsTime'
            : gw.skewAgainstNsTime === 0
              ? 'eventTime'
              : 'mixed';

      const pct = (x: number) => Math.round(x * 100);
      const reason = missing
        ? `only ${pct(ratio)}% of receptions carried a timestamp ` +
          `(threshold ${pct(minTimestampedRatio)}%), having carried one within ${inventoryHours}h`
        : gpsLost
          ? `GPS time lost — only ${pct(gpsRatio)}% of receptions carried GPS time ` +
            `(threshold ${pct(minTimestampedRatio)}%), having carried it within ` +
            `${inventoryHours}h; it is stamping from its own clock`
          : `clock diverged by up to ${gw.maxSkewSeconds}s from the network server ` +
            `(threshold ${maxSkewSeconds}s)`;

      findings.push({
        subject: gatewaySubject(gw.gatewayId),
        summary:
          `gateway ${gw.gatewayId} is not keeping accurate time: ${reason} — ` +
          'check its GPS antenna; downlinks and Class-B depend on this',
        detail: {
          receptionsInWindow: gw.receptions,
          timestampedReceptions: gw.timestamped,
          timestampedRatio: Math.round(ratio * 1000) / 1000,
          gpsTimedReceptions: gw.gpsTimed,
          gpsTimedRatio: Math.round(gpsRatio * 1000) / 1000,
          historyTimestampedReceptions: gw.historyTimestamped,
          historyGpsTimedReceptions: gw.historyGpsTimed,
          maxSkewSeconds: gw.maxSkewSeconds,
          avgSkewSeconds: gw.avgSkewSeconds,
          thresholdSkewSeconds: maxSkewSeconds,
          // What the skew was measured against. 'eventTime' (or 'mixed') means rx_info
          // carried no nsTime for some receptions, and on those drift under ChirpStack's
          // rx_timestamp_max_drift (30 s default) is invisible — see maxSkewSeconds.
          skewReference,
          ...(skewReference === 'eventTime' || skewReference === 'mixed'
            ? {
                skewReferenceNote:
                  'no nsTime in rx_info for some receptions; skew there is against ' +
                  'event_up.time, which ChirpStack derives from the gateway clock when ' +
                  'within rx_timestamp_max_drift, so small drift reads as zero',
              }
            : {}),
          thresholdTimestampedRatio: minTimestampedRatio,
          // Which signal fired, since they point at different things: no timestamp at
          // all, a lost GPS lock behind a still-running clock, or a drifting clock.
          trigger: missing ? 'missing-timestamps' : gpsLost ? 'gps-time-lost' : 'clock-skew',
          lastSeenAt: gw.lastSeen,
          lookbackHours,
          inventoryHours,
        },
      });
    }

    return findings;
  },
};

export default rule;
