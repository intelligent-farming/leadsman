"use strict";
/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Check discovery.
 *
 * Every module in the rules directory that default-exports a Rule becomes an
 * available check. The config file then picks from what is discovered, which is
 * what makes this a menu rather than a fixed pipeline: adding a check is dropping
 * in a file, and enabling it is one line of JSON.
 *
 * A second directory can be supplied via LEADSMAN_RULES_DIR (or --rules-dir) so
 * deployment-specific checks live outside this repo and survive upgrades. Local
 * checks override built-ins of the same id.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RuleLoadError = void 0;
exports.loadRules = loadRules;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const SEVERITIES = ['info', 'warning', 'critical'];
class RuleLoadError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RuleLoadError';
    }
}
exports.RuleLoadError = RuleLoadError;
/** Reject anything that isn't a usable Rule, with a message naming the file. */
function validate(candidate, source) {
    if (typeof candidate !== 'object' || candidate === null) {
        throw new RuleLoadError(`${source}: default export is not an object`);
    }
    const r = candidate;
    if (typeof r.id !== 'string' || r.id.length === 0) {
        throw new RuleLoadError(`${source}: missing string "id"`);
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(r.id)) {
        throw new RuleLoadError(`${source}: id "${r.id}" must be lowercase alphanumeric with hyphens`);
    }
    if (typeof r.description !== 'string' || r.description.length === 0) {
        throw new RuleLoadError(`${source}: missing string "description"`);
    }
    if (!SEVERITIES.includes(r.defaultSeverity)) {
        throw new RuleLoadError(`${source}: defaultSeverity must be one of ${SEVERITIES.join(', ')}`);
    }
    if (typeof r.defaultParams !== 'object' || r.defaultParams === null) {
        throw new RuleLoadError(`${source}: missing object "defaultParams"`);
    }
    if (!Array.isArray(r.requires)) {
        throw new RuleLoadError(`${source}: missing array "requires" — declare the tables and columns the ` +
            `check reads so "leadsman verify" can validate them`);
    }
    if (typeof r.run !== 'function') {
        throw new RuleLoadError(`${source}: missing function "run"`);
    }
    return r;
}
function loadFromDirectory(dir, into) {
    if (!(0, node_fs_1.existsSync)(dir) || !(0, node_fs_1.statSync)(dir).isDirectory())
        return;
    const entries = (0, node_fs_1.readdirSync)(dir)
        .filter((f) => f.endsWith('.js') && !f.endsWith('.d.ts') && !f.endsWith('.test.js'))
        .sort();
    for (const file of entries) {
        const path = (0, node_path_1.join)(dir, file);
        let mod;
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            mod = require(path);
        }
        catch (err) {
            throw new RuleLoadError(`${path}: failed to load — ${err.message}`);
        }
        const exported = mod.default ?? mod;
        const rule = validate(exported, path);
        if (rule.id !== file.replace(/\.js$/, '')) {
            throw new RuleLoadError(`${path}: id "${rule.id}" does not match filename — keep them identical so ` +
                `config entries are greppable`);
        }
        into.set(rule.id, rule);
    }
}
/** All available checks, keyed by id. */
function loadRules(options = {}) {
    const rules = new Map();
    loadFromDirectory((0, node_path_1.join)(__dirname, 'rules'), rules);
    const extra = options.extraDir ?? process.env.LEADSMAN_RULES_DIR ?? null;
    if (extra) {
        const dir = (0, node_path_1.resolve)(extra);
        if (!(0, node_fs_1.existsSync)(dir)) {
            throw new RuleLoadError(`rules directory not found: ${dir}`);
        }
        loadFromDirectory(dir, rules);
    }
    if (rules.size === 0) {
        throw new RuleLoadError('no checks discovered — did the build run? expected compiled modules in dist/rules/');
    }
    return rules;
}
//# sourceMappingURL=registry.js.map