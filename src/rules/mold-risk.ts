/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * mold-risk — humidity held high for long enough, at a temperature the fungus can
 * grow at, to constitute an infection period.
 *
 * Every other measurement check in this repo asks about a value. This one asks about
 * a *duration*, because that is what fungal infection actually depends on. Botrytis
 * on grapes and peacock spot on olives do not care that humidity touched 95 % — they
 * care that free water or near-saturation persisted on the tissue for hours, while
 * the temperature sat in the range the spores germinate in. Those are the two axes of
 * every published infection model (Mills, Broome, the Spilocaea wetness tables), and
 * neither axis alone predicts anything:
 *
 *   - `measurement-threshold` at 90 % RH fires on every cold clear night in autumn,
 *     when radiative cooling saturates the air at 6 °C and nothing germinates.
 *   - A temperature check alone fires on every warm afternoon.
 *   - Both together, *sustained*, is the event a grower sprays for.
 *
 * So this check reports the longest unbroken stretch in which humidity stayed inside
 * a band **while the same uplink** also reported a temperature inside a second band.
 * The gate is what keeps the check from becoming an expensive dew detector.
 *
 *   { "rule": "mold-risk", "as": "grape-botrytis-risk",
 *     "params": { "humidityMin": 90, "temperatureMin": 15, "temperatureMax": 25,
 *                 "dwellHours": 4, "deviceNamePattern": "%vineyard%" } }
 *
 * Point `paths` at `leaf.wetness` instead where the block has wetness sensors: it is
 * the direct measurement of the thing the model is about, and relative humidity is
 * only a proxy for it. Give a wetness instance its own band — 85 % RH and 85 % on a
 * wetness grid are not the same quantity.
 *
 * ## Why this is a `situation`
 *
 * Unlike almost every other rule here, this one defaults to the expensive routing
 * class, and it is the only measurement-shaped rule that does. The summary line is
 * *true* but it is not *actionable*: whether nine hours at 93 °% and 18 °C warrants a
 * spray depends on the crop's phenological stage, what was last applied and how long
 * ago, the pre-harvest interval, whether the canopy was just opened up, and what the
 * forecast does next. None of that is in the event store. An alert that needs four
 * facts this engine does not hold, combined before anyone can act on it, is the
 * definition of a situation in `Routing` — so it goes to the agent route rather than
 * waking someone who would only have to go and look all of that up.
 *
 * Route `situation` to an agent destination and this arrives there automatically; see
 * the Routing section of the README.
 */

import { int, num, optNum, round } from '../params';
import { bandDwell, pathsLabel, resolvePaths, type Band } from '../measurement';
import { resolveScope, SCOPE_PARAMS } from '../scope';
import type { Finding, Rule } from '../types';

/** Human-readable band, for the summary line: "≥90%", "≤30%", "88–96%". */
function bandLabel(band: Band, unit: string): string {
  if (band.min !== null && band.max !== null) return `${band.min}–${band.max}${unit}`;
  if (band.min !== null) return `≥${band.min}${unit}`;
  return `≤${band.max}${unit}`;
}

/**
 * Candidate paths for an optional second measurement.
 *
 * `null` or `[]` means the gate is off. Anything else goes through the same resolver
 * as `paths`, so a gate can list alternatives the way every other path list does.
 */
function optionalPaths(params: Record<string, unknown>, key: string): string[][] | null {
  const raw = params[key];
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw) && raw.length === 0) return null;
  return resolvePaths(params, key);
}

const rule: Rule = {
  id: 'mold-risk',
  description:
    'Flags devices where humidity (or leaf wetness) stayed inside a band for an ' +
    'unbroken stretch of hours while temperature sat in the fungal growth range — ' +
    'the wetness-duration model behind botrytis on grapes and peacock spot on olives. ' +
    'Enable once per crop with a distinct "as" name and its own scope.',
  defaultSeverity: 'warning',
  /**
   * A situation, and deliberately the only measurement rule that is one: acting on it
   * needs the crop stage, the spray history and the forecast, none of which are in the
   * event store. See the header.
   */
  defaultRouting: 'situation',
  defaultParams: {
    /**
     * Priority-ordered candidate paths for the wetness measurement. `leaf.wetness`
     * first where the block has wetness sensors — but give it its own band, since a
     * wetness percentage is not a relative humidity.
     */
    paths: ['air.relativeHumidity'],
    /** Bottom of the humidity band. null opens it downward. */
    humidityMin: 90,
    /** Top of the humidity band. null opens it upward, which is the usual case. */
    humidityMax: null,
    /**
     * Candidate paths for the temperature gate. null or [] turns the gate off and
     * makes this a pure humidity-duration check — noisier, and much more likely to
     * fire on cold saturated nights that infect nothing.
     */
    temperaturePaths: ['air.temperature', 'temperature', 'leaf.temperature'],
    /** Bottom of the gate band, °C. Below it the spores are too cold to germinate. */
    temperatureMin: 15,
    /** Top of the gate band, °C. */
    temperatureMax: 25,
    /** Raise once an unbroken run reaches this many hours. */
    dwellHours: 6,
    /**
     * How far back to look. Also how long the alert stands after the run ends, since
     * the run ages out of the window rather than being cleared by anything.
     */
    lookbackHours: 24,
    /**
     * A reporting gap longer than this breaks the run. While a device is silent
     * nothing is known about the canopy, and bridging the gap would invent dwell out
     * of missing data. Set it to a small multiple of the fleet's uplink interval.
     */
    maxGapHours: 2,
    /** A run needs at least this many readings before its duration means anything. */
    minSamples: 4,
    /**
     * Hysteresis, in hours. An open alert stays open until the longest run falls this
     * far below `dwellHours`, so a run sitting on the boundary does not resolve and
     * re-raise — and re-invoke the agent — every sounding.
     */
    clearDwellHours: 2,
    /** Shown in the alert summary. The vocabulary unit for both humidity paths is %. */
    unit: '%',
    /** Narrow this check to part of the fleet — see src/scope.ts. */
    ...SCOPE_PARAMS,
  },
  requires: [
    { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
  ],

  async run(ctx): Promise<Finding[]> {
    const paths = resolvePaths(ctx.params, 'paths');
    const band: Band = {
      min: optNum(ctx.params, 'humidityMin'),
      max: optNum(ctx.params, 'humidityMax'),
    };
    const gatePaths = optionalPaths(ctx.params, 'temperaturePaths');
    const gateBand: Band = {
      min: optNum(ctx.params, 'temperatureMin'),
      max: optNum(ctx.params, 'temperatureMax'),
    };
    const dwellHours = num(ctx.params, 'dwellHours');
    const lookbackHours = int(ctx.params, 'lookbackHours');
    const maxGapHours = num(ctx.params, 'maxGapHours');
    const minSamples = int(ctx.params, 'minSamples');
    const clearDwellHours = optNum(ctx.params, 'clearDwellHours') ?? 0;
    const unit = typeof ctx.params.unit === 'string' ? ctx.params.unit : '';

    if (band.min === null && band.max === null) {
      throw new Error(
        'at least one of "humidityMin" or "humidityMax" must be set — with neither ' +
          'bound every reading is inside the band and this check would fire on the ' +
          'whole fleet',
      );
    }
    if (band.min !== null && band.max !== null && band.min > band.max) {
      throw new Error(`humidityMin (${band.min}) must not exceed humidityMax (${band.max})`);
    }
    // A gate with no bounds admits every reading that merely *has* a temperature,
    // which looks like a configured gate and behaves like none. Refuse rather than
    // let a deployment believe it is filtering cold nights when it is not.
    if (gatePaths && gateBand.min === null && gateBand.max === null) {
      throw new Error(
        'temperaturePaths is set but neither "temperatureMin" nor "temperatureMax" is — ' +
          'the gate would admit every reading. Set a bound, or set temperaturePaths to ' +
          'null to run without a gate',
      );
    }
    if (gateBand.min !== null && gateBand.max !== null && gateBand.min > gateBand.max) {
      throw new Error(
        `temperatureMin (${gateBand.min}) must not exceed temperatureMax (${gateBand.max})`,
      );
    }
    if (dwellHours <= 0) throw new Error('dwellHours must be positive');
    // A run cannot be longer than the window it is measured in, so this combination
    // can never fire — silently, and looking exactly like a healthy block.
    if (dwellHours >= lookbackHours) {
      throw new Error(
        `dwellHours (${dwellHours}) must be less than lookbackHours (${lookbackHours}) — ` +
          'a run cannot outlast the window it is measured in, so this check could ' +
          'never fire',
      );
    }
    if (maxGapHours <= 0) throw new Error('maxGapHours must be positive');
    if (clearDwellHours < 0) throw new Error('clearDwellHours must not be negative');
    if (clearDwellHours >= dwellHours) {
      throw new Error(
        `clearDwellHours (${clearDwellHours}) must be less than dwellHours (${dwellHours})`,
      );
    }

    const scope = resolveScope(ctx.params);
    const gate = gatePaths ? { paths: gatePaths, band: gateBand } : null;
    const rows = await bandDwell(ctx, paths, band, lookbackHours, maxGapHours, gate, scope);

    if (rows.length === 0) {
      ctx.log.debug('no device reports any candidate path', { paths: pathsLabel(paths) });
      return [];
    }

    // A device measuring humidity but never temperature contributes nothing while the
    // gate is on, and zero findings is indistinguishable from a healthy block. Say so.
    if (gate) {
      const blind = rows.filter((r) => r.gateSamples === 0).map((r) => r.devEui);
      if (blind.length > 0) {
        ctx.log.warn(
          'devices report humidity but no temperature on the same uplink — the gate ' +
            'excludes them entirely and they can never raise this check',
          { devices: blind.join(', '), temperaturePaths: pathsLabel(gate.paths) },
        );
      }
    }

    const humidityBand = bandLabel(band, unit);
    const findings: Finding[] = [];

    for (const r of rows) {
      if (r.samples < minSamples) continue;

      // Hold an open alert to a shorter run than it took to raise one — that is the
      // hysteresis. Without it a run oscillating around the boundary re-invokes the
      // agent every sounding.
      const required = ctx.openDevEuis.has(r.devEui) ? dwellHours - clearDwellHours : dwellHours;
      if (r.hours < required) continue;

      const name = r.deviceName ?? r.devEui;
      // The run is still accumulating when it reaches the device's latest reading.
      // Compared as instants, not as values: pg hands back timestamptz as a Date, so
      // `===` here would compare object identity and never be true.
      const ongoing =
        r.endedAt !== null &&
        new Date(r.endedAt).getTime() === new Date(r.lastSampleAt).getTime();
      const gateRange =
        gate && r.gateMin !== null && r.gateMax !== null
          ? ` at ${round(r.gateMin, 1)}–${round(r.gateMax, 1)}C`
          : '';

      findings.push({
        devEui: r.devEui,
        deviceName: r.deviceName,
        summary:
          `${name} ${r.matchedPath} held ${humidityBand} for ${round(r.hours, 1)}h` +
          `${gateRange} — ${ongoing ? 'ongoing' : 'ended'} mold infection window ` +
          `(raises at ${dwellHours}h)`,
        detail: {
          measurement: r.matchedPath,
          dwellHours: round(r.hours, 2),
          requiredHours: dwellHours,
          humidityBand,
          peak: r.max,
          mean: r.avg,
          temperatureRange:
            gate && r.gateMin !== null && r.gateMax !== null
              ? [round(r.gateMin, 1), round(r.gateMax, 1)]
              : null,
          ongoing,
          samples: r.samples,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
        },
      });
    }

    return findings;
  },
};

export default rule;
