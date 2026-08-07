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

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Rule, Severity } from './types';

const SEVERITIES: readonly Severity[] = ['info', 'warning', 'critical'];

export class RuleLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleLoadError';
  }
}

/** Reject anything that isn't a usable Rule, with a message naming the file. */
function validate(candidate: unknown, source: string): Rule {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new RuleLoadError(`${source}: default export is not an object`);
  }
  const r = candidate as Partial<Rule>;

  if (typeof r.id !== 'string' || r.id.length === 0) {
    throw new RuleLoadError(`${source}: missing string "id"`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(r.id)) {
    throw new RuleLoadError(
      `${source}: id "${r.id}" must be lowercase alphanumeric with hyphens`,
    );
  }
  if (typeof r.description !== 'string' || r.description.length === 0) {
    throw new RuleLoadError(`${source}: missing string "description"`);
  }
  if (!SEVERITIES.includes(r.defaultSeverity as Severity)) {
    throw new RuleLoadError(
      `${source}: defaultSeverity must be one of ${SEVERITIES.join(', ')}`,
    );
  }
  if (typeof r.defaultParams !== 'object' || r.defaultParams === null) {
    throw new RuleLoadError(`${source}: missing object "defaultParams"`);
  }
  if (!Array.isArray(r.requires)) {
    throw new RuleLoadError(
      `${source}: missing array "requires" — declare the tables and columns the ` +
        `check reads so "leadsman verify" can validate them`,
    );
  }
  if (typeof r.run !== 'function') {
    throw new RuleLoadError(`${source}: missing function "run"`);
  }
  return r as Rule;
}

function loadFromDirectory(dir: string, into: Map<string, Rule>): void {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;

  const entries = readdirSync(dir)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.d.ts') && !f.endsWith('.test.js'))
    .sort();

  for (const file of entries) {
    const path = join(dir, file);
    let mod: { default?: unknown };
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require(path) as { default?: unknown };
    } catch (err) {
      throw new RuleLoadError(`${path}: failed to load — ${(err as Error).message}`);
    }

    const exported = mod.default ?? mod;
    const rule = validate(exported, path);

    if (rule.id !== file.replace(/\.js$/, '')) {
      throw new RuleLoadError(
        `${path}: id "${rule.id}" does not match filename — keep them identical so ` +
          `config entries are greppable`,
      );
    }
    into.set(rule.id, rule);
  }
}

export interface LoadRulesOptions {
  /** Extra directory of operator-supplied checks. Overrides built-ins by id. */
  extraDir?: string | null;
}

/** All available checks, keyed by id. */
export function loadRules(options: LoadRulesOptions = {}): Map<string, Rule> {
  const rules = new Map<string, Rule>();

  loadFromDirectory(join(__dirname, 'rules'), rules);

  const extra = options.extraDir ?? process.env.LEADSMAN_RULES_DIR ?? null;
  if (extra) {
    const dir = resolve(extra);
    if (!existsSync(dir)) {
      throw new RuleLoadError(`rules directory not found: ${dir}`);
    }
    loadFromDirectory(dir, rules);
  }

  if (rules.size === 0) {
    throw new RuleLoadError(
      'no checks discovered — did the build run? expected compiled modules in dist/rules/',
    );
  }
  return rules;
}
