"use strict";
/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * measurement-threshold — min/max bound on the latest reading, resolved across
 * several candidate vocabulary paths.
 *
 * The workhorse. `paths` is a priority-ordered list, and per device the first path
 * actually present in that device's telemetry is used. Devices carrying none of the
 * candidates are ignored — so one entry safely covers a mixed fleet.
 *
 * That matters because the normalized vocabulary spreads one concept across several
 * paths. A frost check has to look at `temperature`, `air.temperature`,
 * `leaf.temperature`, and `water.temperature.current`, because which one a device
 * emits depends on what kind of sensor it is:
 *
 *   { "rule": "measurement-threshold", "as": "frost-risk", "severity": "critical",
 *     "params": { "paths": ["air.temperature", "temperature", "leaf.temperature"],
 *                 "min": 1.5, "unit": "C" } }
 *
 * Units are guaranteed by normalization (°C, %, m/s, hPa, …), so thresholds mean
 * the same thing on every vendor's hardware. See docs/vocabulary.md.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const params_1 = require("../params");
const measurement_1 = require("../measurement");
const scope_1 = require("../scope");
const rule = {
    id: 'measurement-threshold',
    description: 'Flags devices whose latest reading, at the first matching path from a candidate ' +
        'list, falls below min or above max. Devices reporting none of the paths are ' +
        'ignored. Enable once per measurement with a distinct "as" name.',
    defaultSeverity: 'warning',
    defaultParams: {
        /**
         * Priority-ordered candidate vocabulary paths. The first one present on a given
         * device wins. Dotted strings or arrays of segments.
         */
        paths: ['temperature', 'air.temperature'],
        /** Alert below this. null disables the lower bound. */
        min: null,
        /** Alert above this. null disables the upper bound. */
        max: null,
        /** Shown in the alert summary. Vocabulary units: C, %, m/s, hPa, ppm, … */
        unit: '',
        /** How far back to look for a device's most recent reading. */
        lookbackHours: 24,
        /**
         * Hysteresis, in measurement units. An open alert stays open until the reading
         * recovers this far past the bound it broke, so a value resting on the boundary
         * does not resolve and re-raise (and re-notify) every sounding.
         */
        clearMargin: 0,
        /** Narrow this check to part of the fleet — see src/scope.ts. */
        ...scope_1.SCOPE_PARAMS,
    },
    requires: [
        { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
    ],
    async run(ctx) {
        const paths = (0, measurement_1.resolvePaths)(ctx.params, 'paths');
        const min = (0, params_1.optNum)(ctx.params, 'min');
        const max = (0, params_1.optNum)(ctx.params, 'max');
        const lookbackHours = (0, params_1.int)(ctx.params, 'lookbackHours');
        const clearMargin = (0, params_1.optNum)(ctx.params, 'clearMargin') ?? 0;
        const unit = typeof ctx.params.unit === 'string' ? ctx.params.unit : '';
        if (min === null && max === null) {
            throw new Error('at least one of "min" or "max" must be set — with neither bound this check ' +
                'can never fire');
        }
        if (min !== null && max !== null && min > max) {
            throw new Error(`min (${min}) must not exceed max (${max})`);
        }
        if (clearMargin < 0)
            throw new Error('clearMargin must not be negative');
        const scope = (0, scope_1.resolveScope)(ctx.params);
        const readings = await (0, measurement_1.latestReadings)(ctx, paths, lookbackHours, scope);
        if (readings.length === 0) {
            ctx.log.debug('no device reports any candidate path', { paths: (0, measurement_1.pathsLabel)(paths) });
            return [];
        }
        const suffix = unit ? `${unit}` : '';
        const findings = [];
        for (const r of readings) {
            const open = ctx.openDevEuis.has(r.devEui);
            // Widen the bounds for devices already in breach — that is the hysteresis.
            const lower = min === null ? null : open ? min + clearMargin : min;
            const upper = max === null ? null : open ? max - clearMargin : max;
            const belowMin = lower !== null && r.value < lower;
            const aboveMax = upper !== null && r.value > upper;
            if (!belowMin && !aboveMax)
                continue;
            const name = r.deviceName ?? r.devEui;
            const bound = belowMin ? `min ${min}${suffix}` : `max ${max}${suffix}`;
            findings.push({
                devEui: r.devEui,
                deviceName: r.deviceName,
                summary: `${name} ${r.matchedPath} ${(0, params_1.round)(r.value, 2)}${suffix} is ` +
                    `${belowMin ? 'below' : 'above'} ${bound}`,
                detail: {
                    measurement: r.matchedPath,
                    value: (0, params_1.round)(r.value, 3),
                    unit: unit || null,
                    min,
                    max,
                    breached: belowMin ? 'min' : 'max',
                    clearMargin,
                    candidatePaths: (0, measurement_1.pathsLabel)(paths),
                    readingAt: r.at,
                },
            });
        }
        return findings;
    },
};
exports.default = rule;
//# sourceMappingURL=measurement-threshold.js.map