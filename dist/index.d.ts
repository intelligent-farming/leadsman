/**
 * Scheduled rule engine over ChirpStack telemetry.
 *
 * Leadsman takes periodic soundings of the ChirpStack event store, evaluates a
 * configurable set of checks, and records deduplicated alerts in Postgres. It is
 * the deterministic tier of a monitoring stack: it costs no inference tokens, and
 * it hands off to whatever sends messages or reasons about them.
 *
 * Two ways to use it:
 *
 * - As a service — `leadsman serve` (scheduled) or `leadsman run` (one-shot).
 * - As a library — import {@link runSounding} to drive soundings from your own
 *   process, or implement {@link Rule} to add a check.
 *
 * @example Add a check
 * ```ts
 * import type { Rule } from '@intelligent-farming/leadsman';
 *
 * const rule: Rule = {
 *   id: 'my-check',
 *   description: 'Flags devices whose reading looks wrong.',
 *   defaultSeverity: 'warning',
 *   defaultParams: { threshold: 10 },
 *   requires: [{ table: 'event_up', columns: ['dev_eui', 'time', 'object'] }],
 *   async run(ctx) {
 *     const rows = await ctx.query<{ dev_eui: string }>(
 *       `SELECT dev_eui FROM event_up WHERE time > now() - interval '1 hour' GROUP BY dev_eui`,
 *     );
 *     return rows.map((r) => ({ devEui: r.dev_eui, summary: 'something is off' }));
 *   },
 * };
 * export default rule;
 * ```
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * @packageDocumentation
 */
export { Store } from './db';
export type { OpenAlert, RaisedAlert, StoreOptions } from './db';
export { loadConfig, parseConfig, databaseUrlFromEnv, ConfigError } from './config';
export { loadRules, RuleLoadError } from './registry';
export type { LoadRulesOptions } from './registry';
export { runSounding } from './runner';
export type { RunSoundingOptions, SoundingSummary } from './runner';
export { serve } from './scheduler';
export type { ServeOptions, ServeHandle } from './scheduler';
export { verify } from './verify';
export type { VerifyProblem, VerifyReport } from './verify';
export { notifyRaised } from './notify';
export type { NotifyOutcome } from './notify';
export { createLogger } from './logger';
export type { LoggerOptions } from './logger';
export { latestReadings, latestBooleans, latestCoordinates, windowStats, pathPresence, resolvePaths, pathsLabel, } from './measurement';
export type { Reading, WindowStat } from './measurement';
export { int, num, str, optNum, jsonPath, pathLabel, round, ParamError } from './params';
export { resolveScope, scopeClause, scopeLabel, ANY_DEVICE, SCOPE_PARAMS } from './scope';
export type { DeviceScope } from './scope';
export type { CheckConfig, CheckResult, Finding, LeadsmanConfig, Logger, NotifyConfig, Rule, SchemaRequirement, Severity, SoundingContext, } from './types';
//# sourceMappingURL=index.d.ts.map