/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Parameter coercion for checks.
 *
 * Config values arrive as untyped JSON. These helpers turn them into the types a
 * check's SQL expects, and throw a message naming the parameter when they can't —
 * which surfaces as a check error in leadsman.run rather than as a confusing
 * Postgres cast failure.
 */

export class ParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParamError';
  }
}

export function num(params: Record<string, unknown>, key: string): number {
  const v = params[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  throw new ParamError(`param "${key}" must be a number (got ${JSON.stringify(v)})`);
}

export function int(params: Record<string, unknown>, key: string): number {
  const v = num(params, key);
  if (!Number.isInteger(v)) {
    throw new ParamError(`param "${key}" must be a whole number (got ${v})`);
  }
  return v;
}

export function str(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v === 'string' && v.length > 0) return v;
  throw new ParamError(`param "${key}" must be a non-empty string (got ${JSON.stringify(v)})`);
}

export function optNum(params: Record<string, unknown>, key: string): number | null {
  const v = params[key];
  if (v === null || v === undefined) return null;
  return num(params, key);
}

/**
 * A JSONB path for the `#>>` operator.
 *
 * Accepts either a dotted string ("status.battery") or an array
 * (["status", "battery"]), and always returns the array form Postgres wants.
 * Decoded measurements live under different shapes depending on the codec, so
 * every measurement check takes a path rather than hard-coding a key.
 */
export function jsonPath(params: Record<string, unknown>, key: string): string[] {
  const v = params[key];

  if (Array.isArray(v)) {
    if (v.length === 0) throw new ParamError(`param "${key}" must not be an empty path`);
    return v.map((seg, i) => {
      if (typeof seg !== 'string' || seg.length === 0) {
        throw new ParamError(`param "${key}"[${i}] must be a non-empty string`);
      }
      return seg;
    });
  }

  if (typeof v === 'string' && v.length > 0) {
    const parts = v.split('.').filter((s) => s.length > 0);
    if (parts.length === 0) throw new ParamError(`param "${key}" is not a usable path`);
    return parts;
  }

  throw new ParamError(
    `param "${key}" must be a dotted string or array of strings (got ${JSON.stringify(v)})`,
  );
}

/** Human-readable path for alert summaries: ["status","battery"] → "status.battery" */
export function pathLabel(path: string[]): string {
  return path.join('.');
}

/** Round for display without dragging in a formatting dependency. */
export function round(value: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}
