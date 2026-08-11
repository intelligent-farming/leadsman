// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Smoke tests. No database required — these cover the parts that fail at deploy
// time for silly reasons: config validation, check discovery, and parameter
// coercion. Check SQL is exercised against a real ChirpStack store via
// `leadsman verify` and `leadsman run --dry-run`, not here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseConfig, ConfigError } = require('../dist/config.js');
const { loadRules } = require('../dist/registry.js');
const params = require('../dist/params.js');

test('parseConfig accepts a minimal config and applies defaults', () => {
  const cfg = parseConfig({ checks: [{ rule: 'device-silent' }] });
  assert.equal(cfg.schedule, '*/15 * * * *');
  assert.equal(cfg.timezone, 'UTC');
  assert.equal(cfg.statementTimeoutMs, 15000);
  assert.equal(cfg.checks.length, 1);
  // Absent `enabled` means enabled; absent `as` defaults to the rule id.
  assert.equal(cfg.checks[0].enabled, true);
  assert.equal(cfg.checks[0].as, 'device-silent');
});

test('parseConfig rejects duplicate check names', () => {
  assert.throws(
    () =>
      parseConfig({
        checks: [{ rule: 'measurement-threshold' }, { rule: 'measurement-threshold' }],
      }),
    ConfigError,
  );
});

test('parseConfig allows the same rule twice under distinct names', () => {
  const cfg = parseConfig({
    checks: [
      { rule: 'measurement-threshold', as: 'soil-low' },
      { rule: 'measurement-threshold', as: 'frost-risk' },
    ],
  });
  assert.deepEqual(
    cfg.checks.map((c) => c.as),
    ['soil-low', 'frost-risk'],
  );
});

test('parseConfig rejects a malformed check name', () => {
  assert.throws(
    () => parseConfig({ checks: [{ rule: 'device-silent', as: 'Soil Moisture' }] }),
    ConfigError,
  );
});

test('parseConfig requires a checks array', () => {
  assert.throws(() => parseConfig({}), ConfigError);
  assert.throws(() => parseConfig({ checks: {} }), ConfigError);
});


test('every bundled check loads and satisfies the Rule contract', () => {
  const rules = loadRules();
  assert.ok(rules.size >= 13, `expected at least 13 checks, found ${rules.size}`);

  for (const [id, rule] of rules) {
    assert.equal(rule.id, id);
    assert.match(id, /^[a-z0-9][a-z0-9-]*$/);
    assert.ok(rule.description.length > 20, `${id}: description too short to be useful`);
    assert.ok(['info', 'warning', 'critical'].includes(rule.defaultSeverity));
    assert.equal(typeof rule.run, 'function');
    assert.ok(Array.isArray(rule.requires) && rule.requires.length > 0,
      `${id}: must declare requires[] so verify can check the schema`);
    for (const req of rule.requires) {
      assert.equal(typeof req.table, 'string');
      assert.ok(Array.isArray(req.columns) && req.columns.length > 0);
    }
  }
});

test('the example config only references checks that exist', () => {
  const rules = loadRules();
  const example = require('../config/leadsman.example.json');
  const cfg = parseConfig(example);
  for (const check of cfg.checks) {
    assert.ok(rules.has(check.rule), `example config references unknown rule "${check.rule}"`);
  }
});

test('every example check param is a real parameter of its rule', () => {
  const rules = loadRules();
  const cfg = parseConfig(require('../config/leadsman.example.json'));
  for (const check of cfg.checks) {
    const rule = rules.get(check.rule);
    for (const key of Object.keys(check.params ?? {})) {
      assert.ok(
        key in rule.defaultParams,
        `example config sets unknown param "${key}" on rule "${check.rule}"`,
      );
    }
  }
});

test('jsonPath accepts dotted strings and arrays', () => {
  assert.deepEqual(params.jsonPath({ p: 'soil.moisture' }, 'p'), ['soil', 'moisture']);
  assert.deepEqual(params.jsonPath({ p: ['soil', 'moisture'] }, 'p'), ['soil', 'moisture']);
  assert.deepEqual(params.jsonPath({ p: 'battery' }, 'p'), ['battery']);
});

test('jsonPath rejects unusable paths', () => {
  assert.throws(() => params.jsonPath({ p: '' }, 'p'), params.ParamError);
  assert.throws(() => params.jsonPath({ p: [] }, 'p'), params.ParamError);
  assert.throws(() => params.jsonPath({ p: 42 }, 'p'), params.ParamError);
});

test('numeric coercion accepts numeric strings and rejects junk', () => {
  assert.equal(params.num({ v: 3.4 }, 'v'), 3.4);
  assert.equal(params.num({ v: '3.4' }, 'v'), 3.4);
  assert.equal(params.int({ v: 12 }, 'v'), 12);
  assert.throws(() => params.num({ v: 'low' }, 'v'), params.ParamError);
  assert.throws(() => params.int({ v: 1.5 }, 'v'), params.ParamError);
  assert.equal(params.optNum({ v: null }, 'v'), null);
});

test('battery-low refuses a clear threshold below its raise threshold', async () => {
  const rule = loadRules().get('battery-low');
  const ctx = {
    query: async () => [],
    params: { ...rule.defaultParams, raiseAtVolts: 3.5, clearAtVolts: 3.1 },
    openDevEuis: new Set(),
    kind: 'battery-low',
    now: new Date(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };
  await assert.rejects(() => rule.run(ctx), /must be >= raiseAtVolts/);
});

test('measurement-threshold refuses to run with neither bound set', async () => {
  const rule = loadRules().get('measurement-threshold');
  const ctx = {
    query: async () => [],
    params: { ...rule.defaultParams, min: null, max: null },
    openDevEuis: new Set(),
    kind: 'x',
    now: new Date(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };
  await assert.rejects(() => rule.run(ctx), /at least one of "min" or "max"/);
});

test('device-silent maps rows to findings with detail', async () => {
  const rule = loadRules().get('device-silent');
  const ctx = {
    query: async () => [
      {
        dev_eui: 'a84041000181d9e2',
        device_name: 'soil-north-01',
        last_seen: '2026-08-05T12:00:00.000Z',
        silent_minutes: '240',
        uplinks: '96',
      },
    ],
    params: { ...rule.defaultParams },
    openDevEuis: new Set(),
    kind: 'device-silent',
    now: new Date(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };

  const findings = await rule.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].devEui, 'a84041000181d9e2');
  assert.match(findings[0].summary, /soil-north-01/);
  assert.match(findings[0].summary, /4h/); // 240 minutes rendered as hours
  assert.equal(findings[0].detail.silentMinutes, 240);
  assert.equal(findings[0].detail.thresholdMinutes, rule.defaultParams.silentMinutes);
});

test('battery-low applies hysteresis via openDevEuis', async () => {
  const rule = loadRules().get('battery-low');
  // 3.5V: above raiseAt (3.4) but below clearAt (3.55). A device already in breach
  // stays in breach; a device that is not does not newly breach.
  const row = {
    dev_eui: 'aa11bb22cc33dd44',
    device_name: 'node-1',
    matched_path: 'battery',
    at: '2026-08-05T12:00:00.000Z',
    value: '3.50',
  };
  const base = {
    query: async () => [row],
    params: { ...rule.defaultParams },
    kind: 'battery-low',
    now: new Date(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };

  const fresh = await rule.run({ ...base, openDevEuis: new Set() });
  assert.equal(fresh.length, 0, '3.5V should not raise a new alert above raiseAt');

  const open = await rule.run({ ...base, openDevEuis: new Set([row.dev_eui]) });
  assert.equal(open.length, 1, '3.5V should keep an existing alert open below clearAt');
});

// ── multi-path resolution ────────────────────────────────────────────────────
// The candidate-list mechanism is what lets one config entry cover a mixed fleet,
// so its coercion rules are worth pinning precisely.

const measurement = require('../dist/measurement.js');

test('resolvePaths accepts a single dotted string', () => {
  assert.deepEqual(measurement.resolvePaths({ paths: 'wind.speed' }), [['wind', 'speed']]);
});

test('resolvePaths preserves candidate order — it is the resolution priority', () => {
  assert.deepEqual(
    measurement.resolvePaths({ paths: ['air.temperature', 'temperature', 'leaf.temperature'] }),
    [['air', 'temperature'], ['temperature'], ['leaf', 'temperature']],
  );
});

test('resolvePaths accepts pre-split segment arrays', () => {
  assert.deepEqual(
    measurement.resolvePaths({ paths: [['water', 'temperature', 'current']] }),
    [['water', 'temperature', 'current']],
  );
});

test('resolvePaths rejects empty and non-string candidates', () => {
  assert.throws(() => measurement.resolvePaths({ paths: [] }), params.ParamError);
  assert.throws(() => measurement.resolvePaths({ paths: '' }), params.ParamError);
  assert.throws(() => measurement.resolvePaths({ paths: [42] }), params.ParamError);
  assert.throws(() => measurement.resolvePaths({ paths: {} }), params.ParamError);
});

test('pathsLabel renders candidates for alert detail', () => {
  assert.equal(
    measurement.pathsLabel([['air', 'temperature'], ['temperature']]),
    'air.temperature, temperature',
  );
});

// ── new checks reject unusable configuration up front ────────────────────────
// A misconfigured check that silently never fires is worse than one that errors,
// because leadsman.run records the error where a human can see it.

function ctxFor(rule, overrides = {}, rows = []) {
  return {
    query: async () => rows,
    params: { ...rule.defaultParams, ...overrides },
    openDevEuis: new Set(),
    kind: 'test',
    now: new Date(),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

test('measurement-peak rejects an unknown direction', async () => {
  const rule = loadRules().get('measurement-peak');
  await assert.rejects(() => rule.run(ctxFor(rule, { direction: 'sideways' })), /must be "max" or "min"/);
});

test('measurement-rate rejects a non-positive rate limit', async () => {
  const rule = loadRules().get('measurement-rate');
  await assert.rejects(() => rule.run(ctxFor(rule, { maxRatePerHour: 0 })), /must be positive/);
});

test('measurement-missing requires recentHours < lookbackHours', async () => {
  const rule = loadRules().get('measurement-missing');
  await assert.rejects(
    () => rule.run(ctxFor(rule, { recentHours: 200, lookbackHours: 168 })),
    /must be less than lookbackHours/,
  );
});

test('geofence-breach requires a complete fence definition', async () => {
  const rule = loadRules().get('geofence-breach');
  await assert.rejects(() => rule.run(ctxFor(rule, { shape: 'box', north: 42 })), /requires north, south, east, and west/);
  await assert.rejects(() => rule.run(ctxFor(rule, { shape: 'radius' })), /requires centerLat, centerLon, and radiusMetres/);
  await assert.rejects(
    () => rule.run(ctxFor(rule, { shape: 'box', north: 41, south: 42, east: -93, west: -94 })),
    /north .* must be greater than south/,
  );
});

test('boolean-alarm requires at least one truthy value', async () => {
  const rule = loadRules().get('boolean-alarm');
  await assert.rejects(() => rule.run(ctxFor(rule, { trueValues: [] })), /non-empty array/);
});

test('counter-stalled flags a backwards counter as critical', async () => {
  const rule = loadRules().get('counter-stalled');
  const findings = await rule.run(
    ctxFor(rule, {}, [
      {
        dev_eui: 'aa', device_name: 'meter', matched_path: 'metering.water.total',
        vmin: '120', vmax: '80000', vavg: '40060', vfirst: '80000', vlast: '120',
        samples: '12', distinct_values: '2',
        first_at: '2026-08-05T00:00:00.000Z', last_at: '2026-08-05T12:00:00.000Z',
      },
    ]),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'critical');
  assert.equal(findings[0].detail.reason, 'decrease');
});

test('the example config exercises every bundled check at least once', () => {
  const rules = loadRules();
  const cfg = parseConfig(require('../config/leadsman.example.json'));
  const used = new Set(cfg.checks.map((c) => c.rule));
  const unused = [...rules.keys()].filter((id) => !used.has(id));
  assert.deepEqual(unused, [], `checks missing from the example config: ${unused.join(', ')}`);
});

test('the example config keeps only universally-safe checks enabled by default', () => {
  // Thresholds depend on crop, region, and equipment. Shipping everything enabled
  // produces noise on first run, which teaches operators to ignore alerts.
  const cfg = parseConfig(require('../config/leadsman.example.json'));
  const enabled = cfg.checks.filter((c) => c.enabled).map((c) => c.as);
  for (const kind of enabled) {
    assert.ok(
      [
        // Fleet health: no crop- or site-specific tuning required.
        'device-silent', 'battery-low', 'decode-failure', 'soil-moisture-missing',
        // Network layer: read ChirpStack's own tables, and two of them keep working
        // when the payload codec is broken.
        'device-log-error', 'status-battery-low', 'status-margin-low', 'join-churn',
      ].includes(kind),
      `"${kind}" is enabled by default but needs deployment-specific tuning`,
    );
  }
});

// ── device scoping coercion ───────────────────────────────────────────────────

const scope = require('../dist/scope.js');

test('resolveScope accepts a list, a bare string, null, and absence', () => {
  assert.deepEqual(scope.resolveScope({ deviceProfiles: ['a', 'b'] }).profiles, ['a', 'b']);
  assert.deepEqual(scope.resolveScope({ deviceProfiles: 'a' }).profiles, ['a']);
  assert.deepEqual(scope.resolveScope({ deviceProfiles: null }).profiles, []);
  assert.deepEqual(scope.resolveScope({}).profiles, []);
  assert.equal(scope.resolveScope({ deviceNamePattern: '%pump%' }).namePattern, '%pump%');
  assert.equal(scope.resolveScope({ deviceNamePattern: null }).namePattern, null);
});

test('resolveScope rejects junk rather than silently matching everything', () => {
  // Silently ignoring a malformed filter is the dangerous outcome: a battery check
  // scoped to one hardware family would quietly evaluate the whole fleet.
  assert.throws(() => scope.resolveScope({ deviceProfiles: [42] }), /deviceProfiles/);
  assert.throws(() => scope.resolveScope({ deviceProfiles: [''] }), /deviceProfiles/);
  assert.throws(() => scope.resolveScope({ deviceProfiles: 7 }), /deviceProfiles/);
  assert.throws(() => scope.resolveScope({ deviceNamePattern: 7 }), /deviceNamePattern/);
});

test('scopeClause always binds both parameters, keeping the SQL text stable', () => {
  // Identical SQL whether or not a scope is set keeps Postgres' plan cache warm across
  // soundings, which matters on a device sharing CPU with ChirpStack.
  const empty = scope.scopeClause(scope.ANY_DEVICE, 3);
  const set = scope.scopeClause(scope.resolveScope({ deviceProfiles: ['x'] }), 3);
  assert.equal(empty.sql, set.sql);
  assert.equal(empty.values.length, 2);
  assert.match(empty.sql, /\$3/);
  assert.match(empty.sql, /\$4/);
});

test('scopeClause honours a table alias', () => {
  assert.match(scope.scopeClause(scope.ANY_DEVICE, 3, 'e').sql, /e\.device_profile_name/);
  assert.match(scope.scopeClause(scope.ANY_DEVICE, 3).sql, /[^.]device_profile_name/);
});

// ── every rule's own defaults are coherent ───────────────────────────────────

test('rules either run on their own defaults or explain what configuration they need', () => {
  // A rule shipping defaults that throw an unhelpful error is a rule nobody can enable.
  // Two rules legitimately require configuration; this asserts exactly which, so
  // adding a third is a deliberate decision rather than an accident.
  const NEEDS_CONFIG = {
    'measurement-threshold': /at least one of "min" or "max"/,
    'geofence-breach': /requires north, south, east, and west/,
  };

  const rules = loadRules();
  const results = [];
  for (const [id, rule] of rules) {
    const ctx = {
      query: async () => [],
      params: { ...rule.defaultParams },
      openDevEuis: new Set(),
      kind: id,
      now: new Date(),
      log: { debug() {}, info() {}, warn() {}, error() {} },
    };
    results.push(
      rule.run(ctx).then(
        (findings) => ({ id, ok: true, findings }),
        (err) => ({ id, ok: false, message: err.message }),
      ),
    );
  }

  return Promise.all(results).then((all) => {
    for (const r of all) {
      if (r.id in NEEDS_CONFIG) {
        assert.equal(r.ok, false, `${r.id} is expected to require configuration`);
        assert.match(r.message, NEEDS_CONFIG[r.id], `${r.id}: unhelpful error message`);
      } else {
        assert.equal(r.ok, true, `${r.id} must run on its own defaults (got: ${r.message})`);
        assert.deepEqual(r.findings, [], `${r.id} must return nothing for an empty store`);
      }
    }
    assert.equal(all.length, rules.size);
  });
});

// ── CLI contract ─────────────────────────────────────────────────────────────
// Exit codes are the interface for cron wrappers and container healthchecks: a
// non-zero `run` is what tells the harness a check failed.

const { spawnSync } = require('node:child_process');

function cli(args, env = {}) {
  return spawnSync(process.execPath, ['dist/cli.js', ...args], {
    encoding: 'utf8',
    // Strip any ambient database URL so these cases are hermetic.
    env: { ...process.env, LEADSMAN_DATABASE_URL: '', LEADSMAN_CONFIG: '', ...env },
  });
}

test('CLI: list and help succeed without a database or config', () => {
  const list = cli(['list']);
  assert.equal(list.status, 0);
  assert.match(list.stdout, /checks available/);

  const help = cli(['help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: leadsman/);
});

test('CLI: list --json emits parseable output for tooling', () => {
  const res = cli(['list', '--json']);
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.ok(Array.isArray(parsed) && parsed.length >= 13);
  for (const r of parsed) {
    assert.ok(r.id && r.description && r.defaultSeverity && r.requires);
  }
});

test('CLI: an unknown command exits 2 and prints usage', () => {
  const res = cli(['frobnicate']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown command/);
  assert.match(res.stderr, /Usage: leadsman/);
});

test('CLI: a missing config file exits 2 with the path, not a stack trace', () => {
  const res = cli(['verify', '--config', 'does/not/exist.json']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /ConfigError/);
  assert.match(res.stderr, /does\/not\/exist\.json/);
  assert.doesNotMatch(res.stderr, /at Object\./, 'operator errors should not print a stack');
});

test('CLI: an absent LEADSMAN_DATABASE_URL is reported as configuration, not a crash', () => {
  const res = cli(['verify', '--config', 'test/fixtures/integration.json']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /LEADSMAN_DATABASE_URL is not set/);
});

test('CLI: invalid JSON in a config file names the file', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'leadsman-')), 'bad.json');
  fs.writeFileSync(bad, '{ "checks": [ }');
  try {
    const res = cli(['verify', '--config', bad]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /not valid JSON/);
    assert.ok(res.stderr.includes(bad));
  } finally {
    fs.rmSync(path.dirname(bad), { recursive: true, force: true });
  }
});

// ── config validation edge cases ─────────────────────────────────────────────

test('parseConfig skips comment-only entries so the menu config can have headers', () => {
  const cfg = parseConfig({
    checks: [
      { '//': 'a section header' },
      { rule: 'device-silent' },
      { '//': 'another', '//note': 'multiple comment keys' },
    ],
  });
  assert.equal(cfg.checks.length, 1);
});

test('parseConfig rejects an entry that has a comment AND is malformed', () => {
  // A real entry that happens to carry a comment must still be validated — only
  // entries consisting *entirely* of comments are treated as annotation.
  assert.throws(
    () => parseConfig({ checks: [{ '//': 'note', enabled: true }] }),
    /rule must be a non-empty string/,
  );
});

test('parseConfig enforces maxChecksPerRun', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ rule: 'device-silent', as: `c${i}` }));
  assert.throws(() => parseConfig({ maxChecksPerRun: 3, checks: many }), /maxChecksPerRun/);
  // Disabled entries do not count against the cap.
  const mostlyOff = many.map((c, i) => ({ ...c, enabled: i < 2 }));
  assert.equal(parseConfig({ maxChecksPerRun: 3, checks: mostlyOff }).checks.length, 5);
});

test('parseConfig rejects a non-positive statementTimeoutMs', () => {
  // A zero or negative timeout would disable the guard that protects ChirpStack's
  // ingestion on a shared device.
  assert.throws(() => parseConfig({ statementTimeoutMs: 0, checks: [] }), ConfigError);
  assert.throws(() => parseConfig({ statementTimeoutMs: -1, checks: [] }), ConfigError);
});


// ── notify: environment overrides ─────────────────────────────────────────────
// Where alerts go is a property of the host, so an orchestrator must be able to set it
// without rewriting a mounted config file. These pin that contract, including the
// empty-string case: `LEADSMAN_WEBHOOK_URL=` in a .env arrives as "", and treating it
// as a value would fail URL validation and take the engine down over a blank line.

/** Run fn with the given env vars set, restoring whatever was there before. */
function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}








test('the Makerfabs config parses and references only real rules and params', () => {
  const rules = loadRules();
  const cfg = parseConfig(require('../config/makerfabs-agrosense.example.json'));
  assert.ok(cfg.checks.length >= 40);
  for (const check of cfg.checks) {
    const rule = rules.get(check.rule);
    assert.ok(rule, `unknown rule "${check.rule}"`);
    for (const key of Object.keys(check.params ?? {})) {
      assert.ok(key in rule.defaultParams, `unknown param "${key}" on "${check.rule}"`);
    }
  }
});

// ── notify routing (fact / situation) ─────────────────────────────────────────
// The point of routing is that the expensive destination stays small. These pin the
// precedence chain, and that a misconfiguration is refused at parse time rather than
// discovered as silence.

const { resolveDestination } = require('../dist/notify');

const DESTS = {
  destinations: {
    sms: { webhookUrl: 'https://sms.test/h' },
    agent: { webhookUrl: 'https://agent.test/h' },
  },
  routing: { fact: 'sms', situation: 'agent' },
};

test('routing sends facts and situations to different destinations', () => {
  const fact = resolveDestination({ severity: 'warning' }, { routing: 'fact' }, DESTS);
  const sit = resolveDestination({ severity: 'warning' }, { routing: 'situation' }, DESTS);
  assert.equal(fact, 'sms');
  assert.equal(sit, 'agent');
});

test('a check notifyTo beats the rule class', () => {
  // The whole reason notifyTo exists: measurement-threshold is a 'fact' rule, but THIS
  // instance of it is pipe-pressure-low, which wants correlating.
  const d = resolveDestination(
    { severity: 'critical' },
    { routing: 'fact', notifyTo: 'agent' },
    DESTS,
  );
  assert.equal(d, 'agent');
});

test('bySeverity beats the rule class but loses to notifyTo', () => {
  const cfg = { ...DESTS, bySeverity: { critical: 'agent' } };
  // critical fact -> escalated by severity
  assert.equal(resolveDestination({ severity: 'critical' }, { routing: 'fact' }, cfg), 'agent');
  // warning fact -> untouched by the severity map
  assert.equal(resolveDestination({ severity: 'warning' }, { routing: 'fact' }, cfg), 'sms');
  // an explicit notifyTo still wins over the severity map
  assert.equal(
    resolveDestination({ severity: 'critical' }, { routing: 'situation', notifyTo: 'sms' }, cfg),
    'sms',
  );
});

test('an explicit null in the chain means record-only, and stops the chain', () => {
  // Silencing the noisy half without losing it: facts are recorded, never pushed.
  const cfg = { ...DESTS, routing: { fact: null, situation: 'agent' }, defaultDestination: 'sms' };
  assert.equal(resolveDestination({ severity: 'warning' }, { routing: 'fact' }, cfg), null);
  // The null must NOT fall through to defaultDestination — that would defeat the silencing.
  assert.equal(resolveDestination({ severity: 'warning' }, { routing: 'situation' }, cfg), 'agent');
});

test('an unroutable alert falls back to defaultDestination, else record-only', () => {
  const withDefault = { destinations: DESTS.destinations, defaultDestination: 'sms' };
  assert.equal(resolveDestination({ severity: 'info' }, undefined, withDefault), 'sms');
  const bare = { destinations: DESTS.destinations };
  assert.equal(resolveDestination({ severity: 'info' }, undefined, bare), null);
});

test('every rule declares a routing class, and situations stay a small set', () => {
  const rules = loadRules();
  const situations = [];
  for (const [id, rule] of rules) {
    assert.ok(
      rule.defaultRouting === 'fact' || rule.defaultRouting === 'situation',
      `${id} has no valid defaultRouting`,
    );
    if (rule.defaultRouting === 'situation') situations.push(id);
  }
  // A guard against drift: every rule moved into 'situation' costs tokens on every fire,
  // so growing this set should be a deliberate act that updates this test.
  assert.deepEqual(situations.sort(), ['device-silent', 'geofence-breach', 'join-churn']);
});

test('the generic measurement rules default to fact, not situation', () => {
  const rules = loadRules();
  // These serve many meanings at once, so they cannot know they are a situation. Defaulting
  // them to 'situation' would send every threshold alert to an LLM.
  for (const id of [
    'measurement-threshold', 'measurement-peak', 'measurement-rate',
    'measurement-stuck', 'measurement-missing', 'counter-spike', 'counter-stalled',
  ]) {
    assert.equal(rules.get(id).defaultRouting, 'fact', `${id} should default to fact`);
  }
});

test('parseConfig rejects routing to a destination that does not exist', () => {
  assert.throws(
    () => parseConfig({
      checks: [],
      notify: { destinations: { sms: { webhookUrl: 'https://a.test/h' } }, routing: { fact: 'nope' } },
    }),
    (err) => err instanceof ConfigError && /not in notify.destinations/.test(err.message),
  );
});

test('parseConfig rejects a check notifyTo naming an unknown destination', () => {
  assert.throws(
    () => parseConfig({
      checks: [{ rule: 'device-silent', notifyTo: 'ghost' }],
      notify: { destinations: { sms: { webhookUrl: 'https://a.test/h' } }, routing: { fact: 'sms' } },
    }),
    (err) => err instanceof ConfigError && /notifyTo names destination "ghost"/.test(err.message),
  );
});


test('parseConfig refuses destinations that nothing routes to', () => {
  // Otherwise the operator gets silence and believes delivery is configured.
  assert.throws(
    () => parseConfig({
      checks: [],
      notify: { destinations: { sms: { webhookUrl: 'https://a.test/h' } } },
    }),
    (err) => err instanceof ConfigError && /nothing routes to it/.test(err.message),
  );
});

test('per-destination secrets come from LEADSMAN_WEBHOOK_TOKEN_<NAME>', () => {
  withEnv(
    { LEADSMAN_WEBHOOK_TOKEN_AGENT: 'agent-secret', LEADSMAN_WEBHOOK_TOKEN: 'shared' },
    () => {
      const cfg = parseConfig({
        checks: [],
        notify: {
          destinations: {
            sms: { webhookUrl: 'https://a.test/h', webhookAuth: 'hmac' },
            agent: { webhookUrl: 'https://b.test/h', webhookAuth: 'hmac' },
          },
          routing: { fact: 'sms', situation: 'agent' },
        },
      });
      // Specific wins for agent; sms falls back to the shared secret.
      assert.equal(cfg.notify.destinations.agent.webhookToken, 'agent-secret');
      assert.equal(cfg.notify.destinations.sms.webhookToken, 'shared');
    },
  );
});


// ── notify shape: one way to configure delivery ───────────────────────────────
// The single-URL form was removed because two ways to say the same thing meant one could be
// set, look configured, and quietly lose. These pin the replacements for what it used to
// validate, plus a clear error for anyone carrying an old config forward.

test('a destination webhookUrl is still URL-validated', () => {
  assert.throws(
    () => parseConfig({
      checks: [],
      notify: { destinations: { hook: { webhookUrl: 'not-a-url' } }, routing: { fact: 'hook' } },
    }),
    (err) => err instanceof ConfigError && /is not a valid URL/.test(err.message),
  );
});

test('notify without destinations is refused, and says what to write instead', () => {
  // The message has to carry a usable example: there is no longer an obvious minimal form,
  // so "destinations is required" on its own would leave the operator guessing.
  assert.throws(
    () => parseConfig({ checks: [], notify: { timeoutMs: 1000 } }),
    (err) =>
      err instanceof ConfigError &&
      /destinations is required/.test(err.message) &&
      /"provider": "twilio"/.test(err.message) &&
      /Omit `notify` entirely/.test(err.message),
  );
});

test('a top-level webhookUrl points at where it moved to', () => {
  for (const dead of ['webhookUrl', 'webhookAuth', 'webhookTokenHeader']) {
    try {
      parseConfig({ checks: [], notify: { [dead]: 'x', destinations: {} } });
      assert.fail(`expected ${dead} to be refused`);
    } catch (e) {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, new RegExp(`notify\\.${dead} is no longer supported`));
      assert.match(e.message, /notify\.destinations\.<name>/);
    }
  }
});

test('notifyTo with no notify block at all is refused', () => {
  assert.throws(
    () => parseConfig({ checks: [{ rule: 'device-silent', notifyTo: 'agent' }] }),
    (err) => err instanceof ConfigError && /there is no notify block/.test(err.message),
  );
});

test('omitting notify entirely is valid and means record-only', () => {
  // The default posture for a fresh install: alerts accumulate, nothing is pushed.
  const cfg = parseConfig({ checks: [{ rule: 'device-silent' }] });
  assert.equal(cfg.notify, undefined);
});

test('an empty destinations map is refused', () => {
  assert.throws(
    () => parseConfig({ checks: [], notify: { destinations: {} } }),
    (err) => err instanceof ConfigError && /destinations is empty/.test(err.message),
  );
});
