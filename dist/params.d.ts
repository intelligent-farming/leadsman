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
export declare class ParamError extends Error {
    constructor(message: string);
}
export declare function num(params: Record<string, unknown>, key: string): number;
export declare function int(params: Record<string, unknown>, key: string): number;
export declare function str(params: Record<string, unknown>, key: string): string;
export declare function optNum(params: Record<string, unknown>, key: string): number | null;
/**
 * A JSONB path for the `#>>` operator.
 *
 * Accepts either a dotted string ("status.battery") or an array
 * (["status", "battery"]), and always returns the array form Postgres wants.
 * Decoded measurements live under different shapes depending on the codec, so
 * every measurement check takes a path rather than hard-coding a key.
 */
export declare function jsonPath(params: Record<string, unknown>, key: string): string[];
/** Human-readable path for alert summaries: ["status","battery"] → "status.battery" */
export declare function pathLabel(path: string[]): string;
/** Round for display without dragging in a formatting dependency. */
export declare function round(value: number, places?: number): number;
//# sourceMappingURL=params.d.ts.map