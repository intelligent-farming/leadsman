/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * device-log-error — ChirpStack itself is reporting errors about the device.
 *
 * Every other check in this engine *infers* trouble from telemetry. This one reads what
 * the network server explicitly wrote down. ChirpStack's PostgreSQL integration logs
 * device-level problems to `event_log`: codec failures, MIC errors, frame-counter
 * resets, OTAA failures, downlink payloads too large for the data rate.
 *
 * That matters most for the case `decode-failure` can only see sideways. When a
 * normalized codec cannot parse a payload it returns `{errors: [...]}` with no `data`
 * key, so ChirpStack has nothing to store in `event_up.object` — the failure is
 * recorded here instead, with a human-readable reason. Inferring "no data" from a NULL
 * object tells you something is wrong; this tells you *what*.
 *
 * ── on level and code ───────────────────────────────────────────────────────────
 * ChirpStack's integration stores both as the *text* of a numeric enum: level is
 * '0' INFO, '1' WARNING, '2' ERROR. Codes enumerate the failure kind.
 *
 * The check filters on `level` rather than on a code allowlist, deliberately. Code
 * numbering is a ChirpStack implementation detail that can grow between versions, and a
 * check that only recognised the codes known when it was written would silently ignore
 * new failure modes. Filtering by severity and putting `description` in the alert means
 * a code this engine has never heard of still reaches a human with its own explanation.
 *
 * `excludeCodes` defaults to '7' (frame-counter retransmission). On a real store both
 * healthy devices produced nothing *but* code 7 — normal LoRaWAN behaviour when an ack
 * is lost and the device repeats a frame. Alerting on it would fire constantly, which is
 * how operators learn to ignore alerts.
 */

import { int, round } from '../params';
import { resolveScope, scopeClause, SCOPE_PARAMS } from '../scope';
import type { Rule } from '../types';

interface Row {
  dev_eui: string;
  device_name: string | null;
  events: string;
  worst_level: string;
  codes: string;
  latest_description: string | null;
  latest_at: string;
}

const rule: Rule = {
  id: 'device-log-error',
  description:
    "Flags devices ChirpStack has logged errors about in event_log — codec failures, " +
    'MIC errors, OTAA failures, frame-counter resets. The only check that reads the ' +
    "network server's own diagnosis rather than inferring from telemetry.",
  defaultSeverity: 'warning',
  defaultParams: {
    /** Window to examine. */
    lookbackHours: 24,
    /**
     * Minimum numeric level to alert on: 0 INFO, 1 WARNING, 2 ERROR. Default 2, so only
     * genuine errors fire. Drop to 1 to include warnings once the noisy codes below are
     * tuned for your fleet.
     */
    minLevel: 2,
    /** Need at least this many qualifying entries before alerting. */
    minEvents: 3,
    /**
     * Codes to ignore, as text. '7' is frame-counter retransmission — normal LoRaWAN
     * behaviour when an ack is lost, and on a real store the only thing healthy devices
     * ever logged.
     */
    excludeCodes: ['7'],
    /** Narrow this check to part of the fleet — see src/scope.ts. */
    ...SCOPE_PARAMS,
  },
  requires: [
    {
      table: 'event_log',
      columns: ['dev_eui', 'device_name', 'time', 'level', 'code', 'description'],
    },
  ],

  async run(ctx) {
    const lookbackHours = int(ctx.params, 'lookbackHours');
    const minLevel = int(ctx.params, 'minLevel');
    const minEvents = int(ctx.params, 'minEvents');

    const rawExclude = ctx.params.excludeCodes;
    if (rawExclude !== null && rawExclude !== undefined && !Array.isArray(rawExclude)) {
      throw new Error('excludeCodes must be an array of strings (or null)');
    }
    const excludeCodes = Array.isArray(rawExclude) ? rawExclude.map((c) => String(c)) : [];

    if (minLevel < 0) throw new Error('minLevel must not be negative');

    const sc = scopeClause(resolveScope(ctx.params), 5);

    // `level` and `code` are text holding numeric enum values, so the comparison needs
    // a cast — guarded by a regex, because a ChirpStack version writing a symbolic name
    // instead of a number must not abort the sounding.
    const rows = await ctx.query<Row>(
      `SELECT dev_eui,
              max(device_name)                                      AS device_name,
              count(*)                                              AS events,
              max(level::int)                                       AS worst_level,
              string_agg(DISTINCT code, ',' ORDER BY code)           AS codes,
              (array_agg(description ORDER BY time DESC))[1]         AS latest_description,
              max(time)                                             AS latest_at
         FROM event_log
        WHERE time > now() - make_interval(hours => $1::int)
          AND level ~ '^[0-9]+$'
          AND level::int >= $2::int
          AND NOT (code = ANY($4::text[]))
          ${sc.sql}
        GROUP BY dev_eui
       HAVING count(*) >= $3::int
        ORDER BY max(level::int) DESC, count(*) DESC`,
      [lookbackHours, minLevel, minEvents, excludeCodes, ...sc.values],
    );

    return rows.map((row) => {
      const events = Number(row.events);
      const worst = Number(row.worst_level);
      const name = row.device_name ?? row.dev_eui;
      // The description is the payload here — it is ChirpStack's own words for what
      // went wrong, and the only part that survives a code this engine has not seen.
      const reason = row.latest_description
        ? `: ${row.latest_description.slice(0, 160)}`
        : '';
      // Level 2 is ChirpStack's ERROR; 1 is WARNING. Calling a warning an error
      // overstates it, and an operator who checks will trust the next alert less.
      const noun = worst >= 2 ? 'error' : 'warning';

      return {
        devEui: row.dev_eui,
        deviceName: row.device_name,
        summary:
          `${name}: ${events} ChirpStack ${noun}${events === 1 ? '' : 's'} in ` +
          `${lookbackHours}h (code${row.codes.includes(',') ? 's' : ''} ${row.codes})${reason}`,
        // Level 2 is ChirpStack's ERROR; anything above is more serious still.
        severity: worst >= 2 ? 'critical' : undefined,
        detail: {
          events,
          worstLevel: worst,
          codes: row.codes.split(','),
          latestDescription: row.latest_description,
          latestAt: row.latest_at,
          lookbackHours,
          minLevel,
          excludedCodes: excludeCodes,
          eventsPerHour: round(events / lookbackHours, 2),
        },
      };
    });
  },
};

export default rule;
