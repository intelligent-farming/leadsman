/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Minimal leveled logger. Emits one JSON object per line when LEADSMAN_LOG_FORMAT
 * is `json` (the default in a container, where something else does the parsing),
 * and a compact human line otherwise.
 */
import type { Logger } from './types';
export interface LoggerOptions {
    level?: string;
    format?: 'json' | 'text';
    /** Merged into every line — used to tag output with the current check. */
    bindings?: Record<string, unknown>;
}
export declare function createLogger(options?: LoggerOptions): Logger & {
    child(bindings: Record<string, unknown>): Logger & {
        child: unknown;
    };
};
//# sourceMappingURL=logger.d.ts.map