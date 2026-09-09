/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Outbound notification seam.
 *
 * Each newly-raised alert goes to exactly one destination, chosen by the routing rules in
 * resolveDestination. A destination is either a webhook (the alert JSON, signed) or a
 * messaging provider (one line of text to a phone):
 *
 *   webhook   your own receiver, or a Hermes route — `deliver_only: true` for zero LLM
 *             tokens, or an agent route for the alerts that need interpreting
 *   twilio    SMS via Twilio's REST API
 *   telegram  a Telegram bot message
 *   signal    Signal via a signal-cli-rest-api instance you run
 *   slack     a Slack bot message posted to a channel
 *
 * The providers are deliberately thin: render one line, make one POST, and let the existing
 * lifecycle do the rest. There is no send queue and no retry loop, because there does not
 * need to be — a failed delivery leaves notified_at null, so the next sounding picks the
 * alert up again. Provider credentials come from the environment only, so a config naming a
 * Twilio destination is still safe to commit.
 *
 * Every message names its sender: `Alert from <name>: <alert>`, where the name is
 * `notify.instanceName` (normally LEADSMAN_INSTANCE_NAME) and falls back to "Leadsman" when
 * the deployment is unnamed. That is what lets several edge devices share one channel or
 * group chat — the rest of the line is identical between two devices watching the same kind
 * of sensor, so without the name a recipient cannot tell which site is dry. Webhook receivers
 * get a configured name as the payload's `instance` field instead of a prefix.
 *
 * Only *newly raised* alerts are sent. An alert that stays open across many soundings is
 * delivered once, which is the whole point of the raise/resolve lifecycle — and the reason a
 * flapping sensor cannot generate repeated messages or repeated agent invocations.
 *
 * ── authenticating to the receiver ─────────────────────────────────────────────
 * Three modes, because receivers disagree about how a webhook should prove itself:
 *
 *   hmac    X-Webhook-Signature-V2 + X-Webhook-Timestamp, where the signature is an
 *           HMAC-SHA256 hex digest of `<unix-seconds>.<body>`. The timestamp is part of
 *           the signed string, so a captured request cannot be replayed later — the
 *           receiver rejects a stale timestamp and the attacker cannot re-sign a fresh
 *           one without the secret. This is what Hermes' generic webhook route expects,
 *           and it is the right default for anything reachable off the loopback.
 *   token   A plain shared secret in a configurable header. Simpler, and what several
 *           receivers accept (Hermes' GitLab-shaped route matches X-Gitlab-Token this
 *           way). No replay protection.
 *   bearer  Authorization: Bearer <secret>. The original behaviour, kept for receivers
 *           that treat the webhook as an ordinary authenticated API call.
 *
 * All three read the secret from LEADSMAN_WEBHOOK_TOKEN, so it never enters the config
 * file.
 */

import { createHmac } from 'node:crypto';
import type { RaisedAlert, Store } from './db';
import type {
  Logger,
  MessagingCredentials,
  NotifyConfig,
  NotifyDestination,
  Routing,
} from './types';

export interface NotifyOutcome {
  attempted: number;
  delivered: number;
  failed: number;
  /** Alerts that resolved to no destination — recorded in Postgres, deliberately not sent. */
  unrouted: number;
}

/** What the runner knows about one check, needed to route its alerts. */
export interface AlertRoute {
  /** Explicit destination from the check's config entry. Highest precedence. */
  notifyTo?: string;
  /** The rule's own classification — see the Routing type. */
  routing: Routing;
}

/**
 * Decide where one alert goes. Null means record-only.
 *
 * Precedence, highest first:
 *
 *   1. the check's `notifyTo`          — this deployment says so explicitly
 *   2. `notify.bySeverity[severity]`   — blanket escalation, use sparingly
 *   3. `notify.routing[rule class]`    — the fact/situation default
 *   4. `notify.defaultDestination`     — catch-all
 *
 * Four levels rather than more: every extra level is another place to look when an alert
 * turns up somewhere unexpected. A `null` at any level is a decision, not a miss — it stops
 * the chain and means record-only.
 */
export function resolveDestination(
  alert: Pick<RaisedAlert, 'severity'>,
  route: AlertRoute | undefined,
  config: NotifyConfig,
): string | null {
  if (route?.notifyTo !== undefined) return route.notifyTo;

  const bySeverity = config.bySeverity;
  if (bySeverity && alert.severity in bySeverity) {
    return bySeverity[alert.severity] ?? null;
  }

  const routing = config.routing;
  if (route && routing && route.routing in routing) {
    return routing[route.routing] ?? null;
  }

  return config.defaultDestination ?? null;
}

/** Body posted per alert. Flat and small — a receiver can map it straight to a template. */
function payload(alert: RaisedAlert, instanceName?: string): Record<string, unknown> {
  return {
    // /2 adds the three subject fields to /1 and changes nothing else. Every /1 field
    // keeps its name and meaning, and devEui is still the DevEUI for a device alert, so a
    // receiver written against /1 keeps working — it will simply see null where the
    // subject is a gateway, the site, or the engine.
    schema: 'leadsman.alert/2',
    // Which edge device raised it, when the deployment is named. Omitted entirely rather than
    // sent as null when it is not, so an existing receiver sees byte-identical bodies and the
    // schema version does not have to move for an additive optional field.
    ...(instanceName ? { instance: instanceName } : {}),
    id: alert.id,
    rule: alert.ruleId,
    kind: alert.kind,
    subjectKind: alert.subjectKind,
    subjectId: alert.subjectId,
    subjectName: alert.subjectName,
    devEui: alert.devEui,
    deviceName: alert.deviceName,
    severity: alert.severity,
    summary: alert.summary,
    detail: alert.detail,
    raisedAt: alert.raisedAt,
  };
}

/**
 * Deliver newly-raised alerts. Failures are logged and left un-stamped, so the
 * alert stays pending and a later sounding retries it — no separate retry queue.
 */
export async function notifyRaised(
  alerts: RaisedAlert[],
  config: NotifyConfig | undefined,
  store: Store,
  log: Logger,
  routes?: Map<string, AlertRoute>,
): Promise<NotifyOutcome> {
  const outcome: NotifyOutcome = { attempted: 0, delivered: 0, failed: 0, unrouted: 0 };
  if (!config || alerts.length === 0) {
    if (alerts.length > 0) {
      log.debug('no notify config — alerts recorded but not delivered', {
        pending: alerts.length,
      });
    }
    return outcome;
  }

  // Group first so one target's failure cannot affect another's, and so the log reads
  // per-destination rather than as an undifferentiated stream.
  const groups = new Map<string, RaisedAlert[]>();
  for (const alert of alerts) {
    const target = resolveDestination(alert, routes?.get(alert.kind), config);
    if (target === null) {
      outcome.unrouted += 1;
      log.debug('alert not routed — recorded only', { alertId: alert.id, kind: alert.kind });
      continue;
    }
    const list = groups.get(target);
    if (list) list.push(alert);
    else groups.set(target, [alert]);
  }

  for (const [name, group] of groups) {
    const dest = config.destinations[name];
    if (!dest) {
      // parseConfig validates every routing target, so this is unreachable via the CLI.
      // Reached only by a caller constructing NotifyConfig by hand — do not lose the alerts.
      outcome.unrouted += group.length;
      log.error('unknown notify destination — alerts recorded but not delivered', {
        destination: name,
        count: group.length,
      });
      continue;
    }
    warnIfUnsigned(dest, name, log);
    for (const alert of group) {
      await deliver(
        alert, dest, name, store, log, outcome, config.messaging, config.instanceName,
      );
    }
  }
  return outcome;
}

/** An auth mode that needs a secret, without one, fails every POST. Say so once. */
function warnIfUnsigned(dest: NotifyDestination, name: string, log: Logger): void {
  // Only webhooks authenticate this way. A messaging provider carries its own credentials and
  // would otherwise draw a warning about a secret it has no use for.
  if ((dest.provider ?? 'webhook') !== 'webhook') return;
  const auth = dest.webhookAuth ?? 'bearer';
  if (auth !== 'bearer' && !dest.webhookToken) {
    log.warn(
      `notify auth is "${auth}" but no secret is set — set ` +
        `LEADSMAN_WEBHOOK_TOKEN_${name.toUpperCase().replace(/-/g, '_')} ` +
        '(or LEADSMAN_WEBHOOK_TOKEN) or the receiver will reject every delivery',
      { destination: name },
    );
  }
}

/**
 * One line of text for a human on a phone.
 *
 * The check summaries were written to be readable on their own — that was the point of making
 * every one of them a sentence rather than a metric dump — so this adds only what a recipient
 * needs to triage: who is reporting, the severity, and the alert kind as the identifier to
 * quote when asking about it. Typically lands near 100 characters, inside a single SMS
 * segment.
 */
export function renderMessage(alert: RaisedAlert, instanceName?: string): string {
  // The sender leads the line, and it is the *only* field that differs between two devices
  // running the same check — "[CRITICAL] battery-low: node-3 3.15V" says nothing about which
  // barn to walk to. Unnamed deployments fall back to "Leadsman" so the sender is never blank
  // and there is exactly one message format to read, named or not.
  const from = instanceName?.trim() || 'Leadsman';
  return `Alert from ${from}: [${alert.severity.toUpperCase()}] ${alert.kind}: ${alert.summary}`;
}

interface SendResult {
  ok: boolean;
  /** For the log line when a send fails. */
  status?: number;
  detail?: string;
}

/** POST the alert JSON, signed per the destination's auth mode. */
async function sendWebhook(
  alert: RaisedAlert,
  dest: NotifyDestination,
  instanceName: string | undefined,
  signal: AbortSignal,
): Promise<SendResult> {
  if (!dest.webhookUrl) return { ok: false, detail: 'no webhookUrl configured' };
  // Serialize once: the signature covers these exact bytes, so re-stringifying for the
  // request body could produce a different string and a signature that never validates.
  const body = JSON.stringify(payload(alert, instanceName));
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const auth = dest.webhookAuth ?? 'bearer';

  if (dest.webhookToken) {
    if (auth === 'hmac') {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      headers['x-webhook-timestamp'] = timestamp;
      headers['x-webhook-signature-v2'] = createHmac('sha256', dest.webhookToken)
        .update(`${timestamp}.${body}`)
        .digest('hex');
    } else if (auth === 'token') {
      headers[(dest.webhookTokenHeader ?? 'x-webhook-token').toLowerCase()] = dest.webhookToken;
    } else {
      headers.authorization = `Bearer ${dest.webhookToken}`;
    }
  }

  const res = await fetch(dest.webhookUrl, { method: 'POST', headers, body, signal });
  return { ok: res.ok, status: res.status };
}

/**
 * Twilio SMS. One POST per recipient — Twilio's Messages resource takes a single `To`.
 *
 * All recipients must succeed for the alert to count as delivered, because a partial success
 * that stamped notified_at would permanently lose the alert for whoever did not get it. The
 * cost is that a retry re-sends to recipients who already received it; a duplicate text is a
 * better failure than a missed critical alert.
 */
async function sendTwilio(
  alert: RaisedAlert,
  dest: NotifyDestination,
  creds: NonNullable<MessagingCredentials['twilio']>,
  instanceName: string | undefined,
  signal: AbortSignal,
): Promise<SendResult> {
  const text = renderMessage(alert, instanceName);
  const url =
    `${creds.baseUrl ?? 'https://api.twilio.com'}/2010-04-01/Accounts/` +
    `${encodeURIComponent(creds.accountSid)}/Messages.json`;
  // The API Key pair authenticates; the URL above still carries the Account SID, since a key
  // identifies the caller rather than replacing the account it acts on.
  const authHeader =
    `Basic ${Buffer.from(`${creds.apiKeySid}:${creds.apiKeySecret}`).toString('base64')}`;

  for (const to of dest.to ?? []) {
    // Twilio's API is form-encoded, not JSON — a JSON body is rejected as a 400.
    const form = new URLSearchParams({ To: to, From: creds.from, Body: text });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: authHeader,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal,
    });
    if (!res.ok) {
      // Twilio returns a JSON error body with a code worth surfacing (21608 = unverified
      // number on a trial account, 21211 = invalid To).
      let detail = `to ${to}`;
      try {
        const j = (await res.json()) as { code?: number; message?: string };
        if (j.code || j.message) detail += `: ${j.code ?? ''} ${j.message ?? ''}`.trim();
      } catch {
        /* non-JSON error body */
      }
      return { ok: false, status: res.status, detail };
    }
  }
  return { ok: true };
}

/** Telegram bot message. One POST per chat. */
async function sendTelegram(
  alert: RaisedAlert,
  dest: NotifyDestination,
  creds: NonNullable<MessagingCredentials['telegram']>,
  instanceName: string | undefined,
  signal: AbortSignal,
): Promise<SendResult> {
  const url = `${creds.baseUrl ?? 'https://api.telegram.org'}/bot${creds.botToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // No parse_mode: alert summaries contain characters Markdown would choke on (underscores
    // in paths, > in transitions), and a formatting error would reject the whole message.
    body: JSON.stringify({ chat_id: dest.chatId, text: renderMessage(alert, instanceName) }),
    signal,
  });
  // Telegram answers in an envelope: {"ok":false,"description":"..."}. It usually pairs that
  // with a non-2xx, but the envelope is the authoritative signal — trusting the status alone
  // risks recording a rejected message as delivered, which loses the alert for good because
  // notified_at gets stamped and no sounding retries it.
  let envelope: { ok?: boolean; description?: string } | null = null;
  try {
    envelope = (await res.json()) as { ok?: boolean; description?: string };
  } catch {
    /* non-JSON body; fall back to the status */
  }
  if (!res.ok || envelope?.ok === false) {
    return {
      ok: false,
      status: res.status,
      detail: envelope?.description ?? '',
    };
  }
  return { ok: true };
}

/**
 * Slack's `text` is parsed as mrkdwn, so `&`, `<` and `>` are metacharacters — `<` in
 * particular opens Slack's link syntax, so an unescaped summary can render as garbage or
 * swallow the rest of the line. Alert summaries are full of both: `>` in transitions and `<`
 * in comparisons ("battery 3.15V (raise <=3.4V)").
 *
 * This is the Slack analogue of the no-parse_mode decision on sendTelegram — a formatting
 * artifact in a critical alert is worse than plain text, so the metacharacters are neutered
 * rather than the message being handed over for interpretation. Order matters: `&` first, or
 * it would re-escape the ampersands the other two replacements introduce.
 */
function escapeSlackText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Slack bot message via chat.postMessage. One POST per channel. */
async function sendSlack(
  alert: RaisedAlert,
  dest: NotifyDestination,
  creds: NonNullable<MessagingCredentials['slack']>,
  instanceName: string | undefined,
  signal: AbortSignal,
): Promise<SendResult> {
  const res = await fetch(`${creds.baseUrl ?? 'https://slack.com'}/api/chat.postMessage`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${creds.botToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel: dest.channel,
      text: escapeSlackText(renderMessage(alert, instanceName)),
    }),
    signal,
  });
  // Slack answers a *rejected* message with HTTP 200 and {"ok":false,"error":"..."}. The
  // envelope is the authoritative signal, exactly as with Telegram: trusting the status alone
  // would stamp notified_at on an alert nobody received, and because no sounding retries a
  // stamped alert it would be lost permanently. Errors worth recognising in the log:
  // channel_not_found, not_in_channel, invalid_auth, ratelimited.
  let envelope: { ok?: boolean; error?: string } | null = null;
  try {
    envelope = (await res.json()) as { ok?: boolean; error?: string };
  } catch {
    /* non-JSON body; fall back to the status */
  }
  if (!res.ok || envelope?.ok === false) {
    return { ok: false, status: res.status, detail: envelope?.error ?? '' };
  }
  return { ok: true };
}

/**
 * Signal via signal-cli-rest-api, which you run yourself — Signal has no hosted send API.
 * Its /v2/send takes all recipients at once, so this is a single POST.
 */
async function sendSignal(
  alert: RaisedAlert,
  dest: NotifyDestination,
  creds: NonNullable<MessagingCredentials['signal']>,
  instanceName: string | undefined,
  signal: AbortSignal,
): Promise<SendResult> {
  const res = await fetch(`${creds.baseUrl}/v2/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: renderMessage(alert, instanceName),
      number: creds.from,
      recipients: dest.to ?? [],
    }),
    signal,
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* non-JSON error body */
    }
    return { ok: false, status: res.status, detail };
  }
  return { ok: true };
}

/**
 * Deliver one alert to one destination, stamping notified_at only on success.
 *
 * A failure deliberately leaves notified_at null, so the alert stays pending and a later
 * sounding retries it. That is the whole retry mechanism — there is no separate queue.
 */
async function deliver(
  alert: RaisedAlert,
  dest: NotifyDestination,
  name: string,
  store: Store,
  log: Logger,
  outcome: NotifyOutcome,
  messaging?: MessagingCredentials,
  instanceName?: string,
): Promise<void> {
  outcome.attempted += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dest.timeoutMs ?? 5_000);
  const provider = dest.provider ?? 'webhook';
  const where = { destination: name, provider };

  try {
    let result: SendResult;
    if (provider === 'twilio') {
      const creds = messaging?.twilio;
      result = creds
        ? await sendTwilio(alert, dest, creds, instanceName, controller.signal)
        : { ok: false, detail: 'twilio credentials not configured' };
    } else if (provider === 'telegram') {
      const creds = messaging?.telegram;
      result = creds
        ? await sendTelegram(alert, dest, creds, instanceName, controller.signal)
        : { ok: false, detail: 'telegram credentials not configured' };
    } else if (provider === 'signal') {
      const creds = messaging?.signal;
      result = creds
        ? await sendSignal(alert, dest, creds, instanceName, controller.signal)
        : { ok: false, detail: 'signal credentials not configured' };
    } else if (provider === 'slack') {
      const creds = messaging?.slack;
      result = creds
        ? await sendSlack(alert, dest, creds, instanceName, controller.signal)
        : { ok: false, detail: 'slack credentials not configured' };
    } else {
      result = await sendWebhook(alert, dest, instanceName, controller.signal);
    }

    if (!result.ok) {
      outcome.failed += 1;
      log.warn('notify failed', {
        alertId: alert.id,
        kind: alert.kind,
        status: result.status,
        detail: result.detail,
        ...where,
      });
      return;
    }

    await store.markNotified(alert.id);
    outcome.delivered += 1;
    log.info('alert delivered', {
      alertId: alert.id,
      kind: alert.kind,
      devEui: alert.devEui,
      ...where,
    });
  } catch (err) {
    outcome.failed += 1;
    const aborted = (err as Error).name === 'AbortError';
    log.warn(aborted ? 'notify timed out' : 'notify errored', {
      alertId: alert.id,
      kind: alert.kind,
      error: (err as Error).message,
      ...where,
    });
  } finally {
    clearTimeout(timer);
  }
}
