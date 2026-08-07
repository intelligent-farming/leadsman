/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * measurement-missing — a device that used to report a field has stopped, while its
 * uplinks keep arriving and decoding.
 *
 * `decode-failure` catches a codec producing nothing at all. This catches the subtler
 * case where the codec still decodes but a field has silently disappeared from the
 * output. Causes worth knowing about:
 *
 *   - A device profile re-provisioned with a different (or upstream, non-normalized)
 *     codec, so `soil.moisture` became `moisture` and every check on it went quiet.
 *   - A codec-version rollback that dropped a measurement.
 *   - A multi-probe node where one probe was unplugged and its field vanished
 *     rather than reading zero.
 *   - Firmware changing the payload so one sensor block no longer parses.
 *
 * This is the failure mode that makes an entire monitoring config quietly useless:
 * every check on the missing field simply stops matching that device, and — because
 * checks ignore devices that report none of their candidate paths — nothing fires.
 * Silence looks identical to health.
 *
 * The check works by comparison against the device's own history: it only considers
 * devices that reported one of the paths earlier in `lookbackHours`, and alerts when
 * they have uplinks in `recentHours` but none carrying the field.
 */
import type { Rule } from '../types';
declare const rule: Rule;
export default rule;
//# sourceMappingURL=measurement-missing.d.ts.map