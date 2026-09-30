/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Published agronomic models, as pure functions over hourly and daily summaries.
 *
 * Everything here is arithmetic from a paper or an extension model page, kept free of
 * SQL and of the engine so it can be tested against the published worked values
 * directly. The rules in src/rules/ fetch an hourly series (measurement.hourlySeries),
 * reduce it with the helpers below, and decide what to raise.
 *
 * Every DAY-BASED model is judged on COMPLETE local days. A day's minimum is not known
 * until the day is over, and a degree-day or a disease-severity value computed from half
 * a day is a different number from the one the model was calibrated on. The cost is that
 * a day-based alert arrives shortly after local midnight rather than during the day.
 * Chill is the exception: its models are hourly, so chill-accumulation counts through
 * the hours of today observed so far.
 */

import type { HourAgg } from './measurement';
import { addDays, daysBetween } from './season';

// ── hour and day bookkeeping ─────────────────────────────────────────────────

/** Absolute local hour number for a `YYYY-MM-DDTHH` key, for adjacency tests. */
export function hourIndex(hour: string): number {
  return daysBetween('1970-01-01', hour.slice(0, 10)) * 24 + Number(hour.slice(11, 13));
}

/** One local day reduced to the statistics the models read. */
export interface DaySummary {
  date: string;
  /** Hours that had at least one reading, 0–24. */
  hoursObserved: number;
  /** Coldest reading of the day (min of hourly minima). Null with no data. */
  min: number | null;
  /** Hottest reading of the day (max of hourly maxima). */
  max: number | null;
  /** Mean of the hourly means. */
  mean: number | null;
  /** The day's hours, ascending. */
  hours: HourAgg[];
}

/**
 * Group hours into local days and return one summary for every date from `from` to
 * `to` inclusive — including days with no data at all, so a gap is visible as
 * `hoursObserved: 0` rather than silently shortening the season.
 *
 * `dayStartHour` moves the day boundary: with 9, day D runs from D 09:00 to D+1 09:00
 * local and is named by its start date — the UK climatological day, which keeps one
 * night inside one day. The hours keep their own labels, so runs and adjacency within a
 * day are still read from real clock hours.
 */
export function summarizeDays(hours: HourAgg[], from: string, to: string, dayStartHour = 0): DaySummary[] {
  const dayOf = (hour: string): string => {
    const date = hour.slice(0, 10);
    return dayStartHour > 0 && Number(hour.slice(11, 13)) < dayStartHour ? addDays(date, -1) : date;
  };
  const byDate = new Map<string, HourAgg[]>();
  for (const h of hours) {
    const d = dayOf(h.hour);
    if (d < from || d > to) continue;
    let list = byDate.get(d);
    if (!list) byDate.set(d, (list = []));
    list.push(h);
  }
  const out: DaySummary[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const list = byDate.get(d) ?? [];
    if (list.length === 0) {
      out.push({ date: d, hoursObserved: 0, min: null, max: null, mean: null, hours: [] });
      continue;
    }
    out.push({
      date: d,
      hoursObserved: new Set(list.map((h) => h.hour)).size,
      min: Math.min(...list.map((h) => h.min)),
      max: Math.max(...list.map((h) => h.max)),
      mean: list.reduce((s, h) => s + h.mean, 0) / list.length,
      hours: list,
    });
  }
  return out;
}

/** Whether a value lies in a band with optional ends. */
export function inBand(v: number, min: number | null, max: number | null): boolean {
  return (min === null || v >= min) && (max === null || v <= max);
}

/** Hours whose mean lies in the band. */
export function hoursInBand(hours: HourAgg[], min: number | null, max: number | null): number {
  return hours.filter((h) => inBand(h.mean, min, max)).length;
}

/**
 * The longest run of CONSECUTIVE clock hours whose mean lies in the band. A missing
 * hour breaks the run: nothing is known about it, and "six continuous hours" is the
 * model's own condition.
 */
export function longestRunInBand(hours: HourAgg[], min: number | null, max: number | null): number {
  let best = 0;
  let run = 0;
  let prev: number | null = null;
  for (const h of hours) {
    const idx = hourIndex(h.hour);
    const ok = inBand(h.mean, min, max);
    if (ok && prev !== null && idx === prev + 1 && run > 0) run += 1;
    else run = ok ? 1 : 0;
    prev = idx;
    if (run > best) best = run;
  }
  return best;
}

// ── degree-days ──────────────────────────────────────────────────────────────

export type DegreeDayMethod = 'sine' | 'average' | 'modified';
export type Cutoff = 'horizontal' | 'vertical';

/**
 * Degree-days for one day from its minimum and maximum.
 *
 *   sine      single sine (Baskerville & Emin 1969; Zalom et al. 1983) — the method
 *             UC IPM uses for its insect models. The day is approximated as a sine
 *             wave between the extremes and the area between the thresholds is
 *             integrated. With an upper threshold, `horizontal` counts the capped area
 *             above it as (upper − lower) and `vertical` counts none of it.
 *   average   (Tmax + Tmin) / 2 − lower, floored at 0. Winkler index, cotton DD60.
 *             No upper threshold.
 *   modified  the corn GDD method: Tmax capped at `upper`, Tmin floored at `lower`,
 *             then the average minus `lower`.
 */
export function dailyDegreeDays(
  tmin: number,
  tmax: number,
  lower: number,
  upper: number | null,
  method: DegreeDayMethod,
  cutoff: Cutoff = 'horizontal',
): number {
  if (tmax < tmin) [tmin, tmax] = [tmax, tmin];

  if (method === 'average') return Math.max(0, (tmax + tmin) / 2 - lower);

  if (method === 'modified') {
    // Both extremes are clamped into [lower, upper] — a 45 °F maximum counts as 50 and
    // a 90 °F minimum as 86 — which is what keeps the method from ever going negative.
    const clamp = (t: number) => Math.max(lower, upper === null ? t : Math.min(t, upper));
    return (clamp(tmax) + clamp(tmin)) / 2 - lower;
  }

  // Single sine.
  const up = upper ?? Infinity;
  if (tmax <= lower) return 0;
  if (tmin >= up) return cutoff === 'horizontal' ? up - lower : 0;

  const m = (tmax + tmin) / 2;
  const w = (tmax - tmin) / 2;
  const PI = Math.PI;

  if (tmin >= lower && tmax <= up) return m - lower;

  if (tmin < lower && tmax <= up) {
    const t1 = Math.asin((lower - m) / w);
    return ((m - lower) * (PI / 2 - t1) + w * Math.cos(t1)) / PI;
  }

  if (tmin >= lower) {
    // tmax > upper
    const t2 = Math.asin((up - m) / w);
    const base = (m - lower) * (t2 + PI / 2) - w * Math.cos(t2);
    return (cutoff === 'horizontal' ? base + (up - lower) * (PI / 2 - t2) : base) / PI;
  }

  // tmin < lower and tmax > upper
  const t1 = Math.asin((lower - m) / w);
  const t2 = Math.asin((up - m) / w);
  const base = (m - lower) * (t2 - t1) + w * (Math.cos(t1) - Math.cos(t2));
  return (cutoff === 'horizontal' ? base + (up - lower) * (PI / 2 - t2) : base) / PI;
}

// ── chill ────────────────────────────────────────────────────────────────────

export type ChillModel = 'hours' | 'utah' | 'dynamic';

/**
 * Utah chill units for one hour (Richardson, Seeley & Walker 1974). Warm hours count
 * against chill already banked.
 */
export function utahUnits(t: number): number {
  if (t <= 1.4) return 0;
  if (t <= 2.4) return 0.5;
  if (t <= 9.1) return 1;
  if (t <= 12.4) return 0.5;
  if (t <= 15.9) return 0;
  if (t <= 18.0) return -0.5;
  return -1;
}

/**
 * Chill portions by the Dynamic model (Fishman, Erez & Couvillon 1987), for hourly
 * temperatures in °C in order. The implementation follows the widely used spreadsheet
 * by Erez and Luedeling, as in chillR's Dynamic_Model: a precursor accumulates at
 * chilling temperatures and can be destroyed by warmth until it reaches a critical
 * level, at which point a share of it is fixed as a permanent portion.
 *
 * A missing hour is skipped, not interpolated: `temps` is the hours that were observed.
 */
export function dynamicChillPortions(temps: number[]): number {
  const E0 = 4153.5;
  const E1 = 12888.8;
  const A0 = 139500;
  const A1 = 2.567e18;
  const slope = 1.6;
  const TF = 277;
  const aa = A0 / A1;
  const ee = E1 - E0;

  let interE = 0;
  let prevXi = 0;
  let portions = 0;
  for (let i = 0; i < temps.length; i++) {
    const tk = temps[i] + 273;
    const ftmprt = (slope * TF * (tk - TF)) / tk;
    const sr = Math.exp(ftmprt);
    const xi = sr / (1 + sr);
    const xs = aa * Math.exp(ee / tk);
    const ak1 = A1 * Math.exp(-E1 / tk);
    // Once the precursor has reached 1 in the previous hour, the fixed share of it was
    // converted to a portion and only the remainder carries forward.
    const s = i === 0 ? 0 : interE < 1 ? interE : interE - interE * prevXi;
    interE = xs - (xs - s) * Math.exp(-ak1);
    if (interE >= 1) portions += interE * xi;
    prevXi = xi;
  }
  return portions;
}

/**
 * Accumulated chill over hourly temperatures, by model.
 *
 *   hours    count of hours with `min < T <= max` (min null for "below max")
 *   utah     running sum of Utah units, never below zero
 *   dynamic  chill portions
 */
export function accumulateChill(
  temps: number[],
  model: ChillModel,
  min: number | null = 0,
  max = 7.2,
): number {
  if (model === 'hours') {
    return temps.filter((t) => (min === null || t > min) && t <= max).length;
  }
  if (model === 'utah') {
    let total = 0;
    for (const t of temps) total = Math.max(0, total + utahUnits(t));
    return total;
  }
  return dynamicChillPortions(temps);
}

// ── Gubler-Thomas grape powdery mildew risk index ────────────────────────────

export interface GublerThomasDay {
  date: string;
  /** Longest run of consecutive hours at 21–29.4 °C. */
  runHours: number;
  /** Whether the day reached 35 °C. */
  heat: boolean;
  /** False when the day was too sparsely observed to judge. */
  known: boolean;
}

export interface GublerThomasState {
  /** null until the index has started (three consecutive qualifying days). */
  index: number | null;
  /** Consecutive qualifying days while waiting to start. */
  consecutive: number;
  /** The date the index started, if it has. */
  startedOn: string | null;
}

/**
 * The UC Davis (Gubler-Thomas) conidial risk index.
 *
 * UC IPM: the index starts after three consecutive days with at least six continuous
 * hours at 21–29.4 °C (70–85 °F), at 60. After that, each day with six such hours adds
 * 20 and each day without subtracts 10; a qualifying day that also reaches 35 °C
 * (95 °F) for 15 minutes adds only 10. "On any one day the index should not decline by
 * more than 10 points or increase by more than 20 points", so heat on a day that
 * already failed takes nothing further off. The index is bounded 0–100. 0–30 is low,
 * 40–50 moderate, 60–100 high pressure.
 *
 * A day not observed well enough to judge (`known: false`) breaks the start-up streak
 * and leaves a running index unchanged — neither a qualifying day nor a failing one
 * was seen, and inventing either would move the spray interval on no evidence.
 */
export function gublerThomas(days: GublerThomasDay[], minRunHours = 6): GublerThomasState {
  const state: GublerThomasState = { index: null, consecutive: 0, startedOn: null };
  for (const d of days) {
    const qualifies = d.known && d.runHours >= minRunHours;
    if (state.index === null) {
      state.consecutive = qualifies ? state.consecutive + 1 : 0;
      if (state.consecutive >= 3) {
        state.index = 60;
        state.startedOn = d.date;
      }
      continue;
    }
    if (!d.known) continue;
    const delta = qualifies ? (d.heat ? 10 : 20) : -10;
    state.index = Math.min(100, Math.max(0, state.index + delta));
  }
  return state;
}

/**
 * Spray intervals in days for an index value, from the UC IPM Gubler-Thomas model page
 * (https://ipm.ucanr.edu/DISEASE/DATABASE/grapepowderymildew.html): sulfur dust
 * 14/10/7, micronized sulfur 18/14/10, DMI 21/17/14 at low/moderate/high pressure. The
 * current UC IPM grape pest-management guideline gives ranges instead (e.g. sulfur
 * 14–21/10–17/7 days) and label intervals vary by product; these are the model page's
 * single figures, a starting point rather than a label.
 */
export function gublerThomasIntervals(index: number): {
  pressure: 'low' | 'moderate' | 'high';
  sulfurDustDays: number;
  micronizedSulfurDays: number;
  dmiDays: number;
} {
  if (index >= 60) return { pressure: 'high', sulfurDustDays: 7, micronizedSulfurDays: 10, dmiDays: 14 };
  if (index >= 40) return { pressure: 'moderate', sulfurDustDays: 10, micronizedSulfurDays: 14, dmiDays: 17 };
  return { pressure: 'low', sulfurDustDays: 14, micronizedSulfurDays: 18, dmiDays: 21 };
}

// ── TOM-CAST disease severity values ─────────────────────────────────────────

/**
 * Daily disease severity value (0–4) from hours of leaf wetness and the mean
 * temperature during them — the FAST table TOM-CAST uses (Madden, Pennypacker &
 * MacNab 1978), as published by UC IPM for tomato black mold. The mean is rounded to
 * the nearest whole °C, as the table's rows are whole degrees; outside 13–29 °C the
 * value is 0.
 */
export function tomcastDsv(wetHours: number, meanTempDuringWetness: number): number {
  const t = Math.round(meanTempDuringWetness);
  const h = wetHours;
  if (t < 13 || t > 29) return 0;
  // [upper bound of hours for DSV 0, 1, 2, 3]; above the last is DSV 4 (or 3 at 13–17).
  let bounds: number[];
  if (t <= 17) bounds = [6, 15, 20];
  else if (t <= 20 || t >= 26) bounds = [3, 8, 15, 22];
  else bounds = [2, 5, 12, 20];
  let dsv = 0;
  while (dsv < bounds.length && h > bounds[dsv]) dsv += 1;
  return dsv;
}

// ── Wallin late-blight severity values ───────────────────────────────────────

/**
 * Daily late-blight severity value (0–4) from hours at RH ≥ 90 % and the mean
 * temperature during them — the Wallin table that BLITECAST builds on, as published by
 * UC IPM:
 *
 *   mean °C during RH ≥ 90 %   SV 0    SV 1    SV 2    SV 3    SV 4
 *   7.2–11.6  (45–53 °F)       ≤ 15    16–18   19–21   22–24   25+
 *   11.7–15.0 (53–59 °F)       ≤ 12    13–15   16–18   19–21   22+
 *   15.1–26.6 (59–80 °F)       ≤ 9     10–12   13–15   16–18   19+
 *
 * Outside 7.2–26.6 °C the value is 0. Wallin counted hours per humid period; BLITECAST
 * implementations, like this one, count them per day, which is how the model reaches a
 * sensor that reports a day at a time. A mean between two rows (11.6–11.7) takes the
 * row above it.
 */
export function wallinSv(humidHours: number, meanTempDuringHumidity: number): number {
  const t = meanTempDuringHumidity;
  if (t < 7.2 || t > 26.6) return 0;
  // [upper bound of hours for SV 0, 1, 2, 3]; above the last is SV 4.
  const bounds = t <= 11.6 ? [15, 18, 21, 24] : t <= 15.0 ? [12, 15, 18, 21] : [9, 12, 15, 18];
  let sv = 0;
  while (sv < bounds.length && humidHours > bounds[sv]) sv += 1;
  return sv;
}
