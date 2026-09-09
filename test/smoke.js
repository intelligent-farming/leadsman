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

// A complete SoundingContext with nothing in it. Every field the engine supplies is
// present and empty, so a rule reaching for one gets the "nothing configured, nothing
// in the store" answer rather than a TypeError — which is the difference between a test
// that proves a rule handles an empty deployment and one that proves the stub is stale.
function stubCtx(overrides = {}) {
  const state = new Map();
  return {
    query: async () => [],
    params: {},
    openDevEuis: new Set(),
    openSubjects: new Set(),
    kind: 'test',
    now: new Date(),
    // Null rather than absent: `needs` is what excuses a rule from running at all, and
    // a rule that ignores it should fail here rather than in the field.
    gateways: null,
    engine: { postmasterStartTime: null, previousRunAt: null, hostAddress: null },
    state: {
      get: async (key) => state.get(key) ?? null,
      set: async (key, value) => {
        state.set(key, { value, seenAt: new Date().toISOString() });
      },
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    ...overrides,
  };
}

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
        // Site, gateway and host: a fault at these layers surfaces as a pile of device
        // alerts that each name a healthy sensor, so leaving them off by default means
        // the noisy diagnosis is the only one anyone gets. None needs a threshold that
        // depends on crop or equipment, and the three that read ChirpStack's gateway API
        // report `skipped` rather than firing when no connection is configured.
        'fleet-silent', 'gateway-silent', 'host-restarted', 'host-address-changed',
        'gateway-deaf', 'gateway-never-seen',
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
    const ctx = stubCtx({ params: { ...rule.defaultParams }, kind: id });
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

// ── site, gateway and host checks ────────────────────────────────────────────
// These are the checks that report the layers underneath a device. The behaviour
// worth pinning is mostly about when they stay QUIET: each one has a way of being
// wrong that would fire on a healthy deployment, and that is what these cover.

test('fleet-silent raises one site alert, not one per device', async () => {
  const rule = loadRules().get('fleet-silent');
  let call = 0;
  const ctx = stubCtx({
    params: { ...rule.defaultParams },
    query: async () => {
      call += 1;
      // First query is the fleet aggregate, second is the join probe.
      if (call === 1) {
        return [{
          devices: '12',
          last_uplink: '2026-09-09T06:00:00.000Z',
          silent_minutes: '145',
          uplinks_in_window: '0',
        }];
      }
      return [{ last_join: null, joins_recent: '0' }];
    },
  });

  const findings = await rule.run(ctx);
  assert.equal(findings.length, 1, 'twelve silent devices must be one alert');
  assert.equal(findings[0].subject.kind, 'site');
  assert.equal(findings[0].devEui, undefined, 'a site alert has no DevEUI');
  assert.match(findings[0].summary, /any of 12 devices/);
  assert.match(findings[0].summary, /2\.4h/);
  assert.equal(findings[0].detail.joinsSinceThreshold, 0);
});

test('fleet-silent stays quiet when anything at all is arriving', async () => {
  const rule = loadRules().get('fleet-silent');
  const ctx = stubCtx({
    params: { ...rule.defaultParams },
    query: async () => [{
      devices: '12',
      last_uplink: '2026-09-09T08:00:00.000Z',
      silent_minutes: '2',
      uplinks_in_window: '40',
    }],
  });
  assert.deepEqual(await rule.run(ctx), []);
});

test('fleet-silent ignores a fleet too small to have a shared cause', async () => {
  // With one device, "the fleet is silent" and "that device is silent" are the same
  // statement, and device-silent says it better.
  const rule = loadRules().get('fleet-silent');
  const ctx = stubCtx({
    params: { ...rule.defaultParams },
    query: async () => [{
      devices: '1',
      last_uplink: '2026-09-09T06:00:00.000Z',
      silent_minutes: '600',
      uplinks_in_window: '0',
    }],
  });
  assert.deepEqual(await rule.run(ctx), []);
});

test('fleet-silent points at the payload path when joins are still landing', async () => {
  // Joins arriving means the radio path is up, which is a completely different fault
  // from silence on everything — worth not sending someone to check the gateway.
  const rule = loadRules().get('fleet-silent');
  let call = 0;
  const ctx = stubCtx({
    params: { ...rule.defaultParams },
    query: async () => {
      call += 1;
      if (call === 1) {
        return [{ devices: '8', last_uplink: '2026-09-09T06:00:00.000Z', silent_minutes: '90', uplinks_in_window: '0' }];
      }
      return [{ last_join: '2026-09-09T07:50:00.000Z', joins_recent: '3' }];
    },
  });
  const findings = await rule.run(ctx);
  assert.equal(findings.length, 1);
  assert.match(findings[0].summary, /joins are still arriving/);
  assert.equal(findings[0].detail.joinsSinceThreshold, 3);
});

test('gateway-silent names the gateway and counts the devices behind it', async () => {
  const rule = loadRules().get('gateway-silent');
  const ctx = stubCtx({
    params: { ...rule.defaultParams },
    query: async () => [
      // Silent for hours, was carrying nine devices.
      { gateway_id: '0016C001F1E2D3C4', first_seen: '2026-09-02T00:00:00.000Z',
        last_seen: '2026-09-09T02:00:00.000Z', silent_minutes: '360',
        receptions: '4200', devices: '9' },
      // Still forwarding, so this is one gateway down rather than a site outage.
      { gateway_id: '0016c001aaaabbbb', first_seen: '2026-09-02T00:00:00.000Z',
        last_seen: '2026-09-09T07:58:00.000Z', silent_minutes: '2',
        receptions: '5100', devices: '11' },
    ],
  });

  const findings = await rule.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject.kind, 'gateway');
  assert.equal(findings[0].subject.id, '0016c001f1e2d3c4', 'gateway EUIs are lowercased');
  assert.match(findings[0].summary, /6h/);
  assert.match(findings[0].summary, /carrying 9 devices/);
  assert.equal(findings[0].detail.gatewaysStillActive, 1);
});

test('gateway-silent leaves a total blackout to fleet-silent', async () => {
  // Every gateway silent at once is one site event, not N gateway faults. Without this,
  // a quiet fleet also reads as every gateway failing simultaneously.
  const rule = loadRules().get('gateway-silent');
  const ctx = stubCtx({
    params: { ...rule.defaultParams },
    query: async () => [
      { gateway_id: 'aaaa000000000001', first_seen: '2026-09-02T00:00:00.000Z',
        last_seen: '2026-09-09T02:00:00.000Z', silent_minutes: '360', receptions: '900', devices: '4' },
      { gateway_id: 'aaaa000000000002', first_seen: '2026-09-02T00:00:00.000Z',
        last_seen: '2026-09-09T02:05:00.000Z', silent_minutes: '355', receptions: '800', devices: '5' },
    ],
  });
  assert.deepEqual(await rule.run(ctx), []);
});

test('gateway-silent ignores a gateway that only ever passed through', async () => {
  const rule = loadRules().get('gateway-silent');
  const ctx = stubCtx({
    params: { ...rule.defaultParams },
    query: async () => [
      // Three receptions, below minReceptions: a neighbour's unit or a survey handheld.
      { gateway_id: 'bbbb000000000001', first_seen: '2026-09-02T00:00:00.000Z',
        last_seen: '2026-09-02T00:10:00.000Z', silent_minutes: '9000', receptions: '3', devices: '1' },
      { gateway_id: 'aaaa000000000002', first_seen: '2026-09-02T00:00:00.000Z',
        last_seen: '2026-09-09T07:59:00.000Z', silent_minutes: '1', receptions: '800', devices: '5' },
    ],
  });
  assert.deepEqual(await rule.run(ctx), []);
});

test('host-restarted reports the monitoring gap, not the uptime', async () => {
  const rule = loadRules().get('host-restarted');
  const restartedAt = new Date(Date.now() - 6 * 60_000);          // 6 minutes ago
  const lastRun = new Date(restartedAt.getTime() - 390 * 60_000);  // 6.5h before that
  const ctx = stubCtx({
    params: { ...rule.defaultParams },
    engine: {
      postmasterStartTime: restartedAt.toISOString(),
      previousRunAt: lastRun.toISOString(),
      hostAddress: null,
    },
  });

  const findings = await rule.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject.kind, 'engine');
  assert.match(findings[0].summary, /restarted 6m ago/);
  assert.match(findings[0].summary, /6\.5h/);
  // The gap runs to the restart, not to now: time since the restart is time the engine
  // has been back and working.
  assert.equal(findings[0].detail.monitoringGapMinutes, 390);
});

test('host-restarted stays quiet on a fresh install and on a quick recreate', async () => {
  const rule = loadRules().get('host-restarted');
  const restartedAt = new Date(Date.now() - 60_000).toISOString();

  // No prior sounding: a new deployment, not an outage. Must not open with an alert.
  const fresh = stubCtx({
    params: { ...rule.defaultParams },
    engine: { postmasterStartTime: restartedAt, previousRunAt: null, hostAddress: null },
  });
  assert.deepEqual(await rule.run(fresh), []);

  // A container recreate during an upgrade restarts Postgres and is not an incident.
  const recreate = stubCtx({
    params: { ...rule.defaultParams },
    engine: {
      postmasterStartTime: restartedAt,
      previousRunAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      hostAddress: null,
    },
  });
  assert.deepEqual(await rule.run(recreate), []);

  // A restart older than the reporting window is no longer news.
  const old = stubCtx({
    params: { ...rule.defaultParams },
    engine: {
      postmasterStartTime: new Date(Date.now() - 10 * 3600_000).toISOString(),
      previousRunAt: new Date(Date.now() - 20 * 3600_000).toISOString(),
      hostAddress: null,
    },
  });
  assert.deepEqual(await rule.run(old), []);
});

test('host-address-changed records the first address silently, then reports a change', async () => {
  const rule = loadRules().get('host-address-changed');
  const store = new Map();
  const state = {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => { store.set(k, { value: v, seenAt: new Date().toISOString() }); },
  };

  // First sighting: nothing to compare against, so a fresh install must stay quiet.
  const first = stubCtx({
    params: { ...rule.defaultParams },
    engine: { postmasterStartTime: null, previousRunAt: null, hostAddress: '192.168.1.42' },
    state,
  });
  assert.deepEqual(await rule.run(first), []);

  // The lease moves.
  const moved = stubCtx({
    params: { ...rule.defaultParams },
    engine: { postmasterStartTime: null, previousRunAt: null, hostAddress: '192.168.1.57' },
    state,
  });
  const findings = await rule.run(moved);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject.kind, 'engine');
  assert.equal(findings[0].severity, undefined);
  assert.match(findings[0].summary, /192\.168\.1\.42 to 192\.168\.1\.57/);
  assert.match(findings[0].summary, /must be re-pointed/);
  assert.equal(findings[0].detail.previousAddress, '192.168.1.42');

  // Still open on the next sounding: re-pointing gateways is manual work, and an alert
  // that resolved itself fifteen minutes later would be gone before anyone acted on it.
  const later = stubCtx({
    params: { ...rule.defaultParams },
    engine: { postmasterStartTime: null, previousRunAt: null, hostAddress: '192.168.1.57' },
    state,
  });
  const again = await rule.run(later);
  assert.equal(again.length, 1);
  assert.equal(again[0].detail.previousAddress, '192.168.1.42');
});

test('host-address-changed stops reporting once the change is stale', async () => {
  const rule = loadRules().get('host-address-changed');
  const store = new Map([
    ['address', { value: '10.0.0.9', seenAt: new Date().toISOString() }],
    ['change', {
      value: JSON.stringify({
        previous: '10.0.0.4',
        current: '10.0.0.9',
        at: new Date(Date.now() - 100 * 3600_000).toISOString(),
      }),
      seenAt: new Date().toISOString(),
    }],
  ]);
  const ctx = stubCtx({
    params: { ...rule.defaultParams },  // openForHours: 72
    engine: { postmasterStartTime: null, previousRunAt: null, hostAddress: '10.0.0.9' },
    state: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => { store.set(k, { value: v, seenAt: new Date().toISOString() }); },
    },
  });
  assert.deepEqual(await rule.run(ctx), []);
});

test('the chirpstack-backed checks skip themselves rather than reporting nothing', async () => {
  // `needs` is what the engine reads to mark these skipped. A rule that ignored it and
  // returned [] would be indistinguishable from a healthy gateway fleet.
  const rules = loadRules();
  for (const id of ['gateway-deaf', 'gateway-never-seen']) {
    assert.ok(rules.get(id).needs.includes('chirpstack'), `${id} must declare needs`);
  }
  assert.ok(rules.get('host-address-changed').needs.includes('hostAddress'));
});

test('gateway-deaf needs the site to be busy before blaming one gateway', async () => {
  // A gateway can hear nothing because nothing is in range yet. If the rest of the site
  // is also quiet, this gateway is not evidence of anything.
  const rule = loadRules().get('gateway-deaf');
  const fresh = new Date(Date.now() - 60_000).toISOString();
  const gateways = {
    listGateways: async () => [
      { gatewayId: '0016c001f1e2d3c4', name: 'north-mast', description: null,
        createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: fresh, state: 'ONLINE' },
    ],
  };

  // Site quiet: no alert.
  const quiet = stubCtx({ params: { ...rule.defaultParams }, gateways, query: async () => [] });
  assert.deepEqual(await rule.run(quiet), []);

  // Site busy on another gateway, this one deaf: alert.
  const busy = stubCtx({
    params: { ...rule.defaultParams },
    gateways,
    query: async () => [
      { gateway_id: 'aaaa000000000002', first_seen: '2026-09-01T00:00:00.000Z',
        last_seen: fresh, silent_minutes: '1', receptions: '900', devices: '6' },
    ],
  });
  const findings = await rule.run(busy);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subject.id, '0016c001f1e2d3c4');
  assert.match(findings[0].summary, /online .* but has received nothing/);
  assert.equal(findings[0].detail.backhaul, 'up');
});

test('gateway-never-seen respects the grace period for a not-yet-installed gateway', async () => {
  const rule = loadRules().get('gateway-never-seen');
  const mk = (createdAt) => ({
    listGateways: async () => [
      { gatewayId: 'ccdd000000000001', name: 'south-mast', description: null,
        createdAt, lastSeenAt: null, state: 'NEVER_SEEN' },
    ],
  });

  // Registered an hour ago: somebody is probably still up a ladder.
  const recent = stubCtx({
    params: { ...rule.defaultParams },
    gateways: mk(new Date(Date.now() - 3600_000).toISOString()),
  });
  assert.deepEqual(await rule.run(recent), []);

  // Registered three days ago and still never connected: something went wrong.
  const stale = stubCtx({
    params: { ...rule.defaultParams },
    gateways: mk(new Date(Date.now() - 72 * 3600_000).toISOString()),
    engine: { postmasterStartTime: null, previousRunAt: null, hostAddress: '192.168.1.57' },
  });
  const findings = await rule.run(stale);
  assert.equal(findings.length, 1);
  assert.match(findings[0].summary, /never connected/);
  assert.match(findings[0].summary, /this host is at 192\.168\.1\.57/);
  assert.equal(findings[0].detail.expectedHost, '192.168.1.57');
});

test('gateway-flapping distinguishes repeated dropouts from one clean outage', async () => {
  const rule = loadRules().get('gateway-flapping');
  const row = (over) => ({
    gateway_id: 'aaaa000000000001',
    last_seen: '2026-09-09T07:55:00.000Z',
    active_buckets: '80',
    gap_buckets: '16',
    dropouts: '8',
    receptions: '4000',
    ...over,
  });

  // Eight dropouts across the window: flapping.
  const flapping = stubCtx({ params: { ...rule.defaultParams }, query: async () => [row()] });
  const findings = await rule.run(flapping);
  assert.equal(findings.length, 1);
  assert.match(findings[0].summary, /dropped out 8 times/);
  assert.equal(findings[0].detail.dropouts, 8);

  // Same lost time, one continuous gap: not flapping, and gateway-silent's business.
  const oneOutage = stubCtx({
    params: { ...rule.defaultParams },
    query: async () => [row({ dropouts: '1', gap_buckets: '16' })],
  });
  assert.deepEqual(await rule.run(oneOutage), []);

  // Mostly absent rather than flapping: broken, or never really installed.
  const mostlyGone = stubCtx({
    params: { ...rule.defaultParams },
    query: async () => [row({ active_buckets: '6', gap_buckets: '90', dropouts: '5' })],
  });
  assert.deepEqual(await rule.run(mostlyGone), []);
});

test('gateway-time-unsynced ignores a gateway that never reported a timestamp', async () => {
  // Some gateway models and ChirpStack versions do not supply one at all. Treating that
  // as a lost GPS lock would flag every gateway on such a deployment, forever.
  const rule = loadRules().get('gateway-time-unsynced');
  const never = stubCtx({
    params: { ...rule.defaultParams },
    query: async () => [{
      gateway_id: 'aaaa000000000001', receptions: '900', timestamped: '0',
      max_skew: null, avg_skew: null, last_seen: '2026-09-09T07:00:00.000Z',
    }],
  });
  assert.deepEqual(await rule.run(never), []);

  // Had a lock, mostly lost it: that is the fault.
  const lost = stubCtx({
    params: { ...rule.defaultParams },
    query: async () => [{
      gateway_id: 'aaaa000000000001', receptions: '900', timestamped: '90',
      max_skew: null, avg_skew: null, last_seen: '2026-09-09T07:00:00.000Z',
    }],
  });
  const findings = await rule.run(lost);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].detail.trigger, 'missing-timestamps');
  assert.match(findings[0].summary, /10% of receptions carried a timestamp/);
});

test('gateway-redundancy-lost only reports a decline, never a site that never had any', async () => {
  const rule = loadRules().get('gateway-redundancy-lost');
  const row = (over) => ({
    dev_eui: 'a84041000181d9e2',
    device_name: 'soil-north-01',
    historical_max: '3',
    recent_max: '1',
    recent_uplinks: '200',
    historical_uplinks: '2800',
    ...over,
  });

  const declined = stubCtx({ params: { ...rule.defaultParams }, query: async () => [row()] });
  const findings = await rule.run(declined);
  assert.equal(findings.length, 1);
  assert.match(findings[0].summary, /now reaching 1 gateway \(was 3/);
  assert.match(findings[0].summary, /one gateway failure will cut it off/);

  // A single-gateway deployment: never had redundancy, so has not lost any.
  const alwaysOne = stubCtx({
    params: { ...rule.defaultParams },
    query: async () => [row({ historical_max: '1' })],
  });
  assert.deepEqual(await rule.run(alwaysOne), []);
});

test('gateway-redundancy-lost refuses parameters that cannot mean anything', () => {
  const rule = loadRules().get('gateway-redundancy-lost');
  return Promise.all([
    assert.rejects(
      () => rule.run(stubCtx({ params: { ...rule.defaultParams, recentHours: 400 } })),
      /must be shorter than historyHours/,
    ),
    assert.rejects(
      () => rule.run(stubCtx({
        params: { ...rule.defaultParams, minGateways: 3, minHistoricalGateways: 2 },
      })),
      /cannot lose redundancy it never had/,
    ),
  ]);
});

// ── suppression ──────────────────────────────────────────────────────────────

const { activeSuppressions } = require('../dist/suppress.js');

test('suppression mutes a downstream kind only while its cause is open', () => {
  const ruleOfKind = new Map([
    ['fleet-silent', 'fleet-silent'],
    ['device-silent', 'device-silent'],
    ['soil-moisture-low', 'measurement-threshold'],
  ]);
  const rules = [{ while: ['fleet-silent'], mute: ['device-silent'], enabled: true }];

  // Cause open: the downstream kind is muted, and the cause is named.
  const muted = activeSuppressions(rules, new Set(['fleet-silent', 'device-silent']), ruleOfKind);
  assert.equal(muted.get('device-silent'), 'fleet-silent');
  assert.equal(muted.size, 1);

  // Cause resolved: nothing is muted, which is what releases held alerts.
  assert.equal(activeSuppressions(rules, new Set(['device-silent']), ruleOfKind).size, 0);
});

test('suppression matches a rule id, covering every instance of a generic rule', () => {
  // A config commonly runs a dozen measurement-missing instances under their own names.
  // Naming the rule has to cover all of them, or the list would need maintaining forever.
  const ruleOfKind = new Map([
    ['gateway-silent', 'gateway-silent'],
    ['soil-moisture-missing', 'measurement-missing'],
    ['climate-fields-missing', 'measurement-missing'],
    ['pipe-pressure-low', 'measurement-threshold'],
  ]);
  const muted = activeSuppressions(
    [{ while: ['gateway-silent'], mute: ['measurement-missing'], enabled: true }],
    new Set(['gateway-silent']),
    ruleOfKind,
  );
  assert.deepEqual([...muted.keys()].sort(), ['climate-fields-missing', 'soil-moisture-missing']);
  assert.equal(muted.has('pipe-pressure-low'), false);
});

test('suppression can never mute the alert that explains everything else', () => {
  // However the config is written. Silencing the cause would leave the storm suppressed
  // and nothing at all delivered — strictly worse than no suppression.
  const ruleOfKind = new Map([['fleet-silent', 'fleet-silent'], ['device-silent', 'device-silent']]);
  const muted = activeSuppressions(
    [{ while: ['fleet-silent'], mute: ['fleet-silent', 'device-silent'], enabled: true }],
    new Set(['fleet-silent']),
    ruleOfKind,
  );
  assert.equal(muted.has('fleet-silent'), false);
  assert.equal(muted.get('device-silent'), 'fleet-silent');
});

test('suppression is off when disabled or unconfigured', () => {
  const ruleOfKind = new Map([['device-silent', 'device-silent']]);
  const open = new Set(['fleet-silent']);
  assert.equal(activeSuppressions(undefined, open, ruleOfKind).size, 0);
  assert.equal(activeSuppressions([], open, ruleOfKind).size, 0);
  assert.equal(
    activeSuppressions(
      [{ while: ['fleet-silent'], mute: ['device-silent'], enabled: false }],
      open,
      ruleOfKind,
    ).size,
    0,
  );
});

test('suppression is on by default, and "suppress": [] is how you turn it off', () => {
  // The one default-on behaviour that withholds anything, so the default is worth
  // pinning: an existing config gets it without being edited, and can opt out in a line.
  const withDefaults = parseConfig({ checks: [{ rule: 'device-silent' }] });
  assert.ok(withDefaults.suppress.length > 0);
  const edges = withDefaults.suppress.map((s) => `${s.while.join('+')}->${s.mute.join('+')}`);
  assert.deepEqual(edges, ['fleet-silent->device-silent', 'gateway-silent->device-silent']);

  assert.deepEqual(parseConfig({ suppress: [], checks: [{ rule: 'device-silent' }] }).suppress, []);
});

test('a malformed suppress block is refused with the shape it wanted', () => {
  assert.throws(
    () => parseConfig({ suppress: {}, checks: [] }),
    (err) => err instanceof ConfigError && /\{while: \[\.\.\.\], mute: \[\.\.\.\]\}/.test(err.message),
  );
  assert.throws(
    () => parseConfig({ suppress: [{ while: [], mute: ['x'] }], checks: [] }),
    (err) => err instanceof ConfigError && /while must be a non-empty array/.test(err.message),
  );
});

// ── gateway scope ────────────────────────────────────────────────────────────

const { resolveGatewayScope, inGatewayScope } = require('../dist/scope.js');

test('gateway scope is case-insensitive and ignore beats only', () => {
  // EUIs get typed by hand, out of a label or a QR code, in whatever case the vendor
  // printed. Matching on case would make ignoreGateways silently not work.
  const scope = resolveGatewayScope({
    gateways: ['0016C001F1E2D3C4', 'AAAA000000000002'],
    ignoreGateways: ['AAAA000000000002'],
  });
  assert.ok(inGatewayScope(scope, '0016c001f1e2d3c4'));
  assert.ok(inGatewayScope(scope, '0016C001F1E2D3C4'));
  assert.equal(inGatewayScope(scope, 'aaaa000000000002'), false, 'ignore wins over only');
  assert.equal(inGatewayScope(scope, 'bbbb000000000003'), false, 'not in the only list');

  // Empty scope means every gateway.
  assert.ok(inGatewayScope(resolveGatewayScope({}), 'anything'));
});

// ── host address resolution ──────────────────────────────────────────────────

const { resolveHostAddress } = require('../dist/host.js');

test('the host address is rejected unless it is a bare host', () => {
  // The value comes from a file another program writes. A bad one would produce an alert
  // claiming the gateways' address changed, which is the exact false alarm to avoid.
  const at = (address) => resolveHostAddress({ address, configFile: null });
  assert.equal(at('192.168.1.57'), '192.168.1.57');
  assert.equal(at('  192.168.1.57  '), '192.168.1.57', 'trimmed');
  assert.equal(at('farm-edge.local'), 'farm-edge.local');
  assert.equal(at('[fd00::1]'), '[fd00::1]', 'bracketed IPv6 is a host');

  assert.equal(at(''), null);
  assert.equal(at('   '), null);
  assert.equal(at('http://192.168.1.57'), null, 'a scheme is not a host');
  assert.equal(at('192.168.1.57:1700'), null, 'a port is not part of the address');
  assert.equal(at('192.168.1.57/24'), null);
  assert.equal(at(undefined), null);
  assert.equal(resolveHostAddress(undefined), null);
});

test('pointing at the shared config file enables both things it supplies', () => {
  // Subtle and worth pinning: the provisioner's config.json carries the API key AND
  // gatewayBridgeHost, so naming it has to enable host-address-changed too. Requiring a
  // second opt-in would make that check silently skip on exactly the stack it was
  // written for — and a skipped check looks the same as a healthy site.
  const prev = process.env.LEADSMAN_CHIRPSTACK_CONFIG;
  try {
    process.env.LEADSMAN_CHIRPSTACK_CONFIG = '/shared/config.json';
    const cfg = parseConfig({ checks: [{ rule: 'host-address-changed' }] });
    assert.equal(cfg.chirpstack.configFile, '/shared/config.json');
    assert.equal(cfg.hostAddress.configFile, '/shared/config.json');
    assert.equal(cfg.hostAddress.configKey, 'gatewayBridgeHost');
  } finally {
    if (prev === undefined) delete process.env.LEADSMAN_CHIRPSTACK_CONFIG;
    else process.env.LEADSMAN_CHIRPSTACK_CONFIG = prev;
  }

  // Neither configured: both absent, and the checks that need them are skipped rather
  // than run blind.
  const bare = parseConfig({ checks: [{ rule: 'host-address-changed' }] });
  assert.equal(bare.chirpstack, undefined);
  assert.equal(bare.hostAddress, undefined);
});

test('an enabled check that will be skipped is reported by verify, as a warning', async () => {
  // The runtime symptom of an unconfigured gateway check is "ran, found nothing", which
  // is indistinguishable from a healthy fleet. Saying so at deploy time is the fix.
  const { verify } = require('../dist/verify.js');
  const rules = loadRules();
  const store = {
    verifyConnection: async () => ({ database: 'x', user: 'y', version: 'z' }),
    hasSchema: async () => true,
    describeTables: async () =>
      new Map([
        ['public.event_up', new Set(['dev_eui', 'device_name', 'time', 'rx_info', 'object'])],
        ['leadsman.engine_state', new Set(['key', 'value', 'seen_at'])],
        ['leadsman.run', new Set(['finished_at'])],
      ]),
    describePublicSchema: async () => new Map([['event_up', new Set(['dev_eui'])]]),
  };

  const report = await verify(
    parseConfig({ checks: [{ rule: 'gateway-deaf' }, { rule: 'host-address-changed' }] }),
    rules,
    store,
  );
  // Warnings, not errors: skipping cleanly is the designed behaviour, so this must not
  // stop `serve` from starting.
  assert.equal(report.ok, true);
  const skips = report.problems.filter((p) => /will be SKIPPED/.test(p.message));
  assert.equal(skips.length, 2);
  assert.ok(skips.every((p) => p.severity === 'warning'));
  assert.match(skips.find((p) => p.where === 'checks.gateway-deaf').message, /chirpstack/);
  assert.match(skips.find((p) => p.where === 'checks.host-address-changed').message, /host address/);
});
