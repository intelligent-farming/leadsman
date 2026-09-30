/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * daily-streak — the weather met a daily condition on N days in a row.
 *
 * A family of published rules is phrased this way, and no other check can express it
 * because each needs a day boundary and a memory of the days before:
 *
 *   Smith Period (late blight)   2 consecutive days, each with a minimum ≥ 10 °C and
 *                                ≥ 11 h at RH ≥ 90 %. Hutton criteria: the same with 6 h.
 *   Gubler-Thomas onset          3 consecutive days with ≥ 6 continuous hours at
 *                                21–29.4 °C, which starts the grape powdery mildew index.
 *   Heat waves, hot nights       3 days above a maximum, 3 nights that never cooled.
 *
 * A day qualifies when EVERY entry in `conditions` holds for it. Each condition names
 * its own paths and a daily statistic of them:
 *
 *   min, max, mean       the day's extreme or mean, compared with `min`/`max`
 *   hoursInBand          hours whose mean lies in `bandMin`–`bandMax`
 *   longestRunInBand     the longest run of CONSECUTIVE such hours
 *
 * so the Smith Period is two conditions — `air.temperature` min ≥ 10, and
 * `air.relativeHumidity` hoursInBand(90–100) ≥ 11 — on the same device.
 *
 * Only complete days are judged, so a streak is reported shortly after the day ends.
 * A day is a local calendar day unless `dayStartHour` moves its start: the Smith and
 * Hutton criteria come from UK practice, where the climatological day runs 09:00 to
 * 09:00, so one humid night stays inside one day. With a midnight boundary each night is
 * split across two days, and a two-night spell can fail an 11-hour test that a 09:00
 * day passes. Days are named by the date they start on. A day with less than `minDayCoverage` of its hours observed is unknown, and
 * an unknown day breaks a streak: a run of qualifying days is a claim about every one of
 * them. The alert is raised while the streak's last day is within `withinDays` of
 * yesterday, and resolves after that.
 */

import { hourlySeries, pathsLabel, resolvePaths, type HourlySeries } from '../measurement';
import { hoursInBand, longestRunInBand, summarizeDays, type DaySummary } from '../models';
import { int, num, ParamError, round } from '../params';
import { resolveScope, SCOPE_PARAMS } from '../scope';
import { addDays, completeDays, localDate, localParts } from '../season';
import type { Finding, Rule } from '../types';

type Statistic = 'min' | 'max' | 'mean' | 'hoursInBand' | 'longestRunInBand';
const STATISTICS: Statistic[] = ['min', 'max', 'mean', 'hoursInBand', 'longestRunInBand'];

interface Condition {
  paths: string[][];
  statistic: Statistic;
  min: number | null;
  max: number | null;
  bandMin: number | null;
  bandMax: number | null;
}

function optional(v: unknown, at: string): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ParamError(`${at} must be a number or null`);
  return v;
}

function parseConditions(raw: unknown): Condition[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ParamError(
      'param "conditions" must list at least one {"paths", "statistic", "min"/"max"} — ' +
        'with none, every day qualifies',
    );
  }
  return raw.map((c, i) => {
    const at = `conditions[${i}]`;
    if (typeof c !== 'object' || c === null) throw new ParamError(`${at} must be an object`);
    const o = c as Record<string, unknown>;
    const statistic = o.statistic as Statistic;
    if (!STATISTICS.includes(statistic)) {
      throw new ParamError(`${at}.statistic must be one of ${STATISTICS.join(', ')}`);
    }
    const cond: Condition = {
      paths: resolvePaths(o, 'paths'),
      statistic,
      min: optional(o.min, `${at}.min`),
      max: optional(o.max, `${at}.max`),
      bandMin: optional(o.bandMin, `${at}.bandMin`),
      bandMax: optional(o.bandMax, `${at}.bandMax`),
    };
    if (cond.min === null && cond.max === null) {
      throw new ParamError(`${at} needs "min" or "max" — with neither, every day qualifies`);
    }
    if (cond.min !== null && cond.max !== null && cond.min > cond.max) {
      throw new ParamError(`${at}.min must not exceed ${at}.max`);
    }
    const banded = statistic === 'hoursInBand' || statistic === 'longestRunInBand';
    if (banded && cond.bandMin === null && cond.bandMax === null) {
      throw new ParamError(`${at}: statistic "${statistic}" needs "bandMin" or "bandMax"`);
    }
    if (!banded && (cond.bandMin !== null || cond.bandMax !== null)) {
      throw new ParamError(`${at}: bandMin/bandMax only apply to hoursInBand and longestRunInBand`);
    }
    if (cond.bandMin !== null && cond.bandMax !== null && cond.bandMin > cond.bandMax) {
      throw new ParamError(`${at}.bandMin must not exceed ${at}.bandMax`);
    }
    return cond;
  });
}

function dayValue(day: DaySummary, c: Condition): number | null {
  switch (c.statistic) {
    case 'min': return day.min;
    case 'max': return day.max;
    case 'mean': return day.mean;
    case 'hoursInBand': return hoursInBand(day.hours, c.bandMin, c.bandMax);
    case 'longestRunInBand': return longestRunInBand(day.hours, c.bandMin, c.bandMax);
  }
}

const rule: Rule = {
  id: 'daily-streak',
  description:
    'Flags devices where a daily condition — a daily minimum, maximum or mean, or hours ' +
    'in a band, on one or more measurements — held on N consecutive local days. Smith ' +
    'and Hutton late-blight periods, Gubler-Thomas onset, heat waves, hot nights.',
  defaultSeverity: 'warning',
  /**
   * Generic, like measurement-dwell: a heat wave is a fact. A disease-period instance
   * that needs interpreting can set notifyTo per instance.
   */
  defaultRouting: 'fact',
  defaultParams: {
    /** Every condition must hold for a day to qualify. Required. */
    conditions: [],
    /** Consecutive qualifying days needed. */
    days: 2,
    /** Raise while the streak's last day is within this many days of yesterday. */
    withinDays: 1,
    /** How far back to look for the streak. */
    lookbackDays: 14,
    /** A day is judged only if at least this fraction of its hours was observed, per condition. */
    minDayCoverage: 0.75,
    /**
     * Local hour a day starts at, 0–23. 0 is the calendar day; 9 is the UK
     * climatological day the Smith and Hutton criteria were built on.
     */
    dayStartHour: 0,
    /** Name of the rule in the summary, e.g. "Smith Period". */
    label: 'qualifying-day streak',
    ...SCOPE_PARAMS,
  },
  requires: [
    { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
  ],

  async run(ctx): Promise<Finding[]> {
    const conditions = parseConditions(ctx.params.conditions);
    const days = int(ctx.params, 'days');
    const withinDays = int(ctx.params, 'withinDays');
    const lookbackDays = int(ctx.params, 'lookbackDays');
    const minDayCoverage = num(ctx.params, 'minDayCoverage');
    const dayStartHour = int(ctx.params, 'dayStartHour');
    const label = typeof ctx.params.label === 'string' ? ctx.params.label : 'qualifying-day streak';

    if (days < 1) throw new Error('days must be at least 1');
    if (withinDays < 1) throw new Error('withinDays must be at least 1');
    if (lookbackDays < days + withinDays - 1) {
      throw new Error(
        `lookbackDays (${lookbackDays}) must be at least days + withinDays - 1 ` +
          `(${days + withinDays - 1}) — otherwise no streak fits in the window`,
      );
    }
    if (!(minDayCoverage > 0) || minDayCoverage > 1) {
      throw new Error('minDayCoverage must be above 0 and at most 1');
    }
    if (dayStartHour < 0 || dayStartHour > 23) {
      throw new Error('dayStartHour must be a local hour, 0–23');
    }

    const tz = ctx.timezone ?? 'UTC';
    const today = localDate(ctx.now, tz);
    const complete = completeDays(addDays(today, -lookbackDays), ctx.now, tz);
    if (!complete) return [];
    // A day that starts at dayStartHour is complete once the next one has begun: before
    // that hour today, yesterday's day is still running.
    const end = localParts(ctx.now, tz).hour < dayStartHour ? addDays(complete.end, -1) : complete.end;
    if (complete.start > end) return [];
    const window = { start: complete.start, end };

    const scope = resolveScope(ctx.params);
    // One series per condition. Conditions on the same paths share a query.
    const byPaths = new Map<string, HourlySeries[]>();
    for (const c of conditions) {
      const key = JSON.stringify(c.paths);
      if (!byPaths.has(key)) byPaths.set(key, await hourlySeries(ctx, c.paths, window.start, tz, scope));
    }

    // Only devices reporting every condition's measurement can be judged.
    const perCondition = conditions.map((c) => {
      const m = new Map<string, HourlySeries>();
      for (const s of byPaths.get(JSON.stringify(c.paths)) ?? []) m.set(s.devEui, s);
      return m;
    });
    const devices = [...perCondition[0].keys()].filter((eui) => perCondition.every((m) => m.has(eui)));
    if (devices.length === 0) {
      ctx.log.debug('no device reports every condition\'s measurement', {
        paths: conditions.map((c) => pathsLabel(c.paths)),
      });
      return [];
    }

    const lastAllowed = addDays(window.end, -(withinDays - 1));
    const findings: Finding[] = [];

    for (const eui of devices) {
      const summaries = perCondition.map((m) =>
        summarizeDays(m.get(eui)!.hours, window.start, window.end, dayStartHour),
      );
      // Walk the days, tracking the run of qualifying days ending at each.
      let run = 0;
      let best: { length: number; end: string; values: (number | null)[] } | null = null;
      for (let i = 0; i < summaries[0].length; i++) {
        const date = summaries[0][i].date;
        const values = conditions.map((c, k) => {
          const day = summaries[k][i];
          return day.hoursObserved / 24 < minDayCoverage ? null : dayValue(day, c);
        });
        const qualifies = values.every((v, k) => {
          const c = conditions[k];
          return v !== null && (c.min === null || v >= c.min) && (c.max === null || v <= c.max);
        });
        run = qualifies ? run + 1 : 0;
        if (run >= days && date >= lastAllowed) best = { length: run, end: date, values };
      }
      if (!best) continue;

      const s = perCondition[0].get(eui)!;
      const name = s.deviceName ?? eui;
      const startDate = addDays(best.end, -(best.length - 1));
      findings.push({
        devEui: eui,
        deviceName: s.deviceName,
        summary:
          `${name}: ${label} — ${best.length} consecutive qualifying day` +
          `${best.length === 1 ? '' : 's'} (${startDate} to ${best.end}; needs ${days})`,
        detail: {
          label,
          streakDays: best.length,
          dayStartHour,
          requiredDays: days,
          from: startDate,
          to: best.end,
          lastDay: conditions.map((c, k) => ({
            measurement: perCondition[k].get(eui)!.matchedPath,
            statistic: c.statistic,
            value: best!.values[k] === null ? null : round(best!.values[k] as number, 2),
            min: c.min,
            max: c.max,
            bandMin: c.bandMin,
            bandMax: c.bandMax,
          })),
        },
      });
    }
    return findings;
  },
};

export default rule;
