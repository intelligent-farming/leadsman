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
     * Ignore the first this-many hours. Occasionally useful to suppress the hour in
     * progress, which every provider reports as a partly-observed estimate.
     */
    afterHours: 0,
    /**
     * Require this many forecast hours to breach before raising. 1 alerts on a single
     * hour dipping over the line; 2 or 3 asks for a sustained event and filters the
     * model's noisiest single-hour excursions.
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

    const crossings: Crossing[] = [];
    let carried = 0;
    for (const hour of inWindow) {
      const hit = valueAt(hour, paths);
      if (!hit) continue;
      carried += 1;
      const belowMin = min !== null && hit.value < min;
      const aboveMax = max !== null && hit.value > max;
      if (belowMin || aboveMax) crossings.push({ hour, path: hit.path, value: hit.value });
    }

    if (carried === 0) {
      // The provider does not supply this field. Worth a warning rather than a silent
      // nothing: a typo'd path looks exactly like fine weather forever.
      ctx.log.warn('the forecast carries none of the candidate paths', {
        paths: pathsLabel(paths),
        available: Object.keys(inWindow[0].values).join(', '),
      });
      return [];
    }

    if (crossings.length < minHours) return [];

    // The worst hour is what the summary leads with — a grower deciding whether to run
    // fans wants the coldest number, not the first one over the line.
    const worst = crossings.reduce((a, b) => {
      if (min !== null) return b.value < a.value ? b : a;
      return b.value > a.value ? b : a;
    });
    const soonest = crossings.reduce((a, b) => (b.hour.leadHours < a.hour.leadHours ? b : a));
    const direction = min !== null && worst.value < min ? 'below' : 'above';
    const bound = direction === 'below' ? `${min}${unit}` : `${max}${unit}`;

    const label =
      (typeof ctx.params.locationLabel === 'string' && ctx.params.locationLabel) ||
      forecast.locationName ||
      `${forecast.at.latitude.toFixed(3)}, ${forecast.at.longitude.toFixed(3)}`;

    return [
      {
        subject: { kind: 'site', id: 'site', name: label },
        summary:
          `${label}: ${worst.path} forecast ${round(worst.value, 1)}${unit} ` +
          `(${direction} ${bound}) in ${round(soonest.hour.leadHours, 0)}h — ` +
          `${crossings.length} hour${crossings.length > 1 ? 's' : ''} affected, ` +
          `worst at ${worst.hour.at.slice(11, 16)}Z`,
        detail: {
          measurement: worst.path,
          worstValue: round(worst.value, 2),
          worstAt: worst.hour.at,
          firstBreachAt: soonest.hour.at,
          leadHours: round(soonest.hour.leadHours, 1),
          hoursAffected: crossings.length,
          min,
          max,
          breached: direction === 'below' ? 'min' : 'max',
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
