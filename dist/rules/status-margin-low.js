"use strict";
/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * status-margin-low — the device is barely hearing the gateway.
 *
 * `signal-degraded` measures the link from the *gateway's* side: how well the network
 * received the device's uplinks. This measures the opposite direction. `margin` in
 * `DevStatusAns` is the device's own demodulation margin in dB for the last downlink it
 * decoded — its report on how well it can hear the network.
 *
 * The two are not interchangeable, and asymmetry is common. A device on a hilltop with a
 * good antenna may be heard perfectly (fine RSSI) while its own receiver is swamped by
 * local noise or sitting behind a lossy connector, so downlinks fail. Anything that
 * needs the downlink path breaks quietly:
 *
 *   - ADR cannot move the device to a better data rate, so it burns battery and airtime
 *   - Confirmed uplinks never get their ack, so the device retransmits (and logs code 7)
 *   - Actuator commands — a valve, a relay, a setpoint — never arrive
 *   - Rejoin and MAC commands fail, which shows up later as join churn
 *
 * A low margin is therefore an early warning for `downlink-unacked` and `join-churn`,
 * and it arrives from a path no codec touches.
 *
 * Margin is a signed dB value (roughly -32..31). Positive is headroom above the
 * demodulation floor; at or below ~5 dB the link has little to spare, and below 0 the
 * device decoded that downlink essentially by luck.
 *
 * Like `status-battery-low`, this reads `event_status`, which arrives only on the device
 * profile's DevStatusReq interval — so the default window is two weeks, not hours.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const params_1 = require("../params");
const scope_1 = require("../scope");
const rule = {
    id: 'status-margin-low',
    description: "Flags devices whose MAC-layer demodulation margin (event_status, from DevStatusAns) " +
        'is low — the device can barely hear the gateway. Early warning for failing ' +
        'downlinks, ADR problems, and join churn. The downlink counterpart to signal-degraded.',
    defaultSeverity: 'warning',
    defaultParams: {
        /**
         * Alert at or below this average margin, in dB. 5 dB leaves little headroom above
         * the demodulation floor; below 0 the device is decoding downlinks by luck.
         */
        minMarginDb: 5,
        /** Escalate to critical at or below this. null disables escalation. */
        criticalMarginDb: 0,
        /** Status events are infrequent — two weeks by default. */
        lookbackHours: 336,
        /** Need at least this many status readings before averaging means anything. */
        minReadings: 3,
    },
    requires: [
        { table: 'event_status', columns: ['dev_eui', 'device_name', 'time', 'margin'] },
    ],
    async run(ctx) {
        const minMargin = (0, params_1.num)(ctx.params, 'minMarginDb');
        const criticalMargin = ctx.params.criticalMarginDb === null || ctx.params.criticalMarginDb === undefined
            ? null
            : (0, params_1.num)(ctx.params, 'criticalMarginDb');
        const lookbackHours = (0, params_1.int)(ctx.params, 'lookbackHours');
        const minReadings = (0, params_1.int)(ctx.params, 'minReadings');
        if (criticalMargin !== null && criticalMargin > minMargin) {
            throw new Error(`criticalMarginDb (${criticalMargin}) must be <= minMarginDb (${minMargin})`);
        }
        const sc = (0, scope_1.scopeClause)((0, scope_1.resolveScope)(ctx.params), 4);
        // Average rather than latest: margin is measured against whichever downlink happened
        // to arrive, so a single reading is noisy. The minimum is carried through as context.
        const rows = await ctx.query(`SELECT dev_eui,
              max(device_name)                              AS device_name,
              round(avg(margin)::numeric, 1)                AS avg_margin,
              min(margin)                                   AS min_margin,
              (array_agg(margin ORDER BY time DESC))[1]      AS latest_margin,
              count(*)                                      AS readings,
              max(time)                                     AS latest_at
         FROM event_status
        WHERE time > now() - make_interval(hours => $1::int)
          AND margin IS NOT NULL
          ${sc.sql}
        GROUP BY dev_eui
       HAVING count(*) >= $2::int
          AND avg(margin) <= $3::numeric
        ORDER BY avg(margin) ASC`, [lookbackHours, minReadings, minMargin, ...sc.values]);
        return rows.map((row) => {
            const avg = Number(row.avg_margin);
            const name = row.device_name ?? row.dev_eui;
            return {
                devEui: row.dev_eui,
                deviceName: row.device_name,
                summary: `${name} downlink margin ${avg}dB over ${lookbackHours}h ` +
                    `(min ${row.min_margin}dB, threshold <=${minMargin}dB) — downlinks may be failing`,
                severity: criticalMargin !== null && avg <= criticalMargin ? 'critical' : undefined,
                detail: {
                    source: 'event_status.margin',
                    avgMarginDb: avg,
                    minMarginDb: Number(row.min_margin),
                    latestMarginDb: Number(row.latest_margin),
                    thresholdDb: minMargin,
                    criticalDb: criticalMargin,
                    statusReadings: Number(row.readings),
                    latestAt: row.latest_at,
                    lookbackHours,
                },
            };
        });
    },
};
exports.default = rule;
//# sourceMappingURL=status-margin-low.js.map