/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Hold back alerts that a higher-level alert already explains.
 *
 * One fault reports itself at several levels at once. A gateway that stops forwarding
 * makes every device behind it look silent, so `fleet-silent` and forty `device-silent`
 * alerts are all simultaneously true — but only the first is a fault. The other forty each
 * name a sensor that is working perfectly, and delivering them buries the one alert that
 * identifies the actual problem under thirty-nine that misdiagnose it.
 *
 * Three properties make this safe enough to be on by default:
 *
 *   - Nothing is dropped. A muted alert is raised, stored, visible in `leadsman status`
 *     and `leadsman.open_alert`, and carries `detail.suppressedBy` naming what withheld
 *     it. The only thing withheld is the push.
 *   - Nothing is muted forever. Suppression is re-evaluated every sounding against what
 *     is open *now*, so it lifts the moment its cause resolves.
 *   - Release delivers. An alert still open when its suppressor resolves becomes
 *     deliverable and goes out — so a node that really is dead is reported once the
 *     gateway is back, rather than lost because it was inconvenient at the time.
 *
 * That last property is the whole reason delivery reads the pending set rather than only
 * freshly-raised alerts. See Store.listPendingNotify.
 */

import type { Store } from './db';
import type { CheckConfig, Logger, SuppressRule } from './types';

/** How a check's kind maps back to the rule behind it, for `mute` matching. */
export type RuleOfKind = ReadonlyMap<string, string>;

/**
 * Which kinds are currently muted, and by what.
 *
 * `mute` entries match a check's kind *or* its rule id. Rule id is usually what an
 * operator means: a config commonly runs a dozen `measurement-missing` instances under
 * names like `soil-moisture-missing`, and naming the rule covers all of them without
 * listing each.
 */
export function activeSuppressions(
  rules: SuppressRule[] | undefined,
  openKinds: ReadonlySet<string>,
  ruleOfKind: RuleOfKind,
): Map<string, string> {
  const muted = new Map<string, string>();
  if (!rules || rules.length === 0) return muted;

  for (const entry of rules) {
    if (entry.enabled === false) continue;

    // Whichever of the `while` kinds is actually open is the one worth naming in the
    // suppressed alert — "suppressedBy: fleet-silent" is the explanation a reader wants.
    const cause = entry.while.find((k) => openKinds.has(k));
    if (!cause) continue;

    for (const kind of ruleOfKind.keys()) {
      // Never let a suppression mute the alert that caused it, however the config is
      // written. An entry naming the same kind in both lists would otherwise silence the
      // one alert that explains everything else.
      if (entry.while.includes(kind)) continue;
      const ruleId = ruleOfKind.get(kind);
      if (entry.mute.includes(kind) || (ruleId !== undefined && entry.mute.includes(ruleId))) {
        if (!muted.has(kind)) muted.set(kind, cause);
      }
    }
  }

  return muted;
}

/**
 * Bring stored suppression state in line with what is open now, and report what is
 * currently muted.
 *
 * Runs after every check has reconciled and before delivery, because both directions
 * depend on the final open set: a `fleet-silent` raised this sounding must mute the
 * `device-silent` alerts raised in the same sounding, and one that resolved this sounding
 * must release them.
 */
export async function applySuppression(
  store: Store,
  suppressRules: SuppressRule[] | undefined,
  checks: CheckConfig[],
  log: Logger,
): Promise<{ suppressed: number; released: number }> {
  const ruleOfKind: Map<string, string> = new Map();
  for (const c of checks) ruleOfKind.set(c.as ?? c.rule, c.rule);

  const openKinds = await store.openKinds();
  const muted = activeSuppressions(suppressRules, openKinds, ruleOfKind);

  // Release first: an alert whose cause has resolved should be deliverable in this same
  // sounding, not the next one.
  let released = 0;
  for (const row of await store.listSuppressed()) {
    if (muted.has(row.kind)) continue;
    await store.setSuppressed(row.id, null);
    released += 1;
  }
  if (released > 0) {
    log.info('suppression lifted — alerts still open are now deliverable', { released });
  }

  let suppressed = 0;
  if (muted.size > 0) {
    // Only the undelivered ones. An alert already pushed cannot be un-pushed, and
    // marking it suppressed afterwards would misrepresent what happened.
    for (const alert of await store.listPendingNotify(1_000)) {
      const cause = muted.get(alert.kind);
      if (!cause) continue;
      await store.setSuppressed(alert.id, cause);
      suppressed += 1;
    }
    if (suppressed > 0) {
      log.info('alerts recorded but withheld — a higher-level alert already explains them', {
        suppressed,
        by: [...new Set(muted.values())].join(', '),
      });
    }
  }

  return { suppressed, released };
}
