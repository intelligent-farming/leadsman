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
  const m = /\(([^)]+)\)/.exec(node.description || '');
  leaves.push({
    path: p,
    type,
    unit: m ? m[1] : '',
    min: node.minimum,
    max: node.maximum,
    exMax: node.exclusiveMaximum,
    enumVals: node.enum,
  });
})(D.measurement, '');

// Which checks make sense for a given path. Booleans and enums route to
// boolean-alarm; cumulative totals to the counter checks; everything numeric and
// instantaneous to the measurement checks.
const COUNTERS = new Set([
  'metering.water.total', 'metering.energy.total', 'pulse.total', 'pulse.count',
  'device.runtime', 'rain.cumulative', 'action.motion.count', 'action.button.count',
  'action.occupancy.duration', 'people.in', 'people.out',
]);
const POSITIONS = new Set(['position.latitude', 'position.longitude']);
const NON_TELEMETRY = new Set(['time', 'air.location', 'hvac.mode', 'action.button.event']);

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
out.push('## Multi-path resolution');
out.push('');
out.push('One concept often spans several paths, because which one a device emits depends on');
out.push('what kind of sensor it is. Every check therefore takes a **priority-ordered list**,');
out.push('resolves the first path present *per device*, and ignores devices carrying none of');
out.push('them. So a single entry covers a mixed fleet:');
out.push('');
out.push('```json');
out.push('{ "rule": "measurement-threshold", "as": "frost-risk",');
out.push('  "params": { "paths": ["air.temperature", "temperature", "leaf.temperature"],');
out.push('              "min": 1.5, "unit": "C" } }');
out.push('```');
out.push('');
out.push('Groupings worth knowing, since these are the ones that bite if you only list one:');
out.push('');
out.push('| Concept | Candidate paths, in a sensible priority order |');
out.push('|---|---|');
out.push('| Temperature | `air.temperature`, `temperature`, `soil.temperature`, `leaf.temperature`, `water.temperature.current` |');
out.push('| Level / fill | `tank.level`, `tank.volume`, `water.level`, `tank.distance`, `linear.position`, `analog.ratio` |');
out.push('| Supply voltage | `battery`, `power.voltage`, `analog.voltage` |');
out.push('| Moisture / wetness | `soil.moisture`, `leaf.wetness`, `air.relativeHumidity` |');
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
        `${checksFor(r).map((c) => (c === '—' ? '—' : `\`${c}\``)).join(', ')} |`,
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
    const fmt = (a) => ((a || []).length ? a.map((p) => `\`${p}\``).join(', ') : '—');
    out.push(`| ${c.id} | ${fmt(c.requires)} | ${fmt(c.provides)} |`);
  }
  out.push('');
}

process.stdout.write(`${out.join('\n')}\n`);
