/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * boolean-alarm — a flag in the telemetry is asserted.
 *
 * The vocabulary has a cluster of boolean and enum states that mean "something has
 * happened" rather than "here is a number":
 *
 *   water.leak                 a leak detector tripped
 *   air.gasAlarm               gas detected / abnormal
 *   action.smoke.detected      smoke detector tripped
 *   action.motion.detected     motion where there should be none
 *   action.switch.state        a switch or relay changed
 *   action.occupancy.occupied  space occupied
 *   action.button.pressed      a panic or acknowledge button
 *   action.contactState        "open" / "closed" — a gate or hatch
 *
 * Codecs express truth inconsistently even after normalization, because the
 * vocabulary allows `additionalProperties` and vendor codecs differ: `true`, `"true"`,
 * `1`, and `"open"` all occur. `trueValues` is therefore configurable, and matching
 * is case-insensitive.
 *
 * The alert clears when the flag reads false again, so a leak detector that trips and
 * is then dried out resolves on its own — while a detector that stays wet keeps one
 * open alert rather than notifying on every uplink.
 */
import type { Rule } from '../types';
declare const rule: Rule;
export default rule;
//# sourceMappingURL=boolean-alarm.d.ts.map