"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParamError = void 0;
exports.num = num;
exports.int = int;
exports.str = str;
exports.optNum = optNum;
exports.jsonPath = jsonPath;
exports.pathLabel = pathLabel;
exports.round = round;
class ParamError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ParamError';
    }
}
exports.ParamError = ParamError;
function num(params, key) {
    const v = params[key];
    if (typeof v === 'number' && Number.isFinite(v))
        return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
        return Number(v);
    throw new ParamError(`param "${key}" must be a number (got ${JSON.stringify(v)})`);
}
function int(params, key) {
    const v = num(params, key);
    if (!Number.isInteger(v)) {
        throw new ParamError(`param "${key}" must be a whole number (got ${v})`);
    }
    return v;
}
function str(params, key) {
    const v = params[key];
    if (typeof v === 'string' && v.length > 0)
        return v;
    throw new ParamError(`param "${key}" must be a non-empty string (got ${JSON.stringify(v)})`);
}
function optNum(params, key) {
    const v = params[key];
    if (v === null || v === undefined)
        return null;
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
function jsonPath(params, key) {
    const v = params[key];
    if (Array.isArray(v)) {
        if (v.length === 0)
            throw new ParamError(`param "${key}" must not be an empty path`);
        return v.map((seg, i) => {
            if (typeof seg !== 'string' || seg.length === 0) {
                throw new ParamError(`param "${key}"[${i}] must be a non-empty string`);
            }
            return seg;
        });
    }
    if (typeof v === 'string' && v.length > 0) {
        const parts = v.split('.').filter((s) => s.length > 0);
        if (parts.length === 0)
            throw new ParamError(`param "${key}" is not a usable path`);
        return parts;
    }
    throw new ParamError(`param "${key}" must be a dotted string or array of strings (got ${JSON.stringify(v)})`);
}
/** Human-readable path for alert summaries: ["status","battery"] → "status.battery" */
function pathLabel(path) {
    return path.join('.');
}
/** Round for display without dragging in a formatting dependency. */
function round(value, places = 2) {
    const f = 10 ** places;
    return Math.round(value * f) / f;
}
//# sourceMappingURL=params.js.map