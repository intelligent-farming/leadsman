/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * chill-accumulation — has dormancy had enough cold, by the model the requirement is in.
 *
 * Deciduous fruit and nut trees need a quantity of winter cold before they bloom
 * normally, and a warm winter that falls short shows up months later as poor, uneven
 * bloom when nothing can be done about it. The requirement is published per variety,
 * and in one of three units that are not interchangeable:
 *
 *   hours    hours between 0 and 7.2 °C (or below 7.2 °C — set `hoursMin` to null).
 *            The oldest model and still the unit many nursery catalogues use.
 *   utah     Utah chill units (Richardson et al. 1974): hours are weighted by
 *            temperature, and warm hours count AGAINST chill already banked.
 *   dynamic  chill portions (Fishman et al. 1987). What UC now publishes requirements
 *            in, because it is the only one of the three that holds up in California's
 *            mild, fluctuating winters: warmth can undo chill that has not yet been
 *            fixed, but not chill that has.
 *
 * `measurement-dwell` can count chill hours over a rolling window, and that is all it
 * can do: it has no memory of a season and no model of warmth undoing cold. This check
 * counts from the start of dormancy (`since`, default November 1) through now.
 *
 * Two questions, by `comparison`:
 *
 *   short    on and after `byDate`, is the season still below `requirement`? The
 *            question to ask with time left to act — dormancy-breaking sprays, bloom
 *            expectations, pollinator contracts.
 *   reached  has the requirement been met? Raised once met, and open for the rest of
 *            the season (pair with activeMonths and resolveOutOfSeason).
 *
 * The count is not projected over gaps: the Dynamic model is not linear in time, so
 * scaling it by coverage would invent chill. Below `minCoverage` it is not judged.
 */

import { hourlySeries, pathsLabel, resolvePaths } from '../measurement';
import { accumulateChill, type ChillModel } from '../models';
import { num, optNum, optStr, ParamError, round, str } from '../params';
import { resolveScope, SCOPE_PARAMS } from '../scope';
import { dateInSeason, localDate, parseSince, seasonStart, zonedMidnight } from '../season';
import type { Finding, Rule } from '../types';

const UNIT: Record<ChillModel, string> = {
  hours: 'chill hours',
  utah: 'Utah chill units',
  dynamic: 'chill portions',
};

const rule: Rule = {
  id: 'chill-accumulation',
  description:
    'Winter chill since the start of dormancy by chill hours, Utah units or the Dynamic ' +
    "model's chill portions, against a variety's requirement. Raises when the season is " +
    'still short on a judgement date, or when the requirement is met.',
  defaultSeverity: 'info',
  defaultRouting: 'fact',
  defaultParams: {
    /** Priority-ordered candidate paths, in °C. */
    paths: ['air.temperature', 'temperature'],
    /** "dynamic" (chill portions), "utah" or "hours". */
    model: 'dynamic',
    /** Start of dormancy: `MM-DD` every year, or `YYYY-MM-DD`. */
    since: '11-01',
    /** The variety's requirement, in the model's unit. Required. */
    requirement: null,
    /** "short" (still below the requirement on or after byDate) or "reached". */
    comparison: 'short',
    /** `MM-DD` from which a shortfall is reported. Required for "short". */
    byDate: null,
    /** "hours" model: hours counted when hoursMin < T <= hoursMax. null hoursMin: T <= hoursMax. */
    hoursMin: 0,
    hoursMax: 7.2,
    /** Refuse to judge when less than this fraction of the season's hours was observed. */
    minCoverage: 0.8,
    /**
     * What the total is called in the alert, when "chill hours" is the wrong word — an "hours"
     * count used for winter-wheat vernalization, say. null uses the model's own unit name.
     */
    unitLabel: null,
    ...SCOPE_PARAMS,
  },
  requires: [
    { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
  ],

  async run(ctx): Promise<Finding[]> {
    const paths = resolvePaths(ctx.params, 'paths');
    const model = str(ctx.params, 'model') as ChillModel;
    const since = parseSince(ctx.params.since);
    const requirement = optNum(ctx.params, 'requirement');
    const comparison = str(ctx.params, 'comparison');
    const hoursMin = optNum(ctx.params, 'hoursMin');
    const hoursMax = num(ctx.params, 'hoursMax');
    const minCoverage = num(ctx.params, 'minCoverage');

    if (!['dynamic', 'utah', 'hours'].includes(model)) {
      throw new Error(`model must be "dynamic", "utah" or "hours" (got "${model}")`);
    }
    if (requirement === null || !(requirement > 0)) {
      throw new Error(
        'requirement must be set to the variety\'s chill requirement in the model\'s unit ' +
          '(e.g. 23 chill portions for Nonpareil almond)',
      );
    }
    if (comparison !== 'short' && comparison !== 'reached') {
      throw new Error(`comparison must be "short" or "reached" (got "${comparison}")`);
    }
    let byDate: string | null = null;
    if (comparison === 'short') {
      const raw = ctx.params.byDate;
      if (typeof raw !== 'string' || !/^\d{2}-\d{2}$/.test(raw)) {
        throw new ParamError(
          'comparison "short" needs byDate as "MM-DD" — the date from which a shortfall ' +
            'is worth reporting; before it every season is short',
        );
      }
      byDate = parseSince(raw, 'byDate');
    }
    if (hoursMin !== null && hoursMin >= hoursMax) {
      throw new Error(`hoursMin (${hoursMin}) must be below hoursMax (${hoursMax})`);
    }
    if (!(minCoverage > 0) || minCoverage > 1) throw new Error('minCoverage must be above 0 and at most 1');

    const tz = ctx.timezone ?? 'UTC';
    const start = seasonStart(since, ctx.now, tz);
    const today = localDate(ctx.now, tz);
    if (start > today) return [];
    // A fixed-year byDate is meaningless across seasons; resolve it within this one.
    const judgeFrom = byDate === null ? null : dateInSeason(start, byDate);
    if (judgeFrom !== null && today < judgeFrom) {
      ctx.log.debug('before byDate — a shortfall is not yet news', { byDate: judgeFrom });
      return [];
    }

    const scope = resolveScope(ctx.params);
    const series = await hourlySeries(ctx, paths, start, tz, scope);
    if (series.length === 0) {
      ctx.log.debug('no device reports any candidate path', { paths: pathsLabel(paths) });
      return [];
    }

    const seasonHours = (ctx.now.getTime() - zonedMidnight(start, tz).getTime()) / 3_600_000;
    const unit = optStr(ctx.params, 'unitLabel') ?? UNIT[model];
    const findings: Finding[] = [];
    const uncovered: string[] = [];

    for (const s of series) {
      const coverage = Math.min(1, s.hours.length / Math.max(1, seasonHours));
      if (coverage + 1e-9 < minCoverage) {
        uncovered.push(`${s.devEui} ${Math.round(coverage * 100)}%`);
        continue;
      }
      const total = accumulateChill(s.hours.map((h) => h.mean), model, hoursMin, hoursMax);
      const met = total >= requirement;
      if (comparison === 'short' ? met : !met) continue;

      const name = s.deviceName ?? s.devEui;
      findings.push({
        devEui: s.devEui,
        deviceName: s.deviceName,
        summary:
          comparison === 'short'
            ? `${name} has ${round(total, 1)} ${unit} since ${start} — short of the ` +
              `${requirement} required (${round(requirement - total, 1)} to go)`
            : `${name} has met its requirement: ${round(total, 1)} ${unit} since ` +
              `${start} (requirement ${requirement})`,
        detail: {
          measurement: s.matchedPath,
          model,
          unit,
          total: round(total, 2),
          requirement,
          remaining: met ? 0 : round(requirement - total, 2),
          since: start,
          byDate: judgeFrom,
          coverage: round(coverage, 3),
          hoursObserved: s.hours.length,
        },
      });
    }

    if (findings.length === 0 && uncovered.length > 0 && uncovered.length === series.length) {
      ctx.log.warn(
        'no device had enough of the season observed to judge chill — this check is ' +
          'currently measuring nothing. Lower minCoverage if the gaps are known',
        { devices: uncovered.slice(0, 5), minCoverage },
      );
    }
    return findings;
  },
};

export default rule;
