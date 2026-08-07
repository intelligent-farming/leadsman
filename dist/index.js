"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCOPE_PARAMS = exports.ANY_DEVICE = exports.scopeLabel = exports.scopeClause = exports.resolveScope = exports.ParamError = exports.round = exports.pathLabel = exports.jsonPath = exports.optNum = exports.str = exports.num = exports.int = exports.pathsLabel = exports.resolvePaths = exports.pathPresence = exports.windowStats = exports.latestCoordinates = exports.latestBooleans = exports.latestReadings = exports.createLogger = exports.notifyRaised = exports.verify = exports.serve = exports.runSounding = exports.RuleLoadError = exports.loadRules = exports.ConfigError = exports.databaseUrlFromEnv = exports.parseConfig = exports.loadConfig = exports.Store = void 0;
var db_1 = require("./db");
Object.defineProperty(exports, "Store", { enumerable: true, get: function () { return db_1.Store; } });
var config_1 = require("./config");
Object.defineProperty(exports, "loadConfig", { enumerable: true, get: function () { return config_1.loadConfig; } });
Object.defineProperty(exports, "parseConfig", { enumerable: true, get: function () { return config_1.parseConfig; } });
Object.defineProperty(exports, "databaseUrlFromEnv", { enumerable: true, get: function () { return config_1.databaseUrlFromEnv; } });
Object.defineProperty(exports, "ConfigError", { enumerable: true, get: function () { return config_1.ConfigError; } });
var registry_1 = require("./registry");
Object.defineProperty(exports, "loadRules", { enumerable: true, get: function () { return registry_1.loadRules; } });
Object.defineProperty(exports, "RuleLoadError", { enumerable: true, get: function () { return registry_1.RuleLoadError; } });
var runner_1 = require("./runner");
Object.defineProperty(exports, "runSounding", { enumerable: true, get: function () { return runner_1.runSounding; } });
var scheduler_1 = require("./scheduler");
Object.defineProperty(exports, "serve", { enumerable: true, get: function () { return scheduler_1.serve; } });
var verify_1 = require("./verify");
Object.defineProperty(exports, "verify", { enumerable: true, get: function () { return verify_1.verify; } });
var notify_1 = require("./notify");
Object.defineProperty(exports, "notifyRaised", { enumerable: true, get: function () { return notify_1.notifyRaised; } });
var logger_1 = require("./logger");
Object.defineProperty(exports, "createLogger", { enumerable: true, get: function () { return logger_1.createLogger; } });
// Multi-path measurement resolution over the normalized codec vocabulary. Use these
// when writing a check so path priority, the numeric guard, and "ignore devices that
// report none of the candidates" behave identically everywhere.
var measurement_1 = require("./measurement");
Object.defineProperty(exports, "latestReadings", { enumerable: true, get: function () { return measurement_1.latestReadings; } });
Object.defineProperty(exports, "latestBooleans", { enumerable: true, get: function () { return measurement_1.latestBooleans; } });
Object.defineProperty(exports, "latestCoordinates", { enumerable: true, get: function () { return measurement_1.latestCoordinates; } });
Object.defineProperty(exports, "windowStats", { enumerable: true, get: function () { return measurement_1.windowStats; } });
Object.defineProperty(exports, "pathPresence", { enumerable: true, get: function () { return measurement_1.pathPresence; } });
Object.defineProperty(exports, "resolvePaths", { enumerable: true, get: function () { return measurement_1.resolvePaths; } });
Object.defineProperty(exports, "pathsLabel", { enumerable: true, get: function () { return measurement_1.pathsLabel; } });
var params_1 = require("./params");
Object.defineProperty(exports, "int", { enumerable: true, get: function () { return params_1.int; } });
Object.defineProperty(exports, "num", { enumerable: true, get: function () { return params_1.num; } });
Object.defineProperty(exports, "str", { enumerable: true, get: function () { return params_1.str; } });
Object.defineProperty(exports, "optNum", { enumerable: true, get: function () { return params_1.optNum; } });
Object.defineProperty(exports, "jsonPath", { enumerable: true, get: function () { return params_1.jsonPath; } });
Object.defineProperty(exports, "pathLabel", { enumerable: true, get: function () { return params_1.pathLabel; } });
Object.defineProperty(exports, "round", { enumerable: true, get: function () { return params_1.round; } });
Object.defineProperty(exports, "ParamError", { enumerable: true, get: function () { return params_1.ParamError; } });
// Optional device scoping. Most checks are scoped implicitly by their candidate paths
// (only a pressure sensor emits pressure.gauge); these are for the fields every device
// reports, where the threshold is per hardware family.
var scope_1 = require("./scope");
Object.defineProperty(exports, "resolveScope", { enumerable: true, get: function () { return scope_1.resolveScope; } });
Object.defineProperty(exports, "scopeClause", { enumerable: true, get: function () { return scope_1.scopeClause; } });
Object.defineProperty(exports, "scopeLabel", { enumerable: true, get: function () { return scope_1.scopeLabel; } });
Object.defineProperty(exports, "ANY_DEVICE", { enumerable: true, get: function () { return scope_1.ANY_DEVICE; } });
Object.defineProperty(exports, "SCOPE_PARAMS", { enumerable: true, get: function () { return scope_1.SCOPE_PARAMS; } });
//# sourceMappingURL=index.js.map