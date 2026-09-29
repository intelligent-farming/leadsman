/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * forecast-threshold — a condition that has not happened yet.
 *
 * Every other check in this engine reads the past, and that was a real ceiling on what
 * it could be useful for. A frost alert at 04:10 tells a grower their crop is already
 * frosted; the same alert at 18:00 the evening before is the difference between
 * running the fans and losing the block. The decisions that matter most are made
 * against the future:
 *
 *   - frost tonight          → run fans, irrigate for latent heat, delay the pick
 *   - rain within 6 hours    → do not spray, the residue washes off and the money
 *                              goes on the ground; get machinery off wet ground
 *   - heat above 38 tomorrow → bring the harvest forward, pre-irrigate, move stock
 *   - wind above 8 m/s       → the spray window is closed
 *
 * ## Subject
 *
 * A forecast is about a PLACE, not a device, so this raises against the site rather
 * than inventing a device to pin it on. That is the same reasoning `fleet-silent`
 * uses: pinning a site-wide fact on one of the sensors that happens to be nearby is
 * how an operator ends up driving out to look at a working sensor.
 *
 * ## One call, shared
 *
 * The forecast is fetched once per sounding for the configured centroid and shared by
 * every forecast check in the pass. Ten instances of this rule — frost, heat, rain,
 * wind, spray window — cost one HTTP request between them. `latitude`/`longitude` can
 * override the centroid per check, which costs one additional request per distinct
 * point and is worth it only for genuinely distant blocks.
 *
 * ## Routing
 *
 * A fact. "Frost forecast at 04:00, -2 °C, 10 hours out" is the whole story and the
 * response is a decision the grower already knows how to make. Sending it to a model
 * to be told it is cold would be paying tokens to restate the summary.
 */

import { int, num, optNum, round, str } from '../params';
import { pathsLabel, resolvePaths } from '../measurement';
import type { Coordinates, Finding, ForecastHour, Rule } from '../types';

/** The hour a forecast check cares about, and the value that made it care. */
interface Crossing {
  hour: ForecastHour;
  path: string;
  value: number;
}

type Direction = 'below' | 'above';

/** A breach of one bound, summarised over its qualifying runs. */
interface Breach {
  direction: Direction;
  bound: number;
  /** Most extreme hour: coldest for `below`, hottest for `above`. */
  worst: Crossing;
  /** The first qualifying run — the one a grower has to act on first. */
  runStart: Crossing;
  runEnd: Crossing;
  runHours: number;
  /** Hours across every qualifying run; a lone excursion shorter than minHours is not counted. */
  hoursAffected: number;
  longestRunHours: number;
}

/**
 * Consecutive runs of hours breaching one side, keeping those at least `minHours` long.
 * `series` is the window in lead-time order, with null for an hour that carries none of
 * the candidate paths — which breaks a run, since nothing is known about that hour.
 */
function breachFor(
  series: Array<Crossing | null>,
  direction: Direction,
  bound: number,
  minHours: number,
): Breach | null {
  const breaches = (c: Crossing | null): c is Crossing =>
    c !== null && (direction === 'below' ? c.value < bound : c.value > bound);

  const runs: Crossing[][] = [];
  let current: Crossing[] = [];
  for (const c of series) {
    if (breaches(c)) {
      current.push(c);
      continue;
    }
    if (current.length > 0) runs.push(current);
    current = [];
  }
  if (current.length > 0) runs.push(current);

  const qualifying = runs.filter((r) => r.length >= minHours);
  if (qualifying.length === 0) return null;

  const hours = qualifying.flat();
  const worst = hours.reduce((a, b) =>
    (direction === 'below' ? b.value < a.value : b.value > a.value) ? b : a);
  const first = qualifying[0];
  return {
    direction,
    bound,
    worst,
    runStart: first[0],
    runEnd: first[first.length - 1],
    runHours: first.length,
    hoursAffected: hours.length,
    longestRunHours: Math.max(...qualifying.map((r) => r.length)),
  };
}

/** First matching path present in this hour, resolved by the usual candidate priority. */
function valueAt(hour: ForecastHour, paths: string[][]): { path: string; value: number } | null {
  for (const parts of paths) {
    const path = parts.join('.');
    const v = hour.values[path];
    if (typeof v === 'number' && Number.isFinite(v)) return { path, value: v };
  }
  return null;
}

const rule: Rule = {
  id: 'forecast-threshold',
  description:
    'Raises a site alert when the forecast crosses a bound inside a lead-time window ' +
    '— frost tonight, rain before the spray dries, heat tomorrow, wind closing the ' +
    'spray window. Needs a configured forecast provider.',
  defaultSeverity: 'warning',
  /**
   * A fact: the summary carries the value, the hour and the lead time, and the
   * response is a decision the grower already knows how to make.
   */
  defaultRouting: 'fact',
  needs: ['forecast'],
  defaultParams: {
    /**
     * Priority-ordered candidate forecast paths. Normalized onto the same vocabulary
     * the sensors use — air.temperature (°C), wind.speed (m/s), rain.intensity
     * (mm/hour), air.relativeHumidity (%), air.pressure (hPa), air.solarIrradiance
     * (W/m²), air.dewPoint (°C), air.uvIndex — plus the forecast-only paths
     * forecast.precipitationProbability (%), forecast.windGust (m/s),
     * forecast.apparentTemperature (°C), forecast.cloudCover (%) and
     * forecast.snowIntensity (mm/hour).
     */
    paths: ['air.temperature'],
    /** Raise when a forecast hour falls below this. null disables the lower bound. */
    min: 1.5,
    /** Raise when a forecast hour rises above this. null disables the upper bound. */
    max: null,
    /**
     * Only look this far ahead. The horizon IS the actionability: a frost 36 hours out
     * is interesting, a frost 8 hours out is a decision, and alerting on the first
     * makes the second arrive as a duplicate nobody reads.
     */
    withinHours: 12,
    /**
     * Ignore forecast hours that start sooner than this many hours from now. The hour
     * already in progress needs no help — its timestamp is in the past, so its lead is
     * negative and it is excluded even at 0. Use this when a breach closer than N
     * hours is too late to act on (fans need lead time, the spray rig is already out),
     * or to tier two instances of the check — 0–6 h as critical, 6–24 h as a warning —
     * so the same event is not raised by both.
     */
    afterHours: 0,
    /**
     * Require this many CONSECUTIVE forecast hours to breach before raising. 1 alerts
     * on a single hour dipping over the line; 2 or 3 asks for a sustained event and
     * filters the model's noisiest single-hour excursions. Consecutive means adjacent
     * hours in the forecast, breaching on the same side: an hour back inside the bound,
     * or an hour that does not carry the path, ends the run — scattered single-hour
     * dips never add up to an event.
     */
    minHours: 1,
    /** Shown in the alert summary. */
    unit: 'C',
    /** Override the configured centroid for this check. null uses the centroid. */
    latitude: null,
    longitude: null,
    /** Label for the subject, so several instances read distinctly in a phone message. */
    locationLabel: null,
  },
  // Reads no database table at all — the only rule in the set that does not. `requires`
  // must still be non-empty for the registry contract, and event_up is the table the
  // engine cannot run without anyway, so declaring it costs nothing and keeps `verify`
  // honest about what a sounding touches.
  requires: [
    { table: 'event_up', columns: ['dev_eui', 'time'] },
  ],

  async run(ctx): Promise<Finding[]> {
    if (!ctx.forecast) {
      // Unreachable via the runner, which skips on `needs`. Explicit so a direct
      // caller in a test gets a sentence rather than a TypeError.
      throw new Error('no forecast source configured — this rule declares needs: [forecast]');
    }

    const paths = resolvePaths(ctx.params, 'paths');
    const min = optNum(ctx.params, 'min');
    const max = optNum(ctx.params, 'max');
    const withinHours = num(ctx.params, 'withinHours');
    const afterHours = num(ctx.params, 'afterHours');
    const minHours = int(ctx.params, 'minHours');
    const unit = typeof ctx.params.unit === 'string' ? ctx.params.unit : '';
    const lat = optNum(ctx.params, 'latitude');
    const lon = optNum(ctx.params, 'longitude');

    if (min === null && max === null) {
      throw new Error(
        'at least one of "min" or "max" must be set — with neither bound this check ' +
          'can never fire',
      );
    }
    if (min !== null && max !== null && min > max) {
      throw new Error(`min (${min}) must not exceed max (${max})`);
    }
    if (withinHours <= 0) throw new Error('withinHours must be positive');
    if (afterHours < 0) throw new Error('afterHours must not be negative');
    if (afterHours >= withinHours) {
      throw new Error(
        `afterHours (${afterHours}) must be less than withinHours (${withinHours}) — ` +
          'the lead-time window would be empty',
      );
    }
    if (minHours < 1) throw new Error('minHours must be at least 1');
    if ((lat === null) !== (lon === null)) {
      throw new Error('latitude and longitude must be set together, or both left null');
    }

    const at: Coordinates | undefined =
      lat !== null && lon !== null ? { latitude: lat, longitude: lon } : undefined;
    const forecast = await ctx.forecast.forecast(at);

    const inWindow = forecast.hours.filter(
      (h) => h.leadHours >= afterHours && h.leadHours <= withinHours,
    );
    if (inWindow.length === 0) {
      ctx.log.debug('forecast carries no hours in the lead-time window', {
        withinHours, afterHours, returned: forecast.hours.length,
      });
      return [];
    }

    // One entry per in-window hour, in lead order (the source sorts), so adjacency in
    // this array is adjacency in the forecast.
    const series: Array<Crossing | null> = inWindow.map((hour) => {
      const hit = valueAt(hour, paths);
      return hit ? { hour, path: hit.path, value: hit.value } : null;
    });
    const carried = series.filter((c) => c !== null).length;

    if (carried === 0) {
      // The provider does not supply this field. Worth a warning rather than a silent
      // nothing: a typo'd path looks exactly like fine weather forever.
      ctx.log.warn('the forecast carries none of the candidate paths', {
        paths: pathsLabel(paths),
        available: Object.keys(inWindow[0].values).join(', '),
      });
      return [];
    }

    // Each bound is judged on its own. With both set, a day forecast to swing from a
    // frost to a heat spike breaches both, and the summary has to say so — picking one
    // direction would report the lesser problem, or the wrong one.
    const breaches: Breach[] = [];
    if (min !== null) {
      const b = breachFor(series, 'below', min, minHours);
      if (b) breaches.push(b);
    }
    if (max !== null) {
      const b = breachFor(series, 'above', max, minHours);
      if (b) breaches.push(b);
    }
    if (breaches.length === 0) return [];

    // The soonest breach leads — it is the decision due first — and within each
    // direction the worst hour is what the summary quotes: a grower deciding whether to
    // run fans wants the coldest number, not the first one over the line.
    breaches.sort((a, b) => a.runStart.hour.leadHours - b.runStart.hour.leadHours);
    const lead = breaches[0];
    const hoursAffected = breaches.reduce((n, b) => n + b.hoursAffected, 0);
    const describe = (b: Breach) =>
      `${round(b.worst.value, 1)}${unit} (${b.direction} ${b.bound}${unit})`;

    const label =
      (typeof ctx.params.locationLabel === 'string' && ctx.params.locationLabel) ||
      forecast.locationName ||
      `${forecast.at.latitude.toFixed(3)}, ${forecast.at.longitude.toFixed(3)}`;

    return [
      {
        subject: { kind: 'site', id: 'site', name: label },
        summary:
          `${label}: ${lead.worst.path} forecast ${breaches.map(describe).join(' and ')} ` +
          `in ${round(lead.runStart.hour.leadHours, 0)}h — ` +
          `${hoursAffected} hour${hoursAffected > 1 ? 's' : ''} affected, ` +
          `worst at ${lead.worst.hour.at.slice(11, 16)}Z`,
        detail: {
          measurement: lead.worst.path,
          worstValue: round(lead.worst.value, 2),
          worstAt: lead.worst.hour.at,
          firstBreachAt: lead.runStart.hour.at,
          leadHours: round(lead.runStart.hour.leadHours, 1),
          // The first qualifying run: the sustained event minHours asked for.
          runStartAt: lead.runStart.hour.at,
          runEndAt: lead.runEnd.hour.at,
          runHours: lead.runHours,
          hoursAffected,
          minHours,
          min,
          max,
          breached:
            breaches.length === 2 ? 'both' : lead.direction === 'below' ? 'min' : 'max',
          // Per direction, so a both-ways breach keeps each side's numbers.
          breaches: breaches.map((b) => ({
            bound: b.direction === 'below' ? 'min' : 'max',
            limit: b.bound,
            worstValue: round(b.worst.value, 2),
            worstAt: b.worst.hour.at,
            runStartAt: b.runStart.hour.at,
            runEndAt: b.runEnd.hour.at,
            runHours: b.runHours,
            longestRunHours: b.longestRunHours,
            hoursAffected: b.hoursAffected,
          })),
          unit: unit || null,
          withinHours,
          location: { ...forecast.at, name: forecast.locationName },
          retrievedAt: forecast.retrievedAt,
        },
      },
    ];
  },
};

export default rule;
