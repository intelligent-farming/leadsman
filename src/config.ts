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
 *   LEADSMAN_INSTANCE_NAME            names this edge device in every message it sends
 *   LEADSMAN_DEST_<NAME>_PROVIDER     webhook | twilio | telegram | signal | slack
 *   LEADSMAN_DEST_<NAME>_TO           recipients, comma-separated E.164
 *   LEADSMAN_DEST_<NAME>_CHAT_ID      Telegram chat id
 *   LEADSMAN_DEST_<NAME>_CHANNEL      Slack channel id or #name
 *   LEADSMAN_DEST_<NAME>_WEBHOOK_URL  webhook target
 *   LEADSMAN_WEBHOOK_TOKEN_<NAME>     that destination's secret
 *   LEADSMAN_WEBHOOK_TOKEN            shared-secret fallback for all of them
 *   LEADSMAN_TWILIO_*  ACCOUNT_SID + API_KEY_SID + API_KEY_SECRET + FROM
 *   LEADSMAN_TELEGRAM_* / _SIGNAL_* / _SLACK_*    other provider credentials
 *   LEADSMAN_HEARTBEAT_URL            where to POST the liveness ping
 *   LEADSMAN_CHIRPSTACK_CONFIG        shared JSON file holding the network server's
 *                                     URL, API key and tenant id
 *   LEADSMAN_CHIRPSTACK_URL           overrides that file's chirpStackUrl
 *   LEADSMAN_CHIRPSTACK_TENANT_ID     overrides that file's tenantId
 *   LEADSMAN_HOST_ADDRESS             the address gateways forward to, if not from a file
 *   LEADSMAN_HOST_ADDRESS_CONFIG      file to read that address from
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
  ChirpStackConfig,
  HeartbeatConfig,
  HostAddressConfig,
  LeadsmanConfig,
  MessagingCredentials,
  NotifyConfig,
  NotifyDestination,
  NotifyProvider,
  Severity,
  SuppressRule,
} from './types';

const SEVERITIES: readonly Severity[] = ['info', 'warning', 'critical'];

/**
 * Ceiling on notify.instanceName. It is prepended to every message, and the whole line aims
 * to fit one 160-character SMS segment — a long site name would silently push every alert
 * into a second segment, so it is refused here instead.
 */
const INSTANCE_NAME_MAX_CHARS = 64;

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

/**
 * Where intelligent-farming-stack's provisioner writes the facts about its own
 * deployment — `chirpStackUrl`, `apiKey`, `tenantId`, `gatewayBridgeHost` — on every
 * start. leftenant and mock-sensors already read this same file, so pointing at it
 * needs no new credential of its own.
 */
const DEFAULT_SHARED_CONFIG = '/shared/config.json';

/**
 * Suppression applied when the config says nothing about it.
 *
 * On by default, unlike almost everything else here, because the noise it removes is
 * noise nobody opted into: a gateway that stops forwarding makes every device behind it
 * look silent, and the resulting alerts each name a sensor that is working fine. The one
 * alert identifying the actual fault arrives buried in forty that misdiagnose it.
 *
 * The list is deliberately short. Most checks read decoded telemetry and simply go quiet
 * when uplinks stop arriving — they have nothing to compare and raise nothing, so there
 * is nothing to mute. `device-silent` is the exception: absence of data is precisely what
 * it fires on, which is what makes it both the most useful check in the catalogue and the
 * one that turns a single outage into a storm.
 *
 * The gateway edge is knowingly broad: one gateway down mutes device-silent fleet-wide,
 * including for a node behind a different gateway that really is dead. That is the right
 * trade because the data cannot distinguish "dead" from "unreachable" while a gateway is
 * missing, and because muting is not dropping — a still-silent node is delivered as soon
 * as the gateway alert resolves.
 *
 * Set `"suppress": []` in the config to deliver everything regardless of cause.
 */
const DEFAULT_SUPPRESS: SuppressRule[] = [
  { while: ['fleet-silent'], mute: ['device-silent'], enabled: true },
  { while: ['gateway-silent'], mute: ['device-silent'], enabled: true },
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read `raw[block][key]` as a string, when the block is present and an object. */
function readOptString(
  raw: Record<string, unknown>,
  block: string,
  key: string,
): string | undefined {
  const b = raw[block];
  if (!isPlainObject(b)) return undefined;
  const v = b[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Same check the webhook destinations apply, so a typo'd URL fails at config time. */
function assertHttpUrl(value: string, at: string): void {
  try {
    new URL(value);
  } catch {
    throw new ConfigError(`${at} is not a valid URL: ${value}`);
  }
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

    // Which edge device this is. Env first, and that is the expected way to set it: a fleet
    // shares one config file and differs only in which host each engine runs on, so the name
    // belongs with the other per-host facts rather than in the committed file.
    const rawInstance = envStr('LEADSMAN_INSTANCE_NAME') ?? rawNotify.instanceName;
    let instanceName: string | undefined;
    if (rawInstance !== undefined) {
      if (typeof rawInstance !== 'string') {
        throw new ConfigError(
          'config.notify.instanceName must be a string when present — it names this edge ' +
            'device, e.g. "north-barn" (or set LEADSMAN_INSTANCE_NAME)',
        );
      }
      // Blank counts as unnamed rather than as an error, and messages then say "Alert from
      // Leadsman" — the same fallback an absent key gets. A blank `VAR=` in a .env or an
      // emptied-out key is not worth failing a deployment over, and the sender is never
      // blank either way.
      instanceName = rawInstance.trim() || undefined;
    }
    if (instanceName !== undefined) {
      // The name leads a one-line message. A newline would split one alert into two lines in
      // the channel, and a control character would corrupt the log line reporting it.
      if (/[\u0000-\u001f\u007f]/.test(instanceName)) {
        throw new ConfigError(
          'config.notify.instanceName must not contain line breaks or control characters — ' +
            'it is prefixed to every one-line message',
        );
      }
      if (instanceName.length > INSTANCE_NAME_MAX_CHARS) {
        throw new ConfigError(
          `config.notify.instanceName is ${instanceName.length} characters — keep it to ` +
            `${INSTANCE_NAME_MAX_CHARS} or fewer, since it is prefixed to every message and ` +
            'an SMS segment is 160 characters',
        );
      }
    }

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
        if (!['webhook', 'twilio', 'telegram', 'signal', 'slack'].includes(provider)) {
          throw new ConfigError(
            `${at}.provider must be "webhook", "twilio", "telegram", "signal", or "slack" ` +
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
        const channel = envStr(`${envPrefix}_CHANNEL`) ?? (raw.channel as string | undefined);

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
        if (provider === 'slack' && !channel) {
          throw new ConfigError(
            `${at}: provider "slack" needs "channel" (or ${envPrefix}_CHANNEL) — a channel ` +
              'ID ("C0123456789") or name ("#field-alerts")',
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
          channel,
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
    const slackToken = envStr('LEADSMAN_SLACK_BOT_TOKEN');
    if (slackToken) {
      messaging.slack = {
        botToken: slackToken,
        baseUrl: envStr('LEADSMAN_SLACK_BASE_URL') ?? 'https://slack.com',
      };
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
        if (p === 'slack' && !messaging.slack) {
          missing.push(
            `"${name}" uses slack but LEADSMAN_SLACK_BOT_TOKEN is not set. Create an app at ` +
              'api.slack.com/apps, add the chat:write bot scope, install it to the workspace, ' +
              'and use the Bot User OAuth Token (xoxb-…).',
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
      instanceName,
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

  // ── suppress ────────────────────────────────────────────────────────────────
  // Absent means DEFAULT_SUPPRESS, not "no suppression". A present array wins, so
  // `"suppress": []` is the documented way to turn it off — see the constant.
  let suppress: SuppressRule[];
  if (raw.suppress === undefined) {
    suppress = DEFAULT_SUPPRESS.map((r) => ({ ...r }));
  } else {
    if (!Array.isArray(raw.suppress)) {
      throw new ConfigError(
        'config.suppress must be an array of {while: [...], mute: [...]} entries ' +
          '(use [] to deliver every alert regardless of cause)',
      );
    }
    suppress = raw.suppress.map((entry, i) => {
      const at = `config.suppress[${i}]`;
      if (!isPlainObject(entry)) throw new ConfigError(`${at} must be an object`);
      const strings = (key: 'while' | 'mute'): string[] => {
        const v = entry[key];
        if (!Array.isArray(v) || v.length === 0) {
          throw new ConfigError(`${at}.${key} must be a non-empty array of check or rule names`);
        }
        return v.map((s) => {
          if (typeof s !== 'string' || s.length === 0) {
            throw new ConfigError(`${at}.${key} entries must be non-empty strings`);
          }
          return s;
        });
      };
      if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
        throw new ConfigError(`${at}.enabled must be a boolean`);
      }
      return {
        while: strings('while'),
        mute: strings('mute'),
        enabled: entry.enabled !== false,
      };
    });
  }

  // ── heartbeat ───────────────────────────────────────────────────────────────
  const heartbeatUrl = envStr('LEADSMAN_HEARTBEAT_URL') ?? readOptString(raw, 'heartbeat', 'url');
  let heartbeat: HeartbeatConfig | undefined;
  if (heartbeatUrl !== undefined) {
    const rawHb = isPlainObject(raw.heartbeat) ? raw.heartbeat : {};
    const auth = rawHb.auth ?? 'bearer';
    if (!['hmac', 'token', 'bearer', 'none'].includes(auth as string)) {
      throw new ConfigError(
        "config.heartbeat.auth must be one of hmac, token, bearer, none",
      );
    }
    assertHttpUrl(heartbeatUrl, 'config.heartbeat.url');
    heartbeat = {
      url: heartbeatUrl,
      auth: auth as HeartbeatConfig['auth'],
      tokenHeader: (rawHb.tokenHeader as string | null | undefined) ?? null,
      timeoutMs: typeof rawHb.timeoutMs === 'number' ? rawHb.timeoutMs : 5_000,
      onError: rawHb.onError !== false,
    };
  }

  // ── chirpstack ──────────────────────────────────────────────────────────────
  // Deliberately explicit: a mounted /shared/config.json is not treated as consent to
  // start calling the network server. Either the config names a `chirpstack` block or
  // the environment points at the shared file.
  const sharedFromEnv = envStr('LEADSMAN_CHIRPSTACK_CONFIG');
  let chirpstack: ChirpStackConfig | undefined;
  if (raw.chirpstack !== undefined || sharedFromEnv !== undefined) {
    if (raw.chirpstack !== undefined && !isPlainObject(raw.chirpstack)) {
      throw new ConfigError('config.chirpstack must be an object');
    }
    const rawCs = isPlainObject(raw.chirpstack) ? raw.chirpstack : {};
    const url = envStr('LEADSMAN_CHIRPSTACK_URL') ?? (rawCs.url as string | undefined);
    if (url !== undefined) assertHttpUrl(url, 'config.chirpstack.url');
    chirpstack = {
      url,
      tenantId: envStr('LEADSMAN_CHIRPSTACK_TENANT_ID') ?? (rawCs.tenantId as string | undefined),
      configFile: sharedFromEnv ?? (rawCs.configFile as string | undefined) ?? DEFAULT_SHARED_CONFIG,
      timeoutMs: typeof rawCs.timeoutMs === 'number' ? rawCs.timeoutMs : 5_000,
    };
  }

  // ── hostAddress ─────────────────────────────────────────────────────────────
  // Also enabled by a configured `chirpstack`, because the same shared file supplies
  // both: the provisioner writes `gatewayBridgeHost` alongside the API key. Pointing at
  // that file is already the statement "read this deployment's facts from here", and
  // requiring a second opt-in for the other key in it would mean host-address-changed
  // silently skipping on exactly the stack it was written for. If the key is absent the
  // address resolves to null and the check is skipped anyway, so this cannot invent one.
  const addrFromEnv = envStr('LEADSMAN_HOST_ADDRESS');
  let hostAddress: HostAddressConfig | undefined;
  if (raw.hostAddress !== undefined || addrFromEnv !== undefined || chirpstack?.configFile) {
    if (raw.hostAddress !== undefined && !isPlainObject(raw.hostAddress)) {
      throw new ConfigError('config.hostAddress must be an object');
    }
    const rawHa = isPlainObject(raw.hostAddress) ? raw.hostAddress : {};
    hostAddress = {
      address: addrFromEnv ?? (rawHa.address as string | undefined) ?? null,
      configFile:
        envStr('LEADSMAN_HOST_ADDRESS_CONFIG') ??
        (rawHa.configFile as string | undefined) ??
        chirpstack?.configFile ??
        DEFAULT_SHARED_CONFIG,
      // What the stack's provisioner writes: the LAN address it detected on the host
      // and handed to gateways as their forwarding target.
      configKey: (rawHa.configKey as string | undefined) ?? 'gatewayBridgeHost',
    };
  }

  const enabledCount = checks.filter((c) => c.enabled).length;
  if (enabledCount > maxChecksPerRun) {
    throw new ConfigError(
      `${enabledCount} checks enabled but maxChecksPerRun is ${maxChecksPerRun}`,
    );
  }

  return {
    schedule,
    timezone,
    statementTimeoutMs,
    maxChecksPerRun,
    notify,
    suppress,
    heartbeat,
    chirpstack,
    hostAddress,
    checks,
  };
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
