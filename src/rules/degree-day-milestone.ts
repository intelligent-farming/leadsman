/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * degree-day-milestone — a season's degree-days have reached a published stage.
 *
 * Most pest and crop timing in agronomy is a degree-day count from a start date,
 * compared with a table: navel orangeworm lays its next generation 1056 °F-days after
 * the egg-trap biofix, codling moth spray 1A falls near 300, corn silks near 1400
 * after planting. The count needs two things `measurement-accumulation` does not do:
 *
 *   - It starts on a DATE, not N hours ago — a biofix observed in the traps, a planting
 *     date, or January 1 every year.
 *   - It is computed from each DAY's minimum and maximum by the method the table was
 *     built with. UC IPM's insect models use the single sine with a horizontal cutoff;
 *     corn GDD uses the modified average; the Winkler index uses the plain average.
 *     A table's numbers only mean something under its own method.
 *
 * ## One alert per milestone
 *
 * An alert is about a subject and a kind, and updating an open alert does not notify
 * again — so a single alert that moved from "1st flight" to "2nd flight" would announce
 * only the first. Instead each crossing raises a fresh alert and holds it open for
 * `holdHours`, then lets it resolve, the pattern host-restarted uses for an event that
 * is news for a while and then is not. Milestones closer together than `holdHours`
 * fold into the alert already open; set it shorter than the tightest gap you care about.
 *
 * ## Missing days are counted, not guessed
 *
 * A day with less than `minDayCoverage` of its hours observed has no trustworthy
 * minimum and maximum, so it contributes nothing — which means the total runs late,
 * never early. Beyond `maxMissingDays` the count is refused outright with a warning:
 * a milestone reported a week late because the station was offline is worse than no
 * report, because it looks like the real thing.
 */

import { resolvePaths, pathsLabel, hourlySeries } from '../measurement';
import { dailyDegreeDays, summarizeDays, type Cutoff, type DegreeDayMethod } from '../models';
import { int, num, optNum, ParamError, round, str } from '../params';
import { resolveScope, SCOPE_PARAMS } from '../scope';
import { addDays, completeDays, localDate, parseSince, zonedMidnight } from '../season';
import type { Finding, Rule } from '../types';

interface Milestone {
  at: number;
  label: string;
}

function parseMilestones(raw: unknown): Milestone[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ParamError('param "milestones" must list at least one {"at": number, "label": string}');
  }
  const out = raw.map((m, i) => {
    if (typeof m !== 'object' || m === null) {
      throw new ParamError(`milestones[${i}] must be an object {"at": number, "label": string}`);
    }
    const { at, label } = m as Record<string, unknown>;
    if (typeof at !== 'number' || !(at > 0)) {
      throw new ParamError(`milestones[${i}].at must be a positive number`);
    }
    if (typeof label !== 'string' || label.length === 0) {
      throw new ParamError(`milestones[${i}].label must be a non-empty string`);
    }
    return { at, label };
  });
  for (let i = 1; i < out.length; i++) {
    if (out[i].at <= out[i - 1].at) {
      throw new ParamError('milestones must be in ascending order of "at", without repeats');
    }
  }
  return out;
}

const rule: Rule = {
  id: 'degree-day-milestone',
  description:
    'Degree-days from daily minimum and maximum since a start date (biofix, planting, ' +
    'Jan 1), by single sine, average or the corn modified method, with an optional upper ' +
    'cutoff. Raises as each configured milestone is reached — pest flights, spray timing, ' +
    'crop stages.',
  defaultSeverity: 'info',
  /** A fact: "the model says the second flight is starting". What to do is the reader's. */
  defaultRouting: 'fact',
  defaultParams: {
    /** Priority-ordered candidate paths. Readings are in °C (vocabulary units). */
    paths: ['air.temperature', 'temperature'],
    /** "sine" (UC IPM insect models), "average" (Winkler, DD60) or "modified" (corn GDD). */
    method: 'sine',
    /** Lower developmental threshold, in `units`. */
    lower: 10,
    /** Upper threshold, in `units`. null: none. Not allowed with "average". */
    upper: null,
    /** What happens above `upper` in the single sine: "horizontal" or "vertical". */
    cutoff: 'horizontal',
    /**
     * The scale `lower`, `upper` and every milestone are written in: "C" or "F". Most
     * US tables are °F-days; readings are converted, so the table can be copied as is.
     */
    units: 'C',
    /**
     * Start of the count: `MM-DD` repeats every year, `YYYY-MM-DD` is a fixed date such
     * as a biofix or planting date. The first counted day is the start date itself.
     */
    since: '01-01',
    /** Ascending [{ "at": degree-days, "label": "what it means" }]. */
    milestones: [],
    /** How long an alert stays open after its milestone is reached. */
    holdHours: 72,
    /** A day counts only if at least this fraction of its 24 hours was observed. */
    minDayCoverage: 0.75,
    /** Refuse to report once more than this many days of the season could not be counted. */
    maxMissingDays: 3,
    ...SCOPE_PARAMS,
  },
  requires: [
    { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
  ],

  async run(ctx): Promise<Finding[]> {
    const paths = resolvePaths(ctx.params, 'paths');
    const method = str(ctx.params, 'method') as DegreeDayMethod;
    const cutoff = str(ctx.params, 'cutoff') as Cutoff;
    const units = str(ctx.params, 'units');
    const lower = num(ctx.params, 'lower');
    const upper = optNum(ctx.params, 'upper');
    const since = parseSince(ctx.params.since);
    const milestones = parseMilestones(ctx.params.milestones);
    const holdHours = num(ctx.params, 'holdHours');
    const minDayCoverage = num(ctx.params, 'minDayCoverage');
    const maxMissingDays = int(ctx.params, 'maxMissingDays');

    if (!['sine', 'average', 'modified'].includes(method)) {
      throw new Error(`method must be "sine", "average" or "modified" (got "${method}")`);
    }
    if (cutoff !== 'horizontal' && cutoff !== 'vertical') {
      throw new Error(`cutoff must be "horizontal" or "vertical" (got "${cutoff}")`);
    }
    if (units !== 'C' && units !== 'F') throw new Error(`units must be "C" or "F" (got "${units}")`);
    if (method === 'average' && upper !== null) {
      throw new Error('method "average" has no upper threshold — use "modified" or "sine" to cap it');
    }
    if (upper !== null && upper <= lower) {
      throw new Error(`upper (${upper}) must be above lower (${lower})`);
    }
    if (!(holdHours > 0)) throw new Error('holdHours must be positive');
    if (!(minDayCoverage > 0) || minDayCoverage > 1) {
      throw new Error('minDayCoverage must be above 0 and at most 1');
    }
    if (maxMissingDays < 0) throw new Error('maxMissingDays must not be negative');

    const tz = ctx.timezone ?? 'UTC';
    const window = completeDays(since, ctx.now, tz);
    if (!window) {
      ctx.log.debug('no complete day since the start date yet', { since });
      return [];
    }

    const scope = resolveScope(ctx.params);
    const series = await hourlySeries(ctx, paths, window.start, tz, scope);
    if (series.length === 0) {
      ctx.log.debug('no device reports any candidate path', { paths: pathsLabel(paths) });
      return [];
    }

    const toUnits = (c: number) => (units === 'F' ? c * 1.8 + 32 : c);
    const unitLabel = units === 'F' ? '°F-days' : '°C-days';
    const findings: Finding[] = [];
    const refused: string[] = [];

    for (const s of series) {
      const days = summarizeDays(s.hours, window.start, window.end);
      let total = 0;
      let missing = 0;
      const crossedOn = new Map<number, string>();
      for (const d of days) {
        if (d.hoursObserved / 24 < minDayCoverage || d.min === null || d.max === null) {
          missing += 1;
          continue;
        }
        total += dailyDegreeDays(toUnits(d.min), toUnits(d.max), lower, upper, method, cutoff);
        milestones.forEach((m, i) => {
          if (total >= m.at && !crossedOn.has(i)) crossedOn.set(i, d.date);
        });
      }

      if (missing > maxMissingDays) {
        refused.push(`${s.devEui} (${missing} days missing)`);
        continue;
      }

      // The latest milestone reached, and whether it is still news.
      const reached = [...crossedOn.keys()].sort((a, b) => a - b).pop();
      if (reached === undefined) continue;
      const on = crossedOn.get(reached)!;
      // A milestone is known at the end of the day it was crossed on.
      const knownAt = zonedMidnight(addDays(on, 1), tz).getTime();
      const age = (ctx.now.getTime() - knownAt) / 3_600_000;
      if (age > holdHours) continue;

      const m = milestones[reached];
      const next = milestones[reached + 1] ?? null;
      const name = s.deviceName ?? s.devEui;
      const methodLabel = method === 'sine' ? `single sine, ${cutoff} cutoff` : method;
      const thresholds = upper === null ? `${lower}°${units}` : `${lower}/${upper}°${units}`;

      findings.push({
        devEui: s.devEui,
        deviceName: s.deviceName,
        summary:
          `${name} reached ${m.label}: ${round(total, 0)} ${unitLabel} since ${window.start} ` +
          `(milestone ${m.at}, reached ${on}; ${thresholds}, ${methodLabel})` +
          (next ? ` — next: ${next.label} at ${next.at}` : ''),
        detail: {
          measurement: s.matchedPath,
          milestone: m.label,
          milestoneAt: m.at,
          reachedOn: on,
          total: round(total, 1),
          units: unitLabel,
          nextMilestone: next?.label ?? null,
          nextAt: next?.at ?? null,
          remaining: next ? round(next.at - total, 1) : null,
          since: window.start,
          through: window.end,
          method,
          cutoff: method === 'sine' ? cutoff : null,
          lower,
          upper,
          missingDays: missing,
          today: localDate(ctx.now, tz),
        },
      });
    }

    if (refused.length > 0) {
      ctx.log.warn(
        'degree-days not reported — too many days of the season had too few readings to ' +
          'count, so any milestone would be late. Raise maxMissingDays or lower ' +
          'minDayCoverage if the gaps are known',
        { devices: refused.slice(0, 5), maxMissingDays },
      );
    }

    return findings;
  },
};

export default rule;
