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
 *
 * The providers are deliberately thin: render one line, make one POST, and let the existing
 * lifecycle do the rest. There is no send queue and no retry loop, because there does not
 * need to be — a failed delivery leaves notified_at null, so the next sounding picks the
 * alert up again. Provider credentials come from the environment only, so a config naming a
 * Twilio destination is still safe to commit.
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
function payload(alert: RaisedAlert): Record<string, unknown> {
  return {
    schema: 'leadsman.alert/1',
    id: alert.id,
    rule: alert.ruleId,
    kind: alert.kind,
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
      await deliver(alert, dest, name, store, log, outcome, config.messaging);
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
 * needs to triage: the severity, and the alert kind as the identifier to quote when asking
 * about it. Typically lands near 90 characters, inside a single SMS segment.
 */
export function renderMessage(alert: RaisedAlert): string {
  return `Leadsman [${alert.severity.toUpperCase()}] ${alert.kind}: ${alert.summary}`;
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
  signal: AbortSignal,
): Promise<SendResult> {
  if (!dest.webhookUrl) return { ok: false, detail: 'no webhookUrl configured' };
  // Serialize once: the signature covers these exact bytes, so re-stringifying for the
  // request body could produce a different string and a signature that never validates.
  const body = JSON.stringify(payload(alert));
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
  signal: AbortSignal,
): Promise<SendResult> {
  const text = renderMessage(alert);
  const url =
    `${creds.baseUrl ?? 'https://api.twilio.com'}/2010-04-01/Accounts/` +
    `${encodeURIComponent(creds.accountSid)}/Messages.json`;
  const authHeader = `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')}`;

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
  signal: AbortSignal,
): Promise<SendResult> {
  const url = `${creds.baseUrl ?? 'https://api.telegram.org'}/bot${creds.botToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // No parse_mode: alert summaries contain characters Markdown would choke on (underscores
    // in paths, > in transitions), and a formatting error would reject the whole message.
    body: JSON.stringify({ chat_id: dest.chatId, text: renderMessage(alert) }),
    signal,
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = (await res.json()) as { description?: string };
      detail = j.description ?? '';
    } catch {
      /* non-JSON error body */
    }
    return { ok: false, status: res.status, detail };
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
  signal: AbortSignal,
): Promise<SendResult> {
  const res = await fetch(`${creds.baseUrl}/v2/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: renderMessage(alert),
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
        ? await sendTwilio(alert, dest, creds, controller.signal)
        : { ok: false, detail: 'twilio credentials not configured' };
    } else if (provider === 'telegram') {
      const creds = messaging?.telegram;
      result = creds
        ? await sendTelegram(alert, dest, creds, controller.signal)
        : { ok: false, detail: 'telegram credentials not configured' };
    } else if (provider === 'signal') {
      const creds = messaging?.signal;
      result = creds
        ? await sendSignal(alert, dest, creds, controller.signal)
        : { ok: false, detail: 'signal credentials not configured' };
    } else {
      result = await sendWebhook(alert, dest, controller.signal);
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
