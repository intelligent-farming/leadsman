"use strict";
/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * The sounding loop: run the enabled checks, reconcile their findings into alerts,
 * deliver whatever is newly raised.
 *
 * Checks run sequentially, not in parallel. This is deliberate — the target is a
 * small edge device sharing CPU and memory bandwidth with ChirpStack's ingestion,
 * and a fan-out of concurrent aggregate queries is exactly how a monitoring tool
 * starts degrading the thing it monitors. Soundings are not latency-critical.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSounding = runSounding;
const notify_1 = require("./notify");
/** One pass over every enabled check. */
async function runSounding(options) {
    const { config, rules, store, log, dryRun = false } = options;
    const startedAt = new Date();
    const results = [];
    const allRaised = [];
    const enabled = config.checks.filter((c) => c.enabled);
    log.info('sounding started', { checks: enabled.length, dryRun });
    for (const check of enabled) {
        const kind = check.as ?? check.rule;
        const checkLog = log.child ? log.child({ check: kind }) : log;
        const rule = rules.get(check.rule);
        const checkStart = new Date();
        if (!rule) {
            const result = {
                ruleId: check.rule,
                kind,
                status: 'error',
                findings: 0,
                raised: 0,
                resolved: 0,
                durationMs: 0,
                error: `unknown rule "${check.rule}" — run "leadsman list" to see available checks`,
            };
            results.push(result);
            checkLog.error('check skipped', { error: result.error });
            if (!dryRun)
                await store.recordRun(result, checkStart);
            continue;
        }
        const began = process.hrtime.bigint();
        try {
            const ctx = {
                query: (sql, values) => store.query(sql, values),
                params: { ...rule.defaultParams, ...(check.params ?? {}) },
                openDevEuis: dryRun ? new Set() : await store.openDevEuis(kind),
                kind,
                now: checkStart,
                log: checkLog,
            };
            const findings = await rule.run(ctx);
            // Guard against a check returning junk — a bad devEui would poison the
            // unique index and the alert stream.
            const clean = findings.filter((f) => {
                if (typeof f?.devEui !== 'string' || f.devEui.length === 0) {
                    checkLog.warn('discarding finding with no devEui', { summary: f?.summary });
                    return false;
                }
                if (typeof f.summary !== 'string' || f.summary.length === 0) {
                    checkLog.warn('discarding finding with no summary', { devEui: f.devEui });
                    return false;
                }
                return true;
            });
            const severity = check.severity ?? rule.defaultSeverity;
            if (dryRun) {
                const result = {
                    ruleId: rule.id,
                    kind,
                    status: 'ok',
                    findings: clean.length,
                    raised: 0,
                    resolved: 0,
                    durationMs: Number(process.hrtime.bigint() - began) / 1e6,
                };
                results.push(result);
                for (const f of clean) {
                    // Report the severity that would actually be stored: a finding may
                    // escalate past the check's configured default.
                    checkLog.info('would raise', {
                        devEui: f.devEui,
                        summary: f.summary,
                        severity: f.severity ?? severity,
                    });
                }
                continue;
            }
            const { raised, resolved, touched } = await store.reconcile(rule.id, kind, severity, clean);
            allRaised.push(...raised);
            const result = {
                ruleId: rule.id,
                kind,
                status: 'ok',
                findings: clean.length,
                raised: raised.length,
                resolved,
                durationMs: Number(process.hrtime.bigint() - began) / 1e6,
            };
            results.push(result);
            await store.recordRun(result, checkStart);
            checkLog.info('check complete', {
                findings: clean.length,
                raised: raised.length,
                stillOpen: touched,
                resolved,
                ms: Math.round(result.durationMs),
            });
        }
        catch (err) {
            // A failing check must not resolve its own open alerts. If the query errored
            // we have no evidence the breach ended, and silently closing alerts would be
            // worse than reporting nothing — so reconcile is simply not called.
            const result = {
                ruleId: rule.id,
                kind,
                status: 'error',
                findings: 0,
                raised: 0,
                resolved: 0,
                durationMs: Number(process.hrtime.bigint() - began) / 1e6,
                error: err.message,
            };
            results.push(result);
            await store.recordRun(result, checkStart);
            checkLog.error('check failed — open alerts left untouched', {
                error: result.error,
            });
        }
    }
    const delivered = dryRun
        ? 0
        : (await (0, notify_1.notifyRaised)(allRaised, config.notify, store, log)).delivered;
    const finishedAt = new Date();
    const summary = {
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        results,
        raised: results.reduce((n, r) => n + r.raised, 0),
        resolved: results.reduce((n, r) => n + r.resolved, 0),
        errors: results.filter((r) => r.status === 'error').length,
        delivered,
    };
    log.info('sounding finished', {
        ms: summary.durationMs,
        raised: summary.raised,
        resolved: summary.resolved,
        delivered: summary.delivered,
        errors: summary.errors,
    });
    return summary;
}
//# sourceMappingURL=runner.js.map