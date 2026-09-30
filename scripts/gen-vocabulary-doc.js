#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Regenerates docs/vocabulary.md from the normalized codec vocabulary.
//
// docs/vocabulary.md is checked in so the repo documents itself without requiring
// the codec package to be installed. Run this after a vocabulary change:
//
//   npm i --no-save @intelligent-farming/lorawan-codec-normalization
//   node scripts/gen-vocabulary-doc.js > docs/vocabulary.md
//
// Resolution order for the vocabulary source: the installed package, then a sibling
// checkout (../lorawan-codec-normalization), then $LORAWAN_CODEC_NORMALIZATION_DIR.

const fs = require('node:fs');
const path = require('node:path');

function findDefinitions() {
  const candidates = [
    process.env.LORAWAN_CODEC_NORMALIZATION_DIR,
    path.join(__dirname, '..', 'node_modules', '@intelligent-farming', 'lorawan-codec-normalization'),
    path.join(__dirname, '..', '..', 'lorawan-codec-normalization'),
  ].filter(Boolean);

  for (const base of candidates) {
    const defs = path.join(base, 'definitions', 'vocabulary.schema.json');
    if (fs.existsSync(defs)) return { schema: defs, categories: path.join(base, 'definitions', 'categories') };
  }
  throw new Error(
    'vocabulary.schema.json not found. Install @intelligent-farming/lorawan-codec-normalization, ' +
      'check out the sibling repo, or set LORAWAN_CODEC_NORMALIZATION_DIR.',
  );
}

const { schema: schemaPath, categories: categoriesDir } = findDefinitions();
const vocab = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const D = vocab.$defs || {};

const deref = (n) => {
  if (!n || typeof n !== 'object') return n;
  if (typeof n.$ref === 'string' && n.$ref.startsWith('#/$defs/')) {
    const t = D[n.$ref.slice('#/$defs/'.length)];
    return { ...t, ...(n.description ? { description: n.description } : {}) };
  }
  return n;
};

// The schema carries units only as parenthesised text in each description, and not every
// parenthesis is a unit: "Hydrostatic (liquid) pressure (kPa)", "occupied (true) or
// vacant (false)", "net count (in - out)". Take the first parenthesis that reads as a
// unit — a symbol or a unit word, not prose, a boolean legend or an expression.
const UNIT_WORDS = new Set(['count', 'lux', 'ppm', 'ppb']);
function unitOf(description) {
  for (const [, text] of description.matchAll(/\(([^)]+)\)/g)) {
    const t = text.trim();
    if (/=|\s-\s/.test(t) || /^(true|false)$/.test(t)) continue;
    if (/^[a-z]{4,}$/.test(t) && !UNIT_WORDS.has(t)) continue;
    if (t.split(/\s+/).length > 2) continue;
    return t;
  }
  return '';
}

const leaves = [];
(function walk(node, p) {
  node = deref(node);
  if (!node || typeof node !== 'object') return;
  if (node.properties) {
    for (const [k, s] of Object.entries(node.properties)) walk(s, p ? `${p}.${k}` : k);
    return;
  }
  if (node.items) return walk(node.items, `${p}[]`);
  const type = Array.isArray(node.type) ? node.type.join(' \\| ') : node.type || '?';
  leaves.push({
    path: p,
    type,
    unit: unitOf(node.description || ''),
    min: node.minimum,
    max: node.maximum,
    exMax: node.exclusiveMaximum,
    enumVals: node.enum,
  });
})(D.measurement, '');

// Which checks make sense for a given path. Booleans and enums route to
// boolean-alarm; cumulative totals to the counter checks; everything numeric and
// instantaneous to the measurement checks.
// Only paths the schema describes as cumulative. Per-interval counts (pulse.count,
// action.button.count, people.in/out), time-in-current-state (action.occupancy.duration)
// and action.motion.count, whose schema text does not promise a running total, reset
// or fall as a matter of course — counter-stalled would call that "went backwards".
const COUNTERS = new Set([
  'metering.water.total', 'metering.energy.total', 'pulse.total',
  'device.runtime', 'rain.cumulative',
]);
const POSITIONS = new Set(['position.latitude', 'position.longitude']);
const NON_TELEMETRY = new Set(['time', 'air.location', 'hvac.mode', 'action.button.event']);

// Checks that apply to a path beyond what its type implies. `pre` sits before
// measurement-implausible in the column and `post` after it.
const EXTRA_CHECKS = {
  temperature: { pre: ['`mold-risk` (as the gate)'], post: ['`measurement-derived`'] },
  'air.temperature': { pre: ['`mold-risk` (as the gate)'], post: ['`measurement-derived`'] },
  'leaf.temperature': { pre: ['`mold-risk` (as the gate)'], post: ['`measurement-derived`'] },
  'air.relativeHumidity': { pre: ['`mold-risk`'], post: ['`measurement-derived`'] },
  'leaf.wetness': { pre: ['`mold-risk`'], post: [] },
  'soil.moisture': { pre: [], post: ['`soil-deficit-band`'] },
};
const isRanged = (leaf) =>
  leaf.min !== undefined || leaf.max !== undefined || leaf.exMax !== undefined;

function checksColumn(leaf) {
  const base = checksFor(leaf);
  if (base[0] === '—') return '—';
  const extra = EXTRA_CHECKS[leaf.path] ?? { pre: [], post: [] };
  return [
    ...base.map((c) => `\`${c}\``),
    ...extra.pre,
    ...(isRanged(leaf) ? ['`measurement-implausible`'] : []),
    ...extra.post,
  ].join(', ');
}

function checksFor(leaf) {
  if (NON_TELEMETRY.has(leaf.path)) return ['—'];
  if (POSITIONS.has(leaf.path)) return ['geofence-breach'];
  if (leaf.type.includes('boolean')) return ['boolean-alarm'];
  if (leaf.enumVals) return ['boolean-alarm'];
  if (leaf.path === 'battery' || leaf.path === 'power.voltage') {
    return ['battery-low', 'measurement-threshold'];
  }
  if (COUNTERS.has(leaf.path)) {
    // rain.cumulative excluded from counter-stalled: a flat rain counter is dry
    // weather, not a fault.
    return leaf.path === 'rain.cumulative'
      ? ['counter-spike', 'measurement-missing']
      : ['counter-stalled', 'counter-spike'];
  }
  return ['measurement-threshold', 'measurement-peak', 'measurement-rate', 'measurement-stuck'];
}

const out = [];
out.push('<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->');
out.push('<!-- Copyright (C) 2026 Intelligent Farming Foundation -->');
out.push('');
out.push('# Normalized measurement vocabulary');
out.push('');
out.push('Every path a Leadsman check can be pointed at, and which check to use for it.');
out.push('');
out.push('Generated from `definitions/vocabulary.schema.json` in');
out.push('[@intelligent-farming/lorawan-codec-normalization](https://github.com/intelligent-farming/lorawan-codec-normalization)');
out.push('— regenerate with `node scripts/gen-vocabulary-doc.js > docs/vocabulary.md`.');
out.push('');
out.push('**Units are guaranteed.** Any device whose profile carries a normalized codec emits');
out.push('these paths in these units regardless of vendor, which is why the shipped checks can');
out.push('have meaningful default thresholds. A device on an upstream (non-normalized) codec');
out.push('will not match these paths at all — it is ignored rather than misread, and');
out.push('`measurement-missing` is what tells you it happened.');
out.push('');
out.push('## Beyond `event_up`');
out.push('');
out.push('Everything below describes the decoded `object` in `event_up`. Five checks read other');
out.push('ChirpStack tables instead, where the fields are columns rather than vocabulary paths and');
out.push('so take no `paths` parameter:');
out.push('');
out.push('| Check | Table | Columns it reads |');
out.push('|---|---|---|');
out.push('| `device-log-error` | `event_log` | `level`, `code`, `description` |');
out.push('| `status-battery-low` | `event_status` | `battery_level`, `battery_level_unavailable`, `external_power_source` |');
out.push('| `status-margin-low` | `event_status` | `margin` |');
out.push('| `join-churn` | `event_join` | `dev_addr` (plus `event_up` for the uplink ratio) |');
out.push('| `downlink-unacked` | `event_ack` | `acknowledged`, `f_cnt_down` |');
out.push('');
out.push('`event_status.battery_level` is worth singling out: it is a battery percentage from the');
out.push('LoRaWAN MAC layer, so it works on a device whose payload codec emits nothing at all.');
out.push('');
out.push('## Multi-path resolution');
out.push('');
out.push('One concept often spans several paths, because which one a device emits depends on');
out.push('what kind of sensor it is. Every check therefore takes a **priority-ordered list**,');
out.push('resolves the first path present *per device* — in the newest uplink that carries any');
out.push('candidate — and ignores devices carrying none of them. So a single entry covers a mixed fleet:');
out.push('');
out.push('```json');
out.push('{ "rule": "measurement-threshold", "as": "frost-risk",');
out.push('  "params": { "paths": ["air.temperature", "temperature", "leaf.temperature"],');
out.push('              "min": 1.5, "unit": "C" } }');
out.push('```');
out.push('');
out.push(`\`measurement-implausible\` enforces the **Range** column in the tables below. It is not configured per`);
out.push(`path: one config entry covers all ${leaves.filter(isRanged).length} paths that carry a declared bound, reading them`);
out.push('straight from the vocabulary schema. It is named in the Checks column wherever that');
out.push('column lists other checks, but its coverage is the Range column itself rather than that');
out.push('list — a path with a range is checked whether or not it is annotated here.');
out.push('');
out.push('Groupings worth knowing, since these are the ones that bite if you only list one:');
out.push('');
out.push('| Concept | Candidate paths, in a sensible priority order |');
out.push('|---|---|');
out.push('| Temperature | `air.temperature`, `temperature`, `soil.temperature`, `leaf.temperature`, `water.temperature.current` |');
out.push('| Level / fill | `tank.level`, `tank.volume`, `water.level`, `tank.distance`, `linear.position`, `analog.ratio` |');
out.push('| Supply voltage | `battery`, `power.voltage`, `analog.voltage` |');
out.push('| Moisture / wetness | `soil.moisture`, `leaf.wetness`, `air.relativeHumidity` |');
out.push('| Canopy wetness, for a disease model | `leaf.wetness`, `air.relativeHumidity` — one band cannot serve both, so give each its own `mold-risk` entry |');
out.push('| Accumulation inputs | `air.temperature` (degree days), `air.par` (light integral), `rain.intensity` (rainfall) — all via `measurement-accumulation`, and note `method` differs between a rate and a per-report quantity |');
out.push('| Pressure | `pressure.gauge`, `pressure.absolute`, `water.pressure`, `air.pressure`, `pressure.differential` |');
out.push('| Cumulative total | `metering.water.total`, `metering.energy.total`, `pulse.total`, `device.runtime` |');
out.push('| Asserted flag | `water.leak`, `air.gasAlarm`, `action.smoke.detected`, `action.motion.detected`, `action.switch.state`, `action.contactState` |');
out.push('| Vibration | `vibration.velocityRms`, `vibration.accelerationRms`, `vibration.accelerationPeak` |');
out.push('');
out.push(`## All paths (${leaves.length})`);
out.push('');

const groups = new Map();
for (const leaf of leaves) {
  const g = leaf.path.split('.')[0];
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(leaf);
}

for (const [group, rows] of groups) {
  out.push(`### \`${group}\``);
  out.push('');
  out.push('| Path | Type | Unit | Range | Checks |');
  out.push('|---|---|---|---|---|');
  for (const r of rows) {
    const range = [
      r.min !== undefined ? `≥ ${r.min}` : '',
      r.max !== undefined ? `≤ ${r.max}` : '',
      r.exMax !== undefined ? `< ${r.exMax}` : '',
      r.enumVals ? r.enumVals.map((v) => `\`${v}\``).join(', ') : '',
    ].filter(Boolean).join(', ');
    out.push(
      `| \`${r.path}\` | ${r.type} | ${r.unit ? `${r.unit}` : '—'} | ${range || '—'} | ` +
        `${checksColumn(r)} |`,
    );
  }
  out.push('');
}

// Category manifests: what each device type can be expected to emit.
if (fs.existsSync(categoriesDir)) {
  const cats = fs.readdirSync(categoriesDir).filter((f) => f.endsWith('.json')).sort();
  out.push(`## Device categories (${cats.length})`);
  out.push('');
  out.push('`requires` is what a device in the category always emits; `provides` is what it may');
  out.push('also emit. Use these to decide which paths to list in a check that should cover a');
  out.push('whole category.');
  out.push('');
  out.push('| Category | Always | May also |');
  out.push('|---|---|---|');
  for (const f of cats) {
    const c = JSON.parse(fs.readFileSync(path.join(categoriesDir, f), 'utf8'));
    // A manifest may name a parent object (`action.motion`) rather than a leaf; show it as
    // the family of leaves it stands for.
    const leafPaths = new Set(leaves.map((l) => l.path));
    const asPath = (p) => (leafPaths.has(p) || !leaves.some((l) => l.path.startsWith(`${p}.`)) ? p : `${p}.*`);
    const fmt = (a) => ((a || []).length ? a.map((p) => `\`${asPath(p)}\``).join(', ') : '—');
    out.push(`| ${c.id} | ${fmt(c.requires)} | ${fmt(c.provides)} |`);
  }
  out.push('');
}

process.stdout.write(`${out.join('\n')}\n`);
