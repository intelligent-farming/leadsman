"use strict";
/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * boolean-alarm — a flag in the telemetry is asserted.
 *
 * The vocabulary has a cluster of boolean and enum states that mean "something has
 * happened" rather than "here is a number":
 *
 *   water.leak                 a leak detector tripped
 *   air.gasAlarm               gas detected / abnormal
 *   action.smoke.detected      smoke detector tripped
 *   action.motion.detected     motion where there should be none
 *   action.switch.state        a switch or relay changed
 *   action.occupancy.occupied  space occupied
 *   action.button.pressed      a panic or acknowledge button
 *   action.contactState        "open" / "closed" — a gate or hatch
 *
 * Codecs express truth inconsistently even after normalization, because the
 * vocabulary allows `additionalProperties` and vendor codecs differ: `true`, `"true"`,
 * `1`, and `"open"` all occur. `trueValues` is therefore configurable, and matching
 * is case-insensitive.
 *
 * The alert clears when the flag reads false again, so a leak detector that trips and
 * is then dried out resolves on its own — while a detector that stays wet keeps one
 * open alert rather than notifying on every uplink.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const params_1 = require("../params");
const measurement_1 = require("../measurement");
const scope_1 = require("../scope");
const rule = {
    id: 'boolean-alarm',
    description: 'Flags devices whose latest reading at a candidate path is an asserted flag — ' +
        'leak, gas, smoke, motion, switch, occupancy, button, or an open contact. ' +
        'Resolves when the flag reads false again.',
    defaultSeverity: 'critical',
    defaultParams: {
        /** Priority-ordered candidate vocabulary paths holding the flag. */
        paths: ['water.leak'],
        /**
         * Values that count as asserted, compared case-insensitively as text. Covers
         * JSON booleans, numeric flags, and the contactState enum.
         */
        trueValues: ['true', '1', 'open', 'detected', 'on', 'yes'],
        /** How far back to look for a device's most recent reading. */
        lookbackHours: 24,
        /** Wording for the alert summary, e.g. "leak detected". */
        label: 'alarm asserted',
        /** Narrow this check to part of the fleet — see src/scope.ts. */
        ...scope_1.SCOPE_PARAMS,
    },
    requires: [
        { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
    ],
    async run(ctx) {
        const paths = (0, measurement_1.resolvePaths)(ctx.params, 'paths');
        const lookbackHours = (0, params_1.int)(ctx.params, 'lookbackHours');
        const label = typeof ctx.params.label === 'string' ? ctx.params.label : 'alarm asserted';
        const rawTrue = ctx.params.trueValues;
        if (!Array.isArray(rawTrue) || rawTrue.length === 0) {
            throw new Error('trueValues must be a non-empty array of strings');
        }
        const trueValues = rawTrue.map((v) => String(v));
        const scope = (0, scope_1.resolveScope)(ctx.params);
        const readings = await (0, measurement_1.latestBooleans)(ctx, paths, lookbackHours, trueValues, scope);
        if (readings.length === 0) {
            ctx.log.debug('no device reports any candidate path', { paths: (0, measurement_1.pathsLabel)(paths) });
            return [];
        }
        return readings
            .filter((r) => r.value)
            .map((r) => {
            const name = r.deviceName ?? r.devEui;
            return {
                devEui: r.devEui,
                deviceName: r.deviceName,
                summary: `${name}: ${label} (${r.matchedPath} = ${r.raw})`,
                detail: {
                    measurement: r.matchedPath,
                    rawValue: r.raw,
                    trueValues,
                    candidatePaths: (0, measurement_1.pathsLabel)(paths),
                    readingAt: r.at,
                },
            };
        });
    },
};
exports.default = rule;
//# sourceMappingURL=boolean-alarm.js.map