/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Config file loading and validation.
 *
 * The config selects which checks run and with what parameters — it is the
 * "pick from the menu" surface. It deliberately holds no credentials: the database
 * URL comes from LEADSMAN_DATABASE_URL and the webhook token from
 * LEADSMAN_WEBHOOK_TOKEN, so the config file is safe to commit and diff.
 */
import type { LeadsmanConfig } from './types';
export declare class ConfigError extends Error {
    constructor(message: string);
}
/** Parse and validate a config object. Throws ConfigError with a usable message. */
export declare function parseConfig(raw: unknown): LeadsmanConfig;
/** Read and validate a config file from disk. */
export declare function loadConfig(path: string): LeadsmanConfig;
/** Connection string for the engine's own role. */
export declare function databaseUrlFromEnv(): string;
//# sourceMappingURL=config.d.ts.map