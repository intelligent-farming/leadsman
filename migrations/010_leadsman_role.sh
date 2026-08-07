#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Intelligent Farming Foundation
#
# Creates the least-privilege role Leadsman connects as.
#
# Follows the same idiom as the stack's own postgresql/events-initdb/010_events_roles.sh:
# drop this file into that directory and it runs automatically on a FRESH volume,
# before ChirpStack has created any event_* tables. ALTER DEFAULT PRIVILEGES
# pre-authorizes SELECT on whatever tables the owner creates later, so the role can
# read every event_* table ChirpStack adds without re-granting.
#
# Privileges: SELECT on public (read telemetry) and INSERT/UPDATE/SELECT on the
# leadsman schema (write its own alerts). No DDL on public, no DELETE anywhere, no
# SUPERUSER/CREATEDB/CREATEROLE. It cannot alter or destroy ChirpStack's data.
#
# To apply to an EXISTING volume, run by hand (env is already in the container):
#   docker compose exec events-postgres bash /docker-entrypoint-initdb.d/010_leadsman_role.sh
#
# Required env:
#   POSTGRES_USER, POSTGRES_DB      — the owner role / database (already set by the image)
#   POSTGRES_LEADSMAN_USER          — role to create (e.g. leadsman)
#   POSTGRES_LEADSMAN_PASSWORD      — its password
#
# Blank/unset LEADSMAN vars disable this script, matching the Fivetran role's
# opt-in behaviour in the stack.

set -euo pipefail

if [ -z "${POSTGRES_LEADSMAN_USER:-}" ] || [ -z "${POSTGRES_LEADSMAN_PASSWORD:-}" ]; then
  echo "010_leadsman_role: POSTGRES_LEADSMAN_USER / POSTGRES_LEADSMAN_PASSWORD not set — skipping"
  exit 0
fi

role_exists="$(psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = '${POSTGRES_LEADSMAN_USER}'" \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB")"
if [ "$role_exists" != "1" ]; then
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "CREATE ROLE \"${POSTGRES_LEADSMAN_USER}\" LOGIN"
fi

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<EOSQL
ALTER ROLE "${POSTGRES_LEADSMAN_USER}" WITH LOGIN PASSWORD '${POSTGRES_LEADSMAN_PASSWORD}';

GRANT CONNECT ON DATABASE "${POSTGRES_DB}" TO "${POSTGRES_LEADSMAN_USER}";

-- Read side: the ChirpStack event_* tables in public. The tables do not exist yet
-- on a fresh boot, so ALTER DEFAULT PRIVILEGES covers the ones created later.
GRANT USAGE  ON SCHEMA public              TO "${POSTGRES_LEADSMAN_USER}";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${POSTGRES_LEADSMAN_USER}";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO "${POSTGRES_LEADSMAN_USER}";
EOSQL

# Write side: only if 001_leadsman_schema.sql has already created the schema. On a
# fresh volume it has not, and 001's own DO block will apply these grants when it
# runs (the role exists by then). Either order works.
schema_exists="$(psql -tAc "SELECT 1 FROM pg_namespace WHERE nspname = 'leadsman'" \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB")"
if [ "$schema_exists" = "1" ]; then
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<EOSQL
GRANT USAGE ON SCHEMA leadsman TO "${POSTGRES_LEADSMAN_USER}";
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA leadsman TO "${POSTGRES_LEADSMAN_USER}";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA leadsman TO "${POSTGRES_LEADSMAN_USER}";
EOSQL
  echo "010_leadsman_role: role '${POSTGRES_LEADSMAN_USER}' ready (read public / write leadsman)"
else
  echo "010_leadsman_role: role '${POSTGRES_LEADSMAN_USER}' ready (read public; leadsman schema not created yet — run migration 001)"
fi
