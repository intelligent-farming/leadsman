// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Database-backed regressions for individual checks.
//
// test/resolver.js pins the shared resolvers; this file pins what a CHECK concludes
// from them — hysteresis across soundings, step-by-step counter semantics, the
// thresholds a rule's description promises. Each case is the smallest event store
// that reproduces a fact-pass finding, so a failure names the finding rather than a
// farm scenario. Like the other DB suites it skips cleanly without a server:
//
//   LEADSMAN_TEST_DATABASE_URL=postgres://... node --test test/checks.js

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers/db.js');
const { loadRules } = require('../dist/registry.js');

if (!h.available) {
  test('database-backed check regressions', { skip: h.skipMessage }, () => {});
} else {
  let env;
  test.before(async () => { env = await h.setup('checks'); });
  test.after(async () => { await h.teardown(env); });
  test.beforeEach(async () => { await h.reset(env.db); });

  const rules = loadRules();

  /** Run a rule with its defaults plus `params`, optionally with the device's alert open. */
  const run = (id, params = {}, { open = [] } = {}) => {
    const rule = rules.get(id);
    return rule.run(h.ctx(env.store, {
      params: { ...rule.defaultParams, ...params },
      openDevEuis: new Set(open),
      kind: id,
    }));
  };

  // ── devEuis scope ────────────────────────────────────────────────────────

  test('devEuis segments a check to named devices, in any case, alongside the other filters', async () => {
    // Two frost sensors, both cold; the north field is one of them.
    for (const [devEui, deviceName] of [['a840410000000001', 'frost-north'], ['a840410000000002', 'frost-south']]) {
      await h.uplink(env.db, { devEui, deviceName, minutesAgo: 5, object: { air: { temperature: 0.5 } } });
    }
    const frost = { paths: ['air.temperature'], min: 1.5, unit: 'C' };
    const all = await run('measurement-threshold', frost);
    assert.deepEqual(all.map((f) => f.devEui).sort(), ['a840410000000001', 'a840410000000002']);

    const north = await run('measurement-threshold', { ...frost, devEuis: ['A840410000000001'] });
    assert.deepEqual(north.map((f) => f.devEui), ['a840410000000001']);

    // ANDed with the name filter: a DevEUI outside the pattern is still excluded.
    assert.deepEqual(
      await run('measurement-threshold', { ...frost, devEuis: ['a840410000000001'], deviceNamePattern: '%south%' }),
      [],
    );
  });

  // ── geofence-breach (H13, M21) ────────────────────────────────────────────

  // 41.8–41.9 N, 93.7–93.5 W: the integration fixture's box. At this latitude 1° of
  // latitude is ~111 320 m and 1° of longitude ~82 900 m.
  const BOX = {
    shape: 'box', north: 41.9, south: 41.8, east: -93.5, west: -93.7, clearMargin: 25,
  };
  const fixAt = (latitude, longitude, minutesAgo = 5) =>
    h.uplink(env.db, {
      devEui: 'gps1', deviceName: 'trailer', minutesAgo,
      object: { position: { latitude, longitude } },
    });

  test('geofence-breach: a fix just outside a box edge stays open across soundings', async () => {
    // Regression H13: while open the box used to WIDEN by the margin (north + margin),
    // so a fix 22 m outside raised, resolved on the next sounding, and raised again —
    // and with the default margin of 25 (then degrees) anything within 25° resolved.
    await fixAt(41.9002, -93.6);
    const first = await run('geofence-breach', BOX);
    assert.equal(first.length, 1, 'raised on the first sounding');
    assert.deepEqual(first[0].detail.outsideEdges, ['north']);

    const second = await run('geofence-breach', BOX, { open: ['gps1'] });
    assert.equal(second.length, 1, 'still outside, so the open alert must not resolve');
    assert.match(second[0].summary, /outside the permitted area to the north/);
  });

  test('geofence-breach: back inside a box by less than clearMargin (metres) stays open', async () => {
    // ~11 m inside the north edge against a 25 m margin.
    await fixAt(41.8999, -93.6);
    const held = await run('geofence-breach', BOX, { open: ['gps1'] });
    assert.equal(held.length, 1, 'inside, but not by the margin — hold the alert');
    assert.equal(held[0].detail.withinClearMargin, true);
    assert.match(held[0].summary, /back inside the permitted area but within the 25m clear margin/);

    // The margin applies only while open: the same fix on a quiet fence is fine.
    assert.deepEqual(await run('geofence-breach', BOX), []);
  });

  test('geofence-breach: back inside a box by more than clearMargin resolves', async () => {
    // ~111 m inside the north edge.
    await fixAt(41.899, -93.6);
    assert.deepEqual(await run('geofence-breach', BOX, { open: ['gps1'] }), []);
  });

  test('geofence-breach: the box margin on longitude is metres scaled by cos(latitude)', async () => {
    // 0.0002° of longitude is ~17 m here — inside a 25 m margin; 0.001° is ~83 m.
    await fixAt(41.85, -93.5002);
    assert.equal((await run('geofence-breach', BOX, { open: ['gps1'] })).length, 1);
    await h.reset(env.db);
    await fixAt(41.85, -93.501);
    assert.deepEqual(await run('geofence-breach', BOX, { open: ['gps1'] }), []);
  });

  test('geofence-breach: a margin wider than the box cannot invert it', async () => {
    // A 10 km margin on an 11 km box: the shrunk edges meet at the centre line rather
    // than cross, so the alert holds (rather than every fix, or none, reading outside).
    await fixAt(41.87, -93.6);
    const found = await run('geofence-breach', { ...BOX, clearMargin: 10_000 }, { open: ['gps1'] });
    assert.equal(found.length, 1);
    assert.deepEqual(await run('geofence-breach', { ...BOX, clearMargin: 10_000 }), []);
  });

  test('geofence-breach: radius hysteresis is unchanged — inside by the margin resolves', async () => {
    const R = { shape: 'radius', centerLat: 41.85, centerLon: -93.6, radiusMetres: 100, clearMargin: 25 };
    await fixAt(41.85 + 90 / 111_320, -93.6); // ~90 m out: inside 100, not inside 75
    assert.equal((await run('geofence-breach', R, { open: ['gps1'] })).length, 1);
    assert.deepEqual(await run('geofence-breach', R), []);
  });

  test('geofence-breach: a (0, 0) "no fix" position is not a breach', async () => {
    // Regression M21: a tracker with no satellite fix reports 0, 0, which used to raise
    // a critical breach ~10 000 km out. Whether the resolver or the rule drops it, the
    // end-to-end answer is no finding.
    await fixAt(0, 0);
    assert.deepEqual(await run('geofence-breach', BOX), []);
    assert.deepEqual(await run('geofence-breach', BOX, { open: ['gps1'] }), []);
  });

  // ── counter-stalled / counter-spike (M22) ─────────────────────────────────

  /** Insert a meter series, oldest first, one reading per `stepMinutes`. */
  const series = async (devEui, values, stepMinutes = 60) => {
    for (let i = 0; i < values.length; i += 1) {
      await h.uplink(env.db, {
        devEui, deviceName: devEui, minutesAgo: (values.length - i) * stepMinutes,
        object: { metering: { water: { total: values[i] } } },
      });
    }
  };

  test('counter-stalled: a mid-window reset is a decrease even when last > first', async () => {
    // Regression M22: only last − first was compared. 1000 → 0 → … → 1100.5 is +100.5
    // end to end, which read as a healthy advancing meter.
    await series('m1', [1000, 0, 500, 1100, 1100.5]);
    const found = await run('counter-stalled');
    assert.equal(found.length, 1);
    assert.equal(found[0].detail.reason, 'decrease');
    assert.equal(found[0].severity, 'critical');
    assert.equal(found[0].detail.dropFrom, 1000);
    assert.equal(found[0].detail.dropTo, 0);
    assert.equal(found[0].detail.drops, 1);
    assert.ok(found[0].detail.dropAt, 'says when the reset landed');
    assert.match(found[0].summary, /went backwards: 1000 → 0/);
  });

  test('counter-stalled: the largest of several drops is the one reported', async () => {
    await series('m1', [100, 90, 200, 5, 50]);
    const [f] = await run('counter-stalled');
    assert.equal(f.detail.drops, 2);
    assert.equal(f.detail.maxDrop, 195);
    assert.match(f.summary, /200 → 5 \(largest of 2 drops\)/);
  });

  test('counter-stalled: with alertOnDecrease off, a reset neither masks a stall nor fakes an advance', async () => {
    // Stalled after a reset: last − first = −1000 used to skip the device entirely.
    await series('flat', [1000, 1000, 0, 0, 0]);
    // Advancing across a reset: the upward steps sum to 1100.5, which is real flow.
    await series('live', [1000, 0, 500, 1100, 1100.5]);
    const found = await run('counter-stalled', { alertOnDecrease: false });
    assert.deepEqual(found.map((f) => f.devEui), ['flat']);
    assert.equal(found[0].detail.reason, 'stalled');
    assert.equal(found[0].detail.advance, 0);
    assert.equal(found[0].detail.drops, 1);
  });

  test('counter-stalled: a plain monotonic meter is judged exactly as before', async () => {
    await series('ok', [10, 20, 30, 40]);
    await series('stuck', [44, 44, 44, 44]);
    const found = await run('counter-stalled');
    assert.deepEqual(found.map((f) => [f.devEui, f.detail.reason]), [['stuck', 'stalled']]);
  });

  test('counter-spike: a burst followed by a reset is still a spike', async () => {
    // Regression M22: 100 → 5000 → 0 → 200 has last − first of +100, so counter-spike
    // saw ~40 L/h, and it left decreases to counter-stalled — so the burst was caught
    // by neither. The upward steps are 4900 + 200 over 2 h.
    await series('burst', [100, 5000, 0, 200], 40);
    const spike = await run('counter-spike');
    assert.equal(spike.length, 1);
    assert.equal(spike[0].detail.advance, 5100);
    assert.equal(spike[0].detail.drops, 1);
    assert.ok(spike[0].detail.ratePerHour > 500);
    assert.match(spike[0].summary, /counted across a counter reset/);

    // And the reset itself is counter-stalled's to report.
    const stalled = await run('counter-stalled', { minSamples: 3 });
    assert.equal(stalled[0].detail.reason, 'decrease');
  });

  test('counter-spike: a reset alone is not consumption', async () => {
    // The drop contributes nothing to the rate: 5000 → 0 → 10 → 20 is 20 of flow.
    await series('reset', [5000, 0, 10, 20], 40);
    assert.deepEqual(await run('counter-spike'), []);
  });

  // ── decode-failure (L16) ──────────────────────────────────────────────────

  test('decode-failure: the defaults fire at half the uplinks failing, critical only when nearly all do', async () => {
    // Pins what the description now says. "The codec decodes nothing" was the old
    // wording; the default ratio is 0.5, and critical starts at 99 %.
    const mix = async (devEui, failed, ok) => {
      for (let i = 0; i < failed; i += 1) await h.uplink(env.db, { devEui, minutesAgo: 10 + i });
      for (let i = 0; i < ok; i += 1) {
        await h.uplink(env.db, { devEui, minutesAgo: 100 + i, object: { temperature: 20 } });
      }
    };
    await mix('half', 6, 4); // 60 %: warning
    await mix('all', 10, 0); // 100 %: critical
    await mix('some', 8, 12); // 40 %: below the default ratio
    const found = await run('decode-failure');
    const bySev = Object.fromEntries(found.map((f) => [f.devEui, f.severity ?? 'default']));
    assert.deepEqual(bySev, { half: 'default', all: 'critical' });
    assert.equal(rules.get('decode-failure').defaultSeverity, 'warning');
  });
}
