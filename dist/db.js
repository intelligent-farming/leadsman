"use strict";
/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Database access and the alert raise/resolve lifecycle.
 *
 * Checks report what is currently in breach; this module turns that into durable,
 * deduplicated alert rows. The rules:
 *
 *   - A finding for a (dev_eui, kind) with no open alert    → raise (INSERT)
 *   - A finding for a (dev_eui, kind) already open          → touch (bump last_seen_at)
 *   - An open alert whose device is no longer reported      → resolve
 *
 * The `alert_open_uniq` partial index enforces at most one open row per
 * (dev_eui, kind), so this is safe under concurrent soundings and a flapping
 * sensor cannot fan out into repeated notifications.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.Store = void 0;
const pg_1 = require("pg");
class Store {
    constructor(options) {
        this.pool = new pg_1.Pool({
            connectionString: options.connectionString,
            max: options.maxConnections ?? 2,
            // Applied per connection by Postgres itself. This is the ceiling that keeps a
            // pathological sounding from monopolising a shared CPU — it aborts the query
            // rather than letting it starve ChirpStack's ingestion.
            statement_timeout: options.statementTimeoutMs,
            // A sounding is short-lived; do not hold idle connections open on a small box.
            idleTimeoutMillis: 10000,
            application_name: 'leadsman',
        });
    }
    async close() {
        await this.pool.end();
    }
    /** Fail fast with a clear message if the engine cannot reach or read the store. */
    async verifyConnection() {
        const { rows } = await this.pool.query('SELECT current_database() AS database, current_user AS user, version() AS version');
        return rows[0];
    }
    /** True if the leadsman schema and alert table are present. */
    async hasSchema() {
        const { rows } = await this.pool.query(`SELECT to_regclass('leadsman.alert') IS NOT NULL AS present`);
        return rows[0]?.present === true;
    }
    /**
     * Which tables and columns actually exist in `public`. Used by `leadsman verify`
     * to compare a check's declared requirements against the live ChirpStack schema,
     * so a version difference is reported up front rather than as a runtime error.
     */
    async describePublicSchema() {
        const { rows } = await this.pool.query(`SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position`);
        const map = new Map();
        for (const row of rows) {
            let cols = map.get(row.table_name);
            if (!cols) {
                cols = new Set();
                map.set(row.table_name, cols);
            }
            cols.add(row.column_name);
        }
        return map;
    }
    /** Read-only query handed to checks via the sounding context. */
    async query(sql, values = []) {
        const { rows } = await this.pool.query(sql, values);
        return rows;
    }
    /** DevEUIs with an open alert for this kind — the hysteresis input. */
    async openDevEuis(kind) {
        const rows = await this.query(`SELECT dev_eui FROM leadsman.alert WHERE kind = $1 AND resolved_at IS NULL`, [kind]);
        return new Set(rows.map((r) => r.dev_eui));
    }
    /**
     * Apply one check's findings.
     *
     * Runs in a transaction so a partially-applied sounding cannot leave alerts in a
     * state where some devices were resolved but their replacements never raised.
     */
    async reconcile(ruleId, kind, defaultSeverity, findings) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const raised = [];
            let touched = 0;
            for (const finding of findings) {
                const severity = finding.severity ?? defaultSeverity;
                const detail = finding.detail ?? {};
                // ON CONFLICT against the partial unique index: an existing open alert is
                // updated in place (keeping raised_at, so `open_for` stays meaningful) and
                // returns nothing new to notify. A fresh one is inserted and returned.
                const { rows } = await client.query(`INSERT INTO leadsman.alert
             (rule_id, kind, dev_eui, device_name, severity, summary, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
           ON CONFLICT (dev_eui, kind) WHERE resolved_at IS NULL
           DO UPDATE SET last_seen_at = now(),
                         summary      = EXCLUDED.summary,
                         detail       = EXCLUDED.detail,
                         severity     = EXCLUDED.severity,
                         device_name  = COALESCE(EXCLUDED.device_name, leadsman.alert.device_name)
           RETURNING id,
                     raised_at,
                     (xmax = 0) AS inserted`, [
                    ruleId,
                    kind,
                    finding.devEui,
                    finding.deviceName ?? null,
                    severity,
                    finding.summary,
                    JSON.stringify(detail),
                ]);
                const row = rows[0];
                if (row?.inserted) {
                    raised.push({
                        id: row.id,
                        ruleId,
                        kind,
                        devEui: finding.devEui,
                        deviceName: finding.deviceName ?? null,
                        severity,
                        summary: finding.summary,
                        detail,
                        raisedAt: row.raised_at,
                    });
                }
                else {
                    touched += 1;
                }
            }
            // Auto-resolve: anything open for this kind that the check no longer reports.
            // Passing the present list as a text[] keeps this a single statement.
            const present = findings.map((f) => f.devEui);
            const { rowCount } = await client.query(`UPDATE leadsman.alert
            SET resolved_at = now()
          WHERE kind = $1
            AND resolved_at IS NULL
            AND NOT (dev_eui = ANY($2::text[]))`, [kind, present]);
            await client.query('COMMIT');
            return { raised, resolved: rowCount ?? 0, touched };
        }
        catch (err) {
            await client.query('ROLLBACK').catch(() => {
                /* the original error is the one worth surfacing */
            });
            throw err;
        }
        finally {
            client.release();
        }
    }
    /** Mark an alert delivered. Called by the notifier, not by checks. */
    async markNotified(alertId) {
        await this.pool.query(`UPDATE leadsman.alert SET notified_at = now() WHERE id = $1 AND notified_at IS NULL`, [alertId]);
    }
    /** Record a check execution for observability. Never throws into the caller. */
    async recordRun(result, startedAt) {
        try {
            await this.pool.query(`INSERT INTO leadsman.run
           (rule_id, kind, started_at, finished_at, duration_ms, status, findings, raised, resolved, error)
         VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8, $9)`, [
                result.ruleId,
                result.kind,
                startedAt.toISOString(),
                Math.round(result.durationMs),
                result.status,
                result.findings,
                result.raised,
                result.resolved,
                result.error ?? null,
            ]);
        }
        catch {
            // Losing a run-log row must not fail the sounding that produced it.
        }
    }
    /** Open alerts across all kinds — for `leadsman status`. */
    async listOpenAlerts(limit = 100) {
        return this.query(`SELECT kind, dev_eui, device_name, severity, summary, raised_at, notified_at
         FROM leadsman.open_alert
        ORDER BY
          CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
          raised_at DESC
        LIMIT $1`, [limit]);
    }
}
exports.Store = Store;
//# sourceMappingURL=db.js.map