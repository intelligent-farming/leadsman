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
import type { Rule } from '../types';
declare const rule: Rule;
export default rule;
//# sourceMappingURL=status-battery-low.d.ts.map