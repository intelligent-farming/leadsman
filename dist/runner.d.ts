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
import { Store } from './db';
import type { CheckResult, LeadsmanConfig, Logger, Rule } from './types';
export interface SoundingSummary {
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    results: CheckResult[];
    raised: number;
    resolved: number;
    errors: number;
    delivered: number;
}
export interface RunSoundingOptions {
    config: LeadsmanConfig;
    rules: Map<string, Rule>;
    store: Store;
    log: Logger;
    /** Evaluate and report without writing alerts or notifying. */
    dryRun?: boolean;
}
/** One pass over every enabled check. */
export declare function runSounding(options: RunSoundingOptions): Promise<SoundingSummary>;
//# sourceMappingURL=runner.d.ts.map