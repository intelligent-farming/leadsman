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
import type { Rule } from '../types';
declare const rule: Rule;
export default rule;
//# sourceMappingURL=measurement-peak.d.ts.map