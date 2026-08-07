// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Direct tests for the multi-path resolvers in src/measurement.ts.
//
// These were previously only exercised transitively, through fixtures large enough that
// several behaviours were indistinguishable from one another. In particular nothing
// asserted *priority* — the case where a device reports two candidate paths and the
// first must win. A resolver that silently picked the last candidate, or the
// alphabetically-first, passed every test in the suite.
//
// Each case here builds the smallest event store that can distinguish the behaviour
// under test, so a failure names the mechanism rather than a farm scenario.

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers/db.js');
const {
  latestReadings, latestBooleans, windowStats, pathPresence, latestCoordinates,
  resolvePaths,
} = require('../dist/measurement.js');
const { resolveScope, ANY_DEVICE } = require('../dist/scope.js');

if (!h.available) {
  test('database-backed resolver tests', { skip: h.skipMessage }, () => {});
} else {
  let env;
  test.before(async () => { env = await h.setup('resolver'); });
  test.after(async () => { await h.teardown(env); });
  test.beforeEach(async () => { await h.reset(env.db); });

  const P = (...dotted) => resolvePaths({ paths: dotted });

  // ── priority ────────────────────────────────────────────────────────────────

  test('latestReadings: the FIRST matching candidate wins when several are present', async () => {
    // The device reports both. A resolver that ignored ordinality would pick either.
    await h.uplink(env.db, {
      devEui: 'aa', minutesAgo: 5,
      object: { air: { temperature: 20 }, temperature: 99 },
    });

    const first = await latestReadings(h.ctx(env.store), P('air.temperature', 'temperature'), 24);
    assert.equal(first.length, 1);
    assert.equal(first[0].matchedPath, 'air.temperature');
    assert.equal(first[0].value, 20);

    // Reversing the candidate list must reverse the winner — proof that priority is
    // the list order and not a property of the data or the path name.
    const second = await latestReadings(h.ctx(env.store), P('temperature', 'air.temperature'), 24);
    assert.equal(second[0].matchedPath, 'temperature');
    assert.equal(second[0].value, 99);
  });

  test('latestReadings: falls through to a later candidate per device', async () => {
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 5, object: { air: { temperature: 20 } } });
    await h.uplink(env.db, { devEui: 'bb', minutesAgo: 5, object: { temperature: 4 } });

    const rows = await latestReadings(h.ctx(env.store), P('air.temperature', 'temperature'), 24);
    const byDev = Object.fromEntries(rows.map((r) => [r.devEui, r.matchedPath]));
    assert.deepEqual(byDev, { aa: 'air.temperature', bb: 'temperature' });
  });

  test('latestReadings: a device reporting none of the candidates is absent, not zero', async () => {
    // The distinction matters: a device treated as 0 would breach every "min" check.
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 5, object: { soil: { moisture: 30 } } });
    const rows = await latestReadings(h.ctx(env.store), P('air.temperature'), 24);
    assert.deepEqual(rows, []);
  });

  test('latestReadings: uses the most recent uplink, not an arbitrary one', async () => {
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 90, object: { temperature: 1 } });
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 5, object: { temperature: 2 } });
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 45, object: { temperature: 3 } });

    const rows = await latestReadings(h.ctx(env.store), P('temperature'), 24);
    assert.equal(rows[0].value, 2);
  });

  test('latestReadings: respects the lookback window', async () => {
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 60 * 30, object: { temperature: 5 } });
    assert.deepEqual(await latestReadings(h.ctx(env.store), P('temperature'), 24), []);
    assert.equal((await latestReadings(h.ctx(env.store), P('temperature'), 48)).length, 1);
  });

  // ── the numeric guard ───────────────────────────────────────────────────────
  // The SQL carries a regex guard before every ::numeric cast. It exists because
  // `additionalProperties` is open and vendor codecs really do emit "3.7V" or
  // "unknown" where a number belongs. Without the guard one bad row aborts the entire
  // sounding — every check, not just the one that hit it.

  test('numeric guard: non-numeric values are skipped without aborting the query', async () => {
    await h.uplink(env.db, { devEui: 'str', minutesAgo: 5, object: { temperature: '3.7V' } });
    await h.uplink(env.db, { devEui: 'txt', minutesAgo: 5, object: { temperature: 'unknown' } });
    await h.uplink(env.db, { devEui: 'bool', minutesAgo: 5, object: { temperature: true } });
    await h.uplink(env.db, { devEui: 'obj', minutesAgo: 5, object: { temperature: { v: 1 } } });
    await h.uplink(env.db, { devEui: 'nul', minutesAgo: 5, object: { temperature: null } });
    await h.uplink(env.db, { devEui: 'ok', minutesAgo: 5, object: { temperature: 21.5 } });

    // Must not throw, and must return only the usable reading.
    const rows = await latestReadings(h.ctx(env.store), P('temperature'), 24);
    assert.deepEqual(rows.map((r) => r.devEui), ['ok']);
    assert.equal(rows[0].value, 21.5);
  });

  test('numeric guard: quoted numeric strings ARE accepted', async () => {
    // Several codecs emit numbers as JSON strings. Rejecting those would silently
    // exclude whole device families.
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 5, object: { temperature: '21.5' } });
    await h.uplink(env.db, { devEui: 'bb', minutesAgo: 5, object: { temperature: '-3' } });

    const rows = await latestReadings(h.ctx(env.store), P('temperature'), 24);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.value).sort((a, b) => a - b), [-3, 21.5]);
  });

  // ── windowStats ─────────────────────────────────────────────────────────────

  test('windowStats: first and last are ordered by time, not by value or insert order', async () => {
    // measurement-rate and both counter checks compute (last - first). If these were
    // min/max or insert-ordered, a falling series would read as rising.
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 10, object: { v: 50 } });
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 190, object: { v: 90 } });
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 100, object: { v: 70 } });

    const [s] = await windowStats(h.ctx(env.store), P('v'), 24);
    assert.equal(s.first, 90, 'first must be the OLDEST reading');
    assert.equal(s.last, 50, 'last must be the NEWEST reading');
    assert.equal(s.min, 50);
    assert.equal(s.max, 90);
    assert.equal(s.samples, 3);
    assert.ok(new Date(s.firstAt) < new Date(s.lastAt));
  });

  test('windowStats: the winning path is chosen across the whole window', async () => {
    // A device that intermittently omits the higher-priority field must still be
    // evaluated on it, rather than flipping between paths sample to sample.
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 30, object: { air: { temperature: 10 }, temperature: 99 } });
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 20, object: { temperature: 99 } });
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 10, object: { air: { temperature: 12 }, temperature: 99 } });

    const [s] = await windowStats(h.ctx(env.store), P('air.temperature', 'temperature'), 24);
    assert.equal(s.matchedPath, 'air.temperature');
    assert.equal(s.samples, 2, 'only the samples carrying the winning path count');
    assert.equal(s.min, 10);
    assert.equal(s.max, 12);
  });

  test('windowStats: distinctValues underpins measurement-stuck', async () => {
    for (const m of [10, 20, 30, 40]) {
      await h.uplink(env.db, { devEui: 'stuck', minutesAgo: m, object: { v: 5 } });
      await h.uplink(env.db, { devEui: 'live', minutesAgo: m, object: { v: m } });
    }
    const rows = await windowStats(h.ctx(env.store), P('v'), 24);
    const byDev = Object.fromEntries(rows.map((r) => [r.devEui, r.distinctValues]));
    assert.equal(byDev.stuck, 1);
    assert.equal(byDev.live, 4);
  });

  test('windowStats: decimals rounds before counting distinct values', async () => {
    // A coarse sensor dithering in noise below its real resolution must read as stuck.
    for (const [i, v] of [30.001, 30.002, 30.0031, 30.0009].entries()) {
      await h.uplink(env.db, { devEui: 'aa', minutesAgo: (i + 1) * 10, object: { v } });
    }
    const [raw] = await windowStats(h.ctx(env.store), P('v'), 24, null);
    assert.equal(raw.distinctValues, 4, 'at full precision the readings differ');

    const [rounded] = await windowStats(h.ctx(env.store), P('v'), 24, 1);
    assert.equal(rounded.distinctValues, 1, 'at 1 decimal they are the same value');
  });

  // ── latestBooleans ──────────────────────────────────────────────────────────

  test('latestBooleans: matches JSON booleans, numbers, and enum strings', async () => {
    await h.uplink(env.db, { devEui: 'jsonTrue', minutesAgo: 5, object: { water: { leak: true } } });
    await h.uplink(env.db, { devEui: 'jsonFalse', minutesAgo: 5, object: { water: { leak: false } } });
    await h.uplink(env.db, { devEui: 'strTrue', minutesAgo: 5, object: { water: { leak: 'TRUE' } } });
    await h.uplink(env.db, { devEui: 'num', minutesAgo: 5, object: { water: { leak: 1 } } });
    await h.uplink(env.db, { devEui: 'zero', minutesAgo: 5, object: { water: { leak: 0 } } });

    const rows = await latestBooleans(
      h.ctx(env.store), P('water.leak'), 24, ['true', '1'],
    );
    const byDev = Object.fromEntries(rows.map((r) => [r.devEui, r.value]));
    assert.equal(byDev.jsonTrue, true);
    assert.equal(byDev.jsonFalse, false);
    assert.equal(byDev.strTrue, true, 'matching must be case-insensitive');
    assert.equal(byDev.num, true);
    assert.equal(byDev.zero, false);
  });

  test('latestBooleans: does not apply the numeric guard', async () => {
    // The guard would discard "open", which is exactly the contactState enum value
    // boolean-alarm exists to catch.
    await h.uplink(env.db, { devEui: 'gate', minutesAgo: 5, object: { action: { contactState: 'open' } } });
    const rows = await latestBooleans(h.ctx(env.store), P('action.contactState'), 24, ['open']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].value, true);
    assert.equal(rows[0].raw, 'open');
  });

  // ── pathPresence ────────────────────────────────────────────────────────────

  test('pathPresence: splits historical sightings from recent ones', async () => {
    // Reported the field 40h–20h ago, then stopped while uplinks continued.
    for (let i = 20; i <= 40; i += 4) {
      await h.uplink(env.db, { devEui: 'lost', minutesAgo: i * 60, object: { soil: { moisture: 30 } } });
    }
    for (let i = 1; i <= 6; i += 1) {
      await h.uplink(env.db, { devEui: 'lost', minutesAgo: i * 30, object: { air: { temperature: 18 } } });
    }
    // A control that never stopped.
    for (let i = 1; i <= 6; i += 1) {
      await h.uplink(env.db, { devEui: 'fine', minutesAgo: i * 30, object: { soil: { moisture: 31 } } });
    }

    const rows = await pathPresence(h.ctx(env.store), P('soil.moisture'), 168, 12);
    const byDev = Object.fromEntries(rows.map((r) => [r.devEui, r]));

    assert.ok(byDev.lost.everSeen >= 5);
    assert.equal(byDev.lost.recentSeen, 0, 'the field is gone from the recent window');
    assert.equal(byDev.lost.recentUplinks, 6, 'but the device is still transmitting');

    assert.ok(byDev.fine.recentSeen > 0, 'the control still reports the field');
  });

  // ── latestCoordinates ───────────────────────────────────────────────────────

  test('latestCoordinates: requires both latitude and longitude', async () => {
    await h.uplink(env.db, { devEui: 'both', minutesAgo: 5, object: { position: { latitude: 41.8, longitude: -93.6 } } });
    await h.uplink(env.db, { devEui: 'latOnly', minutesAgo: 5, object: { position: { latitude: 41.8 } } });

    const rows = await latestCoordinates(
      h.ctx(env.store), P('position.latitude'), P('position.longitude'), 24,
    );
    assert.deepEqual(rows.map((r) => r.devEui), ['both']);
    assert.equal(rows[0].lat, 41.8);
    assert.equal(rows[0].lon, -93.6);
  });

  // ── device scoping ──────────────────────────────────────────────────────────
  // The filter every fields-shared check depends on. If it leaked, a battery
  // threshold tuned for one hardware family would fire on all of them.

  test('scope: deviceProfiles restricts to the listed profiles', async () => {
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 5, profile: 'soil-v1', object: { battery: 3.0 } });
    await h.uplink(env.db, { devEui: 'bb', minutesAgo: 5, profile: 'light-v1', object: { battery: 3.0 } });

    const all = await latestReadings(h.ctx(env.store), P('battery'), 24, ANY_DEVICE);
    assert.equal(all.length, 2, 'an empty scope must match everything');

    const scoped = await latestReadings(
      h.ctx(env.store), P('battery'), 24, resolveScope({ deviceProfiles: ['light-v1'] }),
    );
    assert.deepEqual(scoped.map((r) => r.devEui), ['bb']);
  });

  test('scope: deviceNamePattern applies a LIKE filter', async () => {
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 5, deviceName: 'north-pump-1', object: { v: 1 } });
    await h.uplink(env.db, { devEui: 'bb', minutesAgo: 5, deviceName: 'soil-probe-2', object: { v: 1 } });

    const scoped = await latestReadings(
      h.ctx(env.store), P('v'), 24, resolveScope({ deviceNamePattern: '%pump%' }),
    );
    assert.deepEqual(scoped.map((r) => r.devEui), ['aa']);
  });

  test('scope: both filters combine as AND', async () => {
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 5, profile: 'p1', deviceName: 'pump-a', object: { v: 1 } });
    await h.uplink(env.db, { devEui: 'bb', minutesAgo: 5, profile: 'p2', deviceName: 'pump-b', object: { v: 1 } });

    const scoped = await latestReadings(
      h.ctx(env.store), P('v'), 24,
      resolveScope({ deviceProfiles: ['p1'], deviceNamePattern: '%pump%' }),
    );
    assert.deepEqual(scoped.map((r) => r.devEui), ['aa']);
  });

  test('scope: applies to windowStats and pathPresence too', async () => {
    for (const m of [10, 20, 30, 40]) {
      await h.uplink(env.db, { devEui: 'aa', minutesAgo: m, profile: 'p1', object: { v: m } });
      await h.uplink(env.db, { devEui: 'bb', minutesAgo: m, profile: 'p2', object: { v: m } });
    }
    const scope = resolveScope({ deviceProfiles: ['p1'] });

    const stats = await windowStats(h.ctx(env.store), P('v'), 24, null, scope);
    assert.deepEqual(stats.map((r) => r.devEui), ['aa']);

    const presence = await pathPresence(h.ctx(env.store), P('v'), 168, 12, scope);
    assert.deepEqual(presence.map((r) => r.devEui), ['aa']);
  });

  // ── malformed input must not reach SQL ──────────────────────────────────────

  test('resolvePaths rejects candidates that could alter the query shape', async () => {
    // Paths are bound as parameters, never interpolated, but rejecting junk early
    // gives a message naming the parameter instead of a Postgres cast error.
    for (const bad of [[], {}, 42, null, undefined, [''], [null]]) {
      assert.throws(() => resolvePaths({ paths: bad }), /param "paths"/);
    }
  });

  test('a path containing SQL metacharacters is treated as a literal key', async () => {
    // Proof the paths parameter is data, not code.
    const weird = "o'); DROP TABLE event_up; --";
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 5, object: { [weird]: 7 } });

    const rows = await latestReadings(h.ctx(env.store), [[weird]], 24);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].value, 7);

    const { rows: alive } = await env.db.query('SELECT count(*)::int AS n FROM event_up');
    assert.equal(alive[0].n, 1, 'event_up must still exist');
  });
}
