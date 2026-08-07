/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * measurement-rate — the value is changing too fast, in either direction.
 *
 * Thresholds catch a bad state; this catches a bad trajectory, often hours earlier.
 * The value can be comfortably inside its bounds and still be heading somewhere
 * expensive:
 *
 *   - A tank falling 8 %/hour is a leak or an open valve; at 40 % it is still
 *     "fine" by any threshold, and by morning it is dry.
 *   - Soil moisture dropping fast after irrigation means the water went somewhere
 *     other than the root zone.
 *   - Air temperature falling 3 °C/hour at dusk is the shape of a frost event
 *     before the temperature itself is alarming.
 *   - A dendrometer or sap-flow reading collapsing indicates plant stress.
 *
 * Rate is computed as (last - first) / hours across the window, so it is an average
 * slope rather than an instantaneous derivative. That is deliberate: LoRaWAN
 * sampling is sparse and irregular, and a slope over several samples is far less
 * jumpy than a difference between two adjacent uplinks.
 */
import type { Rule } from '../types';
declare const rule: Rule;
export default rule;
//# sourceMappingURL=measurement-rate.d.ts.map