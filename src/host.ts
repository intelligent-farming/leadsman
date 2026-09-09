/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * The address gateways are configured to forward to.
 *
 * This is one scalar, and it needs a module because getting it right is not obvious.
 *
 * A LoRaWAN gateway does not discover its network server; it is told an address, once, at
 * commissioning — the Gateway Bridge's host on UDP :1700 or ws://<host>:3001. If the host
 * later comes back on a different DHCP lease, every gateway is still dutifully forwarding
 * to an address nobody is listening on. Nothing is broken from the gateway's point of
 * view, nothing is broken from the network server's, and no uplinks arrive.
 *
 * Leadsman cannot discover the answer itself. It runs in a bridged container, where the
 * only addresses visible are the container's own on the docker network — 172.x, stable
 * across exactly the reboot that matters and useless for this purpose. The host's LAN
 * address is visible only on the host. So it is injected: intelligent-farming-stack
 * detects it in setup.sh and its provisioner writes it to the shared config file as
 * `gatewayBridgeHost`, which is the same value it hands to leftenant's Add-Gateway wizard
 * — i.e. literally the address the gateways were told.
 *
 * Consequences worth knowing, both handled by treating unknown as unknown rather than
 * guessing: the file is refreshed when the stack is brought up through setup.sh, so a
 * bare `docker compose up` can leave a stale value; and an install that never mounts the
 * file has no address at all, which is why the check that uses this declares
 * `needs: ['hostAddress']` and is skipped rather than run blind.
 */

import { readSharedConfig } from './chirpstack';
import type { HostAddressConfig, Logger } from './types';

/**
 * Resolve the current address, or null if there is no source for it.
 *
 * An explicit `address` wins over the file: an operator who has pinned it knows something
 * the auto-detection does not.
 */
export function resolveHostAddress(
  config: HostAddressConfig | undefined,
  log?: Pick<Logger, 'warn'>,
): string | null {
  if (!config) return null;

  const explicit = normalize(config.address);
  if (explicit) return explicit;

  if (!config.configFile) return null;
  const shared = readSharedConfig(config.configFile, log);
  if (!shared) return null;

  const key = config.configKey ?? 'gatewayBridgeHost';
  return normalize((shared as Record<string, unknown>)[key]);
}

/**
 * Accept only something that looks like a host, and reject the rest.
 *
 * The value arrives from a file written by another program, and a bad one here would
 * produce an alert claiming the gateways' address changed — the exact false alarm this
 * area exists to avoid. An empty string, whitespace, or a value with a scheme, port,
 * path, or spaces is treated as no answer rather than as an answer.
 */
function normalize(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/[\s/\\@]/.test(trimmed) || trimmed.includes('://')) return null;
  // Bracketed IPv6 is fine; a bare colon means somebody included a port.
  if (trimmed.includes(':') && !trimmed.startsWith('[')) return null;
  return trimmed;
}
