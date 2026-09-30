// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// The agronomic models and the rules built on them, without a database.
//
// The models in src/models.ts are published arithmetic, so most cases here pin a value
// that can be worked by hand from the paper or the extension page, and say where it
// came from. The rule cases feed hourly rows in the shape hourlySeries' SQL returns,
// so a rule's day bookkeeping — complete days, coverage, streaks, holds — is tested
// independently of the SQL, which test/resolver.js covers against a real server.

const test = require('node:test');
const assert = require('node:assert/strict');

const m = require('../dist/models.js');
const season = require('../dist/season.js');
const { loadRules } = require('../dist/registry.js');
const { parseConfig } = require('../dist/config.js');
const { lintConfig } = require('../dist/verify.js');

const close = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

// ── degree-days ──────────────────────────────────────────────────────────────

test('single sine: a day entirely between the thresholds is its mean minus the lower', () => {
  close(m.dailyDegreeDays(15, 25, 10, 30, 'sine'), 10);
});

test('single sine: a day straddling the lower threshold integrates the part above it', () => {
  // m = 20, w = 10, θ1 = asin(-0.5) = -π/6:
  // ((20-15)(π/2 + π/6) + 10 cos(π/6)) / π = (5·2.0944 + 8.6603) / π = 6.0900
  close(m.dailyDegreeDays(10, 30, 15, null, 'sine'), 6.09);
});

test('single sine: navel orangeworm at 50/80 °F against 55/94 °F', () => {
  // m = 65, w = 15, θ1 = asin(-10/15): ((10)(π/2 + 0.7297) + 15 cos 0.7297) / π
  close(m.dailyDegreeDays(50, 80, 55, 94, 'sine'), 10.882);
});

test('single sine is continuous across its case boundaries', () => {
  close(m.dailyDegreeDays(14.9999, 30, 15, null, 'sine'), m.dailyDegreeDays(15, 30, 15, null, 'sine'));
  close(m.dailyDegreeDays(15, 25.0001, 10, 25, 'sine'), m.dailyDegreeDays(15, 25, 10, 25, 'sine'));
});

test('single sine: horizontal cutoff credits the capped area, vertical drops it', () => {
  // A whole day above the upper threshold.
  assert.equal(m.dailyDegreeDays(31, 35, 10, 30, 'sine', 'horizontal'), 20);
  assert.equal(m.dailyDegreeDays(31, 35, 10, 30, 'sine', 'vertical'), 0);
  // A day through both thresholds: vertical is strictly less.
  const h = m.dailyDegreeDays(5, 35, 10, 30, 'sine', 'horizontal');
  const v = m.dailyDegreeDays(5, 35, 10, 30, 'sine', 'vertical');
  assert.ok(v < h && v > 0);
});

test('single sine: a day below the lower threshold is zero', () => {
  assert.equal(m.dailyDegreeDays(0, 9, 10, null, 'sine'), 0);
});

test('average method: (max + min) / 2 minus the base, never negative', () => {
  assert.equal(m.dailyDegreeDays(10, 30, 10, null, 'average'), 10);
  assert.equal(m.dailyDegreeDays(0, 12, 10, null, 'average'), 0);
});

test('corn modified method clamps both extremes into 50–86 °F', () => {
  // Purdue: a 90 °F max counts as 86 and a 45 °F min as 50 → (86 + 50) / 2 − 50 = 18.
  assert.equal(m.dailyDegreeDays(45, 90, 50, 86, 'modified'), 18);
  // A cold day cannot go negative, because the max is also floored at 50.
  assert.equal(m.dailyDegreeDays(35, 45, 50, 86, 'modified'), 0);
});

// ── chill ────────────────────────────────────────────────────────────────────

test('Utah units follow the Richardson et al. 1974 table', () => {
  const table = [[1.4, 0], [2, 0.5], [5, 1], [9.1, 1], [10, 0.5], [14, 0], [17, -0.5], [20, -1]];
  for (const [t, u] of table) assert.equal(m.utahUnits(t), u, `${t} °C`);
});

test('Utah accumulation never goes below zero', () => {
  // Warm hours before any chill cannot bank a debt.
  const temps = [...Array(48).fill(25), ...Array(10).fill(5)];
  assert.equal(m.accumulateChill(temps, 'utah'), 10);
});

test('chill hours: 0 < T ≤ 7.2 by default, or at or below 7.2 with no lower bound', () => {
  const temps = [-2, 0, 0.5, 7.2, 7.3];
  assert.equal(m.accumulateChill(temps, 'hours'), 2);
  assert.equal(m.accumulateChill(temps, 'hours', null, 7.2), 4);
});

test('Dynamic model: no chill at 15 °C, about 0.8 portions a day at 6 °C', () => {
  assert.equal(m.dynamicChillPortions(Array(720).fill(15)), 0);
  const cold = m.dynamicChillPortions(Array(720).fill(6));
  // Near-optimal chilling fixes a portion roughly every 28–30 hours.
  assert.ok(cold > 22 && cold < 27, `30 days at 6 °C gave ${cold}`);
});

test('Dynamic model: warmth before a portion is fixed destroys the precursor', () => {
  const cold = (n) => Array(n).fill(6);
  const steady = m.dynamicChillPortions(cold(72));
  const lastOnly = m.dynamicChillPortions(cold(52));
  // 20 cold hours alone fix nothing: it is all still precursor, and destructible.
  assert.equal(m.dynamicChillPortions(cold(20)), 0);
  // 12 h at 30 °C destroys that precursor outright: 72 cold hours in all, but the
  // result is what the last 52 alone earn — about one portion short of steady.
  const hot = m.dynamicChillPortions([...cold(20), ...Array(12).fill(30), ...cold(52)]);
  close(hot, lastOnly, 0.01);
  assert.ok(steady - hot > 0.9, `${hot} should be about a portion below ${steady}`);
  // 12 h at 22 °C only relaxes it toward its warm equilibrium: most of the first 20
  // hours survive, and the loss is a small fraction of a portion (1.9447 vs 1.9577).
  const mild = m.dynamicChillPortions([...cold(20), ...Array(12).fill(22), ...cold(52)]);
  assert.ok(mild < steady && steady - mild < 0.05, `${mild} should be just below ${steady}`);
});

// ── TOM-CAST ─────────────────────────────────────────────────────────────────

test('TOM-CAST DSV matches the UC IPM table row by row', () => {
  // 13–17 °C: 0–6, 7–15, 16–20, 21+
  assert.deepEqual([6, 7, 15, 16, 20, 21].map((h) => m.tomcastDsv(h, 15)), [0, 1, 1, 2, 2, 3]);
  // 18–20 °C and 26–29 °C: 0–3, 4–8, 9–15, 16–22, 23+
  assert.deepEqual([3, 4, 8, 9, 15, 16, 22, 23].map((h) => m.tomcastDsv(h, 19)), [0, 1, 1, 2, 2, 3, 3, 4]);
  assert.deepEqual([3, 4, 23].map((h) => m.tomcastDsv(h, 28)), [0, 1, 4]);
  // 21–25 °C: 0–2, 3–5, 6–12, 13–20, 21+
  assert.deepEqual([2, 3, 5, 6, 12, 13, 20, 21].map((h) => m.tomcastDsv(h, 23)), [0, 1, 1, 2, 2, 3, 3, 4]);
  // Outside 13–29 °C: nothing.
  assert.equal(m.tomcastDsv(24, 12), 0);
  assert.equal(m.tomcastDsv(24, 30), 0);
});

// ── Gubler-Thomas ────────────────────────────────────────────────────────────

const gtDay = (date, runHours, { heat = false, known = true } = {}) => ({ date, runHours, heat, known });

test('Gubler-Thomas starts at 60 after three consecutive qualifying days', () => {
  const s = m.gublerThomas([gtDay('d1', 6), gtDay('d2', 7), gtDay('d3', 8)]);
  assert.equal(s.index, 60);
  assert.equal(s.startedOn, 'd3');
});

test('Gubler-Thomas start-up is broken by a failing or unobserved day', () => {
  assert.equal(m.gublerThomas([gtDay('1', 6), gtDay('2', 5), gtDay('3', 6), gtDay('4', 6)]).index, null);
  assert.equal(m.gublerThomas([gtDay('1', 6), gtDay('2', 6, { known: false }), gtDay('3', 6)]).index, null);
});

test('Gubler-Thomas: +20, +10 with heat, −10 (never more), bounded 0–100, unknown days hold', () => {
  const start = [gtDay('1', 6), gtDay('2', 6), gtDay('3', 6)];
  assert.equal(m.gublerThomas([...start, gtDay('4', 6)]).index, 80);
  // A qualifying day that also reached 35 °C nets +10.
  assert.equal(m.gublerThomas([...start, gtDay('4', 6, { heat: true })]).index, 70);
  assert.equal(m.gublerThomas([...start, gtDay('4', 2)]).index, 50);
  // UC IPM: "On any one day the index should not decline by more than 10 points" —
  // heat on a day that already failed takes nothing further off.
  assert.equal(m.gublerThomas([...start, gtDay('4', 2, { heat: true })]).index, 50);
  assert.equal(m.gublerThomas([...start, gtDay('4', 6), gtDay('5', 6), gtDay('6', 6)]).index, 100);
  assert.equal(m.gublerThomas([...start, ...Array(10).fill(0).map((_, i) => gtDay(`x${i}`, 0))]).index, 0);
  assert.equal(m.gublerThomas([...start, gtDay('4', 0, { known: false })]).index, 60);
});

test('Gubler-Thomas spray intervals follow the UC IPM bands', () => {
  assert.equal(m.gublerThomasIntervals(20).sulfurDustDays, 14);
  assert.equal(m.gublerThomasIntervals(50).micronizedSulfurDays, 14);
  assert.deepEqual(m.gublerThomasIntervals(60), {
    pressure: 'high', sulfurDustDays: 7, micronizedSulfurDays: 10, dmiDays: 14,
  });
});

// ── hour and day bookkeeping ─────────────────────────────────────────────────

const hr = (hour, mean) => ({ hour, mean, min: mean, max: mean, samples: 1 });

test('longestRunInBand: a missing hour breaks the run', () => {
  const hours = ['00', '01', '02', '04', '05'].map((h) => hr(`2026-05-01T${h}`, 25));
  assert.equal(m.longestRunInBand(hours, 21, 29.4), 3);
  assert.equal(m.hoursInBand(hours, 21, 29.4), 5);
});

test('summarizeDays returns every date in range, including empty ones', () => {
  const days = m.summarizeDays([hr('2026-05-01T03', 10), hr('2026-05-03T03', 12)], '2026-05-01', '2026-05-03');
  assert.deepEqual(days.map((d) => [d.date, d.hoursObserved]), [['2026-05-01', 1], ['2026-05-02', 0], ['2026-05-03', 1]]);
});

// ── season arithmetic ────────────────────────────────────────────────────────

test('seasonStart: MM-DD is the most recent occurrence at or before today', () => {
  assert.equal(season.seasonStart('11-01', new Date('2027-02-10T12:00:00Z'), 'UTC'), '2026-11-01');
  assert.equal(season.seasonStart('11-01', new Date('2026-11-01T12:00:00Z'), 'UTC'), '2026-11-01');
  assert.equal(season.seasonStart('11-01', new Date('2026-10-31T12:00:00Z'), 'UTC'), '2025-11-01');
  assert.equal(season.seasonStart('2026-04-12', new Date('2026-09-01T00:00:00Z')), '2026-04-12');
});

test('seasonStart uses the local date, not UTC', () => {
  // 2026-11-01T05:00Z is still October 31 in Los Angeles.
  assert.equal(season.seasonStart('11-01', new Date('2026-11-01T05:00:00Z'), 'America/Los_Angeles'), '2025-11-01');
});

test('parseSince accepts MM-DD and YYYY-MM-DD and refuses non-dates', () => {
  assert.equal(season.parseSince('03-01'), '03-01');
  assert.equal(season.parseSince('2028-02-29'), '2028-02-29');
  for (const bad of ['02-29', '13-01', '2027-02-29', '3-1', 'spring', 20260101]) {
    assert.throws(() => season.parseSince(bad), /since/, String(bad));
  }
});

test('zonedMidnight finds local midnight across DST', () => {
  const la = 'America/Los_Angeles';
  assert.equal(season.zonedMidnight('2026-07-01', la).toISOString(), '2026-07-01T07:00:00.000Z');
  assert.equal(season.zonedMidnight('2026-12-01', la).toISOString(), '2026-12-01T08:00:00.000Z');
  // Midnight on the spring-forward day is still standard time.
  assert.equal(season.zonedMidnight('2026-03-08', la).toISOString(), '2026-03-08T08:00:00.000Z');
  assert.equal(season.zonedMidnight('2026-03-09', la).toISOString(), '2026-03-09T07:00:00.000Z');
});

test('zonedMidnight is exact in half-hour and 45-minute zones', () => {
  assert.equal(season.zonedMidnight('2026-09-01', 'Asia/Kolkata').toISOString(), '2026-08-31T18:30:00.000Z');
  assert.equal(season.zonedMidnight('2026-09-01', 'Asia/Kathmandu').toISOString(), '2026-08-31T18:15:00.000Z');
  // Chatham: +12:45 in winter, +13:45 from the last Sunday of September.
  assert.equal(season.zonedMidnight('2026-09-01', 'Pacific/Chatham').toISOString(), '2026-08-31T11:15:00.000Z');
  assert.equal(season.zonedMidnight('2026-12-01', 'Pacific/Chatham').toISOString(), '2026-11-30T10:15:00.000Z');
});

test('zonedMidnight: where DST skips midnight, the day starts at 01:00', () => {
  // Chile springs forward at 24:00 on Saturday: 2026-09-06 has no 00:00, and its first
  // instant is 01:00 −03 — not 23:00 −04 on the 5th.
  const scl = 'America/Santiago';
  assert.equal(season.zonedMidnight('2026-09-06', scl).toISOString(), '2026-09-06T04:00:00.000Z');
  assert.equal(season.zonedMidnight('2026-09-05', scl).toISOString(), '2026-09-05T04:00:00.000Z');
  assert.equal(season.zonedMidnight('2026-09-07', scl).toISOString(), '2026-09-07T03:00:00.000Z');
  // Cuba does the same at 00:00 on the second Sunday of March.
  assert.equal(season.zonedMidnight('2026-03-08', 'America/Havana').toISOString(), '2026-03-08T05:00:00.000Z');
  // Where midnight happens twice (Cuba falls back 01:00 → 00:00), the first one.
  assert.equal(season.zonedMidnight('2026-11-01', 'America/Havana').toISOString(), '2026-11-01T04:00:00.000Z');
});

test('completeDays is null until the season has one complete day', () => {
  const now = new Date('2026-05-10T12:00:00Z');
  assert.equal(season.completeDays('05-10', now, 'UTC'), null);
  assert.deepEqual(season.completeDays('05-01', now, 'UTC'), { start: '2026-05-01', end: '2026-05-09' });
});

// ── rules, over hourly rows ──────────────────────────────────────────────────

/** hourlySeries rows for one device: every hour of every day from `from` to `to`. */
function hourlyRows(devEui, path, from, to, valueAt) {
  const rows = [];
  for (let d = from; d <= to; d = season.addDays(d, 1)) {
    for (let h = 0; h < 24; h++) {
      const v = valueAt(d, h);
      if (v === null) continue;
      const lo = Array.isArray(v) ? v[0] : v;
      const hi = Array.isArray(v) ? v[1] : v;
      rows.push({
        dev_eui: devEui, device_name: devEui, matched_path: path,
        hour: `${d}T${String(h).padStart(2, '0')}`,
        mean: String((lo + hi) / 2), vmin: String(lo), vmax: String(hi), samples: '4',
      });
    }
  }
  return rows;
}

/** A context whose query answers by which candidate paths it was asked for. */
function ctx(rule, params, now, byPath, extra = {}) {
  return {
    query: async (_sql, values) => {
      const asked = JSON.stringify(values?.[0] ?? '');
      for (const [needle, rows] of Object.entries(byPath)) if (asked.includes(needle)) return rows;
      return [];
    },
    params: { ...rule.defaultParams, ...params },
    openDevEuis: new Set(),
    openSubjects: new Set(),
    kind: 'test',
    now,
    timezone: 'UTC',
    log: { debug() {}, info() {}, warn() {}, error() {} },
    ...extra,
  };
}

const NOW = new Date('2026-05-11T06:00:00Z');

test('degree-day-milestone raises the milestone reached, and holds it for holdHours', async () => {
  const rule = loadRules().get('degree-day-milestone');
  // 10–30 °C every day: 10 °C-days a day by the average method.
  const rows = hourlyRows('aa', 'air.temperature', '2026-05-01', '2026-05-10', () => [10, 30]);
  const params = {
    method: 'average', lower: 10, since: '2026-05-01',
    milestones: [{ at: 45, label: 'first flight' }, { at: 100, label: 'second flight' }, { at: 500, label: 'third' }],
  };
  const [f] = await rule.run(ctx(rule, params, NOW, { temperature: rows }));
  // 10 days counted → 100 °C-days, crossed on the 10th (yesterday): still news.
  assert.equal(f.detail.milestone, 'second flight');
  assert.equal(f.detail.reachedOn, '2026-05-10');
  assert.equal(f.detail.total, 100);
  assert.equal(f.detail.nextMilestone, 'third');

  // With only the first milestone, crossed on May 5, the hold has long expired.
  const none = await rule.run(ctx(rule, { ...params, milestones: [{ at: 45, label: 'first flight' }] }, NOW, { temperature: rows }));
  assert.deepEqual(none, []);
});

test('degree-day-milestone converts to °F for a table written in °F-days', async () => {
  const rule = loadRules().get('degree-day-milestone');
  const rows = hourlyRows('aa', 'air.temperature', '2026-05-01', '2026-05-10', () => [10, 30]);
  // 50–86 °F each day, average against 50 °F: 18 °F-days a day, 180 by May 10.
  const [f] = await rule.run(ctx(rule, {
    method: 'average', lower: 50, units: 'F', since: '2026-05-01',
    milestones: [{ at: 175, label: 'x' }],
  }, NOW, { temperature: rows }));
  close(f.detail.total, 180, 0.1);
});

test('degree-day-milestone refuses a season with too many unobserved days', async () => {
  const rule = loadRules().get('degree-day-milestone');
  // Days 3–7 missing entirely: five days, beyond maxMissingDays 3.
  const rows = hourlyRows('aa', 'air.temperature', '2026-05-01', '2026-05-10',
    (d) => (d >= '2026-05-03' && d <= '2026-05-07' ? null : [10, 30]));
  const out = await rule.run(ctx(rule, {
    method: 'average', lower: 10, since: '2026-05-01', milestones: [{ at: 40, label: 'x' }],
  }, NOW, { temperature: rows }));
  assert.deepEqual(out, []);
});

test('degree-day-milestone validates its table and thresholds', async () => {
  const rule = loadRules().get('degree-day-milestone');
  const run = (p) => rule.run(ctx(rule, { milestones: [{ at: 10, label: 'x' }], ...p }, NOW, {}));
  await assert.rejects(() => run({ milestones: [] }), /milestones/);
  await assert.rejects(() => run({ milestones: [{ at: 20, label: 'a' }, { at: 10, label: 'b' }] }), /ascending/);
  await assert.rejects(() => run({ method: 'average', upper: 30 }), /no upper threshold/);
  await assert.rejects(() => run({ lower: 30, upper: 20 }), /must be above lower/);
  await assert.rejects(() => run({ since: 'spring' }), /since/);
});

test('chill-accumulation: reached, and short on or after byDate only', async () => {
  const rule = loadRules().get('chill-accumulation');
  const now = new Date('2026-12-15T12:00:00Z');
  const rows = hourlyRows('aa', 'air.temperature', '2026-11-01', '2026-12-15', () => 6);
  const series = { temperature: rows };

  const [met] = await rule.run(ctx(rule, { requirement: 23, comparison: 'reached' }, now, series));
  assert.ok(met.detail.total > 23, `total ${met.detail.total}`);
  assert.equal(met.detail.unit, 'chill portions');

  // Short of 60 portions — but before byDate that is not news.
  assert.deepEqual(await rule.run(ctx(rule, { requirement: 60, byDate: '01-15' }, now, series)), []);
  const [short] = await rule.run(ctx(rule, { requirement: 60, byDate: '12-01' }, now, series));
  assert.ok(short.detail.remaining > 0);
});

test('chill-accumulation: an "hours" count can be named for what it measures', async () => {
  const rule = loadRules().get('chill-accumulation');
  const now = new Date('2026-12-15T12:00:00Z');
  const rows = hourlyRows('aa', 'air.temperature', '2026-11-01', '2026-12-15', () => 6);
  const p = { model: 'hours', requirement: 5000, byDate: '12-01', unitLabel: 'vernalization hours' };
  const [short] = await rule.run(ctx(rule, p, now, { temperature: rows }));
  assert.equal(short.detail.unit, 'vernalization hours');
  assert.match(short.summary, /vernalization hours since/);
  await assert.rejects(() => rule.run(ctx(rule, { ...p, unitLabel: '' }, now, { temperature: rows })), /unitLabel/);
});

test('chill-accumulation refuses a sparsely observed season', async () => {
  const rule = loadRules().get('chill-accumulation');
  const now = new Date('2026-12-15T12:00:00Z');
  // Only every third hour reported.
  const rows = hourlyRows('aa', 'air.temperature', '2026-11-01', '2026-12-15', (_d, h) => (h % 3 === 0 ? 6 : null));
  assert.deepEqual(await rule.run(ctx(rule, { requirement: 5, comparison: 'reached' }, now, { temperature: rows })), []);
});

test('chill-accumulation needs a requirement, and byDate for a shortfall', async () => {
  const rule = loadRules().get('chill-accumulation');
  await assert.rejects(() => rule.run(ctx(rule, {}, NOW, {})), /requirement must be set/);
  await assert.rejects(() => rule.run(ctx(rule, { requirement: 20 }, NOW, {})), /byDate/);
});

const SMITH = [
  { paths: ['air.temperature'], statistic: 'min', min: 10 },
  { paths: ['air.relativeHumidity'], statistic: 'hoursInBand', bandMin: 90, min: 11 },
];

test('daily-streak finds a Smith Period across two measurements', async () => {
  const rule = loadRules().get('daily-streak');
  const temp = hourlyRows('aa', 'air.temperature', '2026-04-27', '2026-05-10', () => [12, 20]);
  // Humid (12 h at 95 %) on May 9 and 10 only.
  const rh = hourlyRows('aa', 'air.relativeHumidity', '2026-04-27', '2026-05-10',
    (d, h) => (d >= '2026-05-09' && h < 12 ? 95 : 60));
  const [f] = await rule.run(ctx(rule, { conditions: SMITH, days: 2, label: 'Smith Period' }, NOW,
    { relativeHumidity: rh, temperature: temp }));
  assert.equal(f.detail.streakDays, 2);
  assert.equal(f.detail.from, '2026-05-09');
  assert.match(f.summary, /Smith Period/);

  // One humid day is not a period.
  const rh1 = hourlyRows('aa', 'air.relativeHumidity', '2026-04-27', '2026-05-10',
    (d, h) => (d === '2026-05-10' && h < 12 ? 95 : 60));
  assert.deepEqual(await rule.run(ctx(rule, { conditions: SMITH, days: 2 }, NOW,
    { relativeHumidity: rh1, temperature: temp })), []);
});

test('daily-streak: an unobserved day breaks the streak', async () => {
  const rule = loadRules().get('daily-streak');
  const cond = [{ paths: ['air.temperature'], statistic: 'max', min: 35 }];
  const rows = hourlyRows('aa', 'air.temperature', '2026-05-01', '2026-05-10',
    (d) => (d === '2026-05-09' ? null : [20, 38]));
  assert.deepEqual(await rule.run(ctx(rule, { conditions: cond, days: 3 }, NOW, { temperature: rows })), []);
  const full = hourlyRows('aa', 'air.temperature', '2026-05-01', '2026-05-10', () => [20, 38]);
  const [f] = await rule.run(ctx(rule, { conditions: cond, days: 3 }, NOW, { temperature: full }));
  assert.ok(f.detail.streakDays >= 3);
});

test('daily-streak validates its conditions', async () => {
  const rule = loadRules().get('daily-streak');
  const run = (p) => rule.run(ctx(rule, p, NOW, {}));
  await assert.rejects(() => run({}), /conditions/);
  await assert.rejects(() => run({ conditions: [{ paths: ['t'], statistic: 'median', min: 1 }] }), /statistic/);
  await assert.rejects(() => run({ conditions: [{ paths: ['t'], statistic: 'min' }] }), /"min" or "max"/);
  await assert.rejects(() => run({ conditions: [{ paths: ['t'], statistic: 'hoursInBand', min: 3 }] }), /bandMin/);
  await assert.rejects(() => run({ conditions: [{ paths: ['t'], statistic: 'min', min: 1, bandMin: 3 }] }), /only apply/);
  await assert.rejects(() => run({ conditions: SMITH, days: 5, lookbackDays: 3 }), /lookbackDays/);
});

test('disease-index gubler-thomas raises at high pressure with the UC intervals', async () => {
  const rule = loadRules().get('disease-index');
  // 8 h at 25 °C every day from May 6: start on the 8th at 60, 80 on the 9th, 100 on the 10th.
  const rows = hourlyRows('aa', 'air.temperature', '2026-05-01', '2026-05-10',
    (d, h) => (d >= '2026-05-06' && h >= 10 && h < 18 ? 25 : 15));
  const [f] = await rule.run(ctx(rule, { since: '2026-05-01' }, NOW, { temperature: rows }));
  assert.equal(f.detail.index, 100);
  assert.equal(f.detail.startedOn, '2026-05-08');
  assert.equal(f.detail.pressure, 'high');
  // Below the threshold nothing is raised.
  const low = hourlyRows('aa', 'air.temperature', '2026-05-01', '2026-05-10', () => 15);
  assert.deepEqual(await rule.run(ctx(rule, { since: '2026-05-01' }, NOW, { temperature: low })), []);
});

test('disease-index tomcast raises when accumulated DSV reaches the threshold', async () => {
  const rule = loadRules().get('disease-index');
  // 10 wet hours at 19 °C each day: 2 DSV a day. From May 2, 15 DSV is crossed on
  // the 9th (16 DSV) — within the default 48 h hold at 06:00 on the 11th.
  const temp = hourlyRows('aa', 'air.temperature', '2026-05-02', '2026-05-10', () => 19);
  const wet = hourlyRows('aa', 'leaf.wetness', '2026-05-02', '2026-05-10', (_d, h) => (h < 10 ? 80 : 5));
  const params = { model: 'tomcast', since: '2026-05-02', threshold: 15, wetMin: 50 };
  const [f] = await rule.run(ctx(rule, params, NOW, { wetness: wet, temperature: temp }));
  assert.equal(f.detail.totalDsv, 18);
  assert.equal(f.detail.crossedOn, '2026-05-09');
  assert.equal(f.detail.sprayPoints, 1);
  // 16 on the 9th resets to zero (the surplus 1 does not carry); the 10th earns 2.
  assert.equal(f.detail.dsvSinceCrossing, 2);
  await assert.rejects(() => rule.run(ctx(rule, { model: 'tomcast' }, NOW, {})), /wetMin/);
});

test('disease-index tomcast restarts the count from zero at each spray point', async () => {
  const rule = loadRules().get('disease-index');
  // At 23 °C (the 21–25 °C row): 13 wet hours earn 3 DSV, 21 earn 4. Threshold 12 with
  // daily 4, 4, 3, 4 crosses on day 4 with 15 — and the 3 surplus does not carry, so the
  // next spray point needs a full 12 more: 4, 4, 3 is not enough, a further 4 is.
  const wetHoursOn = {
    '2026-04-26': 21, '2026-04-27': 21, '2026-04-28': 13, '2026-04-29': 21,
    '2026-04-30': 21, '2026-05-01': 21, '2026-05-02': 13, '2026-05-03': 0,
  };
  const days = (to) => {
    const temp = hourlyRows('aa', 'air.temperature', '2026-04-26', to, () => 23);
    const wet = hourlyRows('aa', 'leaf.wetness', '2026-04-26', to, (d, h) => (h < wetHoursOn[d] ? 80 : 5));
    return { wetness: wet, temperature: temp };
  };
  const params = { model: 'tomcast', since: '2026-04-26', threshold: 12, wetMin: 50, holdHours: 24 * 30 };
  const at = (date) => new Date(`${date}T06:00:00Z`);

  const [first] = await rule.run(ctx(rule, params, at('2026-05-04'), days('2026-05-03')));
  assert.equal(first.detail.crossedOn, '2026-04-29');
  assert.equal(first.detail.sprayPoints, 1);
  assert.equal(first.detail.totalDsv, 26);
  // Days 5–7 (4, 4, 3) and day 8 (0): 11 since the reset. Carrying the surplus 3, it
  // would be 14, and a second spray point would already have been raised on May 2.
  assert.equal(first.detail.dsvSinceCrossing, 11);
  assert.match(first.summary, /restarts from zero/);

  wetHoursOn['2026-05-03'] = 21;
  const [second] = await rule.run(ctx(rule, params, at('2026-05-04'), days('2026-05-03')));
  assert.equal(second.detail.crossedOn, '2026-05-03');
  assert.equal(second.detail.sprayPoints, 2);
  assert.equal(second.detail.dsvSinceCrossing, 0);
});

test('measurement-accumulation: cap must be above base, and since replaces the window', async () => {
  const rule = loadRules().get('measurement-accumulation');
  await assert.rejects(() => rule.run(ctx(rule, { min: 1, base: 10, cap: 10 }, NOW, {})), /cap/);
  await assert.rejects(() => rule.run(ctx(rule, { min: 1, since: 'soon' }, NOW, {})), /since/);
  // A fixed start in the future has not begun: nothing to judge, and no query at all.
  let queried = false;
  const c = ctx(rule, { min: 1, since: '2026-06-01' }, NOW, {});
  c.query = async () => { queried = true; return []; };
  assert.deepEqual(await rule.run(c), []);
  assert.equal(queried, false);
});

// ── resolveOutOfSeason ───────────────────────────────────────────────────────

test('resolveOutOfSeason parses as a boolean and lints a missing activeMonths', async () => {
  const cfg = parseConfig({ checks: [{ rule: 'device-silent', resolveOutOfSeason: true }] });
  assert.equal(cfg.checks[0].resolveOutOfSeason, true);
  assert.throws(() => parseConfig({ checks: [{ rule: 'device-silent', resolveOutOfSeason: 'yes' }] }), /boolean/);
  const problems = await lintConfig(cfg, loadRules());
  assert.ok(problems.some((p) => /resolveOutOfSeason/.test(p.where)), JSON.stringify(problems));
});

// ── Wallin late-blight severity values ───────────────────────────────────────

test('Wallin severity values match the UC IPM table row by row', () => {
  // [humid hours, mean °C, expected SV]
  const cases = [
    [15, 10, 0], [16, 10, 1], [18, 10, 1], [19, 10, 2], [22, 10, 3], [25, 10, 4],
    [12, 13, 0], [13, 13, 1], [16, 13, 2], [19, 13, 3], [22, 13, 4],
    [9, 20, 0], [10, 20, 1], [13, 20, 2], [16, 20, 3], [19, 20, 4],
    // Row edges: 11.6 is the cool row, 11.7 the middle one, 26.6 still counts.
    [16, 11.6, 1], [13, 11.7, 1], [16, 26.6, 3],
    // Outside 7.2–26.6 °C nothing accrues, however long the humidity.
    [24, 7.1, 0], [24, 26.7, 0],
  ];
  for (const [h, t, sv] of cases) assert.equal(m.wallinSv(h, t), sv, `${h} h at ${t} °C`);
});

test('disease-index wallin raises when severity values reach the spray threshold', async () => {
  const rule = loadRules().get('disease-index');
  // 16 h a day at RH 95 % and 20 °C: SV 3 a day. From emergence on May 4 the 18th SV
  // falls on the 9th; the 10th earns 3 toward the next spray point.
  const temp = hourlyRows('aa', 'air.temperature', '2026-05-04', '2026-05-10', () => 20);
  const rh = hourlyRows('aa', 'air.relativeHumidity', '2026-05-04', '2026-05-10', (_d, h) => (h < 16 ? 95 : 70));
  const params = {
    model: 'wallin', since: '2026-05-04', threshold: 18,
    wetnessPaths: ['air.relativeHumidity'], wetMin: 90,
  };
  const [f] = await rule.run(ctx(rule, params, NOW, { relativeHumidity: rh, temperature: temp }));
  assert.equal(f.detail.model, 'wallin');
  assert.equal(f.detail.totalSv, 21);
  assert.equal(f.detail.crossedOn, '2026-05-09');
  assert.equal(f.detail.svSinceCrossing, 3);
  assert.equal(f.detail.recent.at(-1).sv, 3);
  assert.match(f.summary, /late blight \(Wallin\) spray point reached on 2026-05-09: at least 18 severity values/);
  await assert.rejects(() => rule.run(ctx(rule, { model: 'wallin' }, NOW, {})), /wallin needs wetMin/);
  await assert.rejects(() => rule.run(ctx(rule, { model: 'blitecast' }, NOW, {})), /model must be one of/);
});

// ── daily-streak day boundary ────────────────────────────────────────────────

test('daily-streak dayStartHour keeps a humid night inside one day', async () => {
  const rule = loadRules().get('daily-streak');
  const temp = hourlyRows('aa', 'air.temperature', '2026-04-27', '2026-05-11', () => [12, 20]);
  // Two humid nights, 20:00–08:00: May 8→9 and May 9→10. 12 h each.
  const humid = (d, h) =>
    ((d === '2026-05-08' || d === '2026-05-09') && h >= 20) || ((d === '2026-05-09' || d === '2026-05-10') && h < 8);
  const rh = hourlyRows('aa', 'air.relativeHumidity', '2026-04-27', '2026-05-11', (d, h) => (humid(d, h) ? 95 : 60));
  const series = { relativeHumidity: rh, temperature: temp };

  // Midnight days split each night: 4 h, then 8 + 4 = 12 h, then 8 h — only one day
  // reaches 11 h, so there is no Smith Period.
  assert.deepEqual(await rule.run(ctx(rule, { conditions: SMITH, days: 2 }, NOW, series)), []);

  // 09:00 days hold one night each: 12 h and 12 h. At 06:00 on the 11th the day that
  // began at 09:00 on the 10th is still running, so the last complete day is the 9th.
  const [f] = await rule.run(ctx(rule, { conditions: SMITH, days: 2, dayStartHour: 9 }, NOW, series));
  assert.equal(f.detail.from, '2026-05-08');
  assert.equal(f.detail.to, '2026-05-09');
  assert.equal(f.detail.dayStartHour, 9);

  await assert.rejects(() => rule.run(ctx(rule, { conditions: SMITH, dayStartHour: 24 }, NOW, series)), /dayStartHour/);
});

test('summarizeDays with a day start moves early hours to the previous day', () => {
  const hours = ['2026-05-09T08', '2026-05-09T09', '2026-05-10T08'].map((hour) => ({
    hour, mean: 1, min: 1, max: 1, samples: 1,
  }));
  const days = m.summarizeDays(hours, '2026-05-08', '2026-05-09', 9);
  assert.deepEqual(days.map((d) => [d.date, d.hoursObserved]), [['2026-05-08', 1], ['2026-05-09', 2]]);
});

// ── activeHours on standard time ─────────────────────────────────────────────

const { outOfSeason } = require('../dist/runner.js');

test('standardHour reads the zone\'s standard clock through daylight saving, in both hemispheres', () => {
  // Los Angeles: 18:00Z is 11:00 PDT in July and 10:00 PST in January — 10 standard both times.
  assert.equal(season.standardHour(new Date('2026-07-15T18:00:00Z'), 'America/Los_Angeles'), 10);
  assert.equal(season.standardHour(new Date('2026-01-15T18:00:00Z'), 'America/Los_Angeles'), 10);
  // Either side of the March 8 change.
  assert.equal(season.standardHour(new Date('2026-03-07T18:00:00Z'), 'America/Los_Angeles'), 10);
  assert.equal(season.standardHour(new Date('2026-03-09T18:00:00Z'), 'America/Los_Angeles'), 10);
  // Sydney's daylight saving is in January: 00:00Z is 11:00 AEDT, 10:00 AEST.
  assert.equal(season.standardHour(new Date('2026-01-15T00:00:00Z'), 'Australia/Sydney'), 10);
  // No daylight saving, half-hour offset: 04:30Z is 10:00 IST.
  assert.equal(season.standardHour(new Date('2026-07-15T04:30:00Z'), 'Asia/Kolkata'), 10);
});

test('outOfSeason: activeHoursStandardTime gates on standard time, one entry all year', () => {
  const tz = 'America/Los_Angeles';
  const lettuce = { activeHours: [10], activeHoursStandardTime: true };
  const wall = { activeHours: [10] };
  // 11:00 on the clock in July is 10:00 standard.
  assert.equal(outOfSeason(lettuce, new Date('2026-07-15T18:00:00Z'), tz), null);
  assert.match(outOfSeason(wall, new Date('2026-07-15T18:00:00Z'), tz), /hour 11 is not in activeHours/);
  // In January the two agree.
  assert.equal(outOfSeason(lettuce, new Date('2026-01-15T18:00:00Z'), tz), null);
  assert.equal(outOfSeason(wall, new Date('2026-01-15T18:00:00Z'), tz), null);
  // 10:00 on the clock in July is 09:00 standard.
  assert.match(outOfSeason(lettuce, new Date('2026-07-15T17:00:00Z'), tz), /standard-time hour 9 is not in activeHours/);
});

test('activeHoursStandardTime is validated and linted', async () => {
  assert.throws(
    () => parseConfig({ checks: [{ rule: 'device-silent', activeHours: [10], activeHoursStandardTime: 'yes' }] }),
    /activeHoursStandardTime must be a boolean/,
  );
  const cfg = parseConfig({ checks: [{ rule: 'device-silent', activeHoursStandardTime: true }] });
  assert.equal(cfg.checks[0].activeHoursStandardTime, true);
  const problems = await lintConfig(cfg, loadRules());
  assert.ok(problems.some((p) => /activeHoursStandardTime/.test(p.where)), JSON.stringify(problems));
});

// ── mold-risk infection curves ───────────────────────────────────────────────

const BROWN_ROT = [
  { min: 5, max: 8, dwellHours: 10.5 }, { min: 8, max: 12, dwellHours: 6 }, { min: 12, max: 16, dwellHours: 3.5 },
  { min: 16, max: 22, dwellHours: 3 }, { min: 22, max: 25, dwellHours: 5 },
];
/** Hourly readings from 00:00 on May 10: [rh, temperature] per hour, null to skip an hour. */
const readingsOf = (list) => list.flatMap((x, h) => (x === null ? [] : [{
  time: new Date(Date.UTC(2026, 4, 10, h)), value: x[0], temperature: x[1],
}]));
const WET = { min: 90, max: null };

test('curveRequirement: the band a temperature is in, the longer one on an edge, null off the curve', () => {
  assert.equal(m.curveRequirement(BROWN_ROT, 18), 3);
  assert.equal(m.curveRequirement(BROWN_ROT, 12), 6, 'on the 8–12 / 12–16 edge, the longer requirement');
  assert.equal(m.curveRequirement(BROWN_ROT, 4), null);
  assert.equal(m.curveRequirement(BROWN_ROT, 26), null);
});

test('bestInfectionRun: at a steady temperature it is exactly the band\'s hours', () => {
  const r = m.bestInfectionRun(readingsOf([[95, 18], [95, 18], [95, 18], [95, 18]]), WET, BROWN_ROT, 2);
  assert.equal(r.wetHours, 3);
  assert.equal(r.progress, 1);
});

test('bestInfectionRun: a night drifting across a band edge stays one run', () => {
  // Two hours at 14 °C (2/3.5), the hour into 11 °C still at 14's rate (1/3.5), then an
  // hour at 11 °C (1/6): 1.024 — infection. One entry per band sees 2 h at 12–16 and 1 h
  // at 8–12, and neither reaches its dwell.
  const r = m.bestInfectionRun(readingsOf([[95, 14], [95, 14], [95, 14], [95, 11], [95, 11]]), WET, BROWN_ROT, 2);
  assert.ok(Math.abs(r.progress - (3 / 3.5 + 1 / 6)) < 1e-9, `progress ${r.progress}`);
  assert.equal(r.minTemperature, 11);
  assert.equal(r.maxTemperature, 14);
});

test('bestInfectionRun: a dry spell ends the run, unless maxDryHours bridges it', () => {
  const olive = [{ min: 10, max: 20, dwellHours: 12 }];
  // 8 h wet, dry at hours 9–10, 8 h wet again: 16 wet hours with a 3 h dry break.
  const list = [...Array(9).fill([95, 15]), [60, 15], [60, 15], ...Array(9).fill([95, 15])];
  const strict = m.bestInfectionRun(readingsOf(list), WET, olive, 2, 0);
  assert.equal(strict.wetHours, 8);
  assert.ok(strict.progress < 1);
  const bridged = m.bestInfectionRun(readingsOf(list), WET, olive, 2, 4);
  assert.equal(bridged.wetHours, 16);
  assert.equal(bridged.bridgedDryHours, 3);
  assert.ok(bridged.progress >= 1);
  // A longer break than allowed still ends it.
  assert.equal(m.bestInfectionRun(readingsOf(list), WET, olive, 2, 2).wetHours, 8);
});

test('bestInfectionRun: a reporting gap ends the run, and off-curve readings are dry', () => {
  const gap = m.bestInfectionRun(readingsOf([[95, 18], [95, 18], null, null, null, [95, 18], [95, 18]]), WET, BROWN_ROT, 2);
  assert.equal(gap.wetHours, 1);
  const cold = m.bestInfectionRun(readingsOf([[95, 3], [95, 3], [95, 3]]), WET, BROWN_ROT, 2);
  assert.equal(cold, null);
});

test('mold-risk with a curve raises on a drifting night that per-band entries miss', async () => {
  const rule = loadRules().get('mold-risk');
  const now = new Date('2026-05-10T05:00:00Z');
  const temps = [14, 14, 14, 11, 11];
  const rows = temps.map((t, h) => ({
    dev_eui: 'aa', device_name: 'almond-1', matched_path: 'air.relativeHumidity',
    time: new Date(Date.UTC(2026, 4, 10, h)).toISOString(), value: '95', gate_value: String(t),
  }));
  const curve = BROWN_ROT.map((b) => ({ temperatureMin: b.min, temperatureMax: b.max, dwellHours: b.dwellHours }));
  const params = { curve, lookbackHours: 24, minSamples: 4 };
  const [f] = await rule.run(ctx(rule, params, now, { relativeHumidity: rows }));
  assert.ok(f.detail.progress >= 1, JSON.stringify(f.detail));
  assert.deepEqual(f.detail.temperatureRange, [11, 14]);
  assert.match(f.summary, /102% of the infection requirement/);
  // Open alert, hysteresis: 80 % of the requirement still holds it; a fresh alert needs 100 %.
  const shortRows = rows.slice(0, 4);
  assert.deepEqual(await rule.run(ctx(rule, params, now, { relativeHumidity: shortRows })), []);
  const held = await rule.run(ctx(rule, params, now, { relativeHumidity: shortRows }, { openDevEuis: new Set(['aa']) }));
  assert.equal(held.length, 1);
});

test('mold-risk validates its curve', async () => {
  const rule = loadRules().get('mold-risk');
  const run = (p) => rule.run(ctx(rule, p, NOW, {}));
  await assert.rejects(() => run({ curve: [] }), /non-empty list/);
  await assert.rejects(() => run({ curve: [{ temperatureMin: 10, temperatureMax: 5, dwellHours: 3 }] }), /below temperatureMax/);
  await assert.rejects(() => run({ curve: [
    { temperatureMin: 5, temperatureMax: 12, dwellHours: 6 }, { temperatureMin: 10, temperatureMax: 16, dwellHours: 3 },
  ] }), /without overlap/);
  await assert.rejects(() => run({ curve: [{ temperatureMin: 5, temperatureMax: 12, dwellHours: 30 }] }), /lookbackHours/);
  await assert.rejects(() => run({ curve: [{ temperatureMin: 5, temperatureMax: 12, dwellHours: 6 }], temperaturePaths: null }), /temperature gate/);
  await assert.rejects(() => run({ maxDryHours: 20 }), /plus maxDryHours/);
});
