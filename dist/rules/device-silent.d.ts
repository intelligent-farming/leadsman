/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * device-silent — a device that was reporting has stopped.
 *
 * This is the check an uplink-driven rule engine structurally cannot do: you
 * cannot trigger on the absence of a message. It needs a periodic sounding, which
 * is the main reason Leadsman runs on a schedule at all.
 *
 * The device inventory is derived from the event store itself — any DevEUI seen
 * within `inventoryHours` is considered in service. That avoids maintaining a
 * separate device list, at the cost of eventually forgetting a device that has
 * been silent longer than the inventory window (by then it is decommissioned or
 * someone has already noticed).
 */
import type { Rule } from '../types';
declare const rule: Rule;
export default rule;
//# sourceMappingURL=device-silent.d.ts.map