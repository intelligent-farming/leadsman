/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Local calendar arithmetic for the checks that count from a date.
 *
 * Most checks look back a fixed number of hours, which is right for "is it frosty" and
 * wrong for every seasonal total an agronomist plans against. Degree-days for a pest
 * are counted from its biofix, chill from the start of dormancy, a Winkler index from
 * April 1. None of those is "the last N hours": with chill counted from November 1, on
 * February 2 the window is ninety-three days long, and on October 2 it is 335 — still
 * the previous season, which has not been replaced yet.
 *
 * So a season start is written as `MM-DD` (the most recent occurrence at or before
 * today, which is what makes a config written once work every year) or as
 * `YYYY-MM-DD` (a fixed date: a planting date, or a biofix observed in the traps).
 * Everything here is evaluated in the config's timezone — a day is a local day, because
 * "the minimum temperature of March 3" is a local idea.
 */

import { ParamError } from './params';

/** The local wall-clock parts of an instant. */
export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
}

export function localParts(now: Date, timezone = 'UTC'): LocalParts {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    // Intl renders midnight as "24" in some locales under hour12:false.
    return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24 };
  } catch {
    // An unusable timezone must not fail the sounding; UTC is at least deterministic.
    return {
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      day: now.getUTCDate(),
      hour: now.getUTCHours(),
    };
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` for a local date. */
export function isoDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Today's local date as `YYYY-MM-DD`. */
export function localDate(now: Date, timezone = 'UTC'): string {
  const p = localParts(now, timezone);
  return isoDate(p.year, p.month, p.day);
}

/** Days from `from` to `to`, both `YYYY-MM-DD`. Calendar days, so DST does not bend it. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** `YYYY-MM-DD` plus `n` calendar days. */
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

const MONTH_DAY = /^(\d{2})-(\d{2})$/;
const FULL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validMonthDay(month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  // Feb 29 is refused: it would silently move to Mar 1 three years in four.
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= lengths[month - 1];
}

/**
 * Validate a season-start parameter, throwing a ParamError naming it. Accepts `MM-DD`
 * or `YYYY-MM-DD`.
 */
export function parseSince(value: unknown, key = 'since'): string {
  if (typeof value !== 'string') {
    throw new ParamError(`param "${key}" must be "MM-DD" or "YYYY-MM-DD" (got ${JSON.stringify(value)})`);
  }
  let m = MONTH_DAY.exec(value);
  if (m) {
    if (!validMonthDay(Number(m[1]), Number(m[2]))) {
      throw new ParamError(`param "${key}" is not a calendar date: "${value}"`);
    }
    return value;
  }
  m = FULL_DATE.exec(value);
  if (m) {
    const [, y, mo, d] = m.map(Number);
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    if (!(validMonthDay(mo, d) || (leap && mo === 2 && d === 29))) {
      throw new ParamError(`param "${key}" is not a calendar date: "${value}"`);
    }
    return value;
  }
  throw new ParamError(`param "${key}" must be "MM-DD" or "YYYY-MM-DD" (got "${value}")`);
}

/**
 * The local date a season started, as `YYYY-MM-DD`.
 *
 * `MM-DD` resolves to its most recent occurrence at or before today: with "11-01", on
 * 2027-02-10 that is 2026-11-01 and on 2026-11-01 itself it is today. `YYYY-MM-DD` is
 * returned unchanged, including when it is in the future — the caller reports that as
 * "not started" rather than counting backwards.
 */
export function seasonStart(since: string, now: Date, timezone = 'UTC'): string {
  if (FULL_DATE.test(since)) return since;
  const [month, day] = since.split('-').map(Number);
  const today = localParts(now, timezone);
  const thisYear = isoDate(today.year, month, day);
  const todayIso = isoDate(today.year, today.month, today.day);
  return thisYear <= todayIso ? thisYear : isoDate(today.year - 1, month, day);
}

/**
 * The next local occurrence of `MM-DD` at or after the season start — the date a
 * requirement is judged by. With a start of 2026-11-01 and "03-01", that is 2027-03-01.
 */
export function dateInSeason(start: string, monthDay: string): string {
  const year = Number(start.slice(0, 4));
  const candidate = `${year}-${monthDay}`;
  return candidate >= start ? candidate : `${year + 1}-${monthDay}`;
}

/**
 * The zone's UTC offset at an instant, in milliseconds (local wall clock minus UTC),
 * to the second — so half-hour and 45-minute zones (India, Nepal, Chatham) are exact.
 * An unusable timezone is treated as UTC, as in localParts.
 */
function offsetAt(instant: number, timezone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(new Date(instant));
  } catch {
    return 0;
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  // Formatting drops milliseconds; put them back so the difference is the offset alone.
  return wall - (instant - (((instant % 1000) + 1000) % 1000));
}

/**
 * The local hour, 0–23, on the zone's STANDARD time all year — the clock a published rule
 * means when it says "10:00 standard time". The standard offset is the smaller of the
 * offsets in force on January 15 and July 15 of the instant's year, which is the
 * non-daylight one in either hemisphere; a zone without daylight saving gets its only
 * offset. An unusable timezone is treated as UTC, as in localParts.
 */
export function standardHour(now: Date, timezone = 'UTC'): number {
  const year = now.getUTCFullYear();
  const standard = Math.min(
    offsetAt(Date.UTC(year, 0, 15, 12), timezone),
    offsetAt(Date.UTC(year, 6, 15, 12), timezone),
  );
  return new Date(now.getTime() + standard).getUTCHours();
}

/**
 * The first instant of local `date` (`YYYY-MM-DD`) in `timezone` — local midnight, or,
 * on a date where a DST change skips midnight (Santiago, Havana, Asunción, …), the
 * first local time that exists that day, e.g. 01:00.
 *
 * Midnight is tried at the offset in force a day before and a day after, which are the
 * only two offsets a date can straddle. Whichever candidate reads as 00:00 on `date`
 * wins (the earlier, if midnight happens twice). If neither does, midnight fell in a
 * gap, and the day starts at the transition, found by bisection between the two.
 */
export function zonedMidnight(date: string, timezone = 'UTC'): Date {
  const target = Date.parse(`${date}T00:00:00Z`);
  const wallAt = (t: number) => t + offsetAt(t, timezone);
  const candidates = [offsetAt(target - 86_400_000, timezone), offsetAt(target + 86_400_000, timezone)]
    .map((off) => target - off)
    .sort((a, b) => a - b);
  for (const c of candidates) if (wallAt(c) === target) return new Date(c);

  // Skipped midnight: `lo` reads as the previous day, `hi` as later on `date`. Every
  // instant between is one or the other, so bisect for the first that is on `date`.
  let [lo, hi] = candidates;
  if (wallAt(hi) < target) [lo, hi] = [hi, lo];
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2000) * 1000;
    if (mid <= lo) break;
    if (wallAt(mid) >= target) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}

/**
 * The complete local days a day-based model can judge: from the season start through
 * yesterday. null when the season starts today or later — there is no complete day yet.
 */
export function completeDays(since: string, now: Date, timezone = 'UTC'): { start: string; end: string } | null {
  const start = seasonStart(since, now, timezone);
  const end = addDays(localDate(now, timezone), -1);
  return start > end ? null : { start, end };
}
