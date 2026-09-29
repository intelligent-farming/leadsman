/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * measurement-implausible — a reading physics does not permit.
 *
 * This is a data-integrity check wearing a measurement check's clothes, and it belongs
 * in the same family as `decode-failure` and `measurement-stuck`: it reports a device
 * that looks completely healthy to everything else while producing numbers that cannot
 * be used for anything.
 *
 *   - a detached soil probe reading -40 % volumetric water content
 *   - a byte-order bug turning 21.5 °C into 5504 °C
 *   - a scaling error putting pH at 71, or humidity at 6300 %
 *   - a sign error on a differential pressure sensor
 *
 * None of those fire a threshold, because a threshold is tuned for agronomy and these
 * are three orders of magnitude outside it — a frost check with `min: 1.5` is silent
 * at -40 °C only because nobody thought to set a floor, and a soil-moisture-low check
 * at 15 % reads -40 % as "very dry" and alerts for the wrong reason with the wrong
 * remedy. Worse, the bad value flows into every average, every trend and every
 * accumulation downstream.
 *
 * ## Zero configuration, whole fleet
 *
 * The bounds are not supplied by the operator; they come from the normalized
 * vocabulary's own schema — 73 paths with an explicit physical range, vendored in
 * src/vocabulary.ts. One config entry covers every path on every device, and there is
 * nothing to tune, because nothing here is a judgement call: relative humidity has
 * been a percentage the whole time.
 *
 * That is what makes it worth enabling on day one alongside `decode-failure`. It
 * protects the trustworthiness of every other check rather than measuring anything.
 *
 * ## Not an agronomic limit
 *
 * `soil.moisture` may be 0-100 % and still be a disaster at 4 %. A breach here means
 * the SENSOR or the CODEC is wrong, so the alert names a device to fix rather than a
 * field condition to act on — and the severity is the operator's data pipeline, not
 * their crop.
 */

import { int, round } from '../params';
import { resolveScope, SCOPE_PARAMS, scopeClause } from '../scope';
import { VOCABULARY_RANGES } from '../vocabulary';
import type { Finding, Rule } from '../types';

const rule: Rule = {
  id: 'measurement-implausible',
  description:
    'Flags devices reporting a value outside the physically valid range the normalized ' +
    'vocabulary declares for that path — negative humidity, pH above 14, a temperature ' +
    'below absolute zero. Needs no configuration: the bounds come from the schema.',
  defaultSeverity: 'warning',
  /**
   * A fact about the data pipeline. The summary names the path, the value and the
   * bound, and the remedy is always the same shape: fix the sensor or the codec.
   */
  defaultRouting: 'fact',
  defaultParams: {
    /** How far back to look. */
    lookbackHours: 24,
    /**
     * Ignore a device until this many of its readings are out of range in the window.
     * One impossible reading is a corrupted transmission; a run of them is a fault.
     */
    minBreaches: 3,
    /**
     * Paths to exempt, for the rare deployment whose codec legitimately emits outside
     * the declared range — a differential pressure sensor wired to read negative, say.
     * Exempting a path here is a statement that the schema is wrong for this fleet.
     */
    ignorePaths: [] as string[],
    /** Narrow this check to part of the fleet — see src/scope.ts. */
    ...SCOPE_PARAMS,
  },
  requires: [
    { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
  ],

  async run(ctx): Promise<Finding[]> {
    const lookbackHours = int(ctx.params, 'lookbackHours');
    const minBreaches = int(ctx.params, 'minBreaches');

    const rawIgnore = ctx.params.ignorePaths;
    if (rawIgnore !== undefined && rawIgnore !== null && !Array.isArray(rawIgnore)) {
      throw new Error('ignorePaths must be an array of dotted path strings');
    }
    const ignore = new Set((Array.isArray(rawIgnore) ? rawIgnore : []).map(String));
    if (minBreaches < 1) throw new Error('minBreaches must be at least 1');
    if (lookbackHours <= 0) {
      throw new Error(
        'lookbackHours must be positive — an empty window holds no readings, so this ' +
          'check could never fire',
      );
    }

    // The bounds table becomes a JSONB parameter and the comparison happens in SQL, so
    // the engine never pulls a window of raw telemetry across the wire to filter it in
    // TypeScript. 73 paths is a small enough literal to send every sounding.
    const bounds = [...VOCABULARY_RANGES.entries()]
      .filter(([path]) => !ignore.has(path))
      .map(([path, [min, max, exclusive]]) => ({
        path: path.split('.'),
        label: path,
        min,
        max,
        // Exclusive sides from the schema: wind.direction is [0, 360) — 360 degrees is
        // 0, and a codec emitting it has failed to wrap.
        minExclusive: exclusive?.min === true,
        maxExclusive: exclusive?.max === true,
      }));

    if (bounds.length === 0) {
      throw new Error('every known path is in ignorePaths — this check cannot fire');
    }

    const scope = resolveScope(ctx.params);
    // $1 bounds, $2 lookbackHours, $3 minBreaches — the scope pair starts at $4.
    const sc = scopeClause(scope, 4, 'e');

    const rows = await ctx.query<{
      dev_eui: string;
      device_name: string | null;
      label: string;
      breaches: string;
      worst: string;
      lo: string | null;
      hi: string | null;
      lo_excl: boolean;
      hi_excl: boolean;
      last_at: string;
    }>(
      `WITH bounds AS (
         SELECT ARRAY(SELECT jsonb_array_elements_text(b->'path')) AS path,
                b->>'label'                                        AS label,
                (b->>'min')::numeric                               AS lo,
                (b->>'max')::numeric                               AS hi,
                (b->>'minExclusive')::boolean                      AS lo_excl,
                (b->>'maxExclusive')::boolean                      AS hi_excl
           FROM jsonb_array_elements($1::jsonb) AS t(b)
       ),
       breached AS (
         SELECT e.dev_eui,
                e.device_name,
                b.label,
                b.lo,
                b.hi,
                b.lo_excl,
                b.hi_excl,
                (e.object #>> b.path)::numeric AS value,
                e.time
           FROM event_up e
           CROSS JOIN bounds b
          WHERE e.time > now() - make_interval(secs => $2::float8 * 3600)
            AND e.object IS NOT NULL
            AND e.object #>> b.path IS NOT NULL
            -- The same numeric guard the resolvers use: a codec emitting "3.7V" where
            -- a number belongs is decode-failure's problem, not this check's.
            AND e.object #>> b.path ~ '^-?[0-9]+(\\.[0-9]+)?$'
            -- An exclusive side also rejects the bound itself.
            AND (   (b.lo IS NOT NULL AND ((e.object #>> b.path)::numeric < b.lo
                       OR (b.lo_excl AND (e.object #>> b.path)::numeric = b.lo)))
                 OR (b.hi IS NOT NULL AND ((e.object #>> b.path)::numeric > b.hi
                       OR (b.hi_excl AND (e.object #>> b.path)::numeric = b.hi))))
            ${sc.sql}
       )
       SELECT dev_eui,
              max(device_name) AS device_name,
              label,
              count(*)         AS breaches,
              lo, hi, lo_excl, hi_excl,
              -- The reading furthest outside the bound, which is the one worth showing:
              -- it is the most diagnostic of what kind of fault this is.
              (array_agg(value ORDER BY
                 greatest(COALESCE(lo - value, 0), COALESCE(value - hi, 0)) DESC))[1] AS worst,
              max(time) AS last_at
         FROM breached
        GROUP BY dev_eui, label, lo, hi, lo_excl, hi_excl
       HAVING count(*) >= $3::int
        ORDER BY dev_eui, label`,
      [JSON.stringify(bounds), lookbackHours, minBreaches, ...sc.values],
    );

    // One finding per device, not per path: a probe whose codec scaling is wrong
    // usually breaks several paths at once, and five alerts naming one broken sensor
    // is the storm this engine exists to avoid.
    const byDevice = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byDevice.get(r.dev_eui) ?? [];
      list.push(r);
      byDevice.set(r.dev_eui, list);
    }

    const findings: Finding[] = [];
    for (const [devEui, breaches] of byDevice) {
      const deviceName = breaches[0].device_name;
      const name = deviceName ?? devEui;
      const worst = breaches[0];
      const others = breaches.length - 1;

      // Below (or, for an exclusive minimum, at) the lower bound means the min broke;
      // anything else in this list broke the max.
      const lo = worst.lo === null ? null : Number(worst.lo);
      const brokeMin =
        lo !== null && (Number(worst.worst) < lo || (worst.lo_excl && Number(worst.worst) === lo));
      const bound = brokeMin
        ? `min ${worst.lo}${worst.lo_excl ? ', exclusive' : ''}`
        : `max ${worst.hi}${worst.hi_excl ? ', exclusive' : ''}`;

      findings.push({
        devEui,
        deviceName,
        summary:
          `${name} ${worst.label} = ${round(Number(worst.worst), 2)} is outside the ` +
          `physically valid range (${bound})` +
          (others > 0 ? ` — and ${others} other path${others > 1 ? 's' : ''}` : ''),
        detail: {
          paths: breaches.map((b) => ({
            measurement: b.label,
            worstValue: round(Number(b.worst), 3),
            min: b.lo === null ? null : Number(b.lo),
            max: b.hi === null ? null : Number(b.hi),
            minExclusive: b.lo_excl,
            maxExclusive: b.hi_excl,
            breaches: Number(b.breaches),
          })),
          lookbackHours,
          // Says out loud what this alert is and is not, because "humidity is 6300 %"
          // otherwise reads like a weather event to anything skimming the summary.
          fault: 'sensor or codec — not a field condition',
          lastAt: worst.last_at,
        },
      });
    }

    return findings;
  },
};

export default rule;
