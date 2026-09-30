/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * measurement-derived — a threshold on a quantity nothing measures directly.
 *
 * Every other measurement check reads one path and compares it to a bound. Some of the
 * most operationally important numbers on a farm are not on any path, because no sensor
 * emits them: they are formulas over two quantities measured at the same instant.
 *
 *   vpd            Vapour pressure deficit, kPa. The governing number under glass —
 *                  it, not humidity, is what drives transpiration and stomatal closure.
 *                  A greenhouse at 85 % RH means nothing without the temperature.
 *   deltaT         Wet-bulb depression, °C. The standard spray-suitability metric:
 *                  below ~2 the droplets do not evaporate and drift, above ~8-10 they
 *                  evaporate before they land. Outside that band the spray is wasted
 *                  and possibly on the neighbour's block.
 *   dewPoint       °C. Condensation, leaf wetness onset, and the floor an overnight
 *                  radiative frost will actually fall to.
 *   thi            Temperature-humidity index. Livestock heat stress in dairy cattle.
 *                  Armstrong (1994) classifies 72-79 as mild stress, 80-89 moderate
 *                  and 90-98 severe; 72 is the onset still common in extension
 *                  material and appropriate for lower-yielding herds. For
 *                  high-producing cows Zimbelman et al. (2009) put the onset of
 *                  milk-yield loss at 68. There are no built-in bands here — `min`
 *                  and `max` are the operator's — so pick the source that fits the herd.
 *   absoluteHumidity  g/m³. Ventilation and drying calculations, where relative
 *                  humidity is actively misleading because it moves with temperature.
 *
 * All five take temperature and relative humidity, and all five are computed from ONE
 * uplink's pair of readings — a temperature from 04:00 combined with a humidity from
 * 16:00 gives an arithmetically valid, physically meaningless answer.
 *
 * ## Routing
 *
 * A fact, like the other generic mechanisms: `vpd-high` in a greenhouse with automated
 * venting is a number the controller acts on, and `delta-t-unsuitable` is read by
 * whoever is holding the spray wand. A deployment that wants one interpreted sets
 * `notifyTo` on that instance.
 */

import { int, optNum, round, str } from '../params';
import { latestPairs, pathsLabel, resolvePaths } from '../measurement';
import { resolveScope, SCOPE_PARAMS } from '../scope';
import type { Finding, Rule } from '../types';
import { VOCABULARY_RANGES, type VocabularyRange } from '../vocabulary';

/**
 * Saturation vapour pressure over water, kPa. Tetens (the FAO-56 coefficients), which
 * reads low against the IAPWS reference by under 0.1 % from 0 to 30 °C and by about
 * 0.13 % at 40-50 °C. It degrades below freezing — about 0.3 % low at -10 °C and 0.8 %
 * at -20 °C, still over supercooled water rather than ice — which is inside the error
 * of any humidity sensor but worth knowing for a frost-night dew point.
 *
 * Note this is also what `absoluteHumidity` is built on, whereas that quantity is
 * more often published using the Magnus coefficients (17.67 / 243.5) rather than
 * Tetens (17.27 / 237.3). The two disagree by under 0.02 g/m³ across 0-30 °C — far
 * inside the error of any humidity sensor feeding it — and using one function here
 * keeps every derived quantity on a single, testable definition of saturation.
 */
function saturationVapourPressure(tempC: number): number {
  return 0.6108 * Math.exp((17.27 * tempC) / (tempC + 237.3));
}

/**
 * Wet-bulb temperature, °C, from dry bulb and RH.
 *
 * Stull's 2011 empirical fit, published as valid for RH 5-99 % and -20 to 50 °C at
 * standard sea-level pressure, except where low humidity and cold temperature occur
 * together. Over that range its error runs from -1 to +0.65 °C with a mean absolute
 * error under 0.3 °C; the largest errors are at low RH and low temperature. The exact
 * form requires iterating a psychrometric equation. Near the 2 °C and 8-10 °C delta-T
 * spray bounds the fit can move a borderline reading across a line, so treat a
 * delta-T within about half a degree of a bound as marginal rather than decided.
 */
function wetBulb(tempC: number, r: number): number {
  // At saturation the wet bulb IS the dry bulb, by definition. Stull's fit (published
  // only to 99 % RH) does not know that: at 100 % it reads -0.13 °C at 0 °C, -0.06 at
  // 10 °C, +0.01 at 20 °C and +0.08 at 30 °C against the dry bulb. So 100 % returns the
  // dry bulb exactly, and anything else is capped at it — above it would report a
  // negative delta-T, a physically impossible number in an alert a sprayer operator
  // reads. Just below saturation the fit's cold-side bias remains (a delta-T of about
  // 0.1 °C near 0 °C and 99 % RH), far inside the 2 °C spray bound.
  if (r >= 100) return tempC;
  return Math.min(tempC, (
    tempC * Math.atan(0.151977 * Math.sqrt(r + 8.313659)) +
    Math.atan(tempC + r) -
    Math.atan(r - 1.676331) +
    0.00391838 * Math.pow(r, 1.5) * Math.atan(0.023101 * r) -
    4.686035
  ));
}

interface Formula {
  unit: string;
  /** Short description for the alert detail and `leadsman list`. */
  about: string;
  compute(tempC: number, rh: number): number;
}

const FORMULAS: Record<string, Formula> = {
  vpd: {
    unit: ' kPa',
    about: 'vapour pressure deficit from temperature and relative humidity',
    compute: (t, rh) => saturationVapourPressure(t) * (1 - rh / 100),
  },
  dewPoint: {
    unit: 'C',
    about: 'dew point from temperature and relative humidity (Magnus form, Tetens coefficients)',
    compute: (t, rh) => {
      // Guard the log: a codec reporting exactly 0 % RH would otherwise give
      // -Infinity. Inputs outside 0-100 never reach here (see inputProblem).
      const r = Math.max(rh, 0.1);
      const gamma = (17.27 * t) / (237.3 + t) + Math.log(r / 100);
      return (237.3 * gamma) / (17.27 - gamma);
    },
  },
  deltaT: {
    unit: 'C',
    about: 'wet-bulb depression — spray suitability',
    compute: (t, rh) => t - wetBulb(t, rh),
  },
  thi: {
    unit: '',
    about: 'temperature-humidity index — livestock heat stress',
    compute: (t, rh) => {
      const f = 1.8 * t + 32;
      return f - (0.55 - 0.0055 * rh) * (f - 58);
    },
  },
  absoluteHumidity: {
    unit: ' g/m³',
    about: 'absolute humidity from temperature and relative humidity',
    compute: (t, rh) =>
      (2.1674 * (saturationVapourPressure(t) * 10) * rh) /
      (273.15 + t),
  },
};

/**
 * Why a pair is outside the domain every formula here is defined on, or null.
 *
 * The formulas used to clamp RH into 0-100, so a codec emitting 250 % humidity
 * computed as saturated air — vpd 0, delta-T 0, dew point equal to the dry bulb — and
 * fired a vpd-low or spray-unsuitable alert on a sensor fault. Skipping is right
 * instead: measurement-implausible is the check that reports an impossible input, and
 * a derived quantity computed from one is not a field condition.
 *
 * Temperature is held to the vocabulary's declared range for the path that matched
 * (absolute zero for every temperature path), and to the Tetens pole at -237.3 °C
 * whatever the path, since below it the saturation curve is not a curve.
 */
function inputProblem(
  tempPath: string, tempC: number, humidityPath: string, rh: number,
): string | null {
  if (!Number.isFinite(tempC) || !Number.isFinite(rh)) return 'input is not a number';
  if (rh < 0 || rh > 100) return 'relative humidity outside 0-100 %';
  const hr = VOCABULARY_RANGES.get(humidityPath);
  if (hr && !withinRange(rh, hr)) return `${humidityPath} outside its vocabulary range`;
  const tr = VOCABULARY_RANGES.get(tempPath);
  if (tr && !withinRange(tempC, tr)) return `${tempPath} outside its vocabulary range`;
  if (tempC <= -237.3) return 'temperature below the saturation formula\'s domain';
  return null;
}

function withinRange(v: number, [min, max, exclusive]: VocabularyRange): boolean {
  if (min !== null && (v < min || (exclusive?.min === true && v === min))) return false;
  if (max !== null && (v > max || (exclusive?.max === true && v === max))) return false;
  return true;
}

const rule: Rule = {
  id: 'measurement-derived',
  description:
    'Flags devices where a quantity computed from two measurements on the same uplink ' +
    'falls outside a band: vpd, deltaT, dewPoint, thi, or absoluteHumidity from ' +
    'temperature and relative humidity. Enable once per formula with a distinct "as".',
  defaultSeverity: 'warning',
  /** Generic: a computed value outside a band. Set notifyTo per instance to escalate. */
  defaultRouting: 'fact',
  defaultParams: {
    /** Which formula: vpd, deltaT, dewPoint, thi, absoluteHumidity. */
    formula: 'vpd',
    /** Priority-ordered candidate paths for the temperature input, °C. */
    paths: ['air.temperature', 'temperature', 'leaf.temperature'],
    /** Priority-ordered candidate paths for the relative humidity input, %. */
    humidityPaths: ['air.relativeHumidity'],
    /** Alert below this. null disables the lower bound. */
    min: null,
    /** Alert above this. null disables the upper bound. */
    max: 1.5,
    /** How far back to look for a device's most recent complete pair. */
    lookbackHours: 6,
    /** Hysteresis in the computed unit — see measurement-threshold. */
    clearMargin: 0,
    /** Narrow this check to part of the fleet — see src/scope.ts. */
    ...SCOPE_PARAMS,
  },
  requires: [
    { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
  ],

  async run(ctx): Promise<Finding[]> {
    const name = str(ctx.params, 'formula');
    const formula = FORMULAS[name];
    if (!formula) {
      throw new Error(
        `formula must be one of ${Object.keys(FORMULAS).join(', ')} (got "${name}")`,
      );
    }

    const tempPaths = resolvePaths(ctx.params, 'paths');
    const humidityPaths = resolvePaths(ctx.params, 'humidityPaths');
    const min = optNum(ctx.params, 'min');
    const max = optNum(ctx.params, 'max');
    const lookbackHours = int(ctx.params, 'lookbackHours');
    const clearMargin = optNum(ctx.params, 'clearMargin') ?? 0;

    if (min === null && max === null) {
      throw new Error(
        'at least one of "min" or "max" must be set — with neither bound this check ' +
          'can never fire',
      );
    }
    if (min !== null && max !== null && min > max) {
      throw new Error(`min (${min}) must not exceed max (${max})`);
    }
    if (clearMargin < 0) throw new Error('clearMargin must not be negative');
    if (lookbackHours <= 0) {
      throw new Error(
        'lookbackHours must be positive — an empty window holds no readings, so this ' +
          'check could never fire',
      );
    }

    const scope = resolveScope(ctx.params);
    const pairs = await latestPairs(ctx, tempPaths, humidityPaths, lookbackHours, scope);
    if (pairs.length === 0) {
      ctx.log.debug('no device reports both inputs on one uplink', {
        temperature: pathsLabel(tempPaths),
        humidity: pathsLabel(humidityPaths),
      });
      return [];
    }

    const unit = formula.unit;
    const findings: Finding[] = [];

    for (const p of pairs) {
      // An input outside the physical range — a codec emitting 250 % humidity, say —
      // is a data fault, and measurement-implausible is the check that reports it.
      // Saying nothing here is correct; computing on it would alert on the fault as
      // if it were weather.
      const problem = inputProblem(p.primaryPath, p.primary, p.secondaryPath, p.secondary);
      if (problem !== null) {
        ctx.log.debug('input outside the formula\'s domain — skipping', {
          device: p.devEui, formula: name, problem,
          temperature: p.primary, humidity: p.secondary,
        });
        continue;
      }
      const value = formula.compute(p.primary, p.secondary);
      if (!Number.isFinite(value)) {
        ctx.log.debug('derived value is not finite — skipping', {
          device: p.devEui, formula: name, temperature: p.primary, humidity: p.secondary,
        });
        continue;
      }

      const open = ctx.openDevEuis.has(p.devEui);
      const lower = min === null ? null : open ? min + clearMargin : min;
      const upper = max === null ? null : open ? max - clearMargin : max;

      const belowMin = lower !== null && value < lower;
      const aboveMax = upper !== null && value > upper;
      if (!belowMin && !aboveMax) continue;

      const label = p.deviceName ?? p.devEui;
      const bound = belowMin ? `min ${min}${unit}` : `max ${max}${unit}`;

      findings.push({
        devEui: p.devEui,
        deviceName: p.deviceName,
        summary:
          `${label} ${name} ${round(value, 2)}${unit} is ` +
          `${belowMin ? 'below' : 'above'} ${bound} ` +
          `(${round(p.primary, 1)}C, ${round(p.secondary, 0)}% RH)`,
        detail: {
          formula: name,
          about: formula.about,
          value: round(value, 3),
          unit: unit.trim() || null,
          min,
          max,
          breached: belowMin ? 'min' : 'max',
          temperature: round(p.primary, 2),
          relativeHumidity: round(p.secondary, 1),
          inputs: [p.primaryPath, p.secondaryPath],
          readingAt: p.at,
        },
      });
    }

    return findings;
  },
};

export default rule;
