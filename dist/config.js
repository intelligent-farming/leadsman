"use strict";
/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Config file loading and validation.
 *
 * The config selects which checks run and with what parameters — it is the
 * "pick from the menu" surface. It deliberately holds no credentials: the database
 * URL comes from LEADSMAN_DATABASE_URL and the webhook token from
 * LEADSMAN_WEBHOOK_TOKEN, so the config file is safe to commit and diff.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigError = void 0;
exports.parseConfig = parseConfig;
exports.loadConfig = loadConfig;
exports.databaseUrlFromEnv = databaseUrlFromEnv;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const SEVERITIES = ['info', 'warning', 'critical'];
class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigError';
    }
}
exports.ConfigError = ConfigError;
const DEFAULTS = {
    schedule: '*/15 * * * *',
    timezone: 'UTC',
    statementTimeoutMs: 15000,
    maxChecksPerRun: 64,
};
function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
/** Parse and validate a config object. Throws ConfigError with a usable message. */
function parseConfig(raw) {
    if (!isPlainObject(raw))
        throw new ConfigError('config root must be a JSON object');
    const checksRaw = raw.checks;
    if (!Array.isArray(checksRaw)) {
        throw new ConfigError('config.checks must be an array (use [] to disable everything)');
    }
    const checks = [];
    const seenKinds = new Set();
    checksRaw.forEach((entry, i) => {
        const at = `config.checks[${i}]`;
        if (!isPlainObject(entry))
            throw new ConfigError(`${at} must be an object`);
        // Comment-only entries act as section headers in the shipped menu config, which
        // is long enough to need them. JSON has no comment syntax, so an object whose
        // only keys start with "//" is treated as annotation and skipped.
        const keys = Object.keys(entry);
        if (keys.length > 0 && keys.every((k) => k.startsWith('//')))
            return;
        const rule = entry.rule;
        if (typeof rule !== 'string' || rule.length === 0) {
            throw new ConfigError(`${at}.rule must be a non-empty string`);
        }
        const kind = entry.as === undefined ? rule : entry.as;
        if (typeof kind !== 'string' || kind.length === 0) {
            throw new ConfigError(`${at}.as must be a non-empty string when present`);
        }
        // Kinds land in a unique index and in alert payloads; keep them predictable.
        if (!/^[a-z0-9][a-z0-9-]*$/.test(kind)) {
            throw new ConfigError(`${at}.as ("${kind}") must be lowercase alphanumeric with hyphens`);
        }
        if (seenKinds.has(kind)) {
            throw new ConfigError(`${at}: duplicate check name "${kind}" — set a distinct "as" for each ` +
                `instance of the same rule, otherwise their alerts collide`);
        }
        seenKinds.add(kind);
        if (entry.severity !== undefined && !SEVERITIES.includes(entry.severity)) {
            throw new ConfigError(`${at}.severity must be one of ${SEVERITIES.join(', ')}`);
        }
        if (entry.params !== undefined && !isPlainObject(entry.params)) {
            throw new ConfigError(`${at}.params must be an object`);
        }
        if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
            throw new ConfigError(`${at}.enabled must be a boolean`);
        }
        checks.push({
            rule,
            as: kind,
            enabled: entry.enabled !== false, // absent means enabled
            severity: entry.severity,
            params: entry.params ?? {},
        });
    });
    const schedule = raw.schedule ?? DEFAULTS.schedule;
    if (typeof schedule !== 'string' || schedule.trim().length === 0) {
        throw new ConfigError('config.schedule must be a cron expression string');
    }
    const timezone = raw.timezone ?? DEFAULTS.timezone;
    if (typeof timezone !== 'string')
        throw new ConfigError('config.timezone must be a string');
    const statementTimeoutMs = raw.statementTimeoutMs ?? DEFAULTS.statementTimeoutMs;
    if (typeof statementTimeoutMs !== 'number' || statementTimeoutMs <= 0) {
        throw new ConfigError('config.statementTimeoutMs must be a positive number');
    }
    const maxChecksPerRun = raw.maxChecksPerRun ?? DEFAULTS.maxChecksPerRun;
    if (typeof maxChecksPerRun !== 'number' || maxChecksPerRun <= 0) {
        throw new ConfigError('config.maxChecksPerRun must be a positive number');
    }
    let notify;
    if (raw.notify !== undefined) {
        if (!isPlainObject(raw.notify))
            throw new ConfigError('config.notify must be an object');
        const url = raw.notify.webhookUrl ?? null;
        if (url !== null && typeof url !== 'string') {
            throw new ConfigError('config.notify.webhookUrl must be a string or null');
        }
        if (typeof url === 'string') {
            try {
                new URL(url);
            }
            catch {
                throw new ConfigError(`config.notify.webhookUrl is not a valid URL: ${url}`);
            }
        }
        const auth = raw.notify.webhookAuth ?? 'bearer';
        if (auth !== 'hmac' && auth !== 'token' && auth !== 'bearer') {
            throw new ConfigError(`config.notify.webhookAuth must be "hmac", "token", or "bearer" (got ${JSON.stringify(auth)})`);
        }
        const tokenHeader = raw.notify.webhookTokenHeader ?? null;
        if (tokenHeader !== null && typeof tokenHeader !== 'string') {
            throw new ConfigError('config.notify.webhookTokenHeader must be a string or null');
        }
        notify = {
            webhookUrl: url,
            // Secret comes from the environment, never the config file.
            webhookToken: process.env.LEADSMAN_WEBHOOK_TOKEN ?? null,
            webhookAuth: auth,
            webhookTokenHeader: tokenHeader,
            timeoutMs: typeof raw.notify.timeoutMs === 'number' ? raw.notify.timeoutMs : 5000,
        };
    }
    const enabledCount = checks.filter((c) => c.enabled).length;
    if (enabledCount > maxChecksPerRun) {
        throw new ConfigError(`${enabledCount} checks enabled but maxChecksPerRun is ${maxChecksPerRun}`);
    }
    return { schedule, timezone, statementTimeoutMs, maxChecksPerRun, notify, checks };
}
/** Read and validate a config file from disk. */
function loadConfig(path) {
    const full = (0, node_path_1.resolve)(path);
    let text;
    try {
        text = (0, node_fs_1.readFileSync)(full, 'utf8');
    }
    catch (err) {
        throw new ConfigError(`cannot read config at ${full}: ${err.message}`);
    }
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch (err) {
        throw new ConfigError(`${full} is not valid JSON: ${err.message}`);
    }
    return parseConfig(raw);
}
/** Connection string for the engine's own role. */
function databaseUrlFromEnv() {
    const url = process.env.LEADSMAN_DATABASE_URL;
    if (!url) {
        throw new ConfigError('LEADSMAN_DATABASE_URL is not set — expected a Postgres URL for the ' +
            'leadsman role, e.g. postgres://leadsman:...@events-postgres:5432/chirpstack_events');
    }
    return url;
}
//# sourceMappingURL=config.js.map