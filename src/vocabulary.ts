/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Physically valid ranges for the normalized vocabulary.
 *
 * GENERATED — do not hand-edit. The source of truth is
 * `definitions/vocabulary.schema.json` in @intelligent-farming/lorawan-codec-normalization
 * (snapshot of v0.2.2), which carries an explicit `minimum`/`maximum` (or
 * `exclusiveMinimum`/`exclusiveMaximum`) on 73 numeric leaves. Regenerate
 * with `npm run vocabulary:sync`.
 *
 * ## Why this is vendored rather than imported
 *
 * Leadsman's whole dependency tree is `pg` + `croner`, and that is a property worth
 * keeping in something meant to run unattended on an edge device for years. These are
 * 73 pairs of constants describing physics, not code: relative humidity has been a
 * percentage the whole time, and pH has been 0-14 since 1909. The cost of a stale copy
 * is a bound that is slightly generous; the cost of a dependency is a supply chain.
 *
 * ## What these bounds are NOT
 *
 * They are not agronomic limits. `soil.moisture` can be 0-100 % and still be a disaster
 * at 4 %. A value outside these bounds means the SENSOR or the CODEC is wrong — a
 * detached probe reading -40 % moisture, a byte-order bug turning 21.5 °C into 5504 °C,
 * a scaling error putting pH at 71. That is a data-integrity fault rather than a field
 * condition, which is why `measurement-implausible` reports it as one.
 *
 * A one-sided bound is still worth having: nothing measures a negative wind speed, a
 * negative humidity or a battery below zero volts, and each is a real failure signature.
 */

/** Which side of a range is exclusive. Absent or false means inclusive. */
export interface RangeExclusivity {
  readonly min?: boolean;
  readonly max?: boolean;
}

/**
 * `[minimum, maximum, exclusive?]`; `null` on either side means unbounded there.
 * Bounds are inclusive unless the third element marks a side exclusive — the schema's
 * `exclusiveMaximum: 360` on `wind.direction` is `[0, 360, { max: true }]`, since
 * 360 degrees is 0 and a codec emitting it has not wrapped.
 */
export type VocabularyRange = readonly [
  min: number | null,
  max: number | null,
  exclusive?: RangeExclusivity,
];

/** Dotted vocabulary path to its physically valid range. */
export const VOCABULARY_RANGES: ReadonlyMap<string, VocabularyRange> = new Map<
  string,
  VocabularyRange
>([
  ['action.button.count', [0, null]],
  ['action.motion.count', [0, null]],
  ['action.occupancy.duration', [0, null]],
  ['air.co2', [0, 1000000]],
  ['air.iaqIndex', [0, 500]],
  ['air.lightIntensity', [0, null]],
  ['air.par', [0, null]],
  ['air.pm10', [0, null]],
  ['air.pm1_0', [0, null]],
  ['air.pm2_5', [0, null]],
  ['air.pressure', [300, 1100]],
  ['air.relativeHumidity', [0, 100]],
  ['air.solarIrradiance', [0, null]],
  ['air.temperature', [-273.15, null]],
  ['air.tvoc', [0, null]],
  ['analog.current', [0, null]],
  ['analog.ratio', [0, 100]],
  ['battery', [0, null]],
  ['device.runtime', [0, null]],
  ['hvac.setpoint', [-273.15, null]],
  ['hvac.valvePosition', [0, 100]],
  ['leaf.temperature', [-273.15, null]],
  ['leaf.wetness', [0, 100]],
  ['linear.position', [0, 100]],
  ['metering.energy.total', [0, null]],
  ['metering.water.total', [0, null]],
  ['people.in', [0, null]],
  ['people.out', [0, null]],
  ['people.present', [0, null]],
  ['position.latitude', [-90, 90]],
  ['position.longitude', [-180, 180]],
  ['power.apparent', [0, null]],
  ['power.current', [0, null]],
  ['power.factor', [-1, 1]],
  ['power.frequency', [0, null]],
  ['power.voltage', [0, null]],
  ['pressure.absolute', [0, null]],
  ['pulse.count', [0, null]],
  ['pulse.total', [0, null]],
  ['rain.cumulative', [0, null]],
  ['rain.intensity', [0, null]],
  ['soil.depth', [0, null]],
  ['soil.ec', [0, 621]],
  ['soil.k', [0, 1000000]],
  ['soil.moisture', [0, 100]],
  ['soil.n', [0, 1000000]],
  ['soil.p', [0, 1000000]],
  ['soil.pH', [0, 14]],
  ['soil.temperature', [-273.15, null]],
  ['tank.distance', [0, null]],
  ['tank.level', [0, 100]],
  ['tank.volume', [0, null]],
  ['temperature', [-273.15, null]],
  ['vibration.accelerationPeak', [0, null]],
  ['vibration.accelerationRms', [0, null]],
  ['vibration.peakFrequency', [0, null]],
  ['vibration.velocityRms', [0, null]],
  ['vibration.velocityX', [0, null]],
  ['vibration.velocityY', [0, null]],
  ['vibration.velocityZ', [0, null]],
  ['water.dissolvedOxygen', [0, null]],
  ['water.ec', [0, null]],
  ['water.level', [0, null]],
  ['water.ph', [0, 14]],
  ['water.pressure', [0, null]],
  ['water.residualChlorine', [0, null]],
  ['water.temperature.avg', [-273.15, null]],
  ['water.temperature.current', [-273.15, null]],
  ['water.temperature.max', [-273.15, null]],
  ['water.temperature.min', [-273.15, null]],
  ['water.turbidity', [0, null]],
  ['wind.direction', [0, 360, { max: true }]],
  ['wind.speed', [0, null]],
]);

/** Every path that carries a declared range, in a stable order. */
export const RANGED_PATHS: readonly string[] = [...VOCABULARY_RANGES.keys()];
