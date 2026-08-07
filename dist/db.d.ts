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
import type { CheckResult, Finding, Severity } from './types';
export interface OpenAlert {
    id: string;
    devEui: string;
    kind: string;
}
/** An alert row as newly raised — the payload handed to the notifier. */
export interface RaisedAlert {
    id: string;
    ruleId: string;
    kind: string;
    devEui: string;
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
}
export declare class Store {
    private readonly pool;
    constructor(options: StoreOptions);
    close(): Promise<void>;
    /** Fail fast with a clear message if the engine cannot reach or read the store. */
    verifyConnection(): Promise<{
        database: string;
        user: string;
        version: string;
    }>;
    /** True if the leadsman schema and alert table are present. */
    hasSchema(): Promise<boolean>;
    /**
     * Which tables and columns actually exist in `public`. Used by `leadsman verify`
     * to compare a check's declared requirements against the live ChirpStack schema,
     * so a version difference is reported up front rather than as a runtime error.
     */
    describePublicSchema(): Promise<Map<string, Set<string>>>;
    /** Read-only query handed to checks via the sounding context. */
    query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<T[]>;
    /** DevEUIs with an open alert for this kind — the hysteresis input. */
    openDevEuis(kind: string): Promise<Set<string>>;
    /**
     * Apply one check's findings.
     *
     * Runs in a transaction so a partially-applied sounding cannot leave alerts in a
     * state where some devices were resolved but their replacements never raised.
     */
    reconcile(ruleId: string, kind: string, defaultSeverity: Severity, findings: Finding[]): Promise<{
        raised: RaisedAlert[];
        resolved: number;
        touched: number;
    }>;
    /** Mark an alert delivered. Called by the notifier, not by checks. */
    markNotified(alertId: string): Promise<void>;
    /** Record a check execution for observability. Never throws into the caller. */
    recordRun(result: CheckResult, startedAt: Date): Promise<void>;
    /** Open alerts across all kinds — for `leadsman status`. */
    listOpenAlerts(limit?: number): Promise<Array<{
        kind: string;
        dev_eui: string;
        device_name: string | null;
        severity: string;
        summary: string;
        raised_at: string;
        notified_at: string | null;
    }>>;
}
//# sourceMappingURL=db.d.ts.map