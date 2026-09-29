/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Gateway activity derived from `event_up.rx_info` — what measurement.ts is for decoded
 * telemetry, this is for the radio layer underneath it.
 *
 * `rx_info` is a JSONB array with one entry per gateway that received an uplink, so the
 * event store already contains a complete record of which gateways are doing their job.
 * `signal-degraded` has been reading it since the beginning, but only for RSSI and a
 * count — it never looks at *which* gateway. Reading the identifier turns the same column
 * into a gateway inventory with no new data source, no second database, and no API call.
 *
 * What this can and cannot see is worth being precise about, because the gap is the
 * reason src/chirpstack.ts also exists:
 *
 *   visible    a gateway that was forwarding and stopped; one flapping in and out; one
 *              that lost GPS; how many gateways hear each device
 *   invisible  a gateway with no devices in range (nothing to forward, so it never
 *              appears), one connected but deaf, and one registered but never heard from
 *
 * The inventory is derived from traffic, exactly as device-silent derives the device
 * inventory from uplinks, and it inherits the same trade-off: a gateway silent for longer
 * than the inventory window drops out of the inventory and stops being reported. By then
 * it has been reported for the length of the window, or it was never really in service.
 *
 * ── The rx_info key names ──
 * ChirpStack v4's PostgreSQL integration stores rx_info as the gateway UplinkRxInfo
 * messages serialized through pbjson, which emits the protobuf JSON mapping — camelCase:
 * `gatewayId`, `rssi`, `snr`, `gwTime`, `nsTime`, `timeSinceGpsEpoch`, `context`,
 * `metadata`, `crcStatus`. The MQTT integration emits the same camelCase shape. Every
 * query here still reads `COALESCE(g->>'gatewayId', g->>'gateway_id')` (and the snake_case
 * form of each time field): snake_case is what a store written by ChirpStack v3's
 * integration — Go's encoding/json over the protobuf structs — or by other tooling holds,
 * and a missing key would otherwise mean an empty gateway inventory, and an empty
 * inventory reports no faults, which is the one failure mode worth engineering against
 * here. Ids are lowercased as they are read, so the inventory, the scope filter and the
 * alert subject all agree on one spelling. To see what your deployment actually stores:
 *
 *   SELECT DISTINCT jsonb_object_keys(g)
 *     FROM event_up, jsonb_array_elements(rx_info) g
 *    WHERE time > now() - interval '1 day';
 */

import {
  gatewayScopeClause,
  scopeClause,
  type DeviceScope,
  type GatewayScope,
} from './scope';
import type { SchemaRequirement, SoundingContext } from './types';

/** The columns every query here reads. Declare this in a rule's `requires`. */
export const RX_INFO_REQUIREMENT: SchemaRequirement = {
  table: 'event_up',
  columns: ['dev_eui', 'time', 'rx_info'],
};

/**
 * Every rx_info entry in the window, one row per (uplink, gateway entry).
 *
 * The shape guard is a CASE inside the lateral call, and that placement is load-bearing.
 * `jsonb_array_elements` (and `jsonb_array_length`) raise on a value that is not an
 * array, and Postgres guarantees no evaluation order among WHERE conditions — so
 * `jsonb_typeof(rx_info) = 'array' AND jsonb_array_length(rx_info) > 0` can run the
 * second test on the row the first was meant to exclude, and a lateral join can be
 * evaluated before the WHERE clause entirely. Either way one malformed rx_info anywhere
 * in the window aborts the sounding. CASE is the one construct whose branches are
 * evaluated in order at run time, so a non-array rx_info becomes an empty array and
 * simply contributes no rows. The WHERE-clause typeof test stays as a cheap pre-filter,
 * not as the guard. An empty array needs no special case: it yields no elements.
 *
 * The gateway id is lowercased here, once, so grouping, the scope predicate and the
 * returned id cannot disagree about case.
 */
const RX_ROWS = `
  WITH rx AS (
    SELECT dev_eui, time, rx_info
      FROM event_up
     WHERE time > now() - make_interval(secs => $1::float8 * 3600)
       AND rx_info IS NOT NULL
       AND jsonb_typeof(rx_info) = 'array'
  ),
  seen AS (
    SELECT lower(COALESCE(g->>'gatewayId', g->>'gateway_id')) AS gateway_id,
           rx.dev_eui,
           rx.time,
           g AS gw
      FROM rx
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(rx.rx_info) = 'array' THEN rx.rx_info ELSE '[]'::jsonb END
      ) AS g
  )`;

/** One gateway's traffic over the window. */
export interface GatewayActivity {
  gatewayId: string;
  firstSeen: string;
  lastSeen: string;
  silentMinutes: number;
  /** Uplink receptions, not distinct uplinks: two gateways hearing one uplink is two. */
  receptions: number;
  /** How many distinct devices this gateway heard — the size of what it is carrying. */
  devices: number;
}

/**
 * Per-gateway first/last reception and volume over the window.
 *
 * The aggregate is done in Postgres so only one row per gateway crosses the wire, and the
 * silence arithmetic uses SQL `now()` rather than the engine's clock — the two can differ
 * on a box whose NTP has drifted, and the database's own view is the one the timestamps
 * were written against.
 */
export async function gatewayActivity(
  ctx: SoundingContext,
  lookbackHours: number,
  scope: GatewayScope,
): Promise<GatewayActivity[]> {
  const gs = gatewayScopeClause(scope, 2);

  const rows = await ctx.query<{
    gateway_id: string;
    first_seen: string;
    last_seen: string;
    silent_minutes: string;
    receptions: string;
    devices: string;
  }>(
    `${RX_ROWS}
     SELECT gateway_id,
            min(time)                                            AS first_seen,
            max(time)                                            AS last_seen,
            round(EXTRACT(EPOCH FROM (now() - max(time))) / 60)  AS silent_minutes,
            count(*)                                             AS receptions,
            count(DISTINCT dev_eui)                              AS devices
       FROM seen
      WHERE gateway_id IS NOT NULL
        AND gateway_id <> ''
        ${gs.sql}
      GROUP BY gateway_id
      ORDER BY max(time) ASC`,
    [lookbackHours, ...gs.values],
  );

  return rows.map((r) => ({
    gatewayId: r.gateway_id.toLowerCase(),
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    silentMinutes: Number(r.silent_minutes),
    receptions: Number(r.receptions),
    devices: Number(r.devices),
  }));
}

/** One gateway's continuity over the window, bucketed. */
export interface GatewayContinuity {
  gatewayId: string;
  lastSeen: string;
  /** Buckets in the window that carry at least one reception from this gateway. */
  activeBuckets: number;
  /** Buckets between this gateway's first and last reception with nothing at all. */
  gapBuckets: number;
  /** Distinct runs of empty buckets — the number of times it dropped out and came back. */
  dropouts: number;
  receptions: number;
}

/**
 * Bucket each gateway's receptions to find the ones that keep dropping out.
 *
 * Only the span between a gateway's own first and last reception counts, so a gateway
 * commissioned halfway through the window is not charged for the half before it existed.
 * Counting *runs* of empty buckets rather than empty buckets alone is what distinguishes
 * a flapping backhaul from one clean outage: ten scattered gaps and one ten-bucket gap
 * have the same downtime and completely different causes.
 */
export async function gatewayContinuity(
  ctx: SoundingContext,
  lookbackHours: number,
  bucketMinutes: number,
  scope: GatewayScope,
): Promise<GatewayContinuity[]> {
  const gs = gatewayScopeClause(scope, 3);

  const rows = await ctx.query<{
    gateway_id: string;
    last_seen: string;
    active_buckets: string;
    gap_buckets: string;
    dropouts: string;
    receptions: string;
  }>(
    `${RX_ROWS},
     bucketed AS (
       SELECT gateway_id,
              -- Bucket index counted back from now, so 0 is the current bucket.
              floor(EXTRACT(EPOCH FROM (now() - time)) / ($2::int * 60))::bigint AS bucket,
              time
         FROM seen
        WHERE gateway_id IS NOT NULL
          AND gateway_id <> ''
          ${gs.sql}
     ),
     per_bucket AS (
       SELECT gateway_id, bucket, count(*) AS receptions, max(time) AS last_in_bucket
         FROM bucketed
        GROUP BY gateway_id, bucket
     ),
     -- Adjacent occupied buckets differ by 1. A larger step is a gap, and each step
     -- greater than 1 is exactly one dropout-and-recovery.
     stepped AS (
       SELECT gateway_id,
              bucket,
              receptions,
              last_in_bucket,
              bucket - lag(bucket) OVER (PARTITION BY gateway_id ORDER BY bucket) AS step
         FROM per_bucket
     )
     SELECT gateway_id,
            max(last_in_bucket)                                       AS last_seen,
            count(*)                                                  AS active_buckets,
            COALESCE(sum(step - 1) FILTER (WHERE step > 1), 0)         AS gap_buckets,
            count(*) FILTER (WHERE step > 1)                          AS dropouts,
            sum(receptions)                                           AS receptions
       FROM stepped
      GROUP BY gateway_id
      ORDER BY count(*) FILTER (WHERE step > 1) DESC`,
    [lookbackHours, bucketMinutes, ...gs.values],
  );

  return rows.map((r) => ({
    gatewayId: r.gateway_id.toLowerCase(),
    lastSeen: r.last_seen,
    activeBuckets: Number(r.active_buckets),
    gapBuckets: Number(r.gap_buckets),
    dropouts: Number(r.dropouts),
    receptions: Number(r.receptions),
  }));
}

/** How many gateways hear one device, then versus now. */
export interface GatewayRedundancy {
  devEui: string;
  deviceName: string | null;
  /**
   * The device's typical gateway count over the historical window: the largest N such
   * that at least `minHistoricalShare` of its historical uplinks reached N or more
   * distinct gateways. 0 when it has no uplink with a gateway id.
   */
  historicalLevel: number;
  /** Best simultaneous gateway count seen in the historical window — context only. */
  historicalMax: number;
  /** Best simultaneous gateway count seen in the recent window. */
  recentMax: number;
  recentUplinks: number;
  historicalUplinks: number;
}

/**
 * Per device, how many distinct gateways its uplinks typically reached historically, and
 * the most any recent uplink reached.
 *
 * The two sides are deliberately different statistics.
 *
 * The historical side is a *typical* level, not a maximum. A maximum is set by the single
 * best uplink in the window, so one stray double reception in fourteen days — a
 * neighbour's gateway on a clear night, a survey handheld — would make a one-gateway
 * device look like it "used to reach 2" and report a loss that never happened. Requiring
 * a share of historical uplinks (`minHistoricalShare`, e.g. half) to have reached N is
 * what makes "used to reach N" mean "reliably reached N".
 *
 * The recent side stays a maximum. It only has to answer "has *any* recent uplink still
 * reached N", which errs toward not raising: a device whose second gateway still hears it
 * now and then has not lost that gateway.
 *
 * Gateways are counted as distinct gateway ids per uplink, not rx_info entries: a gateway
 * with two concentrator boards or antennas can report one uplink twice, and that is one
 * point of failure, not two. Entries without an id are not counted at all.
 *
 * Non-array rx_info is guarded with CASE rather than a WHERE conjunct — see RX_ROWS for
 * why the conjunct is not a guard.
 */
export async function gatewayRedundancy(
  ctx: SoundingContext,
  historyHours: number,
  recentHours: number,
  minHistoricalShare: number,
  scope: DeviceScope,
): Promise<GatewayRedundancy[]> {
  // $1 historyHours, $2 recentHours, $3 minHistoricalShare, then the two the device
  // scope always consumes.
  const sc = scopeClause(scope, 4);

  const rows = await ctx.query<{
    dev_eui: string;
    device_name: string | null;
    historical_level: string | null;
    historical_max: string;
    recent_max: string | null;
    recent_uplinks: string;
    historical_uplinks: string;
  }>(
    `WITH rx AS (
       SELECT dev_eui, device_name, time,
              CASE WHEN jsonb_typeof(rx_info) = 'array' THEN (
                SELECT count(DISTINCT lower(COALESCE(g->>'gatewayId', g->>'gateway_id')))
                  FROM jsonb_array_elements(rx_info) AS g
              ) END AS gateways
         FROM event_up
        WHERE time > now() - make_interval(secs => $1::float8 * 3600)
          AND rx_info IS NOT NULL
          AND jsonb_typeof(rx_info) = 'array'
          ${sc.sql}
     ),
     counted AS (
       SELECT * FROM rx WHERE gateways > 0
     ),
     -- For each gateway count a device's uplinks reached, how many uplinks reached at
     -- least that many: a running sum from the top down.
     levels AS (
       SELECT dev_eui, gateways,
              sum(n) OVER (PARTITION BY dev_eui ORDER BY gateways DESC) AS at_least,
              sum(n) OVER (PARTITION BY dev_eui)                        AS total
         FROM (SELECT dev_eui, gateways, count(*) AS n
                 FROM counted GROUP BY dev_eui, gateways) h
     ),
     typical AS (
       SELECT dev_eui, max(gateways) FILTER (WHERE at_least >= $3::numeric * total) AS level
         FROM levels
        GROUP BY dev_eui
     )
     SELECT c.dev_eui,
            max(c.device_name)                                                AS device_name,
            max(t.level)                                                      AS historical_level,
            max(c.gateways)                                                   AS historical_max,
            max(c.gateways) FILTER (
              WHERE c.time > now() - make_interval(secs => $2::float8 * 3600))          AS recent_max,
            count(*) FILTER (
              WHERE c.time > now() - make_interval(secs => $2::float8 * 3600))          AS recent_uplinks,
            count(*)                                                          AS historical_uplinks
       FROM counted c
       JOIN typical t ON t.dev_eui = c.dev_eui
      GROUP BY c.dev_eui
      ORDER BY c.dev_eui`,
    [historyHours, recentHours, minHistoricalShare, ...sc.values],
  );

  return rows.map((r) => ({
    devEui: r.dev_eui,
    deviceName: r.device_name,
    historicalLevel: r.historical_level === null ? 0 : Number(r.historical_level),
    historicalMax: Number(r.historical_max),
    recentMax: r.recent_max === null ? 0 : Number(r.recent_max),
    recentUplinks: Number(r.recent_uplinks),
    historicalUplinks: Number(r.historical_uplinks),
  }));
}

/** A gateway's timekeeping, as reported alongside each reception. */
export interface GatewayTimekeeping {
  gatewayId: string;
  /** Receptions inside the evaluation window. */
  receptions: number;
  /** Window receptions carrying a gateway-supplied timestamp of any kind (GPS or clock). */
  timestamped: number;
  /** Window receptions carrying GPS time (`timeSinceGpsEpoch`) — present only with a lock. */
  gpsTimed: number;
  /** Receptions over the whole history window carrying any gateway timestamp. */
  historyTimestamped: number;
  /** Receptions over the whole history window carrying GPS time. */
  historyGpsTimed: number;
  /** Worst absolute divergence between the gateway's clock and the reference, seconds. */
  maxSkewSeconds: number | null;
  /** The mean absolute divergence, seconds. */
  avgSkewSeconds: number | null;
  /** Window receptions whose skew was measured at all (well-formed gwTime). */
  skewCompared: number;
  /** Of those, how many were measured against the network server's `nsTime`. */
  skewAgainstNsTime: number;
  lastSeen: string;
}

/**
 * Whether each gateway is still telling the truth about the time.
 *
 * A gateway with a GPS lock stamps receptions with GPS time; one that has lost the lock
 * (antenna knocked, cable water-ingressed, receiver failed) falls back to its own clock or
 * stops stamping altogether. Uplinks keep flowing perfectly the whole time, so nothing
 * else in this engine notices — but Class-B beaconing, downlink scheduling windows and
 * any TDOA geolocation are all quietly broken.
 *
 * Three rx_info fields, counted separately because they fail separately:
 *
 *   gwTime / gw_time                    the gateway's own timestamp. Present with a GPS
 *                                       lock and, on most packet forwarders, without one
 *                                       too — stamped from the system clock. Its presence
 *                                       therefore says nothing about GPS.
 *   timeSinceGpsEpoch / time_since_…    present only with a lock. Its disappearance while
 *                                       gwTime continues is the GPS-loss signature, and
 *                                       is counted on its own so the fallback clock
 *                                       cannot mask it.
 *   nsTime / ns_time                    the network server's receive clock — the reference
 *                                       skew is measured against.
 *
 * Skew is gwTime minus nsTime. It is deliberately not gwTime minus `event_up.time`:
 * ChirpStack v4 derives the event time from the gateway itself — time_since_gps_epoch
 * when present, else gwTime when it is within `rx_timestamp_max_drift` (default 30 s) of
 * the server, and only otherwise the server's own now() — so against the event time any
 * drift under that bound reads as zero. Only a reception without a well-formed nsTime
 * falls back to the event time, and the counts returned say how many did.
 *
 * `time` (bare) is read as a last resort for the gateway timestamp: it is the field name
 * a ChirpStack v3 store used for it.
 *
 * Two windows: the history window ($1, which RX_ROWS scans) answers "did this gateway
 * ever supply this field", the evaluation window ($2) answers "does it now". Judging
 * "previously supplied" inside the evaluation window alone means a gateway that stops
 * stamping entirely looks, one window later, exactly like a model that never stamped —
 * and its open alert resolves while the fault persists.
 *
 * Timestamps are cast only behind a regex CASE, so a garbage string is counted as
 * unusable for skew rather than aborting the sounding.
 */
export async function gatewayTimekeeping(
  ctx: SoundingContext,
  lookbackHours: number,
  historyHours: number,
  scope: GatewayScope,
): Promise<GatewayTimekeeping[]> {
  // $1 historyHours (RX_ROWS), $2 lookbackHours, then the gateway scope's two.
  const gs = gatewayScopeClause(scope, 3);
  const TS = `'^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ]'`;

  const rows = await ctx.query<{
    gateway_id: string;
    receptions: string;
    timestamped: string;
    gps_timed: string;
    history_timestamped: string;
    history_gps_timed: string;
    max_skew: string | null;
    avg_skew: string | null;
    skew_compared: string;
    skew_vs_ns: string;
    last_seen: string;
  }>(
    `${RX_ROWS},
     timed AS (
       SELECT gateway_id,
              time,
              time > now() - make_interval(secs => $2::float8 * 3600)           AS in_window,
              COALESCE(gw->>'gwTime', gw->>'gw_time', gw->>'time')    AS gw_time,
              COALESCE(gw->>'nsTime', gw->>'ns_time')                  AS ns_time,
              (gw ? 'timeSinceGpsEpoch') OR (gw ? 'time_since_gps_epoch') AS has_gps
         FROM seen
        WHERE gateway_id IS NOT NULL
          AND gateway_id <> ''
          ${gs.sql}
     ),
     skewed AS (
       SELECT timed.*,
              COALESCE(gw_time ~ ${TS} AND ns_time ~ ${TS}, false)   AS vs_ns,
              CASE
                WHEN gw_time ~ ${TS} AND ns_time ~ ${TS}
                  THEN abs(EXTRACT(EPOCH FROM (gw_time::timestamptz - ns_time::timestamptz)))
                WHEN gw_time ~ ${TS}
                  THEN abs(EXTRACT(EPOCH FROM (gw_time::timestamptz - time)))
              END                                                     AS skew
         FROM timed
     )
     SELECT gateway_id,
            count(*) FILTER (WHERE in_window)                                    AS receptions,
            count(*) FILTER (WHERE in_window AND (gw_time IS NOT NULL OR has_gps)) AS timestamped,
            count(*) FILTER (WHERE in_window AND has_gps)                        AS gps_timed,
            count(*) FILTER (WHERE gw_time IS NOT NULL OR has_gps)               AS history_timestamped,
            count(*) FILTER (WHERE has_gps)                                      AS history_gps_timed,
            max(skew) FILTER (WHERE in_window)                                   AS max_skew,
            round(avg(skew) FILTER (WHERE in_window), 1)                         AS avg_skew,
            count(skew) FILTER (WHERE in_window)                                 AS skew_compared,
            count(skew) FILTER (WHERE in_window AND vs_ns)                       AS skew_vs_ns,
            max(time)                                                            AS last_seen
       FROM skewed
      GROUP BY gateway_id
      ORDER BY gateway_id`,
    [historyHours, lookbackHours, ...gs.values],
  );

  return rows.map((r) => ({
    gatewayId: r.gateway_id.toLowerCase(),
    receptions: Number(r.receptions),
    timestamped: Number(r.timestamped),
    gpsTimed: Number(r.gps_timed),
    historyTimestamped: Number(r.history_timestamped),
    historyGpsTimed: Number(r.history_gps_timed),
    maxSkewSeconds: r.max_skew === null ? null : Number(r.max_skew),
    avgSkewSeconds: r.avg_skew === null ? null : Number(r.avg_skew),
    skewCompared: Number(r.skew_compared),
    skewAgainstNsTime: Number(r.skew_vs_ns),
    lastSeen: r.last_seen,
  }));
}

/** Format a minute count the way device-silent does, so alerts read consistently. */
export function forDuration(minutes: number): string {
  if (minutes >= 1440) return `${Math.round((minutes / 1440) * 10) / 10}d`;
  if (minutes >= 60) return `${Math.round((minutes / 60) * 10) / 10}h`;
  return `${Math.round(minutes)}m`;
}

/** A gateway's display label: its name when known, otherwise the EUI. */
export function gatewayLabel(gatewayId: string, name?: string | null): string {
  return name && name.length > 0 ? `${name} (${gatewayId})` : gatewayId;
}
