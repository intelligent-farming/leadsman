// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Database-backed tests for the radio-layer checks: src/gateway.ts, the gateway scope
// predicate, and the rules that read rx_info.
//
// The smoke tests cover these rules with mocked query rows, which proves the rule logic
// and nothing about the SQL — and most of what can go wrong here is SQL: a guard Postgres
// does not evaluate in the order it is written, a key spelled the way one ChirpStack
// version spells it, a statistic taken over the wrong window. Every case below builds the
// smallest event store that tells the fixed behaviour from the broken one.
//
// rx_info is written in the camelCase shape ChirpStack v4 stores (pbjson), except where a
// case is specifically about the snake_case fallback.

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers/db.js');
const { loadRules } = require('../dist/registry.js');
const { gatewayActivity, gatewayTimekeeping, gatewayRedundancy } = require('../dist/gateway.js');
const { ANY_DEVICE, ANY_GATEWAY } = require('../dist/scope.js');

/**
 * Insert one uplink every `stepMin` minutes from `fromMin` ago to `toMin` ago.
 *
 * `rx` is a SQL expression for rx_info, evaluated per row with `ts` bound to that row's
 * time — so a fixture can derive gwTime/nsTime from the reception time, which is how
 * ChirpStack's own values relate. Test-authored constants only.
 */
async function bulk(db, { devEui, fromMin, toMin = 0, stepMin = 1, rx, profile = 'test-profile', name = null }) {
  await db.query(
    `INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
     SELECT ts, $1, $2, $3, '{}'::jsonb, ${rx}
       FROM (SELECT now() - make_interval(mins => m) AS ts
               FROM generate_series($4::int, $5::int, -$6::int) AS m) s`,
    [devEui, name, profile, fromMin, toMin, stepMin],
  );
}

/** ISO text for a timestamp expression, the way pbjson writes a Timestamp. */
const iso = (expr) => `(to_json(${expr}) #>> '{}')`;

/** One camelCase rx_info entry. `extra` is SQL for further jsonb_build_object pairs. */
const entry = (gw, { rssi = -95, snr = 9.5, extra = '' } = {}) =>
  `jsonb_build_object('gatewayId', '${gw}', 'rssi', ${rssi}, 'snr', ${snr}${extra ? `, ${extra}` : ''})`;
const arr = (...entries) => `jsonb_build_array(${entries.join(', ')})`;

const GW_A = 'aaaa00000000000a';
const GW_B = 'aaaa00000000000b';

if (!h.available) {
  test('database-backed gateway tests', { skip: h.skipMessage }, () => {});
} else {
  let env;
  let rules;
  test.before(async () => {
    env = await h.setup('gateway');
    rules = loadRules();
  });
  test.after(async () => { await h.teardown(env); });
  test.beforeEach(async () => { await h.reset(env.db); });

  const run = (id, opts = {}) => {
    const rule = rules.get(id);
    const c = h.ctx(env.store, { ...opts, params: { ...rule.defaultParams, ...(opts.params ?? {}) } });
    return rule.run(c);
  };

  // ── H14: the rx_info shape guard ─────────────────────────────────────────────

  test('a non-array rx_info row does not abort signal-degraded or the rx_info helpers', async () => {
    await bulk(env.db, { devEui: 'd1', fromMin: 250, stepMin: 10, rx: arr(entry(GW_A, { rssi: -120 })) });
    // The row the AND-conjunct guard failed on: "cannot get array length of a non-array".
    await h.uplink(env.db, { devEui: 'd1', minutesAgo: 3, rxInfo: { rssi: -100 } });
    await h.uplink(env.db, { devEui: 'd1', minutesAgo: 4, rxInfo: 'not-an-array' });

    const findings = await run('signal-degraded');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].detail.uplinks, 26, 'the malformed rows are skipped, not counted');

    // Every rx_info reader in src/gateway.ts must survive the same rows.
    const c = h.ctx(env.store);
    assert.equal((await gatewayActivity(c, 24, ANY_GATEWAY)).length, 1);
    assert.equal((await gatewayTimekeeping(c, 24, 168, ANY_GATEWAY)).length, 1);
    assert.equal((await gatewayRedundancy(c, 336, 24, 0.5, ANY_DEVICE)).length, 1);
    await run('gateway-flapping');
    await run('gateway-silent');
  });

  // ── L17: best-gateway SNR comes from the best-RSSI gateway ───────────────────

  test('signal-degraded reports the SNR of the best-RSSI gateway, not the best SNR anywhere', async () => {
    // B has the better RSSI and the worse SNR. The link that carried the uplink is B's.
    await bulk(env.db, {
      devEui: 'd1', fromMin: 250, stepMin: 10,
      rx: arr(entry(GW_A, { rssi: -120, snr: 10 }), entry(GW_B, { rssi: -118, snr: -5 })),
    });
    const findings = await run('signal-degraded');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].detail.avgRssiDbm, -118);
    assert.equal(findings[0].detail.avgSnrDb, -5);
  });

  test('signal-degraded breaks an RSSI tie toward the higher SNR', async () => {
    await bulk(env.db, {
      devEui: 'd1', fromMin: 250, stepMin: 10,
      rx: arr(entry(GW_A, { rssi: -118, snr: -7 }), entry(GW_B, { rssi: -118, snr: 3 })),
    });
    const findings = await run('signal-degraded');
    assert.equal(findings[0].detail.avgSnrDb, 3);
  });

  // ── H7 / H8 / H9: gateway-time-unsynced ──────────────────────────────────────

  const timed = (gw, { gps = true, gwSkewSec = 0, ns = true } = {}) => entry(gw, {
    extra: [
      `'gwTime', ${iso(`ts + make_interval(secs => ${gwSkewSec})`)}`,
      ns ? `'nsTime', ${iso('ts')}` : null,
      gps ? `'timeSinceGpsEpoch', '1411000000.000s'` : null,
    ].filter(Boolean).join(', '),
  });

  test('gateway-time-unsynced stays in breach once every reception in the window lacks a timestamp', async () => {
    // Stamped for days, then nothing at all for the whole 24 h window. Judged inside the
    // window alone this looked like "never supplied" and the open alert resolved.
    await bulk(env.db, { devEui: 'd1', fromMin: 100 * 60, toMin: 25 * 60, stepMin: 5, rx: arr(timed(GW_A)) });
    await bulk(env.db, { devEui: 'd1', fromMin: 23 * 60, stepMin: 5, rx: arr(entry(GW_A)) });

    const findings = await run('gateway-time-unsynced');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].detail.trigger, 'missing-timestamps');
    assert.equal(findings[0].detail.timestampedReceptions, 0);
  });

  test('gateway-time-unsynced still ignores a gateway that never supplied a timestamp', async () => {
    await bulk(env.db, { devEui: 'd1', fromMin: 100 * 60, stepMin: 5, rx: arr(entry(GW_A)) });
    assert.deepEqual(await run('gateway-time-unsynced'), []);
  });

  test('gateway-time-unsynced raises "GPS time lost" while gwTime continues from the system clock', async () => {
    await bulk(env.db, { devEui: 'd1', fromMin: 60 * 60, toMin: 25 * 60, stepMin: 5, rx: arr(timed(GW_A)) });
    // Lock lost: every reception still has gwTime (and a correct one), none has GPS time.
    await bulk(env.db, { devEui: 'd1', fromMin: 23 * 60, stepMin: 5, rx: arr(timed(GW_A, { gps: false })) });

    const findings = await run('gateway-time-unsynced');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].detail.trigger, 'gps-time-lost');
    assert.match(findings[0].summary, /GPS time lost/);
    assert.equal(findings[0].detail.timestampedRatio, 1, 'distinct from "no timestamp at all"');
  });

  test('gateway-time-unsynced does not call a gateway without a GPS receiver "GPS lost"', async () => {
    await bulk(env.db, { devEui: 'd1', fromMin: 60 * 60, stepMin: 5, rx: arr(timed(GW_A, { gps: false })) });
    assert.deepEqual(await run('gateway-time-unsynced'), []);
  });

  test('gateway-time-unsynced measures skew against nsTime, not the gateway-derived event time', async () => {
    // 15 s fast. ChirpStack v4 would set event_up.time FROM gwTime here (within its 30 s
    // rx_timestamp_max_drift), so the event time carries the same error and the old
    // comparison saw zero. The fixture writes exactly that: time = gwTime, nsTime = truth.
    await env.db.query(
      `INSERT INTO event_up (time, dev_eui, device_profile_name, object, rx_info)
       SELECT gw, 'd1', 'p', '{}'::jsonb,
              jsonb_build_array(jsonb_build_object(
                'gatewayId', $1::text, 'rssi', -95, 'snr', 9,
                'gwTime', to_json(gw) #>> '{}', 'nsTime', to_json(ns) #>> '{}'))
         FROM (SELECT now() - make_interval(mins => m) AS ns,
                      now() - make_interval(mins => m) + interval '15 seconds' AS gw
                 FROM generate_series(600, 1, -5) m) s`,
      [GW_A],
    );
    const findings = await run('gateway-time-unsynced');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].detail.trigger, 'clock-skew');
    assert.equal(findings[0].detail.skewReference, 'nsTime');
    assert.ok(Math.abs(findings[0].detail.maxSkewSeconds - 15) < 0.01);
  });

  test('gateway-time-unsynced falls back to the event time without nsTime, and says so', async () => {
    await bulk(env.db, {
      devEui: 'd1', fromMin: 600, stepMin: 5, rx: arr(timed(GW_A, { gwSkewSec: 40, ns: false })),
    });
    const findings = await run('gateway-time-unsynced');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].detail.skewReference, 'eventTime');
    assert.match(findings[0].detail.skewReferenceNote, /rx_timestamp_max_drift/);
  });

  // ── M11 / M12: gateway-silent ────────────────────────────────────────────────

  test('gateway-silent keeps an already-open alert open when the rest of the site goes dark', async () => {
    // A died 10 h ago; B carried on until 2 h ago, then the whole site went dark.
    await bulk(env.db, { devEui: 'd1', fromMin: 48 * 60, toMin: 10 * 60, stepMin: 10, rx: arr(entry(GW_A)) });
    await bulk(env.db, { devEui: 'd2', fromMin: 48 * 60, toMin: 120, stepMin: 10, rx: arr(entry(GW_B)) });

    // A's alert was already open: it must stay open rather than resolve mid-outage.
    const kept = await run('gateway-silent', { openDevEuis: new Set([GW_A]) });
    assert.deepEqual(kept.map((f) => f.subject.id), [GW_A]);
    assert.equal(kept[0].detail.siteWideOutage, true);

    // Nothing open: the site-wide event is fleet-silent's, so no new raises.
    assert.deepEqual(await run('gateway-silent'), []);
  });

  test('gateway-silent leaves a gateway ChirpStack says is online to gateway-deaf', async () => {
    await bulk(env.db, { devEui: 'd1', fromMin: 48 * 60, toMin: 10 * 60, stepMin: 10, rx: arr(entry(GW_A)) });
    await bulk(env.db, { devEui: 'd2', fromMin: 48 * 60, stepMin: 10, rx: arr(entry(GW_B)) });
    const registry = (lastSeenAt) => ({
      listGateways: async () => [
        { gatewayId: GW_A, name: 'north', description: null, createdAt: null, lastSeenAt, state: 'ONLINE' },
        { gatewayId: GW_B, name: 'south', description: null, createdAt: null,
          lastSeenAt: new Date().toISOString(), state: 'ONLINE' },
      ],
    });

    // Online in the registry: deaf, not offline — gateway-deaf's alert, not this one's.
    const online = registry(new Date(Date.now() - 60_000).toISOString());
    assert.deepEqual(await run('gateway-silent', { gateways: online }), []);

    // And gateway-deaf does report it (6 h of nothing, peers busy), so exactly one fires.
    await env.db.query(`DELETE FROM event_up WHERE dev_eui = 'd1' AND time > now() - interval '7 hours'`);
    const deaf = await run('gateway-deaf', { gateways: online });
    assert.deepEqual(deaf.map((f) => f.subject.id), [GW_A]);

    // Offline in the registry: gateway-silent's.
    const offline = registry(new Date(Date.now() - 10 * 3600_000).toISOString());
    assert.deepEqual((await run('gateway-silent', { gateways: offline })).map((f) => f.subject.id), [GW_A]);

    // Deferral disabled, no registry, or a failing registry: reported as before.
    assert.equal((await run('gateway-silent', { gateways: online, params: { onlineWithinMinutes: null } })).length, 1);
    assert.equal((await run('gateway-silent')).length, 1);
    const broken = { listGateways: async () => { throw new Error('HTTP 401'); } };
    assert.equal((await run('gateway-silent', { gateways: broken })).length, 1);
  });

  // ── M13 / L11: gateway-redundancy-lost ───────────────────────────────────────

  test('gateway-redundancy-lost: one stray double reception does not set the baseline', async () => {
    await bulk(env.db, { devEui: 'd1', fromMin: 200 * 60, stepMin: 60, rx: arr(entry(GW_A)) });
    await h.uplink(env.db, {
      devEui: 'd1', minutesAgo: 150 * 60 + 30,
      rxInfo: [{ gatewayId: GW_A, rssi: -95 }, { gatewayId: GW_B, rssi: -120 }],
    });
    assert.deepEqual(await run('gateway-redundancy-lost'), []);
  });

  test('gateway-redundancy-lost: a typical two-gateway device that drops to one is reported', async () => {
    await bulk(env.db, {
      devEui: 'd1', fromMin: 200 * 60, toMin: 25 * 60, stepMin: 60, rx: arr(entry(GW_A), entry(GW_B)),
    });
    await bulk(env.db, { devEui: 'd1', fromMin: 23 * 60, stepMin: 60, rx: arr(entry(GW_A)) });
    const findings = await run('gateway-redundancy-lost');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].detail.historicalGateways, 2);
    assert.equal(findings[0].detail.recentMaxGateways, 1);
  });

  test('gateway-redundancy-lost counts distinct gateways, not rx_info entries', async () => {
    await bulk(env.db, {
      devEui: 'd1', fromMin: 200 * 60, toMin: 25 * 60, stepMin: 60, rx: arr(entry(GW_A), entry(GW_B)),
    });
    // Now only A, reporting each uplink through two boards: one gateway, two entries.
    await bulk(env.db, {
      devEui: 'd1', fromMin: 23 * 60, stepMin: 60,
      rx: arr(entry(GW_A), entry(GW_A.toUpperCase(), { rssi: -99 })),
    });
    const findings = await run('gateway-redundancy-lost');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].detail.recentMaxGateways, 1);
  });

  // ── M14: fleet-silent's join discriminator is scoped ─────────────────────────

  test('fleet-silent ignores joins from devices outside its scope', async () => {
    await bulk(env.db, { devEui: 'd1', fromMin: 600, toMin: 120, stepMin: 10, profile: 'in', rx: arr(entry(GW_A)) });
    await bulk(env.db, { devEui: 'd2', fromMin: 600, toMin: 120, stepMin: 10, profile: 'in', rx: arr(entry(GW_A)) });
    await env.db.query(
      `INSERT INTO event_join (time, dev_eui, device_name, device_profile_name)
       VALUES (now() - interval '2 minutes', 'zz', 'other', 'out')`,
    );
    const findings = await run('fleet-silent', { params: { deviceProfiles: ['in'] } });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].detail.joinsSinceThreshold, 0);
    assert.match(findings[0].summary, /check that the gateways can still reach this host/);

    // The same join from an in-scope device does flip the diagnosis.
    await env.db.query(`UPDATE event_join SET device_profile_name = 'in'`);
    const inScope = await run('fleet-silent', { params: { deviceProfiles: ['in'] } });
    assert.equal(inScope[0].detail.joinsSinceThreshold, 1);
  });

  // ── L12 / M29: gateway id spelling ───────────────────────────────────────────

  test('ignoreGateways matches an uppercase rx_info id', async () => {
    await bulk(env.db, { devEui: 'd1', fromMin: 120, stepMin: 10, rx: arr(entry(GW_A.toUpperCase())) });
    await bulk(env.db, { devEui: 'd2', fromMin: 120, stepMin: 10, rx: arr(entry(GW_B)) });
    const rows = await gatewayActivity(h.ctx(env.store), 24, { only: [], ignore: [GW_A] });
    assert.deepEqual(rows.map((r) => r.gatewayId), [GW_B]);
  });

  test('camelCase and snake_case gateway ids are one gateway', async () => {
    await bulk(env.db, { devEui: 'd1', fromMin: 120, stepMin: 10, rx: arr(entry(GW_A)) });
    await bulk(env.db, {
      devEui: 'd2', fromMin: 120, stepMin: 10,
      rx: `jsonb_build_array(jsonb_build_object('gateway_id', '${GW_A}', 'rssi', -95))`,
    });
    const rows = await gatewayActivity(h.ctx(env.store), 24, ANY_GATEWAY);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].devices, 2);
  });
}
