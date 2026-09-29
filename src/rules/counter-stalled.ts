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
 *
 * Both questions are asked of every STEP in the window, not of its endpoints. A
 * mid-window reset such as 1000 → 0 → 500 → 1100 → 1100.5 has last − first = +100.5,
 * which compared endpoints only would read as a healthy, advancing meter — hiding the
 * reset and the fact that the meter has advanced by 0.5 since it reached 1100. So:
 *
 *   - any step down is a decrease, reported with the largest drop and when it landed;
 *   - the advance is the sum of the positive steps (see src/counter.ts), so a reset
 *     can neither fake an advance nor hide one. That is what the stall test uses when
 *     `alertOnDecrease` is off; when it is on, a window containing a decrease reports
 *     the decrease instead — one finding per device, and the corrupted series is the
 *     more urgent of the two.
 */

import { int, num, round } from '../params';
import { counterWindows } from '../counter';
import { pathsLabel, resolvePaths } from '../measurement';
import { resolveScope, SCOPE_PARAMS } from '../scope';
import type { Finding, Rule } from '../types';

const rule: Rule = {
  id: 'counter-stalled',
  description:
    'Flags monotonic totals (water, energy, pulses, runtime) that failed to advance ' +
    'by a minimum amount over the window, or that stepped backwards at any point in it. ' +
    'Enable only where consumption is genuinely expected — an idle meter is not a fault.',
  defaultSeverity: 'warning',
  /** Generic: a monotonic counter that stopped advancing.
   */
  defaultRouting: 'fact',
  defaultParams: {
    /** Priority-ordered candidate vocabulary paths holding the total. */
    paths: ['metering.water.total', 'pulse.total'],
    /** Window over which the advance is measured. */
    lookbackHours: 12,
    /**
     * Alert if the total advanced by less than this over the window. The advance is the
     * sum of the upward steps, so a reset inside the window does not count against it.
     */
    minAdvance: 1,
    /** Need at least this many readings before concluding anything. */
    minSamples: 4,
    /**
     * Also alert when the total decreases at any step in the window — a meter reset,
     * swap, or rollover — even if it has since climbed back above where it started.
     */
    alertOnDecrease: true,
    /** Narrow this check to part of the fleet — see src/scope.ts. */
    ...SCOPE_PARAMS,
  },
  requires: [
    { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
  ],

  async run(ctx): Promise<Finding[]> {
    const paths = resolvePaths(ctx.params, 'paths');
    const lookbackHours = int(ctx.params, 'lookbackHours');
    const minAdvance = num(ctx.params, 'minAdvance');
    const minSamples = int(ctx.params, 'minSamples');
    const alertOnDecrease = ctx.params.alertOnDecrease !== false;

    if (minAdvance < 0) throw new Error('minAdvance must not be negative');

    const scope = resolveScope(ctx.params);
    const stats = await counterWindows(ctx, paths, lookbackHours, scope);
    if (stats.length === 0) {
      ctx.log.debug('no device reports any candidate path', { paths: pathsLabel(paths) });
      return [];
    }

    const findings: Finding[] = [];

    for (const s of stats) {
      if (s.samples < minSamples) continue;

      const advance = s.rise;
      const name = s.deviceName ?? s.devEui;

      if (s.drops > 0 && alertOnDecrease) {
        findings.push({
          devEui: s.devEui,
          deviceName: s.deviceName,
          summary:
            `${name} ${s.matchedPath} went backwards: ${round(s.dropFrom ?? 0, 2)} → ` +
            `${round(s.dropTo ?? 0, 2)}` +
            (s.drops > 1 ? ` (largest of ${s.drops} drops)` : '') +
            ' — meter reset, replacement, or rollover',
          // A silently corrupted consumption series is worse than a stalled one.
          severity: 'critical',
          detail: {
            measurement: s.matchedPath,
            reason: 'decrease',
            dropFrom: round(s.dropFrom ?? 0, 3),
            dropTo: round(s.dropTo ?? 0, 3),
            dropAt: s.dropAt,
            maxDrop: round(s.maxDrop, 3),
            drops: s.drops,
            firstValue: round(s.first, 3),
            lastValue: round(s.last, 3),
            // Kept for continuity with earlier alerts: the endpoint difference. It can
            // be positive here — that is exactly the case endpoint-only comparison missed.
            delta: round(s.last - s.first, 3),
            advance: round(advance, 3),
            samples: s.samples,
            candidatePaths: pathsLabel(paths),
            firstAt: s.firstAt,
            lastAt: s.lastAt,
          },
        });
        continue;
      }

      if (advance >= minAdvance) continue;

      findings.push({
        devEui: s.devEui,
        deviceName: s.deviceName,
        summary:
          `${name} ${s.matchedPath} advanced only ${round(advance, 2)} in ` +
          `${lookbackHours}h (expected at least ${minAdvance})`,
        detail: {
          measurement: s.matchedPath,
          reason: 'stalled',
          advance: round(advance, 3),
          minAdvance,
          firstValue: round(s.first, 3),
          lastValue: round(s.last, 3),
          // Non-zero only with alertOnDecrease off: the advance above already ignores
          // them, and saying so explains why it differs from last − first.
          drops: s.drops,
          samples: s.samples,
          lookbackHours,
          candidatePaths: pathsLabel(paths),
          firstAt: s.firstAt,
          lastAt: s.lastAt,
        },
      });
    }

    return findings;
  },
};

export default rule;
