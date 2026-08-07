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

import { Cron } from 'croner';
import { runSounding, type SoundingSummary } from './runner';
import type { Store } from './db';
import type { LeadsmanConfig, Logger, Rule } from './types';

export interface ServeOptions {
  config: LeadsmanConfig;
  rules: Map<string, Rule>;
  store: Store;
  log: Logger;
  /** Take one sounding immediately rather than waiting for the first tick. */
  runOnStart?: boolean;
}

export interface ServeHandle {
  /** Stop the schedule and wait for an in-flight sounding to finish. */
  stop(): Promise<void>;
  nextRun(): Date | null;
}

export function serve(options: ServeOptions): ServeHandle {
  const { config, rules, store, log, runOnStart = false } = options;

  let inFlight: Promise<SoundingSummary> | null = null;
  let stopping = false;

  const take = async (): Promise<SoundingSummary> => {
    const p = runSounding({ config, rules, store, log });
    inFlight = p;
    try {
      return await p;
    } finally {
      inFlight = null;
    }
  };

  const job = new Cron(
    config.schedule,
    {
      timezone: config.timezone ?? 'UTC',
      // Skip a tick rather than run two soundings at once.
      protect: (job) => {
        log.warn('sounding still running — skipping this tick', {
          startedAt: job.currentRun()?.toISOString() ?? null,
        });
      },
      catch: (err: unknown) => {
        // A throw here means the sounding itself failed, not an individual check
        // (those are caught per-check). Keep the schedule alive regardless.
        log.error('sounding threw', { error: (err as Error).message });
      },
    },
    async () => {
      if (stopping) return;
      await take();
      log.debug('next sounding scheduled', {
        at: job.nextRun()?.toISOString() ?? null,
      });
    },
  );

  log.info('scheduler started', {
    schedule: config.schedule,
    timezone: config.timezone ?? 'UTC',
    nextRun: job.nextRun()?.toISOString() ?? null,
  });

  if (runOnStart) {
    void take().catch((err: unknown) => {
      log.error('initial sounding failed', { error: (err as Error).message });
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
