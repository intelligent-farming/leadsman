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
import type { Rule } from '../types';
declare const rule: Rule;
export default rule;
//# sourceMappingURL=measurement-stuck.d.ts.map