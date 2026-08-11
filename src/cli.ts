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
import { Store, type RaisedAlert } from './db';
import { createLogger } from './logger';
import { loadRules, RuleLoadError } from './registry';
import { notifyRaised } from './notify';
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
  /** test-notify: limit to one destination. */
  to: string | null;
}

/**
 * Map a leading flag to the command it stands for.
 *
 * Anything starting with "-" otherwise falls through to `help`, which is why `--help` and
 * `-h` appear to work by accident. `--version` needed to be listed explicitly or it would
 * print the usage text and look like an unsupported flag.
 */
function commandFromFlag(flag: string): string {
  if (flag === '--version' || flag === '-v') return 'version';
  return 'help';
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: argv[0] && !argv[0].startsWith('-') ? argv[0] : commandFromFlag(argv[0] ?? ''),
    config: process.env.LEADSMAN_CONFIG ?? 'config/leadsman.json',
    dryRun: false,
    runOnStart: false,
    rulesDir: process.env.LEADSMAN_RULES_DIR ?? null,
    json: false,
    to: null,
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
      case '--to':
        args.to = argv[++i] ?? null;
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
  test-notify          Send a synthetic alert to every destination (no database needed)
  version              Print the engine version

Options:
  -c, --config <path>  Config file (default: $LEADSMAN_CONFIG or config/leadsman.json)
      --rules-dir <p>  Additional directory of operator-supplied checks
      --dry-run        run: evaluate and report without writing or notifying
      --run-on-start   serve: take a sounding immediately instead of waiting
      --json           Machine-readable output where supported
      --to <name>      test-notify: only this destination

Environment:
  LEADSMAN_DATABASE_URL   Postgres URL for the engine role (required)
  LEADSMAN_MIGRATE_URL    Owner-role URL for migrate (falls back to the above)
  LEADSMAN_WEBHOOK_TOKEN  Shared secret for webhook destinations (see README)
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
    log,
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
    log,
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

/**
 * Package version, read from package.json at runtime.
 *
 * Read rather than compiled in so it cannot drift from what npm or the image actually
 * shipped — a hardcoded string is exactly the thing that goes stale and then misreports
 * which config features are supported. dist/ sits one level below the package root, and
 * this build is CommonJS, so __dirname is the right anchor.
 */
function version(): string {
  try {
    const raw = readFileSync(join(__dirname, '..', 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Send a synthetic alert through the real delivery path.
 *
 * Deliberately needs no database. Setting up Telegram (bot token + a chat id you have to go
 * and find), Signal (a signal-cli-rest-api you host and register), or Twilio (a key and a
 * verified recipient) is fiddly, and the alternative to this command is waiting for a real
 * alert to discover you got one field wrong. Nothing is written: the store is a stub, so no
 * alert row is created and no notified_at is stamped.
 */
async function cmdTestNotify(args: Args): Promise<number> {
  const config = loadConfig(args.config);
  const log = createLogger();

  if (!config.notify) {
    process.stderr.write(
      'no notify block in the config — nothing to test. Add notify.destinations first.\n',
    );
    return 2;
  }
  const names = Object.keys(config.notify.destinations);
  const targets = args.to ? [args.to] : names;
  const unknown = targets.filter((t) => !names.includes(t));
  if (unknown.length > 0) {
    process.stderr.write(
      `unknown destination "${unknown[0]}" — this config defines: ${names.join(', ')}\n`,
    );
    return 2;
  }

  // Obviously-synthetic so a recipient cannot mistake it for a real fault.
  const sample: RaisedAlert = {
    id: 'test',
    ruleId: 'test-notify',
    kind: 'test-notify',
    devEui: '0000000000000000',
    deviceName: 'leadsman test',
    severity: 'info',
    summary: 'test message from leadsman — delivery is configured correctly, no fault detected',
    detail: { test: true, sentAt: new Date().toISOString() },
    raisedAt: new Date().toISOString(),
  };

  // markNotified must not touch a database: this command is for people who have not
  // necessarily run migrate yet.
  const stubStore = { markNotified: async () => undefined } as unknown as Store;

  let failed = 0;
  for (const name of targets) {
    const dest = config.notify.destinations[name];
    const provider = dest.provider ?? 'webhook';
    process.stdout.write(`sending to "${name}" (${provider}) ... `);
    // Route explicitly at this one destination, bypassing the fact/situation rules — the
    // question here is "does this destination work", not "where would an alert go".
    const outcome = await notifyRaised(
      [sample],
      { ...config.notify, destinations: { [name]: dest } },
      stubStore,
      log,
      new Map([['test-notify', { notifyTo: name, routing: 'fact' as const }]]),
    );
    if (outcome.delivered === 1) {
      process.stdout.write('delivered\n');
    } else {
      failed += 1;
      process.stdout.write('FAILED (see the warning above for the reason)\n');
    }
  }

  if (failed > 0) {
    process.stdout.write(`\n${failed} of ${targets.length} destination(s) failed\n`);
    return 1;
  }
  process.stdout.write(`\n${targets.length} destination(s) ok\n`);
  return 0;
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
    case 'test-notify':
      return cmdTestNotify(args);
    case 'version':
    case '--version':
    case '-v':
      // Worth a command of its own: config features are gated by version (named
      // destinations and the messaging providers need >= 0.2.0), and an older engine
      // silently ignores unknown config keys rather than complaining — so "why is nothing
      // being delivered" is answered by this one line more often than by any log.
      process.stdout.write(`${version()}\n`);
      return 0;
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
