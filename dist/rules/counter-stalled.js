"use strict";
/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * counter-stalled — a monotonic total has stopped advancing.
 *
 * The vocabulary's cumulative fields need different treatment from instantaneous
 * readings, because for a counter "unchanged" is normal most of the time:
 *
 *   metering.water.total   litres through a water meter
 *   metering.energy.total  watt-hours through an energy meter
 *   pulse.total            raw pulse count
 *   rain.cumulative        millimetres of rain
 *   device.runtime         seconds a machine has run
 *
 * `measurement-stuck` would report every one of these constantly, since an idle
 * meter legitimately reports the same total for hours. So this check is explicitly
 * opt-in per meter and asks a narrower question: has the counter failed to advance
 * over a window in which you *expect* consumption?
 *
 * Useful for irrigation and stock water, where "no water used in 12 hours" during a
 * scheduled irrigation window means a failed pump, a closed valve, or a seized meter
 * — not a quiet day. Do not enable it on `rain.cumulative`, where a flat counter is
 * simply dry weather.
 *
 * A counter going *backwards* is also reported: that is a meter reset, a replacement
 * without re-provisioning, or a rollover, and it will silently corrupt any
 * consumption figure derived from the series.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const params_1 = require("../params");
const measurement_1 = require("../measurement");
const scope_1 = require("../scope");
const rule = {
    id: 'counter-stalled',
    description: 'Flags monotonic totals (water, energy, pulses, runtime) that failed to advance ' +
        'by a minimum amount over the window, or that went backwards. Enable only where ' +
        'consumption is genuinely expected — an idle meter is not a fault.',
    defaultSeverity: 'warning',
    defaultParams: {
        /** Priority-ordered candidate vocabulary paths holding the total. */
        paths: ['metering.water.total', 'pulse.total'],
        /** Window over which the advance is measured. */
        lookbackHours: 12,
        /** Alert if the total advanced by less than this over the window. */
        minAdvance: 1,
        /** Need at least this many readings before concluding anything. */
        minSamples: 4,
        /** Also alert when the total decreases — a meter reset, swap, or rollover. */
        alertOnDecrease: true,
        /** Narrow this check to part of the fleet — see src/scope.ts. */
        ...scope_1.SCOPE_PARAMS,
    },
    requires: [
        { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
    ],
    async run(ctx) {
        const paths = (0, measurement_1.resolvePaths)(ctx.params, 'paths');
        const lookbackHours = (0, params_1.int)(ctx.params, 'lookbackHours');
        const minAdvance = (0, params_1.num)(ctx.params, 'minAdvance');
        const minSamples = (0, params_1.int)(ctx.params, 'minSamples');
        const alertOnDecrease = ctx.params.alertOnDecrease !== false;
        if (minAdvance < 0)
            throw new Error('minAdvance must not be negative');
        const scope = (0, scope_1.resolveScope)(ctx.params);
        const stats = await (0, measurement_1.windowStats)(ctx, paths, lookbackHours, null, scope);
        if (stats.length === 0) {
            ctx.log.debug('no device reports any candidate path', { paths: (0, measurement_1.pathsLabel)(paths) });
            return [];
        }
        const findings = [];
        for (const s of stats) {
            if (s.samples < minSamples)
                continue;
            const advance = s.last - s.first;
            const name = s.deviceName ?? s.devEui;
            if (advance < 0) {
                if (!alertOnDecrease)
                    continue;
                findings.push({
                    devEui: s.devEui,
                    deviceName: s.deviceName,
                    summary: `${name} ${s.matchedPath} went backwards: ${(0, params_1.round)(s.first, 2)} → ` +
                        `${(0, params_1.round)(s.last, 2)} — meter reset, replacement, or rollover`,
                    // A silently corrupted consumption series is worse than a stalled one.
                    severity: 'critical',
                    detail: {
                        measurement: s.matchedPath,
                        reason: 'decrease',
                        firstValue: (0, params_1.round)(s.first, 3),
                        lastValue: (0, params_1.round)(s.last, 3),
                        delta: (0, params_1.round)(advance, 3),
                        samples: s.samples,
                        candidatePaths: (0, measurement_1.pathsLabel)(paths),
                        firstAt: s.firstAt,
                        lastAt: s.lastAt,
                    },
                });
                continue;
            }
            if (advance >= minAdvance)
                continue;
            findings.push({
                devEui: s.devEui,
                deviceName: s.deviceName,
                summary: `${name} ${s.matchedPath} advanced only ${(0, params_1.round)(advance, 2)} in ` +
                    `${lookbackHours}h (expected at least ${minAdvance})`,
                detail: {
                    measurement: s.matchedPath,
                    reason: 'stalled',
                    advance: (0, params_1.round)(advance, 3),
                    minAdvance,
                    firstValue: (0, params_1.round)(s.first, 3),
                    lastValue: (0, params_1.round)(s.last, 3),
                    samples: s.samples,
                    lookbackHours,
                    candidatePaths: (0, measurement_1.pathsLabel)(paths),
                    firstAt: s.firstAt,
                    lastAt: s.lastAt,
                },
            });
        }
        return findings;
    },
};
exports.default = rule;
//# sourceMappingURL=counter-stalled.js.map