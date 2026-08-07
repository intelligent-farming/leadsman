// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Shared harness for the database-backed test files.
//
// The resolvers, the reconciler, and the scope filter are all SQL. There is no honest
// way to test them without Postgres — pg-mem does not implement the lateral joins,
// `WITH ORDINALITY`, or JSONB path operators these queries rely on, so a mock would
// only prove the mock works. These tests therefore require a real server and skip
// cleanly when one is not configured.
//
//   LEADSMAN_TEST_DATABASE_URL=postgres://events:test@127.0.0.1:5439/chirpstack_events \
//     node --test test/resolver.js test/engine.js
//
// Each test FILE gets its own scratch database. `node --test` runs files concurrently,
// and every case here truncates event_up in beforeEach — sharing one database means one
// file wipes another's fixtures mid-test, which fails intermittently and only when the
// files run together. Per-file isolation makes concurrency safe rather than something
// the next contributor has to remember. The configured role needs CREATEDB; on a
// scratch server that is a reasonable ask, and the error says so if it is missing.

const { Client } = require('pg');
const { Store } = require('../../dist/db.js');

// Deliberately NOT named `URL`: that would shadow the global URL constructor used
// below to derive the scratch-database connection string.
const BASE_URL = process.env.LEADSMAN_TEST_DATABASE_URL ?? process.env.LEADSMAN_DATABASE_URL;

/** True when a database is configured. Test files skip themselves without one. */
exports.available = Boolean(BASE_URL);
exports.url = BASE_URL;

exports.skipMessage =
  'set LEADSMAN_TEST_DATABASE_URL to a scratch Postgres to run the database-backed tests';

/**
 * A ChirpStack-shaped event_up plus the leadsman schema, both empty.
 *
 * Each test file gets its own database state and truncates between cases, so tests
 * cannot leak into one another through the event store — which matters here because
 * every resolver query is "everything in the last N hours".
 */
exports.setup = async function setup(name) {
  if (!name || !/^[a-z0-9_]+$/.test(name)) {
    throw new Error('setup(name) requires a lowercase identifier, e.g. setup("resolver")');
  }
  const dbName = `leadsman_test_${name}`;

  // Admin connection on the configured database, used only to create and drop the
  // scratch one. CREATE DATABASE cannot run inside a transaction, hence a plain query.
  const admin = new Client({ connectionString: BASE_URL, application_name: 'leadsman-test-admin' });
  await admin.connect();
  try {
    await admin.query('SET lock_timeout = \'10s\'');
    // Evict any session left behind by a crashed run — DROP DATABASE blocks forever
    // on an open connection, which turns a stale database into a hung test suite.
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
  } catch (err) {
    await admin.end();
    throw new Error(
      `could not create the scratch database ${dbName}: ${err.message}\n` +
        'The role in LEADSMAN_TEST_DATABASE_URL needs CREATEDB. Point it at a scratch ' +
        'Postgres (the CI service container and docker-compose dev database both work).',
    );
  }

  const scratchUrl = new URL(BASE_URL);
  scratchUrl.pathname = `/${dbName}`;
  const db = new Client({
    connectionString: scratchUrl.toString(), application_name: 'leadsman-test',
  });
  await db.connect();

  await db.query(`
    CREATE TABLE IF NOT EXISTS event_up (
      deduplication_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      time                timestamptz NOT NULL,
      dev_eui             text NOT NULL,
      device_name         text,
      device_profile_name text,
      f_cnt               bigint,
      object              jsonb,
      rx_info             jsonb
    );
    -- The other ChirpStack event tables, with the column types the real integration
    -- creates (level/code are TEXT holding numeric enum values; battery_level is real).
    CREATE TABLE IF NOT EXISTS event_join (
      deduplication_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      time timestamptz NOT NULL, dev_eui text, device_name text,
      device_profile_name text, dev_addr text
    );
    CREATE TABLE IF NOT EXISTS event_status (
      deduplication_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      time timestamptz NOT NULL, dev_eui text, device_name text,
      device_profile_name text, margin smallint,
      external_power_source boolean, battery_level_unavailable boolean,
      battery_level real
    );
    CREATE TABLE IF NOT EXISTS event_log (
      id bigserial PRIMARY KEY,
      time timestamptz NOT NULL, dev_eui text, device_name text,
      device_profile_name text, level text, code text, description text, context jsonb
    );
    CREATE TABLE IF NOT EXISTS event_ack (
      queue_item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      time timestamptz NOT NULL, dev_eui text, device_name text,
      device_profile_name text, acknowledged boolean, f_cnt_down bigint
    );
  `);

  // The migration is idempotent, so applying it here is safe whether or not the
  // caller already ran `leadsman migrate`.
  const fs = require('node:fs');
  const path = require('node:path');
  const migration = fs.readFileSync(
    path.join(__dirname, '..', '..', 'migrations', '001_leadsman_schema.sql'),
    'utf8',
  );
  await db.query(migration);

  const store = new Store({
    connectionString: scratchUrl.toString(), statementTimeoutMs: 15_000,
  });
  return { db, store, admin, dbName, url: scratchUrl.toString() };
};

exports.teardown = async function teardown({ db, store, admin, dbName }) {
  await store.close();
  await db.end();
  // Drop the scratch database so a failed run does not leave clutter behind.
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => {});
  await admin.end();
};

exports.reset = async function reset(db) {
  await db.query('TRUNCATE event_up, event_join, event_status, event_log, event_ack');
  await db.query('TRUNCATE leadsman.alert, leadsman.run');
};

/**
 * Insert one uplink. `minutesAgo` counts backwards, so a smaller number is more
 * recent — which keeps the ordering assertions in the window tests readable.
 */
exports.uplink = async function uplink(db, {
  devEui,
  minutesAgo = 0,
  object = null,
  deviceName = null,
  profile = 'test-profile',
  rxInfo = null,
}) {
  await db.query(
    `INSERT INTO event_up (time, dev_eui, device_name, device_profile_name, object, rx_info)
     VALUES (now() - make_interval(mins => $1::int), $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [
      Math.round(minutesAgo),
      devEui,
      deviceName,
      profile,
      object === null ? null : JSON.stringify(object),
      rxInfo === null ? null : JSON.stringify(rxInfo),
    ],
  );
};

/** A minimal SoundingContext backed by the real store. */
exports.ctx = function ctx(store, { params = {}, openDevEuis = new Set(), kind = 'test' } = {}) {
  const lines = [];
  return {
    query: (sql, values) => store.query(sql, values),
    params,
    openDevEuis,
    kind,
    now: new Date(),
    log: {
      debug: (m, meta) => lines.push(['debug', m, meta]),
      info: (m, meta) => lines.push(['info', m, meta]),
      warn: (m, meta) => lines.push(['warn', m, meta]),
      error: (m, meta) => lines.push(['error', m, meta]),
    },
    /** Test-only: what the check logged. */
    _lines: lines,
  };
};

/** Silent logger for runner-level tests. */
exports.quietLogger = function quietLogger() {
  const lines = [];
  const mk = (level) => (msg, meta) => lines.push({ level, msg, ...meta });
  const logger = {
    debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error'),
    lines,
  };
  logger.child = () => logger;
  return logger;
};
