"use strict";
/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * downlink-unacked — confirmed downlinks are not being acknowledged.
 *
 * Every other check in this engine watches data coming *from* devices. This one watches
 * whether the commands you sent *to* them actually landed, which is the difference
 * between monitoring and control.
 *
 * On a farm the downlinks that matter are the ones that move something: open a valve,
 * start a pump, change a setpoint, retune a reporting interval. Those are normally sent
 * confirmed, and ChirpStack records the outcome in `event_ack` — `acknowledged = true`
 * when the device confirmed it, `false` when the confirmation never came.
 *
 * An unacknowledged downlink is genuinely dangerous, because the failure is silent in
 * both directions. Nothing in the telemetry says "the valve did not open"; the sensor
 * keeps reporting the same reading it would have reported anyway, and a scheduler that
 * assumes its command was applied will happily move on. If you act on downlinks at all,
 * this is the check that tells you when you only think you did.
 *
 * Usual causes are downlink-path problems: the device is not listening at the right time
 * (Class A receive windows missed), it cannot hear the gateway (see
 * `status-margin-low`), the session was reset between send and ack (see `join-churn`),
 * or the payload was too large for the current data rate — which ChirpStack also logs to
 * `event_log`, so `device-log-error` often fires alongside.
 *
 * Note `event_ack` only receives rows for *confirmed* downlinks. A deployment that never
 * sends confirmed downlinks will have an empty table and this check will correctly stay
 * silent forever, which is why it ships disabled in the example config.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const params_1 = require("../params");
const scope_1 = require("../scope");
const rule = {
    id: 'downlink-unacked',
    description: 'Flags devices whose confirmed downlinks are not being acknowledged — a command you ' +
        'sent never landed. Silent in the telemetry, because a valve that failed to open ' +
        'produces no anomalous reading. Only meaningful if you send confirmed downlinks.',
    defaultSeverity: 'critical',
    defaultParams: {
        /** Window to examine. */
        lookbackHours: 24,
        /** Need at least this many unacknowledged downlinks before alerting. */
        minUnacked: 2,
        /**
         * Fraction of confirmed downlinks in the window that must be unacknowledged (0–1).
         * A single lost ack is normal radio behaviour; a majority failing is a broken
         * downlink path.
         */
        minUnackedRatio: 0.5,
        /** Narrow this check to part of the fleet — see src/scope.ts. */
        ...scope_1.SCOPE_PARAMS,
    },
    requires: [
        {
            table: 'event_ack',
            columns: ['dev_eui', 'device_name', 'time', 'acknowledged', 'f_cnt_down'],
        },
    ],
    async run(ctx) {
        const lookbackHours = (0, params_1.int)(ctx.params, 'lookbackHours');
        const minUnacked = (0, params_1.int)(ctx.params, 'minUnacked');
        const minRatio = (0, params_1.num)(ctx.params, 'minUnackedRatio');
        if (minRatio <= 0 || minRatio > 1) {
            throw new Error(`minUnackedRatio must be in (0, 1] (got ${minRatio})`);
        }
        const sc = (0, scope_1.scopeClause)((0, scope_1.resolveScope)(ctx.params), 4);
        // `acknowledged IS NOT TRUE` rather than `= false`, so a NULL — which some
        // ChirpStack versions write when the ack never resolved either way — counts as a
        // failure rather than vanishing from both sides of the ratio.
        const rows = await ctx.query(`SELECT dev_eui,
              max(device_name)                                        AS device_name,
              count(*) FILTER (WHERE acknowledged IS NOT TRUE)        AS unacked,
              count(*)                                                AS total,
              max(time) FILTER (WHERE acknowledged IS NOT TRUE)       AS latest_unacked_at,
              (array_agg(f_cnt_down ORDER BY time DESC)
                 FILTER (WHERE acknowledged IS NOT TRUE))[1]          AS latest_f_cnt_down
         FROM event_ack
        WHERE time > now() - make_interval(hours => $1::int)
          ${sc.sql}
        GROUP BY dev_eui
       HAVING count(*) FILTER (WHERE acknowledged IS NOT TRUE) >= $2::int
          AND count(*) FILTER (WHERE acknowledged IS NOT TRUE)::numeric
              / count(*)::numeric >= $3::numeric
        ORDER BY count(*) FILTER (WHERE acknowledged IS NOT TRUE) DESC`, [lookbackHours, minUnacked, minRatio, ...sc.values]);
        return rows.map((row) => {
            const unacked = Number(row.unacked);
            const total = Number(row.total);
            const ratio = total > 0 ? unacked / total : 0;
            const name = row.device_name ?? row.dev_eui;
            return {
                devEui: row.dev_eui,
                deviceName: row.device_name,
                summary: `${name}: ${unacked} of ${total} confirmed downlinks unacknowledged ` +
                    `(${(0, params_1.round)(ratio * 100, 0)}%) — commands may not be landing`,
                detail: {
                    unacked,
                    totalConfirmedDownlinks: total,
                    unackedRatio: (0, params_1.round)(ratio, 3),
                    minUnacked,
                    minUnackedRatio: minRatio,
                    latestUnackedAt: row.latest_unacked_at,
                    latestFCntDown: row.latest_f_cnt_down === null ? null : Number(row.latest_f_cnt_down),
                    lookbackHours,
                },
            };
        });
    },
};
exports.default = rule;
//# sourceMappingURL=downlink-unacked.js.map