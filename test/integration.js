// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Integration assertions against a real Postgres seeded with test/fixtures/seed.sql.
//
// This is where check SQL is actually validated. The smoke suite can only confirm that
// a rule maps rows to findings; it cannot catch a query that returns the wrong rows, a
// JSONB path that never resolves, a multi-path priority that silently skips a device,
// or an ON CONFLICT clause that fails to deduplicate. Those only show up against a
// database.
//
// Assumes `leadsman migrate` and one `leadsman run` have already happened (see the CI
// workflow). Run locally with:
//   LEADSMAN_DATABASE_URL=... LEADSMAN_CONFIG=test/fixtures/integration.json \
//     node dist/cli.js migrate && node dist/cli.js run && node test/integration.js

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');

const CONFIG = process.env.LEADSMAN_CONFIG ?? 'test/fixtures/integration.json';

// Every seeded fault, and the check that must catch it. One alert each, no more.
const EXPECTED = [
  ['0000000000000001', 'device-silent'],
  ['0000000000000002', 'battery-low'],
  ['0000000000000003', 'decode-failure'],
  ['0000000000000004', 'soil-moisture-missing'],
  ['0000000000000005', 'signal-degraded'],
  ['0000000000000006', 'decode-failure'],
  ['0000000000000101', 'frost-risk'],
  ['0000000000000102', 'frost-risk'],
  ['0000000000000103', 'heat-stress'],
  ['0000000000000104', 'temperature-crash'],
  ['0000000000000201', 'wind-gust'],
  ['0000000000000202', 'anemometer-stuck'],
  ['0000000000000301', 'soil-moisture-low'],
  ['0000000000000302', 'soil-probe-stuck'],
  ['0000000000000303', 'soil-salinity-high'],
  ['0000000000000401', 'tank-draining-fast'],
  ['0000000000000402', 'tank-low'],
  ['0000000000000501', 'water-burst'],
  ['0000000000000502', 'water-meter-stalled'],
  ['0000000000000503', 'water-meter-stalled'],
  ['0000000000000601', 'dissolved-oxygen-low'],
  ['0000000000000602', 'co2-high'],
  ['0000000000000701', 'leaf-wetness-high'],
  ['0000000000000702', 'pump-vibration-high'],
  ['0000000000000801', 'water-leak'],
  ['0000000000000802', 'contact-open'],
  ['0000000000000901', 'asset-left-property'],
  // Network-layer faults: each device below sends healthy uplinks, so these are
  // invisible in event_up and only appear in event_log/status/join/ack.
  ['00000000000000a1', 'chirpstack-errors'],
  ['00000000000000a2', 'mac-battery'],
  ['00000000000000a3', 'mac-margin'],
  ['00000000000000a4', 'rejoining'],
  ['00000000000000a5', 'commands-failing'],
];

// Controls. Any alert on one of these is a check firing where it should not.
const HEALTHY = [
  '00000000000000ff', // healthy soil node
  '00000000000000fe', // healthy weather station
  '00000000000000fd', // GPS tracker inside the fence
  '00000000000000fc', // water meter with plausible consumption
  '00000000000000a6', // mains-powered: battery figure is meaningless, must be ignored
  '00000000000000a7', // device reports battery_level_unavailable
  '00000000000000af', // healthy across every network table (code-7 noise only)
];

function sounding() {
  execFileSync(process.execPath, ['dist/cli.js', 'run'], {
    env: { ...process.env, LEADSMAN_CONFIG: CONFIG },
    stdio: 'inherit',
  });
}

async function main() {
  const db = new Client({ connectionString: process.env.LEADSMAN_DATABASE_URL });
  await db.connect();

  const open = async () => {
    const { rows } = await db.query(
      'SELECT kind, dev_eui, severity, summary, detail FROM leadsman.open_alert ORDER BY kind, dev_eui',
    );
    return rows;
  };

  let alerts = await open();

  // ── every seeded fault raised exactly one alert from the intended check ──────
  for (const [devEui, kind] of EXPECTED) {
    const match = alerts.filter((a) => a.dev_eui === devEui && a.kind === kind);
    assert.equal(match.length, 1, `expected exactly one open "${kind}" alert for ${devEui}`);
  }
  console.log(`ok — ${EXPECTED.length} seeded faults each raised one alert`);

  // ── the healthy controls raised nothing ─────────────────────────────────────
  for (const devEui of HEALTHY) {
    const noise = alerts.filter((a) => a.dev_eui === devEui);
    assert.equal(
      noise.length,
      0,
      `healthy control ${devEui} raised ${noise.length} alert(s) — a check is ` +
        `over-firing: ${noise.map((a) => a.kind).join(', ')}`,
    );
  }
  console.log(`ok — ${HEALTHY.length} healthy controls raised nothing`);

  // ── no alerts beyond the expected set ───────────────────────────────────────
  const expectedKeys = new Set(EXPECTED.map(([d, k]) => `${d}|${k}`));
  const unexpected = alerts.filter((a) => !expectedKeys.has(`${a.dev_eui}|${a.kind}`));
  assert.equal(
    unexpected.length,
    0,
    `unexpected alerts: ${unexpected.map((a) => `${a.kind}/${a.dev_eui}`).join(', ')}`,
  );
  console.log(`ok — no alerts outside the expected set (${alerts.length} total)`);

  // ── multi-path resolution ───────────────────────────────────────────────────
  // The single frost-risk entry lists ["air.temperature", "temperature", ...].
  // Device 0101 carries air.temperature; device 0102 carries only bare `temperature`.
  // Both must fire, each recording the path that actually matched. This is the whole
  // point of candidate lists: one config entry covering a mixed fleet.
  const frostAir = alerts.find((a) => a.kind === 'frost-risk' && a.dev_eui === '0000000000000101');
  const frostBare = alerts.find((a) => a.kind === 'frost-risk' && a.dev_eui === '0000000000000102');
  assert.equal(frostAir.detail.measurement, 'air.temperature');
  assert.equal(frostBare.detail.measurement, 'temperature', 'must fall through to a later candidate');

  // Same mechanism on a different concept: 0402 has no tank.level, only linear.position.
  const tankLow = alerts.find((a) => a.kind === 'tank-low' && a.dev_eui === '0000000000000402');
  assert.equal(tankLow.detail.measurement, 'linear.position');
  console.log('ok — multi-path resolution falls through per device and records the match');

  // ── peak vs latest ──────────────────────────────────────────────────────────
  // Device 0201's latest wind reading is calm; only one sample in the window hit
  // 21 m/s. A latest-reading check would miss it entirely.
  const gust = alerts.find((a) => a.kind === 'wind-gust');
  assert.equal(Number(gust.detail.peak), 21, 'measurement-peak must see the window maximum');
  assert.ok(
    Number(gust.detail.windowAvg) < 10,
    'the fixture gust must be invisible to an average-based check, or the test proves nothing',
  );
  console.log('ok — measurement-peak catches a gust the latest reading hides');

  // ── counter semantics ───────────────────────────────────────────────────────
  const stalled = alerts.find((a) => a.kind === 'water-meter-stalled' && a.dev_eui === '0000000000000502');
  assert.equal(stalled.detail.reason, 'stalled');
  const reset = alerts.find((a) => a.kind === 'water-meter-stalled' && a.dev_eui === '0000000000000503');
  assert.equal(reset.detail.reason, 'decrease');
  assert.equal(reset.severity, 'critical', 'a backwards counter corrupts consumption — escalate');
  const burst = alerts.find((a) => a.kind === 'water-burst');
  assert.ok(Number(burst.detail.ratePerHour) > 500, 'counter-spike must compute a per-hour rate');
  console.log('ok — counter checks distinguish stalled, backwards, and spiking totals');

  // ── boolean and enum truthiness ─────────────────────────────────────────────
  // action.contactState is the enum open|closed, not a JSON boolean.
  const contact = alerts.find((a) => a.kind === 'contact-open');
  assert.equal(contact.detail.rawValue, 'open');
  console.log('ok — boolean-alarm matches enum values, not just JSON booleans');

  // ── severity escalation is float-safe ───────────────────────────────────────
  // 3.2 V sits exactly on criticalAtVolts. Computing that point as
  // `raiseAtVolts - 0.2` yields 3.1999999999999997, so this reading would silently
  // stay at warning.
  // A codec returning JSON null must be caught. `object IS NULL` misses it, so this
  // asserts the predicate covers all three empty shapes: SQL NULL, JSON null, and {}.
  const nullCodec = alerts.find(
    (a) => a.kind === 'decode-failure' && a.dev_eui === '0000000000000006',
  );
  assert.ok(nullCodec, 'a codec returning JSON null must be flagged as a decode failure');
  assert.equal(Number(nullCodec.detail.undecodedUplinks), 15);
  assert.equal(nullCodec.severity, 'critical', 'nothing decoding at all is a provisioning error');
  console.log('ok — a JSON-null decoded object is treated as a decode failure');

  const battery = alerts.find((a) => a.kind === 'battery-low');
  assert.equal(battery.severity, 'critical');
  console.log('ok — severity escalation is float-safe');

  // ── deduplication ───────────────────────────────────────────────────────────
  const before = alerts.length;
  sounding();
  alerts = await open();
  assert.equal(alerts.length, before, 'a second sounding must not raise duplicate alerts');

  const { rows: dupes } = await db.query(
    `SELECT dev_eui, kind, count(*) AS n
       FROM leadsman.alert WHERE resolved_at IS NULL
      GROUP BY dev_eui, kind HAVING count(*) > 1`,
  );
  assert.equal(dupes.length, 0, 'the partial unique index must prevent duplicate open alerts');
  console.log('ok — repeated soundings deduplicate');

  // ── auto-resolve ────────────────────────────────────────────────────────────
  // The silent device reports again; its alert must close on the next sounding.
  await db.query(
    `INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
     VALUES (now(), $1, 'silent-node', 'soil-v1',
             '{"battery":3.9,"soil":{"moisture":29.0}}'::jsonb,
             '[{"rssi":-95,"snr":9.5}]'::jsonb)`,
    ['0000000000000001'],
  );
  sounding();

  alerts = await open();
  assert.equal(
    alerts.filter((a) => a.kind === 'device-silent').length,
    0,
    'device-silent must resolve once the device reports again',
  );

  const { rows: resolved } = await db.query(
    `SELECT resolved_at FROM leadsman.alert WHERE kind = 'device-silent' AND dev_eui = $1`,
    ['0000000000000001'],
  );
  assert.equal(resolved.length, 1, 'the resolved alert must remain as history');
  assert.ok(resolved[0].resolved_at, 'resolved_at must be stamped, not deleted');
  console.log('ok — alerts auto-resolve and remain as history');

  // ── network-layer checks see what event_up cannot ───────────────────────────
  // Device a2's uplinks report battery 3.9 V while its MAC-layer status says 12 %. The
  // codec-based check must stay silent and the status-based one must fire — that is the
  // whole reason both exist.
  const macBatt = alerts.find((a) => a.kind === 'mac-battery' && a.dev_eui === '00000000000000a2');
  assert.equal(macBatt.detail.source, 'event_status.battery_level');
  assert.ok(
    !alerts.some((a) => a.kind === 'battery-low' && a.dev_eui === '00000000000000a2'),
    'the codec-based battery check must not see a MAC-layer-only fault',
  );

  // ChirpStack's own description must reach the alert, since a code this engine has
  // never seen is only intelligible through it.
  const logErr = alerts.find((a) => a.kind === 'chirpstack-errors');
  assert.match(logErr.detail.latestDescription, /codec error/i);
  assert.equal(logErr.severity, 'critical', 'ChirpStack level 2 is an ERROR');

  // Join churn is judged on joins relative to uplinks, not joins alone.
  const churn = alerts.find((a) => a.kind === 'rejoining');
  assert.equal(churn.detail.joins, 8);
  assert.equal(churn.detail.distinctDevAddrs, 8, 'distinct DevAddrs prove real new sessions');
  assert.equal(churn.severity, 'critical', 'joining more often than it reports is effectively down');

  const unacked = alerts.find((a) => a.kind === 'commands-failing');
  assert.equal(Number(unacked.detail.unacked), 5);
  assert.equal(Number(unacked.detail.totalConfirmedDownlinks), 6);
  console.log('ok — network-layer checks catch faults invisible in event_up');

  // ── no check errored ────────────────────────────────────────────────────────
  // A failing check resolves nothing (no evidence the breach ended), so a silent SQL
  // error would look like a healthy fleet. Assert none happened.
  const { rows: errored } = await db.query(
    `SELECT kind, error FROM leadsman.run WHERE status = 'error'`,
  );
  assert.equal(
    errored.length,
    0,
    `checks errored: ${errored.map((r) => `${r.kind}: ${r.error}`).join('; ')}`,
  );
  console.log('ok — no check errored');

  // ── observability ───────────────────────────────────────────────────────────
  const { rows: runs } = await db.query(
    `SELECT count(*) AS n, count(DISTINCT kind) AS kinds FROM leadsman.run`,
  );
  assert.ok(Number(runs[0].kinds) >= 24, 'every configured check must be recorded in leadsman.run');
  console.log(`ok — ${runs[0].n} check executions recorded across ${runs[0].kinds} checks`);

  await db.end();
  console.log('\nintegration: all assertions passed');
}

main().catch((err) => {
  console.error(`\nintegration FAILED: ${err.message}`);
  process.exit(1);
});
