/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Pre-flight verification.
 *
 * ChirpStack's PostgreSQL integration creates the event_* tables itself, and their
 * exact columns depend on the ChirpStack version. Rather than assume a schema,
 * every check declares the tables and columns it reads (`Rule.requires`) and this
 * module compares those declarations against the live database.
 *
 * The point is that a schema mismatch is reported once, at deploy time, with the
 * missing column named — instead of surfacing as an SQL error inside a scheduled
 * sounding that nobody is watching.
 */

import type { Store } from './db';
import type { LeadsmanConfig, Rule } from './types';

export interface VerifyProblem {
  severity: 'error' | 'warning';
  where: string;
  message: string;
}

export interface VerifyReport {
  ok: boolean;
  database: string;
  user: string;
  schemaPresent: boolean;
  checksVerified: number;
  problems: VerifyProblem[];
}

/**
 * Validate that the configured checks can actually run: the rules exist, the
 * leadsman schema is present, and every declared table/column is in the database.
 */
export async function verify(
  config: LeadsmanConfig,
  rules: Map<string, Rule>,
  store: Store,
): Promise<VerifyReport> {
  const problems: VerifyProblem[] = [];

  const conn = await store.verifyConnection();
  const schemaPresent = await store.hasSchema();
  if (!schemaPresent) {
    problems.push({
      severity: 'error',
      where: 'database',
      message:
        'leadsman.alert not found — apply migrations/001_leadsman_schema.sql ' +
        '(or run "leadsman migrate")',
    });
  }

  const live = await store.describePublicSchema();
  if (live.size === 0) {
    problems.push({
      severity: 'error',
      where: 'database',
      message:
        'no tables visible in schema "public" — either ChirpStack has not written ' +
        'any events yet, or this role lacks SELECT on public',
    });
  }

  const enabled = config.checks.filter((c) => c.enabled);
  if (enabled.length === 0) {
    problems.push({
      severity: 'warning',
      where: 'config',
      message: 'no checks are enabled — soundings will do nothing',
    });
  }

  let verified = 0;
  // Only report each missing table/column once, however many checks want it.
  const reported = new Set<string>();

  for (const check of enabled) {
    const kind = check.as ?? check.rule;
    const rule = rules.get(check.rule);

    if (!rule) {
      problems.push({
        severity: 'error',
        where: `checks.${kind}`,
        message: `unknown rule "${check.rule}" — see "leadsman list"`,
      });
      continue;
    }

    // Unknown params are almost always typos, and a typo'd threshold silently
    // falls back to the default, which is the kind of bug that looks like the
    // check "not working" for weeks.
    for (const key of Object.keys(check.params ?? {})) {
      if (!(key in rule.defaultParams)) {
        problems.push({
          severity: 'warning',
          where: `checks.${kind}.params`,
          message:
            `"${key}" is not a parameter of rule "${rule.id}" and will be ignored ` +
            `(known: ${Object.keys(rule.defaultParams).join(', ') || 'none'})`,
        });
      }
    }

    for (const req of rule.requires) {
      const cols = live.get(req.table);
      const tableKey = `table:${req.table}`;

      if (!cols) {
        if (!reported.has(tableKey)) {
          reported.add(tableKey);
          problems.push({
            severity: 'error',
            where: `rule.${rule.id}`,
            message: `table public.${req.table} does not exist or is not readable`,
          });
        }
        continue;
      }

      for (const col of req.columns) {
        const colKey = `column:${req.table}.${col}`;
        if (!cols.has(col) && !reported.has(colKey)) {
          reported.add(colKey);
          problems.push({
            severity: 'error',
            where: `rule.${rule.id}`,
            message:
              `column public.${req.table}.${col} does not exist — this ChirpStack ` +
              `version may name it differently; adjust the check's SQL`,
          });
        }
      }
    }
    verified += 1;
  }

  return {
    ok: problems.every((p) => p.severity !== 'error'),
    database: conn.database,
    user: conn.user,
    schemaPresent,
    checksVerified: verified,
    problems,
  };
}
