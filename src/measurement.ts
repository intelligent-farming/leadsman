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
 * `now()` minus the lookback bound at `$n`, in hours, with the fraction kept.
 *
 * The resolvers used to bind `Math.round(lookbackHours)` into
 * `make_interval(hours => $n::int)`, which silently turned a 0.25 h lookback into a
 * zero-length window that matched nothing. Seconds are a double in make_interval, so
 * binding hours as float8 and scaling keeps any lookback a rule accepts.
 */
function hoursAgo(n: number): string {
  return `now() - make_interval(secs => $${n}::float8 * 3600)`;
}

/**
 * Each device's most recent value at the highest-priority path it reports.
 *
 * Use for "what is it doing right now" checks: thresholds, geofences, alarms.
 *
 * "Most recent" means the newest uplink that carries a usable value at ANY of the
 * candidate paths — not simply the newest uplink. Multi-frame devices are common: a
 * soil node alternates measurement frames with battery-only status frames, a tracker
 * sends heartbeats between fixes. Taking the newest uplink and then looking for the
 * path in it made every such frame read as "the value is gone", and an open alert
 * resolved and re-raised (and re-notified) on the next data frame. Within that uplink
 * the candidate order still decides, so "the first path present in that device's
 * telemetry" keeps its meaning.
 *
 * Only uplinks whose `object` is a JSON object count. ChirpStack writes SQL NULL for
 * an undecoded frame, but a codec returning `null` or an array lands as a JSONB value
 * that passes `IS NOT NULL` — and `#>>` indexes into an array, so path `["0"]` would
 * read its first element.
 *
 * The per-uplink resolution is a LATERAL over a handful of candidates, and the outer
 * `DISTINCT ON (dev_eui) … ORDER BY dev_eui, time DESC` is what the
 * (dev_eui, time DESC) index serves.
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
    `WITH ${CANDIDATES}
     SELECT DISTINCT ON (dev_eui)
            dev_eui,
            device_name,
            r.matched_path,
            r.value,
            time AS at
       FROM event_up
       -- The highest-priority usable candidate in THIS uplink. An uplink carrying none
       -- produces no row, so it can never be the device's "latest reading".
       CROSS JOIN LATERAL (
         SELECT array_to_string(c.path, '.')   AS matched_path,
                (object #>> c.path)::numeric   AS value
           FROM candidates c
          WHERE object #>> c.path ${NUMERIC}
          ORDER BY c.ord
          LIMIT 1
       ) r
      WHERE time > ${hoursAgo(2)}
        AND jsonb_typeof(object) = 'object'
        ${sc.sql}
      ORDER BY dev_eui, time DESC`,
    [pathsJson(paths), lookbackHours, ...sc.values],
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
 *
 * Resolved exactly as latestReadings is: the newest uplink carrying ANY candidate
 * (a JSON `null` at the path counts as absent), then candidate order within it.
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
    `WITH ${CANDIDATES}
     SELECT DISTINCT ON (dev_eui)
            dev_eui,
            device_name,
            r.matched_path,
            r.raw,
            time AS at
       FROM event_up
       -- As latestReadings: the newest uplink that carries the flag at all. A heartbeat
       -- that omits it says nothing about the flag, so it must not read as "cleared" —
       -- a leak alert resolves only on a frame that actually reports false.
       CROSS JOIN LATERAL (
         SELECT array_to_string(c.path, '.') AS matched_path,
                object #>> c.path            AS raw
           FROM candidates c
          WHERE object #>> c.path IS NOT NULL
          ORDER BY c.ord
          LIMIT 1
       ) r
      WHERE time > ${hoursAgo(2)}
        AND jsonb_typeof(object) = 'object'
        ${sc.sql}
      ORDER BY dev_eui, time DESC`,
    [pathsJson(paths), lookbackHours, ...sc.values],
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
        WHERE e.time > ${hoursAgo(2)}
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
    [pathsJson(paths), lookbackHours, decimals, ...sc.values],
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
 * Per (device, candidate path): how often the device reported that path across the
 * window, how often in the recent part of it, and how many decodable uplinks it sent
 * recently. One row for every path a device reported at least once; a device that
 * never reported any candidate produces no rows.
 *
 * The basis of `measurement-missing`: a device that used to send `soil.moisture`
 * and no longer does has a codec or configuration problem, not a radio problem.
 *
 * Every candidate is tracked separately rather than resolved to one winner. A path
 * list on this resolver is usually a set of fields a multi-element probe is expected
 * to keep reporting together (moisture, temperature, EC, pH), and the earlier
 * one-winner-per-device resolution watched only the first of them — EC could vanish
 * while moisture kept arriving and nothing fired. Aliases for one concept (`battery`
 * vs `power.voltage` from different codecs) still work, because a device only ever
 * reports the alias its own codec emits and the others produce no row.
 *
 * Only uplinks whose `object` is a JSON object count, for sightings and for
 * `recentUplinks` alike. An undecoded frame (SQL NULL, or a codec returning JSON
 * `null`) is decode-failure's evidence, not proof the device is "still decoding".
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
    /** 1-based position of `matchedPath` in the candidate list. */
    ord: number;
    everSeen: number;
    recentSeen: number;
    /** Decodable uplinks in `recentHours`, whatever they carried. Same for every path of a device. */
    recentUplinks: number;
    lastSeenAt: string;
  }>
> {
  const sc = scopeClause(scope, 4, 'e');
  const rows = await ctx.query<{
    dev_eui: string;
    device_name: string | null;
    matched_path: string;
    ord: string;
    ever_seen: string;
    recent_seen: string;
    recent_uplinks: string;
    last_seen_at: string;
  }>(
    `WITH ${CANDIDATES},
     scoped AS (
       SELECT e.dev_eui, e.device_name, e.time, e.object
         FROM event_up e
        WHERE e.time > ${hoursAgo(2)}
          AND jsonb_typeof(e.object) = 'object'
          ${sc.sql}
     ),
     hits AS (
       SELECT s.dev_eui,
              c.ord,
              array_to_string(c.path, '.')                                AS matched_path,
              count(*)                                                    AS ever_seen,
              count(*) FILTER (WHERE s.time > ${hoursAgo(3)})             AS recent_seen,
              max(s.time)                                                 AS last_seen_at
         FROM scoped s
         CROSS JOIN candidates c
        WHERE s.object #>> c.path IS NOT NULL
        GROUP BY s.dev_eui, c.ord, c.path
     ),
     uplinks AS (
       SELECT dev_eui,
              max(device_name)                                            AS device_name,
              count(*) FILTER (WHERE time > ${hoursAgo(3)})               AS recent_uplinks
         FROM scoped
        GROUP BY dev_eui
     )
     SELECT h.dev_eui, u.device_name, h.matched_path, h.ord,
            h.ever_seen, h.recent_seen, u.recent_uplinks, h.last_seen_at
       FROM hits h
       JOIN uplinks u ON u.dev_eui = h.dev_eui
      ORDER BY h.dev_eui, h.ord`,
    [pathsJson(paths), lookbackHours, recentHours, ...sc.values],
  );

  return rows.map((r) => ({
    devEui: r.dev_eui,
    deviceName: r.device_name,
    matchedPath: r.matched_path,
    ord: Number(r.ord),
    everSeen: Number(r.ever_seen),
    recentSeen: Number(r.recent_seen),
    recentUplinks: Number(r.recent_uplinks),
    lastSeenAt: r.last_seen_at,
  }));
}

/**
 * Two-path coordinate resolution, for geofencing.
 *
 * Each device's newest uplink carrying a complete fix — a numeric latitude AND
 * longitude, each at its highest-priority candidate within that uplink — rather than
 * its newest uplink. A tracker's battery-only frame between fixes otherwise read as
 * "position unknown" and resolved an open breach alert.
 */
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
     fixes AS (
       SELECT e.dev_eui, e.device_name, e.time, lat.v AS lat, lon.v AS lon
         FROM event_up e
         CROSS JOIN LATERAL (
           SELECT (e.object #>> c.path)::numeric AS v FROM lat_candidates c
            WHERE e.object #>> c.path ${NUMERIC}
            ORDER BY c.ord LIMIT 1
         ) lat
         CROSS JOIN LATERAL (
           SELECT (e.object #>> c.path)::numeric AS v FROM lon_candidates c
            WHERE e.object #>> c.path ${NUMERIC}
            ORDER BY c.ord LIMIT 1
         ) lon
        WHERE e.time > ${hoursAgo(3)}
          AND jsonb_typeof(e.object) = 'object'
          ${scopeClause(scope, 4, 'e').sql}
     )
     SELECT DISTINCT ON (dev_eui) dev_eui, device_name, lat, lon, time AS at
       FROM fixes
      -- (0, 0) is the "no fix" sentinel many trackers emit before GNSS locks — a point
      -- in the Gulf of Guinea no farm asset is at. Treated as no fix, so it neither
      -- raises a breach thousands of km out nor hides the last real position.
      WHERE NOT (lat = 0 AND lon = 0)
      ORDER BY dev_eui, time DESC`,
    [pathsJson(latPaths), pathsJson(lonPaths), lookbackHours,
     ...scopeClause(scope, 4, 'e').values],
  );

  return rows
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
 *   total    every in-band reading's time added together. This is what an
 *            accumulation means — chill hours do not care whether the cold came in one
 *            stretch or twelve, only that the tree banked them. Reporting the longest
 *            run here would under-count a normal winter by an order of magnitude.
 *   current  the run that includes the device's LATEST reading, and zero when that
 *            reading is out of band. "Has it been like this, continuously, up to now" —
 *            the question a sustained threshold asks. The longest run anywhere in the
 *            window would let yesterday's real breach vouch for a spike this morning.
 *
 * `startedAt`/`endedAt` and the value extremes describe the longest run in `longest`
 * and `total` mode, since "when" has no meaning for a total, and the current run in
 * `current` mode (all null when the latest reading is out of band).
 *
 * A run is broken by an out-of-band reading, and also by a reporting gap longer than
 * `maxGapHours` — while a device is silent nothing is known about the canopy, and
 * bridging the gap would invent dwell out of missing data. Set it to a small multiple
 * of the fleet's uplink interval.
 *
 * How time is credited differs by mode, and so does the direction it errs in:
 *
 *   longest, current   first in-band sample to last. That understates the true run by
 *                      up to one sampling interval at each end, and a run of a single
 *                      sample is zero hours. For "did it hold long enough" (an
 *                      infection period, a sustained breach) every error is toward not
 *                      raising, which is the right way for a check that costs an LLM
 *                      invocation or a 04:00 page to be wrong.
 *   total              last observation carried forward: each in-band reading is
 *                      credited with the interval up to the NEXT reading (in band or
 *                      not), and the latest reading with the interval up to now — each
 *                      capped at `maxGapHours`, the longest a reading is trusted to
 *                      speak for. First-to-last per run would lose one interval per run,
 *                      so a fragmented winter (seven nights of six hourly readings: 35 h
 *                      against a true 42 h) would read as a chill shortfall that did not
 *                      happen. Carried forward, a total is unbiased on steady cadence;
 *                      the cap means a device that went quiet mid-band is credited at
 *                      most `maxGapHours` for the silence, which errs toward MORE dwell.
 *
 * `band.strict` makes both bounds exclusive — a reading exactly on a bound is out of
 * band. `measurement-threshold` needs that, because its breach test is strict and a
 * sustain run that counted readings resting on the bound would outlast the breach.
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

/**
 * Band bounds. A null bound is open on that side; both null matches everything.
 * Bounds are inclusive unless `strict` is set, in which case a value equal to a bound
 * is outside the band. Only the main band of `bandDwell` honours `strict`.
 */
export interface Band {
  min: number | null;
  max: number | null;
  strict?: boolean;
}

export async function bandDwell(
  ctx: SoundingContext,
  paths: string[][],
  band: Band,
  lookbackHours: number,
  maxGapHours: number,
  gate: { paths: string[][]; band: Band } | null = null,
  scope: DeviceScope = ANY_DEVICE,
  mode: 'longest' | 'total' | 'current' = 'longest',
): Promise<DwellRun[]> {
  const sc = scopeClause(scope, 10, 'e');
  // $12 is the mode and $13 the strict-band flag, bound after the scope pair — see the
  // values array below. $2 keeps its fraction — see hoursAgo.
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
        WHERE e.time > ${hoursAgo(2)}
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
              (    ($3::numeric IS NULL
                    OR r.value > $3::numeric
                    OR (NOT $13::boolean AND r.value = $3::numeric))
               AND ($4::numeric IS NULL
                    OR r.value < $4::numeric
                    OR (NOT $13::boolean AND r.value = $4::numeric))
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
              lag(f.time)    OVER w AS prev_time,
              lead(f.time)   OVER w AS next_time
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
                                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS island,
              -- Carried-forward credit for total mode: this reading speaks for the time
              -- until the next reading of any state (or until now, for the latest),
              -- but never for longer than maxGapHours. greatest() guards a device
              -- clock that stamped a reading in the future.
              greatest(0, least(
                EXTRACT(EPOCH FROM (COALESCE(m.next_time, now()) - m.time)) / 3600.0,
                $9::numeric)) AS credit
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
              round((EXTRACT(EPOCH FROM (max(time) - min(time))) / 3600.0)::numeric, 4) AS hours,
              sum(credit)                                        AS credited
         FROM islanded
        GROUP BY dev_eui, island
     ),
     longest AS (
       SELECT DISTINCT ON (dev_eui) *
         FROM runs ORDER BY dev_eui, hours DESC, ended_at DESC
     ),
     -- The most recent run. Only the CURRENT run if it ends at the device's latest
     -- reading, which is checked against totals below.
     latest_run AS (
       SELECT DISTINCT ON (dev_eui) *
         FROM runs ORDER BY dev_eui, ended_at DESC
     ),
     -- Every in-band reading's carried-forward credit added together, for the
     -- accumulation question. Joined back to the longest run so the timestamps and
     -- extremes still describe a real stretch rather than a span stitched out of
     -- unrelated ones.
     summed AS (
       SELECT dev_eui,
              round(sum(credited)::numeric, 4) AS total_hours,
              sum(samples)                     AS total_samples
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
     ),
     -- The run the timestamps and extremes describe: the current one in current mode
     -- (absent when the latest reading is out of band), the longest otherwise.
     chosen AS (
       SELECT l.* FROM longest l WHERE $12::text <> 'current'
       UNION ALL
       SELECT lr.* FROM latest_run lr
         JOIN totals t ON t.dev_eui = lr.dev_eui AND lr.ended_at = t.last_sample_at
        WHERE $12::text = 'current'
     )
     SELECT t.dev_eui,
            t.device_name,
            t.matched_path,
            CASE WHEN $12::text = 'total' THEN sm.total_hours   ELSE l.hours   END AS hours,
            CASE WHEN $12::text = 'total' THEN sm.total_samples ELSE l.samples END AS samples,
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
       LEFT JOIN chosen  l ON l.dev_eui = t.dev_eui
       LEFT JOIN summed  sm ON sm.dev_eui = t.dev_eui`,
    [
      pathsJson(paths),
      lookbackHours,
      band.min,
      band.max,
      pathsJson(gate ? gate.paths : []),
      gate ? gate.band.min : null,
      gate ? gate.band.max : null,
      gate !== null,
      maxGapHours,
      ...sc.values,
      mode,
      band.strict === true,
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
              EXTRACT(EPOCH FROM (e.time - (${hoursAgo(2)})))
                / 3600.0 AS h
         FROM event_up e
         CROSS JOIN candidates c
        WHERE e.time > ${hoursAgo(2)}
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
    [pathsJson(paths), lookbackHours, ...sc.values],
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
 *
 * Every reading owns the interval up to the next one, and the latest reading owns the
 * interval up to now, held at its value — the trailing edge is treated exactly like an
 * interval between two readings, so it counts when it is no longer than `maxGapHours`
 * and is a gap when it is. Dropping it made every total short by one reporting
 * interval whatever the device was doing. The leading edge (window open to the first
 * reading) is not attributed, since the value before it is not in the window.
 *
 * `coveredHours` is computed the same way for both methods, so a caller can scale an
 * observed total up to the whole window (`total / (coveredHours / lookbackHours)`) and
 * refuse to judge below a coverage fraction, for a sum as well as an integral. For a
 * sum the basis is approximate — each reading's quantity belongs to the interval
 * BEFORE it — but the one interval that shifts at each edge cancels on a steady
 * cadence.
 */
export interface Accumulation {
  devEui: string;
  deviceName: string | null;
  matchedPath: string;
  /** Integral in unit·hours, or the plain sum, depending on the method. */
  total: number;
  /** Readings that contributed. */
  samples: number;
  /**
   * Hours actually covered: every interval (reading to next reading, and latest
   * reading to now) no longer than maxGapHours. Same basis for both methods.
   */
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
        WHERE e.time > ${hoursAgo(2)}
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
              lead(r.value) OVER w AS next_value,
              lead(r.time)  OVER w AS next_time
         FROM resolved r
       WINDOW w AS (PARTITION BY r.dev_eui ORDER BY r.time)
     ),
     -- One slice per reading: the interval to the next reading as a trapezoid, or for
     -- the latest reading the interval up to now, held at its value. A slice longer
     -- than maxGapHours is a gap wherever it falls. greatest() guards a reading a
     -- device clock stamped in the future.
     slices AS (
       SELECT s.dev_eui,
              greatest(0, EXTRACT(EPOCH FROM (COALESCE(s.next_time, now()) - s.time))
                          / 3600.0)::numeric AS dt,
              s.value,
              COALESCE(s.next_value, s.value) AS next_value
         FROM stepped s
     )
     SELECT r.dev_eui,
            max(r.device_name)  AS device_name,
            max(r.matched_path) AS matched_path,
            CASE WHEN $3::text = 'sum'
                 THEN round(sum(r.value), 6)
                 ELSE (SELECT round(COALESCE(sum((sl.value + sl.next_value) / 2 * sl.dt), 0), 6)
                         FROM slices sl
                        WHERE sl.dev_eui = r.dev_eui
                          AND sl.dt <= $5::numeric)
            END AS total,
            count(*) AS samples,
            (SELECT round(COALESCE(sum(sl.dt), 0), 4) FROM slices sl
              WHERE sl.dev_eui = r.dev_eui AND sl.dt <= $5::numeric)
              AS covered_hours,
            (SELECT round(COALESCE(sum(sl.dt), 0), 4) FROM slices sl
              WHERE sl.dev_eui = r.dev_eui AND sl.dt > $5::numeric)
              AS gap_hours,
            min(r.raw)   AS vmin,
            max(r.raw)   AS vmax,
            min(r.time)  AS first_at,
            max(r.time)  AS last_at
       FROM resolved r
      GROUP BY r.dev_eui`,
    [
      pathsJson(paths),
      lookbackHours,
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
 *
 * `minSamples` decides membership BEFORE the median and MAD are computed. A device
 * with one reading in the window is not a peer — its "mean" is one sample — and
 * letting it into the statistics while excluding it from the comparison let three
 * sparse devices drag the median far enough to hide a real outlier among eight good
 * ones. Devices below it are absent from the result altogether, so `groupSize` is the
 * number of devices actually compared.
 */
export interface GroupDeviation {
  devEui: string;
  deviceName: string | null;
  matchedPath: string;
  /** This device's mean over the window. */
  value: number;
  samples: number;
  /** Median across every compared device in the group. */
  groupMedian: number;
  /** Median absolute deviation, rescaled to sigma-equivalent units. */
  groupSpread: number;
  /** Devices compared — those with at least minSamples readings — including this one. */
  groupSize: number;
  /** Signed deviation in sigma-equivalents. Null when the group has no spread at all. */
  deviations: number | null;
}

export async function groupDeviation(
  ctx: SoundingContext,
  paths: string[][],
  lookbackHours: number,
  scope: DeviceScope = ANY_DEVICE,
  minSamples = 1,
): Promise<GroupDeviation[]> {
  // $1 paths, $2 lookbackHours, scope at $3/$4, $5 minSamples.
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
        WHERE e.time > ${hoursAgo(2)}
          AND e.object IS NOT NULL
          AND e.object #>> c.path IS NOT NULL
          AND e.object #>> c.path ${NUMERIC}
          ${sc.sql}
     ),
     winner AS (
       SELECT DISTINCT ON (dev_eui) dev_eui, ord FROM window_rows ORDER BY dev_eui, ord
     ),
     -- One number per device first: comparing raw readings across devices would
     -- compare whoever happened to report most recently. The HAVING is membership:
     -- a device too sparse to compare must not shape the median it is compared to.
     per_device AS (
       SELECT w.dev_eui,
              max(w.device_name)  AS device_name,
              max(w.matched_path) AS matched_path,
              avg(w.value)        AS value,
              count(*)            AS samples
         FROM window_rows w
         JOIN winner ON winner.dev_eui = w.dev_eui AND winner.ord = w.ord
        GROUP BY w.dev_eui
       HAVING count(*) >= $5::int
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
    [pathsJson(paths), lookbackHours, ...sc.values, Math.max(1, Math.floor(minSamples))],
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
 * The mechanism is a LAGGED correlation between a trigger path and a response path.
 * `mold-risk` correlates two measurements within a single uplink; this correlates a
 * trigger with a response separated by however long the physics takes.
 *
 *   trigger   a numeric path that INCREASED by at least `triggerDelta`. A monotonic
 *             counter advancing (litres delivered, pump runtime) is the natural case,
 *             and a 0/1 flag going up works identically with a delta of 1.
 *   response  a path expected to move by at least `minChange` in `direction` within
 *             `responseWindowHours` of the trigger.
 *
 * By default both halves are read from the SAME device. Real irrigation rarely looks
 * like that — the meter is on the header and the probe is in the block, and no
 * vocabulary category emits both a water total and a soil moisture — so
 * `responseDevices` maps a trigger DevEUI to the DevEUIs whose response it should be
 * judged on. A mapped trigger is judged ONLY on its mapped devices, each with its own
 * baseline (its last reading at or before the trigger); an unmapped trigger keeps the
 * same-device pairing. Mapped response devices are read whatever the scope says: the
 * scope selects triggers, and a mapping is an explicit statement about where the
 * response lives. Keys and values are lowercase hex, compared case-insensitively.
 *
 * Only triggers old enough for the response window to have fully elapsed are
 * considered. Without that the check reports every irrigation the moment it starts,
 * before the water could possibly have reached the probe, and the alert is guaranteed
 * to be wrong rather than merely likely to be.
 *
 * The baseline is the last response reading at or before the trigger, so a response
 * that was already high does not excuse one that never moved.
 *
 * One row per trigger device. `responses` lists every response device that could be
 * judged (had a baseline and at least one reading inside the window); the top-level
 * response fields describe the one that moved furthest in the expected direction,
 * which is the one that decides "did anything respond". A trigger none of whose
 * response devices can be judged is absent — "the probe was offline" is not "the
 * valve failed".
 */
export interface ResponseObservation {
  devEui: string;
  deviceName: string | null;
  responsePath: string;
  /** Response value immediately before the trigger, on this device. */
  baseline: number;
  /** The furthest the response got, in the expected direction, inside the window. */
  extreme: number;
  /** Signed movement from baseline to extreme. */
  change: number;
  /** Response readings inside the window. */
  responseSamples: number;
}

export interface TriggerResponse {
  devEui: string;
  deviceName: string | null;
  triggerPath: string;
  /** When the trigger fired. */
  triggeredAt: string;
  /** How far the trigger path advanced. */
  triggerDelta: number;
  /** True when the response was judged on mapped devices rather than the trigger's own. */
  paired: boolean;
  /** The response device that moved furthest in the expected direction. */
  responseDevEui: string;
  responseDeviceName: string | null;
  responsePath: string;
  baseline: number;
  extreme: number;
  change: number;
  responseSamples: number;
  /** Every judgeable response device, best first. */
  responses: ResponseObservation[];
}

/** Trigger DevEUI → response DevEUIs, both lowercase hex. */
export type ResponseDeviceMap = Record<string, string[]>;

export async function triggerResponse(
  ctx: SoundingContext,
  triggerPaths: string[][],
  responsePaths: string[][],
  lookbackHours: number,
  triggerDelta: number,
  responseWindowHours: number,
  direction: 'rising' | 'falling',
  scope: DeviceScope = ANY_DEVICE,
  responseDevices: ResponseDeviceMap = {},
): Promise<TriggerResponse[]> {
  // $1 trigger paths, $2 lookbackHours, $3 triggerDelta, $4 response paths,
  // $5 responseWindowHours, $6 direction, scope at $7/$8, $9 the device map.
  const sc = scopeClause(scope, 7, 'e');
  const map: ResponseDeviceMap = {};
  for (const [k, v] of Object.entries(responseDevices)) {
    map[k.toLowerCase()] = v.map((x) => x.toLowerCase());
  }
  const rows = await ctx.query<{
    dev_eui: string;
    device_name: string | null;
    trigger_path: string;
    triggered_at: string;
    trigger_delta: string;
    paired: boolean;
    resp_eui: string;
    resp_device_name: string | null;
    response_path: string | null;
    baseline: string | null;
    extreme: string | null;
    response_samples: string;
  }>(
    `WITH ${CANDIDATES},
     response_candidates AS (
       SELECT ord, ARRAY(SELECT jsonb_array_elements_text(p)) AS path
         FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY AS t(p, ord)
     ),
     pairing AS (
       SELECT lower(m.k) AS trig_eui, lower(v.eui) AS resp_eui
         FROM jsonb_each($9::jsonb) AS m(k, arr)
         CROSS JOIN LATERAL jsonb_array_elements_text(m.arr) AS v(eui)
     ),
     scoped AS (
       SELECT e.dev_eui, e.device_name, e.time, e.object
         FROM event_up e
        WHERE e.time > ${hoursAgo(2)}
          AND e.object IS NOT NULL
          ${sc.sql}
     ),
     -- Response readings come from the scope OR from a device a mapping names: the
     -- scope selects triggers, and a mapping says outright where the response lives.
     resp_scoped AS (
       SELECT lower(e.dev_eui) AS dev_eui, e.device_name, e.time, e.object
         FROM event_up e
        WHERE e.time > ${hoursAgo(2)}
          AND e.object IS NOT NULL
          AND ((TRUE ${sc.sql})
               OR lower(e.dev_eui) IN (SELECT resp_eui FROM pairing))
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
       SELECT s.dev_eui, s.device_name, s.time, rc.ord,
              array_to_string(rc.path, '.') AS matched_path,
              (s.object #>> rc.path)::numeric AS value
         FROM resp_scoped s CROSS JOIN response_candidates rc
        WHERE s.object #>> rc.path IS NOT NULL AND s.object #>> rc.path ${NUMERIC}
     ),
     resp_winner AS (
       SELECT DISTINCT ON (dev_eui) dev_eui, ord FROM resp_rows ORDER BY dev_eui, ord
     ),
     resp AS (
       SELECT r.* FROM resp_rows r JOIN resp_winner rw
         ON rw.dev_eui = r.dev_eui AND rw.ord = r.ord
     ),
     -- Which devices each trigger is judged on: its mapped devices if it has any,
     -- otherwise itself. Never both — a mapped meter carries no response of its own.
     targets AS (
       SELECT f.*, TRUE AS paired, p.resp_eui
         FROM fired f JOIN pairing p ON p.trig_eui = lower(f.dev_eui)
       UNION ALL
       SELECT f.*, FALSE AS paired, lower(f.dev_eui) AS resp_eui
         FROM fired f
        WHERE NOT EXISTS (SELECT 1 FROM pairing p WHERE p.trig_eui = lower(f.dev_eui))
     )
     SELECT t.dev_eui,
            t.device_name,
            t.trigger_path,
            t.triggered_at,
            t.trigger_delta,
            t.paired,
            t.resp_eui,
            (SELECT max(device_name) FROM resp WHERE dev_eui = t.resp_eui) AS resp_device_name,
            (SELECT max(matched_path) FROM resp WHERE dev_eui = t.resp_eui) AS response_path,
            -- Baseline: this device's last response reading at or before the trigger.
            (SELECT r.value FROM resp r
              WHERE r.dev_eui = t.resp_eui AND r.time <= t.triggered_at
              ORDER BY r.time DESC LIMIT 1) AS baseline,
            -- How far it got in the expected direction inside the window.
            (SELECT CASE WHEN $6::text = 'rising' THEN max(r.value) ELSE min(r.value) END
               FROM resp r
              WHERE r.dev_eui = t.resp_eui
                AND r.time > t.triggered_at
                AND r.time <= t.triggered_at + make_interval(secs => ($5::numeric * 3600)::int)
            ) AS extreme,
            (SELECT count(*) FROM resp r
              WHERE r.dev_eui = t.resp_eui
                AND r.time > t.triggered_at
                AND r.time <= t.triggered_at + make_interval(secs => ($5::numeric * 3600)::int)
            ) AS response_samples
       FROM targets t`,
    [
      pathsJson(triggerPaths),
      lookbackHours,
      triggerDelta,
      pathsJson(responsePaths),
      responseWindowHours,
      direction,
      ...sc.values,
      JSON.stringify(map),
    ],
  );

  // Signed movement in the expected direction, for ranking response devices.
  const moved = (change: number) => (direction === 'rising' ? change : -change);

  const byTrigger = new Map<string, { head: (typeof rows)[number]; obs: ResponseObservation[] }>();
  for (const r of rows) {
    const entry = byTrigger.get(r.dev_eui) ?? { head: r, obs: [] };
    byTrigger.set(r.dev_eui, entry);
    // No baseline or no reading afterwards means there is nothing to judge on this
    // device, not a failure. Reporting it would turn "the probe was offline" into
    // "the valve failed".
    if (r.baseline === null || r.extreme === null || Number(r.response_samples) === 0) continue;
    const baseline = Number(r.baseline);
    const extreme = Number(r.extreme);
    entry.obs.push({
      devEui: r.resp_eui,
      deviceName: r.resp_device_name,
      responsePath: r.response_path ?? '',
      baseline,
      extreme,
      change: extreme - baseline,
      responseSamples: Number(r.response_samples),
    });
  }

  const out: TriggerResponse[] = [];
  for (const { head, obs } of byTrigger.values()) {
    if (obs.length === 0) continue;
    obs.sort((a, b) => moved(b.change) - moved(a.change));
    const best = obs[0];
    out.push({
      devEui: head.dev_eui,
      deviceName: head.device_name,
      triggerPath: head.trigger_path,
      triggeredAt: head.triggered_at,
      triggerDelta: Number(head.trigger_delta),
      paired: head.paired,
      responseDevEui: best.devEui,
      responseDeviceName: best.deviceName,
      responsePath: best.responsePath,
      baseline: best.baseline,
      extreme: best.extreme,
      change: best.change,
      responseSamples: best.responseSamples,
      responses: obs,
    });
  }
  return out;
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
        WHERE e.time > now() - make_interval(secs => $2::float8 * 3600)
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
      lookbackHours,
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
        WHERE e.time > now() - make_interval(secs => $2::float8 * 3600)
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
    [pathsJson(primaryPaths), lookbackHours, pathsJson(secondaryPaths), ...sc.values],
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

/**
 * How a device's time in the window divided between below a band, inside it, and
 * above it.
 *
 * `bandDwell` answers "how long inside", and for an infection period that is the
 * whole question. A managed deficit is different: the target is a band the block is
 * supposed to *live in*, and both ways out of it are faults with opposite remedies.
 * What matters is not that a reading crossed a line but how the window divided —
 *
 *   - 62 % of three days below the floor is a block that is being under-watered, and
 *     the correction is more water.
 *   - 30 % below and 30 % above is a block being pulsed too hard, and the correction
 *     is smaller, more frequent sets — more water would make it worse.
 *   - one reading below the floor at 04:00 and back by 06:00 is nothing at all.
 *
 * A single threshold cannot tell those apart, because all three break the same bound.
 *
 * Time is attributed by last observation carried forward: the interval after each
 * reading belongs to that reading's state. An interval longer than `maxGapHours` is
 * attributed to nothing and counted as a gap — a device that went quiet at 30 % and
 * came back at 12 % was not observed at either value in between, and spreading the
 * gap across a state would invent evidence for whichever side happened to bound it.
 *
 * The final reading's interval is unattributed, since how long the current state will
 * hold is not yet known, and so is the stretch between the window opening and the
 * first reading inside it, since the state before that reading is not in the window.
 * `coveredHours` is therefore always short of the window by up to TWO reporting
 * intervals, one at each edge, which is why the caller compares fractions of covered
 * time rather than of wall-clock time — and why coveredHours can be zero for a device
 * with a single reading, which the caller must not divide by.
 */
export interface BandResidency {
  devEui: string;
  deviceName: string | null;
  matchedPath: string;
  /** Hours attributed to each state. These sum to `coveredHours`. */
  hoursBelow: number;
  hoursInBand: number;
  hoursAbove: number;
  /** Hours actually accounted for — the window minus gaps and the trailing interval. */
  coveredHours: number;
  /** Hours discarded because the reporting gap was longer than maxGapHours. */
  gapHours: number;
  min: number;
  max: number;
  avg: number;
  /** The most recent reading, and which side of the band it is on. */
  lastValue: number;
  lastState: 'below' | 'in' | 'above';
  lastAt: string;
  samples: number;
}

export async function bandResidency(
  ctx: SoundingContext,
  paths: string[][],
  floor: number,
  ceiling: number,
  lookbackHours: number,
  maxGapHours: number,
  scope: DeviceScope = ANY_DEVICE,
): Promise<BandResidency[]> {
  // $1 paths, $2 lookbackHours, $3 floor, $4 ceiling, $5 maxGapHours — scope at $6/$7.
  const since = hoursAgo(2);
  const sc = scopeClause(scope, 6, 'e');
  const rows = await ctx.query<{
    dev_eui: string;
    device_name: string | null;
    matched_path: string;
    hours_below: string;
    hours_in: string;
    hours_above: string;
    gap_hours: string;
    vmin: string;
    vmax: string;
    vavg: string;
    last_value: string;
    last_state: 'below' | 'in' | 'above';
    last_at: string;
    samples: string;
  }>(
    `WITH ${CANDIDATES},
     scoped AS (
       SELECT e.dev_eui, e.device_name, e.time, e.object
         FROM event_up e
        WHERE e.time > ${since}
          AND e.object IS NOT NULL
          ${sc.sql}
     ),
     rows_at_paths AS (
       SELECT s.dev_eui, s.device_name, s.time, c.ord,
              array_to_string(c.path, '.') AS matched_path,
              (s.object #>> c.path)::numeric AS value
         FROM scoped s CROSS JOIN candidates c
        WHERE s.object #>> c.path IS NOT NULL
          AND s.object #>> c.path ${NUMERIC}
     ),
     winner AS (
       SELECT DISTINCT ON (dev_eui) dev_eui, ord FROM rows_at_paths ORDER BY dev_eui, ord
     ),
     resolved AS (
       SELECT r.* FROM rows_at_paths r
         JOIN winner w ON w.dev_eui = r.dev_eui AND w.ord = r.ord
     ),
     classified AS (
       SELECT r.*,
              CASE WHEN r.value < $3::numeric THEN 'below'
                   WHEN r.value > $4::numeric THEN 'above'
                   ELSE 'in' END AS state,
              -- Last observation carried forward: the interval AFTER a reading
              -- belongs to the state that reading reported.
              lead(r.time) OVER (PARTITION BY r.dev_eui ORDER BY r.time) AS next_time
         FROM resolved r
     ),
     slices AS (
       SELECT dev_eui, state,
              CASE WHEN next_time IS NULL THEN NULL
                   ELSE EXTRACT(EPOCH FROM (next_time - time)) / 3600.0
              END AS dt
         FROM classified
     ),
     residency AS (
       SELECT dev_eui,
              round(COALESCE(sum(dt) FILTER (
                WHERE state = 'below' AND dt <= $5::numeric), 0)::numeric, 4) AS hours_below,
              round(COALESCE(sum(dt) FILTER (
                WHERE state = 'in'    AND dt <= $5::numeric), 0)::numeric, 4) AS hours_in,
              round(COALESCE(sum(dt) FILTER (
                WHERE state = 'above' AND dt <= $5::numeric), 0)::numeric, 4) AS hours_above,
              round(COALESCE(sum(dt) FILTER (
                WHERE dt > $5::numeric), 0)::numeric, 4)                      AS gap_hours
         FROM slices
        GROUP BY dev_eui
     ),
     summary AS (
       SELECT dev_eui,
              max(device_name)                             AS device_name,
              max(matched_path)                            AS matched_path,
              min(value)                                   AS vmin,
              max(value)                                   AS vmax,
              round(avg(value), 4)                         AS vavg,
              count(*)                                     AS samples,
              (array_agg(value ORDER BY time DESC))[1]     AS last_value,
              (array_agg(state ORDER BY time DESC))[1]     AS last_state,
              max(time)                                    AS last_at
         FROM classified
        GROUP BY dev_eui
     )
     SELECT s.dev_eui, s.device_name, s.matched_path,
            r.hours_below, r.hours_in, r.hours_above, r.gap_hours,
            s.vmin, s.vmax, s.vavg, s.last_value, s.last_state, s.last_at, s.samples
       FROM summary s
       JOIN residency r ON r.dev_eui = s.dev_eui`,
    [
      pathsJson(paths),
      lookbackHours,
      floor,
      ceiling,
      maxGapHours,
      ...sc.values,
    ],
  );

  return rows.map((r) => {
    const hoursBelow = Number(r.hours_below);
    const hoursInBand = Number(r.hours_in);
    const hoursAbove = Number(r.hours_above);
    return {
      devEui: r.dev_eui,
      deviceName: r.device_name,
      matchedPath: r.matched_path,
      hoursBelow,
      hoursInBand,
      hoursAbove,
      coveredHours: hoursBelow + hoursInBand + hoursAbove,
      gapHours: Number(r.gap_hours),
      min: Number(r.vmin),
      max: Number(r.vmax),
      avg: Number(r.vavg),
      lastValue: Number(r.last_value),
      lastState: r.last_state,
      lastAt: r.last_at,
      samples: Number(r.samples),
    };
  });
}
