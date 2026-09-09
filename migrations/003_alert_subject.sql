-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 Intelligent Farming Foundation
--
-- Generalize an alert's subject from "a device" to "a device, a gateway, the site,
-- or the engine itself".
--
-- Until this migration every alert was keyed on dev_eui NOT NULL, which is why
-- Leadsman had no way to say "gateway 0016c001f1e2d3c4 stopped forwarding" or "no
-- uplinks from anything for 40 minutes". A gateway EUI is also 16 hex characters, so
-- the shortcut of stuffing one into dev_eui would have worked — and would have lied
-- in every SMS, in `leadsman status`, and in the payload that reaches downstream
-- consumers. Hence a real subject.
--
-- dev_eui and device_name are KEPT and still populated for device subjects, so
-- anything already reading them (the open_alert view, PostGraphile, a warehouse sync)
-- keeps working untouched. They are simply NULL when the subject is not a device.
--
-- Idempotent — safe to re-run. Apply as the database owner:
--   leadsman migrate

-- ── alert.subject ─────────────────────────────────────────────────────────────
ALTER TABLE leadsman.alert
  ADD COLUMN IF NOT EXISTS subject_kind text NOT NULL DEFAULT 'device',
  ADD COLUMN IF NOT EXISTS subject_id   text,
  ADD COLUMN IF NOT EXISTS subject_name text,
  -- Set when an alert is deliberately withheld because a higher-level alert already
  -- explains it (see the `suppress` config block). Distinct from notified_at: a
  -- suppressed alert is recorded, is NOT delivered, and is NOT retried — but if it is
  -- still open once the suppressing alert resolves, it becomes deliverable again.
  ADD COLUMN IF NOT EXISTS suppressed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'leadsman.alert'::regclass AND conname = 'alert_subject_kind_check'
  ) THEN
    ALTER TABLE leadsman.alert
      ADD CONSTRAINT alert_subject_kind_check
      CHECK (subject_kind IN ('device', 'gateway', 'site', 'engine'));
  END IF;
END $$;

-- Backfill before the new unique index is built. Every pre-existing alert was a
-- device alert, so subject identity is exactly the old identity — which is what makes
-- the index swap below safe on a live database with open alerts.
UPDATE leadsman.alert
   SET subject_id   = dev_eui,
       subject_name = COALESCE(subject_name, device_name)
 WHERE subject_id IS NULL;

ALTER TABLE leadsman.alert ALTER COLUMN subject_id SET NOT NULL;

-- A non-device alert has no DevEUI to record.
ALTER TABLE leadsman.alert ALTER COLUMN dev_eui DROP NOT NULL;

COMMENT ON COLUMN leadsman.alert.subject_kind IS
  'What this alert is about: device | gateway | site | engine.';
COMMENT ON COLUMN leadsman.alert.subject_id IS
  'Stable id of the subject — DevEUI, gateway EUI, or a constant for site/engine alerts.';
COMMENT ON COLUMN leadsman.alert.dev_eui IS
  'DevEUI for device subjects, NULL otherwise. Kept for consumers that predate subjects.';

-- ── indexes ───────────────────────────────────────────────────────────────────
-- The debounce, now per subject. At most one OPEN alert per (subject, kind).
CREATE UNIQUE INDEX IF NOT EXISTS alert_open_subject_uniq
  ON leadsman.alert (subject_kind, subject_id, kind)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS alert_open_subject_idx
  ON leadsman.alert (kind, subject_kind, subject_id)
  WHERE resolved_at IS NULL;

-- "What needs sending" — open, undelivered, and not suppressed. Replaces the
-- suppression-unaware index from 001.
CREATE INDEX IF NOT EXISTS alert_deliverable_idx
  ON leadsman.alert (raised_at)
  WHERE resolved_at IS NULL AND notified_at IS NULL AND suppressed_at IS NULL;

-- The (dev_eui, kind) index no longer expresses the invariant — dev_eui is NULL for
-- every non-device alert, and NULLs are distinct in a unique index, so it would
-- quietly stop constraining anything that matters. Dropped in favour of the pair above.
DROP INDEX IF EXISTS leadsman.alert_open_uniq;
DROP INDEX IF EXISTS leadsman.alert_open_idx;
DROP INDEX IF EXISTS leadsman.alert_pending_notify_idx;

-- ── engine_state ──────────────────────────────────────────────────────────────
-- The small amount of memory a check needs ACROSS soundings.
--
-- Checks are otherwise stateless by design — they report what is true now and the
-- engine owns the lifecycle. Two things genuinely cannot be derived from telemetry,
-- because they are facts about the host rather than the fleet: the address gateways
-- were told to forward to, and when the engine last ran. Both are single scalars, so
-- this is a key/value table rather than anything structural.
CREATE TABLE IF NOT EXISTS leadsman.engine_state (
  key      text        PRIMARY KEY,
  value    text,
  seen_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE leadsman.engine_state IS
  'Cross-sounding scalars (host address last seen, and similar). Not fleet telemetry.';

-- ── open_alert ────────────────────────────────────────────────────────────────
-- Recreated rather than replaced: CREATE OR REPLACE VIEW can only append columns,
-- and subject_kind/subject_id belong next to the identity they generalize, not
-- tacked on after open_for. 001 creates this view only when it is absent (see the
-- guard there), so re-running the whole migration sequence does not clobber this
-- wider definition.
DROP VIEW IF EXISTS leadsman.open_alert;

CREATE VIEW leadsman.open_alert AS
SELECT id,
       rule_id,
       kind,
       subject_kind,
       subject_id,
       subject_name,
       dev_eui,
       device_name,
       severity,
       summary,
       detail,
       raised_at,
       last_seen_at,
       notified_at,
       suppressed_at,
       now() - raised_at AS open_for
FROM leadsman.alert
WHERE resolved_at IS NULL;

COMMENT ON VIEW leadsman.open_alert IS
  'Currently-breaching alerts. Read this instead of leadsman.alert directly.';

-- ── grants ────────────────────────────────────────────────────────────────────
-- Same conditional shape as 001: applied only if the roles exist, and re-applied
-- here because DROP VIEW discarded the grants open_alert used to carry.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadsman') THEN
    GRANT SELECT, INSERT, UPDATE ON leadsman.engine_state TO leadsman;
    GRANT SELECT ON leadsman.open_alert TO leadsman;
    -- host-restarted reads its own run history to report how long the gap was.
    GRANT SELECT ON leadsman.run TO leadsman;
    RAISE NOTICE 'granted engine privileges on engine_state / open_alert to role "leadsman"';
  ELSE
    RAISE NOTICE 'role "leadsman" not found — skipping engine grants (see migrations/010_leadsman_role.sh)';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'events_api') THEN
    GRANT SELECT ON leadsman.engine_state, leadsman.open_alert TO events_api;
    RAISE NOTICE 'granted read-only access on engine_state / open_alert to role "events_api"';
  ELSE
    RAISE NOTICE 'role "events_api" not found — skipping read-only grants';
  END IF;
END $$;
