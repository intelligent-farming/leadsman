// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Database-backed tests for the seasonal and infection-model checks.
//
// test/agronomy.js pins the model arithmetic against hand-worked values, feeding the
// rules stubbed query results. This file runs the same rules against Postgres, so the
// whole path is exercised: the hourly-series and raw-reading SQL, the local-day
// bucketing, the season window, and the rule's reading of what comes back. Readings
// are written relative to the real clock — weeks of hourly uplinks ending now — and the
// context runs in UTC. Like the other DB suites it skips cleanly without a server:
//
//   LEADSMAN_TEST_DATABASE_URL=postgres://... node --test test/seasonal.js

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers/db.js');
const { loadRules } = require('../dist/registry.js');

if (!h.available) {
  test('database-backed seasonal checks', { skip: h.skipMessage }, () => {});
} else {
  let env;
  test.before(async () => { env = await h.setup('seasonal'); });
  test.after(async () => { await h.teardown(env); });
  test.beforeEach(async () => { await h.reset(env.db); });

  const rules = loadRules();
  const run = (id, params = {}, { open = [] } = {}) => {
    const rule = rules.get(id);
    return rule.run(h.ctx(env.store, {
      params: { ...rule.defaultParams, ...params },
      openDevEuis: new Set(open),
      kind: id,
    }));
  };

  const HOUR = 3_600_000;
  /** Today's UTC date, and `n` days before it, as YYYY-MM-DD. */
  const dayAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  /** The top of the current UTC hour. */
  const thisHour = () => Math.floor(Date.now() / HOUR) * HOUR;

  /**
   * Hourly uplinks for one device, at the top of every UTC hour from `from` (a Date)
   * up to now. `objectAt(date)` returns the decoded object, or null to skip that hour.
   * One INSERT for the whole series.
   */
  async function hourly(devEui, from, objectAt, deviceName = devEui) {
    const times = [];
    const objects = [];
    for (let t = Math.ceil(from.getTime() / HOUR) * HOUR; t <= Date.now(); t += HOUR) {
      const o = objectAt(new Date(t));
      if (o === null) continue;
      times.push(new Date(t).toISOString());
      objects.push(JSON.stringify(o));
    }
    await env.db.query(
      `INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object)
       SELECT t, $3, $4, 'test-profile', o::jsonb
         FROM unnest($1::timestamptz[], $2::text[]) AS u(t, o)`,
      [times, objects, devEui, deviceName],
    );
    return times.length;
  }
  const midnight = (date) => new Date(`${date}T00:00:00Z`);

  // ── degree-day-milestone ─────────────────────────────────────────────────

  test('degree-day-milestone: a steady 20 °C season reaches its milestone from real hourly rows', async () => {
    // 20 °C flat with a 10 °C base is 10 °C-days a day by any method. Fifteen complete
    // days since `since` is 150 — past the 100 milestone, short of 1000.
    const since = dayAgo(15);
    await hourly('dd1', midnight(since), () => ({ air: { temperature: 20 } }));
    const [f] = await run('degree-day-milestone', {
      since, method: 'average', lower: 10, holdHours: 24 * 30,
      milestones: [{ at: 100, label: 'first flight' }, { at: 1000, label: 'second flight' }],
    });
    assert.ok(f, 'milestone raised');
    assert.equal(f.detail.milestone, 'first flight');
    assert.equal(f.detail.total, 150);
    assert.equal(f.detail.reachedOn, dayAgo(6), 'the tenth complete day');
    assert.equal(f.detail.nextMilestone, 'second flight');
  });

  test('degree-day-milestone: a device silent for most of the season is refused, not under-counted', async () => {
    const since = dayAgo(15);
    // Only the last three days reported.
    await hourly('dd2', midnight(dayAgo(3)), () => ({ air: { temperature: 20 } }));
    assert.deepEqual(await run('degree-day-milestone', {
      since, method: 'average', lower: 10, holdHours: 24 * 30,
      milestones: [{ at: 20, label: 'x' }],
    }), []);
  });

  // ── chill-accumulation ───────────────────────────────────────────────────

  test('chill-accumulation: hours below 7.2 °C since the season start, reached and short', async () => {
    // 30 days at 5 °C: every hour counts, about 720 of them.
    const since = dayAgo(30);
    await hourly('ch1', midnight(since), () => ({ air: { temperature: 5 } }), 'pistachio-1');
    const md = since.slice(5);
    const [met] = await run('chill-accumulation', {
      model: 'hours', hoursMin: null, hoursMax: 7.2, since: md, requirement: 500, comparison: 'reached',
    });
    assert.ok(met, 'requirement met');
    assert.ok(met.detail.total >= 700 && met.detail.total <= 745, `total ${met.detail.total}`);
    assert.equal(met.detail.since, since);

    // Short of 2000 on or after byDate (a week ago), with the label a wheat entry uses.
    const [short] = await run('chill-accumulation', {
      model: 'hours', hoursMin: 0, hoursMax: 7.2, since: md, requirement: 2000,
      byDate: dayAgo(7).slice(5), unitLabel: 'vernalization hours',
    });
    assert.ok(short, 'shortfall raised');
    assert.equal(short.detail.unit, 'vernalization hours');
    assert.ok(short.detail.remaining > 1000);
  });

  test('chill-accumulation: warm hours earn nothing', async () => {
    const since = dayAgo(20);
    await hourly('ch2', midnight(since), () => ({ air: { temperature: 12 } }));
    const [short] = await run('chill-accumulation', {
      model: 'hours', since: since.slice(5), requirement: 10, byDate: dayAgo(1).slice(5),
    });
    assert.equal(short.detail.total, 0);
  });

  // ── disease-index ────────────────────────────────────────────────────────

  test('disease-index wallin: severity values from real RH and temperature rows', async () => {
    // RH 95 % for 16 h of every UTC day at 20 °C: SV 3 a day. From emergence eight days
    // ago, the 18th SV falls on the sixth complete day.
    const since = dayAgo(8);
    await hourly('lb1', midnight(since), (t) => ({
      air: { temperature: 20, relativeHumidity: t.getUTCHours() < 16 ? 95 : 70 },
    }), 'potato-1');
    const [f] = await run('disease-index', {
      model: 'wallin', since, threshold: 18, wetnessPaths: ['air.relativeHumidity'], wetMin: 90,
      holdHours: 24 * 30,
    });
    assert.ok(f, 'spray point raised');
    assert.equal(f.detail.totalSv, 24, 'eight complete days at SV 3');
    assert.equal(f.detail.crossedOn, dayAgo(3));
    assert.equal(f.detail.svSinceCrossing, 6);
  });

  test('disease-index tomcast: leaf wetness hours from real rows', async () => {
    // 10 wet hours a day at 19 °C: 2 DSV a day. Threshold 15 is crossed on day eight.
    const since = dayAgo(9);
    await hourly('tc1', midnight(since), (t) => ({
      air: { temperature: 19 }, leaf: { wetness: t.getUTCHours() < 10 ? 80 : 5 },
    }), 'tomato-1');
    const [f] = await run('disease-index', {
      model: 'tomcast', since, threshold: 15, wetMin: 50, holdHours: 24 * 30,
    });
    assert.ok(f, 'spray point raised');
    assert.equal(f.detail.totalDsv, 18);
    assert.equal(f.detail.crossedOn, dayAgo(2));
  });

  // ── daily-streak ─────────────────────────────────────────────────────────

  const SMITH = [
    { paths: ['air.temperature'], statistic: 'min', min: 10 },
    { paths: ['air.relativeHumidity'], statistic: 'hoursInBand', bandMin: 90, min: 11 },
  ];

  test('daily-streak: a Smith Period across two humid nights needs a 09:00 day', async () => {
    // Humid 20:00–08:00 on the nights ending two days ago and yesterday: 12 h each.
    const d3 = dayAgo(3), d2 = dayAgo(2), d1 = dayAgo(1);
    const humid = (t) => {
      const day = t.toISOString().slice(0, 10), hr = t.getUTCHours();
      return ((day === d3 || day === d2) && hr >= 20) || ((day === d2 || day === d1) && hr < 8);
    };
    await hourly('sm1', midnight(dayAgo(10)), (t) => ({
      air: { temperature: 14, relativeHumidity: humid(t) ? 95 : 60 },
    }), 'tomato-1');

    // Midnight days: 4 h, 12 h, 8 h — one day short of a period.
    assert.deepEqual(await run('daily-streak', { conditions: SMITH, days: 2, withinDays: 2 }), []);

    // 09:00 days hold one night each.
    const [f] = await run('daily-streak', { conditions: SMITH, days: 2, withinDays: 2, dayStartHour: 9 });
    assert.ok(f, 'Smith Period found');
    assert.equal(f.detail.from, d3);
    assert.equal(f.detail.to, d2);
  });

  // ── mold-risk infection curve ────────────────────────────────────────────

  const BROWN_ROT = [
    { temperatureMin: 5, temperatureMax: 8, dwellHours: 10.5 },
    { temperatureMin: 8, temperatureMax: 12, dwellHours: 6 },
    { temperatureMin: 12, temperatureMax: 16, dwellHours: 3.5 },
    { temperatureMin: 16, temperatureMax: 22, dwellHours: 3 },
    { temperatureMin: 22, temperatureMax: 25, dwellHours: 5 },
  ];

  /** Uplinks at the given hours before now, each with RH and temperature on the same uplink. */
  async function night(devEui, points) {
    for (const [hoursAgo, rh, t] of points) {
      await h.uplink(env.db, {
        devEui, deviceName: 'almond-1', minutesAgo: hoursAgo * 60,
        object: { air: { relativeHumidity: rh, temperature: t } },
      });
    }
  }

  test('mold-risk curve: a night cooling across a band edge raises where per-band entries miss', async () => {
    // Wet for 4 h, cooling from 14 °C to 11 °C: 3/3.5 + 1/6 of an infection.
    await night('br1', [[4, 95, 14], [3, 95, 14], [2, 95, 14], [1, 95, 11], [0, 95, 11]]);
    const [f] = await run('mold-risk', { curve: BROWN_ROT, lookbackHours: 24, minSamples: 4 });
    assert.ok(f, 'infection raised');
    assert.ok(f.detail.progress >= 1, `progress ${f.detail.progress}`);
    assert.deepEqual(f.detail.temperatureRange, [11, 14]);
    assert.equal(f.detail.ongoing, true);

    // The same night against one entry per band: neither band's run reaches its dwell.
    for (const b of BROWN_ROT) {
      assert.deepEqual(await run('mold-risk', { ...b, lookbackHours: 24, minSamples: 2, clearDwellHours: 0 }), [],
        `band ${b.temperatureMin}–${b.temperatureMax}`);
    }
  });

  test('mold-risk curve: a dry reading ends the run unless maxDryHours bridges it', async () => {
    const olive = [{ temperatureMin: 10, temperatureMax: 20, dwellHours: 12 }];
    // 8 h wet, 3 h dry, 8 h wet, at 15 °C.
    const points = [];
    for (let hr = 19; hr >= 0; hr--) points.push([hr, hr >= 9 && hr <= 11 ? 60 : 95, 15]);
    await night('pk1', points);
    assert.deepEqual(await run('mold-risk', { curve: olive, lookbackHours: 48 }), []);
    const [f] = await run('mold-risk', { curve: olive, lookbackHours: 48, maxDryHours: 6 });
    assert.ok(f, 'bridged run raised');
    assert.equal(f.detail.bridgedDryHours, 4, 'last wet reading before the break to the first after it');
    assert.ok(f.detail.progress >= 1);
  });
}
