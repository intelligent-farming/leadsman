/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Minimal leveled logger. Emits one JSON object per line when LEADSMAN_LOG_FORMAT
 * is `json` (the default in a container, where something else does the parsing),
 * and a compact human line otherwise.
 */

import type { Logger } from './types';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

function normalizeLevel(value: string | undefined): Level {
  const v = (value ?? 'info').toLowerCase();
  return v in LEVELS ? (v as Level) : 'info';
}

export interface LoggerOptions {
  level?: string;
  format?: 'json' | 'text';
  /** Merged into every line — used to tag output with the current check. */
  bindings?: Record<string, unknown>;
}

export function createLogger(options: LoggerOptions = {}): Logger & {
  child(bindings: Record<string, unknown>): Logger & { child: unknown };
} {
  const threshold = LEVELS[normalizeLevel(options.level ?? process.env.LEADSMAN_LOG_LEVEL)];
  const format =
    options.format ?? (process.env.LEADSMAN_LOG_FORMAT === 'text' ? 'text' : 'json');
  const bindings = options.bindings ?? {};

  function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
    if (LEVELS[level] < threshold) return;
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
    child(extra: Record<string, unknown>) {
      return createLogger({
        level: options.level ?? process.env.LEADSMAN_LOG_LEVEL,
        format,
        bindings: { ...bindings, ...extra },
      });
    },
  };
}
