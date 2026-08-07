/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * measurement-threshold — min/max bound on the latest reading, resolved across
 * several candidate vocabulary paths.
 *
 * The workhorse. `paths` is a priority-ordered list, and per device the first path
 * actually present in that device's telemetry is used. Devices carrying none of the
 * candidates are ignored — so one entry safely covers a mixed fleet.
 *
 * That matters because the normalized vocabulary spreads one concept across several
 * paths. A frost check has to look at `temperature`, `air.temperature`,
 * `leaf.temperature`, and `water.temperature.current`, because which one a device
 * emits depends on what kind of sensor it is:
 *
 *   { "rule": "measurement-threshold", "as": "frost-risk", "severity": "critical",
 *     "params": { "paths": ["air.temperature", "temperature", "leaf.temperature"],
 *                 "min": 1.5, "unit": "C" } }
 *
 * Units are guaranteed by normalization (°C, %, m/s, hPa, …), so thresholds mean
 * the same thing on every vendor's hardware. See docs/vocabulary.md.
 */
import type { Rule } from '../types';
declare const rule: Rule;
export default rule;
//# sourceMappingURL=measurement-threshold.d.ts.map