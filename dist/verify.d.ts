/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Pre-flight verification.
 *
 * ChirpStack's PostgreSQL integration creates the event_* tables itself, and their
 * exact columns depend on the ChirpStack version. Rather than assume a schema,
 * every check declares the tables and columns it reads (`Rule.requires`) and this
 * module compares those declarations against the live database.
 *
 * The point is that a schema mismatch is reported once, at deploy time, with the
 * missing column named — instead of surfacing as an SQL error inside a scheduled
 * sounding that nobody is watching.
 */
import type { Store } from './db';
import type { LeadsmanConfig, Rule } from './types';
export interface VerifyProblem {
    severity: 'error' | 'warning';
    where: string;
    message: string;
}
export interface VerifyReport {
    ok: boolean;
    database: string;
    user: string;
    schemaPresent: boolean;
    checksVerified: number;
    problems: VerifyProblem[];
}
/**
 * Validate that the configured checks can actually run: the rules exist, the
 * leadsman schema is present, and every declared table/column is in the database.
 */
export declare function verify(config: LeadsmanConfig, rules: Map<string, Rule>, store: Store): Promise<VerifyReport>;
//# sourceMappingURL=verify.d.ts.map