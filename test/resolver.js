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
  bandDwell, windowTrend, windowAccumulation, groupDeviation, triggerResponse,
  booleanDwell, latestPairs, resolvePaths,
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

  // ── bandDwell: duration inside a band ───────────────────────────────────────
  // This is the one resolver whose answer is a length of time rather than a value,
  // and every case below distinguishes it from an aggregate that would look the same
  // on a chart: total vs longest, broken vs unbroken, measured vs assumed.

  /** Hourly humidity readings, most recent last. `null` means the uplink is missing. */
  async function series(devEui, values, { gate = null, startMinutesAgo = null } = {}) {
    const start = startMinutesAgo ?? values.length * 60;
    for (let i = 0; i < values.length; i += 1) {
      if (values[i] === null) continue;
      const object = { air: { relativeHumidity: values[i] } };
      if (gate !== null && gate[i] !== null && gate[i] !== undefined) {
        object.air.temperature = gate[i];
      }
      await h.uplink(env.db, { devEui, minutesAgo: start - i * 60, object });
    }
  }

  const RH = () => P('air.relativeHumidity');
  const TEMP = { paths: [['air', 'temperature']], band: { min: 15, max: 25 } };

  test('bandDwell: measures the run from first in-band sample to last', async () => {
    // Four consecutive hourly readings in band span three hours, not four: the
    // duration is what was measured, not what the sampling interval implies.
    await series('aa', [70, 95, 95, 95, 95, 70]);
    const rows = await bandDwell(h.ctx(env.store), RH(), { min: 90, max: null }, 24, 2);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].hours, 3);
    assert.equal(rows[0].samples, 4);
    assert.equal(rows[0].max, 95);
  });

  test('bandDwell: returns the LONGEST run, not the total time in band', async () => {
    // 2h + 4h. A sum would say six hours and report an infection that did not happen.
    await series('aa', [95, 95, 95, 40, 95, 95, 95, 95, 95, 40]);
    const rows = await bandDwell(h.ctx(env.store), RH(), { min: 90, max: null }, 24, 2);

    assert.equal(rows[0].hours, 4, 'the second run, not the sum of both');
  });

  test('bandDwell: one out-of-band reading breaks the run', async () => {
    await series('aa', [95, 95, 95, 40, 95, 95, 95]);
    const rows = await bandDwell(h.ctx(env.store), RH(), { min: 90, max: null }, 24, 2);
    assert.equal(rows[0].hours, 2);
  });

  test('bandDwell: a reporting gap longer than maxGapHours breaks the run', async () => {
    // Readings 3, 4 and 5 never arrived. The canopy may have dried in that window and
    // nothing in the store says otherwise, so the run cannot be bridged across it.
    await series('aa', [95, 95, 95, null, null, null, 95, 95, 95]);

    const broken = await bandDwell(h.ctx(env.store), RH(), { min: 90, max: null }, 24, 2);
    assert.equal(broken[0].hours, 2, 'a 4h gap at maxGapHours=2 must split the run');

    // The same data with a tolerant gap setting is one continuous run.
    const bridged = await bandDwell(h.ctx(env.store), RH(), { min: 90, max: null }, 24, 6);
    assert.equal(bridged[0].hours, 8);
  });

  test('bandDwell: a single in-band reading is zero hours, not one', async () => {
    await series('aa', [40, 95, 40]);
    const rows = await bandDwell(h.ctx(env.store), RH(), { min: 90, max: null }, 24, 2);
    assert.equal(rows[0].hours, 0);
    assert.equal(rows[0].samples, 1);
  });

  test('bandDwell: a device that never entered the band is reported with zero hours', async () => {
    // Present-but-zero rather than absent: the caller has to be able to tell "nothing
    // is at risk" from "nothing is being measured".
    await series('aa', [40, 45, 50, 42]);
    const rows = await bandDwell(h.ctx(env.store), RH(), { min: 90, max: null }, 24, 2);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].hours, 0);
    assert.equal(rows[0].samples, 0);
    assert.equal(rows[0].startedAt, null);
    assert.equal(rows[0].windowSamples, 4);
  });

  test('bandDwell: the gate excludes samples whose own uplink was out of range', async () => {
    // Nine hours at 95% RH, but the first four were at 8C — the cold saturated night
    // that a humidity-only check reports as an infection period and a grower ignores.
    await series('aa', [95, 95, 95, 95, 95, 95, 95, 95, 95],
      { gate: [8, 8, 8, 8, 18, 18, 18, 18, 18] });

    const gated = await bandDwell(
      h.ctx(env.store), RH(), { min: 90, max: null }, 24, 2, TEMP,
    );
    assert.equal(gated[0].hours, 4, 'only the warm half counts');
    assert.equal(gated[0].gateMin, 18);
    assert.equal(gated[0].gateMax, 18);

    const ungated = await bandDwell(h.ctx(env.store), RH(), { min: 90, max: null }, 24, 2);
    assert.equal(ungated[0].hours, 8, 'and without the gate the whole night counts');
  });

  test('bandDwell: a sample with no gate value at all does not count', async () => {
    // The pairing is same-uplink, not nearest-in-time: a humidity reading with no
    // temperature beside it is a moment nothing is known about.
    await series('aa', [95, 95, 95, 95], { gate: [18, null, null, 18] });
    const rows = await bandDwell(
      h.ctx(env.store), RH(), { min: 90, max: null }, 24, 6, TEMP,
    );

    assert.equal(rows[0].hours, 0, 'two in-band samples three hours apart, each alone');
    assert.equal(rows[0].gateSamples, 2);
    assert.equal(rows[0].windowSamples, 4);
  });

  test('bandDwell: gateSamples is what tells a caller the gate blinded a device', async () => {
    await series('aa', [95, 95, 95, 95]); // humidity only, no temperature ever
    const rows = await bandDwell(
      h.ctx(env.store), RH(), { min: 90, max: null }, 24, 2, TEMP,
    );

    assert.equal(rows[0].hours, 0);
    assert.equal(rows[0].gateSamples, 0, 'zero coverage is the signal, not an empty result');
    assert.equal(rows[0].windowSamples, 4);
  });

  test('bandDwell: endedAt equal to lastSampleAt is how "still ongoing" is known', async () => {
    await series('aa', [40, 95, 95, 95]); // the run reaches the newest reading
    const running = await bandDwell(h.ctx(env.store), RH(), { min: 90, max: null }, 24, 2);
    // Compared as instants: pg returns timestamptz as a Date, and two Dates for the
    // same moment are not the same object. A rule doing this with === never fires.
    assert.equal(+new Date(running[0].endedAt), +new Date(running[0].lastSampleAt));

    await h.reset(env.db);
    await series('aa', [95, 95, 95, 40]); // it dried out an hour ago
    const done = await bandDwell(h.ctx(env.store), RH(), { min: 90, max: null }, 24, 2);
    assert.notEqual(+new Date(done[0].endedAt), +new Date(done[0].lastSampleAt));
  });

  test('bandDwell: a closed band excludes readings above it as well as below', async () => {
    await series('aa', [88, 92, 92, 92, 99, 92]);
    const rows = await bandDwell(h.ctx(env.store), RH(), { min: 90, max: 95 }, 24, 2);
    assert.equal(rows[0].hours, 2, '99 breaks the run from above');
  });

  test('bandDwell: resolves path priority per device, like every other resolver', async () => {
    await h.uplink(env.db, {
      devEui: 'aa', minutesAgo: 120, object: { leaf: { wetness: 95 }, air: { relativeHumidity: 10 } },
    });
    await h.uplink(env.db, {
      devEui: 'aa', minutesAgo: 60, object: { leaf: { wetness: 95 }, air: { relativeHumidity: 10 } },
    });

    const wetnessFirst = await bandDwell(
      h.ctx(env.store), P('leaf.wetness', 'air.relativeHumidity'), { min: 90, max: null }, 24, 2,
    );
    assert.equal(wetnessFirst[0].matchedPath, 'leaf.wetness');
    assert.equal(wetnessFirst[0].hours, 1);

    const humidityFirst = await bandDwell(
      h.ctx(env.store), P('air.relativeHumidity', 'leaf.wetness'), { min: 90, max: null }, 24, 2,
    );
    assert.equal(humidityFirst[0].matchedPath, 'air.relativeHumidity');
    assert.equal(humidityFirst[0].hours, 0, 'the winning path never entered the band');
  });

  test('bandDwell: per-device runs do not leak across devices', async () => {
    await series('aa', [95, 95, 95, 95]);
    await series('bb', [95, 40, 95, 40]);
    const rows = await bandDwell(h.ctx(env.store), RH(), { min: 90, max: null }, 24, 2);
    const byDev = Object.fromEntries(rows.map((r) => [r.devEui, r.hours]));
    assert.deepEqual(byDev, { aa: 3, bb: 0 });
  });

  test('bandDwell: honours the device scope', async () => {
    for (const m of [240, 180, 120, 60]) {
      await h.uplink(env.db, { devEui: 'aa', minutesAgo: m, profile: 'p1', object: { air: { relativeHumidity: 95 } } });
      await h.uplink(env.db, { devEui: 'bb', minutesAgo: m, profile: 'p2', object: { air: { relativeHumidity: 95 } } });
    }
    const rows = await bandDwell(
      h.ctx(env.store), RH(), { min: 90, max: null }, 24, 2, null,
      resolveScope({ deviceProfiles: ['p1'] }),
    );
    assert.deepEqual(rows.map((r) => r.devEui), ['aa']);
  });

  test('bandDwell: readings older than the window are not part of any run', async () => {
    // 48h of saturation, but a 6h window can only ever report 6h of it.
    await series('aa', Array(48).fill(95));
    const rows = await bandDwell(h.ctx(env.store), RH(), { min: 90, max: null }, 6, 2);
    assert.ok(rows[0].hours <= 6, `expected at most 6h, got ${rows[0].hours}`);
    assert.ok(rows[0].hours >= 4, `expected the window to be nearly full, got ${rows[0].hours}`);
  });

  // ── bandDwell: total mode ───────────────────────────────────────────────────

  test('bandDwell: total mode adds every run, longest mode takes one', async () => {
    // 2h + 4h in band. The two modes are two different agronomic questions and must
    // not be interchangeable: chill hours wants 6, an infection period wants 4.
    await series('aa', [95, 95, 95, 40, 95, 95, 95, 95, 95, 40]);

    const longest = await bandDwell(h.ctx(env.store), RH(), { min: 90, max: null }, 24, 2);
    assert.equal(longest[0].hours, 4);

    const total = await bandDwell(
      h.ctx(env.store), RH(), { min: 90, max: null }, 24, 2, null, undefined, 'total',
    );
    assert.equal(total[0].hours, 6, 'both runs, added');
    assert.equal(total[0].samples, 8, 'and every in-band reading: 3 + 5');
  });

  test('bandDwell: total mode still reports the longest run timestamps', async () => {
    // "When" has no meaning for a total, so the timestamps describe a real stretch
    // rather than a span stitched together out of unrelated ones.
    await series('aa', [95, 95, 40, 95, 95, 95, 95]);
    const total = await bandDwell(
      h.ctx(env.store), RH(), { min: 90, max: null }, 24, 2, null, undefined, 'total',
    );
    assert.equal(total[0].hours, 4, '1h + 3h');
    const span =
      (new Date(total[0].endedAt) - new Date(total[0].startedAt)) / 3_600_000;
    assert.ok(Math.abs(span - 3) < 0.01, `timestamps span the longest run, got ${span}`);
  });

  // ── windowTrend: least squares ──────────────────────────────────────────────

  test('windowTrend: recovers a known slope and reports a perfect fit', async () => {
    // A clean 2 units/hour ramp, hourly.
    for (let i = 0; i < 12; i += 1) {
      await h.uplink(env.db, { devEui: 'aa', minutesAgo: (11 - i) * 60, object: { v: i * 2 } });
    }
    const [t] = await windowTrend(h.ctx(env.store), P('v'), 24);
    assert.ok(Math.abs(t.slopePerHour - 2) < 0.01, `slope ${t.slopePerHour}`);
    assert.ok(t.r2 > 0.999, `r2 ${t.r2}`);
    assert.equal(t.samples, 12);
  });

  test('windowTrend: a bad endpoint cannot invent a trend the way endpoints can', async () => {
    // Twelve flat readings and one corrupted final sample. The endpoint method reads
    // this as a steep trend; the fit does not, and reports a fit nobody should trust.
    for (let i = 0; i < 12; i += 1) {
      await h.uplink(env.db, { devEui: 'aa', minutesAgo: (12 - i) * 60, object: { v: 50 } });
    }
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 0, object: { v: 120 } });

    const [w] = await windowStats(h.ctx(env.store), P('v'), 24);
    const endpointSlope = (w.last - w.first) /
      ((new Date(w.lastAt) - new Date(w.firstAt)) / 3_600_000);
    assert.ok(endpointSlope > 5, `endpoints read a steep trend: ${endpointSlope}/h`);

    const [t] = await windowTrend(h.ctx(env.store), P('v'), 24);
    assert.ok(t.slopePerHour < endpointSlope / 2, 'least squares is dragged far less');
    assert.ok(t.r2 < 0.5, `and reports a fit nobody should believe: r2 ${t.r2}`);
  });

  test('windowTrend: a single reading produces no row rather than a zero slope', async () => {
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 30, object: { v: 5 } });
    assert.deepEqual(await windowTrend(h.ctx(env.store), P('v'), 24), []);
  });

  // ── windowAccumulation ──────────────────────────────────────────────────────

  test('windowAccumulation: integral is the area, and base floors at zero', async () => {
    // 6 hourly readings at 20 °C, base 10 → 10 degree-hours per hour over 5 spans.
    for (let i = 0; i < 6; i += 1) {
      await h.uplink(env.db, {
        devEui: 'aa', minutesAgo: (5 - i) * 60, object: { air: { temperature: 20 } },
      });
    }
    const [a] = await windowAccumulation(
      h.ctx(env.store), P('air.temperature'), 24, 'integral', 10, 3,
    );
    assert.ok(Math.abs(a.total - 50) < 0.1, `50 degree-hours expected, got ${a.total}`);
    assert.ok(Math.abs(a.coveredHours - 5) < 0.01);
  });

  test('windowAccumulation: hours below the base contribute nothing, not a negative', async () => {
    // The degree-day definition. Cancelling cold hours against warm ones would make a
    // frosty night erase a warm afternoon and report a crop as behind when it is not.
    for (let i = 0; i < 5; i += 1) {
      await h.uplink(env.db, {
        devEui: 'aa', minutesAgo: (4 - i) * 60,
        object: { air: { temperature: i < 2 ? 0 : 20 } },
      });
    }
    const [a] = await windowAccumulation(
      h.ctx(env.store), P('air.temperature'), 24, 'integral', 10, 3,
    );
    assert.ok(a.total > 0, `never negative, got ${a.total}`);
    // Two hours at 0 °C contribute 0; the ramp and the warm hours contribute the rest.
    assert.ok(a.total <= 25.1, `and no more than the warm hours justify, got ${a.total}`);
  });

  test('windowAccumulation: a gap contributes nothing and is reported as a gap', async () => {
    // Holding the last value across a silent day would manufacture degree days out of
    // a dead radio, and an index that counts its own outages is worse than none.
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 600, object: { air: { temperature: 20 } } });
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 540, object: { air: { temperature: 20 } } });
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 60, object: { air: { temperature: 20 } } });
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 0, object: { air: { temperature: 20 } } });

    const [a] = await windowAccumulation(
      h.ctx(env.store), P('air.temperature'), 24, 'integral', 10, 2,
    );
    assert.ok(Math.abs(a.coveredHours - 2) < 0.02, `two 1h spans, got ${a.coveredHours}`);
    assert.ok(Math.abs(a.gapHours - 8) < 0.02, `and an 8h gap, got ${a.gapHours}`);
    assert.ok(Math.abs(a.total - 20) < 0.2, `only the covered hours count, got ${a.total}`);
  });

  test('windowAccumulation: sum ignores time, which is why it is the wrong default', async () => {
    // Same readings, twice the cadence. The integral is unchanged; the sum doubles.
    for (let i = 0; i < 5; i += 1) {
      await h.uplink(env.db, { devEui: 'aa', minutesAgo: (4 - i) * 60, object: { v: 10 } });
    }
    const [sparse] = await windowAccumulation(h.ctx(env.store), P('v'), 24, 'sum', null, 3);
    const [sparseI] = await windowAccumulation(h.ctx(env.store), P('v'), 24, 'integral', null, 3);

    await h.reset(env.db);
    for (let i = 0; i < 9; i += 1) {
      await h.uplink(env.db, { devEui: 'aa', minutesAgo: (8 - i) * 30, object: { v: 10 } });
    }
    const [dense] = await windowAccumulation(h.ctx(env.store), P('v'), 24, 'sum', null, 3);
    const [denseI] = await windowAccumulation(h.ctx(env.store), P('v'), 24, 'integral', null, 3);

    assert.equal(sparse.total, 50);
    assert.equal(dense.total, 90, 'the sum scales with reporting cadence');
    assert.ok(Math.abs(sparseI.total - denseI.total) < 0.2,
      'the integral does not — 40 unit-hours either way');
  });

  // ── groupDeviation ──────────────────────────────────────────────────────────

  /** n probes reading `values[i]`, six readings each. */
  async function probes(values) {
    for (let d = 0; d < values.length; d += 1) {
      for (let k = 0; k < 6; k += 1) {
        await h.uplink(env.db, {
          devEui: `p${d}`, minutesAgo: k * 60, object: { soil: { moisture: values[d] } },
        });
      }
    }
  }

  test('groupDeviation: finds the odd one out against the group median', async () => {
    await probes([30, 31, 30, 29, 18]);
    const rows = await groupDeviation(h.ctx(env.store), P('soil.moisture'), 24);
    const odd = rows.find((r) => r.devEui === 'p4');
    assert.equal(odd.groupMedian, 30);
    assert.equal(odd.groupSize, 5);
    assert.ok(odd.deviations < -3, `the dry probe is far out: ${odd.deviations}`);
    for (const r of rows.filter((x) => x.devEui !== 'p4')) {
      assert.ok(Math.abs(r.deviations) < 2, `${r.devEui} is not an outlier`);
    }
  });

  test('groupDeviation: MAD does not let one bad sensor hide inside its own spread', async () => {
    // The property standard deviation lacks. With six probes, one far-out reading
    // inflates sigma enough to fall within two of them; the median absolute deviation
    // does not move at all.
    const values = [30, 30, 31, 30, 29, 80];
    await probes(values);
    const rows = await groupDeviation(h.ctx(env.store), P('soil.moisture'), 24);
    const odd = rows.find((r) => r.devEui === 'p5');

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
    assert.ok(Math.abs(80 - mean) / sd < 2.3, 'under sigma it is barely an outlier');
    assert.ok(odd.deviations > 20, `under MAD it is unmissable: ${odd.deviations}`);
  });

  test('groupDeviation: a perfectly uniform group yields null, not a division by zero', async () => {
    await probes([30, 30, 30, 30]);
    const rows = await groupDeviation(h.ctx(env.store), P('soil.moisture'), 24);
    assert.ok(rows.every((r) => r.deviations === null), 'no spread means "cannot tell"');
  });

  // ── triggerResponse ─────────────────────────────────────────────────────────

  /** A counter advancing at `minutesAgo`, with a response series around it. */
  async function irrigation({ jump, moisture }) {
    // moisture[i] pairs with hour i, counting back from 12h ago.
    let total = 1000;
    for (let i = 0; i < 12; i += 1) {
      if (i === 4) total += jump;
      await h.uplink(env.db, {
        devEui: 'aa', deviceName: 'block-3', minutesAgo: (11 - i) * 60,
        object: { metering: { water: { total } }, soil: { moisture: moisture[i] } },
      });
    }
  }

  test('triggerResponse: pairs a counter advance with what the response did after it', async () => {
    await irrigation({ jump: 500, moisture: [20, 20, 20, 20, 20, 26, 28, 28, 27, 27, 26, 26] });
    const [r] = await triggerResponse(
      h.ctx(env.store), P('metering.water.total'), P('soil.moisture'), 48, 100, 6, 'rising',
    );
    assert.equal(r.triggerDelta, 500);
    assert.equal(r.baseline, 20, 'the last reading at or before the trigger');
    assert.equal(r.extreme, 28, 'and the furthest it got inside the window');
    assert.equal(r.change, 8);
  });

  test('triggerResponse: an irrigation that did nothing shows no movement', async () => {
    await irrigation({ jump: 500, moisture: Array(12).fill(20) });
    const [r] = await triggerResponse(
      h.ctx(env.store), P('metering.water.total'), P('soil.moisture'), 48, 100, 6, 'rising',
    );
    assert.equal(r.change, 0, 'the counter turned and the root zone never wetted');
  });

  test('triggerResponse: a trigger too recent to judge is not reported at all', async () => {
    // Reporting an irrigation before the water could reach the probe is an alert
    // guaranteed to be wrong rather than merely likely to be.
    let total = 1000;
    for (let i = 0; i < 6; i += 1) {
      if (i === 5) total += 500;
      await h.uplink(env.db, {
        devEui: 'aa', minutesAgo: (5 - i) * 30,
        object: { metering: { water: { total } }, soil: { moisture: 20 } },
      });
    }
    assert.deepEqual(
      await triggerResponse(
        h.ctx(env.store), P('metering.water.total'), P('soil.moisture'), 48, 100, 6, 'rising',
      ),
      [], 'the 6h response window has not elapsed',
    );
  });

  test('triggerResponse: an advance below the delta is not a trigger', async () => {
    await irrigation({ jump: 20, moisture: Array(12).fill(20) });
    assert.deepEqual(
      await triggerResponse(
        h.ctx(env.store), P('metering.water.total'), P('soil.moisture'), 48, 100, 6, 'rising',
      ),
      [], 'a 20-litre drift is not an irrigation',
    );
  });

  // ── booleanDwell ────────────────────────────────────────────────────────────

  /** A flag series, newest last. */
  async function flags(values, gapMinutes = 30) {
    for (let i = 0; i < values.length; i += 1) {
      await h.uplink(env.db, {
        devEui: 'aa', deviceName: 'coolroom', minutesAgo: (values.length - 1 - i) * gapMinutes,
        object: { action: { contactState: values[i] ? 'open' : 'closed' } },
      });
    }
  }
  const TRUE = ['true', '1', 'open'];

  test('booleanDwell: measures the CURRENT run, not the longest in the window', async () => {
    // The door stood open for hours yesterday and is shut now. An alert engine
    // answering "what is wrong at this moment" must not report that as a problem.
    await flags([true, true, true, true, true, false, false, true]);
    const [r] = await booleanDwell(h.ctx(env.store), P('action.contactState'), 24, TRUE, 2);
    assert.equal(r.asserted, true);
    assert.equal(r.hours, 0, 'one asserted reading in the current run');
    assert.equal(r.samples, 1);
  });

  test('booleanDwell: a flag that is clear now reports zero however long it was set', async () => {
    await flags([true, true, true, true, false]);
    const [r] = await booleanDwell(h.ctx(env.store), P('action.contactState'), 24, TRUE, 2);
    assert.equal(r.asserted, false);
    assert.equal(r.hours, 0);
    assert.equal(r.startedAt, null);
  });

  test('booleanDwell: an unbroken current run is measured end to end', async () => {
    await flags([false, true, true, true, true, true], 30);
    const [r] = await booleanDwell(h.ctx(env.store), P('action.contactState'), 24, TRUE, 2);
    assert.equal(r.asserted, true);
    assert.ok(Math.abs(r.hours - 2) < 0.02, `five readings 30 min apart = 2h, got ${r.hours}`);
    assert.equal(r.samples, 5);
  });

  test('booleanDwell: a reporting gap breaks the run', async () => {
    // The device was silent for three hours. It was not observed asserted throughout,
    // whatever it said either side.
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 300, object: { action: { contactState: 'open' } } });
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 240, object: { action: { contactState: 'open' } } });
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 60, object: { action: { contactState: 'open' } } });
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 0, object: { action: { contactState: 'open' } } });

    const [r] = await booleanDwell(h.ctx(env.store), P('action.contactState'), 24, TRUE, 2);
    assert.ok(Math.abs(r.hours - 1) < 0.02, `only the run since the gap, got ${r.hours}`);
  });

  // ── latestPairs ─────────────────────────────────────────────────────────────

  test('latestPairs: takes both values from ONE uplink, never across two', async () => {
    // A temperature from 04:00 with a humidity from 16:00 gives a VPD that is
    // arithmetically valid and physically meaningless.
    await h.uplink(env.db, {
      devEui: 'aa', minutesAgo: 120, object: { air: { temperature: 5, relativeHumidity: 95 } },
    });
    await h.uplink(env.db, {
      devEui: 'aa', minutesAgo: 60, object: { air: { temperature: 30 } }, // humidity dropped
    });

    const [p] = await latestPairs(
      h.ctx(env.store), P('air.temperature'), P('air.relativeHumidity'), 24,
    );
    assert.equal(p.primary, 5, 'the newest COMPLETE pair, not the newest uplink');
    assert.equal(p.secondary, 95);
  });

  test('latestPairs: a device reporting only one of the two is absent', async () => {
    await h.uplink(env.db, { devEui: 'aa', minutesAgo: 30, object: { air: { temperature: 20 } } });
    assert.deepEqual(
      await latestPairs(h.ctx(env.store), P('air.temperature'), P('air.relativeHumidity'), 24),
      [],
    );
  });

  test('latestPairs: both sides resolve by candidate priority, per device', async () => {
    await h.uplink(env.db, {
      devEui: 'aa', minutesAgo: 30, object: { air: { temperature: 20, relativeHumidity: 50 } },
    });
    await h.uplink(env.db, {
      devEui: 'bb', minutesAgo: 30, object: { temperature: 25, air: { relativeHumidity: 40 } },
    });
    const rows = await latestPairs(
      h.ctx(env.store), P('air.temperature', 'temperature'), P('air.relativeHumidity'), 24,
    );
    const byDev = Object.fromEntries(rows.map((r) => [r.devEui, r.primaryPath]));
    assert.deepEqual(byDev, { aa: 'air.temperature', bb: 'temperature' });
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
