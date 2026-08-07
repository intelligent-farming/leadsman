/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * decode-failure — uplinks are arriving but the payload codec is not decoding them.
 *
 * ChirpStack decodes server-side: the device profile's codec runs at ingest, and the
 * uplink event's `object` column holds the result. When `object` is NULL or empty,
 * the radio link is fine and the device is transmitting — but the measurement is
 * being thrown away.
 *
 * This is the failure mode that looks like nothing is wrong. Threshold checks stay
 * quiet because there is no value to compare, and device-silent stays quiet because
 * uplinks are still arriving. Without this check, a device profile provisioned with
 * a missing or broken codec can log data-free uplinks for months.
 *
 * Common causes: device onboarded before its codec existed, a codec-version rollback
 * that lost the decoder, or a firmware change altering the payload format.
 */
import type { Rule } from '../types';
declare const rule: Rule;
export default rule;
//# sourceMappingURL=decode-failure.d.ts.map