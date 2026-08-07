"use strict";
/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Long-running scheduled mode.
 *
 * Two ways to run Leadsman on a timer, and the choice matters on a constrained box:
 *
 *   serve  — this module. One long-lived container, an in-process cron. Node stays
 *            warm, so a sounding starts immediately; overlapping runs are blocked.
 *   run    — one-shot, invoked by host cron or `docker compose run`. No resident
 *            process, but pays container + Node startup on every tick.
 *
 * `serve` is the default for compose deployments. Overlap protection is the reason:
 * if a sounding on a slow device takes longer than the interval, the next tick is
 * skipped rather than piling a second set of aggregate queries onto the first.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.serve = serve;
const croner_1 = require("croner");
const runner_1 = require("./runner");
function serve(options) {
    const { config, rules, store, log, runOnStart = false } = options;
    let inFlight = null;
    let stopping = false;
    const take = async () => {
        const p = (0, runner_1.runSounding)({ config, rules, store, log });
        inFlight = p;
        try {
            return await p;
        }
        finally {
            inFlight = null;
        }
    };
    const job = new croner_1.Cron(config.schedule, {
        timezone: config.timezone ?? 'UTC',
        // Skip a tick rather than run two soundings at once.
        protect: (job) => {
            log.warn('sounding still running — skipping this tick', {
                startedAt: job.currentRun()?.toISOString() ?? null,
            });
        },
        catch: (err) => {
            // A throw here means the sounding itself failed, not an individual check
            // (those are caught per-check). Keep the schedule alive regardless.
            log.error('sounding threw', { error: err.message });
        },
    }, async () => {
        if (stopping)
            return;
        await take();
        log.debug('next sounding scheduled', {
            at: job.nextRun()?.toISOString() ?? null,
        });
    });
    log.info('scheduler started', {
        schedule: config.schedule,
        timezone: config.timezone ?? 'UTC',
        nextRun: job.nextRun()?.toISOString() ?? null,
    });
    if (runOnStart) {
        void take().catch((err) => {
            log.error('initial sounding failed', { error: err.message });
        });
    }
    return {
        async stop() {
            stopping = true;
            job.stop();
            if (inFlight) {
                log.info('waiting for in-flight sounding to finish');
                await inFlight.catch(() => {
                    /* already logged */
                });
            }
            log.info('scheduler stopped');
        },
        nextRun: () => job.nextRun(),
    };
}
//# sourceMappingURL=scheduler.js.map