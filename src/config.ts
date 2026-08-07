/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Config file loading and validation.
 *
 * The config selects which checks run and with what parameters — it is the
 * "pick from the menu" surface. It deliberately holds no credentials, and nothing
 * host-specific: the database URL comes from LEADSMAN_DATABASE_URL, and every part of
 * the notification seam can come from the environment too —
 *
 *   LEADSMAN_WEBHOOK_URL           overrides notify.webhookUrl
 *   LEADSMAN_WEBHOOK_AUTH          overrides notify.webhookAuth  (hmac|token|bearer)
 *   LEADSMAN_WEBHOOK_TOKEN_HEADER  overrides notify.webhookTokenHeader
 *   LEADSMAN_WEBHOOK_TOKEN         the secret — env only, never the file
 *
 * Env wins over the file. That split is what keeps the config file identical across
 * every install and safe to commit and diff: it describes *what* to watch, while where
 * alerts go is a property of the host it runs on. An empty environment variable counts
 * as unset, so a blank `VAR=` in a .env is not mistaken for a value.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CheckConfig, LeadsmanConfig, Severity } from './types';

const SEVERITIES: readonly Severity[] = ['info', 'warning', 'critical'];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULTS = {
  schedule: '*/15 * * * *',
  timezone: 'UTC',
  statementTimeoutMs: 15_000,
  maxChecksPerRun: 64,
} as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parse and validate a config object. Throws ConfigError with a usable message. */
export function parseConfig(raw: unknown): LeadsmanConfig {
  if (!isPlainObject(raw)) throw new ConfigError('config root must be a JSON object');

  const checksRaw = raw.checks;
  if (!Array.isArray(checksRaw)) {
    throw new ConfigError('config.checks must be an array (use [] to disable everything)');
  }

  const checks: CheckConfig[] = [];
  const seenKinds = new Set<string>();

  checksRaw.forEach((entry, i) => {
    const at = `config.checks[${i}]`;
    if (!isPlainObject(entry)) throw new ConfigError(`${at} must be an object`);

    // Comment-only entries act as section headers in the shipped menu config, which
    // is long enough to need them. JSON has no comment syntax, so an object whose
    // only keys start with "//" is treated as annotation and skipped.
    const keys = Object.keys(entry);
    if (keys.length > 0 && keys.every((k) => k.startsWith('//'))) return;

    const rule = entry.rule;
    if (typeof rule !== 'string' || rule.length === 0) {
      throw new ConfigError(`${at}.rule must be a non-empty string`);
    }

    const kind = entry.as === undefined ? rule : entry.as;
    if (typeof kind !== 'string' || kind.length === 0) {
      throw new ConfigError(`${at}.as must be a non-empty string when present`);
    }
    // Kinds land in a unique index and in alert payloads; keep them predictable.
    if (!/^[a-z0-9][a-z0-9-]*$/.test(kind)) {
      throw new ConfigError(
        `${at}.as ("${kind}") must be lowercase alphanumeric with hyphens`,
      );
    }
    if (seenKinds.has(kind)) {
      throw new ConfigError(
        `${at}: duplicate check name "${kind}" — set a distinct "as" for each ` +
          `instance of the same rule, otherwise their alerts collide`,
      );
    }
    seenKinds.add(kind);

    if (entry.severity !== undefined && !SEVERITIES.includes(entry.severity as Severity)) {
      throw new ConfigError(
        `${at}.severity must be one of ${SEVERITIES.join(', ')}`,
      );
    }
    if (entry.params !== undefined && !isPlainObject(entry.params)) {
      throw new ConfigError(`${at}.params must be an object`);
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      throw new ConfigError(`${at}.enabled must be a boolean`);
    }

    checks.push({
      rule,
      as: kind,
      enabled: entry.enabled !== false, // absent means enabled
      severity: entry.severity as Severity | undefined,
      params: (entry.params as Record<string, unknown>) ?? {},
    });
  });

  const schedule = raw.schedule ?? DEFAULTS.schedule;
  if (typeof schedule !== 'string' || schedule.trim().length === 0) {
    throw new ConfigError('config.schedule must be a cron expression string');
  }

  const timezone = raw.timezone ?? DEFAULTS.timezone;
  if (typeof timezone !== 'string') throw new ConfigError('config.timezone must be a string');

  const statementTimeoutMs = raw.statementTimeoutMs ?? DEFAULTS.statementTimeoutMs;
  if (typeof statementTimeoutMs !== 'number' || statementTimeoutMs <= 0) {
    throw new ConfigError('config.statementTimeoutMs must be a positive number');
  }

  const maxChecksPerRun = raw.maxChecksPerRun ?? DEFAULTS.maxChecksPerRun;
  if (typeof maxChecksPerRun !== 'number' || maxChecksPerRun <= 0) {
    throw new ConfigError('config.maxChecksPerRun must be a positive number');
  }

  // ── notify ──────────────────────────────────────────────────────────────────
  // Where alerts go is a deployment fact, not check policy: the same config file is
  // meant to describe *what* to watch across every install, while the receiver's
  // address changes per host. So the whole of `notify` can come from the environment
  // and env wins over the file — which lets an orchestrator (docker compose, systemd,
  // Kubernetes) point the engine at a receiver without rewriting a mounted file.
  //
  // Empty string counts as unset. `LEADSMAN_WEBHOOK_URL=` in a .env arrives as "",
  // and treating that as a configured value would fail URL validation and take the
  // whole engine down over a blank line.
  const envStr = (name: string): string | undefined => {
    const v = process.env[name];
    return v !== undefined && v.trim() !== '' ? v.trim() : undefined;
  };
  const envUrl = envStr('LEADSMAN_WEBHOOK_URL');
  const envAuth = envStr('LEADSMAN_WEBHOOK_AUTH');
  const envTokenHeader = envStr('LEADSMAN_WEBHOOK_TOKEN_HEADER');

  let notify: LeadsmanConfig['notify'];
  if (raw.notify !== undefined || envUrl !== undefined) {
    if (raw.notify !== undefined && !isPlainObject(raw.notify)) {
      throw new ConfigError('config.notify must be an object');
    }
    const rawNotify: Record<string, unknown> = isPlainObject(raw.notify) ? raw.notify : {};

    const fileUrl = rawNotify.webhookUrl ?? null;
    if (fileUrl !== null && typeof fileUrl !== 'string') {
      throw new ConfigError('config.notify.webhookUrl must be a string or null');
    }
    const url = envUrl ?? fileUrl;
    if (typeof url === 'string') {
      try {
        new URL(url);
      } catch {
        throw new ConfigError(
          envUrl !== undefined
            ? `LEADSMAN_WEBHOOK_URL is not a valid URL: ${url}`
            : `config.notify.webhookUrl is not a valid URL: ${url}`,
        );
      }
    }

    const auth = envAuth ?? rawNotify.webhookAuth ?? 'bearer';
    if (auth !== 'hmac' && auth !== 'token' && auth !== 'bearer') {
      throw new ConfigError(
        `${envAuth !== undefined ? 'LEADSMAN_WEBHOOK_AUTH' : 'config.notify.webhookAuth'} ` +
          `must be "hmac", "token", or "bearer" (got ${JSON.stringify(auth)})`,
      );
    }

    const fileTokenHeader = rawNotify.webhookTokenHeader ?? null;
    if (fileTokenHeader !== null && typeof fileTokenHeader !== 'string') {
      throw new ConfigError('config.notify.webhookTokenHeader must be a string or null');
    }
    const tokenHeader = envTokenHeader ?? fileTokenHeader;

    notify = {
      webhookUrl: url,
      // Secret comes from the environment only, never the config file.
      webhookToken: envStr('LEADSMAN_WEBHOOK_TOKEN') ?? null,
      webhookAuth: auth,
      webhookTokenHeader: tokenHeader,
      timeoutMs:
        typeof rawNotify.timeoutMs === 'number' ? rawNotify.timeoutMs : 5_000,
    };
  }

  const enabledCount = checks.filter((c) => c.enabled).length;
  if (enabledCount > maxChecksPerRun) {
    throw new ConfigError(
      `${enabledCount} checks enabled but maxChecksPerRun is ${maxChecksPerRun}`,
    );
  }

  return { schedule, timezone, statementTimeoutMs, maxChecksPerRun, notify, checks };
}

/** Read and validate a config file from disk. */
export function loadConfig(path: string): LeadsmanConfig {
  const full = resolve(path);
  let text: string;
  try {
    text = readFileSync(full, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `cannot read config at ${full}: ${(err as Error).message}`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${full} is not valid JSON: ${(err as Error).message}`);
  }

  return parseConfig(raw);
}

/** Connection string for the engine's own role. */
export function databaseUrlFromEnv(): string {
  const url = process.env.LEADSMAN_DATABASE_URL;
  if (!url) {
    throw new ConfigError(
      'LEADSMAN_DATABASE_URL is not set — expected a Postgres URL for the ' +
        'leadsman role, e.g. postgres://leadsman:...@events-postgres:5432/chirpstack_events',
    );
  }
  return url;
}
