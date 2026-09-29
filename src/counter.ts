/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Step-aware window statistics for monotonic counters.
 *
 * `windowStats` summarises a counter by its first and last reading, and `last - first`
 * is only a counter's advance when nothing happened in between. A meter that resets
 * mid-window breaks that: 1000 → 0 → 500 → 1100 → 1100.5 has `last - first` = +100.5,
 * which reads as healthy consumption and hides both the reset and the fact that the
 * meter has barely moved since. And 100 → 5000 → 0 → 200 has `last - first` = +100,
 * which hides a 4900-unit spike AND the reset that followed it. So the counter checks
 * need the individual steps, not the endpoints:
 *
 *   rise      the sum of every positive step. This is the reset-aware advance — the
 *             same convention as Prometheus's `increase()` — so a reset neither fakes
 *             an advance (the drop contributes nothing) nor masks one (consumption
 *             after the reset still counts). The cost of the convention: a single
 *             glitched low reading that recovers (1000 → 0 → 1000) counts its
 *             recovery as 1000 of advance. That case is a decrease too, so
 *             counter-stalled reports it by default rather than letting it pass.
 *   drops     how many steps went down.
 *   maxDrop   the largest single downward step, with the readings either side of it
 *             and the time of the lower one — "when did it reset" is the first thing
 *             an operator asks.
 *
 * The candidate-path resolution is the same as windowStats in measurement.ts —
 * lowest-ordinality path present anywhere in the window wins per device — and the
 * CANDIDATES / NUMERIC fragments are copies of the ones there. They are copied rather
 * than imported because measurement.ts does not export them; if either changes there,
 * change it here too, or the counter checks resolve a different path from every other
 * check pointed at the same device.
 */

import { ANY_DEVICE, scopeClause, type DeviceScope } from './scope';
import type { SoundingContext } from './types';

/** A counter's window, including the step structure `windowStats` flattens away. */
export interface CounterWindow {
  devEui: string;
  deviceName: string | null;
  matchedPath: string;
  first: number;
  last: number;
  samples: number;
  firstAt: string;
  lastAt: string;
  /** Sum of every positive step — the reset-aware advance. */
  rise: number;
  /** Number of steps that went down. */
  drops: number;
  /** Largest single downward step as a positive number; 0 when nothing went down. */
  maxDrop: number;
  /** Reading before and after the largest drop, and when the lower one arrived. */
  dropFrom: number | null;
  dropTo: number | null;
  dropAt: string | null;
}

// Mirrors measurement.ts — see the file comment.
const CANDIDATES = `
  candidates AS (
    SELECT ord, ARRAY(SELECT jsonb_array_elements_text(p)) AS path
      FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS t(p, ord)
  )`;
const NUMERIC = `~ '^-?[0-9]+(\\.[0-9]+)?$'`;

/**
 * Each device's counter over the window at its highest-priority path, step by step.
 *
 * Steps are consecutive readings in time order. Two readings with the same timestamp
 * are ordered by value so the result is deterministic rather than whatever the heap
 * returned — a duplicate uplink must not manufacture a drop and a rise.
 */
export async function counterWindows(
  ctx: SoundingContext,
  paths: string[][],
  lookbackHours: number,
  scope: DeviceScope = ANY_DEVICE,
): Promise<CounterWindow[]> {
  const sc = scopeClause(scope, 3, 'e');
  const rows = await ctx.query<{
    dev_eui: string;
    device_name: string | null;
    matched_path: string;
    vfirst: string;
    vlast: string;
    samples: string;
    first_at: string;
    last_at: string;
    rise: string | null;
    drops: string;
    max_drop: string | null;
    drop_from: string | null;
    drop_to: string | null;
    drop_at: string | null;
  }>(
    `WITH ${CANDIDATES},
     window_rows AS (
       SELECT e.dev_eui,
              e.device_name,
              e.time,
              c.ord,
              array_to_string(c.path, '.') AS matched_path,
              (e.object #>> c.path)::numeric AS value
         FROM event_up e
         CROSS JOIN candidates c
        WHERE e.time > now() - make_interval(secs => $2::float8 * 3600)
          AND e.object IS NOT NULL
          AND e.object #>> c.path IS NOT NULL
          AND e.object #>> c.path ${NUMERIC}
          ${sc.sql}
     ),
     winner AS (
       SELECT DISTINCT ON (dev_eui) dev_eui, ord
         FROM window_rows
        ORDER BY dev_eui, ord
     ),
     steps AS (
       SELECT w.dev_eui, w.device_name, w.matched_path, w.time, w.value,
              lag(w.value) OVER (PARTITION BY w.dev_eui ORDER BY w.time, w.value) AS prev
         FROM window_rows w
         JOIN winner ON winner.dev_eui = w.dev_eui AND winner.ord = w.ord
     ),
     -- The single largest drop per device. Ties go to the earliest, which is the
     -- moment the series first became untrustworthy.
     worst_drop AS (
       SELECT DISTINCT ON (dev_eui) dev_eui,
              prev - value AS max_drop, prev AS drop_from, value AS drop_to, time AS drop_at
         FROM steps
        WHERE prev IS NOT NULL AND value < prev
        ORDER BY dev_eui, prev - value DESC, time
     )
     SELECT s.dev_eui,
            max(s.device_name)                                      AS device_name,
            max(s.matched_path)                                     AS matched_path,
            (array_agg(s.value ORDER BY s.time ASC, s.value ASC))[1]   AS vfirst,
            (array_agg(s.value ORDER BY s.time DESC, s.value DESC))[1] AS vlast,
            count(*)                                                AS samples,
            min(s.time)                                             AS first_at,
            max(s.time)                                             AS last_at,
            coalesce(sum(s.value - s.prev) FILTER (WHERE s.value > s.prev), 0) AS rise,
            count(*) FILTER (WHERE s.value < s.prev)                AS drops,
            max(d.max_drop)                                         AS max_drop,
            max(d.drop_from)                                        AS drop_from,
            max(d.drop_to)                                          AS drop_to,
            max(d.drop_at)                                          AS drop_at
       FROM steps s
       LEFT JOIN worst_drop d ON d.dev_eui = s.dev_eui
      GROUP BY s.dev_eui`,
    [JSON.stringify(paths), lookbackHours, ...sc.values],
  );

  const opt = (v: string | null) => (v === null || v === undefined ? null : Number(v));
  return rows.map((r) => ({
    devEui: r.dev_eui,
    deviceName: r.device_name,
    matchedPath: r.matched_path,
    first: Number(r.vfirst),
    last: Number(r.vlast),
    samples: Number(r.samples),
    firstAt: r.first_at,
    lastAt: r.last_at,
    rise: Number(r.rise ?? 0),
    drops: Number(r.drops),
    maxDrop: Number(r.max_drop ?? 0),
    dropFrom: opt(r.drop_from),
    dropTo: opt(r.drop_to),
    dropAt: r.drop_at ?? null,
  }));
}
