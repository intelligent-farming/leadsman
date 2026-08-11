/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Config file loading and validation.
 *
 * The config selects which checks run and with what parameters — it is the
 * "pick from the menu" surface. It deliberately holds no credentials, and nothing
 * host-specific. The database URL comes from LEADSMAN_DATABASE_URL, and every part of a
 * delivery destination can be overridden per destination from the environment:
 *
 *   LEADSMAN_DEST_<NAME>_PROVIDER     webhook | twilio | telegram | signal
 *   LEADSMAN_DEST_<NAME>_TO           recipients, comma-separated E.164
 *   LEADSMAN_DEST_<NAME>_CHAT_ID      Telegram chat id
 *   LEADSMAN_DEST_<NAME>_WEBHOOK_URL  webhook target
 *   LEADSMAN_WEBHOOK_TOKEN_<NAME>     that destination's secret
 *   LEADSMAN_WEBHOOK_TOKEN            shared-secret fallback for all of them
 *   LEADSMAN_TWILIO_*  ACCOUNT_SID + API_KEY_SID + API_KEY_SECRET + FROM
 *   LEADSMAN_TELEGRAM_* / _SIGNAL_*               other provider credentials
 *
 * NAME is the destination name upper-cased with hyphens as underscores. Env wins over the
 * file, which is what keeps the config identical across installs and safe to commit: it
 * describes *what* to watch, while where alerts go is a property of the host. An empty
 * environment variable counts as unset, so a blank `VAR=` in a .env is not mistaken for a
 * value.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  CheckConfig,
  LeadsmanConfig,
  MessagingCredentials,
  NotifyConfig,
  NotifyDestination,
  NotifyProvider,
  Severity,
} from './types';

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

    if (entry.notifyTo !== undefined && typeof entry.notifyTo !== 'string') {
      throw new ConfigError(`${at}.notifyTo must be a destination name string`);
    }

    checks.push({
      rule,
      as: kind,
      notifyTo: entry.notifyTo as string | undefined,
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
  // Empty string counts as unset. A blank `VAR=` in a .env arrives as "", and treating
  // that as a configured value would fail validation and take the whole engine down over a
  // blank line.
  const envStr = (name: string): string | undefined => {
    const v = process.env[name];
    return v !== undefined && v.trim() !== '' ? v.trim() : undefined;
  };

  let notify: LeadsmanConfig['notify'];
  if (raw.notify !== undefined) {
    if (!isPlainObject(raw.notify)) {
      throw new ConfigError('config.notify must be an object');
    }
    const rawNotify: Record<string, unknown> = raw.notify;

    // Exactly one way to describe delivery: named destinations. Two ways would mean one of
    // them can be set, look configured, and quietly lose to the other.
    if (rawNotify.destinations === undefined) {
      throw new ConfigError(
        'config.notify.destinations is required — name your delivery targets, e.g. ' +
          '{"destinations": {"sms": {"provider": "twilio", "to": ["+15125550123"]}}, ' +
          '"routing": {"fact": "sms"}}. Omit `notify` entirely to record alerts without ' +
          'delivering them.',
      );
    }
    for (const dead of ['webhookUrl', 'webhookAuth', 'webhookTokenHeader']) {
      if (dead in rawNotify) {
        throw new ConfigError(
          `config.notify.${dead} is no longer supported — move it into ` +
            `notify.destinations.<name>.${dead}`,
        );
      }
    }

    const defaultTimeout =
      typeof rawNotify.timeoutMs === 'number' ? rawNotify.timeoutMs : 5_000;

    // ── named destinations ────────────────────────────────────────────────────
    // Absent, everything below stays undefined and delivery behaves exactly as it did
    // before: one URL, every alert. That is what keeps existing deployments working.
    const destinations: Record<string, NotifyDestination> = {};
    {
      if (!isPlainObject(rawNotify.destinations)) {
        throw new ConfigError('config.notify.destinations must be an object of name → target');
      }
      for (const [name, raw] of Object.entries(rawNotify.destinations)) {
        const at = `config.notify.destinations.${name}`;
        // Destination names appear in env var names, so keep them predictable.
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
          throw new ConfigError(`${at}: name must be lowercase alphanumeric with hyphens`);
        }
        if (!isPlainObject(raw)) throw new ConfigError(`${at} must be an object`);

        // Per-destination env overrides, so an operator can switch a destination from
        // Twilio to Telegram, or change who gets paged, without editing a mounted file.
        // LEADSMAN_DEST_<NAME>_* with hyphens in the name becoming underscores.
        const envPrefix = `LEADSMAN_DEST_${name.toUpperCase().replace(/-/g, '_')}`;
        const provider = (envStr(`${envPrefix}_PROVIDER`) ?? raw.provider ?? 'webhook') as
          | NotifyProvider
          | string;
        if (!['webhook', 'twilio', 'telegram', 'signal'].includes(provider)) {
          throw new ConfigError(
            `${at}.provider must be "webhook", "twilio", "telegram", or "signal" ` +
              `(got ${JSON.stringify(provider)})`,
          );
        }

        // Recipients: a comma-separated env list wins over the config array.
        const envTo = envStr(`${envPrefix}_TO`);
        const to = envTo
          ? envTo.split(',').map((s) => s.trim()).filter(Boolean)
          : Array.isArray(raw.to)
            ? raw.to.map(String)
            : undefined;
        const chatId = envStr(`${envPrefix}_CHAT_ID`) ?? (raw.chatId as string | undefined);

        if (provider === 'twilio' || provider === 'signal') {
          if (!to || to.length === 0) {
            throw new ConfigError(
              `${at}: provider "${provider}" needs at least one recipient — set "to": ` +
                `["+15125550123"] or ${envPrefix}_TO`,
            );
          }
          // A number without a country code silently fails to deliver at the carrier, which
          // looks like a Leadsman bug. Catch it here instead.
          //
          // Signal additionally addresses groups by id rather than by number — signal-cli
          // reports them as `group.<base64>` — so those are accepted for `signal` only.
          // Twilio has no such concept, and letting one through there would produce a 21211
          // at send time instead of a clear error here.
          const isNumber = (n: string) => /^\+[1-9]\d{6,15}$/.test(n);
          const isSignalGroup = (n: string) => provider === 'signal' && /^group\.[A-Za-z0-9+/=_-]+$/.test(n);
          const bad = to.filter((n) => !isNumber(n) && !isSignalGroup(n));
          if (bad.length > 0) {
            throw new ConfigError(
              `${at}.to must be E.164 numbers starting with "+" and a country code` +
                (provider === 'signal' ? ', or a Signal group id ("group.…")' : '') +
                ` (bad: ${bad.join(', ')})`,
            );
          }
        }
        if (provider === 'telegram' && !chatId) {
          throw new ConfigError(
            `${at}: provider "telegram" needs "chatId" (or ${envPrefix}_CHAT_ID). Groups and ` +
              'channels are negative, e.g. "-1001234567890"',
          );
        }

        // webhookUrl is required only for the webhook provider.
        const envDestUrl = envStr(`${envPrefix}_WEBHOOK_URL`);
        const destUrl = envDestUrl ?? (raw.webhookUrl as string | undefined);
        if (provider === 'webhook') {
          if (typeof destUrl !== 'string' || destUrl.length === 0) {
            throw new ConfigError(`${at}.webhookUrl must be a non-empty string`);
          }
          try {
            new URL(destUrl);
          } catch {
            throw new ConfigError(`${at}.webhookUrl is not a valid URL: ${destUrl}`);
          }
        }
        const dAuth = raw.webhookAuth ?? 'bearer';
        if (dAuth !== 'hmac' && dAuth !== 'token' && dAuth !== 'bearer') {
          throw new ConfigError(
            `${at}.webhookAuth must be "hmac", "token", or "bearer" (got ${JSON.stringify(dAuth)})`,
          );
        }
        // Per-destination secret, falling back to the shared one so a single token still
        // works across both routes. Hyphens become underscores: destination "on-call" reads
        // LEADSMAN_WEBHOOK_TOKEN_ON_CALL.
        const envName = `LEADSMAN_WEBHOOK_TOKEN_${name.toUpperCase().replace(/-/g, '_')}`;
        destinations[name] = {
          provider: provider as NotifyProvider,
          to,
          chatId,
          webhookUrl: destUrl,
          webhookAuth: dAuth,
          webhookTokenHeader:
            typeof raw.webhookTokenHeader === 'string' ? raw.webhookTokenHeader : null,
          webhookToken: envStr(envName) ?? envStr('LEADSMAN_WEBHOOK_TOKEN') ?? null,
          timeoutMs: typeof raw.timeoutMs === 'number' ? raw.timeoutMs : defaultTimeout,
        };
      }
      if (Object.keys(destinations).length === 0) {
        throw new ConfigError(
          'config.notify.destinations is empty — omit `notify` entirely to record alerts '
            + 'without delivering them',
        );
      }
    }

    // ── provider credentials, from the environment only ───────────────────────
    // Kept out of the config file so a config naming a Twilio destination is still safe to
    // commit and diff — the same reason the database URL and webhook secret live in env.
    const messaging: MessagingCredentials = {};
    const twilioAccount = envStr('LEADSMAN_TWILIO_ACCOUNT_SID');
    const twilioKeySid = envStr('LEADSMAN_TWILIO_API_KEY_SID');
    const twilioKeySecret = envStr('LEADSMAN_TWILIO_API_KEY_SECRET');
    const twilioFrom = envStr('LEADSMAN_TWILIO_FROM');
    if (twilioAccount && twilioKeySid && twilioKeySecret && twilioFrom) {
      messaging.twilio = {
        accountSid: twilioAccount,
        apiKeySid: twilioKeySid,
        apiKeySecret: twilioKeySecret,
        from: twilioFrom,
        baseUrl: envStr('LEADSMAN_TWILIO_BASE_URL') ?? 'https://api.twilio.com',
      };
    }
    const tgToken = envStr('LEADSMAN_TELEGRAM_BOT_TOKEN');
    if (tgToken) {
      messaging.telegram = {
        botToken: tgToken,
        baseUrl: envStr('LEADSMAN_TELEGRAM_BASE_URL') ?? 'https://api.telegram.org',
      };
    }
    const signalBase = envStr('LEADSMAN_SIGNAL_BASE_URL');
    const signalFrom = envStr('LEADSMAN_SIGNAL_FROM');
    if (signalBase && signalFrom) {
      messaging.signal = { baseUrl: signalBase.replace(/\/+$/, ''), from: signalFrom };
    }

    // Fail at config time, not at 3am on the first alert: a destination whose provider has no
    // credentials can never deliver, and its failure would look like a network problem.
    {
      const missing: string[] = [];
      for (const [name, dest] of Object.entries(destinations)) {
        const p = dest.provider ?? 'webhook';
        if (p === 'twilio' && !messaging.twilio) {
          missing.push(
            `"${name}" uses twilio but LEADSMAN_TWILIO_ACCOUNT_SID / _API_KEY_SID / ` +
              '_API_KEY_SECRET / _FROM are not all set. Create an API Key under Twilio ' +
              'Console > Account > API keys & tokens — the Account Auth Token is not used.',
          );
        }
        if (p === 'telegram' && !messaging.telegram) {
          missing.push(`"${name}" uses telegram but LEADSMAN_TELEGRAM_BOT_TOKEN is not set`);
        }
        if (p === 'signal' && !messaging.signal) {
          missing.push(
            `"${name}" uses signal but LEADSMAN_SIGNAL_BASE_URL / _FROM are not both set`,
          );
        }
      }
      if (missing.length > 0) {
        throw new ConfigError(`config.notify.destinations: ${missing.join('; ')}`);
      }
    }

    /** Validate that a routing target names a real destination (null = record-only). */
    const knownTarget = (value: unknown, at: string): string | null => {
      if (value === null) return null;
      if (typeof value !== 'string') {
        throw new ConfigError(`${at} must be a destination name or null`);
      }
      if (!(value in destinations)) {
        const known = Object.keys(destinations).join(', ');
        throw new ConfigError(
          `${at} names destination "${value}", which is not in notify.destinations [${known}]`,
        );
      }
      return value;
    };

    let routing: NotifyConfig['routing'];
    if (rawNotify.routing !== undefined) {
      if (!isPlainObject(rawNotify.routing)) {
        throw new ConfigError('config.notify.routing must be an object');
      }
      routing = {};
      for (const [cls, target] of Object.entries(rawNotify.routing)) {
        if (cls !== 'fact' && cls !== 'situation') {
          throw new ConfigError(
            `config.notify.routing keys must be "fact" or "situation" (got ${JSON.stringify(cls)})`,
          );
        }
        routing[cls] = knownTarget(target, `config.notify.routing.${cls}`);
      }
    }

    let bySeverity: NotifyConfig['bySeverity'];
    if (rawNotify.bySeverity !== undefined) {
      if (!isPlainObject(rawNotify.bySeverity)) {
        throw new ConfigError('config.notify.bySeverity must be an object');
      }
      bySeverity = {};
      for (const [sev, target] of Object.entries(rawNotify.bySeverity)) {
        if (!SEVERITIES.includes(sev as Severity)) {
          throw new ConfigError(
            `config.notify.bySeverity keys must be one of ${SEVERITIES.join(', ')}`,
          );
        }
        bySeverity[sev as Severity] = knownTarget(target, `config.notify.bySeverity.${sev}`);
      }
    }

    const defaultDestination =
      rawNotify.defaultDestination === undefined
        ? null
        : knownTarget(rawNotify.defaultDestination, 'config.notify.defaultDestination');

    // A destinations block with nothing pointing at it delivers nothing, silently. Refuse.
    if (!routing && !bySeverity && defaultDestination === null) {
      throw new ConfigError(
        'config.notify.destinations is set but nothing routes to it — add notify.routing ' +
          '(e.g. {"fact":"sms","situation":"agent"}), notify.defaultDestination, or per-check ' +
          'notifyTo, otherwise no alert would ever be delivered',
      );
    }

    notify = {
      timeoutMs: defaultTimeout,
      destinations,
      routing,
      bySeverity,
      defaultDestination,
      messaging: Object.keys(messaging).length > 0 ? messaging : undefined,
    };
  }

  // Per-check notifyTo must name a real destination too — caught here rather than at 3am.
  if (notify) {
    for (const c of checks) {
      if (c.notifyTo === undefined) continue;
      if (!(c.notifyTo in notify.destinations)) {
        throw new ConfigError(
          `config.checks "${c.as}".notifyTo names destination "${c.notifyTo}", which is not ` +
            `in notify.destinations [${Object.keys(notify.destinations).join(', ')}]`,
        );
      }
    }
  } else {
    const withTarget = checks.find((c) => c.notifyTo !== undefined);
    if (withTarget) {
      throw new ConfigError(
        `config.checks "${withTarget.as}" sets notifyTo but there is no notify block — ` +
          'add notify.destinations to route anywhere',
      );
    }
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
