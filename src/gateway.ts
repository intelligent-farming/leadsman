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
 * ── The gateway-id key ──
 * ChirpStack's PostgreSQL integration writes the protobuf struct as JSON, which
 * serializes snake_case, so `gateway_id` is expected. Its MQTT path emits camelCase
 * `gatewayId` for the same field, and the two are easy to confuse. Every query here reads
 * `COALESCE(g->>'gateway_id', g->>'gatewayId')` so both shapes work — a missing key would
 * otherwise mean an empty gateway inventory, and an empty inventory reports no faults,
 * which is the one failure mode worth engineering against here. To see what your
 * deployment actually stores:
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
 * Rows surviving the shape guards, materialized.
 *
 * MATERIALIZED is load-bearing rather than a hint. `jsonb_array_elements` raises an error
 * on a value that is not an array, and a lateral join is logically evaluated before the
 * WHERE clause that would have excluded such a row — so with an inlinable CTE, one
 * malformed rx_info anywhere in the window can abort the whole sounding. Materializing
 * forces the filter to run first. signal-degraded gets away without it only because its
 * jsonb_array_elements sits in a scalar subquery in the target list, which is evaluated
 * after WHERE.
 */
const RX_ROWS = `
  WITH rx AS MATERIALIZED (
    SELECT dev_eui, time, rx_info
      FROM event_up
     WHERE time > now() - make_interval(hours => $1::int)
       AND rx_info IS NOT NULL
       AND jsonb_typeof(rx_info) = 'array'
       AND jsonb_array_length(rx_info) > 0
  ),
  seen AS (
    SELECT COALESCE(g->>'gateway_id', g->>'gatewayId') AS gateway_id,
           rx.dev_eui,
           rx.time,
           g AS gw
      FROM rx
      CROSS JOIN LATERAL jsonb_array_elements(rx.rx_info) AS g
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
  /** Best simultaneous gateway count seen in the historical window. */
  historicalMax: number;
  /** Best simultaneous gateway count seen in the recent window. */
  recentMax: number;
  recentUplinks: number;
  historicalUplinks: number;
}

/**
 * Per device, the most gateways that ever heard one of its uplinks, historically and
 * recently.
 *
 * Maximum rather than average, deliberately. An average falls when a distant gateway
 * hears the device intermittently, which is not a loss of anything; the maximum only
 * falls when a gateway that used to hear it reliably has stopped. That is the difference
 * between a device with no redundancy left and a device whose third gateway is marginal.
 */
export async function gatewayRedundancy(
  ctx: SoundingContext,
  historyHours: number,
  recentHours: number,
  scope: DeviceScope,
): Promise<GatewayRedundancy[]> {
  // $1 historyHours, $2 recentHours, then the two the device scope always consumes.
  const sc = scopeClause(scope, 3);

  const rows = await ctx.query<{
    dev_eui: string;
    device_name: string | null;
    historical_max: string;
    recent_max: string | null;
    recent_uplinks: string;
    historical_uplinks: string;
  }>(
    `WITH rx AS MATERIALIZED (
       SELECT dev_eui, device_name, time, jsonb_array_length(rx_info) AS gateways
         FROM event_up
        WHERE time > now() - make_interval(hours => $1::int)
          AND rx_info IS NOT NULL
          AND jsonb_typeof(rx_info) = 'array'
          AND jsonb_array_length(rx_info) > 0
          ${sc.sql}
     )
     SELECT dev_eui,
            max(device_name)                                                  AS device_name,
            max(gateways)                                                     AS historical_max,
            max(gateways) FILTER (
              WHERE time > now() - make_interval(hours => $2::int))            AS recent_max,
            count(*) FILTER (
              WHERE time > now() - make_interval(hours => $2::int))            AS recent_uplinks,
            count(*)                                                          AS historical_uplinks
       FROM rx
      GROUP BY dev_eui
      ORDER BY dev_eui`,
    [historyHours, recentHours, ...sc.values],
  );

  return rows.map((r) => ({
    devEui: r.dev_eui,
    deviceName: r.device_name,
    historicalMax: Number(r.historical_max),
    recentMax: r.recent_max === null ? 0 : Number(r.recent_max),
    recentUplinks: Number(r.recent_uplinks),
    historicalUplinks: Number(r.historical_uplinks),
  }));
}

/** A gateway's timekeeping, as reported alongside each reception. */
export interface GatewayTimekeeping {
  gatewayId: string;
  receptions: number;
  /** Receptions carrying a gateway-supplied timestamp at all. */
  timestamped: number;
  /** Worst absolute divergence between the gateway's clock and the event time, seconds. */
  maxSkewSeconds: number | null;
  /** Median-ish figure: the mean absolute divergence, seconds. */
  avgSkewSeconds: number | null;
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
 * `gw_time` is ChirpStack's field for the gateway's own timestamp; `time_since_gps_epoch`
 * is present only with a lock, which makes its disappearance the cleaner signal of the
 * two. Both are read for whichever the deployment provides.
 */
export async function gatewayTimekeeping(
  ctx: SoundingContext,
  lookbackHours: number,
  scope: GatewayScope,
): Promise<GatewayTimekeeping[]> {
  const gs = gatewayScopeClause(scope, 2);

  const rows = await ctx.query<{
    gateway_id: string;
    receptions: string;
    timestamped: string;
    max_skew: string | null;
    avg_skew: string | null;
    last_seen: string;
  }>(
    `${RX_ROWS},
     timed AS (
       SELECT gateway_id,
              time,
              COALESCE(gw->>'gw_time', gw->>'gwTime', gw->>'time') AS gw_time,
              (gw ? 'time_since_gps_epoch') OR (gw ? 'timeSinceGpsEpoch') AS has_gps
         FROM seen
        WHERE gateway_id IS NOT NULL
          AND gateway_id <> ''
          ${gs.sql}
     )
     SELECT gateway_id,
            count(*)                                    AS receptions,
            count(*) FILTER (WHERE gw_time IS NOT NULL OR has_gps) AS timestamped,
            -- Only well-formed timestamps are compared; a garbage string is counted as
            -- untimestamped rather than cast, which would abort the sounding.
            max(abs(EXTRACT(EPOCH FROM (gw_time::timestamptz - time)))) FILTER (
              WHERE gw_time ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ]')     AS max_skew,
            round(avg(abs(EXTRACT(EPOCH FROM (gw_time::timestamptz - time)))) FILTER (
              WHERE gw_time ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ]'), 1) AS avg_skew,
            max(time)                                   AS last_seen
       FROM timed
      GROUP BY gateway_id
      ORDER BY gateway_id`,
    [lookbackHours, ...gs.values],
  );

  return rows.map((r) => ({
    gatewayId: r.gateway_id.toLowerCase(),
    receptions: Number(r.receptions),
    timestamped: Number(r.timestamped),
    maxSkewSeconds: r.max_skew === null ? null : Number(r.max_skew),
    avgSkewSeconds: r.avg_skew === null ? null : Number(r.avg_skew),
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
