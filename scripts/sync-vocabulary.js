#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Intelligent Farming Foundation
//
// Regenerate src/vocabulary.ts from the codec package's vocabulary schema.
//
//   npm run vocabulary:sync -- ../lorawan-codec-normalization
//
// The schema is the source of truth for physically valid ranges; this vendors them so
// leadsman keeps its two-dependency tree. Run it when the codec package publishes new
// paths or revised bounds, and commit the result.

const fs = require('node:fs');
const path = require('node:path');

const pkgDir = process.argv[2] ?? '../lorawan-codec-normalization';
const schemaPath = path.resolve(pkgDir, 'definitions/vocabulary.schema.json');
if (!fs.existsSync(schemaPath)) {
  console.error(`no vocabulary schema at ${schemaPath}\nUsage: npm run vocabulary:sync -- <path-to-codec-package>`);
  process.exit(2);
}

const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const defs = schema.$defs ?? {};
const version = JSON.parse(
  fs.readFileSync(path.resolve(pkgDir, 'package.json'), 'utf8'),
).version;

const resolve = (node) => {
  for (let i = 0; i < 10 && node && node.$ref; i += 1) {
    node = defs[node.$ref.split('/').pop()] ?? {};
  }
  return node;
};

const ranges = new Map();
const walk = (node, prefix) => {
  node = resolve(node);
  if (!node || typeof node !== 'object') return;
  if (node.properties && typeof node.properties === 'object') {
    for (const [k, v] of Object.entries(node.properties)) {
      walk(v, prefix ? `${prefix}.${k}` : k);
    }
    return;
  }
  if (node.type === 'number' || node.type === 'integer') {
    const { minimum = null, maximum = null } = node;
    if (minimum !== null || maximum !== null) ranges.set(prefix, [minimum, maximum]);
  }
};
walk(schema, '');

const rows = [...ranges.entries()]
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([p, [lo, hi]]) => `  ['${p}', [${lo ?? 'null'}, ${hi ?? 'null'}]],`)
  .join('\n');

const out = `/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Copyright (C) 2026 Intelligent Farming Foundation
 *
 * Physically valid ranges for the normalized vocabulary.
 *
 * GENERATED — do not hand-edit. The source of truth is
 * \`definitions/vocabulary.schema.json\` in @intelligent-farming/lorawan-codec-normalization
 * (snapshot of v${version}), which carries an explicit \`minimum\`/\`maximum\` on
 * ${ranges.size} numeric leaves. Regenerate with \`npm run vocabulary:sync\`.
 *
 * ## Why this is vendored rather than imported
 *
 * Leadsman's whole dependency tree is \`pg\` + \`croner\`, and that is a property worth
 * keeping in something meant to run unattended on an edge device for years. These are
 * ${ranges.size} pairs of constants describing physics, not code: relative humidity has been a
 * percentage the whole time, and pH has been 0-14 since 1909. The cost of a stale copy
 * is a bound that is slightly generous; the cost of a dependency is a supply chain.
 *
 * ## What these bounds are NOT
 *
 * They are not agronomic limits. \`soil.moisture\` can be 0-100 % and still be a disaster
 * at 4 %. A value outside these bounds means the SENSOR or the CODEC is wrong — a
 * detached probe reading -40 % moisture, a byte-order bug turning 21.5 °C into 5504 °C,
 * a scaling error putting pH at 71. That is a data-integrity fault rather than a field
 * condition, which is why \`measurement-implausible\` reports it as one.
 *
 * A one-sided bound is still worth having: nothing measures a negative wind speed, a
 * negative humidity or a battery below zero volts, and each is a real failure signature.
 */

/** Inclusive \`[minimum, maximum]\`; \`null\` on either side means unbounded there. */
export type VocabularyRange = readonly [min: number | null, max: number | null];

/** Dotted vocabulary path to its physically valid range. */
export const VOCABULARY_RANGES: ReadonlyMap<string, VocabularyRange> = new Map<
  string,
  VocabularyRange
>([
${rows}
]);

/** Every path that carries a declared range, in a stable order. */
export const RANGED_PATHS: readonly string[] = [...VOCABULARY_RANGES.keys()];
`;

fs.writeFileSync(path.join(__dirname, '..', 'src', 'vocabulary.ts'), out);
console.log(`wrote ${ranges.size} ranges from codec-normalization v${version}`);
