/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * The sounding loop: run the enabled checks, reconcile their findings into alerts,
 * decide what a reader actually needs to be told, and deliver that.
 *
 * Checks run sequentially, not in parallel. This is deliberate — the target is a
 * small edge device sharing CPU and memory bandwidth with ChirpStack's ingestion,
 * and a fan-out of concurrent aggregate queries is exactly how a monitoring tool
 * starts degrading the thing it monitors. Soundings are not latency-critical.
 *
 * Order matters at the end of a sounding. Suppression runs after every check has
 * reconciled, because it can only be judged against the final open set — a
 * `fleet-silent` raised in this pass must mute the `device-silent` alerts raised in the
 * same pass, and one that resolved in this pass must release them. Delivery then reads
 * the pending set rather than a list of what was just raised, which is what lets a
 * released alert go out and a failed delivery be retried at all.
 */

import { gatewaySource, resolveConnection } from './chirpstack';
import { Store, type RaisedAlert } from './db';
import { heartbeatSecretFromEnv, sendHeartbeat } from './heartbeat';
import { resolveHostAddress } from './host';
import { notifyRaised, type AlertRoute } from './notify';
import { subjectOf } from './subject';
import { applySuppression } from './suppress';
import { version } from './version';
import type {
  CheckResult,
  CheckState,
  EngineFacts,
  GatewaySource,
  LeadsmanConfig,
  Logger,
  Rule,
  SoundingContext,
} from './types';

export interface SoundingSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  results: CheckResult[];
  raised: number;
  resolved: number;
  errors: number;
  delivered: number;
  /**
   * Deliveries that failed, and alerts that resolved to no destination.
   *
   * These were previously discarded, which made a TOTAL delivery failure — a wrong Twilio
   * token, an unreachable webhook — read as `delivered=0 errors=0`: indistinguishable from
   * having nothing to send. `errors` counts failed CHECKS, not failed sends, so it stayed
   * zero too. Surfacing them means the summary line alone tells you delivery is broken.
   */
  deliveryFailed: number;
  unrouted: number;
  /** Alerts recorded but deliberately withheld — see src/suppress.ts. */
  suppressed: number;
  /** Alerts whose suppression lifted this sounding, making them deliverable again. */
  released: number;
  /** Whether the liveness ping went out, when one is configured. */
  heartbeat?: 'sent' | 'failed';
}

export interface RunSoundingOptions {
  config: LeadsmanConfig;
  rules: Map<string, Rule>;
  store: Store;
  log: Logger;
  /** Evaluate and report without writing alerts or notifying. */
  dryRun?: boolean;
}

/** One pass over every enabled check. */
export async function runSounding(options: RunSoundingOptions): Promise<SoundingSummary> {
  const { config, rules, store, log, dryRun = false } = options;

  const startedAt = new Date();
  const results: CheckResult[] = [];
  const allRaised: RaisedAlert[] = [];
  const routes = new Map<string, AlertRoute>();

  // Routes for EVERY configured check, not only the ones about to run. Delivery works
  // from the pending set, which can contain an alert raised by a check that has since
  // been disabled, or one released from suppression this sounding — both would resolve
  // to no destination if this map only covered checks that ran in this pass.
  for (const check of config.checks) {
    const rule = rules.get(check.rule);
    if (!rule) continue;
    routes.set(check.as ?? check.rule, {
      notifyTo: check.notifyTo,
      routing: rule.defaultRouting,
    });
  }

  const enabled = config.checks.filter((c) => c.enabled);
  log.info('sounding started', { checks: enabled.length, dryRun });

  // ── engine facts and the gateway source, gathered once ──────────────────────
  // Once per sounding rather than once per check: several gateway checks run in the same
  // pass, and there is no reason for each to re-ask the network server or re-read the
  // same file. Failures here are not fatal — a check that needs something missing is
  // skipped below, which reads very differently from a check that ran and found nothing.
  const engine = await gatherEngineFacts(config, store, log);
  const { gateways, chirpstackMissing } = buildGatewaySource(config, log);

  for (const check of enabled) {
    const kind = check.as ?? check.rule;
    const checkLog = log.child ? log.child({ check: kind }) : log;
    const rule = rules.get(check.rule);
    const checkStart = new Date();

    if (!rule) {
      const result: CheckResult = {
        ruleId: check.rule,
        kind,
        status: 'error',
        findings: 0,
        raised: 0,
        resolved: 0,
        durationMs: 0,
        error: `unknown rule "${check.rule}" — run "leadsman list" to see available checks`,
      };
      results.push(result);
      checkLog.error('check skipped', { error: result.error });
      if (!dryRun) await store.recordRun(result, checkStart);
      continue;
    }

    // A check whose prerequisites are not configured is skipped, not run. Running it
    // would return no findings, which is indistinguishable from a healthy fleet — the
    // precise confusion this whole area of the engine exists to remove.
    const unmet = unmetNeeds(rule, { gateways, hostAddress: engine.hostAddress });
    if (unmet) {
      const result: CheckResult = {
        ruleId: rule.id,
        kind,
        status: 'skipped',
        findings: 0,
        raised: 0,
        resolved: 0,
        durationMs: 0,
      };
      results.push(result);
      checkLog.warn('check skipped — not configured', {
        needs: unmet,
        reason: unmet === 'chirpstack' ? chirpstackMissing ?? 'no chirpstack block' : 'no host address source',
      });
      if (!dryRun) await store.recordRun(result, checkStart);
      continue;
    }

    const began = process.hrtime.bigint();
    try {
      const open = dryRun ? new Set<string>() : await store.openSubjects(kind);
      const ctx: SoundingContext = {
        query: (sql, values) => store.query(sql, values),
        params: { ...rule.defaultParams, ...(check.params ?? {}) },
        // The same set under both names: for a device check the subject ids *are* the
        // DevEUIs, so every existing hysteresis rule keeps working unchanged.
        openDevEuis: open,
        openSubjects: open,
        kind,
        now: checkStart,
        gateways,
        engine,
        state: checkState(store, kind, dryRun),
        log: checkLog,
      };

      const findings = await rule.run(ctx);

      // Guard against a check returning junk — an unidentifiable subject would poison
      // the unique index and the alert stream.
      const clean = findings.filter((f) => {
        if (!subjectOf(f)) {
          checkLog.warn('discarding finding with no identifiable subject', {
            summary: f?.summary,
          });
          return false;
        }
        if (typeof f.summary !== 'string' || f.summary.length === 0) {
          checkLog.warn('discarding finding with no summary', { subject: subjectOf(f)?.id });
          return false;
        }
        return true;
      });

      const severity = check.severity ?? rule.defaultSeverity;

      // Routing is resolved at delivery time, but only here are the config entry and
      // the rule in scope together. RaisedAlert carries `kind`, so a kind-keyed map is
      // all notify needs to look this up later.
      routes.set(kind, { notifyTo: check.notifyTo, routing: rule.defaultRouting });

      if (dryRun) {
        const result: CheckResult = {
          ruleId: rule.id,
          kind,
          status: 'ok',
          findings: clean.length,
          raised: 0,
          resolved: 0,
          durationMs: Number(process.hrtime.bigint() - began) / 1e6,
        };
        results.push(result);
        for (const f of clean) {
          const subject = subjectOf(f);
          // Report the severity that would actually be stored: a finding may
          // escalate past the check's configured default.
          checkLog.info('would raise', {
            subject: `${subject?.kind}:${subject?.id}`,
            summary: f.summary,
            severity: f.severity ?? severity,
          });
        }
        continue;
      }

      const { raised, resolved, touched } = await store.reconcile(
        rule.id,
        kind,
        severity,
        clean,
      );
      allRaised.push(...raised);

      const result: CheckResult = {
        ruleId: rule.id,
        kind,
        status: 'ok',
        findings: clean.length,
        raised: raised.length,
        resolved,
        durationMs: Number(process.hrtime.bigint() - began) / 1e6,
      };
      results.push(result);
      await store.recordRun(result, checkStart);

      checkLog.info('check complete', {
        findings: clean.length,
        raised: raised.length,
        stillOpen: touched,
        resolved,
        ms: Math.round(result.durationMs),
      });
    } catch (err) {
      // A failing check must not resolve its own open alerts. If the query errored
      // we have no evidence the breach ended, and silently closing alerts would be
      // worse than reporting nothing — so reconcile is simply not called.
      const result: CheckResult = {
        ruleId: rule.id,
        kind,
        status: 'error',
        findings: 0,
        raised: 0,
        resolved: 0,
        durationMs: Number(process.hrtime.bigint() - began) / 1e6,
        error: (err as Error).message,
      };
      results.push(result);
      await store.recordRun(result, checkStart);
      checkLog.error('check failed — open alerts left untouched', {
        error: result.error,
      });
    }
  }

  // Suppression before delivery, and both after every check has reconciled — see the
  // ordering note in the module header.
  const suppression = dryRun
    ? { suppressed: 0, released: 0 }
    : await applySuppression(store, config.suppress, config.checks, log);

  const notified = dryRun
    ? { delivered: 0, failed: 0, unrouted: 0 }
    : await notifyRaised(await store.listPendingNotify(), config.notify, store, log, routes);

  const finishedAt = new Date();
  const summary: SoundingSummary = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    results,
    raised: results.reduce((n, r) => n + r.raised, 0),
    resolved: results.reduce((n, r) => n + r.resolved, 0),
    errors: results.filter((r) => r.status === 'error').length,
    delivered: notified.delivered,
    deliveryFailed: notified.failed,
    unrouted: notified.unrouted,
    suppressed: suppression.suppressed,
    released: suppression.released,
  };

  // Last, and only when not a dry run: the ping says "a sounding completed", so it has
  // to follow the sounding completing. A failed ping never fails the sounding.
  const skipPing = config.heartbeat?.onError === false && summary.errors > 0;
  if (!dryRun && config.heartbeat && !skipPing) {
    const openAlerts = await store.listOpenAlerts(1_000).catch(() => []);
    const hb = await sendHeartbeat(
      config.heartbeat,
      {
        schema: 'leadsman.heartbeat/1',
        ...(config.notify?.instanceName ? { instance: config.notify.instanceName } : {}),
        sentAt: finishedAt.toISOString(),
        version: version(),
        soundingMs: summary.durationMs,
        checksRun: results.filter((r) => r.status !== 'skipped').length,
        checksErrored: summary.errors,
        openAlerts: openAlerts.length,
        suppressedAlerts: openAlerts.filter((a) => a.suppressed_at !== null).length,
      },
      log,
      heartbeatSecretFromEnv(),
    );
    if (hb.attempted) summary.heartbeat = hb.delivered ? 'sent' : 'failed';
  }

  log.info('sounding finished', {
    ms: summary.durationMs,
    raised: summary.raised,
    resolved: summary.resolved,
    delivered: summary.delivered,
    // Only surfaced when non-zero, so a healthy line stays as short as it was.
    ...(summary.deliveryFailed > 0 ? { deliveryFailed: summary.deliveryFailed } : {}),
    ...(summary.unrouted > 0 ? { unrouted: summary.unrouted } : {}),
    ...(summary.suppressed > 0 ? { suppressed: summary.suppressed } : {}),
    ...(summary.released > 0 ? { released: summary.released } : {}),
    ...(summary.heartbeat ? { heartbeat: summary.heartbeat } : {}),
    errors: summary.errors,
  });

  return summary;
}

/**
 * The host- and engine-level facts, read once per sounding.
 *
 * None of these can be derived from telemetry, which is why they are gathered here rather
 * than by the checks that use them: they are properties of the box, not of the fleet.
 * Each is independently optional — a failure to read one leaves it null and skips only the
 * checks that declared a need for it.
 */
async function gatherEngineFacts(
  config: LeadsmanConfig,
  store: Store,
  log: Logger,
): Promise<EngineFacts> {
  const [postmasterStartTime, previousRunAt] = await Promise.all([
    store.postmasterStartTime().catch((err: Error) => {
      log.warn('could not read pg_postmaster_start_time', { error: err.message });
      return null;
    }),
    store.previousRunAt().catch((err: Error) => {
      log.warn('could not read the previous run time', { error: err.message });
      return null;
    }),
  ]);

  return {
    postmasterStartTime,
    previousRunAt,
    hostAddress: resolveHostAddress(config.hostAddress, log),
  };
}

/**
 * Build the gateway source, or explain why there isn't one.
 *
 * The reason string is kept and logged against any check that gets skipped, because
 * "chirpstack is not configured" and "the API key in the shared file is missing" call for
 * completely different actions and both otherwise present as a silent skip.
 */
function buildGatewaySource(
  config: LeadsmanConfig,
  log: Logger,
): { gateways: GatewaySource | null; chirpstackMissing: string | null } {
  if (!config.chirpstack) return { gateways: null, chirpstackMissing: null };

  const resolved = resolveConnection(config.chirpstack, log);
  if ('missing' in resolved) {
    log.warn('chirpstack gateway checks unavailable', { reason: resolved.missing });
    return { gateways: null, chirpstackMissing: resolved.missing };
  }
  return { gateways: gatewaySource(resolved.connection, log), chirpstackMissing: null };
}

/**
 * A check's private corner of leadsman.engine_state.
 *
 * Keys are prefixed with the check's kind, so two instances of the same rule keep
 * separate memory, and a rule cannot reach another rule's state by guessing a key.
 * Writes are dropped under --dry-run: a dry run that quietly recorded a new host address
 * would make the real sounding afterwards see no change and report nothing.
 */
function checkState(store: Store, kind: string, dryRun: boolean): CheckState {
  const namespaced = (key: string): string => `${kind}:${key}`;
  return {
    get: (key) => store.getEngineState(namespaced(key)),
    set: async (key, value) => {
      if (dryRun) return;
      await store.setEngineState(namespaced(key), value);
    },
  };
}

/** The first prerequisite a rule declared that this sounding cannot provide. */
function unmetNeeds(
  rule: Rule,
  available: { gateways: GatewaySource | null; hostAddress: string | null },
): 'chirpstack' | 'hostAddress' | null {
  for (const need of rule.needs ?? []) {
    if (need === 'chirpstack' && !available.gateways) return 'chirpstack';
    if (need === 'hostAddress' && !available.hostAddress) return 'hostAddress';
  }
  return null;
}
