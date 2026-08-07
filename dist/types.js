"use strict";
/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * The contract between the engine and a check script.
 *
 * A check is a stateless predicate over current telemetry: given a database it
 * can read and some parameters, return the devices that are *currently* in
 * breach. It does not decide whether that is new, whether anyone has been told,
 * or when to stop caring — the engine reconciles findings against open alerts and
 * owns the raise/resolve lifecycle. Keeping checks stateless is what makes them
 * safe to add, remove, and reorder from a config file.
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=types.js.map