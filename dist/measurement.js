"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolvePaths = resolvePaths;
exports.pathsLabel = pathsLabel;
exports.latestReadings = latestReadings;
exports.latestBooleans = latestBooleans;
exports.windowStats = windowStats;
exports.pathPresence = pathPresence;
exports.latestCoordinates = latestCoordinates;
const params_1 = require("./params");
const scope_1 = require("./scope");
/**
 * Normalize a `paths` parameter to the JSON form the SQL expects.
 *
 * Accepts a single dotted string, an array of dotted strings, or an array of
 * segment arrays — so config can say `"wind.speed"`, `["wind.speed", "air.speed"]`,
 * or `[["wind","speed"]]`. Order is significant: it is the resolution priority.
 */
function resolvePaths(params, key = 'paths') {
    const raw = params[key];
    const one = (v, at) => {
        if (typeof v === 'string') {
            const parts = v.split('.').filter((s) => s.length > 0);
            if (parts.length === 0)
                throw new params_1.ParamError(`${at} is not a usable path`);
            return parts;
        }
        if (Array.isArray(v)) {
            if (v.length === 0)
                throw new params_1.ParamError(`${at} must not be an empty path`);
            return v.map((seg, i) => {
                if (typeof seg !== 'string' || seg.length === 0) {
                    throw new params_1.ParamError(`${at}[${i}] must be a non-empty string`);
                }
                return seg;
            });
        }
        throw new params_1.ParamError(`${at} must be a dotted string or array of strings`);
    };
    if (typeof raw === 'string')
        return [one(raw, `param "${key}"`)];
    if (Array.isArray(raw)) {
        if (raw.length === 0) {
            throw new params_1.ParamError(`param "${key}" must list at least one candidate path`);
        }
        return raw.map((entry, i) => one(entry, `param "${key}"[${i}]`));
    }
    throw new params_1.ParamError(`param "${key}" must be a path or an array of paths (got ${JSON.stringify(raw)})`);
}
/** Serialize resolved paths for the SQL parameter. */
function pathsJson(paths) {
    return JSON.stringify(paths);
}
function pathsLabel(paths) {
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
async function latestReadings(ctx, paths, lookbackHours, scope = scope_1.ANY_DEVICE) {
    const sc = (0, scope_1.scopeClause)(scope, 3);
    const rows = await ctx.query(`WITH ${CANDIDATES},
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
      ORDER BY l.dev_eui, c.ord`, [pathsJson(paths), Math.round(lookbackHours), ...sc.values]);
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
async function latestBooleans(ctx, paths, lookbackHours, trueValues, scope = scope_1.ANY_DEVICE) {
    const sc = (0, scope_1.scopeClause)(scope, 3);
    const rows = await ctx.query(`WITH ${CANDIDATES},
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
      ORDER BY l.dev_eui, c.ord`, [pathsJson(paths), Math.round(lookbackHours), ...sc.values]);
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
async function windowStats(ctx, paths, lookbackHours, decimals = null, scope = scope_1.ANY_DEVICE) {
    const sc = (0, scope_1.scopeClause)(scope, 4, 'e');
    const rows = await ctx.query(`WITH ${CANDIDATES},
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
      GROUP BY w.dev_eui`, [pathsJson(paths), Math.round(lookbackHours), decimals, ...sc.values]);
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
async function pathPresence(ctx, paths, lookbackHours, recentHours, scope = scope_1.ANY_DEVICE) {
    const rows = await ctx.query(`WITH ${CANDIDATES},
     scoped AS (
       SELECT e.dev_eui, e.device_name, e.time, e.object
         FROM event_up e
        WHERE e.time > now() - make_interval(hours => $2::int)
          ${(0, scope_1.scopeClause)(scope, 4, 'e').sql}
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
      GROUP BY w.dev_eui, w.matched_path`, [pathsJson(paths), Math.round(lookbackHours), Math.round(recentHours),
        ...(0, scope_1.scopeClause)(scope, 4, 'e').values]);
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
async function latestCoordinates(ctx, latPaths, lonPaths, lookbackHours, scope = scope_1.ANY_DEVICE) {
    const rows = await ctx.query(`WITH lat_candidates AS (
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
          ${(0, scope_1.scopeClause)(scope, 4).sql}
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
       FROM latest l`, [pathsJson(latPaths), pathsJson(lonPaths), Math.round(lookbackHours),
        ...(0, scope_1.scopeClause)(scope, 4).values]);
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
//# sourceMappingURL=measurement.js.map