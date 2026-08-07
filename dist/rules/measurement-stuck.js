"use strict";
/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * measurement-stuck — the device is reporting, but the reading never changes.
 *
 * One of two failure modes that passes every other check. A soil probe pulled out of
 * the ground, a seized cup anemometer, a latched ADC, or a codec returning a
 * constant will all keep producing perfectly plausible in-range values forever.
 * Threshold checks are satisfied, uplinks keep arriving, and the data is worthless.
 *
 * Detection is deliberately blunt: over a window, count distinct values. A real
 * environmental measurement moves — even a stable one dithers in the last decimal.
 * Zero variation across many samples means the sensor, not the environment.
 *
 * Two tuning levers, because coarse sensors legitimately repeat values:
 *   - `decimals` compares at the sensor's real resolution rather than full float
 *     precision (a 0.5 %-resolution moisture probe looks stuck at 3 decimals).
 *   - `minSamples` raises the evidence bar.
 *
 * Do not point this at a monotonic counter — a counter that stops is
 * `counter-stalled`, and a counter that is merely idle is not a fault.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const params_1 = require("../params");
const measurement_1 = require("../measurement");
const scope_1 = require("../scope");
const rule = {
    id: 'measurement-stuck',
    description: 'Flags devices whose reading at the first matching candidate path has not changed ' +
        'across many consecutive uplinks — a detached, seized, latched, or mis-decoded ' +
        'sensor. Invisible to threshold and silence checks.',
    defaultSeverity: 'warning',
    defaultParams: {
        /** Priority-ordered candidate vocabulary paths. */
        paths: ['soil.moisture'],
        /** Window to examine. */
        lookbackHours: 24,
        /** Need at least this many readings before concluding anything. */
        minSamples: 12,
        /**
         * Round to this many decimals before comparing, to match the sensor's real
         * resolution. Comparing raw floats makes coarse sensors look stuck.
         */
        decimals: 3,
        /**
         * Allow this many distinct values and still call it stuck. 1 is strict (no
         * variation at all). Raise to 2 for a sensor that toggles between two adjacent
         * quantization steps, which is also a fault but reports two values.
         */
        maxDistinctValues: 1,
        /** Narrow this check to part of the fleet — see src/scope.ts. */
        ...scope_1.SCOPE_PARAMS,
    },
    requires: [
        { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
    ],
    async run(ctx) {
        const paths = (0, measurement_1.resolvePaths)(ctx.params, 'paths');
        const lookbackHours = (0, params_1.int)(ctx.params, 'lookbackHours');
        const minSamples = (0, params_1.int)(ctx.params, 'minSamples');
        const decimals = (0, params_1.int)(ctx.params, 'decimals');
        const maxDistinct = (0, params_1.int)(ctx.params, 'maxDistinctValues');
        if (minSamples < 2)
            throw new Error('minSamples must be at least 2');
        if (decimals < 0 || decimals > 10)
            throw new Error('decimals must be between 0 and 10');
        if (maxDistinct < 1)
            throw new Error('maxDistinctValues must be at least 1');
        const scope = (0, scope_1.resolveScope)(ctx.params);
        const stats = await (0, measurement_1.windowStats)(ctx, paths, lookbackHours, decimals, scope);
        if (stats.length === 0) {
            ctx.log.debug('no device reports any candidate path', { paths: (0, measurement_1.pathsLabel)(paths) });
            return [];
        }
        const findings = [];
        for (const s of stats) {
            if (s.samples < minSamples)
                continue;
            if (s.distinctValues > maxDistinct)
                continue;
            const name = s.deviceName ?? s.devEui;
            const spanHours = (new Date(s.lastAt).getTime() - new Date(s.firstAt).getTime()) / 3600000;
            findings.push({
                devEui: s.devEui,
                deviceName: s.deviceName,
                summary: `${name} ${s.matchedPath} stuck at ${(0, params_1.round)(s.last, Math.min(decimals, 4))} ` +
                    `across ${s.samples} readings over ${Math.round(spanHours)}h — check the sensor`,
                detail: {
                    measurement: s.matchedPath,
                    value: (0, params_1.round)(s.last, 4),
                    samples: s.samples,
                    distinctValues: s.distinctValues,
                    comparedAtDecimals: decimals,
                    candidatePaths: (0, measurement_1.pathsLabel)(paths),
                    firstAt: s.firstAt,
                    lastAt: s.lastAt,
                    spanHours: (0, params_1.round)(spanHours, 1),
                },
            });
        }
        return findings;
    },
};
exports.default = rule;
//# sourceMappingURL=measurement-stuck.js.map