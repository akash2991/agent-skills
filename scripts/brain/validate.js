#!/usr/bin/env node
'use strict';
// Validate the brain sources: skills/ (skill anatomy via the repo linter), agents/ (persona anatomy),
// manifest.json, templates/, references/. Exit 1 on errors.
const path = require('path');
const fs = require('fs');
const { ROOT, DUMP_DIR, AGENTS_DIR, TEMPLATES_DIR, ORG_DIR_SRC, REPORTS_DIR, CONTROL_PLANE_DIR, REFERENCES_DIR, DIST_DIR, DIST_SELF_DIR, exists, loadManifest } = require('./lib/fs-utils');
const { indexDump, resolveManifest } = require('./lib/dump');
const { indexPersonas } = require('./lib/personas');
const { TARGETS } = require('./lib/targets');
const { lintSkillContent } = require(path.join(__dirname, '..', 'lib', 'skill-lint'));

const errors = [];
const warnings = [];
// Validate everything that either build ships: the product selection plus whatever the self build
// adds. Omissions are not validated away, because they are still product artifacts.
const manifest = loadManifest({ selfBuild: true });
for (const name of manifest.selfOmitPersonas) if (!manifest.personas.includes(name)) manifest.personas.push(name);
for (const name of manifest.selfOmitSkills) if (!manifest.skills.includes(name)) manifest.skills.push(name);

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
for (const f of ['README.md', 'schema.sql', 'db.js', 'state.js', 'brain.js', 'emit.js', 'quota.js', 'langfuse.js',
  'server.js', 'ui.html', 'hook.js', 'event.schema.json', '.gitignore']) {
  if (!exists(path.join(CONTROL_PLANE_DIR, f))) errors.push(`control-plane/${f} is missing`);
}
for (const f of ['global-docs/ARCHITECTURE.md', 'global-docs/CONVENTIONS.md', 'global-docs/DECISIONS.md', 'global-docs/CHANGELOG.md',
  'service-docs/CONVENTIONS.md', 'service-docs/CHANGELOG.md', 'service-docs/HLD.md', 'service-docs/LLD.md',
  'service-docs/CURRENT_MILESTONE.md', 'service-docs/DECISIONS.md', 'service-docs/RCA.md',
  'commands/_persona.md']) {
  if (!exists(path.join(TEMPLATES_DIR, f))) errors.push(`templates/${f} is missing`);
}
// Every command this organization ships is namespaced `brain-`. A command lands in a shared
// directory next to whatever the project and its other tools already put there, so an unprefixed
// name is a collision waiting to happen, and the loser is silently whichever one loads second.
// A leading underscore marks a template the build expands, not a command that ships.
for (const f of fs.readdirSync(path.join(TEMPLATES_DIR, 'commands')).filter(n => n.endsWith('.md') && !n.startsWith('_'))) {
  const name = f.replace(/\.md$/, '');
  if (!/^brain-[a-z0-9][a-z0-9-]*$/.test(name)) {
    errors.push(`templates/commands/${f}: a command must be named brain-<something> in lowercase kebab-case, so it cannot collide with a command from another tool`);
  }
}

// Runtime state must never reach a build. `control-plane/brain.db` is created by running the CLI
// from the source directory, and shipping it would hand every consuming project this repository's
// sessions, agents, budgets and events.
for (const dir of [DIST_DIR, DIST_SELF_DIR]) {
  if (!exists(dir)) continue;
  const leaked = [];
  const walkFor = d => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walkFor(full);
      else if (/^brain\.db(-wal|-shm)?$/.test(entry.name)) leaked.push(path.relative(ROOT, full));
    }
  };
  walkFor(dir);
  for (const f of leaked) errors.push(`${f}: a control-plane database must never be built or shipped; each project creates its own on first use`);
}

if (!exists(path.join(REFERENCES_DIR, 'project-management-interface.md'))) errors.push('references/project-management-interface.md is missing');
if (!exists(path.join(REFERENCES_DIR, 'agent-observability.md'))) errors.push('references/agent-observability.md is missing');

// Leak check. Rule parts, report templates, references, and every product skill or persona ship to
// projects that consume the brain. None of them may name an artifact that only the self build
// carries, or the reference dangles there.
const selfOnly = new Set([...(manifest.selfAddSkills || []), ...(manifest.selfAddPersonas || [])]);
if (selfOnly.size) {
  const productSkills = new Set(selected.filter(e => !selfOnly.has(e.name)).map(e => e.name));
  const productFiles = [];
  const collect = (dir, filter = f => f.endsWith('.md')) => {
    if (!exists(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) collect(full, filter);
      else if (filter(f)) productFiles.push(full);
    }
  };
  collect(ORG_DIR_SRC); collect(REPORTS_DIR); collect(REFERENCES_DIR); collect(TEMPLATES_DIR);
  for (const name of productSkills) productFiles.push(path.join(DUMP_DIR, name, 'SKILL.md'));
  for (const p2 of personas.filter(x => !selfOnly.has(x.name) && !x.missing)) productFiles.push(path.join(AGENTS_DIR, `${p2.name}.md`));
  for (const file of productFiles) {
    if (!exists(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const name of selfOnly) {
      if (new RegExp('`' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`').test(text)) {
        errors.push(`${path.relative(ROOT, file)} references \`${name}\`, which only the self build ships: a project that consumes the brain would find it missing`);
      }
    }
  }
}

console.log(`skills: ${entries.length} in skills/, ${selected.length} selected (${selfOnly.size} self-only) · personas: ${personas.length} selected`);
for (const w of warnings) console.log(`  WARN  ${w}`);
for (const e of errors) console.log(`  ERROR ${e}`);
console.log(errors.length ? `\nFAILED (${errors.length} error(s))` : `\nOK${warnings.length ? ` with ${warnings.length} warning(s)` : ''}`);
process.exit(errors.length ? 1 : 0);
