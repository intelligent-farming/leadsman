/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * join-churn — the device keeps rejoining the network.
 *
 * A healthy OTAA device joins once and then runs for months on that session. Repeated
 * joins mean the session keeps being lost, and every rejoin is expensive:
 *
 *   - The session resets, so queued downlinks are discarded — an actuator command
 *     silently disappears
 *   - ADR history is lost, so the device restarts at its slowest data rate, burning
 *     battery and airtime until it re-converges
 *   - A new DevAddr is issued each time, which breaks anything keyed on DevAddr
 *
 * Common causes, roughly in order of how often they turn out to be the answer: the device
 * is power-cycling (flat battery, loose terminal, watchdog reset); it cannot hear the
 * join-accept, so it retries forever while the network thinks it joined (see
 * `status-margin-low`); a frame-counter or key mismatch after the device was
 * re-provisioned elsewhere; or a duplicate DevEUI, with two units fighting over one
 * identity.
 *
 * The tell that distinguishes churn from a normal deployment burst is the ratio of joins
 * to uplinks. A device that joins nine times and delivers seven uplinks is not
 * commissioning — it is failing. That pattern showed up on a real store, and no other
 * check in this engine could see it: `device-silent` was quiet because uplinks were
 * arriving, and `decode-failure` only saw the payload problem.
 */
import type { Rule } from '../types';
declare const rule: Rule;
export default rule;
//# sourceMappingURL=join-churn.d.ts.map