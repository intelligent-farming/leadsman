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
//   - Delivery failures must leave the alert pending AND the next sounding must actually
//     retry it — the design deliberately has no separate retry queue. Asserting the NULL
//     notified_at alone was not enough: delivery once read only freshly-raised alerts, so
//     a pending one was in fact never offered again.
//   - An alert already delivered must not re-send while it stays open.
//   - Suppression withholds delivery without losing the alert, and releases it when the
//     alert that explained it resolves.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const h = require('./helpers/db.js');
const { runSounding } = require('../dist/runner.js');
const { notifyRaised } = require('../dist/notify.js');
const { Store } = require('../dist/db.js');

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
    // Sockets are tracked so close() can destroy them. `fetch` keeps connections alive,
    // so server.close() alone waits on an idle keep-alive socket and never resolves —
    // which would hang the test rather than fail it.
    const sockets = new Set();
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ headers: req.headers, body: JSON.parse(body || '{}') });
        handler(req, res, received);
      });
    });
    server.on('connection', (sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return {
      url: `http://127.0.0.1:${server.address().port}/hook`,
      received,
      close: () => new Promise((r) => {
        server.close(r);
        for (const sock of sockets) sock.destroy();
      }),
    };
  }

  const raised = (id, devEui) => ({
    id: String(id), ruleId: 'r', kind: 'r',
    subjectKind: 'device', subjectId: devEui, subjectName: null,
    devEui, deviceName: null,
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
      assert.equal(hook.received[0].body.schema, 'leadsman.alert/2');
      assert.equal(hook.received[0].body.devEui, 'aa');
      assert.equal(hook.received[0].body.subjectKind, 'device');
      assert.equal(hook.received[0].body.subjectId, 'aa');
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

  test('notifier: an alert already delivered is not delivered again while it stays open', async () => {
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

  test('notifier: a failed delivery IS retried on the next sounding', async () => {
    // The retry the docs have always promised, which for a long time did not happen.
    // Delivery used to work from reconcile's newly-inserted rows: on the second
    // sounding the ON CONFLICT took the DO UPDATE branch, so the alert was no longer
    // "new", its NULL notified_at was never revisited, and it was never offered again.
    // A storm that throttled Twilio or Slack lost those alerts permanently.
    //
    // Delivery now reads the pending set — open, unnotified, unsuppressed — so the only
    // record of delivery is notified_at, and anything lacking one is tried again.
    let attempts = 0;
    const hook = await receiver((req, res) => {
      attempts += 1;
      // Fail the first attempt, accept the second.
      if (attempts === 1) { res.writeHead(500); res.end(); return; }
      res.writeHead(204); res.end();
    });
    try {
      const rule = fakeRule('r', async () => [finding('aa')]);
      const cfg = {
        schedule: '* * * * *',
        statementTimeoutMs: 15_000,
        notify: {
          destinations: { hook: { webhookUrl: hook.url, timeoutMs: 2000 } },
          defaultDestination: 'hook',
        },
        checks: [{ rule: 'r', as: 'r', enabled: true }],
      };
      const opts = {
        config: cfg, rules: new Map([['r', rule]]), store: env.store, log: h.quietLogger(),
      };

      const first = await runSounding(opts);
      assert.equal(first.delivered, 0);
      assert.equal(first.deliveryFailed, 1);
      assert.equal((await openAlerts())[0].notified_at, null);

      const second = await runSounding(opts);
      assert.equal(second.raised, 0, 'still the same open alert, not a new one');
      assert.equal(second.delivered, 1, 'the pending alert is offered again');
      assert.ok((await openAlerts())[0].notified_at, 'and stamped once it lands');

      // A third sounding must not send a third time.
      const third = await runSounding(opts);
      assert.equal(third.delivered, 0);
      assert.equal(attempts, 2, 'exactly two POSTs: one failed, one succeeded');
    } finally {
      await hook.close();
    }
  });

  // ── suppression ────────────────────────────────────────────────────────────
  // The pure matching logic is covered in the smoke suite. These cover the part that
  // needs a database: that a withheld alert is recorded rather than dropped, and that it
  // is delivered if it is still open when its cause resolves.

  const suppressCfg = (hookUrl, extra = {}) => ({
    schedule: '* * * * *',
    statementTimeoutMs: 15_000,
    suppress: [{ while: ['cause'], mute: ['downstream'], enabled: true }],
    notify: {
      destinations: { hook: { webhookUrl: hookUrl, timeoutMs: 2000 } },
      defaultDestination: 'hook',
    },
    checks: [
      { rule: 'cause', as: 'cause', enabled: true },
      { rule: 'downstream', as: 'downstream', enabled: true },
    ],
    ...extra,
  });

  test('suppression records the muted alert and withholds only the delivery', async () => {
    const hook = await receiver((req, res) => { res.writeHead(204); res.end(); });
    try {
      const summary = await runSounding({
        config: suppressCfg(hook.url),
        rules: new Map([
          ['cause', fakeRule('cause', async () => [finding('site')])],
          ['downstream', fakeRule('downstream', async () => [finding('aa')])],
        ]),
        store: env.store,
        log: h.quietLogger(),
      });

      assert.equal(summary.raised, 2, 'both alerts are raised');
      assert.equal(summary.suppressed, 1);
      assert.equal(summary.delivered, 1, 'only the cause is delivered');
      assert.equal(hook.received.length, 1);
      assert.equal(hook.received[0].body.kind, 'cause');

      // Recorded, visible, and explained — not dropped.
      const rows = await env.store.query(
        `SELECT kind, suppressed_at, detail->>'suppressedBy' AS by, notified_at
           FROM leadsman.alert WHERE kind = 'downstream'`,
      );
      assert.equal(rows.length, 1);
      assert.ok(rows[0].suppressed_at, 'suppressed_at is stamped');
      assert.equal(rows[0].by, 'cause', 'and says what withheld it');
      assert.equal(rows[0].notified_at, null, 'never delivered');
    } finally {
      await hook.close();
    }
  });

  test('suppression releases a still-open alert when its cause resolves', async () => {
    // The property that makes muting safe enough to be on by default: a node that
    // really is dead is reported once the outage explaining it away has cleared.
    const hook = await receiver((req, res) => { res.writeHead(204); res.end(); });
    try {
      let causeBreaching = true;
      const rules = new Map([
        ['cause', fakeRule('cause', async () => (causeBreaching ? [finding('site')] : []))],
        ['downstream', fakeRule('downstream', async () => [finding('aa')])],
      ]);
      const opts = {
        config: suppressCfg(hook.url), rules, store: env.store, log: h.quietLogger(),
      };

      const first = await runSounding(opts);
      assert.equal(first.suppressed, 1);
      assert.equal(first.delivered, 1);

      // The cause clears; the downstream alert is still breaching.
      causeBreaching = false;
      const second = await runSounding(opts);
      assert.equal(second.released, 1, 'suppression lifts in the same sounding');
      assert.equal(second.delivered, 1, 'and the held alert goes out');
      assert.equal(hook.received.length, 2);
      assert.equal(hook.received[1].body.kind, 'downstream');

      const rows = await env.store.query(
        `SELECT suppressed_at, notified_at, detail ? 'suppressedBy' AS still_marked
           FROM leadsman.alert WHERE kind = 'downstream'`,
      );
      assert.equal(rows[0].suppressed_at, null, 'no longer suppressed');
      assert.equal(rows[0].still_marked, false, 'and the explanation is cleared');
      assert.ok(rows[0].notified_at);
    } finally {
      await hook.close();
    }
  });

  test('suppression withholds nothing when the downstream alert resolves with its cause', async () => {
    // The common case: the devices were never broken, so their alerts resolve alongside
    // the outage and are never delivered at all. This is the storm not happening.
    const hook = await receiver((req, res) => { res.writeHead(204); res.end(); });
    try {
      let breaching = true;
      const rules = new Map([
        ['cause', fakeRule('cause', async () => (breaching ? [finding('site')] : []))],
        ['downstream', fakeRule('downstream', async () => (breaching ? [finding('aa')] : []))],
      ]);
      const opts = {
        config: suppressCfg(hook.url), rules, store: env.store, log: h.quietLogger(),
      };

      await runSounding(opts);
      breaching = false;
      const second = await runSounding(opts);

      assert.equal(second.resolved, 2, 'both resolve');
      assert.equal(second.delivered, 0);
      assert.equal(hook.received.length, 1, 'the downstream alert was never sent');
    } finally {
      await hook.close();
    }
  });

  test('"suppress": [] delivers the storm, which is the documented opt-out', async () => {
    const hook = await receiver((req, res) => { res.writeHead(204); res.end(); });
    try {
      const summary = await runSounding({
        config: suppressCfg(hook.url, { suppress: [] }),
        rules: new Map([
          ['cause', fakeRule('cause', async () => [finding('site')])],
          ['downstream', fakeRule('downstream', async () => [finding('aa')])],
        ]),
        store: env.store,
        log: h.quietLogger(),
      });
      assert.equal(summary.suppressed, 0);
      assert.equal(summary.delivered, 2);
    } finally {
      await hook.close();
    }
  });

  // ── subjects ───────────────────────────────────────────────────────────────

  test('a gateway and a device can hold the same id without colliding', async () => {
    // Dedup is keyed on (subject_kind, subject_id, kind). A gateway EUI and a DevEUI are
    // both 16 hex characters and can legitimately coincide, so subject_kind has to be
    // part of the key — otherwise one would resolve the other away every sounding.
    const same = '0016c001f1e2d3c4';
    const summary = await sound(
      [
        fakeRule('dev', async () => [{ devEui: same, summary: 'device unhappy' }]),
        fakeRule('gw', async () => [
          { subject: { kind: 'gateway', id: same, name: 'north-mast' }, summary: 'gateway unhappy' },
        ]),
      ],
      [
        { rule: 'dev', as: 'dev', enabled: true },
        { rule: 'gw', as: 'gw', enabled: true },
      ],
    );
    assert.equal(summary.raised, 2);

    const rows = await env.store.query(
      `SELECT subject_kind, subject_id, dev_eui, device_name, subject_name
         FROM leadsman.alert ORDER BY subject_kind`,
    );
    assert.equal(rows.length, 2);

    // The device row keeps dev_eui populated, so consumers predating subjects work on.
    const device = rows.find((r) => r.subject_kind === 'device');
    assert.equal(device.dev_eui, same);

    // The gateway row leaves it NULL rather than filing a gateway fault against a
    // device that does not exist.
    const gateway = rows.find((r) => r.subject_kind === 'gateway');
    assert.equal(gateway.subject_id, same);
    assert.equal(gateway.dev_eui, null);
    assert.equal(gateway.device_name, null);
    assert.equal(gateway.subject_name, 'north-mast');
  });

  test('a check writes and reads its own state across soundings, namespaced by kind', async () => {
    // Two instances of one rule must not share memory — that is what would make a
    // per-site threshold in one instance overwrite another's.
    const seen = [];
    const remember = {
      id: 'remember',
      description: 'test rule that remembers something across soundings',
      defaultSeverity: 'info',
      defaultRouting: 'fact',
      defaultParams: {},
      requires: [{ table: 'event_up', columns: ['dev_eui'] }],
      async run(ctx) {
        seen.push([ctx.kind, (await ctx.state.get('v'))?.value ?? null]);
        await ctx.state.set('v', ctx.kind);
        return [];
      },
    };

    const opts = {
      config: {
        schedule: '* * * * *',
        statementTimeoutMs: 15_000,
        checks: [
          { rule: 'remember', as: 'one', enabled: true },
          { rule: 'remember', as: 'two', enabled: true },
        ],
      },
      rules: new Map([['remember', remember]]),
      store: env.store,
      log: h.quietLogger(),
    };

    await runSounding(opts);
    await runSounding(opts);

    assert.deepEqual(seen, [
      ['one', null], ['two', null],       // nothing remembered yet
      ['one', 'one'], ['two', 'two'],     // each sees only its own
    ]);
  });

  test('--dry-run writes no check state, so the next real sounding still sees the change', async () => {
    // A dry run that recorded a new host address would make the real sounding afterwards
    // find no difference and report nothing — the outage would go unexplained.
    const rule = {
      id: 'drystate',
      description: 'test rule that records something in its own state',
      defaultSeverity: 'info',
      defaultRouting: 'fact',
      defaultParams: {},
      requires: [{ table: 'event_up', columns: ['dev_eui'] }],
      async run(ctx) {
        await ctx.state.set('v', 'written');
        return [];
      },
    };
    const opts = {
      config: {
        schedule: '* * * * *',
        statementTimeoutMs: 15_000,
        checks: [{ rule: 'drystate', as: 'drystate', enabled: true }],
      },
      rules: new Map([['drystate', rule]]),
      store: env.store,
      log: h.quietLogger(),
    };

    await runSounding({ ...opts, dryRun: true });
    assert.equal(await env.store.getEngineState('drystate:v'), null);

    await runSounding(opts);
    assert.equal((await env.store.getEngineState('drystate:v')).value, 'written');
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
    // Both schemas, and the same unqualified-means-public rule verify applies: most
    // checks read ChirpStack's event tables in public, and a few read Leadsman's own in
    // the leadsman schema.
    const live = await env.store.describeTables(['public', 'leadsman']);
    const problems = [];
    for (const [id, rule] of loadRules()) {
      for (const req of rule.requires) {
        const qualified = req.table.includes('.') ? req.table : `public.${req.table}`;
        const cols = live.get(qualified);
        if (!cols) { problems.push(`${id}: table ${qualified} missing`); continue; }
        for (const col of req.columns) {
          if (!cols.has(col)) problems.push(`${id}: ${qualified}.${col} missing`);
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

test('a pool error handler is attached, so an idle-connection failure cannot crash serve', async () => {
  // Regression: node-postgres emits 'error' on the Pool when an IDLE client dies, which is
  // what a Postgres restart looks like to a resident `serve`. With no listener that becomes an
  // uncaught exception and the engine exits(1) — a transient database outage killed it.
  // Asserting the listener exists is the cheap proxy for "does not crash"; the behavioural
  // proof needs a real server to stop, which the container test covers.
  const store = new Store({ connectionString: h.url, statementTimeoutMs: 5000 });
  try {
    const pool = store.pool;
    assert.ok(pool, 'could not reach the pool to inspect its listeners');
    assert.ok(
      pool.listenerCount('error') >= 1,
      'the Pool must have an error listener or an idle-client failure is an uncaught exception',
    );
    // And it must not throw when one fires.
    pool.emit('error', new Error('simulated idle client failure'));
  } finally {
    await store.close();
  }
});
