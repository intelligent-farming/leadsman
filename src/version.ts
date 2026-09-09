/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Package version, read from package.json at runtime.
 *
 * Read rather than compiled in so it cannot drift from what npm or the image actually
 * shipped — a hardcoded string is exactly the thing that goes stale and then misreports
 * which config features are supported. dist/ sits one level below the package root, and
 * this build is CommonJS, so __dirname is the right anchor.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function version(): string {
  try {
    const raw = readFileSync(join(__dirname, '..', 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
