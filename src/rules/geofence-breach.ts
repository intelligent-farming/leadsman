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

import { int, num, optNum, round, str } from '../params';
import { latestCoordinates, resolvePaths } from '../measurement';
import { resolveScope, SCOPE_PARAMS } from '../scope';
import type { Finding, Rule } from '../types';

/** Great-circle distance in metres. Earth radius 6 371 008.8 m (mean). */
function haversineMetres(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6_371_008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

const rule: Rule = {
  id: 'geofence-breach',
  description:
    'Flags GPS trackers whose latest position falls outside a bounding box or beyond a ' +
    'radius from a centre point. Use for implements, generators, trailers, and ' +
    'livestock collars.',
  defaultSeverity: 'critical',
  defaultParams: {
    /** Candidate paths for latitude and longitude. */
    latPaths: ['position.latitude'],
    lonPaths: ['position.longitude'],
    /** "box" or "radius". */
    shape: 'box',
    /** box: inclusive bounds in decimal degrees. */
    north: null,
    south: null,
    east: null,
    west: null,
    /** radius: centre point and permitted distance in metres. */
    centerLat: null,
    centerLon: null,
    radiusMetres: null,
    /**
     * Hysteresis in metres (radius) or degrees (box). An asset parked on the fence
     * line would otherwise resolve and re-raise on GPS jitter alone, notifying each
     * time. Applied outward, so a breaching asset must come back inside by this much.
     */
    clearMargin: 25,
    /** How far back to look for a device's most recent fix. */
    lookbackHours: 24,
    /** Narrow this check to part of the fleet — see src/scope.ts. */
    ...SCOPE_PARAMS,
  },
  requires: [
    { table: 'event_up', columns: ['dev_eui', 'device_name', 'time', 'object'] },
  ],

  async run(ctx): Promise<Finding[]> {
    const latPaths = resolvePaths(ctx.params, 'latPaths');
    const lonPaths = resolvePaths(ctx.params, 'lonPaths');
    const shape = str(ctx.params, 'shape');
    const lookbackHours = int(ctx.params, 'lookbackHours');
    const clearMargin = num(ctx.params, 'clearMargin');

    if (shape !== 'box' && shape !== 'radius') {
      throw new Error(`shape must be "box" or "radius" (got "${shape}")`);
    }
    if (clearMargin < 0) throw new Error('clearMargin must not be negative');

    let north = 0;
    let south = 0;
    let east = 0;
    let west = 0;
    let centerLat = 0;
    let centerLon = 0;
    let radius = 0;

    if (shape === 'box') {
      const n = optNum(ctx.params, 'north');
      const s = optNum(ctx.params, 'south');
      const e = optNum(ctx.params, 'east');
      const w = optNum(ctx.params, 'west');
      if (n === null || s === null || e === null || w === null) {
        throw new Error('shape "box" requires north, south, east, and west');
      }
      if (n <= s) throw new Error(`north (${n}) must be greater than south (${s})`);
      if (e <= w) throw new Error(`east (${e}) must be greater than west (${w})`);
      [north, south, east, west] = [n, s, e, w];
    } else {
      const cLat = optNum(ctx.params, 'centerLat');
      const cLon = optNum(ctx.params, 'centerLon');
      const r = optNum(ctx.params, 'radiusMetres');
      if (cLat === null || cLon === null || r === null) {
        throw new Error('shape "radius" requires centerLat, centerLon, and radiusMetres');
      }
      if (r <= 0) throw new Error('radiusMetres must be positive');
      [centerLat, centerLon, radius] = [cLat, cLon, r];
    }

    const scope = resolveScope(ctx.params);
    const fixes = await latestCoordinates(ctx, latPaths, lonPaths, lookbackHours, scope);
    const findings: Finding[] = [];

    for (const f of fixes) {
      const open = ctx.openDevEuis.has(f.devEui);
      const name = f.deviceName ?? f.devEui;

      if (shape === 'radius') {
        const distance = haversineMetres(centerLat, centerLon, f.lat, f.lon);
        // A breaching asset must return inside radius - clearMargin to resolve.
        const limit = open ? Math.max(0, radius - clearMargin) : radius;
        if (distance <= limit) continue;

        findings.push({
          devEui: f.devEui,
          deviceName: f.deviceName,
          summary:
            `${name} is ${round(distance, 0)}m from the permitted centre ` +
            `(limit ${radius}m) at ${round(f.lat, 5)}, ${round(f.lon, 5)}`,
          detail: {
            shape,
            distanceMetres: round(distance, 1),
            radiusMetres: radius,
            latitude: round(f.lat, 6),
            longitude: round(f.lon, 6),
            centerLat,
            centerLon,
            clearMargin,
            fixAt: f.at,
          },
        });
        continue;
      }

      const margin = open ? clearMargin : 0;
      const outside: string[] = [];
      if (f.lat > north + margin) outside.push('north');
      if (f.lat < south - margin) outside.push('south');
      if (f.lon > east + margin) outside.push('east');
      if (f.lon < west - margin) outside.push('west');
      if (outside.length === 0) continue;

      findings.push({
        devEui: f.devEui,
        deviceName: f.deviceName,
        summary:
          `${name} is outside the permitted area to the ${outside.join(' and ')} ` +
          `at ${round(f.lat, 5)}, ${round(f.lon, 5)}`,
        detail: {
          shape,
          outsideEdges: outside,
          latitude: round(f.lat, 6),
          longitude: round(f.lon, 6),
          bounds: { north, south, east, west },
          clearMargin,
          fixAt: f.at,
        },
      });
    }

    return findings;
  },
};

export default rule;
