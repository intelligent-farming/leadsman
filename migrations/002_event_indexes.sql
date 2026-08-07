-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 Intelligent Farming Foundation
--
-- Indexes on ChirpStack's event_* tables.
--
-- ⚠ This file modifies tables Leadsman does not own. ChirpStack's PostgreSQL
-- integration creates the event_* tables and ships them with a primary-key index
-- only — no index on `time` or `dev_eui`. Every Leadsman check filters by time
-- and groups by dev_eui, so without these indexes each sounding is a full
-- sequential scan plus a sort. On a small edge device sharing CPU with
-- ChirpStack's own ingestion, that is the most likely way this engine degrades
-- the thing it is monitoring.
--
-- Adding indexes does not change ChirpStack's behaviour (it only writes), but it
-- does add write amplification on insert. At LoRaWAN uplink rates that cost is
-- negligible next to the scan it removes.
--
-- Apply as the owner of the event_* tables (EVENTS_POSTGRES_USER). Separate from
-- 001 so operators can review it before touching ChirpStack-owned objects:
--   psql "$LEADSMAN_MIGRATE_URL" -f migrations/002_event_indexes.sql
--
-- On a database with existing data this rewrites indexes and will hold locks.
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so if you are
-- applying to a live store, run the CONCURRENTLY variants noted below by hand
-- instead of executing this file wholesale.

-- Uplinks: every check does `WHERE time > now() - <window>`.
CREATE INDEX IF NOT EXISTS event_up_time_idx
  ON public.event_up (time DESC);

-- Per-device history: `GROUP BY dev_eui` with a time bound, and
-- "latest reading for this device" lookups.
CREATE INDEX IF NOT EXISTS event_up_deveui_time_idx
  ON public.event_up (dev_eui, time DESC);

-- Join events — used by onboarding tooling and any future join-rate checks.
CREATE INDEX IF NOT EXISTS event_join_time_idx
  ON public.event_join (time DESC);

CREATE INDEX IF NOT EXISTS event_join_deveui_time_idx
  ON public.event_join (dev_eui, time DESC);

-- Device status (battery/margin) if the deployment uses it.
CREATE INDEX IF NOT EXISTS event_status_deveui_time_idx
  ON public.event_status (dev_eui, time DESC);

-- Live-store variants — run these individually, outside a transaction:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS event_up_time_idx
--     ON public.event_up (time DESC);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS event_up_deveui_time_idx
--     ON public.event_up (dev_eui, time DESC);
