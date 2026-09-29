/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * measurement-accumulation — how much, rather than how high.
 *
 * Every other measurement check asks about a value: is it out of bounds now, did it
 * ever cross, is it moving fast, has it held. None of them integrate, and that single
 * absence blocks most of the standard agronomic index set — because the numbers a
 * grower actually plans against are totals, not instants.
 *
 *   growing degree days   integral of max(0, T - base) / 24. Pest emergence, harvest
 *                         timing, variety fit. The most-used derived number in
 *                         agronomy and previously inexpressible here.
 *   daily light integral  integral of PAR, scaled to mol/m²/day. The governing number
 *                         under glass, and a greenhouse under target loses yield
 *                         silently for weeks.
 *   rainfall delivered    integral of an intensity, in mm.
 *   heat or cold exposure post-harvest quality, cold-chain dwell above a limit.
 *
 * ## Both directions matter, and the "too little" half is the point
 *
 * `min` is not an afterthought. Insufficient chill, a DLI below target, an irrigation
 * block that did not get its allocation — these are the accumulations that go wrong,
 * and not one of them can be expressed by any other rule in this engine, because
 * "nothing bad happened often enough" leaves no trace for a threshold to catch.
 *
 * ## Method
 *
 *   integral  area under the curve, trapezoid between consecutive readings, in
 *             unit·hours. Right for anything that is a RATE or a persisting level —
 *             temperature, PAR, mm/hour. Insensitive to reporting cadence, which
 *             matters because LoRaWAN cadence is irregular by nature.
 *   sum       every reading added up, ignoring time. Right ONLY when each reading is
 *             already a per-report quantity, such as a tipping-bucket count since the
 *             last uplink. A sum over a rate silently scales with how often the device
 *             happens to report, which is the main way to get a nonsense answer here.
 *
 * ## Coverage is reported, not assumed
 *
 * A gap longer than `maxGapHours` contributes nothing. Holding the last value across a
 * silent day would manufacture degree days out of a dead radio, and an index that
 * quietly counts its own outages is worse than no index. `minCoverage` refuses to
 * report a total at all below a fraction of the window, because "the block is 300 GDD
 * behind" and "the sensor was offline for two days" must not look the same. That
 * applies to `sum` as much as to `integral`: a rain gauge that reported for three
 * hours of twenty-four has not measured a day's rain, and coverage is computed on the
 * same basis for both — time spanned by intervals no longer than `maxGapHours`,
 * including the trailing interval from the latest reading to now.
 *
 * ## The total is judged at full coverage
 *
 * Coverage the rule accepts still biases the total: at 0.8 coverage an honest sensor
 * reports 80 % of the true figure, and an unscaled "short of target" at that coverage
 * is the missing fifth, not the crop. So the observed total is projected to the whole
 * window — `observed / coverage`, the mean rate over the observed time held across the
 * unobserved time — and the PROJECTED total is what is compared with `min` and `max`,
 * in both directions. That is unbiased when the gaps look like the rest of the window
 * and wrong when they do not (a gauge that died during the storm), which is exactly
 * why `minCoverage` still bounds how much of the answer may be projection. The alert
 * carries observed, projected and coverage side by side, so a reader can see how much
 * of the number was measured.
 */

import { int, num, optNum, round, str } from '../params';
import { pathsLabel, resolvePaths, windowAccumulation } from '../measurement';
import { resolveScope, SCOPE_PARAMS } from '../scope';
import type { Finding, Rule } from '../types';

const rule: Rule = {
  id: 'measurement-accumulation',
  description:
    'Flags devices whose accumulated total across a window falls outside a target — ' +
    'growing degree days, chill or heat exposure, daily light integral, rainfall or ' +
    'irrigation delivered. Alerts on too little as well as too much.',
  defaultSeverity: 'info',
  /** Generic: a total outside a target band. Set notifyTo per instance to escalate. */
  defaultRouting: 'fact',
  defaultParams: {
    /** Priority-ordered candidate vocabulary paths. */
    paths: ['air.temperature', 'temperature'],
    /** "integral" (area under the curve) or "sum" — see the header, they differ a lot. */
    method: 'integral',
    /**
     * Subtracted from every reading before integrating, with the remainder floored at
     * zero. That is the degree-day definition: hours below the base contribute nothing
     * rather than cancelling out hours above it. null integrates the raw value.
     */
    base: 10,
    /**
     * Multiplies the integral. The integral is in unit·hours, and most indices want
     * something else:
     *
     *   growing degree days   1/24 = 0.0416667   (°C·hours → °C·days)
     *   daily light integral  0.0036             (µmol/m²/s·h → mol/m²)
     *   millimetres of rain   1                  (mm/h·h is already mm)
     */
    scale: 0.0416667,
    /** Alert when the total is below this. null disables the lower bound. */
    min: null,
    /** Alert when the total is above this. null disables the upper bound. */
    max: null,
    /** Shown in the alert summary. */
    unit: ' GDD',
    /** The accumulation window. 24 for a daily index, 720 for a season to date. */
    lookbackHours: 24,
    /** A reporting gap longer than this contributes nothing to the total. */
    maxGapHours: 3,
    /**
     * Refuse to judge a total built from less than this fraction of the window
     * (above 0, at most 1). An under-target alert from a sensor that was offline half
     * the period is an alert about the radio wearing an agronomic costume. Applies to
     * both methods. The total judged is the observed total scaled up to full coverage.
     */
    minCoverage: 0.8,
    /** A total needs at least this many readings behind it. */
    minSamples: 6,
    /** Hysteresis in the accumulated unit — see measurement-threshold. */
    clearMargin: 0,
    /** Narrow this check to part of the fleet — see src/scope.ts. */
    ...SCOPE_PARAMS,
  },
  requires: [
    { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
  ],

  async run(ctx): Promise<Finding[]> {
    const paths = resolvePaths(ctx.params, 'paths');
    const method = str(ctx.params, 'method');
    const base = optNum(ctx.params, 'base');
    const scale = num(ctx.params, 'scale');
    const min = optNum(ctx.params, 'min');
    const max = optNum(ctx.params, 'max');
    const lookbackHours = int(ctx.params, 'lookbackHours');
    const maxGapHours = num(ctx.params, 'maxGapHours');
    const minCoverage = num(ctx.params, 'minCoverage');
    const minSamples = int(ctx.params, 'minSamples');
    const clearMargin = optNum(ctx.params, 'clearMargin') ?? 0;
    const unit = typeof ctx.params.unit === 'string' ? ctx.params.unit : '';

    if (method !== 'integral' && method !== 'sum') {
      throw new Error(`method must be "integral" or "sum" (got "${method}")`);
    }
    if (min === null && max === null) {
      throw new Error(
        'at least one of "min" or "max" must be set — with neither bound this check ' +
          'can never fire',
      );
    }
    if (min !== null && max !== null && min > max) {
      throw new Error(`min (${min}) must not exceed max (${max})`);
    }
    if (scale === 0) throw new Error('scale must not be zero — the total would always be 0');
    if (maxGapHours <= 0) throw new Error('maxGapHours must be positive');
    if (!(minCoverage > 0) || minCoverage > 1) {
      throw new Error(
        `minCoverage must be between 0 and 1, and above 0 (got ${minCoverage}) — the ` +
          'judged total is scaled by coverage, and a total with no covered time behind ' +
          'it is not a measurement',
      );
    }
    if (clearMargin < 0) throw new Error('clearMargin must not be negative');

    const scope = resolveScope(ctx.params);
    const rows = await windowAccumulation(
      ctx, paths, lookbackHours, method, base, maxGapHours, scope,
    );
    if (rows.length === 0) {
      ctx.log.debug('no device reports any candidate path', { paths: pathsLabel(paths) });
      return [];
    }

    const findings: Finding[] = [];
    // Counted rather than logged per device. One line each would be twenty warnings a
    // sounding on a twenty-device fleet, and a warning that always fires is one an
    // operator learns to scroll past — including on the sounding it finally matters.
    let judged = 0;
    const uncovered: string[] = [];

    for (const r of rows) {
      if (r.samples < minSamples) continue;

      // Same basis for both methods. A sum ignores time in its VALUE, which is why it
      // is the wrong method for a rate, but whether the window was observed at all is
      // a question about time either way. Capped at 1: a reading stamped at the window
      // edge can round covered time a hair past the window.
      const coverage = Math.min(1, r.coveredHours / lookbackHours);
      // The epsilon keeps coverage exactly AT the line on the accepted side: 19.2/24 is
      // 0.7999999999999999 in floating point, not 0.8.
      if (!(coverage > 0) || coverage + 1e-9 < minCoverage) {
        uncovered.push(`${r.devEui} ${Math.round(coverage * 100)}%`);
        ctx.log.debug('accumulation not judged — too little of the window is covered', {
          device: r.devEui,
          coverage: round(coverage, 2),
          minCoverage,
          gapHours: round(r.gapHours, 1),
        });
        continue;
      }
      judged += 1;

      const observed = r.total * scale;
      // Judged at full coverage — see the header. Without it an accepted 0.8 coverage
      // reads 20 % short, and constant 20 °C against a 10 GDD target "fails" at 8.5.
      const total = observed / coverage;
      const open = ctx.openDevEuis.has(r.devEui);
      const lower = min === null ? null : open ? min + clearMargin : min;
      const upper = max === null ? null : open ? max - clearMargin : max;

      const belowMin = lower !== null && total < lower;
      const aboveMax = upper !== null && total > upper;
      if (!belowMin && !aboveMax) continue;

      const name = r.deviceName ?? r.devEui;
      const bound = belowMin ? `target ${min}${unit}` : `limit ${max}${unit}`;
      const projection = coverage < 1
        ? ` (${round(observed, 1)}${unit} observed over ${Math.round(coverage * 100)}% ` +
          'of the window, projected to full coverage)'
        : '';

      findings.push({
        devEui: r.devEui,
        deviceName: r.deviceName,
        summary:
          `${name} accumulated ${round(total, 1)}${unit} from ${r.matchedPath} over ` +
          `${lookbackHours}h${projection} — ${belowMin ? 'short of' : 'over'} ${bound}`,
        detail: {
          measurement: r.matchedPath,
          /** The projected total — the number compared with min and max. */
          total: round(total, 3),
          observedTotal: round(observed, 3),
          projectedTotal: round(total, 3),
          unit: unit.trim() || null,
          method,
          base,
          min,
          max,
          breached: belowMin ? 'min' : 'max',
          lookbackHours,
          coverage: round(coverage, 3),
          gapHours: round(r.gapHours, 2),
          samples: r.samples,
          observedMin: round(r.min, 2),
          observedMax: round(r.max, 2),
          firstAt: r.firstAt,
          lastAt: r.lastAt,
        },
      });
    }

    // Said once, and only when the check is effectively inert. A total nobody can
    // judge looks exactly like a total that is fine, and an accumulation check that
    // silently measures nothing for a season is the failure worth catching here.
    if (judged === 0 && uncovered.length > 0) {
      ctx.log.warn(
        'no device had enough of the window covered to judge an accumulation — this ' +
          'check is currently measuring nothing. Lower minCoverage, shorten ' +
          'lookbackHours, or raise maxGapHours to match the fleet reporting interval',
        {
          devices: uncovered.length,
          minCoverage,
          lookbackHours,
          worst: uncovered.slice(0, 5).join(', '),
        },
      );
    }

    return findings;
  },
};

export default rule;
