"use strict";
/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * battery-low — supply voltage has fallen below a threshold.
 *
 * Almost every category in the normalized vocabulary lists `battery` (volts) in its
 * `provides`, which makes this the one check that meaningfully covers a whole fleet
 * from a single entry. Mains- or analog-powered nodes report `power.voltage`
 * instead, so both are candidates by default.
 *
 * Demonstrates hysteresis, which matters more than it sounds. A cell sitting on the
 * threshold drifts above and below it with temperature, and because the engine
 * notifies on *newly raised* alerts, a naive check would send an SMS on every
 * crossing. Two thresholds fix it: raise at `raiseAtVolts`, and hold the alert open
 * until the reading recovers past the looser `clearAtVolts`. `ctx.openDevEuis` is
 * what lets the check do that without keeping state of its own.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const params_1 = require("../params");
const measurement_1 = require("../measurement");
const scope_1 = require("../scope");
const rule = {
    id: 'battery-low',
    description: 'Flags devices whose latest battery (or supply) voltage is below the raise ' +
        'threshold, holding the alert open until it recovers past the clear threshold. ' +
        'Covers most of a fleet from one entry, since nearly every device category ' +
        'reports battery.',
    defaultSeverity: 'warning',
    defaultParams: {
        /**
         * Candidate paths, in priority order. `battery` is the vocabulary's standard
         * volts field; `power.voltage` covers mains- and analog-powered nodes.
         */
        paths: ['battery', 'power.voltage'],
        /** Raise when the latest reading is at or below this. */
        raiseAtVolts: 3.4,
        /** Hold the alert open until the reading exceeds this. Must be >= raiseAtVolts. */
        clearAtVolts: 3.55,
        /**
         * Escalate to critical at or below this. An explicit parameter rather than an
         * offset from raiseAtVolts: `raiseAtVolts - 0.2` evaluates to 3.1999999999999997
         * in IEEE-754, so a reading of exactly 3.2 would silently fail to escalate.
         * null disables escalation.
         */
        criticalAtVolts: 3.2,
        /** How far back to look for a device's most recent reading. */
        lookbackHours: 24,
        /** Narrow this check to part of the fleet — see src/scope.ts. */
        ...scope_1.SCOPE_PARAMS,
    },
    requires: [
        { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
    ],
    async run(ctx) {
        const paths = (0, measurement_1.resolvePaths)(ctx.params, 'paths');
        const raiseAt = (0, params_1.num)(ctx.params, 'raiseAtVolts');
        const clearAt = (0, params_1.num)(ctx.params, 'clearAtVolts');
        const criticalAt = (0, params_1.optNum)(ctx.params, 'criticalAtVolts');
        const lookbackHours = (0, params_1.num)(ctx.params, 'lookbackHours');
        if (clearAt < raiseAt) {
            throw new Error(`clearAtVolts (${clearAt}) must be >= raiseAtVolts (${raiseAt}); a clear ` +
                'threshold below the raise threshold defeats the hysteresis');
        }
        if (criticalAt !== null && criticalAt > raiseAt) {
            throw new Error(`criticalAtVolts (${criticalAt}) must be <= raiseAtVolts (${raiseAt}); an ` +
                'escalation threshold above the raise threshold would fire on every alert');
        }
        const scope = (0, scope_1.resolveScope)(ctx.params);
        const readings = await (0, measurement_1.latestReadings)(ctx, paths, lookbackHours, scope);
        const findings = [];
        for (const r of readings) {
            // Devices already in breach are evaluated against the looser clear threshold.
            const limit = ctx.openDevEuis.has(r.devEui) ? clearAt : raiseAt;
            if (r.value > limit)
                continue;
            const name = r.deviceName ?? r.devEui;
            findings.push({
                devEui: r.devEui,
                deviceName: r.deviceName,
                summary: `${name} ${r.matchedPath} ${(0, params_1.round)(r.value, 2)}V ` +
                    `(raise <=${raiseAt}V, clear >${clearAt}V)`,
                // A nearly-flat cell is a different conversation from one that just crossed.
                severity: criticalAt !== null && r.value <= criticalAt ? 'critical' : undefined,
                detail: {
                    measurement: r.matchedPath,
                    value: (0, params_1.round)(r.value, 3),
                    raiseAtVolts: raiseAt,
                    clearAtVolts: clearAt,
                    criticalAtVolts: criticalAt,
                    candidatePaths: (0, measurement_1.pathsLabel)(paths),
                    readingAt: r.at,
                },
            });
        }
        return findings;
    },
};
exports.default = rule;
//# sourceMappingURL=battery-low.js.map