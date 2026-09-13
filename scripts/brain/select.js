#!/usr/bin/env node
'use strict';
// Pick the skills named in manifest.json out of the flat skills/ dump and write them, grouped by category,
// to build/selected/<category>/<name>/, or build/selected-self/ with --self. Regenerated each run; edit skills/, not build/.
const path = require('path');
const { SELECTED_DIR, SELECTED_SELF_DIR, rmrf, copyTree, writeJson, loadManifest } = require('./lib/fs-utils');
const { indexDump, resolveManifest } = require('./lib/dump');

const selfBuild = process.argv.includes('--self');
const outDir = selfBuild ? SELECTED_SELF_DIR : SELECTED_DIR;
const manifest = loadManifest({ selfBuild });
const entries = indexDump();
const { selected, errors } = resolveManifest(manifest, entries);
const bad = selected.filter(e => e.problems.length);
for (const e of bad) for (const p of e.problems) console.error(`ERROR skills/${e.name}: ${p}`);
for (const e of errors) console.error(`ERROR manifest.json: ${e}`);
if (bad.length || errors.length) process.exit(1);

rmrf(outDir);
const index = [];
for (const e of selected) {
  copyTree(e.dir, path.join(outDir, e.category, e.name));
  index.push({ name: e.name, category: e.category, description: e.data.description });
  console.log(`  + ${e.category}/${e.name}`);
}
writeJson(path.join(outDir, 'INDEX.json'), { generatedAt: new Date().toISOString(), selfBuild, skills: index });
console.log(`\n${index.length} skill(s) written to ${path.relative(process.cwd(), outDir)}/ (${[...new Set(index.map(i => i.category))].sort().join(', ')})`);
