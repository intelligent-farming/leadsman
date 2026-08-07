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
import { type DeviceScope } from './scope';
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
export declare function resolvePaths(params: Record<string, unknown>, key?: string): string[][];
export declare function pathsLabel(paths: string[][]): string;
/**
 * Each device's most recent value at the highest-priority path it reports.
 *
 * Use for "what is it doing right now" checks: thresholds, geofences, alarms.
 */
export declare function latestReadings(ctx: SoundingContext, paths: string[][], lookbackHours: number, scope?: DeviceScope): Promise<Reading[]>;
/**
 * Each device's most recent *boolean* value at its highest-priority path.
 *
 * Separate from the numeric path because JSONB booleans do not survive the numeric
 * guard, and because codecs express flags inconsistently — `true`, `"true"`, `1`,
 * and `"open"` all appear in the wild.
 */
export declare function latestBooleans(ctx: SoundingContext, paths: string[][], lookbackHours: number, trueValues: string[], scope?: DeviceScope): Promise<Array<Omit<Reading, 'value'> & {
    value: boolean;
    raw: string;
}>>;
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
export declare function windowStats(ctx: SoundingContext, paths: string[][], lookbackHours: number, decimals?: number | null, scope?: DeviceScope): Promise<WindowStat[]>;
/**
 * Devices that report *any* of `expectPaths` at some point in the window, split
 * into those currently reporting it and those that have stopped.
 *
 * The basis of `measurement-missing`: a device that used to send `soil.moisture`
 * and no longer does has a codec or configuration problem, not a radio problem.
 */
export declare function pathPresence(ctx: SoundingContext, paths: string[][], lookbackHours: number, recentHours: number, scope?: DeviceScope): Promise<Array<{
    devEui: string;
    deviceName: string | null;
    matchedPath: string;
    everSeen: number;
    recentSeen: number;
    recentUplinks: number;
    lastSeenAt: string;
}>>;
/** Two-path coordinate resolution, for geofencing. */
export declare function latestCoordinates(ctx: SoundingContext, latPaths: string[][], lonPaths: string[][], lookbackHours: number, scope?: DeviceScope): Promise<Array<{
    devEui: string;
    deviceName: string | null;
    lat: number;
    lon: number;
    at: string;
}>>;
//# sourceMappingURL=measurement.d.ts.map