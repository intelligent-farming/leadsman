/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * ChirpStack's own view of the gateways, over its REST API.
 *
 * Every other check in this engine reads the event store, and for devices that is
 * sufficient: a device that exists is a device that has sent something. Gateways are not
 * like that. What `event_up.rx_info` records is which gateways *forwarded* an uplink, so
 * a gateway is only visible while it is doing its job. Two faults are therefore
 * structurally invisible to SQL over the event store:
 *
 *   - connected but deaf. The gateway is online and sending stats, the network server is
 *     perfectly happy, and it is receiving nothing — a dead concentrator, a disconnected
 *     antenna, water in the feeder. It never appears in rx_info, so from the event store
 *     it is indistinguishable from a gateway that was never installed.
 *   - registered and never heard from. The commissioning mistake: added in ChirpStack,
 *     pointed at the wrong address, and silently absent ever since.
 *
 * Both need the network server's own record, which lives in ChirpStack's core database —
 * a different database from the event store this engine connects to. Rather than open a
 * second DSN into a schema ChirpStack owns, this reads the documented API.
 *
 * No new dependency: `fetch` and `AbortController` are already how notify.ts talks to
 * Twilio, Slack and webhooks, so `pg` + `croner` remains the whole tree.
 *
 * Credentials are never read from the Leadsman config file, which stays committable. They
 * come from the JSON file intelligent-farming-stack's provisioner writes on every start —
 * the same file leftenant and mock-sensors already read.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChirpStackConfig, GatewayRecord, GatewaySource, Logger } from './types';

/** Page size for /api/gateways. ChirpStack caps this server-side; 100 matches leftenant. */
const PAGE_SIZE = 100;

/** Refuse to page forever if the API keeps reporting more than it returns. */
const MAX_PAGES = 50;

export class ChirpStackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChirpStackError';
  }
}

/** What the shared config file supplies. */
export interface SharedStackConfig {
  chirpStackUrl?: string;
  apiKey?: string;
  tenantId?: string;
  gatewayBridgeHost?: string;
}

/**
 * Read the stack's shared config file.
 *
 * Absence is not an error — it means the file is not mounted, which is the normal state
 * for a standalone install. Returns null and lets the caller decide.
 */
export function readSharedConfig(path: string, log?: Pick<Logger, 'warn'>): SharedStackConfig | null {
  const full = resolve(path);
  let text: string;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as SharedStackConfig;
  } catch (err) {
    // Present but malformed is worth saying out loud: the file exists, so somebody meant
    // it to be used, and silently ignoring it looks exactly like a working setup.
    log?.warn(`shared config at ${full} is not valid JSON — ignoring it`, {
      error: (err as Error).message,
    });
    return null;
  }
}

/** Resolved connection details, or a reason there are none. */
export interface ResolvedConnection {
  url: string;
  apiKey: string;
  tenantId: string;
  timeoutMs: number;
}

/**
 * Merge the config block with the shared file. Explicit config wins; the API key only
 * ever comes from the file.
 */
export function resolveConnection(
  config: ChirpStackConfig,
  log?: Pick<Logger, 'warn'>,
): { connection: ResolvedConnection } | { missing: string } {
  const shared = config.configFile ? readSharedConfig(config.configFile, log) : null;

  const url = config.url ?? shared?.chirpStackUrl;
  const tenantId = config.tenantId ?? shared?.tenantId;
  const apiKey = shared?.apiKey;

  if (!url) {
    return {
      missing:
        `no ChirpStack URL — set chirpstack.url (or LEADSMAN_CHIRPSTACK_URL), or mount the ` +
        `stack's shared config at ${config.configFile ?? '/shared/config.json'}`,
    };
  }
  if (!apiKey) {
    return {
      missing:
        `no ChirpStack API key — it is read only from ${config.configFile ?? '/shared/config.json'} ` +
        `(the file the stack's provisioner writes), never from the Leadsman config`,
    };
  }
  if (!tenantId) {
    return {
      missing:
        'no ChirpStack tenant id — set chirpstack.tenantId (or LEADSMAN_CHIRPSTACK_TENANT_ID), ' +
        'or mount the shared config file',
    };
  }

  return {
    connection: { url: url.replace(/\/+$/, ''), apiKey, tenantId, timeoutMs: config.timeoutMs ?? 5_000 },
  };
}

/** One row as chirpstack-rest-api returns it. Fields absent when unset, not null. */
interface GatewayRow {
  gatewayId?: string;
  name?: string;
  description?: string;
  createdAt?: string;
  lastSeenAt?: string;
  state?: string;
}

/**
 * A GatewaySource backed by chirpstack-rest-api.
 *
 * One call per sounding, cached for the life of the source, because several gateway
 * checks run in the same pass and there is no reason for each to re-ask.
 */
export function gatewaySource(
  connection: ResolvedConnection,
  log: Pick<Logger, 'debug' | 'warn'>,
): GatewaySource {
  let cached: Promise<GatewayRecord[]> | null = null;

  const fetchPage = async (offset: number): Promise<{ total: number; rows: GatewayRow[] }> => {
    const url =
      `${connection.url}/api/gateways` +
      `?tenantId=${encodeURIComponent(connection.tenantId)}&limit=${PAGE_SIZE}&offset=${offset}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), connection.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          // chirpstack-rest-api expects the API key as a bearer token.
          authorization: `Bearer ${connection.apiKey}`,
          accept: 'application/json',
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        // Deliberately does not echo the body: a 401 from the REST gateway can include
        // the request context, and this string reaches logs.
        throw new ChirpStackError(
          `GET /api/gateways returned HTTP ${res.status} — check the API key and tenant id`,
        );
      }
      const body = (await res.json()) as { totalCount?: number | string; result?: GatewayRow[] };
      return { total: Number(body.totalCount ?? 0), rows: body.result ?? [] };
    } catch (err) {
      if (err instanceof ChirpStackError) throw err;
      const e = err as Error;
      throw new ChirpStackError(
        e.name === 'AbortError'
          ? `GET /api/gateways timed out after ${connection.timeoutMs}ms`
          : `GET /api/gateways failed: ${e.message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  };

  const loadAll = async (): Promise<GatewayRecord[]> => {
    const out: GatewayRecord[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { total, rows } = await fetchPage(offset);
      for (const row of rows) {
        // A row without an id is unusable and would collide with any other such row as
        // an alert subject, so drop it rather than invent an identity.
        if (!row.gatewayId) continue;
        out.push({
          gatewayId: row.gatewayId.toLowerCase(),
          name: row.name ?? null,
          description: row.description ?? null,
          createdAt: row.createdAt ?? null,
          lastSeenAt: row.lastSeenAt ?? null,
          state: row.state ?? null,
        });
      }
      offset += rows.length;
      if (rows.length === 0 || out.length >= total) break;
    }
    log.debug('read gateways from chirpstack', { count: out.length });
    return out;
  };

  return {
    listGateways: () => {
      if (!cached) cached = loadAll();
      return cached;
    },
  };
}
