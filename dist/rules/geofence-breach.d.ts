/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * geofence-breach — a tracked asset has left its permitted area.
 *
 * The `gps-tracker` category reports `position.latitude` and `position.longitude`.
 * On a farm the assets worth fencing are the ones that walk or get driven away:
 * implements, generators, pumps, trailers, and livestock collars.
 *
 * Two fence shapes:
 *   - **box** — north/south/east/west bounds. Cheap, no trigonometry, and adequate
 *     for a field or a yard.
 *   - **radius** — metres from a centre point, using the haversine formula. Better
 *     for a circular area or a single fixed asset that should not move at all
 *     (set a 50 m radius on a pump and you have a theft alarm).
 *
 * Distance is computed in TypeScript rather than SQL deliberately: PostGIS is not
 * available in the stack's plain `postgres:16-alpine` image, and a haversine over the
 * handful of rows a fleet's trackers produce is not worth an extension dependency.
 */
import type { Rule } from '../types';
declare const rule: Rule;
export default rule;
//# sourceMappingURL=geofence-breach.d.ts.map