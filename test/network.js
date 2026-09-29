// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Database-backed tests for the network-layer and host checks: the ones that read
// ChirpStack's own event_status / event_join / event_log tables, and the two that read
// Leadsman's own run history and cross-sounding state.
//
// Every case here is a regression for a behaviour a stubbed `query` cannot show: which
// row DISTINCT ON picks after the WHERE clause has run, what a correlated count returns
// for a device with no uplinks, what leadsman.run holds on the second sounding after a
// restart. Each builds the smallest store that distinguishes the fixed behaviour from
// the broken one.

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers/db.js');
const { loadRules } = require('../dist/registry.js');

if (!h.available) {
  test('database-backed network and host tests', { skip: h.skipMessage }, () => {});
} else {
  let env;
  let rules;
  test.before(async () => {
    env = await h.setup('network');
    rules = loadRules();
  });
  test.after(async () => { await h.teardown(env); });
  test.beforeEach(async () => { await h.reset(env.db); });

  const status = (db, {
    devEui, hoursAgo, battery = null, unavailable = false, external = false, margin = 10,
    profile = 'test-profile', deviceName = null,
  }) =>
    db.query(
      `INSERT INTO event_status (time, dev_eui, device_name, device_profile_name, margin,
                                 external_power_source, battery_level_unavailable, battery_level)
       VALUES (now() - make_interval(mins => $1::int), $2, $3, $4, $5, $6, $7, $8)`,
      [Math.round(hoursAgo * 60), devEui, deviceName, profile, margin, external, unavailable, battery],
    );

  const join = (db, { devEui, minutesAgo, devAddr }) =>
    db.query(
      `INSERT INTO event_join (time, dev_eui, device_profile_name, dev_addr)
       VALUES (now() - make_interval(mins => $1::int), $2, 'test-profile', $3)`,
      [minutesAgo, devEui, devAddr],
    );

  const logEntry = (db, { devEui, minutesAgo, level, code, description = 'x' }) =>
    db.query(
      `INSERT INTO event_log (time, dev_eui, device_profile_name, level, code, description)
       VALUES (now() - make_interval(mins => $1::int), $2, 'test-profile', $3, $4, $5)`,
      [minutesAgo, devEui, level, code, description],
    );

  const run = (rule, opts = {}) =>
    rule.run(h.ctx(env.store, { kind: rule.id, ...opts, params: { ...rule.defaultParams, ...opts.params } }));

  // ── status-battery-low (H3) ────────────────────────────────────────────────

  test('status-battery-low: a replaced battery clears even with an old low reading in the window', async () => {
    const rule = rules.get('status-battery-low');
    await status(env.db, { devEui: 'aa', hoursAgo: 72, battery: 15 });
    await status(env.db, { devEui: 'aa', hoursAgo: 1, battery: 95 });
    // Open alert or not, 95 % is past both thresholds.
    assert.deepEqual(await run(rule), []);
    assert.deepEqual(await run(rule, { openDevEuis: new Set(['aa']) }), []);
  });

  test('status-battery-low: a node now on external power resolves', async () => {
    const rule = rules.get('status-battery-low');
    await status(env.db, { devEui: 'aa', hoursAgo: 48, battery: 5 });
    // ChirpStack writes 0 for the percentage when the device is on external power.
    await status(env.db, { devEui: 'aa', hoursAgo: 1, battery: 0, external: true });
    assert.deepEqual(await run(rule, { openDevEuis: new Set(['aa']) }), []);

    // With ignoreExternalPower off, the latest percentage is thresholded as any other.
    const off = await run(rule, { params: { ignoreExternalPower: false } });
    assert.equal(off.length, 1);
    assert.equal(off[0].detail.batteryPercent, 0);
  });

  test('status-battery-low: a device now reporting battery unavailable resolves', async () => {
    const rule = rules.get('status-battery-low');
    await status(env.db, { devEui: 'aa', hoursAgo: 30, battery: 8 });
    await status(env.db, { devEui: 'aa', hoursAgo: 1, battery: 0, unavailable: true });
    assert.deepEqual(await run(rule, { openDevEuis: new Set(['aa']) }), []);
  });

  test('status-battery-low: hysteresis is applied to the latest reading', async () => {
    const rule = rules.get('status-battery-low');
    await status(env.db, { devEui: 'aa', hoursAgo: 50, battery: 90 });
    await status(env.db, { devEui: 'aa', hoursAgo: 2, battery: 22 });
    // 22 %: above the raise threshold (20) for a new alert, inside the clear band (25)
    // for an open one.
    assert.deepEqual(await run(rule), []);
    const held = await run(rule, { openDevEuis: new Set(['aa']) });
    assert.equal(held.length, 1);
    assert.equal(held[0].detail.batteryPercent, 22);
    assert.equal(held[0].detail.statusReadingsInWindow, 2);
  });

  // ── scope params (M10) ─────────────────────────────────────────────────────

  test('status-battery-low and status-margin-low declare the scope filters they apply', async () => {
    for (const id of ['status-battery-low', 'status-margin-low']) {
      const params = rules.get(id).defaultParams;
      assert.ok('deviceProfiles' in params, `${id} must declare deviceProfiles`);
      assert.ok('deviceNamePattern' in params, `${id} must declare deviceNamePattern`);
    }
    const rule = rules.get('status-battery-low');
    await status(env.db, { devEui: 'aa', hoursAgo: 1, battery: 5, profile: 'coin-cell' });
    await status(env.db, { devEui: 'bb', hoursAgo: 1, battery: 5, profile: 'mains' });
    const scoped = await run(rule, { params: { deviceProfiles: ['coin-cell'] } });
    assert.deepEqual(scoped.map((f) => f.devEui), ['aa']);
  });

  // ── join-churn (H5) ────────────────────────────────────────────────────────

  test('join-churn: joins with no uplinks at all fire critical, below maxJoins', async () => {
    const rule = rules.get('join-churn');
    for (let i = 0; i < 3; i++) {
      await join(env.db, { devEui: 'aa', minutesAgo: 60 * (i + 1), devAddr: `0000000${i}` });
    }
    const findings = await run(rule);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'critical');
    assert.equal(findings[0].detail.uplinksInWindow, 0);
    assert.equal(findings[0].detail.trigger, 'joinsExceedUplinks');
  });

  test('join-churn: joins outnumbering uplinks fire regardless of minUplinksForRatio', async () => {
    const rule = rules.get('join-churn');
    await join(env.db, { devEui: 'aa', minutesAgo: 120, devAddr: '00000001' });
    await join(env.db, { devEui: 'aa', minutesAgo: 60, devAddr: '00000002' });
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 30 });
    const findings = await run(rule);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'critical');
  });

  test('join-churn: a single join is never churn on its own', async () => {
    const rule = rules.get('join-churn');
    // Freshly commissioned: joined, no uplink yet.
    await join(env.db, { devEui: 'aa', minutesAgo: 10, devAddr: '00000001' });
    // 1 join / 4 uplinks: a normal session start, below minUplinksForRatio too.
    await join(env.db, { devEui: 'bb', minutesAgo: 600, devAddr: '00000002' });
    for (let i = 0; i < 4; i++) await h.uplink(env.db, { devEui: 'bb', minutesAgo: 60 * (i + 1) });
    // 1 join / 7 uplinks: a daily-interval device commissioned this week. Ratio 0.14
    // would pass maxJoinsPerUplinkRatio, but one join is not churn.
    await join(env.db, { devEui: 'cc', minutesAgo: 9000, devAddr: '00000003' });
    for (let i = 0; i < 7; i++) await h.uplink(env.db, { devEui: 'cc', minutesAgo: 1200 * (i + 1) });
    assert.deepEqual(await run(rule), []);
  });

  test('join-churn: the ratio test still raises a warning when uplinks outnumber joins', async () => {
    const rule = rules.get('join-churn');
    await join(env.db, { devEui: 'aa', minutesAgo: 600, devAddr: '00000001' });
    await join(env.db, { devEui: 'aa', minutesAgo: 300, devAddr: '00000002' });
    for (let i = 0; i < 15; i++) await h.uplink(env.db, { devEui: 'aa', minutesAgo: 20 * (i + 1) });
    const findings = await run(rule);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, undefined);
    assert.equal(findings[0].detail.trigger, 'ratio');
  });

  // ── device-log-error (M9, L13) ─────────────────────────────────────────────

  test('device-log-error: findings at default minLevel carry the configured severity', async () => {
    const rule = rules.get('device-log-error');
    assert.equal(rule.defaultSeverity, 'warning');
    for (let i = 0; i < 3; i++) {
      await logEntry(env.db, { devEui: 'aa', minutesAgo: 10 + i, level: '2', code: '2', description: 'codec error' });
    }
    const findings = await run(rule);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, undefined, 'must not escalate every ERROR to critical');
    assert.match(findings[0].summary, /3 ChirpStack errors/);
  });

  test('device-log-error: non-numeric levels are skipped, not cast, and code 7 is excluded at minLevel 1', async () => {
    const rule = rules.get('device-log-error');
    // A symbolic level must not abort the sounding, whatever order Postgres evaluates in.
    for (let i = 0; i < 5; i++) {
      await logEntry(env.db, { devEui: 'aa', minutesAgo: 10 + i, level: 'ERROR', code: '2' });
    }
    // Code 7 at level 1, exactly as ChirpStack v4 logs it.
    for (let i = 0; i < 5; i++) {
      await logEntry(env.db, { devEui: 'bb', minutesAgo: 10 + i, level: '1', code: '7' });
    }
    assert.deepEqual(await run(rule), []);
    assert.deepEqual(await run(rule, { params: { minLevel: 1 } }), []);
    // Without the exclusion, lowering minLevel is what exposes code 7.
    const noisy = await run(rule, { params: { minLevel: 1, excludeCodes: [] } });
    assert.deepEqual(noisy.map((f) => f.devEui), ['bb']);
  });

  // ── host-restarted (M8) ────────────────────────────────────────────────────

  const recordRun = (db, finishedMinutesAgo) =>
    db.query(
      `INSERT INTO leadsman.run (rule_id, kind, started_at, finished_at, status)
       VALUES ('x', 'x', now() - make_interval(mins => $1::int),
               now() - make_interval(mins => $1::int), 'ok')`,
      [finishedMinutesAgo],
    );

  test('host-restarted: the alert stays open on later soundings within withinMinutes', async () => {
    const rule = rules.get('host-restarted');
    const restartedAt = new Date(Date.now() - 40 * 60_000).toISOString();
    await recordRun(env.db, 40 + 390);   // last sounding 6.5 h before the restart

    const sounding = async () =>
      run(rule, {
        engine: {
          postmasterStartTime: restartedAt,
          // Exactly as the runner gathers it: the latest completed sounding.
          previousRunAt: await env.store.previousRunAt(),
          hostAddress: null,
        },
      });

    const first = await sounding();
    assert.equal(first.length, 1);
    assert.equal(first[0].detail.monitoringGapMinutes, 390);

    // The first post-restart sounding completes; the next one must still see the gap.
    await recordRun(env.db, 25);
    const second = await sounding();
    assert.equal(second.length, 1, 'the second post-restart sounding must still report it');
    assert.equal(second[0].detail.monitoringGapMinutes, 390);

    await recordRun(env.db, 10);
    assert.equal((await sounding()).length, 1);
  });

  test('host-restarted: resolves once the restart is older than withinMinutes', async () => {
    const rule = rules.get('host-restarted');
    const restartedAt = new Date(Date.now() - 130 * 60_000).toISOString();
    await recordRun(env.db, 130 + 390);
    await recordRun(env.db, 5);
    const findings = await run(rule, {
      engine: {
        postmasterStartTime: restartedAt,
        previousRunAt: await env.store.previousRunAt(),
        hostAddress: null,
      },
    });
    assert.deepEqual(findings, []);
  });

  // ── host-address-changed (H6) ──────────────────────────────────────────────

  const sound = (address) =>
    run(rules.get('host-address-changed'), {
      engine: { postmasterStartTime: null, previousRunAt: null, hostAddress: address },
    });

  test('host-address-changed: A → B → A resolves when the address comes back', async () => {
    assert.deepEqual(await sound('10.0.0.1'), []);
    const moved = await sound('10.0.0.2');
    assert.equal(moved.length, 1);
    assert.equal(moved[0].detail.previousAddress, '10.0.0.1');
    assert.deepEqual(await sound('10.0.0.1'), [], 'the gateways never left 10.0.0.1');
    // And the baseline is still A: a later move to B is reported from A again.
    const again = await sound('10.0.0.2');
    assert.match(again[0].summary, /from 10\.0\.0\.1 to 10\.0\.0\.2/);
  });

  test('host-address-changed: A → B → C reports from A, where the gateways still are', async () => {
    assert.deepEqual(await sound('10.0.0.1'), []);
    await sound('10.0.0.2');
    const c = await sound('10.0.0.3');
    assert.equal(c.length, 1);
    assert.match(c[0].summary, /from 10\.0\.0\.1 to 10\.0\.0\.3/);
    assert.match(c[0].summary, /still forwarding to 10\.0\.0\.1/);
  });

  test('host-address-changed: after openForHours the new address becomes the baseline', async () => {
    await env.store.setEngineState('host-address-changed:address', '10.0.0.1');
    await env.store.setEngineState('host-address-changed:change', JSON.stringify({
      previous: '10.0.0.1', current: '10.0.0.2',
      at: new Date(Date.now() - 100 * 3600_000).toISOString(),
    }));
    assert.deepEqual(await sound('10.0.0.2'), []);
    // The gateways were (assumed) re-pointed to .2, so going back to .1 is now a change.
    const back = await sound('10.0.0.1');
    assert.equal(back.length, 1);
    assert.match(back[0].summary, /from 10\.0\.0\.2 to 10\.0\.0\.1/);
  });
}
