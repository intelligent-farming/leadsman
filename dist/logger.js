"use strict";
/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Minimal leveled logger. Emits one JSON object per line when LEADSMAN_LOG_FORMAT
 * is `json` (the default in a container, where something else does the parsing),
 * and a compact human line otherwise.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLogger = createLogger;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function normalizeLevel(value) {
    const v = (value ?? 'info').toLowerCase();
    return v in LEVELS ? v : 'info';
}
function createLogger(options = {}) {
    const threshold = LEVELS[normalizeLevel(options.level ?? process.env.LEADSMAN_LOG_LEVEL)];
    const format = options.format ?? (process.env.LEADSMAN_LOG_FORMAT === 'text' ? 'text' : 'json');
    const bindings = options.bindings ?? {};
    function emit(level, msg, meta) {
        if (LEVELS[level] < threshold)
            return;
        const record = { ts: new Date().toISOString(), level, msg, ...bindings, ...meta };
        const stream = LEVELS[level] >= LEVELS.error ? process.stderr : process.stdout;
        if (format === 'json') {
            stream.write(`${JSON.stringify(record)}\n`);
            return;
        }
        const extras = { ...bindings, ...meta };
        const tail = Object.keys(extras).length
            ? ' ' +
                Object.entries(extras)
                    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
                    .join(' ')
            : '';
        stream.write(`${record.ts} ${level.toUpperCase().padEnd(5)} ${msg}${tail}\n`);
    }
    return {
        debug: (msg, meta) => emit('debug', msg, meta),
        info: (msg, meta) => emit('info', msg, meta),
        warn: (msg, meta) => emit('warn', msg, meta),
        error: (msg, meta) => emit('error', msg, meta),
        child(extra) {
            return createLogger({
                level: options.level ?? process.env.LEADSMAN_LOG_LEVEL,
                format,
                bindings: { ...bindings, ...extra },
            });
        },
    };
}
//# sourceMappingURL=logger.js.map