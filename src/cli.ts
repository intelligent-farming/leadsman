#!/usr/bin/env node
/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Command-line entry point.
 *
 *   leadsman list                    what checks are available (the menu)
 *   leadsman verify                  validate config + schema, write nothing
 *   leadsman run [--dry-run]         take one sounding and exit
 *   leadsman serve [--run-on-start]  stay resident, sound on the configured cron
 *   leadsman status                  show currently open alerts
 *   leadsman migrate                 apply migrations/*.sql
 *
 * Config path: --config <path>, else LEADSMAN_CONFIG, else ./config/leadsman.json
 * Database:    LEADSMAN_DATABASE_URL (migrate uses LEADSMAN_MIGRATE_URL if set,
 *              since applying DDL needs the owner role, not the engine role)
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { ConfigError, databaseUrlFromEnv, loadConfig } from './config';
import { Store } from './db';
import { createLogger } from './logger';
import { loadRules, RuleLoadError } from './registry';
import { runSounding } from './runner';
import { serve } from './scheduler';
import { verify } from './verify';

interface Args {
  command: string;
  config: string;
  dryRun: boolean;
  runOnStart: boolean;
  rulesDir: string | null;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help',
    config: process.env.LEADSMAN_CONFIG ?? 'config/leadsman.json',
    dryRun: false,
    runOnStart: false,
    rulesDir: process.env.LEADSMAN_RULES_DIR ?? null,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--config':
      case '-c':
        args.config = argv[++i] ?? args.config;
        break;
      case '--rules-dir':
        args.rulesDir = argv[++i] ?? null;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--run-on-start':
        args.runOnStart = true;
        break;
      case '--json':
        args.json = true;
        break;
      default:
        break;
    }
  }
  return args;
}

const USAGE = `leadsman — scheduled rule engine over ChirpStack telemetry

Usage: leadsman <command> [options]

Commands:
  list                 List available checks and their parameters
  verify               Validate config and database schema (no writes)
  run                  Take one sounding and exit
  serve                Stay resident and sound on the configured schedule
  status               Show currently open alerts
  migrate              Apply migrations/*.sql (needs an owner-role URL)

Options:
  -c, --config <path>  Config file (default: $LEADSMAN_CONFIG or config/leadsman.json)
      --rules-dir <p>  Additional directory of operator-supplied checks
      --dry-run        run: evaluate and report without writing or notifying
      --run-on-start   serve: take a sounding immediately instead of waiting
      --json           Machine-readable output where supported

Environment:
  LEADSMAN_DATABASE_URL   Postgres URL for the engine role (required)
  LEADSMAN_MIGRATE_URL    Owner-role URL for migrate (falls back to the above)
  LEADSMAN_WEBHOOK_TOKEN  Bearer token for notify.webhookUrl, if it needs one
  LEADSMAN_LOG_LEVEL      debug | info | warn | error (default info)
  LEADSMAN_LOG_FORMAT     json | text (default json)
`;

async function cmdList(args: Args): Promise<number> {
  const rules = loadRules({ extraDir: args.rulesDir });
  const sorted = [...rules.values()].sort((a, b) => a.id.localeCompare(b.id));

  if (args.json) {
    process.stdout.write(`${JSON.stringify(sorted.map((r) => ({
      id: r.id,
      description: r.description,
      defaultSeverity: r.defaultSeverity,
      defaultParams: r.defaultParams,
      requires: r.requires,
    })), null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${sorted.length} checks available:\n\n`);
  for (const rule of sorted) {
    process.stdout.write(`  ${rule.id}  [${rule.defaultSeverity}]\n`);
    process.stdout.write(`    ${rule.description}\n`);
    const params = Object.entries(rule.defaultParams);
    if (params.length > 0) {
      process.stdout.write('    params:\n');
      for (const [key, value] of params) {
        process.stdout.write(`      ${key} = ${JSON.stringify(value)}\n`);
      }
    }
    process.stdout.write('\n');
  }
  return 0;
}

async function cmdVerify(args: Args): Promise<number> {
  const config = loadConfig(args.config);
  const rules = loadRules({ extraDir: args.rulesDir });
  const store = new Store({
    connectionString: databaseUrlFromEnv(),
    statementTimeoutMs: config.statementTimeoutMs ?? 15_000,
  });

  try {
    const report = await verify(config, rules, store);

    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return report.ok ? 0 : 1;
    }

    process.stdout.write(
      `database: ${report.database}  role: ${report.user}\n` +
        `leadsman schema: ${report.schemaPresent ? 'present' : 'MISSING'}\n` +
        `checks verified: ${report.checksVerified}\n\n`,
    );
    if (report.problems.length === 0) {
      process.stdout.write('no problems found\n');
    } else {
      for (const p of report.problems) {
        const tag = p.severity === 'error' ? 'ERROR  ' : 'WARNING';
        process.stdout.write(`${tag} ${p.where}: ${p.message}\n`);
      }
      process.stdout.write(
        `\n${report.problems.filter((p) => p.severity === 'error').length} error(s), ` +
          `${report.problems.filter((p) => p.severity === 'warning').length} warning(s)\n`,
      );
    }
    return report.ok ? 0 : 1;
  } finally {
    await store.close();
  }
}

async function cmdRun(args: Args): Promise<number> {
  const config = loadConfig(args.config);
  const rules = loadRules({ extraDir: args.rulesDir });
  const log = createLogger();
  const store = new Store({
    connectionString: databaseUrlFromEnv(),
    statementTimeoutMs: config.statementTimeoutMs ?? 15_000,
  });

  try {
    const summary = await runSounding({ config, rules, store, log, dryRun: args.dryRun });
    if (args.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    // Non-zero when a check failed, so a cron wrapper or healthcheck notices.
    return summary.errors > 0 ? 1 : 0;
  } finally {
    await store.close();
  }
}

async function cmdServe(args: Args): Promise<number> {
  const config = loadConfig(args.config);
  const rules = loadRules({ extraDir: args.rulesDir });
  const log = createLogger();
  const store = new Store({
    connectionString: databaseUrlFromEnv(),
    statementTimeoutMs: config.statementTimeoutMs ?? 15_000,
  });

  // Fail fast rather than discovering a bad schema on the first scheduled tick.
  const report = await verify(config, rules, store);
  for (const p of report.problems) {
    if (p.severity === 'error') log.error('verify', { where: p.where, message: p.message });
    else log.warn('verify', { where: p.where, message: p.message });
  }
  if (!report.ok) {
    log.error('refusing to start — fix the errors above or run "leadsman verify"');
    await store.close();
    return 1;
  }

  const handle = serve({ config, rules, store, log, runOnStart: args.runOnStart });

  await new Promise<void>((resolve) => {
    const shutdown = (signal: string) => {
      log.info('shutting down', { signal });
      handle
        .stop()
        .catch(() => undefined)
        .finally(() => resolve());
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  });

  await store.close();
  return 0;
}

async function cmdStatus(args: Args): Promise<number> {
  const config = loadConfig(args.config);
  const store = new Store({
    connectionString: databaseUrlFromEnv(),
    statementTimeoutMs: config.statementTimeoutMs ?? 15_000,
  });

  try {
    const open = await store.listOpenAlerts();
    if (args.json) {
      process.stdout.write(`${JSON.stringify(open, null, 2)}\n`);
      return 0;
    }
    if (open.length === 0) {
      process.stdout.write('no open alerts\n');
      return 0;
    }
    process.stdout.write(`${open.length} open alert(s):\n\n`);
    for (const a of open) {
      const sent = a.notified_at ? 'notified' : 'pending';
      process.stdout.write(
        `  [${a.severity}] ${a.kind}  ${a.dev_eui}  (${sent})\n    ${a.summary}\n` +
          `    since ${a.raised_at}\n\n`,
      );
    }
    return 0;
  } finally {
    await store.close();
  }
}

async function cmdMigrate(): Promise<number> {
  // DDL needs the owner role; the engine role deliberately cannot create schemas.
  const url = process.env.LEADSMAN_MIGRATE_URL ?? process.env.LEADSMAN_DATABASE_URL;
  if (!url) {
    process.stderr.write('LEADSMAN_MIGRATE_URL (or LEADSMAN_DATABASE_URL) is not set\n');
    return 1;
  }

  // Packaged alongside dist/, and available from the repo root in development.
  const candidates = [join(__dirname, '..', 'migrations'), join(process.cwd(), 'migrations')];
  let dir: string | null = null;
  let files: string[] = [];
  for (const c of candidates) {
    try {
      const found = readdirSync(c).filter((f) => f.endsWith('.sql')).sort();
      if (found.length > 0) {
        dir = c;
        files = found;
        break;
      }
    } catch {
      /* try the next candidate */
    }
  }
  if (!dir) {
    process.stderr.write(`no migrations/*.sql found (looked in: ${candidates.join(', ')})\n`);
    return 1;
  }

  const client = new Client({ connectionString: url, application_name: 'leadsman-migrate' });
  await client.connect();
  try {
    for (const file of files) {
      // 002 touches ChirpStack-owned tables; make the operator opt in explicitly.
      if (file.startsWith('002_') && process.env.LEADSMAN_APPLY_EVENT_INDEXES !== 'true') {
        process.stdout.write(
          `skipped ${file} (indexes ChirpStack-owned tables — ` +
            `set LEADSMAN_APPLY_EVENT_INDEXES=true to apply)\n`,
        );
        continue;
      }
      const sql = readFileSync(join(dir, file), 'utf8');
      process.stdout.write(`applying ${file} ... `);
      await client.query(sql);
      process.stdout.write('ok\n');
    }
    return 0;
  } finally {
    await client.end();
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'list':
      return cmdList(args);
    case 'verify':
      return cmdVerify(args);
    case 'run':
      return cmdRun(args);
    case 'serve':
      return cmdServe(args);
    case 'status':
      return cmdStatus(args);
    case 'migrate':
      return cmdMigrate();
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`unknown command "${args.command}"\n\n${USAGE}`);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    // Config and rule-loading problems are operator errors, not crashes — report
    // them as one clear line rather than a stack trace.
    if (err instanceof ConfigError || err instanceof RuleLoadError) {
      process.stderr.write(`${err.name}: ${err.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  });
