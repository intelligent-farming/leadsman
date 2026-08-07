/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Optional device scoping for checks.
 *
 * For most checks the candidate path list *is* the scope: a `pressure.gauge` threshold
 * only ever matches a pressure sensor, because nothing else emits that path. That is
 * the cleanest form of targeting and needs no configuration.
 *
 * It breaks down for the fields that every device reports. `battery` is the important
 * one — nearly every category in the vocabulary provides it, but the sensible
 * threshold is per hardware family. A Makerfabs AgroSense light sensor running on a
 * coin cell and a mains-adjacent pipe-pressure node do not share a low-battery
 * voltage, so a single fleet-wide threshold either cries wolf on one or stays silent
 * on the other.
 *
 * `deviceProfiles` and `deviceNamePattern` narrow a check to part of the fleet.
 * Profile matching is exact (against ChirpStack's `device_profile_name`); the name
 * pattern is a SQL `LIKE`, so `%pump%` works. Both are optional and default to
 * matching everything, which keeps existing configs behaving identically.
 */
import type { SoundingContext } from './types';
export interface DeviceScope {
    /** Exact `device_profile_name` values. Empty means every profile. */
    profiles: string[];
    /** SQL LIKE pattern against `device_name`. null means every device. */
    namePattern: string | null;
}
export declare const ANY_DEVICE: DeviceScope;
/** Parameters every check exposes so scoping is configured identically everywhere. */
export declare const SCOPE_PARAMS: {
    /**
     * Restrict to these ChirpStack device profiles (exact names). Empty or null means
     * every profile. Use this to give a hardware family its own thresholds.
     */
    deviceProfiles: string[];
    /**
     * Restrict to device names matching this SQL LIKE pattern, e.g. "%pump%".
     * null means every device.
     */
    deviceNamePattern: string | null;
};
export declare function resolveScope(params: Record<string, unknown>): DeviceScope;
/**
 * SQL predicate for a scope, plus the values to bind.
 *
 * `startIndex` is the next free positional parameter. The predicate always references
 * both parameters so the SQL text is identical whether or not a scope is set — which
 * keeps Postgres' plan cache warm across soundings. An empty profile list and a null
 * pattern make both conditions trivially true.
 */
export declare function scopeClause(scope: DeviceScope, startIndex: number, alias?: string): {
    sql: string;
    values: unknown[];
};
/** Human-readable scope, for alert detail and log lines. */
export declare function scopeLabel(scope: DeviceScope): string | null;
/** Convenience for checks that resolve scope straight from their context. */
export declare function scopeFrom(ctx: SoundingContext): DeviceScope;
//# sourceMappingURL=scope.d.ts.map