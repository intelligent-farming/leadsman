/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * disease-index — a published disease model, run day by day over the season.
 *
 * `mold-risk` and `daily-streak` answer "did the weather allow an infection". The
 * models here answer the question a spray program is actually run on — how much
 * pressure has built up — by carrying a score from one day to the next:
 *
 *   gubler-thomas   The UC Davis grape powdery mildew risk index (UC IPM). Starts at
 *                   60 after three consecutive days with ≥ 6 continuous hours at
 *                   21–29.4 °C; then +20 for each such day (+10 if it also reached
 *                   35 °C), −10 for each day without; bounded 0–100. Raised while the
 *                   index is at or above `threshold` (default 60: high pressure), with
 *                   the UC spray intervals for that pressure in the alert.
 *   tomcast         TOM-CAST (early blight, Septoria leaf spot, anthracnose, black mold
 *                   on tomato). Each day earns a disease severity value, 0–4, from its
 *                   hours of leaf wetness and the mean temperature during them. The
 *                   protocol sprays when the DSV total since the last spray reaches
 *                   `threshold` (UC IPM: 12 for susceptible varieties, 18 resistant;
 *                   15 is the Midwest default) and then starts counting again from
 *                   zero — so an alert is raised each time the DSV since the previous
 *                   spray point reaches `threshold`, and held for `holdHours`. Surplus
 *                   DSV on the crossing day does not carry into the next interval: the
 *                   spray is applied after that day, and the protocol counts from it.
 *   wallin          Wallin late-blight severity values (potato and tomato), the model
 *                   BLITECAST builds on and the one most US late-blight programmes use.
 *                   Each day earns 0–4 from its hours at RH ≥ 90 % (`wetMin`) and the
 *                   mean temperature during them (UC IPM's table, 7.2–26.6 °C).
 *                   Accumulation starts at plant emergence (`since`); the first spray is
 *                   due at `threshold` severity values (18 by convention — UC IPM: blight
 *                   is predicted 7–14 days after 18–20). After that the count restarts
 *                   from zero, as with TOM-CAST. BLITECAST times later sprays from a
 *                   matrix of the last seven days' rain-favourable days and severity
 *                   values; that matrix needs rainfall and is not implemented, so repeat
 *                   alerts here are an approximation of it — say so to whoever acts on one.
 *
 * These are named models rather than tables in the config, because the published
 * tables are fixed and a hand-entered copy of one is the most likely way to get a
 * disease model subtly wrong. They are still mechanisms in this engine's sense: which
 * sensor feeds them, over which blocks, is configuration.
 *
 * Both are judged on complete local days. A day observed for less than
 * `minDayCoverage` of its hours is unknown: it breaks the Gubler-Thomas start-up streak
 * and leaves a running index unchanged, and it earns no DSV.
 */

import { hourlySeries, pathsLabel, resolvePaths, type HourlySeries } from '../measurement';
import {
  gublerThomas,
  gublerThomasIntervals,
  longestRunInBand,
  summarizeDays,
  tomcastDsv,
  wallinSv,
} from '../models';
import { num, optNum, round, str } from '../params';
import { resolveScope, SCOPE_PARAMS } from '../scope';
import { addDays, completeDays, parseSince, zonedMidnight } from '../season';
import type { Finding, Rule, SoundingContext } from '../types';

type Model = 'gubler-thomas' | 'tomcast' | 'wallin';
const MODELS: Model[] = ['gubler-thomas', 'tomcast', 'wallin'];

/** The day-by-day severity models: a daily value from wet hours and the mean temperature during them. */
interface SeverityModel {
  model: 'tomcast' | 'wallin';
  /** What one unit of the running total is called in alerts. */
  unit: 'DSV' | 'severity values';
  /** Prefix for the detail keys: totalDsv / dsvSinceCrossing, totalSv / svSinceCrossing. */
  key: 'Dsv' | 'Sv';
  title: string;
  daily: (wetHours: number, meanTemp: number) => number;
}
const SEVERITY: Record<'tomcast' | 'wallin', SeverityModel> = {
  tomcast: { model: 'tomcast', unit: 'DSV', key: 'Dsv', title: 'TOM-CAST spray point', daily: tomcastDsv },
  wallin: { model: 'wallin', unit: 'severity values', key: 'Sv', title: 'late blight (Wallin) spray point', daily: wallinSv },
};

const rule: Rule = {
  id: 'disease-index',
  description:
    'Runs a published disease model day by day since a season start: the Gubler-Thomas ' +
    'grape powdery mildew index, TOM-CAST disease severity values for tomato, or Wallin ' +
    'late-blight severity values. Raises at high index pressure, or each time the ' +
    'accumulated severity reaches the spray threshold.',
  defaultSeverity: 'warning',
  /** Acting on it needs spray history, product and crop stage. */
  defaultRouting: 'situation',
  defaultParams: {
    /** "gubler-thomas", "tomcast" or "wallin". */
    model: 'gubler-thomas',
    /** Temperature paths, in °C. */
    temperaturePaths: ['air.temperature', 'temperature', 'leaf.temperature'],
    /**
     * TOM-CAST and Wallin: the wetness measurement. TOM-CAST: `leaf.wetness` with its
     * sensor's wet cut-off as wetMin, or `air.relativeHumidity` with 90 as a proxy.
     * Wallin is defined on humidity: `air.relativeHumidity` with wetMin 90.
     */
    wetnessPaths: ['leaf.wetness'],
    /** TOM-CAST and Wallin: an hour counts when its mean wetness reading is at least this. */
    wetMin: null,
    /** Start of the season's count: `MM-DD` every year, or `YYYY-MM-DD`. */
    since: '04-01',
    /** Gubler-Thomas: index at or above which to raise (0–100). TOM-CAST, Wallin: severity per spray. */
    threshold: 60,
    /** TOM-CAST and Wallin: how long an alert stays open after a threshold crossing. */
    holdHours: 48,
    /** A day is judged only if at least this fraction of its hours was observed. */
    minDayCoverage: 0.75,
    ...SCOPE_PARAMS,
  },
  requires: [
    { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
  ],

  async run(ctx): Promise<Finding[]> {
    const model = str(ctx.params, 'model') as Model;
    const temperaturePaths = resolvePaths(ctx.params, 'temperaturePaths');
    const since = parseSince(ctx.params.since);
    const threshold = num(ctx.params, 'threshold');
    const holdHours = num(ctx.params, 'holdHours');
    const minDayCoverage = num(ctx.params, 'minDayCoverage');

    if (!MODELS.includes(model)) {
      throw new Error(`model must be one of ${MODELS.map((m) => `"${m}"`).join(', ')} (got "${model}")`);
    }
    if (model === 'gubler-thomas' && !(threshold > 0 && threshold <= 100)) {
      throw new Error('threshold for gubler-thomas is an index value, above 0 and at most 100');
    }
    if (model !== 'gubler-thomas' && !(threshold > 0)) {
      throw new Error(`threshold for ${model} is the severity total per spray, and must be positive`);
    }
    if (!(holdHours > 0)) throw new Error('holdHours must be positive');
    if (!(minDayCoverage > 0) || minDayCoverage > 1) {
      throw new Error('minDayCoverage must be above 0 and at most 1');
    }
    let wetnessPaths: string[][] = [];
    let wetMin: number | null = null;
    if (model !== 'gubler-thomas') {
      wetnessPaths = resolvePaths(ctx.params, 'wetnessPaths');
      wetMin = optNum(ctx.params, 'wetMin');
      if (wetMin === null) {
        throw new Error(
          model === 'tomcast'
            ? 'tomcast needs wetMin — the reading at which an hour counts as wet. A leaf-wetness ' +
                'percentage means different things on different sensors; with ' +
                'air.relativeHumidity as the proxy, 90 is conventional'
            : 'wallin needs wetMin — the model counts hours at RH ≥ 90 %, so with ' +
                'air.relativeHumidity set it to 90',
        );
      }
    }

    const tz = ctx.timezone ?? 'UTC';
    const window = completeDays(since, ctx.now, tz);
    if (!window) return [];
    const scope = resolveScope(ctx.params);
    const temps = await hourlySeries(ctx, temperaturePaths, window.start, tz, scope);
    if (temps.length === 0) {
      ctx.log.debug('no device reports any temperature path', { paths: pathsLabel(temperaturePaths) });
      return [];
    }

    return model === 'gubler-thomas'
      ? gublerThomasFindings(ctx, temps, window, threshold, minDayCoverage)
      : severityFindings(SEVERITY[model], ctx, temps, await hourlySeries(ctx, wetnessPaths, window.start, tz, scope),
          window, threshold, wetMin!, holdHours, minDayCoverage, tz);
  },
};

function gublerThomasFindings(
  ctx: SoundingContext,
  temps: HourlySeries[],
  window: { start: string; end: string },
  threshold: number,
  minDayCoverage: number,
): Finding[] {
  const findings: Finding[] = [];
  for (const s of temps) {
    const days = summarizeDays(s.hours, window.start, window.end).map((d) => ({
      date: d.date,
      runHours: longestRunInBand(d.hours, 21, 29.4),
      heat: d.max !== null && d.max >= 35,
      known: d.hoursObserved / 24 >= minDayCoverage,
    }));
    const state = gublerThomas(days);
    if (state.index === null || state.index < threshold) continue;

    const iv = gublerThomasIntervals(state.index);
    const name = s.deviceName ?? s.devEui;
    findings.push({
      devEui: s.devEui,
      deviceName: s.deviceName,
      summary:
        `${name} powdery mildew risk index ${state.index} (${iv.pressure} pressure, started ` +
        `${state.startedOn}) — UC spray intervals: sulfur dust ${iv.sulfurDustDays} d, ` +
        `micronized sulfur ${iv.micronizedSulfurDays} d, DMI ${iv.dmiDays} d`,
      detail: {
        model: 'gubler-thomas',
        measurement: s.matchedPath,
        index: state.index,
        threshold,
        startedOn: state.startedOn,
        through: window.end,
        ...iv,
        recent: days.slice(-5),
      },
    });
  }
  ctx.log.debug('gubler-thomas evaluated', { devices: temps.length, raised: findings.length });
  return findings;
}

function severityFindings(
  m: SeverityModel,
  ctx: SoundingContext,
  temps: HourlySeries[],
  wetness: HourlySeries[],
  window: { start: string; end: string },
  threshold: number,
  wetMin: number,
  holdHours: number,
  minDayCoverage: number,
  tz: string,
): Finding[] {
  const wetByDevice = new Map(wetness.map((w) => [w.devEui, w]));
  const findings: Finding[] = [];

  for (const t of temps) {
    const w = wetByDevice.get(t.devEui);
    if (!w) continue;
    const tempByHour = new Map(t.hours.map((h) => [h.hour, h.mean]));
    const wetDays = summarizeDays(w.hours, window.start, window.end);

    let total = 0;
    /** DSV since the last spray point (or since `since`); reset to zero at each one. */
    let interval = 0;
    let sprays = 0;
    let lastCrossing: string | null = null;
    const daily: { date: string; wetHours: number; meanTemp: number | null; dsv: number | null }[] = [];
    for (const d of wetDays) {
      if (d.hoursObserved / 24 < minDayCoverage) {
        daily.push({ date: d.date, wetHours: 0, meanTemp: null, dsv: null });
        continue;
      }
      const wetHours = d.hours.filter((h) => h.mean >= wetMin);
      const wetTemps = wetHours.map((h) => tempByHour.get(h.hour)).filter((v): v is number => v !== undefined);
      const meanTemp = wetTemps.length > 0 ? wetTemps.reduce((a, b) => a + b, 0) / wetTemps.length : null;
      const dsv = meanTemp === null ? 0 : m.daily(wetHours.length, meanTemp);
      daily.push({ date: d.date, wetHours: wetHours.length, meanTemp, dsv });
      total += dsv;
      interval += dsv;
      if (interval >= threshold) {
        sprays += 1;
        lastCrossing = d.date;
        interval = 0;
      }
    }
    if (lastCrossing === null) continue;

    const age = (ctx.now.getTime() - zonedMidnight(addDays(lastCrossing, 1), tz).getTime()) / 3_600_000;
    if (age > holdHours) continue;

    const name = t.deviceName ?? t.devEui;
    findings.push({
      devEui: t.devEui,
      deviceName: t.deviceName,
      summary:
        `${name} ${m.title} reached on ${lastCrossing}: at least ${threshold} ${m.unit} ` +
        `accumulated since the previous one, and the count restarts from zero (${total} ${m.unit} ` +
        `since ${window.start}, spray point ${sprays} this season)`,
      detail: {
        model: m.model,
        temperature: t.matchedPath,
        wetness: w.matchedPath,
        wetMin,
        threshold,
        [`total${m.key}`]: total,
        sprayPoints: sprays,
        crossedOn: lastCrossing,
        /** Severity earned on the days after `crossedOn` — toward the next spray point. */
        [`${m.key.toLowerCase()}SinceCrossing`]: interval,
        since: window.start,
        through: window.end,
        recent: daily.slice(-7).map(({ dsv, ...d }) => ({
          ...d,
          meanTemp: d.meanTemp === null ? null : round(d.meanTemp, 1),
          [m.key.toLowerCase()]: dsv,
        })),
      },
    });
  }
  return findings;
}

export default rule;
