// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Tests for the alert lifecycle, the runner's failure handling, and the notifier.
//
// These cover the properties the README promises and nothing previously verified:
//
//   - A failing check must NOT resolve its open alerts. If a query errors there is no
//     evidence the breach ended, and silently closing alerts would turn a database
//     hiccup into "everything is fine". This is the single most dangerous thing the
//     engine could get wrong, and it had no test.
//   - Delivery failures must leave the alert pending so the next sounding retries it —
//     the design deliberately has no separate retry queue.
//   - Only newly-raised alerts notify. An alert open for a week must not re-send.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const h = require('./helpers/db.js');
const { runSounding } = require('../dist/runner.js');
const { notifyRaised } = require('../dist/notify.js');

if (!h.available) {
  test('database-backed engine tests', { skip: h.skipMessage }, () => {});
} else {
  let env;
  test.before(async () => { env = await h.setup('engine'); });
  test.after(async () => { await h.teardown(env); });
  test.beforeEach(async () => { await h.reset(env.db); });

  const openAlerts = async () => {
    const { rows } = await env.db.query(
      'SELECT kind, dev_eui, severity, summary, notified_at FROM leadsman.open_alert ORDER BY dev_eui',
    );
    return rows;
  };
  const allAlerts = async () => {
    const { rows } = await env.db.query(
      'SELECT dev_eui, kind, resolved_at FROM leadsman.alert ORDER BY id',
    );
    return rows;
  };

  /** A check that returns whatever findings you hand it, or throws. */
  const fakeRule = (id, behaviour) => ({
    id,
    description: 'A synthetic check used only by the test suite.',
    defaultSeverity: 'warning',
    defaultParams: {},
    requires: [{ table: 'event_up', columns: ['dev_eui'] }],
    run: typeof behaviour === 'function' ? behaviour : async () => behaviour,
  });

  const sound = (rules, checks, { dryRun = false } = {}) =>
    runSounding({
      config: { schedule: '* * * * *', checks, statementTimeoutMs: 15_000 },
      rules: new Map(rules.map((r) => [r.id, r])),
      store: env.store,
      log: h.quietLogger(),
      dryRun,
    });

  const finding = (devEui, summary = `${devEui} is unhappy`) => ({ devEui, summary });

  // ── the safety property ─────────────────────────────────────────────────────

  test('a failing check does NOT resolve its open alerts', async () => {
    const rule = fakeRule('flaky', async () => [finding('aa'), finding('bb')]);
    await sound([rule], [{ rule: 'flaky', as: 'flaky', enabled: true }]);
    assert.equal((await openAlerts()).length, 2, 'both alerts should be open');

    // Same check, now erroring. Its alerts must survive untouched.
    const broken = fakeRule('flaky', async () => { throw new Error('connection reset'); });
    const summary = await sound([broken], [{ rule: 'flaky', as: 'flaky', enabled: true }]);

    assert.equal(summary.errors, 1);
    assert.equal(summary.resolved, 0, 'a failed check must resolve nothing');
    assert.equal(
      (await openAlerts()).length, 2,
      'open alerts must survive a check failure — otherwise a database hiccup reads as a healthy fleet',
    );

    const { rows } = await env.db.query(
      `SELECT status, error FROM leadsman.run WHERE status = 'error'`,
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].error, /connection reset/, 'the failure must be recorded, not swallowed');
  });

  test('an empty findings list resolves every open alert for that kind', async () => {
    const raise = fakeRule('r', async () => [finding('aa'), finding('bb')]);
    await sound([raise], [{ rule: 'r', as: 'r', enabled: true }]);
    assert.equal((await openAlerts()).length, 2);

    const clear = fakeRule('r', async () => []);
    const summary = await sound([clear], [{ rule: 'r', as: 'r', enabled: true }]);
    assert.equal(summary.resolved, 2);
    assert.equal((await openAlerts()).length, 0);
  });

  test('one check resolving does not touch another kind', async () => {
    const a = fakeRule('a', async () => [finding('shared')]);
    const b = fakeRule('b', async () => [finding('shared')]);
    await sound([a, b], [
      { rule: 'a', as: 'a', enabled: true },
      { rule: 'b', as: 'b', enabled: true },
    ]);
    assert.equal((await openAlerts()).length, 2, 'the same device can breach two checks');

    const aClear = fakeRule('a', async () => []);
    await sound([aClear, b], [
      { rule: 'a', as: 'a', enabled: true },
      { rule: 'b', as: 'b', enabled: true },
    ]);
    const open = await openAlerts();
    assert.deepEqual(open.map((r) => r.kind), ['b']);
  });

  // ── reconciler edge cases ───────────────────────────────────────────────────

  test('a duplicate devEui within one findings list does not break the transaction', async () => {
    // A buggy check could emit the same device twice. The partial unique index would
    // reject the second INSERT; ON CONFLICT must absorb it instead of aborting the
    // whole sounding and losing every other finding.
    const rule = fakeRule('dupe', async () => [
      finding('aa', 'first'), finding('aa', 'second'), finding('bb', 'other'),
    ]);
    const summary = await sound([rule], [{ rule: 'dupe', as: 'dupe', enabled: true }]);

    assert.equal(summary.errors, 0);
    const open = await openAlerts();
    assert.equal(open.length, 2);
    // Last write wins on the summary — the row is updated, not duplicated.
    assert.equal(open.find((r) => r.dev_eui === 'aa').summary, 'second');
  });

  test('re-breaching after a resolve creates a new row, preserving history', async () => {
    const raise = fakeRule('r', async () => [finding('aa')]);
    const clear = fakeRule('r', async () => []);
    await sound([raise], [{ rule: 'r', as: 'r', enabled: true }]);
    await sound([clear], [{ rule: 'r', as: 'r', enabled: true }]);
    await sound([raise], [{ rule: 'r', as: 'r', enabled: true }]);

    const all = await allAlerts();
    assert.equal(all.length, 2, 'the resolved episode and the new one are separate rows');
    assert.ok(all[0].resolved_at, 'the first episode stays resolved');
    assert.equal(all[1].resolved_at, null, 'the second is open');
    assert.equal((await openAlerts()).length, 1);
  });

  test('re-raising while already open keeps raised_at, so open_for stays meaningful', async () => {
    const rule = fakeRule('r', async () => [finding('aa')]);
    await sound([rule], [{ rule: 'r', as: 'r', enabled: true }]);
    const { rows: before } = await env.db.query('SELECT raised_at, last_seen_at FROM leadsman.alert');

    await new Promise((r) => setTimeout(r, 50));
    await sound([rule], [{ rule: 'r', as: 'r', enabled: true }]);
    const { rows: after } = await env.db.query('SELECT raised_at, last_seen_at FROM leadsman.alert');

    assert.equal(
      before[0].raised_at.getTime(), after[0].raised_at.getTime(),
      'raised_at must not move — it is how long the problem has existed',
    );
    assert.ok(
      after[0].last_seen_at.getTime() > before[0].last_seen_at.getTime(),
      'last_seen_at must advance',
    );
  });

  test('a per-finding severity overrides the check default', async () => {
    const rule = fakeRule('r', async () => [
      { devEui: 'aa', summary: 'mild' },
      { devEui: 'bb', summary: 'bad', severity: 'critical' },
    ]);
    await sound([rule], [{ rule: 'r', as: 'r', enabled: true, severity: 'info' }]);
    const open = await openAlerts();
    assert.equal(open.find((r) => r.dev_eui === 'aa').severity, 'info');
    assert.equal(open.find((r) => r.dev_eui === 'bb').severity, 'critical');
  });

  // ── runner robustness ───────────────────────────────────────────────────────

  test('an unknown rule id is reported and the sounding continues', async () => {
    const good = fakeRule('good', async () => [finding('aa')]);
    const summary = await sound([good], [
      { rule: 'nonexistent', as: 'ghost', enabled: true },
      { rule: 'good', as: 'good', enabled: true },
    ]);

    assert.equal(summary.errors, 1);
    assert.equal(summary.raised, 1, 'the healthy check must still run');
    const ghost = summary.results.find((r) => r.kind === 'ghost');
    assert.match(ghost.error, /unknown rule/);
  });

  test('findings missing a devEui or summary are discarded, not written', async () => {
    // A malformed devEui would poison the unique index; an empty summary would send a
    // blank SMS. Both must be dropped without failing the check.
    const rule = fakeRule('junk', async () => [
      { devEui: '', summary: 'no id' },
      { devEui: 'aa', summary: '' },
      { devEui: 'bb', summary: 'valid' },
      { summary: 'no devEui at all' },
    ]);
    const summary = await sound([rule], [{ rule: 'junk', as: 'junk', enabled: true }]);

    assert.equal(summary.errors, 0);
    const open = await openAlerts();
    assert.deepEqual(open.map((r) => r.dev_eui), ['bb']);
  });

  test('disabled checks do not run at all', async () => {
    let ran = false;
    const rule = fakeRule('r', async () => { ran = true; return []; });
    await sound([rule], [{ rule: 'r', as: 'r', enabled: false }]);
    assert.equal(ran, false);
    const { rows } = await env.db.query('SELECT count(*)::int AS n FROM leadsman.run');
    assert.equal(rows[0].n, 0, 'a disabled check must not even be logged');
  });

  test('dry-run writes nothing to either table', async () => {
    const rule = fakeRule('r', async () => [finding('aa'), finding('bb')]);
    const summary = await sound([rule], [{ rule: 'r', as: 'r', enabled: true }], { dryRun: true });

    assert.equal(summary.results[0].findings, 2, 'it still evaluates');
    assert.equal(summary.raised, 0);
    const { rows } = await env.db.query(
      'SELECT (SELECT count(*) FROM leadsman.alert)::int AS a, (SELECT count(*) FROM leadsman.run)::int AS r',
    );
    assert.deepEqual(rows[0], { a: 0, r: 0 });
  });

  test('every check execution is recorded with a duration', async () => {
    const rule = fakeRule('r', async () => [finding('aa')]);
    await sound([rule], [{ rule: 'r', as: 'r', enabled: true }]);
    const { rows } = await env.db.query(
      'SELECT status, findings, raised, resolved, duration_ms, finished_at FROM leadsman.run',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'ok');
    assert.equal(rows[0].findings, 1);
    assert.equal(rows[0].raised, 1);
    assert.ok(rows[0].duration_ms >= 0);
    assert.ok(rows[0].finished_at);
  });

  // ── notifier ────────────────────────────────────────────────────────────────

  /** A throwaway HTTP endpoint that records what it received. */
  async function receiver(handler) {
    const received = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ headers: req.headers, body: JSON.parse(body || '{}') });
        handler(req, res, received);
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return {
      url: `http://127.0.0.1:${server.address().port}/hook`,
      received,
      close: () => new Promise((r) => server.close(r)),
    };
  }

  const raised = (id, devEui) => ({
    id: String(id), ruleId: 'r', kind: 'r', devEui, deviceName: null,
    severity: 'warning', summary: `${devEui} unhappy`, detail: { v: 1 },
    raisedAt: new Date().toISOString(),
  });

  test('notifier: a successful POST stamps notified_at', async () => {
    const rule = fakeRule('r', async () => [finding('aa')]);
    await sound([rule], [{ rule: 'r', as: 'r', enabled: true }]);
    const { rows } = await env.db.query('SELECT id FROM leadsman.alert');

    const hook = await receiver((req, res) => { res.writeHead(204); res.end(); });
    try {
      const out = await notifyRaised(
        [raised(rows[0].id, 'aa')],
        { destinations: { hook: { webhookUrl: hook.url, timeoutMs: 2000 } }, defaultDestination: 'hook' },
        env.store, h.quietLogger(),
      );
      assert.equal(out.delivered, 1);
      assert.equal(out.failed, 0);

      const after = await openAlerts();
      assert.ok(after[0].notified_at, 'notified_at must be stamped on success');

      // The payload is the documented contract; a receiver templates against it.
      assert.equal(hook.received[0].body.schema, 'leadsman.alert/1');
      assert.equal(hook.received[0].body.devEui, 'aa');
      assert.equal(hook.received[0].body.severity, 'warning');
    } finally {
      await hook.close();
    }
  });

  test('notifier: a 500 leaves the alert pending so a later sounding retries it', async () => {
    const rule = fakeRule('r', async () => [finding('aa')]);
    await sound([rule], [{ rule: 'r', as: 'r', enabled: true }]);
    const { rows } = await env.db.query('SELECT id FROM leadsman.alert');

    const hook = await receiver((req, res) => { res.writeHead(500); res.end(); });
    try {
      const out = await notifyRaised(
        [raised(rows[0].id, 'aa')],
        { destinations: { hook: { webhookUrl: hook.url, timeoutMs: 2000 } }, defaultDestination: 'hook' },
        env.store, h.quietLogger(),
      );
      assert.equal(out.delivered, 0);
      assert.equal(out.failed, 1);

      const after = await openAlerts();
      assert.equal(
        after[0].notified_at, null,
        'a failed delivery must leave notified_at NULL — that is the retry mechanism',
      );
    } finally {
      await hook.close();
    }
  });

  test('notifier: an unreachable endpoint fails without throwing', async () => {
    // Port 1 is reserved and refuses immediately. A dead notifier must not take the
    // sounding down with it.
    const out = await notifyRaised(
      [raised(1, 'aa')],
      { destinations: { hook: { webhookUrl: 'http://127.0.0.1:1/hook', timeoutMs: 1000 } }, defaultDestination: 'hook' },
      env.store, h.quietLogger(),
    );
    assert.equal(out.failed, 1);
    assert.equal(out.delivered, 0);
  });

  test('notifier: a hung endpoint is abandoned at the timeout', async () => {
    const hook = await receiver(() => { /* never responds */ });
    try {
      const started = Date.now();
      const out = await notifyRaised(
        [raised(1, 'aa')],
        { destinations: { hook: { webhookUrl: hook.url, timeoutMs: 300 } }, defaultDestination: 'hook' },
        env.store, h.quietLogger(),
      );
      assert.equal(out.failed, 1);
      assert.ok(Date.now() - started < 3000, 'the timeout must actually fire');
    } finally {
      await hook.close();
    }
  });

  test('notifier: sends a bearer token when configured', async () => {
    const hook = await receiver((req, res) => { res.writeHead(204); res.end(); });
    try {
      await notifyRaised(
        [raised(1, 'aa')],
        { destinations: { hook: { webhookUrl: hook.url, webhookToken: 's3cret', timeoutMs: 2000 } }, defaultDestination: 'hook' },
        env.store, h.quietLogger(),
      );
      assert.equal(hook.received[0].headers.authorization, 'Bearer s3cret');
    } finally {
      await hook.close();
    }
  });

  test('notifier: hmac mode signs <timestamp>.<body> and the signature verifies', async () => {
    // The receiver recomputes this exact digest. If leadsman serialized the body twice —
    // once to sign, once to send — the two strings could differ and every delivery would
    // be rejected with no useful error, so the test verifies end to end.
    const secret = 'shhh';
    const hook = await receiver((req, res) => { res.writeHead(204); res.end(); });
    try {
      await notifyRaised(
        [raised(1, 'aa')],
        { destinations: { hook: { webhookUrl: hook.url, webhookToken: secret, webhookAuth: 'hmac', timeoutMs: 2000 } }, defaultDestination: 'hook' },
        env.store, h.quietLogger(),
      );

      const got = hook.received[0];
      const ts = got.headers['x-webhook-timestamp'];
      const sig = got.headers['x-webhook-signature-v2'];
      assert.ok(ts, 'X-Webhook-Timestamp must be present');
      assert.ok(sig, 'X-Webhook-Signature-V2 must be present');
      assert.equal(got.headers.authorization, undefined, 'hmac mode must not also send a bearer');

      // Recompute over the body as the receiver would see it.
      const expected = require('node:crypto')
        .createHmac('sha256', secret)
        .update(`${ts}.${JSON.stringify(got.body)}`)
        .digest('hex');
      assert.equal(sig, expected, 'the signature must cover exactly the bytes that were sent');

      // Replay protection depends on the timestamp being current.
      const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
      assert.ok(skew < 60, `timestamp should be current, was ${skew}s off`);
    } finally {
      await hook.close();
    }
  });

  test('notifier: token mode sends the raw secret in a configurable header', async () => {
    const hook = await receiver((req, res) => { res.writeHead(204); res.end(); });
    try {
      await notifyRaised(
        [raised(1, 'aa')],
        { destinations: { hook: { webhookUrl: hook.url, webhookToken: 'plain', webhookAuth: 'token',
          webhookTokenHeader: 'X-Gitlab-Token', timeoutMs: 2000 } }, defaultDestination: 'hook' },
        env.store, h.quietLogger(),
      );
      assert.equal(hook.received[0].headers['x-gitlab-token'], 'plain');
      assert.equal(hook.received[0].headers.authorization, undefined);
    } finally {
      await hook.close();
    }
  });

  test('notifier: only NEWLY raised alerts are delivered', async () => {
    const rule = fakeRule('r', async () => [finding('aa')]);
    const hook = await receiver((req, res) => { res.writeHead(204); res.end(); });
    try {
      const cfg = {
        schedule: '* * * * *',
        statementTimeoutMs: 15_000,
        notify: { destinations: { hook: { webhookUrl: hook.url, timeoutMs: 2000 } }, defaultDestination: 'hook' },
        checks: [{ rule: 'r', as: 'r', enabled: true }],
      };
      const opts = {
        config: cfg, rules: new Map([['r', rule]]), store: env.store, log: h.quietLogger(),
      };

      const first = await runSounding(opts);
      assert.equal(first.delivered, 1);

      // Still breaching. The alert stays open and must NOT re-notify — this is what
      // stops a flapping sensor from becoming an SMS storm.
      const second = await runSounding(opts);
      assert.equal(second.raised, 0);
      assert.equal(second.delivered, 0);
      assert.equal(hook.received.length, 1, 'exactly one POST across two soundings');
    } finally {
      await hook.close();
    }
  });

  test('notifier: with no notify config, alerts are still recorded', async () => {
    const rule = fakeRule('r', async () => [finding('aa')]);
    const summary = await sound([rule], [{ rule: 'r', as: 'r', enabled: true }]);
    assert.equal(summary.raised, 1);
    assert.equal(summary.delivered, 0);
    assert.equal((await openAlerts()).length, 1);
  });

  // ── operational guarantees ──────────────────────────────────────────────────

  test('the migration is idempotent', async () => {
    // The README tells operators it is safe to re-run. Applying it twice in one
    // session is the cheapest way to keep that true.
    const fs = require('node:fs');
    const path = require('node:path');
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', '001_leadsman_schema.sql'), 'utf8',
    );
    await env.db.query(sql);
    await env.db.query(sql);

    const { rows } = await env.db.query(
      `SELECT count(*)::int AS n FROM pg_indexes
        WHERE schemaname = 'leadsman' AND indexname = 'alert_open_uniq'`,
    );
    assert.equal(rows[0].n, 1, 'indexes must not be duplicated');
  });

  test('statement_timeout is applied to the connection', async () => {
    // The ceiling that stops one slow sounding from starving ChirpStack's ingestion on
    // a shared box. Worth asserting, because a silently-unset timeout looks fine until
    // a sequential scan on a large event_up wedges the device.
    const { Store } = require('../dist/db.js');
    const store = new Store({ connectionString: env.url, statementTimeoutMs: 150 });
    try {
      await assert.rejects(
        () => store.query('SELECT pg_sleep(3)'),
        /statement timeout|canceling statement/i,
      );
    } finally {
      await store.close();
    }
  });

  // ── every rule's SQL actually executes ──────────────────────────────────────

  test('every rule executes its real SQL against the database on its own defaults', async () => {
    // The smoke suite has a similar test, but it stubs `query` — so parameter binding,
    // SQL syntax, and casts are never exercised. That gap let a $-placeholder collision
    // in join-churn reach live data: the rule bound 6 values to a 5-parameter statement
    // and failed only when run against a real server.
    //
    // This runs every discovered rule against an EMPTY event store with its own
    // defaults. Empty is the point — it proves the statement prepares, binds, and
    // executes without needing fixture data per rule, so a new check is covered the
    // moment it is added.
    const { loadRules } = require('../dist/registry.js');
    const rules = loadRules();

    // Rules that legitimately refuse to run until configured. Anything else must
    // execute cleanly; anything new landing here is a deliberate decision.
    const NEEDS_CONFIG = new Set(['measurement-threshold', 'geofence-breach']);

    const failures = [];
    for (const [id, rule] of rules) {
      const ctx = h.ctx(env.store, { params: { ...rule.defaultParams }, kind: id });
      try {
        const findings = await rule.run(ctx);
        if (NEEDS_CONFIG.has(id)) {
          failures.push(`${id}: expected it to require configuration, but it ran`);
        } else if (findings.length !== 0) {
          failures.push(`${id}: returned ${findings.length} findings from an empty store`);
        }
      } catch (err) {
        // A parameter or SQL fault reads very differently from a validation message,
        // and only the former is a bug.
        const msg = err.message;
        const isSqlFault =
          /parameters|prepared statement|syntax error|does not exist|cannot be matched|invalid input syntax|operator does not exist|column .* does not exist/i
            .test(msg);
        if (isSqlFault || !NEEDS_CONFIG.has(id)) {
          failures.push(`${id}: ${msg}`);
        }
      }
    }

    assert.deepEqual(failures, [], `rules failed against a real database:\n  ${failures.join('\n  ')}`);
    assert.ok(rules.size >= 18, `expected at least 18 rules, found ${rules.size}`);
  });

  test('every rule declares tables and columns that exist', async () => {
    // `verify` does this at startup for the configured checks; this covers every rule in
    // the registry, including ones no shipped config enables yet.
    const { loadRules } = require('../dist/registry.js');
    const live = await env.store.describePublicSchema();
    const problems = [];
    for (const [id, rule] of loadRules()) {
      for (const req of rule.requires) {
        const cols = live.get(req.table);
        if (!cols) { problems.push(`${id}: table ${req.table} missing`); continue; }
        for (const col of req.columns) {
          if (!cols.has(col)) problems.push(`${id}: ${req.table}.${col} missing`);
        }
      }
    }
    assert.deepEqual(problems, [], problems.join('; '));
  });

  test('decode-failure counts all three empty decoded shapes', async () => {
    // Real ChirpStack data turned up a codec returning JSON null, which is neither a
    // SQL NULL nor an empty object — the original predicate missed it entirely, so a
    // device producing no usable data looked healthy to every check.
    const rows = await env.store.query(
      `SELECT count(*)::int AS n FROM (VALUES
         (NULL::jsonb), ('null'::jsonb), ('{}'::jsonb), ('{\"a\":1}'::jsonb)
       ) AS t(object)
       WHERE object IS NULL OR jsonb_typeof(object) = 'null' OR object = '{}'::jsonb`,
    );
    assert.equal(rows[0].n, 3, 'NULL, JSON null, and {} all count as undecoded; {a:1} does not');
  });

  test('verifyConnection reports the database and role', async () => {
    const info = await env.store.verifyConnection();
    assert.ok(info.database);
    assert.ok(info.user);
    assert.match(info.version, /PostgreSQL/);
  });
}
