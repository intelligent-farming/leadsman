/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Multi-path measurement resolution over the normalized codec vocabulary.
 *
 * Codecs from @intelligent-farming/lorawan-codec-normalization emit a fixed
 * vocabulary (104 leaf paths across 37 device categories), and — importantly —
 * fixed *units*: `wind.speed` is always m/s, `temperature` always °C,
 * `soil.moisture` always a percentage. That guarantee is what lets a check ship a
 * meaningful default threshold instead of asking the operator to supply one.
 *
 * What the vocabulary does not give you is a single path per concept. Temperature
 * arrives as `temperature`, `air.temperature`, `soil.temperature`,
 * `water.temperature.current`, or `leaf.temperature` depending on the device;
 * a level is `tank.level`, `tank.volume`, `tank.distance`, or `water.level`.
 * A frost check that only knew one of those would silently ignore most of a fleet.
 *
 * So every check here takes a *list* of candidate paths and resolves, per device,
 * the first one actually present in that device's telemetry. Devices carrying none
 * of the candidates produce no row at all — they are ignored rather than treated as
 * zero or as an error, which is what makes one config entry safe to point at a
 * mixed fleet.
 *
 * Resolution happens in SQL: candidate paths arrive as a single JSONB parameter and
 * are unnested `WITH ORDINALITY`, so "first match wins" is `ORDER BY ord` and no
 * SQL is built by string concatenation.
 */

import { ParamError } from './params';
import { ANY_DEVICE, scopeClause, type DeviceScope } from './scope';
import type { SoundingContext } from './types';

/** A device's resolved reading, plus which candidate path it came from. */
export interface Reading {
  devEui: string;
  deviceName: string | null;
  /** Dotted path that matched, e.g. "air.temperature". Goes into alert detail. */
  matchedPath: string;
  value: number;
  at: string;
}

/** A device's aggregate over a window. */
export interface WindowStat {
  devEui: string;
  deviceName: string | null;
  matchedPath: string;
  min: number;
  max: number;
  avg: number;
  first: number;
  last: number;
  samples: number;
  distinctValues: number;
  firstAt: string;
  lastAt: string;
}

/**
 * Normalize a `paths` parameter to the JSON form the SQL expects.
 *
 * Accepts a single dotted string, an array of dotted strings, or an array of
 * segment arrays — so config can say `"wind.speed"`, `["wind.speed", "air.speed"]`,
 * or `[["wind","speed"]]`. Order is significant: it is the resolution priority.
 */
export function resolvePaths(params: Record<string, unknown>, key = 'paths'): string[][] {
  const raw = params[key];

  const one = (v: unknown, at: string): string[] => {
    if (typeof v === 'string') {
      const parts = v.split('.').filter((s) => s.length > 0);
      if (parts.length === 0) throw new ParamError(`${at} is not a usable path`);
      return parts;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) throw new ParamError(`${at} must not be an empty path`);
      return v.map((seg, i) => {
        if (typeof seg !== 'string' || seg.length === 0) {
          throw new ParamError(`${at}[${i}] must be a non-empty string`);
        }
        return seg;
      });
    }
    throw new ParamError(`${at} must be a dotted string or array of strings`);
  };

  if (typeof raw === 'string') return [one(raw, `param "${key}"`)];

  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      throw new ParamError(`param "${key}" must list at least one candidate path`);
    }
    return raw.map((entry, i) => one(entry, `param "${key}"[${i}]`));
  }

  throw new ParamError(
    `param "${key}" must be a path or an array of paths (got ${JSON.stringify(raw)})`,
  );
}

/** Serialize resolved paths for the SQL parameter. */
function pathsJson(paths: string[][]): string {
  return JSON.stringify(paths);
}

export function pathsLabel(paths: string[][]): string {
  return paths.map((p) => p.join('.')).join(', ');
}

/**
 * Postgres fragment that turns the JSONB paths parameter into (ord, path) rows.
 * `$1` must be the paths JSON. Shared by every query below so resolution
 * semantics cannot drift between checks.
 */
const CANDIDATES = `
  candidates AS (
    SELECT ord, ARRAY(SELECT jsonb_array_elements_text(p)) AS path
      FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS t(p, ord)
  )`;

/**
 * Guard for casting a JSONB text value to numeric.
 *
 * A codec is free to emit `"3.7V"`, `"unknown"`, or `true` where a number is
 * expected — `additionalProperties` is open, and vendor codecs vary. Without this
 * the cast aborts the whole sounding on one bad row.
 */
const NUMERIC = `~ '^-?[0-9]+(\\.[0-9]+)?$'`;

/**
 * Each device's most recent value at the highest-priority path it reports.
 *
 * Use for "what is it doing right now" checks: thresholds, geofences, alarms.
 */
export async function latestReadings(
  ctx: SoundingContext,
  paths: string[][],
  lookbackHours: number,
  scope: DeviceScope = ANY_DEVICE,
): Promise<Reading[]> {
  const sc = scopeClause(scope, 3);
  const rows = await ctx.query<{
    dev_eui: string;
    device_name: string | null;
    matched_path: string;
    value: string;
    at: string;
  }>(
    `WITH ${CANDIDATES},
     latest AS (
       SELECT DISTINCT ON (dev_eui) dev_eui, device_name, time, object
         FROM event_up
        WHERE time > now() - make_interval(hours => $2::int)
          AND object IS NOT NULL
          ${sc.sql}
        ORDER BY dev_eui, time DESC
     )
     SELECT DISTINCT ON (l.dev_eui)
            l.dev_eui,
            l.device_name,
            array_to_string(c.path, '.')      AS matched_path,
            (l.object #>> c.path)::numeric    AS value,
            l.time                            AS at
       FROM latest l
       CROSS JOIN candidates c
      WHERE l.object #>> c.path IS NOT NULL
        AND l.object #>> c.path ${NUMERIC}
      ORDER BY l.dev_eui, c.ord`,
    [pathsJson(paths), Math.round(lookbackHours), ...sc.values],
  );

  return rows.map((r) => ({
    devEui: r.dev_eui,
    deviceName: r.device_name,
    matchedPath: r.matched_path,
    value: Number(r.value),
    at: r.at,
  }));
}

/**
 * Each device's most recent *boolean* value at its highest-priority path.
 *
 * Separate from the numeric path because JSONB booleans do not survive the numeric
 * guard, and because codecs express flags inconsistently — `true`, `"true"`, `1`,
 * and `"open"` all appear in the wild.
 */
export async function latestBooleans(
  ctx: SoundingContext,
  paths: string[][],
  lookbackHours: number,
  trueValues: string[],
  scope: DeviceScope = ANY_DEVICE,
): Promise<Array<Omit<Reading, 'value'> & { value: boolean; raw: string }>> {
  const sc = scopeClause(scope, 3);
  const rows = await ctx.query<{
    dev_eui: string;
    device_name: string | null;
    matched_path: string;
    raw: string;
    at: string;
  }>(
    `WITH ${CANDIDATES},
     latest AS (
       SELECT DISTINCT ON (dev_eui) dev_eui, device_name, time, object
         FROM event_up
        WHERE time > now() - make_interval(hours => $2::int)
          AND object IS NOT NULL
          ${sc.sql}
        ORDER BY dev_eui, time DESC
     )
     SELECT DISTINCT ON (l.dev_eui)
            l.dev_eui,
            l.device_name,
            array_to_string(c.path, '.') AS matched_path,
            l.object #>> c.path          AS raw,
            l.time                       AS at
       FROM latest l
       CROSS JOIN candidates c
      WHERE l.object #>> c.path IS NOT NULL
      ORDER BY l.dev_eui, c.ord`,
    [pathsJson(paths), Math.round(lookbackHours), ...sc.values],
  );

  const truthy = new Set(trueValues.map((v) => v.toLowerCase()));
  return rows.map((r) => ({
    devEui: r.dev_eui,
    deviceName: r.device_name,
    matchedPath: r.matched_path,
    raw: r.raw,
    value: truthy.has(String(r.raw).toLowerCase()),
    at: r.at,
  }));
}

/**
 * Per-device aggregate over a window at the highest-priority path.
 *
 * Use for peaks (wind gusts), variation (a stuck sensor), rate of change, and
 * counter behaviour. `first`/`last` are ordered by time, so a monotonic counter's
 * advance is `last - first`.
 *
 * Path priority is resolved per device from the *whole window*: the path with the
 * lowest ordinality that appears anywhere in the window wins, so a device that
 * intermittently omits a field is still evaluated on it.
 */
export async function windowStats(
  ctx: SoundingContext,
  paths: string[][],
  lookbackHours: number,
  decimals: number | null = null,
  scope: DeviceScope = ANY_DEVICE,
): Promise<WindowStat[]> {
  const sc = scopeClause(scope, 4, 'e');
  const rows = await ctx.query<{
    dev_eui: string;
    device_name: string | null;
    matched_path: string;
    vmin: string;
    vmax: string;
    vavg: string;
    vfirst: string;
    vlast: string;
    samples: string;
    distinct_values: string;
    first_at: string;
    last_at: string;
  }>(
    `WITH ${CANDIDATES},
     window_rows AS (
       SELECT e.dev_eui,
              e.device_name,
              e.time,
              c.ord,
              array_to_string(c.path, '.') AS matched_path,
              CASE WHEN $3::int IS NULL
                   THEN (e.object #>> c.path)::numeric
                   ELSE round((e.object #>> c.path)::numeric, $3::int)
              END AS value
         FROM event_up e
         CROSS JOIN candidates c
        WHERE e.time > now() - make_interval(hours => $2::int)
          AND e.object IS NOT NULL
          AND e.object #>> c.path IS NOT NULL
          AND e.object #>> c.path ${NUMERIC}
          ${sc.sql}
     ),
     -- One winning path per device: the lowest ordinality present in the window.
     winner AS (
       SELECT DISTINCT ON (dev_eui) dev_eui, ord
         FROM window_rows
        ORDER BY dev_eui, ord
     )
     SELECT w.dev_eui,
            max(w.device_name)                                        AS device_name,
            max(w.matched_path)                                       AS matched_path,
            min(w.value)                                              AS vmin,
            max(w.value)                                              AS vmax,
            round(avg(w.value), 4)                                    AS vavg,
            (array_agg(w.value ORDER BY w.time ASC))[1]               AS vfirst,
            (array_agg(w.value ORDER BY w.time DESC))[1]              AS vlast,
            count(*)                                                  AS samples,
            count(DISTINCT w.value)                                   AS distinct_values,
            min(w.time)                                               AS first_at,
            max(w.time)                                               AS last_at
       FROM window_rows w
       JOIN winner ON winner.dev_eui = w.dev_eui AND winner.ord = w.ord
      GROUP BY w.dev_eui`,
    [pathsJson(paths), Math.round(lookbackHours), decimals, ...sc.values],
  );

  return rows.map((r) => ({
    devEui: r.dev_eui,
    deviceName: r.device_name,
    matchedPath: r.matched_path,
    min: Number(r.vmin),
    max: Number(r.vmax),
    avg: Number(r.vavg),
    first: Number(r.vfirst),
    last: Number(r.vlast),
    samples: Number(r.samples),
    distinctValues: Number(r.distinct_values),
    firstAt: r.first_at,
    lastAt: r.last_at,
  }));
}

/**
 * Devices that report *any* of `expectPaths` at some point in the window, split
 * into those currently reporting it and those that have stopped.
 *
 * The basis of `measurement-missing`: a device that used to send `soil.moisture`
 * and no longer does has a codec or configuration problem, not a radio problem.
 */
export async function pathPresence(
  ctx: SoundingContext,
  paths: string[][],
  lookbackHours: number,
  recentHours: number,
  scope: DeviceScope = ANY_DEVICE,
): Promise<
  Array<{
    devEui: string;
    deviceName: string | null;
    matchedPath: string;
    everSeen: number;
    recentSeen: number;
    recentUplinks: number;
    lastSeenAt: string;
  }>
> {
  const rows = await ctx.query<{
    dev_eui: string;
    device_name: string | null;
    matched_path: string;
    ever_seen: string;
    recent_seen: string;
    recent_uplinks: string;
    last_seen_at: string;
  }>(
    `WITH ${CANDIDATES},
     scoped AS (
       SELECT e.dev_eui, e.device_name, e.time, e.object
         FROM event_up e
        WHERE e.time > now() - make_interval(hours => $2::int)
          ${scopeClause(scope, 4, 'e').sql}
     ),
     hits AS (
       SELECT s.dev_eui,
              c.ord,
              array_to_string(c.path, '.') AS matched_path,
              s.time
         FROM scoped s
         CROSS JOIN candidates c
        WHERE s.object IS NOT NULL
          AND s.object #>> c.path IS NOT NULL
     ),
     winner AS (
       SELECT DISTINCT ON (dev_eui) dev_eui, ord, matched_path
         FROM hits ORDER BY dev_eui, ord
     )
     SELECT w.dev_eui,
            max(s.device_name)  AS device_name,
            w.matched_path,
            count(h.time)                                                       AS ever_seen,
            count(h.time) FILTER (
              WHERE h.time > now() - make_interval(hours => $3::int))            AS recent_seen,
            count(s.time) FILTER (
              WHERE s.time > now() - make_interval(hours => $3::int))            AS recent_uplinks,
            max(h.time)                                                          AS last_seen_at
       FROM winner w
       JOIN scoped s ON s.dev_eui = w.dev_eui
       LEFT JOIN hits h ON h.dev_eui = w.dev_eui AND h.ord = w.ord AND h.time = s.time
      GROUP BY w.dev_eui, w.matched_path`,
    [pathsJson(paths), Math.round(lookbackHours), Math.round(recentHours),
     ...scopeClause(scope, 4, 'e').values],
  );

  return rows.map((r) => ({
    devEui: r.dev_eui,
    deviceName: r.device_name,
    matchedPath: r.matched_path,
    everSeen: Number(r.ever_seen),
    recentSeen: Number(r.recent_seen),
    recentUplinks: Number(r.recent_uplinks),
    lastSeenAt: r.last_seen_at,
  }));
}

/** Two-path coordinate resolution, for geofencing. */
export async function latestCoordinates(
  ctx: SoundingContext,
  latPaths: string[][],
  lonPaths: string[][],
  lookbackHours: number,
  scope: DeviceScope = ANY_DEVICE,
): Promise<
  Array<{
    devEui: string;
    deviceName: string | null;
    lat: number;
    lon: number;
    at: string;
  }>
> {
  const rows = await ctx.query<{
    dev_eui: string;
    device_name: string | null;
    lat: string;
    lon: string;
    at: string;
  }>(
    `WITH lat_candidates AS (
       SELECT ord, ARRAY(SELECT jsonb_array_elements_text(p)) AS path
         FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS t(p, ord)
     ),
     lon_candidates AS (
       SELECT ord, ARRAY(SELECT jsonb_array_elements_text(p)) AS path
         FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS t(p, ord)
     ),
     latest AS (
       SELECT DISTINCT ON (dev_eui) dev_eui, device_name, time, object
         FROM event_up
        WHERE time > now() - make_interval(hours => $3::int)
          AND object IS NOT NULL
          ${scopeClause(scope, 4).sql}
        ORDER BY dev_eui, time DESC
     )
     SELECT l.dev_eui,
            l.device_name,
            (SELECT (l.object #>> c.path)::numeric FROM lat_candidates c
              WHERE l.object #>> c.path IS NOT NULL AND l.object #>> c.path ${NUMERIC}
              ORDER BY c.ord LIMIT 1) AS lat,
            (SELECT (l.object #>> c.path)::numeric FROM lon_candidates c
              WHERE l.object #>> c.path IS NOT NULL AND l.object #>> c.path ${NUMERIC}
              ORDER BY c.ord LIMIT 1) AS lon,
            l.time AS at
       FROM latest l`,
    [pathsJson(latPaths), pathsJson(lonPaths), Math.round(lookbackHours),
     ...scopeClause(scope, 4).values],
  );

  return rows
    .filter((r) => r.lat !== null && r.lon !== null)
    .map((r) => ({
      devEui: r.dev_eui,
      deviceName: r.device_name,
      lat: Number(r.lat),
      lon: Number(r.lon),
      at: r.at,
    }));
}

/**
 * How long one device held a measurement inside a band, optionally only while a
 * second measurement was also inside a band of its own.
 *
 * `latestReadings` answers "is it out of bounds now" and `windowStats` answers "was
 * it ever". Neither can answer "for how long without a break", which is the only
 * question a plant pathogen cares about: humidity at 95 % for twenty minutes is
 * weather, the same 95 % held for eight hours is an infection period. See the
 * `mold-risk` rule.
 *
 * `mode` picks which aggregate, and the choice is not cosmetic — it is the difference
 * between two unrelated agronomic questions:
 *
 *   longest  the device's longest UNBROKEN run inside the band. Six separate one-hour
 *            spells are six failed infections; one six-hour spell is one successful
 *            one, and summing them would report the first as the second. This is what
 *            an infection period means.
 *   total    every in-band run added together. This is what an accumulation means —
 *            chill hours do not care whether the cold came in one stretch or twelve,
 *            only that the tree banked them. Reporting the longest run here would
 *            under-count a normal winter by an order of magnitude.
 *
 * `startedAt`/`endedAt` and the value extremes always describe the longest run, since
 * "when" has no meaning for a total.
 *
 * A run is broken by an out-of-band reading, and also by a reporting gap longer than
 * `maxGapHours` — while a device is silent nothing is known about the canopy, and
 * bridging the gap would invent dwell out of missing data. Set it to a small multiple
 * of the fleet's uplink interval.
 *
 * Duration is measured from the first in-band sample to the last, so it understates
 * the true run by up to one sampling interval at each end, and a run of a single
 * sample is zero hours. That is deliberate: every direction of error here is toward
 * not raising, which is the right way for a check that costs an LLM invocation to be
 * wrong.
 *
 * `gate` restricts which samples count at all. A sample counts only if the *same
 * uplink* also carried a gate value inside the gate band — same uplink rather than
 * nearest-in-time, because that is the only pairing the event store can guarantee is
 * one moment at one place. A device that reports humidity but never temperature
 * therefore contributes nothing while a gate is set, which is the honest answer and
 * why `gateSamples` is returned: the caller can say so rather than look healthy.
 *
 * Devices that reported a candidate path but never entered the band come back with
 * `hours: 0` and `samples: 0` rather than being dropped, so a caller can tell
 * "nothing is at risk" apart from "nothing is being measured".
 */
export interface DwellRun {
  devEui: string;
  deviceName: string | null;
  matchedPath: string;
  /** Hours inside the band: the longest unbroken run, or the total — see `mode`. */
  hours: number;
  /** Readings counted, under the same mode. 0 when the band was never entered. */
  samples: number;
  /** Extremes and mean across the run. Null when there was no run. */
  min: number | null;
  max: number | null;
  avg: number | null;
  /** Range the gate measurement covered during the run. Null without a gate. */
  gateMin: number | null;
  gateMax: number | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Readings at the matched path anywhere in the window, in band or not. */
  windowSamples: number;
  /** Of those, how many carried a usable gate value. Equals windowSamples with no gate. */
  gateSamples: number;
  /** The device's most recent reading in the window — `endedAt` equal to it means ongoing. */
  lastSampleAt: string;
}

/** Band bounds. A null bound is open on that side; both null matches everything. */
export interface Band {
  min: number | null;
  max: number | null;
}

export async function bandDwell(
  ctx: SoundingContext,
  paths: string[][],
  band: Band,
  lookbackHours: number,
  maxGapHours: number,
  gate: { paths: string[][]; band: Band } | null = null,
  scope: DeviceScope = ANY_DEVICE,
  mode: 'longest' | 'total' = 'longest',
): Promise<DwellRun[]> {
  const sc = scopeClause(scope, 10, 'e');
  // $12 is the mode flag, bound after the scope pair — see the values array below.
  const rows = await ctx.query<{
    dev_eui: string;
    device_name: string | null;
    matched_path: string;
    hours: string | null;
    samples: string | null;
    vmin: string | null;
    vmax: string | null;
    vavg: string | null;
    gate_min: string | null;
    gate_max: string | null;
    started_at: string | null;
    ended_at: string | null;
    window_samples: string;
    gate_samples: string;
    last_sample_at: string;
  }>(
    `WITH ${CANDIDATES},
     gate_candidates AS (
       SELECT ord, ARRAY(SELECT jsonb_array_elements_text(p)) AS path
         FROM jsonb_array_elements($5::jsonb) WITH ORDINALITY AS t(p, ord)
     ),
     scoped AS (
       SELECT e.dev_eui, e.device_name, e.time, e.object
         FROM event_up e
        WHERE e.time > now() - make_interval(hours => $2::int)
          AND e.object IS NOT NULL
          ${sc.sql}
     ),
     -- Every reading at every candidate path, each carrying the gate value from its
     -- own uplink. The gate subquery resolves by ordinality exactly as the main path
     -- does, so gate priority behaves the same way.
     samples AS (
       SELECT s.dev_eui,
              s.device_name,
              s.time,
              c.ord,
              array_to_string(c.path, '.') AS matched_path,
              (s.object #>> c.path)::numeric AS value,
              (SELECT (s.object #>> g.path)::numeric
                 FROM gate_candidates g
                WHERE s.object #>> g.path IS NOT NULL
                  AND s.object #>> g.path ${NUMERIC}
                ORDER BY g.ord
                LIMIT 1) AS gate_value
         FROM scoped s
         CROSS JOIN candidates c
        WHERE s.object #>> c.path IS NOT NULL
          AND s.object #>> c.path ${NUMERIC}
     ),
     winner AS (
       SELECT DISTINCT ON (dev_eui) dev_eui, ord
         FROM samples ORDER BY dev_eui, ord
     ),
     resolved AS (
       SELECT s.* FROM samples s
         JOIN winner w ON w.dev_eui = s.dev_eui AND w.ord = s.ord
     ),
     flagged AS (
       SELECT r.*,
              (    ($3::numeric IS NULL OR r.value >= $3::numeric)
               AND ($4::numeric IS NULL OR r.value <= $4::numeric)
               AND (NOT $8::boolean
                    OR (r.gate_value IS NOT NULL
                        AND ($6::numeric IS NULL OR r.gate_value >= $6::numeric)
                        AND ($7::numeric IS NULL OR r.gate_value <= $7::numeric)))
              ) AS in_band
         FROM resolved r
     ),
     -- Look back one reading per device, over ALL readings rather than only the
     -- in-band ones, so an out-of-band reading between two in-band ones breaks the run.
     stepped AS (
       SELECT f.*,
              lag(f.in_band) OVER w AS prev_in_band,
              lag(f.time)    OVER w AS prev_time
         FROM flagged f
       WINDOW w AS (PARTITION BY f.dev_eui ORDER BY f.time)
     ),
     marked AS (
       SELECT s.*,
              CASE WHEN s.prev_in_band IS NOT TRUE
                     OR EXTRACT(EPOCH FROM (s.time - s.prev_time)) / 3600.0 > $9::numeric
                   THEN 1 ELSE 0 END AS is_start
         FROM stepped s
     ),
     -- Gaps and islands: the running count of run-starts numbers each unbroken run.
     islanded AS (
       SELECT m.*,
              sum(m.is_start) OVER (PARTITION BY m.dev_eui ORDER BY m.time
                                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS island
         FROM marked m
        WHERE m.in_band
     ),
     runs AS (
       SELECT dev_eui,
              island,
              min(time)                                          AS started_at,
              max(time)                                          AS ended_at,
              count(*)                                           AS samples,
              min(value)                                         AS vmin,
              max(value)                                         AS vmax,
              round(avg(value), 4)                               AS vavg,
              min(gate_value)                                    AS gate_min,
              max(gate_value)                                    AS gate_max,
              round((EXTRACT(EPOCH FROM (max(time) - min(time))) / 3600.0)::numeric, 4) AS hours
         FROM islanded
        GROUP BY dev_eui, island
     ),
     longest AS (
       SELECT DISTINCT ON (dev_eui) *
         FROM runs ORDER BY dev_eui, hours DESC, ended_at DESC
     ),
     -- Every run added together, for the accumulation question. Joined back to the
     -- longest run so the timestamps and extremes still describe a real stretch rather
     -- than a span stitched out of unrelated ones.
     summed AS (
       SELECT dev_eui,
              round(sum(hours), 4) AS total_hours,
              sum(samples)         AS total_samples
         FROM runs GROUP BY dev_eui
     ),
     totals AS (
       SELECT dev_eui,
              max(device_name)                                    AS device_name,
              max(matched_path)                                   AS matched_path,
              count(*)                                            AS window_samples,
              count(*) FILTER (WHERE gate_value IS NOT NULL)       AS gate_samples,
              max(time)                                           AS last_sample_at
         FROM resolved
        GROUP BY dev_eui
     )
     SELECT t.dev_eui,
            t.device_name,
            t.matched_path,
            CASE WHEN $12::boolean THEN sm.total_hours   ELSE l.hours   END AS hours,
            CASE WHEN $12::boolean THEN sm.total_samples ELSE l.samples END AS samples,
            l.vmin,
            l.vmax,
            l.vavg,
            l.gate_min,
            l.gate_max,
            l.started_at,
            l.ended_at,
            t.window_samples,
            t.gate_samples,
            t.last_sample_at
       FROM totals t
       LEFT JOIN longest l ON l.dev_eui = t.dev_eui
       LEFT JOIN summed  sm ON sm.dev_eui = t.dev_eui`,
    [
      pathsJson(paths),
      Math.round(lookbackHours),
      band.min,
      band.max,
      pathsJson(gate ? gate.paths : []),
      gate ? gate.band.min : null,
      gate ? gate.band.max : null,
      gate !== null,
      maxGapHours,
      ...sc.values,
      mode === 'total',
    ],
  );

  return rows.map((r) => ({
    devEui: r.dev_eui,
    deviceName: r.device_name,
    matchedPath: r.matched_path,
    hours: r.hours === null ? 0 : Number(r.hours),
    samples: r.samples === null ? 0 : Number(r.samples),
    min: r.vmin === null ? null : Number(r.vmin),
    max: r.vmax === null ? null : Number(r.vmax),
    avg: r.vavg === null ? null : Number(r.vavg),
    gateMin: r.gate_min === null ? null : Number(r.gate_min),
    gateMax: r.gate_max === null ? null : Number(r.gate_max),
    startedAt: r.started_at,
    endedAt: r.ended_at,
    windowSamples: Number(r.window_samples),
    gateSamples: Number(r.gate_samples),
    lastSampleAt: r.last_sample_at,
  }));
}

/**
 * Least-squares slope over the window, plus how well the line actually fits.
 *
 * `windowStats` gives `first` and `last`, and `measurement-rate` divides their
 * difference by the span. Over six hours that is fine and it is far steadier than an
 * instantaneous derivative. Over a season it is close to useless: a thirty-day trend
 * computed from exactly two readings inherits every fault of those two readings, and a
 * single bad endpoint invents or erases a trend on its own.
 *
 * Seasonal drift is a real agronomic condition — salinity creeping up under deficit
 * irrigation, a water table falling year on year, a probe slowly decalibrating — and it
 * is invisible to every other mechanism here. A threshold does not fire until the
 * damage is done, and a six-hour slope is pure noise at that timescale.
 *
 * `regr_slope` is computed against time in HOURS, so the slope is per hour and directly
 * comparable with the endpoint method. `r2` comes back alongside it because a slope
 * without a fit quality is a number that will confidently describe a straight line
 * through a cloud: a caller can insist on a minimum r² before believing a trend.
 */
export interface TrendStat {
  devEui: string;
  deviceName: string | null;
  matchedPath: string;
  /** Least-squares slope, in measurement units per hour. */
  slopePerHour: number;
  /** Coefficient of determination, 0-1. Null when Postgres cannot compute one. */
  r2: number | null;
  /** Fitted value at the start and end of the observed span. */
  fittedFirst: number;
  fittedLast: number;
  samples: number;
  spanHours: number;
  firstAt: string;
  lastAt: string;
}

export async function windowTrend(
  ctx: SoundingContext,
  paths: string[][],
  lookbackHours: number,
  scope: DeviceScope = ANY_DEVICE,
): Promise<TrendStat[]> {
  const sc = scopeClause(scope, 3, 'e');
  const rows = await ctx.query<{
    dev_eui: string;
    device_name: string | null;
    matched_path: string;
    slope: string | null;
    intercept: string | null;
    r2: string | null;
    samples: string;
    first_h: string;
    last_h: string;
    first_at: string;
    last_at: string;
  }>(
    `WITH ${CANDIDATES},
     window_rows AS (
       SELECT e.dev_eui,
              e.device_name,
              e.time,
              c.ord,
              array_to_string(c.path, '.') AS matched_path,
              (e.object #>> c.path)::numeric::double precision AS value,
              -- Hours since the window opened. Regressing against a small number keeps
              -- the slope in per-hour units without a second conversion.
              EXTRACT(EPOCH FROM (e.time - (now() - make_interval(hours => $2::int))))
                / 3600.0 AS h
         FROM event_up e
         CROSS JOIN candidates c
        WHERE e.time > now() - make_interval(hours => $2::int)
          AND e.object IS NOT NULL
          AND e.object #>> c.path IS NOT NULL
          AND e.object #>> c.path ${NUMERIC}
          ${sc.sql}
     ),
     winner AS (
       SELECT DISTINCT ON (dev_eui) dev_eui, ord FROM window_rows ORDER BY dev_eui, ord
     )
     SELECT w.dev_eui,
            max(w.device_name)             AS device_name,
            max(w.matched_path)            AS matched_path,
            regr_slope(w.value, w.h)       AS slope,
            regr_intercept(w.value, w.h)   AS intercept,
            regr_r2(w.value, w.h)          AS r2,
            count(*)                       AS samples,
            min(w.h)                       AS first_h,
            max(w.h)                       AS last_h,
            min(w.time)                    AS first_at,
            max(w.time)                    AS last_at
       FROM window_rows w
       JOIN winner ON winner.dev_eui = w.dev_eui AND winner.ord = w.ord
      GROUP BY w.dev_eui
     -- regr_slope is null for fewer than two points, or when every x is identical.
     HAVING regr_slope(w.value, w.h) IS NOT NULL`,
    [pathsJson(paths), Math.round(lookbackHours), ...sc.values],
  );

  return rows.map((r) => {
    const slope = Number(r.slope);
    const intercept = Number(r.intercept);
    const firstH = Number(r.first_h);
    const lastH = Number(r.last_h);
    return {
      devEui: r.dev_eui,
      deviceName: r.device_name,
      matchedPath: r.matched_path,
      slopePerHour: slope,
      r2: r.r2 === null ? null : Number(r.r2),
      fittedFirst: intercept + slope * firstH,
      fittedLast: intercept + slope * lastH,
      samples: Number(r.samples),
      spanHours: lastH - firstH,
      firstAt: r.first_at,
      lastAt: r.last_at,
    };
  });
}

/**
 * A device's accumulation across the window: how much, not how high.
 *
 * Nothing else in this engine integrates. That single absence is what blocks most of
 * the standard agronomic index set, because the numbers a grower plans against are
 * almost all totals rather than instants:
 *
 *   - growing degree days — the integral of `max(0, T - base)`, driving pest emergence,
 *     harvest timing and variety fit
 *   - daily light integral — the integral of PAR, the governing number under glass
 *   - rainfall or irrigation delivered — the integral of an intensity
 *   - cumulative heat or cold exposure — post-harvest quality, cold-chain dwell
 *
 * Two methods, and picking the wrong one is the main way to get a nonsense answer:
 *
 *   integral  the area under the curve, trapezoid between consecutive readings, in
 *             `unit·hours`. Correct for anything expressed as a RATE or a level that
 *             persists between readings — temperature, PAR, mm/hour of rain. Insensitive
 *             to reporting cadence, which matters because LoRaWAN cadence is irregular.
 *   sum       every reading added up, ignoring time. Correct only when each reading is
 *             already a quantity per report — a per-interval tipping-bucket total. A sum
 *             over a rate silently scales with how often the device happens to report.
 *
 * `base` is subtracted before integrating and the remainder is floored at zero, which
 * is exactly the degree-day definition: hours below the base contribute nothing rather
 * than cancelling out hours above it. Leave it null to integrate the raw value.
 *
 * A gap longer than `maxGapHours` contributes nothing at all. Assuming a constant value
 * across a silent day would manufacture degree days out of a dead radio, and an index
 * that quietly counts its own outages is worse than no index.
 */
export interface Accumulation {
  devEui: string;
  deviceName: string | null;
  matchedPath: string;
  /** Integral in unit·hours, or the plain sum, depending on the method. */
  total: number;
  /** Readings that contributed. */
  samples: number;
  /** Hours actually covered — the window minus the gaps that were skipped. */
  coveredHours: number;
  /** Hours discarded as gaps. Large values mean the total understates reality. */
  gapHours: number;
  min: number;
  max: number;
  firstAt: string;
  lastAt: string;
}

export async function windowAccumulation(
  ctx: SoundingContext,
  paths: string[][],
  lookbackHours: number,
  method: 'integral' | 'sum',
  base: number | null,
  maxGapHours: number,
  scope: DeviceScope = ANY_DEVICE,
): Promise<Accumulation[]> {
  const sc = scopeClause(scope, 6, 'e');
  const rows = await ctx.query<{
    dev_eui: string;
    device_name: string | null;
    matched_path: string;
    total: string | null;
    samples: string;
    covered_hours: string | null;
    gap_hours: string | null;
    vmin: string;
    vmax: string;
    first_at: string;
    last_at: string;
  }>(
    `WITH ${CANDIDATES},
     window_rows AS (
       SELECT e.dev_eui,
              e.device_name,
              e.time,
              c.ord,
              array_to_string(c.path, '.') AS matched_path,
              (e.object #>> c.path)::numeric AS raw
         FROM event_up e
         CROSS JOIN candidates c
        WHERE e.time > now() - make_interval(hours => $2::int)
          AND e.object IS NOT NULL
          AND e.object #>> c.path IS NOT NULL
          AND e.object #>> c.path ${NUMERIC}
          ${sc.sql}
     ),
     winner AS (
       SELECT DISTINCT ON (dev_eui) dev_eui, ord FROM window_rows ORDER BY dev_eui, ord
     ),
     resolved AS (
       SELECT w.dev_eui, w.device_name, w.time, w.matched_path, w.raw,
              -- Degree-day semantics: below the base contributes nothing, rather than
              -- cancelling out the hours above it.
              CASE WHEN $4::numeric IS NULL THEN w.raw
                   ELSE greatest(w.raw - $4::numeric, 0) END AS value
         FROM window_rows w
         JOIN winner ON winner.dev_eui = w.dev_eui AND winner.ord = w.ord
     ),
     stepped AS (
       SELECT r.*,
              lag(r.value) OVER w AS prev_value,
              lag(r.time)  OVER w AS prev_time
         FROM resolved r
       WINDOW w AS (PARTITION BY r.dev_eui ORDER BY r.time)
     ),
     -- One trapezoid per adjacent pair, dropped when the pair straddles a gap.
     slices AS (
       SELECT s.dev_eui,
              CASE WHEN s.prev_time IS NULL THEN NULL
                   ELSE EXTRACT(EPOCH FROM (s.time - s.prev_time)) / 3600.0
              END AS dt,
              s.value, s.prev_value
         FROM stepped s
     )
     SELECT r.dev_eui,
            max(r.device_name)  AS device_name,
            max(r.matched_path) AS matched_path,
            CASE WHEN $3::text = 'sum'
                 THEN round(sum(r.value), 6)
                 ELSE (SELECT round(COALESCE(sum((sl.value + sl.prev_value) / 2 * sl.dt::numeric), 0), 6)
                         FROM slices sl
                        WHERE sl.dev_eui = r.dev_eui
                          AND sl.dt IS NOT NULL
                          AND sl.dt <= $5::numeric)
            END AS total,
            count(*) AS samples,
            (SELECT round(COALESCE(sum(sl.dt::numeric), 0), 4) FROM slices sl
              WHERE sl.dev_eui = r.dev_eui AND sl.dt IS NOT NULL AND sl.dt <= $5::numeric)
              AS covered_hours,
            (SELECT round(COALESCE(sum(sl.dt::numeric), 0), 4) FROM slices sl
              WHERE sl.dev_eui = r.dev_eui AND sl.dt IS NOT NULL AND sl.dt > $5::numeric)
              AS gap_hours,
            min(r.raw)   AS vmin,
            max(r.raw)   AS vmax,
            min(r.time)  AS first_at,
            max(r.time)  AS last_at
       FROM resolved r
      GROUP BY r.dev_eui`,
    [
      pathsJson(paths),
      Math.round(lookbackHours),
      method,
      base,
      maxGapHours,
      ...sc.values,
    ],
  );

  return rows.map((r) => ({
    devEui: r.dev_eui,
    deviceName: r.device_name,
    matchedPath: r.matched_path,
    total: r.total === null ? 0 : Number(r.total),
    samples: Number(r.samples),
    coveredHours: r.covered_hours === null ? 0 : Number(r.covered_hours),
    gapHours: r.gap_hours === null ? 0 : Number(r.gap_hours),
    min: Number(r.vmin),
    max: Number(r.vmax),
    firstAt: r.first_at,
    lastAt: r.last_at,
  }));
}

/**
 * Each device's recent mean, alongside the median and spread of its peer group.
 *
 * Every other check in this engine is longitudinal — one device against its own past.
 * This is the cross-sectional one, and it catches a fault class the others structurally
 * cannot: the device that is *plausibly wrong*.
 *
 *   - A drifting probe. `measurement-stuck` catches one that died; a probe reading 8 %
 *     low passes every threshold, varies convincingly, and quietly biases every
 *     decision made from it. Its neighbours are the only available ground truth.
 *   - Irrigation uniformity. Probes on one valve should move together. One that does
 *     not is a blocked line, a failed emitter or a shut lateral — invisible per-device.
 *   - Frost inversion, which is by definition a difference between two sensors.
 *
 * Spread is measured as median absolute deviation, not standard deviation, because the
 * outlier being looked for would inflate a standard deviation enough to hide itself —
 * with a handful of probes per valve, one bad sensor can raise σ past its own error.
 * MAD does not move. The 1.4826 factor rescales MAD to be comparable with σ for normal
 * data, so a threshold in "sigmas" means roughly the usual thing.
 *
 * The group is whatever the scope selects, so grouping is expressed the same way every
 * other check narrows a fleet: a device profile, or a name pattern per valve or block.
 */
export interface GroupDeviation {
  devEui: string;
  deviceName: string | null;
  matchedPath: string;
  /** This device's mean over the window. */
  value: number;
  samples: number;
  /** Median across every device in the group. */
  groupMedian: number;
  /** Median absolute deviation, rescaled to sigma-equivalent units. */
  groupSpread: number;
  /** Devices in the group, including this one. */
  groupSize: number;
  /** Signed deviation in sigma-equivalents. Null when the group has no spread at all. */
  deviations: number | null;
}

export async function groupDeviation(
  ctx: SoundingContext,
  paths: string[][],
  lookbackHours: number,
  scope: DeviceScope = ANY_DEVICE,
): Promise<GroupDeviation[]> {
  const sc = scopeClause(scope, 3, 'e');
  const rows = await ctx.query<{
    dev_eui: string;
    device_name: string | null;
    matched_path: string;
    value: string;
    samples: string;
    group_median: string;
    group_spread: string;
    group_size: string;
  }>(
    `WITH ${CANDIDATES},
     window_rows AS (
       SELECT e.dev_eui, e.device_name, e.time, c.ord,
              array_to_string(c.path, '.') AS matched_path,
              (e.object #>> c.path)::numeric AS value
         FROM event_up e
         CROSS JOIN candidates c
        WHERE e.time > now() - make_interval(hours => $2::int)
          AND e.object IS NOT NULL
          AND e.object #>> c.path IS NOT NULL
          AND e.object #>> c.path ${NUMERIC}
          ${sc.sql}
     ),
     winner AS (
       SELECT DISTINCT ON (dev_eui) dev_eui, ord FROM window_rows ORDER BY dev_eui, ord
     ),
     -- One number per device first: comparing raw readings across devices would
     -- compare whoever happened to report most recently.
     per_device AS (
       SELECT w.dev_eui,
              max(w.device_name)  AS device_name,
              max(w.matched_path) AS matched_path,
              avg(w.value)        AS value,
              count(*)            AS samples
         FROM window_rows w
         JOIN winner ON winner.dev_eui = w.dev_eui AND winner.ord = w.ord
        GROUP BY w.dev_eui
     ),
     centre AS (
       SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY value) AS med,
              count(*) AS n
         FROM per_device
     ),
     -- MAD rather than stddev: with six probes on a valve, the bad one inflates a
     -- standard deviation enough to fall inside its own threshold.
     spread AS (
       SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(p.value - c.med)) * 1.4826
                AS mad
         FROM per_device p CROSS JOIN centre c
     )
     -- percentile_cont returns double precision, and round(double precision, int)
     -- does not exist in Postgres. The ::numeric casts are load-bearing.
     SELECT p.dev_eui, p.device_name, p.matched_path,
            round(p.value::numeric, 4)                  AS value,
            p.samples,
            round(c.med::numeric, 4)                    AS group_median,
            round(COALESCE(s.mad, 0)::numeric, 6)       AS group_spread,
            c.n                                         AS group_size
       FROM per_device p CROSS JOIN centre c CROSS JOIN spread s`,
    [pathsJson(paths), Math.round(lookbackHours), ...sc.values],
  );

  return rows.map((r) => {
    const value = Number(r.value);
    const groupMedian = Number(r.group_median);
    const groupSpread = Number(r.group_spread);
    return {
      devEui: r.dev_eui,
      deviceName: r.device_name,
      matchedPath: r.matched_path,
      value,
      samples: Number(r.samples),
      groupMedian,
      groupSpread,
      groupSize: Number(r.group_size),
      // A group where every device reads identically has no scale to judge deviation
      // against. Null says "cannot tell" rather than dividing by zero into Infinity.
      deviations: groupSpread > 0 ? (value - groupMedian) / groupSpread : null,
    };
  });
}

/**
 * Did the thing that was supposed to follow an action actually follow it?
 *
 * `downlink-unacked` catches a command that was never acknowledged. Nothing here
 * catches the worse case: a command that WAS acknowledged, by a device that is online
 * and reporting happily, whose physical effect never arrived. The valve reported open
 * and no water moved. The flow meter turned and the root zone stayed dry. The frost
 * fans started and the temperature kept falling.
 *
 * That is the expensive silent failure on a farm, because the operator believes the
 * action happened — the log says so — and finds out at harvest. It is invisible to
 * every per-measurement mechanism, since both halves look individually healthy: the
 * counter advanced (fine) and the moisture is 22 % (fine, if unremarkable).
 *
 * The mechanism is a LAGGED correlation between two paths on one device. `mold-risk`
 * correlates two measurements within a single uplink; this correlates a trigger with a
 * response separated by however long the physics takes.
 *
 *   trigger   a numeric path that INCREASED by at least `triggerDelta`. A monotonic
 *             counter advancing (litres delivered, pump runtime) is the natural case,
 *             and a 0/1 flag going up works identically with a delta of 1.
 *   response  a path expected to move by at least `minChange` in `direction` within
 *             `responseWindowHours` of the trigger.
 *
 * Only triggers old enough for the response window to have fully elapsed are
 * considered. Without that the check reports every irrigation the moment it starts,
 * before the water could possibly have reached the probe, and the alert is guaranteed
 * to be wrong rather than merely likely to be.
 *
 * The baseline is the last response reading at or before the trigger, so a response
 * that was already high does not excuse one that never moved.
 */
export interface TriggerResponse {
  devEui: string;
  deviceName: string | null;
  triggerPath: string;
  responsePath: string;
  /** When the trigger fired. */
  triggeredAt: string;
  /** How far the trigger path advanced. */
  triggerDelta: number;
  /** Response value immediately before the trigger. */
  baseline: number;
  /** The furthest the response got, in the expected direction, inside the window. */
  extreme: number;
  /** Signed movement from baseline to extreme. */
  change: number;
  /** Response readings inside the window. Zero means nothing to judge. */
  responseSamples: number;
}

export async function triggerResponse(
  ctx: SoundingContext,
  triggerPaths: string[][],
  responsePaths: string[][],
  lookbackHours: number,
  triggerDelta: number,
  responseWindowHours: number,
  direction: 'rising' | 'falling',
  scope: DeviceScope = ANY_DEVICE,
): Promise<TriggerResponse[]> {
  const sc = scopeClause(scope, 7, 'e');
  const rows = await ctx.query<{
    dev_eui: string;
    device_name: string | null;
    trigger_path: string;
    response_path: string;
    triggered_at: string;
    trigger_delta: string;
    baseline: string | null;
    extreme: string | null;
    response_samples: string;
  }>(
    `WITH ${CANDIDATES},
     response_candidates AS (
       SELECT ord, ARRAY(SELECT jsonb_array_elements_text(p)) AS path
         FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY AS t(p, ord)
     ),
     scoped AS (
       SELECT e.dev_eui, e.device_name, e.time, e.object
         FROM event_up e
        WHERE e.time > now() - make_interval(hours => $2::int)
          AND e.object IS NOT NULL
          ${sc.sql}
     ),
     trig_rows AS (
       SELECT s.dev_eui, s.device_name, s.time, c.ord,
              array_to_string(c.path, '.') AS matched_path,
              (s.object #>> c.path)::numeric AS value
         FROM scoped s CROSS JOIN candidates c
        WHERE s.object #>> c.path IS NOT NULL AND s.object #>> c.path ${NUMERIC}
     ),
     trig_winner AS (
       SELECT DISTINCT ON (dev_eui) dev_eui, ord FROM trig_rows ORDER BY dev_eui, ord
     ),
     trig AS (
       SELECT t.*, t.value - lag(t.value) OVER w AS advance
         FROM trig_rows t JOIN trig_winner tw
           ON tw.dev_eui = t.dev_eui AND tw.ord = t.ord
       WINDOW w AS (PARTITION BY t.dev_eui ORDER BY t.time)
     ),
     -- The most recent qualifying trigger that is ALSO old enough for the response
     -- window to have run out. Reporting one still in progress is guaranteed noise.
     fired AS (
       SELECT DISTINCT ON (dev_eui)
              dev_eui, device_name, matched_path AS trigger_path, time AS triggered_at,
              advance AS trigger_delta
         FROM trig
        WHERE advance >= $3::numeric
          AND time <= now() - make_interval(secs => ($5::numeric * 3600)::int)
        ORDER BY dev_eui, time DESC
     ),
     resp_rows AS (
       SELECT s.dev_eui, s.time, rc.ord,
              array_to_string(rc.path, '.') AS matched_path,
              (s.object #>> rc.path)::numeric AS value
         FROM scoped s CROSS JOIN response_candidates rc
        WHERE s.object #>> rc.path IS NOT NULL AND s.object #>> rc.path ${NUMERIC}
     ),
     resp_winner AS (
       SELECT DISTINCT ON (dev_eui) dev_eui, ord FROM resp_rows ORDER BY dev_eui, ord
     ),
     resp AS (
       SELECT r.* FROM resp_rows r JOIN resp_winner rw
         ON rw.dev_eui = r.dev_eui AND rw.ord = r.ord
     )
     SELECT f.dev_eui,
            f.device_name,
            f.trigger_path,
            (SELECT max(matched_path) FROM resp WHERE dev_eui = f.dev_eui) AS response_path,
            f.triggered_at,
            f.trigger_delta,
            -- Baseline: the last response reading at or before the trigger.
            (SELECT r.value FROM resp r
              WHERE r.dev_eui = f.dev_eui AND r.time <= f.triggered_at
              ORDER BY r.time DESC LIMIT 1) AS baseline,
            -- How far it got in the expected direction inside the window.
            (SELECT CASE WHEN $6::text = 'rising' THEN max(r.value) ELSE min(r.value) END
               FROM resp r
              WHERE r.dev_eui = f.dev_eui
                AND r.time > f.triggered_at
                AND r.time <= f.triggered_at + make_interval(secs => ($5::numeric * 3600)::int)
            ) AS extreme,
            (SELECT count(*) FROM resp r
              WHERE r.dev_eui = f.dev_eui
                AND r.time > f.triggered_at
                AND r.time <= f.triggered_at + make_interval(secs => ($5::numeric * 3600)::int)
            ) AS response_samples
       FROM fired f`,
    [
      pathsJson(triggerPaths),
      Math.round(lookbackHours),
      triggerDelta,
      pathsJson(responsePaths),
      responseWindowHours,
      direction,
      ...sc.values,
    ],
  );

  return rows
    // No baseline or no reading afterwards means there is nothing to judge, not a
    // failure. Reporting it would turn "the probe was offline" into "the valve failed".
    .filter((r) => r.baseline !== null && r.extreme !== null && Number(r.response_samples) > 0)
    .map((r) => {
      const baseline = Number(r.baseline);
      const extreme = Number(r.extreme);
      return {
        devEui: r.dev_eui,
        deviceName: r.device_name,
        triggerPath: r.trigger_path,
        responsePath: r.response_path,
        triggeredAt: r.triggered_at,
        triggerDelta: Number(r.trigger_delta),
        baseline,
        extreme,
        change: extreme - baseline,
        responseSamples: Number(r.response_samples),
      };
    });
}

/**
 * How long a flag has been continuously asserted, up to the device's latest reading.
 *
 * `latestBooleans` answers "is the flag set right now", which is the whole story for a
 * leak or a smoke detector — those are worth a text the instant they assert. It is the
 * wrong question for everything that is *normal briefly and expensive for long*:
 *
 *   - a cold-store door open for 3 minutes is someone fetching a pallet; open for
 *     3 hours is a ruined load, and the flag reads identically in both
 *   - a pump running is normal; a pump that has been running for 14 hours is a float
 *     switch that failed closed, or a leak downstream
 *   - an irrigation valve open past its scheduled window is water on the ground
 *
 * Returns the CURRENT run — asserted readings ending at the most recent one — not the
 * longest in the window. A door that stood open for six hours yesterday and is shut
 * now is not a problem now, and an alert engine whose job is "what is wrong at this
 * moment" must not report it as one.
 *
 * Duration runs from the first asserted reading of the current run to the latest, so
 * it understates by up to one reporting interval, and a flag asserted in exactly one
 * reading is zero. A gap longer than `maxGapHours` breaks the run: a device that went
 * silent and came back asserted has not been observed asserted throughout.
 */
export interface BooleanRun {
  devEui: string;
  deviceName: string | null;
  matchedPath: string;
  /** Raw value of the latest reading, as the codec wrote it. */
  raw: string;
  /** True when the latest reading is asserted. Only then is `hours` meaningful. */
  asserted: boolean;
  /** Length of the current unbroken asserted run, in hours. */
  hours: number;
  samples: number;
  startedAt: string | null;
  lastAt: string;
}

export async function booleanDwell(
  ctx: SoundingContext,
  paths: string[][],
  lookbackHours: number,
  trueValues: string[],
  maxGapHours: number,
  scope: DeviceScope = ANY_DEVICE,
): Promise<BooleanRun[]> {
  const sc = scopeClause(scope, 4, 'e');
  const rows = await ctx.query<{
    dev_eui: string;
    device_name: string | null;
    matched_path: string;
    raw: string;
    is_true: boolean;
    at: string;
  }>(
    `WITH ${CANDIDATES},
     scoped AS (
       SELECT e.dev_eui, e.device_name, e.time, e.object
         FROM event_up e
        WHERE e.time > now() - make_interval(hours => $2::int)
          AND e.object IS NOT NULL
          ${sc.sql}
     ),
     rows_at_paths AS (
       SELECT s.dev_eui, s.device_name, s.time, c.ord,
              array_to_string(c.path, '.') AS matched_path,
              s.object #>> c.path AS raw
         FROM scoped s CROSS JOIN candidates c
        WHERE s.object #>> c.path IS NOT NULL
     ),
     winner AS (
       SELECT DISTINCT ON (dev_eui) dev_eui, ord FROM rows_at_paths ORDER BY dev_eui, ord
     )
     SELECT r.dev_eui, r.device_name, r.matched_path, r.raw,
            lower(r.raw) = ANY($3::text[]) AS is_true,
            r.time AS at
       FROM rows_at_paths r
       JOIN winner w ON w.dev_eui = r.dev_eui AND w.ord = r.ord
      ORDER BY r.dev_eui, r.time DESC`,
    [
      pathsJson(paths),
      Math.round(lookbackHours),
      trueValues.map((v) => v.toLowerCase()),
      ...sc.values,
    ],
  );

  // Walking backwards from the newest reading is the whole algorithm: stop at the
  // first reading that is not asserted, or at the first gap too long to bridge. Done
  // in TypeScript rather than SQL because "current run" is a scan from one end, and
  // the readable version of that is a loop.
  const out: BooleanRun[] = [];
  let i = 0;
  while (i < rows.length) {
    const devEui = rows[i].dev_eui;
    let j = i;
    while (j < rows.length && rows[j].dev_eui === devEui) j += 1;
    const series = rows.slice(i, j); // newest first
    i = j;

    const latest = series[0];
    if (!latest.is_true) {
      out.push({
        devEui,
        deviceName: latest.device_name,
        matchedPath: latest.matched_path,
        raw: latest.raw,
        asserted: false,
        hours: 0,
        samples: 0,
        startedAt: null,
        lastAt: latest.at,
      });
      continue;
    }

    let start = latest;
    let samples = 1;
    for (let k = 1; k < series.length; k += 1) {
      const older = series[k];
      if (!older.is_true) break;
      const gapHours =
        (new Date(start.at).getTime() - new Date(older.at).getTime()) / 3_600_000;
      if (gapHours > maxGapHours) break;
      start = older;
      samples += 1;
    }

    out.push({
      devEui,
      deviceName: latest.device_name,
      matchedPath: latest.matched_path,
      raw: latest.raw,
      asserted: true,
      hours:
        (new Date(latest.at).getTime() - new Date(start.at).getTime()) / 3_600_000,
      samples,
      startedAt: start.at,
      lastAt: latest.at,
    });
  }

  return out;
}

/**
 * Two measurements from one uplink, per device.
 *
 * Every derived agronomic index is a formula over two quantities measured at the same
 * instant in the same place: VPD and dew point from temperature and humidity, delta-T
 * from a dry bulb and a wet bulb, THI from temperature and humidity. Pairing by
 * *uplink* rather than by nearest timestamp is the whole point — a temperature from
 * 04:00 and a humidity from 16:00 produce a VPD that is arithmetically valid and
 * physically meaningless.
 *
 * Both sides resolve through the ordinary candidate-path priority, so one config entry
 * still covers a mixed fleet: a device reporting `air.temperature` and one reporting
 * bare `temperature` both pair correctly against the same humidity path.
 */
export interface ReadingPair {
  devEui: string;
  deviceName: string | null;
  primaryPath: string;
  secondaryPath: string;
  primary: number;
  secondary: number;
  at: string;
}

export async function latestPairs(
  ctx: SoundingContext,
  primaryPaths: string[][],
  secondaryPaths: string[][],
  lookbackHours: number,
  scope: DeviceScope = ANY_DEVICE,
): Promise<ReadingPair[]> {
  const sc = scopeClause(scope, 4, 'e');
  const rows = await ctx.query<{
    dev_eui: string;
    device_name: string | null;
    primary_path: string;
    secondary_path: string;
    primary_value: string;
    secondary_value: string;
    at: string;
  }>(
    `WITH ${CANDIDATES},
     secondary_candidates AS (
       SELECT ord, ARRAY(SELECT jsonb_array_elements_text(p)) AS path
         FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS t(p, ord)
     ),
     scoped AS (
       SELECT e.dev_eui, e.device_name, e.time, e.object
         FROM event_up e
        WHERE e.time > now() - make_interval(hours => $2::int)
          AND e.object IS NOT NULL
          ${sc.sql}
     ),
     -- The most recent uplink that carries BOTH, not the most recent uplink. A device
     -- whose latest message dropped the humidity should use the last complete pair
     -- rather than fall out of the check entirely.
     paired AS (
       SELECT s.dev_eui, s.device_name, s.time,
              (SELECT array_to_string(c.path, '.') FROM candidates c
                WHERE s.object #>> c.path IS NOT NULL AND s.object #>> c.path ${NUMERIC}
                ORDER BY c.ord LIMIT 1) AS primary_path,
              (SELECT (s.object #>> c.path)::numeric FROM candidates c
                WHERE s.object #>> c.path IS NOT NULL AND s.object #>> c.path ${NUMERIC}
                ORDER BY c.ord LIMIT 1) AS primary_value,
              (SELECT array_to_string(sc2.path, '.') FROM secondary_candidates sc2
                WHERE s.object #>> sc2.path IS NOT NULL AND s.object #>> sc2.path ${NUMERIC}
                ORDER BY sc2.ord LIMIT 1) AS secondary_path,
              (SELECT (s.object #>> sc2.path)::numeric FROM secondary_candidates sc2
                WHERE s.object #>> sc2.path IS NOT NULL AND s.object #>> sc2.path ${NUMERIC}
                ORDER BY sc2.ord LIMIT 1) AS secondary_value
         FROM scoped s
     )
     -- "primary" and "secondary" are reserved words in Postgres, so the _value
     -- suffix here is load-bearing rather than decoration. (And no backticks in this
     -- string: it is a TypeScript template literal, and one would close it.)
     SELECT DISTINCT ON (dev_eui)
            dev_eui, device_name, primary_path, secondary_path,
            primary_value, secondary_value,
            time AS at
       FROM paired
      WHERE primary_value IS NOT NULL AND secondary_value IS NOT NULL
      ORDER BY dev_eui, time DESC`,
    [pathsJson(primaryPaths), Math.round(lookbackHours), pathsJson(secondaryPaths), ...sc.values],
  );

  return rows.map((r) => ({
    devEui: r.dev_eui,
    deviceName: r.device_name,
    primaryPath: r.primary_path,
    secondaryPath: r.secondary_path,
    primary: Number(r.primary_value),
    secondary: Number(r.secondary_value),
    at: r.at,
  }));
}
