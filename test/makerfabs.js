// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Validates config/makerfabs-agrosense.example.json against test/fixtures/makerfabs-seed.sql.
//
// The shipped per-device config is documentation as much as configuration, and stale
// documentation is worse than none. This asserts it still does what it claims on
// payload shapes copied from each codec's vectors.json — so a vocabulary change, a
// renamed path, or a regression in the resolver breaks CI rather than a farm.
//
// Run locally with:
//   LEADSMAN_DATABASE_URL=... node dist/cli.js migrate
//   psql "$LEADSMAN_DATABASE_URL" -f test/fixtures/makerfabs-seed.sql
//   LEADSMAN_CONFIG=config/makerfabs-agrosense.example.json node dist/cli.js run
//   node test/makerfabs.js

const assert = require('node:assert/strict');
const { Client } = require('pg');

// One healthy and one faulted device per AgroSense model.
const HEALTHY = {
  '0000000000000001': 'AGLWSM02 soil monitor',
  '0000000000000011': 'AGLWTH01 climate node',
  '0000000000000021': 'AGLWPP01 pipe pressure',
  '0000000000000031': 'AGLWL01 light sensor',
};

// Every fault the fixture plants, and the check that must catch it.
const EXPECTED = {
  '0000000000000002': ['sm02-moisture-low', 'sm02-probe-stuck', 'sm02-root-frost',
                       'sm02-salinity-high', 'sm02-ph-out-of-band'],
  '0000000000000012': ['th01-frost-occurred', 'th01-humidity-high'],
  '0000000000000022': ['pp01-pressure-low', 'pp01-pressure-collapse'],
  '0000000000000032': ['l01-sensor-fouled'],
};

async function main() {
  const db = new Client({ connectionString: process.env.LEADSMAN_DATABASE_URL });
  await db.connect();

  const { rows } = await db.query(
    'SELECT kind, dev_eui, severity, detail FROM leadsman.open_alert',
  );
  const byDevice = new Map();
  for (const r of rows) {
    if (!byDevice.has(r.dev_eui)) byDevice.set(r.dev_eui, []);
    byDevice.get(r.dev_eui).push(r);
  }
  const kindsFor = (devEui) => (byDevice.get(devEui) ?? []).map((a) => a.kind).sort();

  // ── each planted fault raised exactly its expected checks, and nothing else ──
  for (const [devEui, expected] of Object.entries(EXPECTED)) {
    assert.deepEqual(
      kindsFor(devEui),
      [...expected].sort(),
      `device ${devEui} raised the wrong set of alerts`,
    );
  }
  console.log(
    `ok — ${Object.values(EXPECTED).flat().length} faults across 4 device models caught exactly`,
  );

  // ── healthy devices are silent ──────────────────────────────────────────────
  for (const [devEui, label] of Object.entries(HEALTHY)) {
    assert.deepEqual(
      kindsFor(devEui),
      [],
      `healthy ${label} (${devEui}) raised alerts — a check is over-firing`,
    );
  }
  console.log('ok — 4 healthy devices raised nothing');

  // ── per-family battery scoping ──────────────────────────────────────────────
  // The light sensor runs at 2.85 V, which is normal for that hardware but far below
  // the soil monitor's 3.3 V raise point. Without deviceProfiles scoping on
  // battery-low, this device would raise battery-low-soil on every sounding — the
  // exact false positive that makes operators stop reading alerts.
  assert.deepEqual(
    kindsFor('0000000000000032').filter((k) => k.startsWith('battery-low')),
    [],
    'a 2.85 V light sensor must not trip another family\'s battery threshold',
  );
  console.log('ok — battery thresholds are scoped per device family');

  // ── window minimum vs latest reading ────────────────────────────────────────
  // Device 0012 dipped to -1.2 C six hours ago and has recovered to 8 C. The
  // latest-reading frost check must stay quiet; only the window-minimum check fires.
  // If both fire, `measurement-peak` is reading the wrong aggregate.
  const th01 = kindsFor('0000000000000012');
  assert.ok(
    !th01.includes('th01-frost-risk'),
    'the latest-reading frost check must not fire on a device that has recovered',
  );
  assert.ok(
    th01.includes('th01-frost-occurred'),
    'the window-minimum check must catch the overnight dip',
  );
  const frost = byDevice.get('0000000000000012').find((a) => a.kind === 'th01-frost-occurred');
  assert.equal(frost.detail.comparison, 'below');
  assert.equal(frost.detail.direction, 'min');
  console.log('ok — overnight frost caught by window minimum, latest-reading check silent');

  // ── the max/below combination ───────────────────────────────────────────────
  // A fouled light sensor means the daily PEAK is too LOW. Every individual reading is
  // plausible (it really is dark at night), so no threshold check can express this.
  const fouled = byDevice.get('0000000000000032').find((a) => a.kind === 'l01-sensor-fouled');
  assert.equal(fouled.detail.direction, 'max');
  assert.equal(fouled.detail.comparison, 'below');
  assert.ok(
    Number(fouled.detail.peak) < 5000,
    'the fouled sensor fixture must have a daily peak below the threshold',
  );
  console.log('ok — a fouled light sensor is caught by peak-below, which no threshold can express');

  // ── multi-path candidate lists resolved to the real vocabulary paths ────────
  // These are the paths the codecs actually emit, per their vectors.json.
  const resolved = Object.fromEntries(
    rows.filter((r) => r.detail?.measurement).map((r) => [r.kind, r.detail.measurement]),
  );
  assert.equal(resolved['sm02-moisture-low'], 'soil.moisture');
  assert.equal(resolved['sm02-root-frost'], 'soil.temperature');
  assert.equal(resolved['sm02-salinity-high'], 'soil.ec');
  assert.equal(resolved['sm02-ph-out-of-band'], 'soil.pH');
  assert.equal(resolved['th01-humidity-high'], 'air.relativeHumidity');
  assert.equal(resolved['th01-frost-occurred'], 'air.temperature');
  assert.equal(resolved['pp01-pressure-low'], 'pressure.gauge');
  assert.equal(resolved['l01-sensor-fouled'], 'air.lightIntensity');
  console.log('ok — candidate lists resolved to the paths these codecs actually emit');

  // ── no check errored ────────────────────────────────────────────────────────
  const { rows: errored } = await db.query(
    `SELECT kind, error FROM leadsman.run WHERE status = 'error'`,
  );
  assert.equal(
    errored.length,
    0,
    `checks errored: ${errored.map((r) => `${r.kind}: ${r.error}`).join('; ')}`,
  );
  console.log('ok — no check errored');

  await db.end();
  console.log('\nmakerfabs: all assertions passed');
}

main().catch((err) => {
  console.error(`\nmakerfabs FAILED: ${err.message}`);
  process.exit(1);
});
