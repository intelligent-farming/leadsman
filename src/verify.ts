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
import type { CheckConfig, LeadsmanConfig, Rule, SoundingContext } from './types';

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
 * Everything that can be checked about a config WITHOUT a database.
 *
 * Split out from `verify` so the same logic serves two callers and cannot drift
 * between them. `verify` runs it and then adds the schema checks; `leadsman lint`
 * runs it alone, which is what makes a config reviewable on a laptop, in a
 * pre-commit hook, or on a box that has no Postgres reachable yet.
 *
 * That gap was real: the deployment config for this project's own bench was never
 * machine-checked by anything, because the only tool that could check it needed a
 * database, and the two shipped example configs were covered by unit tests it was
 * not. A config file is the part of a deployment most likely to be hand-edited at
 * 3am and least likely to be tested.
 */
export async function lintConfig(
  config: LeadsmanConfig,
  rules: Map<string, Rule>,
): Promise<VerifyProblem[]> {
  const problems: VerifyProblem[] = [];
  const enabled = config.checks.filter((c) => c.enabled);

  if (enabled.length === 0) {
    problems.push({
      severity: 'warning',
      where: 'config',
      message: 'no checks are enabled — soundings will do nothing',
    });
  }

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

    problems.push(...needProblems(config, rule, kind));
    problems.push(...paramNameProblems(rule, check, kind));
    problems.push(...(await paramValueProblems(rule, check, kind)));

    // A window that can never contain "now" disables the check permanently while
    // looking configured. parseConfig rejects an empty list and an out-of-range
    // value; this catches the subtler shape where every entry is individually legal.
    if (check.activeMonths && check.activeMonths.length === 12) {
      problems.push({
        severity: 'warning',
        where: `checks.${kind}.activeMonths`,
        message: 'lists all twelve months, which is the same as omitting it',
      });
    }
    if (check.activeHours && check.activeHours.length === 24) {
      problems.push({
        severity: 'warning',
        where: `checks.${kind}.activeHours`,
        message: 'lists all twenty-four hours, which is the same as omitting it',
      });
    }
  }

  return problems;
}

/** Prerequisites a rule declares that this config does not supply. */
function needProblems(
  config: LeadsmanConfig,
  rule: Rule,
  kind: string,
): VerifyProblem[] {
  const out: VerifyProblem[] = [];
  // Keyed by need so a new capability cannot fall through to another one's message.
  // It did once: `forecast` landed in the hostAddress branch of an if/else and every
  // forecast check reported "no host address source", which is a wrong diagnosis
  // pointing at the wrong fix.
  const NEEDS: Record<string, { configured: boolean; message: string }> = {
    chirpstack: {
      configured: config.chirpstack !== undefined,
      message:
        'will be SKIPPED: no chirpstack connection configured. Set ' +
        'LEADSMAN_CHIRPSTACK_CONFIG (or a chirpstack block) to enable it',
    },
    hostAddress: {
      configured: config.hostAddress !== undefined,
      message:
        'will be SKIPPED: no host address source configured. Set ' +
        'LEADSMAN_HOST_ADDRESS (or a hostAddress block) to enable it',
    },
    forecast: {
      configured: config.forecast !== undefined,
      message:
        'will be SKIPPED: no forecast provider configured. Add a forecast block ' +
        'with a provider, latitude and longitude, and supply the key as ' +
        'LEADSMAN_WEATHERBIT_API_KEY',
    },
  };

  for (const need of rule.needs ?? []) {
    const entry = NEEDS[need];
    if (!entry) {
      out.push({
        severity: 'error',
        where: `checks.${kind}`,
        message:
          `declares an unknown need "${need}" — verify cannot tell whether it is ` +
          'configured, so it would skip silently at runtime',
      });
      continue;
    }
    if (entry.configured) continue;
    out.push({ severity: 'warning', where: `checks.${kind}`, message: entry.message });
  }
  return out;
}

/** Parameters the config sets that the rule does not have. */
function paramNameProblems(rule: Rule, check: CheckConfig, kind: string): VerifyProblem[] {
  const out: VerifyProblem[] = [];
  // Unknown params are almost always typos, and a typo'd threshold silently
  // falls back to the default, which is the kind of bug that looks like the
  // check "not working" for weeks. That is a config that looks configured and is
  // not — the class lint exists to refuse — so it is an error, not a warning.
  for (const key of Object.keys(check.params ?? {})) {
    if (!(key in rule.defaultParams)) {
      out.push({
        severity: 'error',
        where: `checks.${kind}.params`,
        message:
          `"${key}" is not a parameter of rule "${rule.id}" and would be ignored ` +
          `(known: ${Object.keys(rule.defaultParams).join(', ') || 'none'})`,
      });
    }
  }
  return out;
}

/**
 * Parameter VALUES the rule itself refuses.
 *
 * Every rule validates its own parameters at the top of `run`, and those checks are
 * where the genuinely dangerous configurations are caught — a dwell longer than the
 * window it is measured in, a threshold with neither bound, a gate with no bounds.
 * All of them share one property: the check never fires, and a check that never
 * fires is indistinguishable from a healthy fleet.
 *
 * They are reached here by running the rule against a stub that returns no rows, so
 * the validation executes and the query does not. A rule that gets past validation
 * simply finds nothing and reports nothing, which is the correct outcome for a lint.
 */
async function paramValueProblems(
  rule: Rule,
  check: CheckConfig,
  kind: string,
): Promise<VerifyProblem[]> {
  // A rule with unmet needs is already reported as skipped; running it here would
  // only produce a second, more confusing message about the same thing.
  if ((rule.needs ?? []).length > 0) return [];

  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const ctx: SoundingContext = {
    query: async () => [],
    params: { ...rule.defaultParams, ...(check.params ?? {}) },
    openDevEuis: new Set(),
    openSubjects: new Set(),
    kind,
    now: new Date(),
    gateways: null,
    forecast: null,
    engine: { postmasterStartTime: null, previousRunAt: null, hostAddress: null },
    state: { get: async () => null, set: async () => {} },
    log: quiet,
  };

  try {
    await rule.run(ctx);
    return [];
  } catch (err) {
    return [{
      severity: 'error',
      where: `checks.${kind}.params`,
      message: `rule "${rule.id}" refuses these parameters: ${(err as Error).message}`,
    }];
  }
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

  const tables = await store.describeTables(['public', 'leadsman']);
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

  // Everything that does not need the database, in one place shared with
  // `leadsman lint` — see lintConfig.
  problems.push(...(await lintConfig(config, rules)));

  const enabled = config.checks.filter((c) => c.enabled);
  let verified = 0;
  // Only report each missing table/column once, however many checks want it.
  const reported = new Set<string>();

  for (const check of enabled) {
    const kind = check.as ?? check.rule;
    const rule = rules.get(check.rule);

    // An unknown rule, unmet needs and unknown params are all reported by
    // lintConfig above. Only the schema half belongs here.
    if (!rule) continue;

    for (const req of rule.requires) {
      // An unqualified name means public, where ChirpStack's event tables live. A check
      // reading Leadsman's own tables qualifies them (`leadsman.run`).
      const qualified = req.table.includes('.') ? req.table : `public.${req.table}`;
      const cols = tables.get(qualified);
      const tableKey = `table:${qualified}`;

      if (!cols) {
        if (!reported.has(tableKey)) {
          reported.add(tableKey);
          problems.push({
            severity: 'error',
            where: `rule.${rule.id}`,
            message: `table ${qualified} does not exist or is not readable`,
          });
        }
        continue;
      }

      for (const col of req.columns) {
        const colKey = `column:${qualified}.${col}`;
        if (!cols.has(col) && !reported.has(colKey)) {
          reported.add(colKey);
          problems.push({
            severity: 'error',
            where: `rule.${rule.id}`,
            message:
              `column ${qualified}.${col} does not exist — this ChirpStack ` +
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
