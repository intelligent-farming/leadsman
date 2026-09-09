/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * host-restarted — the edge device came back up, and here is how long it was gone.
 *
 * Every other check in this engine reports something wrong with the fleet. This one
 * reports something that happened to the engine, and it exists because of a blind spot
 * with no other cure: while the host is down, Leadsman is down, and a rule engine that is
 * not running raises nothing. A six-hour power cut produces no alerts at all — not one —
 * and then the site comes back and carries on as though nothing happened. From the alert
 * history, an outage is indistinguishable from a quiet night.
 *
 * `pg_postmaster_start_time()` is the cheapest possible detector: one function, no
 * privileges, no extension, readable by the least-privileged role. On a single-box
 * deployment the event store restarting *is* the box restarting, so this doubles as a
 * power-cut and reboot alarm.
 *
 * The gap is the valuable part. The restart on its own says "something happened"; the
 * time since the last completed sounding says how much telemetry was never collected and
 * how long nothing was being watched, which is what decides whether anyone needs to walk
 * the field. A gap during a frost is a different conversation from a gap at midday in July.
 *
 * This is retrospective by construction, and that is its limit rather than a flaw to fix
 * here — it cannot warn during the outage, because it is not running during the outage.
 * That is what the heartbeat is for (src/heartbeat.ts): an external receiver noticing the
 * pings stopped is the only thing that can raise an alarm while the box is off. The two
 * are complements, and a deployment that cares about outages wants both.
 */

import { forDuration } from '../gateway';
import { int } from '../params';
import { engineSubject } from '../subject';
import type { Rule } from '../types';

const rule: Rule = {
  id: 'host-restarted',
  description:
    'Flags a recent restart of the event store — on a single-box deployment, of the edge ' +
    'device itself — and reports how long the engine was not running. The only check that ' +
    'makes a power cut visible after the fact.',
  defaultSeverity: 'warning',
  /**
   * A fact: it says what happened and for how long. Severity is warning rather than
   * critical because by the time anyone reads it the site is back — what matters is the
   * gap, not the present state.
   */
  defaultRouting: 'fact',
  defaultParams: {
    /**
     * Report a restart that happened within this long.
     *
     * This is the width of the alert's own window, not a threshold on the outage. It
     * needs to be comfortably longer than the sounding schedule so a restart cannot slip
     * between two soundings unreported, and short enough that the alert resolves by
     * itself once the restart is old news. At the default 15-minute schedule, 120
     * minutes survives several missed soundings while a site settles down after a reboot.
     */
    withinMinutes: 120,
    /**
     * Ignore a gap shorter than this.
     *
     * A container restart during an upgrade, or a compose recreate, restarts Postgres
     * and is not an incident. Only a gap long enough to have lost real telemetry is
     * worth a message; below this the restart is reported in the log and nowhere else.
     */
    minGapMinutes: 15,
  },
  /**
   * leadsman.run is schema-qualified, which is the reason `leadsman verify` learned to
   * resolve qualified names — a bare `run` would have been looked for in public, where
   * ChirpStack's tables live.
   */
  requires: [{ table: 'leadsman.run', columns: ['finished_at'] }],

  async run(ctx) {
    const withinMinutes = int(ctx.params, 'withinMinutes');
    const minGapMinutes = int(ctx.params, 'minGapMinutes');

    const startedAt = ctx.engine.postmasterStartTime;
    // Null means the query failed, not that nothing restarted. Reporting a restart on no
    // evidence would be worse than staying quiet.
    if (!startedAt) return [];

    const startedMs = Date.parse(startedAt);
    if (Number.isNaN(startedMs)) return [];

    const upMinutes = (Date.now() - startedMs) / 60_000;
    if (upMinutes > withinMinutes) return [];

    // The gap runs from the last completed sounding to the restart — not to now. Time
    // since the restart is time the engine has been back and working, and counting it as
    // downtime would overstate every outage by one sounding interval.
    const previous = ctx.engine.previousRunAt;
    const previousMs = previous === null ? null : Date.parse(previous);
    const gapMinutes =
      previousMs === null || Number.isNaN(previousMs)
        ? null
        : Math.max(0, (startedMs - previousMs) / 60_000);

    // A first run on a fresh install has no previous sounding and therefore no gap. That
    // is a new deployment, not an outage, and it should not open with an alert.
    if (gapMinutes === null) {
      ctx.log.info('event store restarted recently, no prior sounding to compare', {
        startedAt,
      });
      return [];
    }
    if (gapMinutes < minGapMinutes) {
      ctx.log.debug('event store restarted, gap below threshold', {
        startedAt,
        gapMinutes: Math.round(gapMinutes),
      });
      return [];
    }

    return [
      {
        subject: engineSubject(),
        summary:
          `edge device restarted ${forDuration(upMinutes)} ago — nothing was being ` +
          `monitored for ${forDuration(gapMinutes)} before that`,
        detail: {
          restartedAt: startedAt,
          upForMinutes: Math.round(upMinutes),
          lastSoundingBeforeRestart: previous,
          monitoringGapMinutes: Math.round(gapMinutes),
          thresholdMinutes: minGapMinutes,
          // Named because the pair explains itself: an outage this long with no
          // heartbeat configured is an outage nobody could have known about at the time.
          hostForwardAddress: ctx.engine.hostAddress,
        },
      },
    ];
  },
};

export default rule;
