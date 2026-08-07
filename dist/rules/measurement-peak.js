"use strict";
/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * measurement-peak — the highest (or lowest) value *anywhere* in a window.
 *
 * `measurement-threshold` looks at the latest reading, which answers "what is it
 * doing right now". This answers "did it ever cross the line", which is the right
 * question for anything transient:
 *
 *   - A damaging wind gust between two uplinks. A station reporting 10-minute
 *     averages can hide a 25 m/s gust entirely.
 *   - Peak sound level, peak vibration on a pump, a pressure spike.
 *   - An overnight temperature minimum, when the morning reading has recovered
 *     but the crop was still frosted at 04:00.
 *
 * Two independent knobs: `direction` picks the aggregate (window `max` or `min`) and
 * `comparison` picks which side of `threshold` fires (`above` or `below`). All four
 * combinations are useful, and the two "inverted" ones are not obvious:
 *
 *   max / above   a wind gust, a pressure spike, peak vibration
 *   min / below   an overnight temperature minimum — it frosted at 04:00
 *   max / below   a light sensor whose *daily peak* never got bright: fouled, shaded,
 *                 or buried. A plain threshold cannot express this, because low lux at
 *                 night is normal and would fire every evening.
 *   min / above   it never got cold enough — unmet chill hours, or a cold store whose
 *                 minimum stayed above spec all day.
 *
 * `comparison` defaults to the natural pairing (`max`→`above`, `min`→`below`).
 *
 * Note the interaction with the sounding schedule: a peak stays inside the window
 * for `lookbackHours` after it happens, so the alert persists for that long and
 * then auto-resolves as the peak ages out. Set the window to how long you want the
 * alert to stand, not to how often you sound.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const params_1 = require("../params");
const measurement_1 = require("../measurement");
const scope_1 = require("../scope");
const rule = {
    id: 'measurement-peak',
    description: 'Flags devices whose highest (or lowest) reading anywhere in the window crosses a ' +
        'threshold, rather than only the latest reading. Use for wind gusts, peak ' +
        'vibration or sound, pressure spikes, and overnight temperature minima.',
    defaultSeverity: 'warning',
    defaultParams: {
        /** Priority-ordered candidate vocabulary paths. */
        paths: ['wind.speed'],
        /** Which aggregate to test: the window's "max" or its "min". */
        direction: 'max',
        /**
         * Which side of the threshold fires: "above" or "below". Defaults to the natural
         * pairing for `direction` — max→above, min→below. Set it explicitly for the
         * inverted cases (a daily peak that is too low, a daily minimum that is too high).
         */
        comparison: null,
        /** The line being crossed, in vocabulary units. */
        threshold: 17,
        /** Shown in the alert summary. */
        unit: ' m/s',
        /** Window examined — also how long the alert stands after the peak. */
        lookbackHours: 3,
        /** Ignore devices with fewer readings than this in the window. */
        minSamples: 3,
        /** Narrow this check to part of the fleet — see src/scope.ts. */
        ...scope_1.SCOPE_PARAMS,
    },
    requires: [
        { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
    ],
    async run(ctx) {
        const paths = (0, measurement_1.resolvePaths)(ctx.params, 'paths');
        const direction = (0, params_1.str)(ctx.params, 'direction');
        const threshold = (0, params_1.num)(ctx.params, 'threshold');
        const lookbackHours = (0, params_1.int)(ctx.params, 'lookbackHours');
        const minSamples = (0, params_1.int)(ctx.params, 'minSamples');
        const unit = typeof ctx.params.unit === 'string' ? ctx.params.unit : '';
        if (direction !== 'max' && direction !== 'min') {
            throw new Error(`direction must be "max" or "min" (got "${direction}")`);
        }
        const rawComparison = ctx.params.comparison;
        if (rawComparison !== null && rawComparison !== undefined && rawComparison !== 'above' && rawComparison !== 'below') {
            throw new Error(`comparison must be "above", "below", or null (got "${String(rawComparison)}")`);
        }
        // Natural pairing when unset: a max is normally too high, a min too low.
        const comparison = rawComparison ??
            (direction === 'max' ? 'above' : 'below');
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
            const peak = direction === 'max' ? s.max : s.min;
            const breached = comparison === 'above' ? peak > threshold : peak < threshold;
            if (!breached)
                continue;
            const name = s.deviceName ?? s.devEui;
            findings.push({
                devEui: s.devEui,
                deviceName: s.deviceName,
                summary: `${name} ${s.matchedPath} ${direction === 'max' ? 'peaked at' : 'bottomed at'} ` +
                    `${(0, params_1.round)(peak, 2)}${unit} in the last ${lookbackHours}h ` +
                    `(alerts ${comparison} ${threshold}${unit})`,
                detail: {
                    measurement: s.matchedPath,
                    peak: (0, params_1.round)(peak, 3),
                    direction,
                    comparison,
                    threshold,
                    unit: unit.trim() || null,
                    windowAvg: (0, params_1.round)(s.avg, 3),
                    windowMin: (0, params_1.round)(s.min, 3),
                    windowMax: (0, params_1.round)(s.max, 3),
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
//# sourceMappingURL=measurement-peak.js.map