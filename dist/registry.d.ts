/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Check discovery.
 *
 * Every module in the rules directory that default-exports a Rule becomes an
 * available check. The config file then picks from what is discovered, which is
 * what makes this a menu rather than a fixed pipeline: adding a check is dropping
 * in a file, and enabling it is one line of JSON.
 *
 * A second directory can be supplied via LEADSMAN_RULES_DIR (or --rules-dir) so
 * deployment-specific checks live outside this repo and survive upgrades. Local
 * checks override built-ins of the same id.
 */
import type { Rule } from './types';
export declare class RuleLoadError extends Error {
    constructor(message: string);
}
export interface LoadRulesOptions {
    /** Extra directory of operator-supplied checks. Overrides built-ins by id. */
    extraDir?: string | null;
}
/** All available checks, keyed by id. */
export declare function loadRules(options?: LoadRulesOptions): Map<string, Rule>;
//# sourceMappingURL=registry.d.ts.map