/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * The contract between the engine and a check script.
 *
 * A check is a stateless predicate over current telemetry: given a database it
 * can read and some parameters, return the devices that are *currently* in
 * breach. It does not decide whether that is new, whether anyone has been told,
 * or when to stop caring — the engine reconciles findings against open alerts and
 * owns the raise/resolve lifecycle. Keeping checks stateless is what makes them
 * safe to add, remove, and reorder from a config file.
 */
export type Severity = 'info' | 'warning' | 'critical';
/** A device that a check found to be in breach on this run. */
export interface Finding {
    /** DevEUI, lowercase hex. The stable device identity — device_name is mutable. */
    devEui: string;
    /** Human-readable device name at time of sounding, if the row carried one. */
    deviceName?: string | null;
    /** One line, suitable for an SMS body. No trailing period needed. */
    summary: string;
    /** Overrides the check's default severity for this particular finding. */
    severity?: Severity;
    /**
     * Structured context — measured value, threshold, sample count. Keep it small:
     * this is the payload a notifier or an agent receives, and every field costs
     * tokens if a model reads it.
     */
    detail?: Record<string, unknown>;
}
/** Minimal logger, so checks don't take a dependency on a logging library. */
export interface Logger {
    debug(msg: string, meta?: Record<string, unknown>): void;
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
    /**
     * Optional: return a logger that tags every line with `bindings`. The engine uses
     * it to label output with the current check, and falls back to the parent logger
     * when an implementation doesn't provide it — so a caller passing a bare console
     * shim still works.
     */
    child?(bindings: Record<string, unknown>): Logger;
}
/** What the engine hands a check on each sounding. */
export interface SoundingContext {
    /**
     * Parameterized read-only query against the event store. Always pass values as
     * `$1`-style parameters; never interpolate into SQL. A statement timeout is
     * already applied at the connection level.
     */
    query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<T[]>;
    /** Config `params` merged over the check's `defaultParams`. */
    params: Record<string, unknown>;
    /**
     * DevEUIs that currently have an open alert for *this* check's kind. Checks that
     * implement hysteresis use this to widen their predicate for devices already in
     * breach: raise at one threshold, clear at a looser one, so a value sitting on
     * the boundary does not oscillate.
     */
    openDevEuis: ReadonlySet<string>;
    /** The configured instance name for this check — also the alert `kind`. */
    kind: string;
    /** Wall clock at the start of the sounding. Prefer SQL `now()` for time math. */
    now: Date;
    log: Logger;
}
/** A table plus the columns a check reads, for `leadsman verify`. */
export interface SchemaRequirement {
    table: string;
    columns: string[];
}
/** A check script. Modules in src/rules/ default-export one of these. */
export interface Rule {
    /** Stable identifier, matching the filename. Referenced by config `rule`. */
    id: string;
    /** One or two sentences: what it detects and when you would enable it. */
    description: string;
    /** Applied to findings that don't set their own. */
    defaultSeverity: Severity;
    /** Merged under config `params`. Every parameter must have a default. */
    defaultParams: Record<string, unknown>;
    /**
     * Tables and columns this check reads. `leadsman verify` compares these against
     * the live database and reports mismatches, so a ChirpStack schema difference
     * surfaces as a clear message rather than a runtime SQL error at 3am.
     */
    requires: SchemaRequirement[];
    /** Return every device currently in breach. Throw to fail the sounding. */
    run(ctx: SoundingContext): Promise<Finding[]>;
}
/** One entry in the config's `checks` array. */
export interface CheckConfig {
    /** Rule id — the script to run. */
    rule: string;
    /**
     * Instance name, and therefore the alert `kind`. Defaults to `rule`. Set this
     * when enabling the same script more than once with different parameters
     * (e.g. measurement-threshold for both soil moisture and air temperature).
     */
    as?: string;
    enabled?: boolean;
    severity?: Severity;
    params?: Record<string, unknown>;
}
export interface NotifyConfig {
    /**
     * Optional POST target, fired once per newly-raised alert. This is the seam to
     * the notification path — a Twilio sender, or a Hermes webhook route with
     * `deliver_only: true` for a zero-token SMS. Leadsman does not send SMS itself.
     */
    webhookUrl?: string | null;
    /** Bearer token sent as `Authorization`, if the receiver wants one. */
    webhookToken?: string | null;
    /** Give up on a webhook after this long. Default 5000. */
    timeoutMs?: number;
}
export interface LeadsmanConfig {
    /** Cron expression for `serve` mode. Five or six fields. */
    schedule: string;
    /** IANA timezone the schedule is interpreted in. Default 'UTC'. */
    timezone?: string;
    /**
     * Per-query ceiling, applied as Postgres `statement_timeout`. This is the guard
     * that stops one slow sounding from starving ChirpStack's ingestion on a shared
     * box. Default 15000.
     */
    statementTimeoutMs?: number;
    /**
     * Refuse to run more than this many checks per sounding. A crude backstop
     * against a config that grew unnoticed. Default 64.
     */
    maxChecksPerRun?: number;
    notify?: NotifyConfig;
    checks: CheckConfig[];
}
/** Outcome of running one check. */
export interface CheckResult {
    ruleId: string;
    kind: string;
    status: 'ok' | 'error' | 'skipped';
    findings: number;
    raised: number;
    resolved: number;
    durationMs: number;
    error?: string;
}
//# sourceMappingURL=types.d.ts.map