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
 * pattern is a SQL `LIKE`, so `%pump%` works. `devEuis` names the devices outright —
 * the way to segment a check by field or location when device names do not encode it.
 * All three are optional, combine with AND, and default to matching everything, which
 * keeps existing configs behaving identically.
 */

import type { SoundingContext } from './types';

export interface DeviceScope {
  /** Exact `device_profile_name` values. Empty means every profile. */
  profiles: string[];
  /** SQL LIKE pattern against `device_name`. null means every device. */
  namePattern: string | null;
  /** Exact DevEUIs, lower-case hex. Empty means every device. */
  devEuis: string[];
}

export const ANY_DEVICE: DeviceScope = { profiles: [], namePattern: null, devEuis: [] };

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
  /**
   * Restrict to these devices, by DevEUI (16 hex digits, any case). Empty or null means
   * every device. Use this to segment a check by field or location.
   */
  devEuis: [] as string[],
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

  const rawEuis = params.devEuis;
  let devEuis: string[] = [];
  if (Array.isArray(rawEuis)) {
    devEuis = rawEuis.map((e, i) => {
      if (typeof e !== 'string' || !/^[0-9a-fA-F]{16}$/.test(e)) {
        throw new Error(`devEuis[${i}] must be a DevEUI — 16 hex digits (got ${JSON.stringify(e)})`);
      }
      // ChirpStack stores DevEUIs as lower-case hex; match that, whatever case was typed.
      return e.toLowerCase();
    });
  } else if (rawEuis !== null && rawEuis !== undefined) {
    throw new Error('devEuis must be an array of DevEUI strings, or null');
  }

  return { profiles, namePattern, devEuis };
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
  // The two list filters travel in ONE jsonb parameter, {"p": profiles, "d": DevEUIs},
  // so the clause still binds exactly two values. Every caller numbers its own
  // parameters after these two; a third would shift them all.
  const list = (key: string) => `ARRAY(SELECT jsonb_array_elements_text($${i}::jsonb -> '${key}'))`;
  return {
    sql:
      `AND (jsonb_array_length($${i}::jsonb -> 'p') = 0 OR ${p}device_profile_name = ANY(${list('p')})) ` +
      `AND (jsonb_array_length($${i}::jsonb -> 'd') = 0 OR ${p}dev_eui = ANY(${list('d')})) ` +
      `AND ($${i + 1}::text IS NULL OR ${p}device_name LIKE $${i + 1}::text)`,
    values: [JSON.stringify({ p: scope.profiles, d: scope.devEuis }), scope.namePattern],
  };
}

/** Human-readable scope, for alert detail and log lines. */
export function scopeLabel(scope: DeviceScope): string | null {
  const parts: string[] = [];
  if (scope.profiles.length > 0) parts.push(`profiles: ${scope.profiles.join(', ')}`);
  if (scope.namePattern) parts.push(`name like ${scope.namePattern}`);
  if (scope.devEuis.length > 0) parts.push(`devices: ${scope.devEuis.join(', ')}`);
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

/**
 * Gateway EUIs are compared lowercase, matching how ChirpStack v4's rx_info and API report
 * them. Lowercased here for the in-memory comparison, and again on both sides of the SQL
 * predicate in gatewayScopeClause, so an uppercase id in rx_info (a v3-era row, a
 * hand-written fixture, another writer) is still matched by `gateways`/`ignoreGateways`.
 */
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
 *
 * Case-insensitive on both sides: the column is wrapped in lower() and the bound lists
 * are lowercased here rather than trusted to arrive that way, because a GatewayScope can
 * be built directly (ANY_GATEWAY, a test) without going through resolveGatewayScope.
 * Comparing the raw rx_info id against a lowercased list would let an uppercase id slip
 * past `ignoreGateways` — the documented "compared lowercase" would then be untrue.
 */
export function gatewayScopeClause(
  scope: GatewayScope,
  startIndex: number,
  column = 'gateway_id',
): { sql: string; values: unknown[] } {
  const i = startIndex;
  return {
    sql:
      `AND (cardinality($${i}::text[]) = 0 OR lower(${column}) = ANY($${i}::text[])) ` +
      `AND NOT (lower(${column}) = ANY($${i + 1}::text[]))`,
    values: [
      scope.only.map((id) => id.toLowerCase()),
      scope.ignore.map((id) => id.toLowerCase()),
    ],
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
