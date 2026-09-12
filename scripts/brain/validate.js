#!/usr/bin/env node
'use strict';
// Validate the brain sources: skills/ (skill anatomy via the repo linter), agents/ (persona anatomy),
// manifest.json, templates/, references/. Exit 1 on errors.
const path = require('path');
const fs = require('fs');
const { TEMPLATES_DIR, ORG_DIR_SRC, REPORTS_DIR, CONTROL_PLANE_DIR, REFERENCES_DIR, exists, loadManifest } = require('./lib/fs-utils');
const { indexDump, resolveManifest } = require('./lib/dump');
const { indexPersonas } = require('./lib/personas');
const { TARGETS } = require('./lib/targets');
const { lintSkillContent } = require(path.join(__dirname, '..', 'lib', 'skill-lint'));

const errors = [];
const warnings = [];
const manifest = loadManifest();

// Skills: index problems for all, anatomy lint for selected.
const entries = indexDump();
for (const e of entries) for (const p of e.problems) errors.push(`skills/${e.name}: ${p}`);
const { selected, errors: selErrors } = resolveManifest(manifest, entries);
errors.push(...selErrors.map(e => `manifest.json: ${e}`));
const known = new Set(entries.map(e => e.name));
for (const e of selected) {
  const r = lintSkillContent(e.name, fs.readFileSync(path.join(e.dir, 'SKILL.md'), 'utf8'), known);
  for (const m of r.errors) errors.push(`skills/${e.name}: ${m}`);
  for (const m of r.warnings) warnings.push(`skills/${e.name}: ${m}`);
}

// Personas: only those the manifest selects are part of the organization.
if (!manifest.personas.length) errors.push('manifest.json: `personas` is empty');
const personas = indexPersonas(manifest.personas);
const selectedNames = new Set(selected.map(e => e.name));
for (const p of personas) {
  for (const m of p.problems) errors.push(`agents/${p.name}.md: ${m}`);
  for (const s of p.skills) {
    if (!known.has(s)) errors.push(`agents/${p.name}.md: skill "${s}" does not exist in skills/`);
    else if (!selectedNames.has(s)) errors.push(`agents/${p.name}.md: skill "${s}" is not selected in manifest.json`);
  }
}
if (!personas.some(p => p.name === 'ceo')) errors.push('manifest.json: persona "ceo" must be selected; the organization has exactly one CEO');
for (const role of ['product-manager', 'engineering-manager']) if (!personas.some(p => p.name === role)) warnings.push(`persona "${role}" is not selected; org/ refers to it`);
if (!personas.some(p => /principal-engineer$/.test(p.name))) warnings.push('no principal-engineer persona selected');
if (!personas.some(p => /staff-engineer$/.test(p.name))) warnings.push('no staff-engineer persona selected');

// Targets, PM tool, templates, references
for (const t of manifest.targets) if (!TARGETS[t]) errors.push(`manifest.json: unknown target "${t}" (known: ${Object.keys(TARGETS).join(', ')})`);
if (manifest.projectManagement && !selectedNames.has(manifest.projectManagement)) warnings.push(`manifest.json: projectManagement "${manifest.projectManagement}" is not a selected skill`);
const orgParts = exists(ORG_DIR_SRC) ? fs.readdirSync(ORG_DIR_SRC).filter(f => /^\d+-.*\.md$/.test(f)) : [];
if (!orgParts.length) errors.push('org/ has no numbered parts (NN-name.md)');
for (const f of ['README.md', 'ceo-report.md', 'pm-report.md', 'em-report.md',
  'principal-engineer-design-report.md', 'design-review.md', 'staff-engineer-report.md', 'merge-review.md', 'qa-report.md']) {
  if (!exists(path.join(REPORTS_DIR, f))) errors.push(`agents-reports/${f} is missing`);
}
for (const f of ['README.md', 'schema.sql', 'db.js', 'state.js', 'brain.js', 'emit.js', 'quota.js', 'control.js',
  'server.js', 'ui.html', 'hook.js', 'event.schema.json', 'herdr-plugin.toml', '.gitignore']) {
  if (!exists(path.join(CONTROL_PLANE_DIR, f))) errors.push(`control-plane/${f} is missing`);
}
for (const f of ['global-docs/CONVENTIONS.md', 'global-docs/DECISIONS.md', 'global-docs/CHANGELOG.md',
  'service-docs/CONVENTIONS.md', 'service-docs/CHANGELOG.md', 'service-docs/HLD.md', 'service-docs/LLD.md',
  'service-docs/CURRENT_MILESTONE.md', 'service-docs/DECISIONS.md', 'service-docs/RCA.md',
  'commands/brain.md']) {
  if (!exists(path.join(TEMPLATES_DIR, f))) errors.push(`templates/${f} is missing`);
}
if (!exists(path.join(REFERENCES_DIR, 'project-management-interface.md'))) errors.push('references/project-management-interface.md is missing');
if (!exists(path.join(REFERENCES_DIR, 'agent-observability.md'))) errors.push('references/agent-observability.md is missing');

console.log(`skills: ${entries.length} in skills/, ${selected.length} selected · personas: ${personas.length} selected`);
for (const w of warnings) console.log(`  WARN  ${w}`);
for (const e of errors) console.log(`  ERROR ${e}`);
console.log(errors.length ? `\nFAILED (${errors.length} error(s))` : `\nOK${warnings.length ? ` with ${warnings.length} warning(s)` : ''}`);
process.exit(errors.length ? 1 : 0);
