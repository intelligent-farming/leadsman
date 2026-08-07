"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCOPE_PARAMS = exports.ANY_DEVICE = void 0;
exports.resolveScope = resolveScope;
exports.scopeClause = scopeClause;
exports.scopeLabel = scopeLabel;
exports.scopeFrom = scopeFrom;
exports.ANY_DEVICE = { profiles: [], namePattern: null };
/** Parameters every check exposes so scoping is configured identically everywhere. */
exports.SCOPE_PARAMS = {
    /**
     * Restrict to these ChirpStack device profiles (exact names). Empty or null means
     * every profile. Use this to give a hardware family its own thresholds.
     */
    deviceProfiles: [],
    /**
     * Restrict to device names matching this SQL LIKE pattern, e.g. "%pump%".
     * null means every device.
     */
    deviceNamePattern: null,
};
function resolveScope(params) {
    const rawProfiles = params.deviceProfiles;
    let profiles = [];
    if (Array.isArray(rawProfiles)) {
        profiles = rawProfiles.map((p, i) => {
            if (typeof p !== 'string' || p.length === 0) {
                throw new Error(`deviceProfiles[${i}] must be a non-empty string`);
            }
            return p;
        });
    }
    else if (typeof rawProfiles === 'string' && rawProfiles.length > 0) {
        profiles = [rawProfiles];
    }
    else if (rawProfiles !== null && rawProfiles !== undefined) {
        throw new Error('deviceProfiles must be an array of strings, a string, or null');
    }
    const rawPattern = params.deviceNamePattern;
    let namePattern = null;
    if (typeof rawPattern === 'string' && rawPattern.length > 0) {
        namePattern = rawPattern;
    }
    else if (rawPattern !== null && rawPattern !== undefined) {
        throw new Error('deviceNamePattern must be a string or null');
    }
    return { profiles, namePattern };
}
/**
 * SQL predicate for a scope, plus the values to bind.
 *
 * `startIndex` is the next free positional parameter. The predicate always references
 * both parameters so the SQL text is identical whether or not a scope is set — which
 * keeps Postgres' plan cache warm across soundings. An empty profile list and a null
 * pattern make both conditions trivially true.
 */
function scopeClause(scope, startIndex, alias = '') {
    const p = alias ? `${alias}.` : '';
    const i = startIndex;
    return {
        sql: `AND (cardinality($${i}::text[]) = 0 OR ${p}device_profile_name = ANY($${i}::text[])) ` +
            `AND ($${i + 1}::text IS NULL OR ${p}device_name LIKE $${i + 1}::text)`,
        values: [scope.profiles, scope.namePattern],
    };
}
/** Human-readable scope, for alert detail and log lines. */
function scopeLabel(scope) {
    const parts = [];
    if (scope.profiles.length > 0)
        parts.push(`profiles: ${scope.profiles.join(', ')}`);
    if (scope.namePattern)
        parts.push(`name like ${scope.namePattern}`);
    return parts.length > 0 ? parts.join('; ') : null;
}
/** Convenience for checks that resolve scope straight from their context. */
function scopeFrom(ctx) {
    return resolveScope(ctx.params);
}
//# sourceMappingURL=scope.js.map