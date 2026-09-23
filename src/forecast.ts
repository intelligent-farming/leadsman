/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * The weather that has not happened yet, from Weatherbit.
 *
 * Every other source this engine reads is a record of the past, and that is a real
 * ceiling on what it can be useful for. The decisions a grower actually loses money on
 * are made against the future — spray before the rain arrives, run the fans tonight,
 * pick ahead of the heat, keep the sprayer out of a block that is about to become
 * untrafficable. None of that is derivable from an event store at any price.
 *
 * ## One call per sounding
 *
 * A forecast's spatial resolution is kilometres; the distance between blocks is
 * hundreds of metres. Fetching per device, or per check, would multiply quota use and
 * return the same numbers, so the config names ONE centroid for the operation and every
 * check shares that answer. The source memoizes per coordinate for the life of the
 * sounding, so ten checks calling `forecast()` cost one HTTP request. A check that
 * passes explicit coordinates costs one more — deliberately the exception.
 *
 * ## Normalized onto the codec vocabulary
 *
 * Weatherbit's field names and units are its own. They are mapped here onto the same
 * vocabulary paths and units the decoders emit, so `air.temperature` is °C and
 * `wind.speed` is m/s whether the number came from a sensor in the orchard or from an
 * API. That is what lets `forecast-threshold` reuse the ordinary candidate-path
 * mechanism instead of inventing a second vocabulary for the future tense, and it means
 * a frost threshold of 1.5 reads identically in both.
 *
 * No new dependency: `fetch` and `AbortController` are already how notify.ts and
 * chirpstack.ts make HTTP calls, so `pg` + `croner` remains the whole tree.
 */

import type {
  Coordinates,
  Forecast,
  ForecastConfig,
  ForecastHour,
  ForecastSource,
  Logger,
} from './types';

export class ForecastError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForecastError';
  }
}

const DEFAULT_BASE_URL = 'https://api.weatherbit.io';

/**
 * Weatherbit's hourly field names, mapped to vocabulary paths.
 *
 * Requested with `units=M`, which makes Weatherbit's units already the vocabulary's:
 * temp °C, rh %, wind_spd m/s, precip mm/hr, pres hPa (their "mb"), solar_rad W/m².
 * No arithmetic happens here on purpose — a unit conversion buried in a provider
 * adapter is the kind of thing that is wrong for a year before anyone notices.
 *
 * The `forecast.*` paths have no sensor equivalent and cannot get one: probability of
 * precipitation is not a quantity anything can measure, and a gust forecast is a
 * different statistic from an anemometer's window maximum.
 */
const FIELD_MAP: ReadonlyArray<readonly [weatherbitField: string, path: string]> = [
  ['temp', 'air.temperature'],
  ['rh', 'air.relativeHumidity'],
  ['wind_spd', 'wind.speed'],
  ['wind_dir', 'wind.direction'],
  ['precip', 'rain.intensity'],
  ['pres', 'air.pressure'],
  ['solar_rad', 'air.solarIrradiance'],
  ['dewpt', 'air.dewPoint'],
  ['uv', 'air.uvIndex'],
  ['snow', 'forecast.snowIntensity'],
  ['pop', 'forecast.precipitationProbability'],
  ['clouds', 'forecast.cloudCover'],
  ['app_temp', 'forecast.apparentTemperature'],
  ['wind_gust_spd', 'forecast.windGust'],
];

/** Every path a forecast can carry, for error messages and `leadsman list`. */
export const FORECAST_PATHS: readonly string[] = FIELD_MAP.map(([, path]) => path);

/** One hour as Weatherbit's /forecast/hourly returns it. */
interface WeatherbitHour {
  timestamp_utc?: string;
  [field: string]: unknown;
}

/**
 * Resolve the API key.
 *
 * The environment wins over the file. The operator asked for the key to be allowed in
 * the config's general section and it is, but every other credential in this engine is
 * environment-only precisely so a config file stays safe to commit and diff — so the
 * env path stays the recommended one and the caller is told which was used.
 */
export function resolveApiKey(
  config: ForecastConfig,
): { apiKey: string; source: 'env' | 'config' } | { missing: string } {
  const fromEnv = process.env.LEADSMAN_WEATHERBIT_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return { apiKey: fromEnv.trim(), source: 'env' };
  }
  if (typeof config.apiKey === 'string' && config.apiKey.trim().length > 0) {
    return { apiKey: config.apiKey.trim(), source: 'config' };
  }
  return {
    missing:
      'no Weatherbit API key — set LEADSMAN_WEATHERBIT_API_KEY, or forecast.apiKey in ' +
      'the config file (which then holds a credential and should not be committed)',
  };
}

/** Round a coordinate for use as a memo key: ~11 m, far finer than any forecast grid. */
function keyFor(at: Coordinates): string {
  return `${at.latitude.toFixed(4)},${at.longitude.toFixed(4)}`;
}

/** Pull the numeric fields we understand out of one provider row. */
function normalizeHour(row: WeatherbitHour, now: number): ForecastHour | null {
  const stamp = typeof row.timestamp_utc === 'string' ? row.timestamp_utc : null;
  if (!stamp) return null;
  // Weatherbit's timestamp_utc has no zone suffix; it is documented as UTC.
  const at = new Date(/[Zz]|[+-]\d\d:?\d\d$/.test(stamp) ? stamp : `${stamp}Z`);
  if (Number.isNaN(at.getTime())) return null;

  const values: Record<string, number> = {};
  for (const [field, path] of FIELD_MAP) {
    const raw = row[field];
    // Absent rather than zero: 0 °C and 0 m/s are both real values, so a missing field
    // has to stay missing or a frost check reads "no data" as "freezing".
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    values[path] = raw;
  }

  return {
    at: at.toISOString(),
    leadHours: (at.getTime() - now) / 3_600_000,
    values,
  };
}

/**
 * A ForecastSource backed by Weatherbit's hourly endpoint.
 *
 * Memoizes the in-flight promise, not just the settled value, so two checks calling in
 * the same tick share one request rather than racing to make two.
 */
export function forecastSource(
  config: ForecastConfig,
  apiKey: string,
  log: Pick<Logger, 'debug' | 'warn'>,
): ForecastSource {
  const centroid: Coordinates = { latitude: config.latitude, longitude: config.longitude };
  const cache = new Map<string, Promise<Forecast>>();
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

  const load = async (at: Coordinates): Promise<Forecast> => {
    const url =
      `${baseUrl}/v2.0/forecast/hourly` +
      `?lat=${encodeURIComponent(String(at.latitude))}` +
      `&lon=${encodeURIComponent(String(at.longitude))}` +
      `&hours=${encodeURIComponent(String(config.hours))}` +
      `&units=M&key=${encodeURIComponent(apiKey)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) {
        // The URL carries the key as a query parameter, so it must never reach a log
        // line or an error string. Only the status does.
        throw new ForecastError(
          res.status === 403
            ? 'Weatherbit returned HTTP 403 — the API key is rejected, or the hourly ' +
              'endpoint is not included in this plan'
            : `Weatherbit returned HTTP ${res.status}`,
        );
      }

      const body = (await res.json()) as {
        data?: WeatherbitHour[];
        city_name?: string;
        timezone?: string;
      };
      const now = Date.now();
      const hours = (body.data ?? [])
        .map((row) => normalizeHour(row, now))
        .filter((h): h is ForecastHour => h !== null)
        .sort((a, b) => a.leadHours - b.leadHours);

      if (hours.length === 0) {
        throw new ForecastError(
          'Weatherbit returned no usable hours — the response parsed but carried no ' +
            'timestamped entries',
        );
      }

      log.debug('fetched forecast', {
        at: keyFor(at),
        hours: hours.length,
        through: hours[hours.length - 1].at,
      });

      return {
        at,
        locationName: typeof body.city_name === 'string' ? body.city_name : null,
        retrievedAt: new Date(now).toISOString(),
        hours,
      };
    } catch (err) {
      if (err instanceof ForecastError) throw err;
      const e = err as Error;
      throw new ForecastError(
        e.name === 'AbortError'
          ? `Weatherbit request timed out after ${config.timeoutMs}ms`
          : `Weatherbit request failed: ${e.message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    centroid,
    forecast: (at?: Coordinates) => {
      const point = at ?? centroid;
      const key = keyFor(point);
      let pending = cache.get(key);
      if (!pending) {
        pending = load(point);
        cache.set(key, pending);
        // A rejected forecast must not be cached as the answer for the rest of the
        // sounding's lifetime — but the source only lives for one sounding, so the
        // retry this enables is the next check in the same pass, not a hot loop.
        pending.catch(() => cache.delete(key));
      }
      return pending;
    },
  };
}
