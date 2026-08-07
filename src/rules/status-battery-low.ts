/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * status-battery-low — battery percentage from the LoRaWAN MAC layer.
 *
 * The important property: **this works when the codec does not.**
 *
 * `battery-low` reads whatever the payload codec decoded into `battery`. If the device
 * profile has no codec, a broken one, or one that dropped the battery field, that check
 * silently stops matching the device — and a flat battery goes unnoticed precisely when
 * everything else has already gone quiet.
 *
 * `event_status` comes from a different path entirely. ChirpStack issues a MAC-layer
 * `DevStatusReq` on the interval configured in the device profile, and the device answers
 * with `DevStatusAns` carrying battery and margin. No codec is involved. So this check
 * still reports on a device whose payload decoding is completely broken, which makes it
 * the natural companion to `decode-failure`.
 *
 * Two flags from the same event decide whether the reading means anything:
 *   external_power_source     device is mains-powered; its battery number is meaningless
 *   battery_level_unavailable device cannot measure its battery
 * Both are respected rather than thresholded, so a mains-powered node does not generate
 * a permanent alert.
 *
 * ── windows ─────────────────────────────────────────────────────────────────────
 * Status events are *rare* — they arrive on the profile's DevStatusReq interval, often
 * daily or less. A real store had 38 status rows against 9,195 uplinks for the same
 * device. `lookbackHours` therefore defaults to two weeks; a 24-hour window would
 * usually find nothing and the check would look broken.
 *
 * Note also that some devices report a *static* battery percentage (one real device sat
 * at exactly 39.37 % across every reading, another at 100 %). Do not point
 * `measurement-stuck` at this field — an unchanging value here is common and normal.
 */

import { num, optNum, round } from '../params';
import { resolveScope, scopeClause, SCOPE_PARAMS } from '../scope';
import type { Finding, Rule } from '../types';

interface Row {
  dev_eui: string;
  device_name: string | null;
  battery_level: string;
  at: string;
  readings: string;
}

const rule: Rule = {
  id: 'status-battery-low',
  description:
    'Flags devices whose MAC-layer battery percentage (event_status, from DevStatusAns) ' +
    'is below threshold. Independent of the payload codec, so it still reports on a ' +
    'device whose decoding is broken — the companion to decode-failure.',
  defaultSeverity: 'warning',
  defaultParams: {
    /** Raise at or below this percentage. */
    raiseAtPercent: 20,
    /** Hold the alert open until it recovers past this. Must be >= raiseAtPercent. */
    clearAtPercent: 25,
    /** Escalate to critical at or below this. null disables escalation. */
    criticalAtPercent: 10,
    /**
     * Status events are infrequent — driven by the device profile's DevStatusReq
     * interval, often daily. Two weeks by default so the check has something to read.
     */
    lookbackHours: 336,
    /**
     * Skip devices reporting external_power_source. A mains-powered node's battery
     * figure is meaningless and would alert forever.
     */
    ignoreExternalPower: true,
  },
  requires: [
    {
      table: 'event_status',
      columns: [
        'dev_eui', 'device_name', 'time',
        'battery_level', 'battery_level_unavailable', 'external_power_source',
      ],
    },
  ],

  async run(ctx): Promise<Finding[]> {
    const raiseAt = num(ctx.params, 'raiseAtPercent');
    const clearAt = num(ctx.params, 'clearAtPercent');
    const criticalAt = optNum(ctx.params, 'criticalAtPercent');
    const lookbackHours = num(ctx.params, 'lookbackHours');
    const ignoreExternal = ctx.params.ignoreExternalPower !== false;

    if (clearAt < raiseAt) {
      throw new Error(
        `clearAtPercent (${clearAt}) must be >= raiseAtPercent (${raiseAt}); a clear ` +
          'threshold below the raise threshold defeats the hysteresis',
      );
    }
    if (criticalAt !== null && criticalAt > raiseAt) {
      throw new Error(
        `criticalAtPercent (${criticalAt}) must be <= raiseAtPercent (${raiseAt})`,
      );
    }

    const sc = scopeClause(resolveScope(ctx.params), 4);

    // Fetch everything at or below the *clear* threshold: that covers new breaches and
    // devices still recovering. The raise/clear decision is made per device below.
    const rows = await ctx.query<Row>(
      `SELECT DISTINCT ON (dev_eui)
              dev_eui,
              device_name,
              battery_level,
              time     AS at,
              count(*) OVER (PARTITION BY dev_eui) AS readings
         FROM event_status
        WHERE time > now() - make_interval(hours => $1::int)
          AND battery_level IS NOT NULL
          -- The device told us the number is not usable; believe it.
          AND battery_level_unavailable IS NOT TRUE
          AND ($2::boolean IS NOT TRUE OR external_power_source IS NOT TRUE)
          AND battery_level <= $3::real
          ${sc.sql}
        ORDER BY dev_eui, time DESC`,
      [Math.round(lookbackHours), ignoreExternal, clearAt, ...sc.values],
    );

    const findings: Finding[] = [];

    for (const row of rows) {
      const pct = Number(row.battery_level);
      // Devices already in breach are held against the looser clear threshold.
      const limit = ctx.openDevEuis.has(row.dev_eui) ? clearAt : raiseAt;
      if (pct > limit) continue;

      const name = row.device_name ?? row.dev_eui;
      findings.push({
        devEui: row.dev_eui,
        deviceName: row.device_name,
        summary:
          `${name} battery ${round(pct, 1)}% (MAC-layer status; raise <=${raiseAt}%, ` +
          `clear >${clearAt}%)`,
        severity: criticalAt !== null && pct <= criticalAt ? 'critical' : undefined,
        detail: {
          source: 'event_status.battery_level',
          batteryPercent: round(pct, 2),
          raiseAtPercent: raiseAt,
          clearAtPercent: clearAt,
          criticalAtPercent: criticalAt,
          statusReadingsInWindow: Number(row.readings),
          readingAt: row.at,
          lookbackHours,
        },
      });
    }

    return findings;
  },
};

export default rule;
