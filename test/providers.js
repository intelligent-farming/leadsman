// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Wire-format tests for the messaging providers.
//
// These exist because a provider is only useful if the request matches what the vendor
// actually accepts, and getting that wrong fails at 3am against a live API rather than in a
// unit test. So each test stands up a fake endpoint and asserts the exact shape: Twilio is
// form-encoded with basic auth (a JSON body is a 400), Telegram is JSON to a bot-token path,
// Signal is a single JSON POST carrying all recipients.
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
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  return { seen, port, close: () => server.close() };
}

const ok201 = (req, res) => res.writeHead(201, { 'content-type': 'application/json' }).end('{}');

test('renderMessage is one readable line inside an SMS segment', () => {
  const line = renderMessage(alert());
  assert.equal(
    line,
    'Leadsman [CRITICAL] pipe-pressure-low: pipe-dry pressure.gauge 4kPa is below min 20kPa',
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
