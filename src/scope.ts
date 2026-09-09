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

export const ANY_DEVICE: DeviceScope = { profiles: [], namePattern: null };

/** Parameters every check exposes so scoping is configured identically everywhere. */
export const SCOPE_PARAMS = {
  /**
   * Restrict to these ChirpStack device profiles (exact names). Empty or null means
   * every profile. Use this to give a hardware family its own thresholds.
   */
  deviceProfiles: [] as string[],
  /**
   * Restrict to device names matching this SQL LIKE pattern, e.g. "%pump%".
   * null means every device.
   */
  deviceNamePattern: null as string | null,
};

export function resolveScope(params: Record<string, unknown>): DeviceScope {
  const rawProfiles = params.deviceProfiles;
  let profiles: string[] = [];
  if (Array.isArray(rawProfiles)) {
    profiles = rawProfiles.map((p, i) => {
      if (typeof p !== 'string' || p.length === 0) {
        throw new Error(`deviceProfiles[${i}] must be a non-empty string`);
      }
      return p;
    });
  } else if (typeof rawProfiles === 'string' && rawProfiles.length > 0) {
    profiles = [rawProfiles];
  } else if (rawProfiles !== null && rawProfiles !== undefined) {
    throw new Error('deviceProfiles must be an array of strings, a string, or null');
  }

  const rawPattern = params.deviceNamePattern;
  let namePattern: string | null = null;
  if (typeof rawPattern === 'string' && rawPattern.length > 0) {
    namePattern = rawPattern;
  } else if (rawPattern !== null && rawPattern !== undefined) {
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
export function scopeClause(
  scope: DeviceScope,
  startIndex: number,
  alias = '',
): { sql: string; values: unknown[] } {
  const p = alias ? `${alias}.` : '';
  const i = startIndex;
  return {
    sql:
      `AND (cardinality($${i}::text[]) = 0 OR ${p}device_profile_name = ANY($${i}::text[])) ` +
      `AND ($${i + 1}::text IS NULL OR ${p}device_name LIKE $${i + 1}::text)`,
    values: [scope.profiles, scope.namePattern],
  };
}

/** Human-readable scope, for alert detail and log lines. */
export function scopeLabel(scope: DeviceScope): string | null {
  const parts: string[] = [];
  if (scope.profiles.length > 0) parts.push(`profiles: ${scope.profiles.join(', ')}`);
  if (scope.namePattern) parts.push(`name like ${scope.namePattern}`);
  return parts.length > 0 ? parts.join('; ') : null;
}

/** Convenience for checks that resolve scope straight from their context. */
export function scopeFrom(ctx: SoundingContext): DeviceScope {
  return resolveScope(ctx.params);
}

/* -------------------------------------------------------------------------- */
/* Gateway scoping                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Which gateways a check considers.
 *
 * Separate from DeviceScope rather than folded into it, because the two axes narrow
 * different things and combining them would let a config say something meaningless —
 * a device profile does not select gateways.
 *
 * The interesting parameter is `ignoreGateways`. A gateway inventory built from
 * `rx_info` includes whatever has ever forwarded an uplink, which on a bench or during
 * commissioning means test gateways, a colleague's handheld, and anything else that
 * briefly appeared. Those raise a silence alert forever after, because they are silent
 * and were once seen. Naming them here is how they stop.
 */
export interface GatewayScope {
  /** Exact gateway EUIs to consider. Empty means every gateway seen. */
  only: string[];
  /** Exact gateway EUIs to skip. Applied after `only`. */
  ignore: string[];
}

export const ANY_GATEWAY: GatewayScope = { only: [], ignore: [] };

/** Parameters every gateway check exposes, so scoping reads the same everywhere. */
export const GATEWAY_SCOPE_PARAMS = {
  /**
   * Restrict to these gateway EUIs (16 hex characters, case-insensitive). Empty means
   * every gateway the event store has seen.
   */
  gateways: [] as string[],
  /**
   * Gateway EUIs to ignore — decommissioned units, and test gateways that appeared once
   * and would otherwise be reported silent forever.
   */
  ignoreGateways: [] as string[],
};

/** Gateway EUIs are compared lowercase, matching how rx_info and the API report them. */
function euiList(params: Record<string, unknown>, key: string): string[] {
  const raw = params[key];
  if (raw === null || raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((v, i) => {
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`${key}[${i}] must be a non-empty gateway EUI string`);
    }
    return v.trim().toLowerCase();
  });
}

export function resolveGatewayScope(params: Record<string, unknown>): GatewayScope {
  return { only: euiList(params, 'gateways'), ignore: euiList(params, 'ignoreGateways') };
}

/**
 * SQL predicate for a gateway scope, plus the values to bind.
 *
 * Same constant-shape approach as scopeClause: both parameters are always referenced so
 * the statement text does not change with configuration. Consumes two positional
 * parameters starting at `startIndex`.
 */
export function gatewayScopeClause(
  scope: GatewayScope,
  startIndex: number,
  column = 'gateway_id',
): { sql: string; values: unknown[] } {
  const i = startIndex;
  return {
    sql:
      `AND (cardinality($${i}::text[]) = 0 OR ${column} = ANY($${i}::text[])) ` +
      `AND NOT (${column} = ANY($${i + 1}::text[]))`,
    values: [scope.only, scope.ignore],
  };
}

/** Filter an in-memory list, for checks whose gateways come from the API rather than SQL. */
export function inGatewayScope(scope: GatewayScope, gatewayId: string): boolean {
  const id = gatewayId.toLowerCase();
  if (scope.only.length > 0 && !scope.only.includes(id)) return false;
  return !scope.ignore.includes(id);
}

/** Human-readable gateway scope, for alert detail and log lines. */
export function gatewayScopeLabel(scope: GatewayScope): string | null {
  const parts: string[] = [];
  if (scope.only.length > 0) parts.push(`gateways: ${scope.only.join(', ')}`);
  if (scope.ignore.length > 0) parts.push(`ignoring: ${scope.ignore.join(', ')}`);
  return parts.length > 0 ? parts.join('; ') : null;
}
