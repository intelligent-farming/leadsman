/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Database access and the alert raise/resolve lifecycle.
 *
 * Checks report what is currently in breach; this module turns that into durable,
 * deduplicated alert rows. The rules:
 *
 *   - A finding for a (subject, kind) with no open alert    → raise (INSERT)
 *   - A finding for a (subject, kind) already open          → touch (bump last_seen_at)
 *   - An open alert whose subject is no longer reported     → resolve
 *
 * The `alert_open_subject_uniq` partial index enforces at most one open row per
 * (subject_kind, subject_id, kind), so this is safe under concurrent soundings and a
 * flapping sensor cannot fan out into repeated notifications.
 *
 * A subject is usually a device, but may be a gateway, the site, or the engine — see
 * SubjectKind in types.ts. dev_eui/device_name are still written for device subjects and
 * left NULL otherwise, so consumers that predate subjects keep working.
 */

import { Pool, type PoolClient } from 'pg';
import { subjectOf } from './subject';
import type { CheckResult, Finding, Logger, Severity, SubjectKind } from './types';

export interface OpenAlert {
  id: string;
  devEui: string;
  kind: string;
}

/** An alert row awaiting delivery — the payload handed to the notifier. */
export interface RaisedAlert {
  id: string;
  ruleId: string;
  kind: string;
  subjectKind: SubjectKind;
  subjectId: string;
  subjectName: string | null;
  /** Populated for device subjects only, so existing webhook receivers see no change. */
  devEui: string | null;
  deviceName: string | null;
  severity: Severity;
  summary: string;
  detail: Record<string, unknown>;
  raisedAt: string;
}


export interface StoreOptions {
  connectionString: string;
  statementTimeoutMs: number;
  /** Small by design: soundings run sequentially, so 2 is plenty. */
  maxConnections?: number;
  /**
   * Where to report errors raised by IDLE pooled connections — see the constructor. Optional
   * only so short-lived callers (migrate, one-shot scripts) need not build a logger; when it
   * is absent the message still reaches stderr rather than being swallowed.
   */
  log?: Pick<Logger, 'warn'>;
}

export class Store {
  private readonly pool: Pool;

  constructor(options: StoreOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.maxConnections ?? 2,
      // Applied per connection by Postgres itself. This is the ceiling that keeps a
      // pathological sounding from monopolising a shared CPU — it aborts the query
      // rather than letting it starve ChirpStack's ingestion.
      statement_timeout: options.statementTimeoutMs,
      // A sounding is short-lived; do not hold idle connections open on a small box.
      idleTimeoutMillis: 10_000,
      application_name: 'leadsman',
    });

    // REQUIRED, not defensive. node-postgres emits 'error' on the Pool when an IDLE client
    // dies — exactly what happens when Postgres restarts under a long-running `serve`. An
    // EventEmitter 'error' with no listener becomes an uncaught exception, so without this the
    // engine exits(1) on any transient database outage: an upgrade, a reboot ordering race,
    // the OOM killer on a small box. Docker's restart policy brings it back, but only after a
    // crash loop, with the healthcheck flapping and soundings missed in between.
    //
    // Logging and continuing is the correct response: the pool has already discarded the bad
    // client, and the next query transparently acquires a fresh one.
    this.pool.on('error', (err) => {
      const message = `idle database connection error (pool recovered): ${err.message}`;
      if (options.log) options.log.warn(message);
      else process.stderr.write(`${message}\n`);
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Fail fast with a clear message if the engine cannot reach or read the store. */
  async verifyConnection(): Promise<{ database: string; user: string; version: string }> {
    const { rows } = await this.pool.query<{
      database: string;
      user: string;
      version: string;
    }>('SELECT current_database() AS database, current_user AS user, version() AS version');
    return rows[0];
  }

  /** True if the leadsman schema and alert table are present. */
  async hasSchema(): Promise<boolean> {
    const { rows } = await this.pool.query<{ present: boolean }>(
      `SELECT to_regclass('leadsman.alert') IS NOT NULL AS present`,
    );
    return rows[0]?.present === true;
  }

  /**
   * Which tables and columns actually exist in `public`. Used by `leadsman verify`
   * to compare a check's declared requirements against the live ChirpStack schema,
   * so a version difference is reported up front rather than as a runtime error.
   */
  async describePublicSchema(): Promise<Map<string, Set<string>>> {
    const { rows } = await this.pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position`,
    );
    const map = new Map<string, Set<string>>();
    for (const row of rows) {
      let cols = map.get(row.table_name);
      if (!cols) {
        cols = new Set<string>();
        map.set(row.table_name, cols);
      }
      cols.add(row.column_name);
    }
    return map;
  }

  /**
   * Tables and columns across several schemas, keyed `schema.table`.
   *
   * `describePublicSchema` above covers the ChirpStack event tables, which is all a
   * check needed while every check read telemetry. Some now read Leadsman's own tables
   * instead — host-restarted needs `leadsman.run` to say how long the gap was — and
   * those live in a different schema, so a bare table name is no longer enough to
   * identify what a rule requires.
   */
  async describeTables(schemas: string[]): Promise<Map<string, Set<string>>> {
    const { rows } = await this.pool.query<{
      table_schema: string;
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_schema, table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = ANY($1::text[])
        ORDER BY table_schema, table_name, ordinal_position`,
      [schemas],
    );
    const map = new Map<string, Set<string>>();
    for (const row of rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      let cols = map.get(key);
      if (!cols) {
        cols = new Set<string>();
        map.set(key, cols);
      }
      cols.add(row.column_name);
    }
    return map;
  }

  /** Read-only query handed to checks via the sounding context. */
  async query<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
    const { rows } = await this.pool.query(sql, values);
    return rows as T[];
  }

  /** Subject ids with an open alert for this kind — the hysteresis input. */
  async openSubjects(kind: string): Promise<Set<string>> {
    const rows = await this.query<{ subject_id: string }>(
      `SELECT subject_id FROM leadsman.alert WHERE kind = $1 AND resolved_at IS NULL`,
      [kind],
    );
    return new Set(rows.map((r) => r.subject_id));
  }

  /** Kinds that currently have at least one open alert — the suppression input. */
  async openKinds(): Promise<Set<string>> {
    const rows = await this.query<{ kind: string }>(
      `SELECT DISTINCT kind FROM leadsman.alert WHERE resolved_at IS NULL`,
    );
    return new Set(rows.map((r) => r.kind));
  }

  /**
   * When the event store's Postgres last started.
   *
   * The cheapest possible restart detector: no privileges, no extension, one function
   * every role can call. On a single-box deployment the events database restarting means
   * the box restarted, which is what makes a power cut visible after the fact.
   */
  async postmasterStartTime(): Promise<string | null> {
    const rows = await this.query<{ started: string | null }>(
      `SELECT pg_postmaster_start_time()::text AS started`,
    );
    return rows[0]?.started ?? null;
  }

  /** The most recent completed sounding, ignoring the one now in progress. */
  async previousRunAt(): Promise<string | null> {
    const rows = await this.query<{ at: string | null }>(
      `SELECT max(finished_at)::text AS at FROM leadsman.run WHERE finished_at IS NOT NULL`,
    );
    return rows[0]?.at ?? null;
  }

  /** Read one cross-sounding scalar. Null when never written. */
  async getEngineState(key: string): Promise<{ value: string | null; seenAt: string } | null> {
    const rows = await this.query<{ value: string | null; seen_at: string }>(
      `SELECT value, seen_at::text AS seen_at FROM leadsman.engine_state WHERE key = $1`,
      [key],
    );
    const row = rows[0];
    return row ? { value: row.value, seenAt: row.seen_at } : null;
  }

  /** Write one cross-sounding scalar. */
  async setEngineState(key: string, value: string | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO leadsman.engine_state (key, value, seen_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, seen_at = now()`,
      [key, value],
    );
  }

  /**
   * Apply one check's findings.
   *
   * Runs in a transaction so a partially-applied sounding cannot leave alerts in a
   * state where some devices were resolved but their replacements never raised.
   */
  async reconcile(
    ruleId: string,
    kind: string,
    defaultSeverity: Severity,
    findings: Finding[],
  ): Promise<{ raised: RaisedAlert[]; resolved: number; touched: number }> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const raised: RaisedAlert[] = [];
      let touched = 0;

      const present: string[] = [];

      for (const finding of findings) {
        const subject = subjectOf(finding);
        // The runner filters these out before we get here; belt and braces, because a
        // null subject_id would violate the column's NOT NULL and abort the sounding.
        if (!subject) continue;
        present.push(subject.id);

        const severity = finding.severity ?? defaultSeverity;
        const detail = finding.detail ?? {};
        const isDevice = subject.kind === 'device';
        const subjectName = subject.name ?? finding.deviceName ?? null;

        // ON CONFLICT against the partial unique index: an existing open alert is
        // updated in place (keeping raised_at, so `open_for` stays meaningful). A fresh
        // one reports inserted = true.
        const { rows } = await client.query<{
          id: string;
          raised_at: string;
          inserted: boolean;
        }>(
          `INSERT INTO leadsman.alert
             (rule_id, kind, subject_kind, subject_id, subject_name,
              dev_eui, device_name, severity, summary, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
           ON CONFLICT (subject_kind, subject_id, kind) WHERE resolved_at IS NULL
           DO UPDATE SET last_seen_at = now(),
                         summary      = EXCLUDED.summary,
                         detail       = EXCLUDED.detail,
                         severity     = EXCLUDED.severity,
                         subject_name = COALESCE(EXCLUDED.subject_name, leadsman.alert.subject_name),
                         device_name  = COALESCE(EXCLUDED.device_name, leadsman.alert.device_name)
           RETURNING id,
                     raised_at,
                     (xmax = 0) AS inserted`,
          [
            ruleId,
            kind,
            subject.kind,
            subject.id,
            subjectName,
            isDevice ? subject.id : null,
            isDevice ? subjectName : null,
            severity,
            finding.summary,
            JSON.stringify(detail),
          ],
        );

        const row = rows[0];
        if (row?.inserted) {
          raised.push({
            id: row.id,
            ruleId,
            kind,
            subjectKind: subject.kind,
            subjectId: subject.id,
            subjectName,
            devEui: isDevice ? subject.id : null,
            deviceName: isDevice ? subjectName : null,
            severity,
            summary: finding.summary,
            detail,
            raisedAt: row.raised_at,
          });
        } else {
          touched += 1;
        }
      }

      // Auto-resolve: anything open for this kind whose subject the check no longer
      // reports. Passing the present list as a text[] keeps this a single statement.
      const { rowCount } = await client.query(
        `UPDATE leadsman.alert
            SET resolved_at = now()
          WHERE kind = $1
            AND resolved_at IS NULL
            AND NOT (subject_id = ANY($2::text[]))`,
        [kind, present],
      );

      await client.query('COMMIT');
      return { raised, resolved: rowCount ?? 0, touched };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {
        /* the original error is the one worth surfacing */
      });
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Everything open, undelivered and unsuppressed — what the notifier should send.
   *
   * Delivery used to work from `reconcile`'s newly-inserted rows alone, which had two
   * consequences. A delivery that failed was never offered again: the next sounding's
   * ON CONFLICT took the DO UPDATE branch, so the alert was not "new" any more and its
   * NULL notified_at was never revisited — the retry that the docs describe could not
   * happen, and a storm that throttled Twilio or Slack lost those alerts permanently.
   * And an alert withheld by suppression could never be released later.
   *
   * Selecting the pending set instead fixes both: notified_at is the only record of
   * delivery, so anything still lacking one gets another attempt, and an alert stops
   * being suppressed the moment its suppressor resolves.
   */
  async listPendingNotify(limit = 200): Promise<RaisedAlert[]> {
    const rows = await this.query<{
      id: string;
      rule_id: string;
      kind: string;
      subject_kind: SubjectKind;
      subject_id: string;
      subject_name: string | null;
      dev_eui: string | null;
      device_name: string | null;
      severity: Severity;
      summary: string;
      detail: Record<string, unknown> | null;
      raised_at: string;
    }>(
      `SELECT id, rule_id, kind, subject_kind, subject_id, subject_name,
              dev_eui, device_name, severity, summary, detail, raised_at::text AS raised_at
         FROM leadsman.alert
        WHERE resolved_at IS NULL
          AND notified_at IS NULL
          AND suppressed_at IS NULL
        ORDER BY
          CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
          raised_at ASC
        LIMIT $1`,
      [limit],
    );

    return rows.map((r) => ({
      id: r.id,
      ruleId: r.rule_id,
      kind: r.kind,
      subjectKind: r.subject_kind,
      subjectId: r.subject_id,
      subjectName: r.subject_name,
      devEui: r.dev_eui,
      deviceName: r.device_name,
      severity: r.severity,
      summary: r.summary,
      detail: r.detail ?? {},
      raisedAt: r.raised_at,
    }));
  }

  /** Mark an alert delivered. Called by the notifier, not by checks. */
  async markNotified(alertId: string): Promise<void> {
    await this.pool.query(
      `UPDATE leadsman.alert SET notified_at = now() WHERE id = $1 AND notified_at IS NULL`,
      [alertId],
    );
  }

  /**
   * Withhold an alert because an open alert of another kind already explains it, or
   * release one whose explanation has resolved.
   *
   * `detail.suppressedBy` records which kind did it, so nothing about this is invisible:
   * the alert is in `leadsman status` and in `open_alert` throughout, just not delivered.
   */
  async setSuppressed(alertId: string, byKind: string | null): Promise<void> {
    if (byKind === null) {
      await this.pool.query(
        `UPDATE leadsman.alert
            SET suppressed_at = NULL,
                detail        = detail - 'suppressedBy'
          WHERE id = $1`,
        [alertId],
      );
      return;
    }
    await this.pool.query(
      `UPDATE leadsman.alert
          SET suppressed_at = COALESCE(suppressed_at, now()),
              detail        = detail || jsonb_build_object('suppressedBy', $2::text)
        WHERE id = $1`,
      [alertId, byKind],
    );
  }

  /**
   * Open alerts that are currently suppressed, with the kind that suppressed them.
   * The release check reads this: a suppressor that has resolved no longer justifies
   * holding anything back.
   */
  async listSuppressed(): Promise<Array<{ id: string; kind: string; suppressedBy: string | null }>> {
    const rows = await this.query<{ id: string; kind: string; suppressed_by: string | null }>(
      `SELECT id, kind, detail->>'suppressedBy' AS suppressed_by
         FROM leadsman.alert
        WHERE resolved_at IS NULL AND suppressed_at IS NOT NULL`,
    );
    return rows.map((r) => ({ id: r.id, kind: r.kind, suppressedBy: r.suppressed_by }));
  }

  /** Record a check execution for observability. Never throws into the caller. */
  async recordRun(result: CheckResult, startedAt: Date): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO leadsman.run
           (rule_id, kind, started_at, finished_at, duration_ms, status, findings, raised, resolved, error)
         VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8, $9)`,
        [
          result.ruleId,
          result.kind,
          startedAt.toISOString(),
          Math.round(result.durationMs),
          result.status,
          result.findings,
          result.raised,
          result.resolved,
          result.error ?? null,
        ],
      );
    } catch {
      // Losing a run-log row must not fail the sounding that produced it.
    }
  }

  /** Open alerts across all kinds — for `leadsman status`. */
  async listOpenAlerts(limit = 100): Promise<
    Array<{
      kind: string;
      subject_kind: SubjectKind;
      subject_id: string;
      subject_name: string | null;
      dev_eui: string | null;
      device_name: string | null;
      severity: string;
      summary: string;
      raised_at: string;
      notified_at: string | null;
      suppressed_at: string | null;
    }>
  > {
    return this.query(
      `SELECT kind, subject_kind, subject_id, subject_name, dev_eui, device_name,
              severity, summary, raised_at, notified_at, suppressed_at
         FROM leadsman.open_alert
        ORDER BY
          CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
          raised_at DESC
        LIMIT $1`,
      [limit],
    );
  }
}
