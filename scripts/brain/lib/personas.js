'use strict';
// Index agents/*.md, resolve `extends:` specializations, and lint against docs/persona-anatomy.md.
const fs = require('fs');
const path = require('path');
const { AGENTS_DIR, exists, splitList } = require('./fs-utils');
const fm = require('./frontmatter');

const REQUIRED_SECTIONS = ['## Role', '## Responsibilities', '## Goals', '## Communication', '## Success Criteria',
  '## Tools', '## Authorization', '## Way of Working', '## Quality Non-negotiables', '## Skills', '## Composition', '## Red Flags'];
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Every persona file in agents/, parsed but not yet resolved or linted.
function readAll() {
  if (!exists(AGENTS_DIR)) return new Map();
  const all = new Map();
  for (const file of fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md')).sort()) {
    const name = file.replace(/\.md$/, '');
    const { data, body } = fm.parse(fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8'));
    all.set(name, { name, data, body });
  }
  return all;
}

// Split a body into { title, sections: [{heading, text}] } on level-2 headings.
function splitSections(body) {
  const lines = body.split('\n');
  let title = '';
  const sections = [];
  let cur = null;
  for (const line of lines) {
    if (/^## /.test(line)) { cur = { heading: line.trim(), text: '' }; sections.push(cur); continue; }
    if (/^# /.test(line) && !cur) { title = line; continue; }
    if (cur) cur.text += line + '\n'; else if (line.trim()) title += (title ? '\n' : '') + line;
  }
  return { title, sections };
}

// Child sections replace base sections with the same heading; new child sections are inserted before Composition (or Red Flags).
function mergeBodies(baseBody, childBody) {
  const base = splitSections(baseBody);
  const child = splitSections(childBody);
  const out = base.sections.map(s => ({ ...s }));
  for (const cs of child.sections) {
    const i = out.findIndex(s => s.heading === cs.heading);
    if (i !== -1) out[i] = { ...cs };
    else {
      let at = out.findIndex(s => s.heading === '## Composition');
      if (at === -1) at = out.findIndex(s => s.heading === '## Red Flags');
      out.splice(at === -1 ? out.length : at, 0, { ...cs });
    }
  }
  const title = child.title || base.title;
  return `${title}\n\n` + out.map(s => `${s.heading}\n${s.text.replace(/\n+$/, '')}\n`).join('\n');
}

function resolve(all, name, chain = []) {
  const p = all.get(name);
  if (!p) return null;
  if (chain.includes(name)) throw new Error(`extends cycle: ${[...chain, name].join(' → ')}`);
  if (!p.data.extends) return { ...p, resolvedData: { ...p.data }, resolvedBody: p.body };
  const base = resolve(all, p.data.extends, [...chain, name]);
  if (!base) throw new Error(`agents/${name}.md extends unknown persona "${p.data.extends}"`);
  const resolvedData = { ...base.resolvedData, ...p.data };
  delete resolvedData.abstract;
  return { ...p, resolvedData, resolvedBody: mergeBodies(base.resolvedBody, p.body) };
}

function lint(p) {
  const problems = [];
  const d = p.resolvedData;
  if (!KEBAB.test(p.name)) problems.push(`file name "${p.name}" is not lowercase-hyphen-separated`);
  if (!p.data.name) problems.push('frontmatter missing `name`');
  else if (p.data.name !== p.name) problems.push(`frontmatter name "${p.data.name}" != file name "${p.name}"`);
  if (!d.description) problems.push('frontmatter missing `description`');
  else if (!/\buse (this )?when\b/i.test(d.description)) problems.push('description has no "Use when" trigger');
  // Model and effort are runtime decisions recorded in the control plane, never persona frontmatter:
  // any agent may run any model at any effort, chosen per task by the EM from complexity, budget, and
  // provider quota (`model-routing`). Reject the old keys so a per-persona allowlist cannot creep back.
  for (const key of ['model', 'effort', 'allowed', 'allowed-models', 'allowed-efforts']) {
    if (p.data[key] !== undefined) problems.push(`frontmatter must not set \`${key}\`: model and effort are chosen per task and recorded in the control plane, not fixed on the persona`);
  }
  if (!d.skills) problems.push('frontmatter missing `skills` (comma-separated list this persona may use)');
  const prose = p.resolvedBody.replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
  for (const h of REQUIRED_SECTIONS) {
    if (!new RegExp(`^${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(prose)) problems.push(`missing required section: ${h}`);
  }
  return problems;
}

// Returns the resolved, non-abstract personas named by `selectors` (names, or "*" for every non-abstract persona).
function indexPersonas(selectors = []) {
  const all = readAll();
  const names = selectors.includes('*') ? [...all.keys()] : selectors;
  const out = [];
  for (const name of names) {
    if (!all.has(name)) { out.push({ name, missing: true, problems: [`agents/${name}.md does not exist`], skills: [] }); continue; }
    let r;
    try { r = resolve(all, name); } catch (e) { out.push({ name, problems: [e.message], skills: [] }); continue; }
    if (r.data.abstract === 'true' || r.data.abstract === true) continue;
    r.skills = splitList(r.resolvedData.skills);
    r.problems = lint(r);
    out.push(r);
  }
  return out;
}

module.exports = { indexPersonas, REQUIRED_SECTIONS };
