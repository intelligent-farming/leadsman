/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Outbound liveness ping — the one alert this engine cannot raise about itself.
 *
 * Every check here works by looking at data and finding something wrong with it. That
 * approach has a floor: it requires the engine to be running. A power cut, a kernel panic,
 * a full disk, an OOM kill, a container that never came back after a reboot — in all of
 * them Leadsman is not executing, and a rule engine that is not executing raises nothing
 * at all. From outside, a site whose sensors are all healthy and a site whose edge device
 * is dead look exactly alike: no alerts either way.
 *
 * `host-restarted` closes half of this, retrospectively, by noticing on the way back up
 * that there is a gap. But retrospect is the wrong tense for a farm — a frost event during
 * a six-hour outage is not something to find out about afterwards.
 *
 * So the signal is inverted and pushed off the box: a ping after each sounding, and
 * something external raises the alarm when the pings stop. That receiver has to be
 * somewhere the outage cannot reach, which is the whole point — a watchdog on the same
 * edge device dies with it.
 *
 * Sent on error too, by default. An engine whose checks are failing is still an engine
 * that is up, and conflating "degraded" with "gone" would fire the wrong alarm; the
 * payload carries the error count so the receiver can tell them apart.
 */

import { createHmac } from 'node:crypto';
import type { HeartbeatConfig, Logger } from './types';

/** What the receiver gets. Small on purpose — this is a liveness signal, not a report. */
export interface HeartbeatPayload {
  schema: 'leadsman.heartbeat/1';
  /** Which edge device is alive, when the deployment is named. */
  instance?: string;
  sentAt: string;
  /** Engine version, so a receiver can notice a downgrade it did not expect. */
  version: string;
  /** Wall-clock duration of the sounding that just finished. */
  soundingMs: number;
  checksRun: number;
  checksErrored: number;
  openAlerts: number;
  /** Open alerts withheld by suppression — a receiver seeing these knows to look. */
  suppressedAlerts: number;
}

export interface HeartbeatResult {
  attempted: boolean;
  delivered: boolean;
  detail?: string;
}

/**
 * POST one ping. Never throws.
 *
 * A failed heartbeat must not fail the sounding: the checks have already run and their
 * alerts are already stored, and taking the engine down because a watchdog endpoint is
 * unreachable would turn a monitoring outage into a monitoring failure. It is logged at
 * warn and that is all — the receiver's own missed-ping alarm is the backstop, and it is
 * about to fire anyway.
 */
export async function sendHeartbeat(
  config: HeartbeatConfig | undefined,
  payload: HeartbeatPayload,
  log: Logger,
  secret?: string | null,
): Promise<HeartbeatResult> {
  if (!config) return { attempted: false, delivered: false };

  const auth = config.auth ?? 'bearer';
  if (auth !== 'none' && auth !== 'bearer' && !secret) {
    log.warn(
      `heartbeat auth is "${auth}" but no secret is set — set LEADSMAN_WEBHOOK_TOKEN_HEARTBEAT ` +
        '(or LEADSMAN_WEBHOOK_TOKEN) or the receiver will reject every ping',
    );
  }

  // Serialize once: the HMAC covers these exact bytes, so re-stringifying for the body
  // could produce a different string and a signature that never validates.
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (secret && auth !== 'none') {
    if (auth === 'hmac') {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      headers['x-webhook-timestamp'] = timestamp;
      headers['x-webhook-signature-v2'] = createHmac('sha256', secret)
        .update(`${timestamp}.${body}`)
        .digest('hex');
    } else if (auth === 'token') {
      headers[(config.tokenHeader ?? 'x-webhook-token').toLowerCase()] = secret;
    } else {
      headers.authorization = `Bearer ${secret}`;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 5_000);
  try {
    const res = await fetch(config.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn('heartbeat rejected', { status: res.status });
      return { attempted: true, delivered: false, detail: `HTTP ${res.status}` };
    }
    log.debug('heartbeat sent');
    return { attempted: true, delivered: true };
  } catch (err) {
    const e = err as Error;
    const detail = e.name === 'AbortError' ? `timed out after ${config.timeoutMs ?? 5_000}ms` : e.message;
    log.warn('heartbeat failed', { error: detail });
    return { attempted: true, delivered: false, detail };
  } finally {
    clearTimeout(timer);
  }
}

/** The secret for the heartbeat endpoint, following the webhook naming convention. */
export function heartbeatSecretFromEnv(): string | null {
  const specific = process.env.LEADSMAN_WEBHOOK_TOKEN_HEARTBEAT;
  if (specific && specific.trim() !== '') return specific.trim();
  const shared = process.env.LEADSMAN_WEBHOOK_TOKEN;
  if (shared && shared.trim() !== '') return shared.trim();
  return null;
}
