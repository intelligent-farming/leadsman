#!/usr/bin/env node
/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Command-line entry point.
 *
 *   leadsman list                    what checks are available (the menu)
 *   leadsman verify                  validate config + schema, write nothing
 *   leadsman run [--dry-run]         take one sounding and exit
 *   leadsman serve [--run-on-start]  stay resident, sound on the configured cron
 *   leadsman status                  show currently open alerts
 *   leadsman migrate                 apply migrations/*.sql
 *
 * Config path: --config <path>, else LEADSMAN_CONFIG, else ./config/leadsman.json
 * Database:    LEADSMAN_DATABASE_URL (migrate uses LEADSMAN_MIGRATE_URL if set,
 *              since applying DDL needs the owner role, not the engine role)
 */
export {};
//# sourceMappingURL=cli.d.ts.map