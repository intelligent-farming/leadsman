/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * What an alert is about, and how a check says so.
 *
 * Devices and gateways have their own identities — a DevEUI, a gateway EUI. Site- and
 * engine-level alerts do not: there is exactly one site and one engine per Leadsman
 * instance, which is what `LEADSMAN_INSTANCE_NAME` already assumes. They still need a
 * stable subject id, because dedup is keyed on (subject_kind, subject_id, kind) and an
 * id that varied between soundings would raise a fresh alert every time instead of
 * keeping one open. Hence the two constants below.
 */

import type { AlertSubject, Finding } from './types';

/**
 * Subject id for site-wide alerts.
 *
 * Constant, not the instance name: the name is display text an operator may edit, and
 * renaming a deployment must not silently orphan its open alerts and raise duplicates.
 */
export const SITE_SUBJECT_ID = 'site';

/** Subject id for alerts about Leadsman and its host. Constant for the same reason. */
export const ENGINE_SUBJECT_ID = 'engine';

/** The site as an alert subject. */
export function siteSubject(name?: string | null): AlertSubject {
  return { kind: 'site', id: SITE_SUBJECT_ID, name: name ?? null };
}

/** The engine as an alert subject. */
export function engineSubject(name?: string | null): AlertSubject {
  return { kind: 'engine', id: ENGINE_SUBJECT_ID, name: name ?? null };
}

/** One gateway as an alert subject. */
export function gatewaySubject(gatewayId: string, name?: string | null): AlertSubject {
  return { kind: 'gateway', id: gatewayId.toLowerCase(), name: name ?? null };
}

/**
 * Resolve a finding to the subject it is about.
 *
 * Device checks set `devEui` and nothing else, which is why this exists rather than
 * every one of them having to spell out `{ kind: 'device', id: … }`.
 */
export function subjectOf(finding: Finding): AlertSubject | null {
  if (finding.subject && typeof finding.subject.id === 'string' && finding.subject.id.length > 0) {
    return finding.subject;
  }
  if (typeof finding.devEui === 'string' && finding.devEui.length > 0) {
    return { kind: 'device', id: finding.devEui, name: finding.deviceName ?? null };
  }
  return null;
}
