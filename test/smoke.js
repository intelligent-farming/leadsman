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

test('geofence-breach skips a (0, 0) "no fix" position itself, whatever the resolver returns', async () => {
  // Regression M21. The resolver may also drop (0, 0), but the rule must not depend on
  // it: a tracker waking indoors reports 0, 0, and that used to raise a critical breach
  // ~10 000 km out. Stubbed rows, so this is the rule's guard alone.
  const rule = loadRules().get('geofence-breach');
  const debug = [];
  const ctx = {
    ...ctxFor(rule, { shape: 'box', north: 41.9, south: 41.8, east: -93.5, west: -93.7 }, [
      { dev_eui: 'nofix', device_name: 'collar', lat: '0', lon: '0', at: '2026-08-05T00:00:00Z' },
      { dev_eui: 'away', device_name: 'trailer', lat: '42.5', lon: '-93.6', at: '2026-08-05T00:00:00Z' },
    ]),
    log: { debug: (m, meta) => debug.push([m, meta]), info() {}, warn() {}, error() {} },
  };
  const found = await rule.run(ctx);
  assert.deepEqual(found.map((f) => f.devEui), ['away'], 'a real breach still raises');
  assert.equal(debug.length, 1);
  assert.match(debug[0][0], /\(0, 0\) position/);
  assert.equal(debug[0][1].devEui, 'nofix');
});

test('boolean-alarm requires at least one truthy value', async () => {
  const rule = loadRules().get('boolean-alarm');
  await assert.rejects(() => rule.run(ctxFor(rule, { trueValues: [] })), /non-empty array/);
});

// ── mold-risk ────────────────────────────────────────────────────────────────
// The only rule whose findings cost an LLM invocation by default, so its refusals
// matter more than most: every one of them is a configuration that fires constantly
// or never, and both of those are expensive in a different way.

/** One row in the shape bandDwell's SQL returns — numerics arrive from pg as text. */
function dwellRow(over = {}) {
  return {
    dev_eui: 'aa11bb22cc33dd44',
    device_name: 'vineyard-north',
    matched_path: 'air.relativeHumidity',
    hours: '7.5',
    samples: '9',
    vmin: '90.4', vmax: '97.1', vavg: '93.8000',
    gate_min: '16.2', gate_max: '21.4',
    started_at: '2026-09-21T22:00:00.000Z',
    ended_at: '2026-09-22T05:30:00.000Z',
    window_samples: '24',
    gate_samples: '24',
    last_sample_at: '2026-09-22T05:30:00.000Z',
    ...over,
  };
}

test('mold-risk refuses a temperature gate with no bounds', async () => {
  // Paths set but both bounds null admits every reading that merely HAS a temperature.
  // That looks like a configured gate and behaves like none, which is the worst of both.
  const rule = loadRules().get('mold-risk');
  await assert.rejects(
    () => rule.run(ctxFor(rule, { temperatureMin: null, temperatureMax: null })),
    /the gate would admit every reading/,
  );
});

test('mold-risk refuses a dwell longer than the window it is measured in', async () => {
  const rule = loadRules().get('mold-risk');
  await assert.rejects(
    () => rule.run(ctxFor(rule, { dwellHours: 24, lookbackHours: 24 })),
    /could\s+never fire/,
  );
});

test('mold-risk refuses a humidity band with neither bound', async () => {
  const rule = loadRules().get('mold-risk');
  await assert.rejects(
    () => rule.run(ctxFor(rule, { humidityMin: null, humidityMax: null })),
    /at least one of "humidityMin" or "humidityMax"/,
  );
});

test('mold-risk refuses hysteresis that cancels the dwell requirement', async () => {
  const rule = loadRules().get('mold-risk');
  await assert.rejects(
    () => rule.run(ctxFor(rule, { dwellHours: 4, clearDwellHours: 4 })),
    /must be less than dwellHours/,
  );
});

test('mold-risk raises on a run past the dwell, naming duration and gate range', async () => {
  const rule = loadRules().get('mold-risk');
  const findings = await rule.run(ctxFor(rule, { dwellHours: 6 }, [dwellRow()]));

  assert.equal(findings.length, 1);
  assert.match(findings[0].summary, /vineyard-north/);
  assert.match(findings[0].summary, /≥90% for 7\.5h/);
  assert.match(findings[0].summary, /16\.2–21\.4C/);
  // The run reaches the device's latest reading, so it is still accumulating.
  assert.match(findings[0].summary, /ongoing/);
  assert.equal(findings[0].detail.ongoing, true);
  assert.equal(findings[0].detail.dwellHours, 7.5);
  assert.equal(findings[0].detail.requiredHours, 6);
  assert.deepEqual(findings[0].detail.temperatureRange, [16.2, 21.4]);
});

test('mold-risk reports a run that has already ended as ended, not ongoing', async () => {
  const rule = loadRules().get('mold-risk');
  const findings = await rule.run(
    ctxFor(rule, { dwellHours: 6 }, [
      dwellRow({ last_sample_at: '2026-09-22T09:00:00.000Z' }),
    ]),
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0].summary, /ended/);
  assert.equal(findings[0].detail.ongoing, false);
});

test('mold-risk ignores a run short of the dwell, and a run with too few samples', async () => {
  const rule = loadRules().get('mold-risk');
  assert.deepEqual(
    await rule.run(ctxFor(rule, { dwellHours: 8 }, [dwellRow()])),
    [],
  );
  // Nine hours is plenty; three readings across them is not a measured nine hours.
  assert.deepEqual(
    await rule.run(ctxFor(rule, { dwellHours: 6, minSamples: 4 }, [
      dwellRow({ hours: '9', samples: '3' }),
    ])),
    [],
  );
});

test('mold-risk holds an open alert to a shorter run than it took to raise one', async () => {
  const rule = loadRules().get('mold-risk');
  // 5h against a 6h dwell: below the raise line, above the 6-2=4h clear line.
  const rows = [dwellRow({ hours: '5' })];

  const fresh = { ...ctxFor(rule, { dwellHours: 6, clearDwellHours: 2 }, rows) };
  assert.deepEqual(await rule.run(fresh), [], 'must not raise at 5h');

  const open = {
    ...ctxFor(rule, { dwellHours: 6, clearDwellHours: 2 }, rows),
    openDevEuis: new Set(['aa11bb22cc33dd44']),
  };
  assert.equal((await rule.run(open)).length, 1, 'an open alert must stay open at 5h');
});

test('mold-risk warns about devices the temperature gate excludes entirely', async () => {
  // A humidity sensor with no temperature on the same uplink can never raise this
  // check. Zero findings then means "blind", not "safe", and the log has to say which.
  const rule = loadRules().get('mold-risk');
  const lines = [];
  const ctx = {
    ...ctxFor(rule, {}, [dwellRow({ hours: '0', samples: null, gate_samples: '0' })]),
    log: { debug() {}, info() {}, warn: (m, meta) => lines.push([m, meta]), error() {} },
  };

  assert.deepEqual(await rule.run(ctx), []);
  assert.equal(lines.length, 1);
  assert.match(lines[0][0], /no temperature on the same uplink/);
  assert.match(lines[0][1].devices, /aa11bb22cc33dd44/);
});

test('counter-stalled flags a backwards counter as critical', async () => {
  const rule = loadRules().get('counter-stalled');
  const findings = await rule.run(
    ctxFor(rule, {}, [
      {
        // counterWindows' row shape (src/counter.ts): step-aware, not just endpoints.
        dev_eui: 'aa', device_name: 'meter', matched_path: 'metering.water.total',
        vfirst: '80000', vlast: '120', samples: '12',
        first_at: '2026-08-05T00:00:00.000Z', last_at: '2026-08-05T12:00:00.000Z',
        rise: '0', drops: '1', max_drop: '79880', drop_from: '80000', drop_to: '120',
        drop_at: '2026-08-05T08:00:00.000Z',
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
        // Data integrity: the bounds come from the vocabulary schema, so there is
        // nothing to tune and nothing that could depend on the crop. A breach means
        // the sensor or the codec is wrong on any farm anywhere.
        'measurement-implausible',
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
    'measurement-accumulation': /at least one of "min" or "max"/,
    'forecast-threshold': /needs: \[forecast\]/,
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

// ── soil-deficit-band ────────────────────────────────────────────────────────
// A managed deficit is a band the block lives in, and both ways out are faults with
// opposite remedies. These pin the classification, because getting it backwards
// tells a grower to add water to a block that is already being over-irrigated.

/** One residency row in the shape bandResidency's SQL returns. */
function residencyRow(over = {}) {
  return {
    dev_eui: 'aa11bb22cc33dd44',
    device_name: 'block-7',
    matched_path: 'soil.moisture',
    hours_below: '0', hours_in: '0', hours_above: '0', gap_hours: '0',
    vmin: '10', vmax: '30', vavg: '20.0000',
    last_value: '15', last_state: 'below',
    last_at: '2026-09-24T06:00:00.000Z',
    samples: '72',
    ...over,
  };
}

test('soil-deficit-band names under-watering when the time is all on one side', async () => {
  const rule = loadRules().get('soil-deficit-band');
  const findings = await rule.run(ctxFor(rule, { lookbackHours: 72 }, [
    residencyRow({ hours_below: '45', hours_in: '25', hours_above: '0' }),
  ]));

  assert.equal(findings.length, 1);
  assert.equal(findings[0].detail.pattern, 'below');
  assert.match(findings[0].summary, /64% of the time below the 18% floor/);
  assert.match(findings[0].summary, /block-7/);
  assert.equal(findings[0].detail.hoursBelow, 45);
});

test('soil-deficit-band names over-watering as its own fault, not just "out of band"', async () => {
  const rule = loadRules().get('soil-deficit-band');
  const findings = await rule.run(ctxFor(rule, { lookbackHours: 72 }, [
    residencyRow({ hours_below: '0', hours_in: '20', hours_above: '50',
                   last_value: '31', last_state: 'above' }),
  ]));
  assert.equal(findings[0].detail.pattern, 'above');
  assert.match(findings[0].summary, /above the 28% ceiling/);
});

test('soil-deficit-band calls out oscillation, where more water makes it worse', async () => {
  // The case an operator most often corrects backwards. Same total time out of band
  // as the under-watered block above, opposite remedy.
  const rule = loadRules().get('soil-deficit-band');
  const findings = await rule.run(ctxFor(rule, { lookbackHours: 72 }, [
    residencyRow({ hours_below: '24', hours_in: '22', hours_above: '24' }),
  ]));

  assert.equal(findings[0].detail.pattern, 'oscillating');
  assert.match(findings[0].summary, /swinging across the band/);
  assert.match(findings[0].summary, /sets too large and too far apart/);
});

test('soil-deficit-band stays quiet for a block inside its band', async () => {
  const rule = loadRules().get('soil-deficit-band');
  assert.deepEqual(
    await rule.run(ctxFor(rule, { lookbackHours: 72 }, [
      residencyRow({ hours_below: '4', hours_in: '66', hours_above: '0',
                     last_value: '22', last_state: 'in' }),
    ])),
    [], '6% out of band is inside the 25% tolerance',
  );
});

test('soil-deficit-band refuses to judge a block that barely reported', async () => {
  // A block that reported for six hours of three days has demonstrated nothing about
  // its deficit, and saying nothing beats guessing from it.
  const rule = loadRules().get('soil-deficit-band');
  const lines = [];
  const ctx = {
    ...ctxFor(rule, { lookbackHours: 72, minCoverage: 0.6 }, [
      residencyRow({ hours_below: '6', hours_in: '0', hours_above: '0', gap_hours: '60' }),
    ]),
    log: { debug() {}, info() {}, warn: (m) => lines.push(m), error() {} },
  };

  assert.deepEqual(await ctx && await rule.run(ctx), []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /currently measuring nothing/);
});

test('soil-deficit-band holds an open alert below the raise line', async () => {
  const rule = loadRules().get('soil-deficit-band');
  // 22% out of band: under the 25% raise line, over the 25-5=20% clear line.
  const rows = [residencyRow({ hours_below: '16', hours_in: '56', hours_above: '0' })];
  const params = { lookbackHours: 72, maxOutOfBandFraction: 0.25, clearMarginFraction: 0.05 };

  assert.deepEqual(await rule.run(ctxFor(rule, params, rows)), [], 'must not raise at 22%');
  assert.equal(
    (await rule.run({ ...ctxFor(rule, params, rows), openDevEuis: new Set(['aa11bb22cc33dd44']) })).length,
    1, 'an open alert stays open at 22%',
  );
});

test('soil-deficit-band adds depletion only when both soil constants are given', async () => {
  const rule = loadRules().get('soil-deficit-band');
  const rows = [residencyRow({ hours_below: '45', hours_in: '25', last_value: '15' })];

  const plain = await rule.run(ctxFor(rule, { lookbackHours: 72 }, rows));
  assert.equal('depletionFraction' in plain[0].detail, false);

  // FC 32, PWP 12 → TAW 20. At 15 % VWC that is (32-15)/20 = 0.85 depleted.
  const enriched = await rule.run(ctxFor(rule, {
    lookbackHours: 72, fieldCapacity: 32, wiltingPoint: 12,
  }, rows));
  assert.equal(enriched[0].detail.depletionFraction, 0.85);
  assert.equal(enriched[0].detail.floorDepletion, 0.7, 'the 18% floor is 70% depleted');
  assert.match(enriched[0].summary, /85% depletion/);
});

test('soil-deficit-band refuses configurations that can never mean anything', async () => {
  const rule = loadRules().get('soil-deficit-band');
  await assert.rejects(
    () => rule.run(ctxFor(rule, { floor: 28, ceiling: 18 })), /must be below ceiling/);
  await assert.rejects(
    () => rule.run(ctxFor(rule, { floor: 20, ceiling: 20 })), /must be below ceiling/);
  await assert.rejects(
    () => rule.run(ctxFor(rule, { maxOutOfBandFraction: 1 })), /could ever raise/);
  // One soil constant alone cannot produce a depletion fraction, and silently
  // ignoring the half-configured pair would hide the mistake.
  await assert.rejects(
    () => rule.run(ctxFor(rule, { fieldCapacity: 32 })), /must be set together/);
  await assert.rejects(
    () => rule.run(ctxFor(rule, { fieldCapacity: 12, wiltingPoint: 32 })),
    /must be above wiltingPoint/);
});

// ── fact-pass regressions: validation and judgement on stub rows ─────────────

test('M19 soil-deficit-band refuses minCoverage 0, which judged 0/0 as NaN%', async () => {
  const rule = loadRules().get('soil-deficit-band');
  await assert.rejects(() => rule.run(ctxFor(rule, { minCoverage: 0 })), /above 0/);
  // Covered time of zero is never judged, whatever the coverage setting.
  const findings = await rule.run(ctxFor(rule, { lookbackHours: 72, minCoverage: 0.01 }, [
    residencyRow({ hours_below: '0', hours_in: '0', hours_above: '0' }),
  ]));
  assert.deepEqual(findings, []);
});

test('L7 soil-deficit-band: clearMarginFraction must be strictly less than the raise line', async () => {
  const rule = loadRules().get('soil-deficit-band');
  await assert.rejects(
    () => rule.run(ctxFor(rule, { maxOutOfBandFraction: 0.25, clearMarginFraction: 0.25 })),
    /less than maxOutOfBandFraction/,
  );
  await assert.doesNotReject(
    () => rule.run(ctxFor(rule, { maxOutOfBandFraction: 0.25, clearMarginFraction: 0.24 })),
  );
});

test('L8 soil-deficit-band: the summary says the fraction is of OBSERVED time', async () => {
  const rule = loadRules().get('soil-deficit-band');
  const [f] = await rule.run(ctxFor(rule, { lookbackHours: 72 }, [
    residencyRow({ hours_below: '45', hours_in: '25', hours_above: '0' }),
  ]));
  assert.match(f.summary, /for 64% of the observed 70h of the 72h window/);
  assert.equal(f.detail.observedHours, 70);
});

/** One accumulation row in the shape windowAccumulation's SQL returns. */
function accumulationRow(over = {}) {
  return {
    dev_eui: 'aa11bb22cc33dd44', device_name: 'gauge-1', matched_path: 'rain.total',
    total: '0', samples: '12', covered_hours: '24', gap_hours: '0',
    vmin: '0', vmax: '1', first_at: '2026-09-24T00:00:00.000Z',
    last_at: '2026-09-25T00:00:00.000Z',
    ...over,
  };
}

test('M17 measurement-accumulation applies minCoverage to method "sum" too', async () => {
  // A gauge that reported for 3h of 24 has not measured a day's rain.
  const rule = loadRules().get('measurement-accumulation');
  const params = { method: 'sum', scale: 1, base: null, min: 5, unit: ' mm', minCoverage: 0.8 };
  const thin = await rule.run(ctxFor(rule, params, [
    accumulationRow({ total: '1', covered_hours: '3', gap_hours: '21' }),
  ]));
  assert.deepEqual(thin, []);
  const covered = await rule.run(ctxFor(rule, params, [accumulationRow({ total: '1' })]));
  assert.equal(covered.length, 1, 'a fully covered short total still fires');
});

test('M18 measurement-accumulation judges the coverage-projected total, both ways', async () => {
  const rule = loadRules().get('measurement-accumulation');
  // 8 GDD observed over 0.8 of the window is 10 at full coverage — on target.
  const row = accumulationRow({ total: '192', covered_hours: '19.2', gap_hours: '4.8' });
  assert.deepEqual(await rule.run(ctxFor(rule, { min: 10 }, [row])), []);

  // And over a limit by projection, even though the observed total is under it.
  const [f] = await rule.run(ctxFor(rule, { max: 9 }, [row]));
  assert.ok(Math.abs(f.detail.projectedTotal - 10) < 0.001);
  assert.ok(Math.abs(f.detail.observedTotal - 8) < 0.001);
  assert.equal(f.detail.coverage, 0.8);
  assert.match(f.summary, /8 GDD observed over 80% of the window, projected to full coverage/);

  await assert.rejects(() => rule.run(ctxFor(rule, { min: 1, minCoverage: 0 })), /above 0/);
});

test('M2 measurement-threshold validates maxGapMinutes', async () => {
  const rule = loadRules().get('measurement-threshold');
  await assert.rejects(
    () => rule.run(ctxFor(rule, { min: 1, sustainMinutes: 30, maxGapMinutes: 0 })),
    /maxGapMinutes must be positive/,
  );
  assert.equal(rule.defaultParams.maxGapMinutes, 90);
});

test('H10 response-missing validates the responseDevices map', async () => {
  const rule = loadRules().get('response-missing');
  const run = (responseDevices) => rule.run(ctxFor(rule, { responseDevices }));
  await assert.rejects(() => run(['a840410001810001']), /must be an object/);
  await assert.rejects(() => run({ meter: ['a840410001810002'] }), /key "meter" is not a 16-digit hex/);
  await assert.rejects(() => run({ a840410001810001: 'a840410001810002' }), /non-empty array/);
  await assert.rejects(() => run({ a840410001810001: [] }), /non-empty array/);
  await assert.rejects(() => run({ a840410001810001: ['zz40410001810002'] }), /\[0\] is not a 16-digit hex/);
  await assert.doesNotReject(() => run({ A840410001810001: ['a840410001810002'] }));
  await assert.doesNotReject(() => run(null));
});

// ── lintConfig / leadsman lint ───────────────────────────────────────────────
// The database-free half of verify. It exists because a config file is the part of
// a deployment most likely to be hand-edited and least likely to be tested, and
// until now the only tool that could check one needed a reachable Postgres.

const { lintConfig } = require('../dist/verify.js');

const lint = async (raw) => lintConfig(parseConfig(raw), loadRules());
const messages = (problems) => problems.map((p) => `${p.severity} ${p.where}: ${p.message}`);

test('lint catches a parameter combination that can never fire', async () => {
  // The whole point. Every one of these is a check that runs forever, finds nothing,
  // and is indistinguishable from a healthy fleet — the failure this engine exists
  // to remove, reproduced in its own config.
  const cases = [
    [{ rule: 'measurement-threshold', as: 'no-bounds', params: { min: null, max: null } },
      /at least one of "min" or "max"/],
    [{ rule: 'measurement-dwell', as: 'too-long',
       params: { comparison: 'atLeast', dwellHours: 400, lookbackHours: 168 } },
      /could never fire/],
    [{ rule: 'mold-risk', as: 'open-gate',
       params: { temperatureMin: null, temperatureMax: null } },
      /the gate would admit every reading/],
    [{ rule: 'measurement-accumulation', as: 'zero-scale', params: { min: 5, scale: 0 } },
      /scale must not be zero/],
    [{ rule: 'response-missing', as: 'unjudgeable',
       params: { responseWindowHours: 48, lookbackHours: 48 } },
      /no trigger could ever be old enough/],
  ];

  for (const [check, pattern] of cases) {
    const problems = await lint({ checks: [check] });
    const errors = problems.filter((p) => p.severity === 'error');
    assert.equal(errors.length, 1, `${check.as}: expected one error, got ${messages(problems)}`);
    assert.match(errors[0].message, pattern);
    assert.match(errors[0].where, new RegExp(`^checks\\.${check.as}`));
  }
});

test('lint catches an unknown rule and a typo\'d parameter', async () => {
  const problems = await lint({
    checks: [
      { rule: 'no-such-rule', as: 'ghost' },
      { rule: 'measurement-threshold', as: 'typo', params: { min: 1, lookbackHrs: 6 } },
    ],
  });
  assert.match(messages(problems).join('\n'), /error checks\.ghost: unknown rule/);
  // A typo'd parameter silently falls back to the default, which looks like the
  // check "not working" for weeks — so it fails lint rather than warning.
  assert.match(messages(problems).join('\n'), /error checks\.typo\.params: "lookbackHrs"/);
});

test('lint reports a rule whose prerequisites this config cannot supply', async () => {
  const withoutForecast = await lint({
    checks: [{ rule: 'forecast-threshold', as: 'frost', params: {} }],
  });
  assert.match(messages(withoutForecast).join(), /no forecast provider configured/);
  // And says nothing once it is configured — a forecast rule must not also be
  // reported as a parameter error just because it declines to run without a source.
  const withForecast = await lint({
    forecast: { latitude: 38.8, longitude: -122, apiKey: 'k' },
    checks: [{ rule: 'forecast-threshold', as: 'frost', params: {} }],
  });
  assert.deepEqual(messages(withForecast), []);
});

test('lint flags a gating window that is the same as no window', async () => {
  const problems = await lint({
    checks: [{
      rule: 'device-silent', as: 'all-year',
      activeMonths: [1,2,3,4,5,6,7,8,9,10,11,12],
    }],
  });
  assert.match(messages(problems).join(), /all twelve months, which is the same as omitting it/);
});

test('lint passes both shipped example configs', async () => {
  for (const file of ['../config/leadsman.example.json',
                      '../config/makerfabs-agrosense.example.json']) {
    const problems = await lint(require(file));
    const errors = problems.filter((p) => p.severity === 'error');
    assert.deepEqual(errors, [], `${file}: ${messages(errors).join('; ')}`);
  }
});

test('lint does not run a rule that would need a database to validate', async () => {
  // The stub context returns no rows, so a rule that gets past its own parameter
  // validation finds nothing and reports nothing. A clean config must lint clean.
  const problems = await lint({
    checks: [
      { rule: 'device-silent', as: 'silent' },
      { rule: 'measurement-threshold', as: 'frost', params: { min: 1.5, max: null } },
      { rule: 'measurement-outlier', as: 'probes', params: { minGroupSize: 4 } },
      { rule: 'measurement-implausible', as: 'implausible' },
    ],
  });
  assert.deepEqual(messages(problems), []);
});

test('CLI: lint validates a config with no database configured', () => {
  const res = cli(['lint', '--config', 'config/leadsman.example.json']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /checks: \d+ \(\d+ enabled\)/);
});

test('CLI: lint exits 1 on an error but 0 on warnings alone', () => {
  // Warnings do not fail: "will be SKIPPED" is a legitimate deployment state, and a
  // gate that rejects it cannot be used in CI.
  const ok = cli(['lint', '--config', 'config/makerfabs-agrosense.example.json']);
  assert.equal(ok.status, 0, ok.stdout);

  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'leadsman-lint-')), 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({
    checks: [{ rule: 'measurement-threshold', as: 'x', params: { min: null, max: null } }],
  }));
  const res = cli(['lint', '--config', bad]);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /can never fire/);
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
  // mold-risk is the one measurement-shaped rule in the set, and it is here because
  // acting on it needs the crop stage, the spray history and the forecast — none of
  // which are in the event store. See the rule header.
  assert.deepEqual(situations.sort(), [
    'device-silent', 'geofence-breach', 'join-churn', 'measurement-outlier',
    'mold-risk', 'response-missing', 'soil-deficit-band',
  ]);
});

test('every situation rule can actually reach an agent route at its own severity', () => {
  // Found by a fact pass, not by any existing test. Routing consults bySeverity
  // BEFORE the fact/situation class, so a rule that is `info` AND `situation` is
  // silenced by the common `{"info": null}` policy before its class is ever read —
  // it is simultaneously "worth an LLM invocation" and "too trivial to deliver".
  // measurement-outlier shipped that way for exactly one session.
  const rules = loadRules();
  const cfg = {
    destinations: { oncall: {}, agent: {} },
    bySeverity: { info: null },
    routing: { fact: 'oncall', situation: 'agent' },
    defaultDestination: 'oncall',
  };

  const unreachable = [];
  for (const [id, rule] of rules) {
    if (rule.defaultRouting !== 'situation') continue;
    const dest = resolveDestination(
      { severity: rule.defaultSeverity }, { routing: 'situation' }, cfg,
    );
    if (dest !== 'agent') unreachable.push(`${id} (${rule.defaultSeverity}) -> ${dest}`);
  }
  assert.deepEqual(unreachable, [],
    'a situation rule whose default severity is silenced can never be interpreted');
});

test('the generic measurement rules default to fact, not situation', () => {
  const rules = loadRules();
  // These serve many meanings at once, so they cannot know they are a situation. Defaulting
  // them to 'situation' would send every threshold alert to an LLM.
  for (const id of [
    'measurement-threshold', 'measurement-peak', 'measurement-rate',
    'measurement-stuck', 'measurement-missing', 'counter-spike', 'counter-stalled',
    // These two are generic mechanisms too, despite the agronomic names in their
    // docs: one config can use measurement-derived for both a greenhouse VPD alarm
    // and a livestock THI warning, and the rule cannot know which it is.
    'measurement-accumulation', 'measurement-derived',
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
      gateway_id: 'aaaa000000000001', receptions: '900', timestamped: '0', gps_timed: '0',
      history_timestamped: '0', history_gps_timed: '0', skew_compared: '0', skew_vs_ns: '0',
      max_skew: null, avg_skew: null, last_seen: '2026-09-09T07:00:00.000Z',
    }],
  });
  assert.deepEqual(await rule.run(never), []);

  // Had a lock, mostly lost it: that is the fault.
  const lost = stubCtx({
    params: { ...rule.defaultParams },
    query: async () => [{
      gateway_id: 'aaaa000000000001', receptions: '900', timestamped: '90', gps_timed: '0',
      history_timestamped: '2000', history_gps_timed: '0', skew_compared: '0', skew_vs_ns: '0',
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
    historical_level: '3',
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
    query: async () => [row({ historical_level: '1' })],
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

// ── seasonal and diurnal gating ──────────────────────────────────────────────
// Evaluated by the runner rather than inside a rule, so it applies uniformly to all
// 34 checks including the gateway and host ones that take no measurement params.

const { outOfSeason } = require('../dist/runner.js');

test('outOfSeason: no window configured means always active', () => {
  assert.equal(outOfSeason({}, new Date('2026-07-15T12:00:00Z'), 'UTC'), null);
});

test('outOfSeason: a month outside activeMonths is skipped, and says which', () => {
  const july = new Date('2026-07-15T12:00:00Z');
  const frost = { activeMonths: [1, 2, 3, 10, 11, 12] };
  assert.match(outOfSeason(frost, july, 'UTC'), /month 7 is not in activeMonths/);
  assert.equal(outOfSeason(frost, new Date('2026-11-15T12:00:00Z'), 'UTC'), null);
});

test('outOfSeason: a month list that wraps the year end works unchanged', () => {
  // A southern-hemisphere summer, and a northern dormancy. The engine does not need
  // to know which, and must not assume a list is contiguous or ascending.
  const summer = { activeMonths: [11, 12, 1, 2] };
  assert.equal(outOfSeason(summer, new Date('2026-12-20T12:00:00Z'), 'UTC'), null);
  assert.equal(outOfSeason(summer, new Date('2026-01-20T12:00:00Z'), 'UTC'), null);
  assert.match(outOfSeason(summer, new Date('2026-06-20T12:00:00Z'), 'UTC'), /month 6/);
});

test('outOfSeason: hours are evaluated in the config timezone, not UTC', () => {
  // 06:00 UTC is 23:00 the previous day in Los Angeles. A frost window expressed in
  // local night hours would otherwise be wrong by the whole offset every single
  // night, which is the entire period it is supposed to cover.
  const night = { activeHours: [22, 23, 0, 1, 2, 3, 4, 5] };
  const at = new Date('2026-11-15T06:00:00Z'); // 23:00 the previous day in Los Angeles
  assert.equal(outOfSeason(night, at, 'America/Los_Angeles'), null, '23:00 local is in the window');
  assert.match(outOfSeason(night, at, 'UTC'), /hour 6 is not in activeHours/, 'UTC would disagree');
});

test('outOfSeason: midnight is hour 0, not hour 24', () => {
  // Intl renders midnight as "24" in some locales under hour12:false, which would
  // make a check configured for [0,1,2] silently skip every midnight.
  const night = { activeHours: [0] };
  assert.equal(outOfSeason(night, new Date('2026-11-15T00:30:00Z'), 'UTC'), null);
});

test('outOfSeason: an unusable timezone falls back to UTC rather than failing', () => {
  const check = { activeHours: [12] };
  assert.equal(outOfSeason(check, new Date('2026-11-15T12:30:00Z'), 'Mars/Olympus'), null);
});

test('parseConfig rejects an empty activeMonths rather than disabling the check', () => {
  // "activeMonths": [] reads like a placeholder and would silently turn the check off
  // forever. Refusing it is the difference between a typo and a mystery.
  assert.throws(
    () => parseConfig({ checks: [{ rule: 'device-silent', activeMonths: [] }] }),
    /must not be empty/,
  );
});

test('parseConfig validates the range of activeMonths and activeHours', () => {
  assert.throws(
    () => parseConfig({ checks: [{ rule: 'device-silent', activeMonths: [0] }] }),
    /from 1 to 12/,
  );
  assert.throws(
    () => parseConfig({ checks: [{ rule: 'device-silent', activeHours: [24] }] }),
    /from 0 to 23/,
  );
  // Deduplicated and sorted, so a hand-edited list behaves predictably.
  const cfg = parseConfig({ checks: [{ rule: 'device-silent', activeMonths: [12, 1, 12] }] });
  assert.deepEqual(cfg.checks[0].activeMonths, [1, 12]);
});

// ── the forecast config block ────────────────────────────────────────────────

test('parseConfig reads a forecast block and defaults the optional fields', () => {
  const cfg = parseConfig({
    checks: [],
    forecast: { latitude: 38.795, longitude: -121.993, apiKey: 'k' },
  });
  assert.equal(cfg.forecast.provider, 'weatherbit');
  assert.equal(cfg.forecast.hours, 48);
  assert.equal(cfg.forecast.timeoutMs, 8000);
});

test('parseConfig rejects coordinates that would silently forecast the wrong place', () => {
  // A transposed pair, or a string, otherwise fails at 3am against a metered API —
  // or worse, succeeds and returns a real forecast for another hemisphere.
  assert.throws(
    () => parseConfig({ checks: [], forecast: { latitude: 138.5, longitude: -121 } }),
    /latitude must be between -90 and 90/,
  );
  assert.throws(
    () => parseConfig({ checks: [], forecast: { latitude: '38.5', longitude: -121 } }),
    /latitude must be a number/,
  );
  assert.throws(
    () => parseConfig({ checks: [], forecast: { latitude: 38.5 } }),
    /longitude must be a number/,
  );
});

test('parseConfig rejects an unknown forecast provider by name', () => {
  assert.throws(
    () => parseConfig({ checks: [], forecast: { provider: 'accuweather', latitude: 1, longitude: 2 } }),
    /must be "weatherbit"/,
  );
});

test('a forecast block is required — an env key alone is not consent to call the API', () => {
  const prev = process.env.LEADSMAN_WEATHERBIT_API_KEY;
  try {
    process.env.LEADSMAN_WEATHERBIT_API_KEY = 'k';
    assert.equal(parseConfig({ checks: [] }).forecast, undefined);
  } finally {
    if (prev === undefined) delete process.env.LEADSMAN_WEATHERBIT_API_KEY;
    else process.env.LEADSMAN_WEATHERBIT_API_KEY = prev;
  }
});

// ── the new rules refuse the configurations that can never fire ──────────────

test('measurement-accumulation rejects a scale of zero and a bad coverage fraction', async () => {
  const rule = loadRules().get('measurement-accumulation');
  await assert.rejects(() => rule.run(ctxFor(rule, { min: 1, scale: 0 })), /scale must not be zero/);
  await assert.rejects(
    () => rule.run(ctxFor(rule, { min: 1, minCoverage: 1.5 })),
    /minCoverage must be between 0 and 1/,
  );
  await assert.rejects(() => rule.run(ctxFor(rule, { min: 1, method: 'average' })), /"integral" or "sum"/);
});

test('measurement-derived rejects an unknown formula, naming the ones that exist', async () => {
  const rule = loadRules().get('measurement-derived');
  await assert.rejects(
    () => rule.run(ctxFor(rule, { formula: 'humidex' })),
    /formula must be one of vpd, dewPoint, deltaT, thi, absoluteHumidity/,
  );
});

test('measurement-derived computes the published formulas correctly', async () => {
  const rule = loadRules().get('measurement-derived');
  const row = (t, rh) => [{
    dev_eui: 'aa', device_name: 'glasshouse', primary_path: 'air.temperature',
    secondary_path: 'air.relativeHumidity', primary_value: String(t),
    secondary_value: String(rh), at: '2026-09-22T12:00:00.000Z',
  }];

  // 20 °C / 50 % RH: es = 2.3388 kPa, so VPD = 1.169. Textbook worked example.
  const vpd = await rule.run(ctxFor(rule, { formula: 'vpd', max: 1 }, row(20, 50)));
  assert.equal(vpd.length, 1);
  assert.ok(Math.abs(vpd[0].detail.value - 1.169) < 0.005, `got ${vpd[0].detail.value}`);

  // Dew point at 50 % RH and 20 °C is ~9.3 °C.
  const dew = await rule.run(ctxFor(rule, { formula: 'dewPoint', max: 5 }, row(20, 50)));
  assert.ok(Math.abs(dew[0].detail.value - 9.3) < 0.1, `got ${dew[0].detail.value}`);

  // At 100 % RH the dew point IS the dry bulb, and delta-T is zero.
  const saturated = await rule.run(ctxFor(rule, { formula: 'dewPoint', max: 5 }, row(20, 100)));
  assert.ok(Math.abs(saturated[0].detail.value - 20) < 0.2, `got ${saturated[0].detail.value}`);
  const dt = await rule.run(ctxFor(rule, { formula: 'deltaT', max: 0.5 }, row(20, 100)));
  assert.deepEqual(dt, [], 'delta-T at saturation is ~0, which is inside max 0.5');

  // THI 72 is the dairy action line. 25 °C at 50 % RH computes to 71.8 — just UNDER
  // it, which is the correct answer and worth pinning, since an off-by-a-little
  // formula would put it the other side of the line an operator acts on.
  const under = await rule.run(ctxFor(rule, { formula: 'thi', max: 72 }, row(25, 50)));
  assert.deepEqual(under, [], 'THI at 25C/50% is 71.8, below the action line');

  const thi = await rule.run(ctxFor(rule, { formula: 'thi', max: 72 }, row(26, 60)));
  assert.equal(thi.length, 1);
  assert.ok(thi[0].detail.value > 74 && thi[0].detail.value < 75, `got ${thi[0].detail.value}`);
});

test('measurement-derived skips a pair whose formula cannot produce a number', async () => {
  // A codec emitting 250 % humidity is measurement-implausible's problem. Producing
  // NaN here and comparing it to a bound would silently never fire.
  const rule = loadRules().get('measurement-derived');
  const findings = await rule.run(ctxFor(rule, { formula: 'vpd', max: 0.1 }, [{
    dev_eui: 'aa', device_name: null, primary_path: 'air.temperature',
    secondary_path: 'air.relativeHumidity', primary_value: 'NaN',
    secondary_value: '50', at: '2026-09-22T12:00:00.000Z',
  }]));
  assert.deepEqual(findings, []);
});

test('M16 measurement-derived skips out-of-range humidity instead of clamping it', async () => {
  // 250 % RH used to clamp to 100 and compute as saturated air: vpd 0, delta-T 0 and
  // dew point = T, so each of these low-bound checks fired on a sensor fault.
  const rule = loadRules().get('measurement-derived');
  const row = (t, rh, tp = 'air.temperature') => [{
    dev_eui: 'aa', device_name: null, primary_path: tp,
    secondary_path: 'air.relativeHumidity', primary_value: String(t),
    secondary_value: String(rh), at: '2026-09-22T12:00:00.000Z',
  }];
  for (const [formula, bounds] of [
    ['vpd', { min: 0.2, max: null }],
    ['deltaT', { min: 2, max: null }],
    ['dewPoint', { min: null, max: 15 }],
    ['thi', { min: null, max: 60 }],
    ['absoluteHumidity', { min: null, max: 5 }],
  ]) {
    for (const rh of [250, -5]) {
      assert.deepEqual(
        await rule.run(ctxFor(rule, { formula, ...bounds }, row(20, rh))), [],
        `${formula} at ${rh} % RH must be skipped`,
      );
    }
    // In range, the same bounds do fire — the skip is about the input, not the bound.
    assert.equal(
      (await rule.run(ctxFor(rule, { formula, ...bounds }, row(20, formula === 'vpd' || formula === 'deltaT' ? 100 : 80)))).length,
      1, `${formula} must still fire on a valid pair`,
    );
  }
  // Below absolute zero is outside the vocabulary's temperature range.
  assert.deepEqual(await rule.run(ctxFor(rule, { formula: 'vpd', max: 0 }, row(-300, 50))), []);
  // Exactly 0 % RH stays a valid input: the dew point log guard keeps it finite.
  const dry = await rule.run(ctxFor(rule, { formula: 'dewPoint', max: 100 }, row(20, 0)));
  assert.deepEqual(dry, []);
  const dryLow = await rule.run(ctxFor(rule, { formula: 'dewPoint', min: -30, max: null }, row(20, 0)));
  assert.equal(dryLow.length, 1);
  assert.ok(Number.isFinite(dryLow[0].detail.value));
});

test('M6 lint: measurement rules refuse windows that can never fire', async () => {
  const rules = loadRules();
  const refuses = async (id, over, re) => {
    const rule = rules.get(id);
    await assert.rejects(() => rule.run(ctxFor(rule, over)), re, `${id} ${JSON.stringify(over)}`);
  };
  await refuses('measurement-rate', { minSpanHours: 10, lookbackHours: 6 }, /minSpanHours .* must be less than lookbackHours/);
  await refuses('measurement-rate', { minSpanHours: 6, lookbackHours: 6 }, /minSpanHours/);
  await refuses('measurement-rate', { lookbackHours: 0, minSpanHours: 0 }, /lookbackHours must be positive/);
  for (const id of [
    'measurement-peak', 'measurement-stuck', 'measurement-implausible', 'measurement-derived',
    'measurement-threshold', 'battery-low', 'boolean-alarm',
  ]) {
    // A threshold needs a bound before it reaches the window check.
    const base = id === 'measurement-threshold' ? { min: 1 } : {};
    await refuses(id, { ...base, lookbackHours: 0 }, /lookbackHours must be positive/);
    await refuses(id, { ...base, lookbackHours: -3 }, /lookbackHours must be positive/);
  }
  await refuses('measurement-missing', { recentHours: 0 }, /recentHours must be positive/);
  // A sane combination still passes.
  const rate = rules.get('measurement-rate');
  await assert.doesNotReject(() => rate.run(ctxFor(rate, { minSpanHours: 1, lookbackHours: 6 })));
});

test('M4 vocabulary: exclusive schema bounds are carried, not dropped', () => {
  const { VOCABULARY_RANGES } = require('../dist/vocabulary.js');
  assert.deepEqual(VOCABULARY_RANGES.get('wind.direction'), [0, 360, { max: true }]);
  // Inclusive rows stay plain pairs, and the vendored count is unchanged.
  assert.deepEqual(VOCABULARY_RANGES.get('air.relativeHumidity'), [0, 100]);
  assert.equal(VOCABULARY_RANGES.size, 73);
});

test('measurement-outlier refuses a group too small to have an odd one out', async () => {
  const rule = loadRules().get('measurement-outlier');
  await assert.rejects(
    () => rule.run(ctxFor(rule, { minGroupSize: 2 })),
    /with two devices there is no majority/,
  );
});

test('measurement-dwell allows an atMost target longer than the window', async () => {
  // A seasonal chill requirement is normally larger than the window it is sampled
  // over, and refusing that — as the atLeast direction must — would make the whole
  // accumulate-or-fail direction unusable.
  const rule = loadRules().get('measurement-dwell');
  await assert.doesNotReject(
    () => rule.run(ctxFor(rule, { comparison: 'atMost', dwellHours: 400, lookbackHours: 168 })),
  );
  await assert.rejects(
    () => rule.run(ctxFor(rule, { comparison: 'atLeast', dwellHours: 400, lookbackHours: 168 })),
    /could never fire/,
  );
});

test('response-missing refuses a response window no trigger could outlive', async () => {
  const rule = loadRules().get('response-missing');
  await assert.rejects(
    () => rule.run(ctxFor(rule, { responseWindowHours: 48, lookbackHours: 48 })),
    /no trigger could ever be old enough to judge/,
  );
});

test('forecast-threshold refuses a lead-time window that is empty', async () => {
  const rule = loadRules().get('forecast-threshold');
  const withForecast = (over) => ({
    ...ctxFor(rule, over),
    forecast: { centroid: { latitude: 0, longitude: 0 }, forecast: async () => ({
      at: { latitude: 0, longitude: 0 }, locationName: null,
      retrievedAt: new Date().toISOString(), hours: [],
    }) },
  });
  await assert.rejects(
    () => rule.run(withForecast({ afterHours: 12, withinHours: 6 })),
    /the lead-time window would be empty/,
  );
  await assert.rejects(
    () => rule.run(withForecast({ latitude: 38.5, longitude: null })),
    /must be set together/,
  );
});

test('forecast-threshold raises against the site, not a device', async () => {
  const rule = loadRules().get('forecast-threshold');
  const hours = [
    { at: '2026-11-15T02:00:00.000Z', leadHours: 2, values: { 'air.temperature': 4 } },
    { at: '2026-11-15T04:00:00.000Z', leadHours: 4, values: { 'air.temperature': -2.1 } },
    { at: '2026-11-15T06:00:00.000Z', leadHours: 6, values: { 'air.temperature': 0.5 } },
  ];
  const ctx = {
    ...ctxFor(rule, { min: 1.5, withinHours: 12, unit: 'C', locationLabel: 'Yolo 12A' }),
    forecast: { centroid: { latitude: 38.8, longitude: -122 }, forecast: async () => ({
      at: { latitude: 38.8, longitude: -122 }, locationName: 'Dunnigan',
      retrievedAt: '2026-11-15T00:00:00.000Z', hours,
    }) },
  };

  const found = await rule.run(ctx);
  assert.equal(found.length, 1, 'one alert for the site, not one per breaching hour');
  // A forecast is about a place. Pinning it on a device sends someone to look at a
  // sensor that is working perfectly.
  assert.deepEqual(found[0].subject, { kind: 'site', id: 'site', name: 'Yolo 12A' });
  assert.equal(found[0].detail.worstValue, -2.1, 'the summary leads with the worst hour');
  assert.equal(found[0].detail.leadHours, 4, 'and the lead time is to the FIRST breach');
  assert.equal(found[0].detail.hoursAffected, 2);
});

test('forecast-threshold honours minHours, so one overshot hour is not an event', async () => {
  const rule = loadRules().get('forecast-threshold');
  const hours = [
    { at: '2026-07-15T02:00:00.000Z', leadHours: 2, values: { 'air.temperature': 39 } },
    { at: '2026-07-15T03:00:00.000Z', leadHours: 3, values: { 'air.temperature': 36 } },
  ];
  const ctx = {
    ...ctxFor(rule, { min: null, max: 38, withinHours: 12, minHours: 3 }),
    forecast: { centroid: { latitude: 0, longitude: 0 }, forecast: async () => ({
      at: { latitude: 0, longitude: 0 }, locationName: null,
      retrievedAt: '2026-07-15T00:00:00.000Z', hours,
    }) },
  };
  assert.deepEqual(await rule.run(ctx), []);
});
