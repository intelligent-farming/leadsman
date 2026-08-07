-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 Intelligent Farming Foundation
--
-- Leadsman's own schema, applied to the standalone device-event store
-- (events-postgres in intelligent-farming-stack).
--
-- Everything lives in a dedicated `leadsman` schema rather than `public`, for two
-- reasons: ChirpStack owns `public` and auto-creates its event_* tables there on
-- boot, and PostGraphile (events-api) is configured with schema:['public'], so
-- these tables stay out of the public GraphQL surface until someone deliberately
-- adds 'leadsman' to that list.
--
-- Idempotent — safe to re-run. Apply as the database owner (the role ChirpStack
-- connects as, EVENTS_POSTGRES_USER), which needs rights to create a schema:
--   psql "$LEADSMAN_MIGRATE_URL" -f migrations/001_leadsman_schema.sql
-- or via the CLI:
--   leadsman migrate

CREATE SCHEMA IF NOT EXISTS leadsman;

COMMENT ON SCHEMA leadsman IS
  'Rule-engine state: alerts raised from soundings over ChirpStack event_* tables.';

-- ── alert ─────────────────────────────────────────────────────────────────────
-- One row per (device, kind) breach episode. A row is *raised* when a check first
-- reports a device, kept open (last_seen_at bumped) while the check keeps
-- reporting it, and *resolved* when the check stops reporting it. That lifecycle
-- is what gives deduplication: a sensor flapping around a threshold cannot create
-- more than one open row, so it cannot trigger more than one downstream
-- notification or agent invocation.
CREATE TABLE IF NOT EXISTS leadsman.alert (
  id            bigserial   PRIMARY KEY,

  -- which check produced this. rule_id is the script; kind is the configured
  -- instance name (`as` in the config), so one script can back several checks
  -- with different parameters and each gets its own alert stream.
  rule_id       text        NOT NULL,
  kind          text        NOT NULL,

  dev_eui       text        NOT NULL,
  device_name   text,

  severity      text        NOT NULL
                            CHECK (severity IN ('info', 'warning', 'critical')),
  summary       text        NOT NULL,

  -- Structured context for whatever consumes this: the measured value, the
  -- threshold it crossed, sample counts. Keep it small — this is what gets handed
  -- to a notifier or an agent, and every field is tokens if an LLM reads it.
  detail        jsonb       NOT NULL DEFAULT '{}'::jsonb,

  raised_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,

  -- Stamped by whatever delivers the alert (SMS sender, webhook consumer).
  -- Leadsman never sets this; it is the handoff point to the notification path.
  notified_at   timestamptz
);

-- The debounce. At most one OPEN alert per (dev_eui, kind); a partial unique
-- index leaves resolved history unconstrained so the same device can breach the
-- same check again later.
CREATE UNIQUE INDEX IF NOT EXISTS alert_open_uniq
  ON leadsman.alert (dev_eui, kind)
  WHERE resolved_at IS NULL;

-- "What is currently wrong" — the hot path for both the notifier and the agent.
CREATE INDEX IF NOT EXISTS alert_open_idx
  ON leadsman.alert (kind, dev_eui)
  WHERE resolved_at IS NULL;

-- "What needs sending" — open and not yet delivered.
CREATE INDEX IF NOT EXISTS alert_pending_notify_idx
  ON leadsman.alert (raised_at)
  WHERE resolved_at IS NULL AND notified_at IS NULL;

CREATE INDEX IF NOT EXISTS alert_history_idx
  ON leadsman.alert (raised_at DESC);

-- ── run ───────────────────────────────────────────────────────────────────────
-- One row per check execution. This is the observability surface: if a check is
-- silently erroring, or a query has crept up to multi-second durations on a
-- 2-core box, it shows up here rather than only in container logs.
CREATE TABLE IF NOT EXISTS leadsman.run (
  id           bigserial   PRIMARY KEY,
  rule_id      text        NOT NULL,
  kind         text        NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  duration_ms  integer,
  status       text        NOT NULL CHECK (status IN ('ok', 'error', 'skipped')),
  findings     integer     NOT NULL DEFAULT 0,
  raised       integer     NOT NULL DEFAULT 0,
  resolved     integer     NOT NULL DEFAULT 0,
  error        text
);

CREATE INDEX IF NOT EXISTS run_recent_idx
  ON leadsman.run (started_at DESC);

CREATE INDEX IF NOT EXISTS run_errors_idx
  ON leadsman.run (started_at DESC)
  WHERE status = 'error';

-- ── open_alert ────────────────────────────────────────────────────────────────
-- The read surface. Point a notifier, a dashboard, or an agent at this rather
-- than at the base table so the resolved-row filter lives in one place.
CREATE OR REPLACE VIEW leadsman.open_alert AS
SELECT id,
       rule_id,
       kind,
       dev_eui,
       device_name,
       severity,
       summary,
       detail,
       raised_at,
       last_seen_at,
       notified_at,
       now() - raised_at AS open_for
FROM leadsman.alert
WHERE resolved_at IS NULL;

COMMENT ON VIEW leadsman.open_alert IS
  'Currently-breaching alerts. Read this instead of leadsman.alert directly.';

-- ── grants ────────────────────────────────────────────────────────────────────
-- Applied only if the role exists, so this file is safe to run on a database
-- where the roles have not been created yet (see 010_leadsman_role.sh).
DO $$
BEGIN
  -- Read/write for the engine itself.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadsman') THEN
    GRANT USAGE ON SCHEMA leadsman TO leadsman;
    GRANT SELECT, INSERT, UPDATE ON leadsman.alert, leadsman.run TO leadsman;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA leadsman TO leadsman;
    GRANT SELECT ON leadsman.open_alert TO leadsman;
    -- Reading the telemetry it takes soundings of.
    GRANT USAGE ON SCHEMA public TO leadsman;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO leadsman;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO leadsman;
    RAISE NOTICE 'granted engine privileges to role "leadsman"';
  ELSE
    RAISE NOTICE 'role "leadsman" not found — skipping engine grants (see migrations/010_leadsman_role.sh)';
  END IF;

  -- Read-only for the existing API role, so events-api/PostGraphile can expose
  -- alerts once 'leadsman' is added to its schema list, and so anything already
  -- holding those credentials can read alerts without new secrets.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'events_api') THEN
    GRANT USAGE ON SCHEMA leadsman TO events_api;
    GRANT SELECT ON leadsman.alert, leadsman.run, leadsman.open_alert TO events_api;
    ALTER DEFAULT PRIVILEGES IN SCHEMA leadsman GRANT SELECT ON TABLES TO events_api;
    RAISE NOTICE 'granted read-only access to role "events_api"';
  ELSE
    RAISE NOTICE 'role "events_api" not found — skipping read-only grants';
  END IF;
END $$;
