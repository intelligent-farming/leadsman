// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Wire-format tests for the messaging providers.
//
// These exist because a provider is only useful if the request matches what the vendor
// actually accepts, and getting that wrong fails at 3am against a live API rather than in a
// unit test. So each test stands up a fake endpoint and asserts the exact shape: Twilio is
// form-encoded with basic auth (a JSON body is a 400), Telegram is JSON to a bot-token path,
// Signal is a single JSON POST carrying all recipients, Slack is JSON with a bearer token to
// chat.postMessage and answers a rejection with HTTP 200.
//
// The instanceName prefix is checked here too, since it is the one thing that has to look
// identical across all four providers — it is what makes a shared channel legible.
//
// No database: notifyRaised only calls store.markNotified, which is stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { notifyRaised, renderMessage } = require('../dist/notify.js');
const { parseConfig, ConfigError } = require('../dist/config.js');

const alert = (over = {}) => ({
  id: '1',
  ruleId: 'measurement-threshold',
  kind: 'pipe-pressure-low',
  subjectKind: 'device',
  subjectId: 'aaaa000000000001',
  subjectName: 'pipe-dry',
  devEui: 'aaaa000000000001',
  deviceName: 'pipe-dry',
  severity: 'critical',
  summary: 'pipe-dry pressure.gauge 4kPa is below min 20kPa',
  detail: { value: 4 },
  raisedAt: '2026-08-10T12:00:00.000Z',
  ...over,
});

const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

/** Run a fake API for one request, returning what it received. */
async function capture(handler) {
  const seen = [];
  // Tracked so close() can destroy them. `fetch` keeps connections alive, so
  // server.close() alone only stops accepting NEW connections and leaves the idle
  // keep-alive socket open — the listener lingers, its ephemeral port can be handed to
  // the next test's server while a stray request is still in flight, and that request
  // then lands in the wrong test's `seen`. Rare, and it presents as an unrelated
  // assertion failure somewhere else in the file.
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  server.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  return {
    seen,
    port,
    close: () => {
      server.close();
      for (const sock of sockets) sock.destroy();
    },
  };
}

const ok201 = (req, res) => res.writeHead(201, { 'content-type': 'application/json' }).end('{}');

test('renderMessage is one readable line inside an SMS segment', () => {
  const line = renderMessage(alert());
  assert.equal(
    line,
    'Alert from Leadsman: [CRITICAL] pipe-pressure-low: '
      + 'pipe-dry pressure.gauge 4kPa is below min 20kPa',
  );
  // Not a hard limit — longer messages just cost extra segments — but the format should not
  // be the reason an alert spills over.
  assert.ok(line.length <= 160, `message is ${line.length} chars, over one SMS segment`);
});

test('twilio: form-encoded body, basic auth, one POST per recipient', async () => {
  const api = await capture(ok201);
  const marked = [];
  const out = await notifyRaised(
    [alert()],
    {
      destinations: {
        sms: { provider: 'twilio', to: ['+15125550123', '+15125550124'], timeoutMs: 5000 },
      },
      routing: { fact: 'sms' },
      messaging: {
        twilio: {
          accountSid: 'AC123',
          apiKeySid: 'SK456',
          apiKeySecret: 'keysecret',
          from: '+15125550000',
          baseUrl: `http://127.0.0.1:${api.port}`,
        },
      },
    },
    { markNotified: async (id) => void marked.push(id) },
    quietLog,
    new Map([['pipe-pressure-low', { routing: 'fact' }]]),
  );
  api.close();

  assert.equal(out.delivered, 1);
  // One POST per recipient — Twilio's Messages resource takes a single To.
  assert.equal(api.seen.length, 2);
  for (const req of api.seen) {
    assert.equal(req.url, '/2010-04-01/Accounts/AC123/Messages.json');
    assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded');
    // The API Key pair authenticates; the Account SID appears only in the URL. Sending the
    // Account SID as the username would be the old Auth Token scheme.
    assert.equal(
      req.headers.authorization,
      `Basic ${Buffer.from('SK456:keysecret').toString('base64')}`,
    );
    const form = new URLSearchParams(req.body);
    assert.equal(form.get('From'), '+15125550000');
    assert.match(form.get('To'), /^\+1512555012[34]$/);
    assert.equal(form.get('Body'), renderMessage(alert()));
  }
  // One alert, so notified_at is stamped once even though two messages went out.
  assert.deepEqual(marked, ['1']);
});

test('twilio: a partial failure does not stamp notified_at, so the next sounding retries', async () => {
  let n = 0;
  const api = await capture((req, res) => {
    // First recipient succeeds, second is rejected as unverified (trial-account 21608).
    n += 1;
    if (n === 1) return ok201(req, res);
    res.writeHead(400, { 'content-type': 'application/json' })
      .end(JSON.stringify({ code: 21608, message: 'Unverified number' }));
  });
  const marked = [];
  const out = await notifyRaised(
    [alert()],
    {
      destinations: { sms: { provider: 'twilio', to: ['+15125550123', '+15125550124'] } },
      routing: { fact: 'sms' },
      messaging: {
        twilio: { accountSid: 'AC1', apiKeySid: 'SK1', apiKeySecret: 's', from: '+1512',
                  baseUrl: `http://127.0.0.1:${api.port}` },
      },
    },
    { markNotified: async (id) => void marked.push(id) },
    quietLog,
    new Map([['pipe-pressure-low', { routing: 'fact' }]]),
  );
  api.close();
  assert.equal(out.failed, 1);
  assert.equal(out.delivered, 0);
  assert.deepEqual(marked, [], 'must stay pending rather than be recorded as delivered');
});

test('telegram: JSON body to the bot-token path, no parse_mode', async () => {
  const api = await capture((req, res) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));
  const out = await notifyRaised(
    [alert()],
    {
      destinations: { tg: { provider: 'telegram', chatId: '-1001234567890' } },
      routing: { fact: 'tg' },
      messaging: { telegram: { botToken: '123:ABC', baseUrl: `http://127.0.0.1:${api.port}` } },
    },
    { markNotified: async () => {} },
    quietLog,
    new Map([['pipe-pressure-low', { routing: 'fact' }]]),
  );
  api.close();

  assert.equal(out.delivered, 1);
  assert.equal(api.seen.length, 1);
  assert.equal(api.seen[0].url, '/bot123:ABC/sendMessage');
  assert.equal(api.seen[0].headers['content-type'], 'application/json');
  const body = JSON.parse(api.seen[0].body);
  assert.equal(body.chat_id, '-1001234567890');
  assert.equal(body.text, renderMessage(alert()));
  // parse_mode is deliberately absent: summaries contain underscores and > which Markdown
  // would reject, failing the whole message.
  assert.equal('parse_mode' in body, false);
});

test('signal: a single JSON POST carrying every recipient', async () => {
  const api = await capture(ok201);
  const out = await notifyRaised(
    [alert()],
    {
      destinations: { sig: { provider: 'signal', to: ['+15125550123', '+15125550124'] } },
      routing: { fact: 'sig' },
      messaging: { signal: { baseUrl: `http://127.0.0.1:${api.port}`, from: '+15125559999' } },
    },
    { markNotified: async () => {} },
    quietLog,
    new Map([['pipe-pressure-low', { routing: 'fact' }]]),
  );
  api.close();

  assert.equal(out.delivered, 1);
  // /v2/send takes recipients as an array, so two numbers is still one request.
  assert.equal(api.seen.length, 1);
  assert.equal(api.seen[0].url, '/v2/send');
  const body = JSON.parse(api.seen[0].body);
  assert.equal(body.number, '+15125559999');
  assert.deepEqual(body.recipients, ['+15125550123', '+15125550124']);
  assert.equal(body.message, renderMessage(alert()));
});

test('slack: JSON body with bearer auth to chat.postMessage', async () => {
  const api = await capture((req, res) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));
  const out = await notifyRaised(
    [alert()],
    {
      destinations: { field: { provider: 'slack', channel: '#field-alerts' } },
      routing: { fact: 'field' },
      messaging: { slack: { botToken: 'xoxb-test', baseUrl: `http://127.0.0.1:${api.port}` } },
    },
    { markNotified: async () => {} },
    quietLog,
    new Map([['pipe-pressure-low', { routing: 'fact' }]]),
  );
  api.close();

  assert.equal(out.delivered, 1);
  assert.equal(api.seen.length, 1);
  assert.equal(api.seen[0].url, '/api/chat.postMessage');
  assert.equal(api.seen[0].headers['content-type'], 'application/json; charset=utf-8');
  // A bot token goes in the Authorization header — Slack rejects it as a query parameter.
  assert.equal(api.seen[0].headers.authorization, 'Bearer xoxb-test');
  const body = JSON.parse(api.seen[0].body);
  assert.deepEqual(body, {
    channel: '#field-alerts',
    text: 'Alert from Leadsman: [CRITICAL] pipe-pressure-low: '
      + 'pipe-dry pressure.gauge 4kPa is below min 20kPa',
  });
});

// ── Slack: the envelope decides, not the status ───────────────────────────────

test('slack: HTTP 200 with ok:false is a FAILURE, not a delivery', async () => {
  // Slack answers a rejected message with 200 and {"ok":false,"error":"..."}. Trusting the
  // status alone would stamp notified_at on an alert nobody received, and no later sounding
  // would retry it — the alert is lost permanently.
  const api = await capture((req, res) =>
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ok: false, error: 'channel_not_found' })));
  const marked = [];
  const warned = [];
  const out = await notifyRaised(
    [alert()],
    {
      destinations: { field: { provider: 'slack', channel: '#nope' } },
      routing: { fact: 'field' },
      messaging: { slack: { botToken: 'xoxb-test', baseUrl: `http://127.0.0.1:${api.port}` } },
    },
    { markNotified: async (id) => void marked.push(id) },
    { ...quietLog, warn: (m, x) => warned.push(x) },
    new Map([['pipe-pressure-low', { routing: 'fact' }]]),
  );
  api.close();
  assert.equal(out.failed, 1);
  assert.equal(out.delivered, 0);
  assert.deepEqual(marked, [], 'a rejected message must stay pending');
  // The reason has to reach the log or the operator is guessing.
  assert.match(warned[0].detail, /channel_not_found/);
  assert.equal(warned[0].status, 200);
});

test('slack: ok:true with 200 delivers', async () => {
  const api = await capture((req, res) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"ts":"1.2"}'));
  const marked = [];
  const out = await notifyRaised(
    [alert()],
    {
      destinations: { field: { provider: 'slack', channel: 'C0123456789' } },
      routing: { fact: 'field' },
      messaging: { slack: { botToken: 'xoxb-test', baseUrl: `http://127.0.0.1:${api.port}` } },
    },
    { markNotified: async (id) => void marked.push(id) },
    quietLog,
    new Map([['pipe-pressure-low', { routing: 'fact' }]]),
  );
  api.close();
  assert.equal(out.delivered, 1);
  assert.deepEqual(marked, ['1']);
});

test('slack: mrkdwn metacharacters in the summary are escaped', async () => {
  // `<` opens Slack's link syntax, so an unescaped summary renders as garbage or swallows the
  // rest of the line. Summaries carry both < and > routinely.
  const api = await capture((req, res) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));
  const out = await notifyRaised(
    [alert({ summary: 'battery 3.15V <= 3.4V & falling > 0.1V/h' })],
    {
      destinations: { field: { provider: 'slack', channel: 'C0123456789' } },
      routing: { fact: 'field' },
      messaging: { slack: { botToken: 'xoxb-test', baseUrl: `http://127.0.0.1:${api.port}` } },
    },
    { markNotified: async () => {} },
    quietLog,
    new Map([['pipe-pressure-low', { routing: 'fact' }]]),
  );
  api.close();

  assert.equal(out.delivered, 1);
  const { text } = JSON.parse(api.seen[0].body);
  assert.equal(
    text,
    'Alert from Leadsman: [CRITICAL] pipe-pressure-low: '
      + 'battery 3.15V &lt;= 3.4V &amp; falling &gt; 0.1V/h',
  );
  // & is replaced first, so the entities the other two introduce are not re-escaped.
  assert.equal(/&amp;(lt|gt);/.test(text), false);
});

// ── naming the edge device ────────────────────────────────────────────────────

test('renderMessage names the sender, falling back to Leadsman when unnamed', () => {
  assert.equal(
    renderMessage(alert(), 'North Barn'),
    'Alert from North Barn: [CRITICAL] pipe-pressure-low: '
      + 'pipe-dry pressure.gauge 4kPa is below min 20kPa',
  );
  // One format whether or not the deployment is named, so a channel carrying both reads the
  // same way and the sender field is never blank.
  const unnamed = 'Alert from Leadsman: [CRITICAL] pipe-pressure-low: '
    + 'pipe-dry pressure.gauge 4kPa is below min 20kPa';
  assert.equal(renderMessage(alert()), unnamed);
  assert.equal(renderMessage(alert(), undefined), unnamed);
  // Blank is unnamed, not a blank sender — including whitespace that reached here directly.
  assert.equal(renderMessage(alert(), ''), unnamed);
  assert.equal(renderMessage(alert(), '   '), unnamed);
});

test('the instance prefix reaches every messaging provider, whatever the body shape', async () => {
  // One renderer, one code path — a provider that built its own line would drift from the
  // others, and a channel shared by several devices would carry two different formats.
  const tw = await capture(ok201);
  const tg = await capture((req, res) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));
  const sig = await capture(ok201);
  const sl = await capture((req, res) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));

  const config = {
    instanceName: 'North Barn',
    destinations: {
      sms: { provider: 'twilio', to: ['+15125550123'] },
      tg: { provider: 'telegram', chatId: '-1001' },
      sig: { provider: 'signal', to: ['+15125550124'] },
      sl: { provider: 'slack', channel: 'C0123456789' },
    },
    messaging: {
      twilio: { accountSid: 'AC1', apiKeySid: 'SK1', apiKeySecret: 's', from: '+1512',
                baseUrl: `http://127.0.0.1:${tw.port}` },
      telegram: { botToken: 'x', baseUrl: `http://127.0.0.1:${tg.port}` },
      signal: { baseUrl: `http://127.0.0.1:${sig.port}`, from: '+15125559999' },
      slack: { botToken: 'xoxb-test', baseUrl: `http://127.0.0.1:${sl.port}` },
    },
  };

  // One alert per destination, routed explicitly at each in turn.
  for (const name of ['sms', 'tg', 'sig', 'sl']) {
    const out = await notifyRaised(
      [alert()],
      config,
      { markNotified: async () => {} },
      quietLog,
      new Map([['pipe-pressure-low', { notifyTo: name, routing: 'fact' }]]),
    );
    assert.equal(out.delivered, 1, `${name} delivered`);
  }
  tw.close(); tg.close(); sig.close(); sl.close();

  // Same line in all four, in whichever field that provider calls the message body.
  const expected = renderMessage(alert(), 'North Barn');
  assert.match(expected, /^Alert from North Barn: \[CRITICAL\]/);
  assert.equal(new URLSearchParams(tw.seen[0].body).get('Body'), expected);
  assert.equal(JSON.parse(tg.seen[0].body).text, expected);
  assert.equal(JSON.parse(sig.seen[0].body).message, expected);
  assert.equal(JSON.parse(sl.seen[0].body).text, expected);
});

test('slack: the instance name is escaped along with the rest of the line', async () => {
  // The prefix is part of the rendered text, so a name carrying an mrkdwn metacharacter has
  // to be neutered too — escaping only the summary would leave a live `<` in every message.
  const api = await capture((req, res) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));
  await notifyRaised(
    [alert()],
    {
      instanceName: 'Barn A & B <east>',
      destinations: { field: { provider: 'slack', channel: 'C0123456789' } },
      routing: { fact: 'field' },
      messaging: { slack: { botToken: 'xoxb-test', baseUrl: `http://127.0.0.1:${api.port}` } },
    },
    { markNotified: async () => {} },
    quietLog,
    new Map([['pipe-pressure-low', { routing: 'fact' }]]),
  );
  api.close();
  const { text } = JSON.parse(api.seen[0].body);
  assert.match(text, /^Alert from Barn A &amp; B &lt;east&gt;: \[CRITICAL\]/);
});

test('webhook: the instance travels as a payload field, and is absent when unnamed', async () => {
  // A webhook receiver gets structure rather than a sentence, so the name is a field. Hermes
  // posting its analysis into the same channel needs it to attribute the alert.
  const named = await capture((req, res) => res.writeHead(204).end());
  await notifyRaised(
    [alert()],
    {
      instanceName: 'North Barn',
      destinations: { hook: { webhookUrl: `http://127.0.0.1:${named.port}/hook` } },
      routing: { fact: 'hook' },
    },
    { markNotified: async () => {} },
    quietLog,
    new Map([['pipe-pressure-low', { routing: 'fact' }]]),
  );
  named.close();
  assert.equal(JSON.parse(named.seen[0].body).instance, 'North Barn');

  const plain = await capture((req, res) => res.writeHead(204).end());
  await notifyRaised(
    [alert()],
    {
      destinations: { hook: { webhookUrl: `http://127.0.0.1:${plain.port}/hook` } },
      routing: { fact: 'hook' },
    },
    { markNotified: async () => {} },
    quietLog,
    new Map([['pipe-pressure-low', { routing: 'fact' }]]),
  );
  plain.close();
  const body = JSON.parse(plain.seen[0].body);
  // Omitted, not null: an existing receiver sees the bytes it always saw.
  assert.equal('instance' in body, false);
  assert.equal(body.schema, 'leadsman.alert/2');
});

test('leadsman.alert/2 adds the subject and leaves every /1 field alone', async () => {
  // The compatibility claim the schema bump rests on: /2 is /1 plus three fields. A
  // receiver written against /1 reads a device alert identically, which is what makes
  // gateway and site alerts an additive change rather than a breaking one.
  const cap = await capture((req, res) => res.writeHead(204).end());
  await notifyRaised(
    [alert()],
    {
      destinations: { hook: { webhookUrl: `http://127.0.0.1:${cap.port}/hook` } },
      routing: { fact: 'hook' },
    },
    { markNotified: async () => {} },
    quietLog,
    new Map([['pipe-pressure-low', { routing: 'fact' }]]),
  );
  cap.close();
  const body = JSON.parse(cap.seen[0].body);

  // Every /1 field, unchanged in name and meaning.
  assert.equal(body.id, '1');
  assert.equal(body.rule, 'measurement-threshold');
  assert.equal(body.kind, 'pipe-pressure-low');
  assert.equal(body.devEui, 'aaaa000000000001');
  assert.equal(body.deviceName, 'pipe-dry');
  assert.equal(body.severity, 'critical');
  assert.equal(body.raisedAt, '2026-08-10T12:00:00.000Z');

  // Plus the subject.
  assert.equal(body.subjectKind, 'device');
  assert.equal(body.subjectId, 'aaaa000000000001');
  assert.equal(body.subjectName, 'pipe-dry');
});

test('a gateway alert carries a null devEui rather than a fake one', async () => {
  // The reason subjects exist. A gateway EUI is also 16 hex characters, so it would fit
  // in devEui perfectly and be wrong — a receiver would file a gateway outage against a
  // device that does not exist.
  const cap = await capture((req, res) => res.writeHead(204).end());
  await notifyRaised(
    [
      alert({
        ruleId: 'gateway-silent',
        kind: 'gateway-silent',
        subjectKind: 'gateway',
        subjectId: '0016c001f1e2d3c4',
        subjectName: 'north-mast',
        devEui: null,
        deviceName: null,
        summary: 'gateway 0016c001f1e2d3c4 has forwarded nothing for 2.5h',
      }),
    ],
    {
      destinations: { hook: { webhookUrl: `http://127.0.0.1:${cap.port}/hook` } },
      routing: { fact: 'hook' },
    },
    { markNotified: async () => {} },
    quietLog,
    new Map([['gateway-silent', { routing: 'fact' }]]),
  );
  cap.close();
  const body = JSON.parse(cap.seen[0].body);

  assert.equal(body.subjectKind, 'gateway');
  assert.equal(body.subjectId, '0016c001f1e2d3c4');
  assert.equal(body.devEui, null);
  assert.equal(body.deviceName, null);
});

test('a provider destination with no credentials fails loudly, not silently', async () => {
  const warned = [];
  const out = await notifyRaised(
    [alert()],
    {
      destinations: { sms: { provider: 'twilio', to: ['+15125550123'] } },
      routing: { fact: 'sms' },
      // messaging deliberately absent
    },
    { markNotified: async () => assert.fail('must not stamp notified_at') },
    { ...quietLog, warn: (m, x) => warned.push([m, x]) },
    new Map([['pipe-pressure-low', { routing: 'fact' }]]),
  );
  assert.equal(out.failed, 1);
  assert.equal(out.delivered, 0);
  assert.match(warned[0][1].detail, /credentials not configured/);
});

// ── config-level validation ───────────────────────────────────────────────────

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const TWILIO_ENV = {
  LEADSMAN_TWILIO_ACCOUNT_SID: 'AC1',
  LEADSMAN_TWILIO_API_KEY_SID: 'SK1',
  LEADSMAN_TWILIO_API_KEY_SECRET: 'keysecret',
  LEADSMAN_TWILIO_FROM: '+15125550000',
};

test('provider credentials are read from the environment, never the config file', () => {
  withEnv(TWILIO_ENV, () => {
    const cfg = parseConfig({
      checks: [],
      notify: {
        destinations: { sms: { provider: 'twilio', to: ['+15125550123'] } },
        routing: { fact: 'sms' },
      },
    });
    assert.equal(cfg.notify.messaging.twilio.accountSid, 'AC1');
    assert.equal(cfg.notify.messaging.twilio.apiKeySid, 'SK1');
    assert.equal(cfg.notify.messaging.twilio.from, '+15125550000');
    // The destination itself carries no secret.
    assert.equal('apiKeySecret' in cfg.notify.destinations.sms, false);
  });
});

test('a provider without its credentials is rejected at config time', () => {
  // Discovering this on the first alert would look like a network fault.
  assert.throws(
    () => parseConfig({
      checks: [],
      notify: {
        destinations: { sms: { provider: 'twilio', to: ['+15125550123'] } },
        routing: { fact: 'sms' },
      },
    }),
    (err) => err instanceof ConfigError && /_API_KEY_SID/.test(err.message),
  );
});

test('recipients must be E.164, because a bare number fails at the carrier', () => {
  withEnv(TWILIO_ENV, () => {
    assert.throws(
      () => parseConfig({
        checks: [],
        notify: {
          destinations: { sms: { provider: 'twilio', to: ['5125550123'] } },
          routing: { fact: 'sms' },
        },
      }),
      (err) => err instanceof ConfigError && /E\.164/.test(err.message),
    );
  });
});

test('telegram requires a chatId', () => {
  withEnv({ LEADSMAN_TELEGRAM_BOT_TOKEN: '123:ABC' }, () => {
    assert.throws(
      () => parseConfig({
        checks: [],
        notify: { destinations: { tg: { provider: 'telegram' } }, routing: { fact: 'tg' } },
      }),
      (err) => err instanceof ConfigError && /needs "chatId"/.test(err.message),
    );
  });
});

test('slack requires a channel', () => {
  withEnv({ LEADSMAN_SLACK_BOT_TOKEN: 'xoxb-test' }, () => {
    assert.throws(
      () => parseConfig({
        checks: [],
        notify: { destinations: { field: { provider: 'slack' } }, routing: { fact: 'field' } },
      }),
      (err) => err instanceof ConfigError && /needs "channel"/.test(err.message),
    );
  });
});

test('slack without a bot token is rejected at config time', () => {
  // Same reason as every other provider: on the first alert this would look like a network
  // fault, and the message would be lost until someone read the log.
  withEnv({ LEADSMAN_SLACK_BOT_TOKEN: undefined }, () => {
    assert.throws(
      () => parseConfig({
        checks: [],
        notify: {
          destinations: { field: { provider: 'slack', channel: '#field-alerts' } },
          routing: { fact: 'field' },
        },
      }),
      (err) => err instanceof ConfigError && /LEADSMAN_SLACK_BOT_TOKEN/.test(err.message),
    );
  });
});

test('slack credentials are read from the environment, never the config file', () => {
  withEnv({ LEADSMAN_SLACK_BOT_TOKEN: 'xoxb-test' }, () => {
    const cfg = parseConfig({
      checks: [],
      notify: {
        destinations: { field: { provider: 'slack', channel: '#field-alerts' } },
        routing: { fact: 'field' },
      },
    });
    assert.equal(cfg.notify.messaging.slack.botToken, 'xoxb-test');
    assert.equal(cfg.notify.messaging.slack.baseUrl, 'https://slack.com');
    assert.equal('botToken' in cfg.notify.destinations.field, false);
  });
});

test('a destination can be switched to another platform entirely from env', () => {
  // The operational point of this feature: change platform without editing a mounted file.
  withEnv(
    {
      ...TWILIO_ENV,
      LEADSMAN_TELEGRAM_BOT_TOKEN: '123:ABC',
      LEADSMAN_DEST_SMS_PROVIDER: 'telegram',
      LEADSMAN_DEST_SMS_CHAT_ID: '-100999',
    },
    () => {
      const cfg = parseConfig({
        checks: [],
        notify: {
          // The file says Twilio; the environment overrides it to Telegram.
          destinations: { sms: { provider: 'twilio', to: ['+15125550123'] } },
          routing: { fact: 'sms' },
        },
      });
      assert.equal(cfg.notify.destinations.sms.provider, 'telegram');
      assert.equal(cfg.notify.destinations.sms.chatId, '-100999');
    },
  );
});

test('a destination can be switched to slack from env, channel included', () => {
  withEnv(
    {
      ...TWILIO_ENV,
      LEADSMAN_SLACK_BOT_TOKEN: 'xoxb-test',
      LEADSMAN_DEST_SMS_PROVIDER: 'slack',
      LEADSMAN_DEST_SMS_CHANNEL: 'C0123456789',
    },
    () => {
      const cfg = parseConfig({
        checks: [],
        notify: {
          // The file says Twilio; the environment overrides it to Slack.
          destinations: { sms: { provider: 'twilio', to: ['+15125550123'] } },
          routing: { fact: 'sms' },
        },
      });
      assert.equal(cfg.notify.destinations.sms.provider, 'slack');
      assert.equal(cfg.notify.destinations.sms.channel, 'C0123456789');
    },
  );
});

test('recipients can be overridden as a comma-separated env list', () => {
  withEnv({ ...TWILIO_ENV, LEADSMAN_DEST_SMS_TO: '+15125550999, +15125550888' }, () => {
    const cfg = parseConfig({
      checks: [],
      notify: {
        destinations: { sms: { provider: 'twilio', to: ['+15125550123'] } },
        routing: { fact: 'sms' },
      },
    });
    assert.deepEqual(cfg.notify.destinations.sms.to, ['+15125550999', '+15125550888']);
  });
});

test('instanceName comes from the env first, since the file is shared across devices', () => {
  withEnv({ ...TWILIO_ENV, LEADSMAN_INSTANCE_NAME: 'North Barn' }, () => {
    const cfg = parseConfig({
      checks: [],
      notify: {
        // The file names one device; this host is a different one. Env wins, which is what
        // lets a fleet share a single committed config.
        instanceName: 'from-the-file',
        destinations: { sms: { provider: 'twilio', to: ['+15125550123'] } },
        routing: { fact: 'sms' },
      },
    });
    assert.equal(cfg.notify.instanceName, 'North Barn');
  });
});

test('instanceName can still be set in the file, and is absent when neither sets it', () => {
  withEnv({ ...TWILIO_ENV, LEADSMAN_INSTANCE_NAME: undefined }, () => {
    const base = {
      destinations: { sms: { provider: 'twilio', to: ['+15125550123'] } },
      routing: { fact: 'sms' },
    };
    assert.equal(
      parseConfig({ checks: [], notify: { ...base, instanceName: '  East Field  ' } })
        .notify.instanceName,
      'East Field',
      'surrounding whitespace is trimmed, or it would show up in every message',
    );
    assert.equal(parseConfig({ checks: [], notify: base }).notify.instanceName, undefined);
  });
});

test('a blank instanceName means unnamed, and the message says "Alert from Leadsman"', () => {
  // Blank is not worth failing a deployment over: a `VAR=` line in a .env, or a key someone
  // emptied out, lands on the same fallback an absent key gets.
  withEnv({ ...TWILIO_ENV, LEADSMAN_INSTANCE_NAME: '   ' }, () => {
    const cfg = parseConfig({
      checks: [],
      notify: {
        instanceName: '',
        destinations: { sms: { provider: 'twilio', to: ['+15125550123'] } },
        routing: { fact: 'sms' },
      },
    });
    assert.equal(cfg.notify.instanceName, undefined);
    assert.match(renderMessage(alert(), cfg.notify.instanceName), /^Alert from Leadsman: /);
  });
});

test('instanceName rejects the values that would corrupt every message', () => {
  withEnv({ ...TWILIO_ENV, LEADSMAN_INSTANCE_NAME: undefined }, () => {
    const withName = (instanceName) => () => parseConfig({
      checks: [],
      notify: {
        instanceName,
        destinations: { sms: { provider: 'twilio', to: ['+15125550123'] } },
        routing: { fact: 'sms' },
      },
    });
    // A non-string is a mistake rather than "unnamed" — blank already has a meaning.
    assert.throws(withName(42),
      (err) => err instanceof ConfigError && /must be a string/.test(err.message));
    // A newline would split one alert into two lines in the channel.
    assert.throws(withName('North\nBarn'),
      (err) => err instanceof ConfigError && /line breaks or control characters/.test(err.message));
    // Every message pays for the prefix, and an SMS segment is 160 characters.
    assert.throws(withName('x'.repeat(65)),
      (err) => err instanceof ConfigError && /65 characters/.test(err.message));
    // The boundary itself is fine.
    assert.equal(withName('x'.repeat(64))().notify.instanceName, 'x'.repeat(64));
  });
});

test('a webhook destination still requires a URL; a provider one does not', () => {
  withEnv(TWILIO_ENV, () => {
    assert.throws(
      () => parseConfig({
        checks: [],
        notify: { destinations: { hook: {} }, routing: { fact: 'hook' } },
      }),
      (err) => err instanceof ConfigError && /webhookUrl must be a non-empty string/.test(err.message),
    );
    // Same empty object, but as a provider — valid, because recipients replace the URL.
    const cfg = parseConfig({
      checks: [],
      notify: {
        destinations: { sms: { provider: 'twilio', to: ['+15125550123'] } },
        routing: { fact: 'sms' },
      },
    });
    assert.equal(cfg.notify.destinations.sms.webhookUrl, undefined);
  });
});

// ── Telegram: the envelope decides, not the status ────────────────────────────

test('telegram: HTTP 200 with ok:false is a FAILURE, not a delivery', async () => {
  // Telegram answers in an envelope. Trusting the status alone would stamp notified_at on a
  // message the API rejected, and no later sounding would retry it — the alert is lost.
  const api = await capture((req, res) =>
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' })));
  const marked = [];
  const warned = [];
  const out = await notifyRaised(
    [alert()],
    {
      destinations: { tg: { provider: 'telegram', chatId: '-100BAD' } },
      routing: { fact: 'tg' },
      messaging: { telegram: { botToken: 'x', baseUrl: `http://127.0.0.1:${api.port}` } },
    },
    { markNotified: async (id) => void marked.push(id) },
    { ...quietLog, warn: (m, x) => warned.push(x) },
    new Map([['pipe-pressure-low', { routing: 'fact' }]]),
  );
  api.close();
  assert.equal(out.failed, 1);
  assert.equal(out.delivered, 0);
  assert.deepEqual(marked, [], 'a rejected message must stay pending');
  // The reason has to reach the log or the operator is guessing.
  assert.match(warned[0].detail, /chat not found/);
  assert.equal(warned[0].status, 200);
});

test('telegram: ok:true with 200 still delivers', async () => {
  const api = await capture((req, res) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"result":{}}'));
  const out = await notifyRaised(
    [alert()],
    {
      destinations: { tg: { provider: 'telegram', chatId: '-1001' } },
      routing: { fact: 'tg' },
      messaging: { telegram: { botToken: 'x', baseUrl: `http://127.0.0.1:${api.port}` } },
    },
    { markNotified: async () => {} },
    quietLog,
    new Map([['pipe-pressure-low', { routing: 'fact' }]]),
  );
  api.close();
  assert.equal(out.delivered, 1);
});

// ── Signal: groups are addressed by id, not by number ─────────────────────────

test('signal: a group id is a valid recipient alongside numbers', () => {
  withEnv({ LEADSMAN_SIGNAL_BASE_URL: 'http://signal:8080', LEADSMAN_SIGNAL_FROM: '+15125559999' }, () => {
    const cfg = parseConfig({
      checks: [],
      notify: {
        destinations: {
          field: { provider: 'signal', to: ['+15125550123', 'group.dGVzdEdyb3VwSWQ='] },
        },
        routing: { fact: 'field' },
      },
    });
    assert.deepEqual(cfg.notify.destinations.field.to,
      ['+15125550123', 'group.dGVzdEdyb3VwSWQ=']);
  });
});

test('signal: a malformed recipient is still rejected, and the error mentions groups', () => {
  withEnv({ LEADSMAN_SIGNAL_BASE_URL: 'http://signal:8080', LEADSMAN_SIGNAL_FROM: '+15125559999' }, () => {
    assert.throws(
      () => parseConfig({
        checks: [],
        notify: {
          destinations: { field: { provider: 'signal', to: ['5125550123'] } },
          routing: { fact: 'field' },
        },
      }),
      (err) => err instanceof ConfigError && /Signal group id/.test(err.message),
    );
  });
});

test('twilio does NOT accept a group id — there is no such concept', () => {
  // Letting one through would surface as a Twilio 21211 at send time instead of here.
  withEnv({
    LEADSMAN_TWILIO_ACCOUNT_SID: 'AC1', LEADSMAN_TWILIO_API_KEY_SID: 'SK1',
    LEADSMAN_TWILIO_API_KEY_SECRET: 's', LEADSMAN_TWILIO_FROM: '+15125550000',
  }, () => {
    assert.throws(
      () => parseConfig({
        checks: [],
        notify: {
          destinations: { sms: { provider: 'twilio', to: ['group.dGVzdA=='] } },
          routing: { fact: 'sms' },
        },
      }),
      (err) => err instanceof ConfigError && !/Signal group id/.test(err.message),
    );
  });
});

test('signal: group ids are sent through in the recipients array', async () => {
  const api = await capture(ok201);
  await notifyRaised(
    [alert()],
    {
      destinations: { field: { provider: 'signal', to: ['group.dGVzdA=='] } },
      routing: { fact: 'field' },
      messaging: { baseUrl: undefined, signal: { baseUrl: `http://127.0.0.1:${api.port}`, from: '+1512' } },
    },
    { markNotified: async () => {} },
    quietLog,
    new Map([['pipe-pressure-low', { routing: 'fact' }]]),
  );
  api.close();
  assert.deepEqual(JSON.parse(api.seen[0].body).recipients, ['group.dGVzdA==']);
});
