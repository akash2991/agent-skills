'use strict';
// Index the flat skill dump (skills/<name>/SKILL.md) and resolve manifest selections.
// Category comes from the optional `category:` frontmatter field (default: general).
const fs = require('fs');
const path = require('path');
const { DUMP_DIR, DEFAULT_CATEGORY, listDirs, exists } = require('./fs-utils');
const fm = require('./frontmatter');

function indexDump() {
  // A `-original` directory is an upstream copy kept for side-by-side comparison, not a skill
  // this organization ships. It is excluded everywhere so a reference copy cannot be selected,
  // linted against our anatomy, or required to have an eval case.
  return listDirs(DUMP_DIR).filter(name => !name.endsWith('-original')).map(name => {
    const dir = path.join(DUMP_DIR, name);
    const file = path.join(dir, 'SKILL.md');
    const entry = { name, dir, data: {}, category: DEFAULT_CATEGORY, problems: [] };
    if (!exists(file)) { entry.problems.push('missing SKILL.md'); return entry; }
    const { data } = fm.parse(fs.readFileSync(file, 'utf8'));
    entry.data = data;
    entry.category = data.category || DEFAULT_CATEGORY;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.category)) entry.problems.push(`category "${entry.category}" is not lowercase-hyphen-separated`);
    if (!data.name) entry.problems.push('frontmatter missing `name`');
    else if (data.name !== name) entry.problems.push(`frontmatter name "${data.name}" != directory "${name}"`);
    if (!data.description) entry.problems.push('frontmatter missing `description`');
    return entry;
  });
}

// Selectors: "name", "category:<category>", "*".
function resolveSelector(selector, entries) {
  if (selector === '*') return { matches: entries };
  if (selector.startsWith('category:')) {
    const cat = selector.slice('category:'.length);
    const matches = entries.filter(e => e.category === cat);
    return matches.length ? { matches } : { matches, error: `"${selector}" matched no skill (categories: ${[...new Set(entries.map(e => e.category))].sort().join(', ')})` };
  }
  const matches = entries.filter(e => e.name === selector);
  return matches.length ? { matches } : { matches, error: `"${selector}" is not a skill in skills/` };
}

function resolveManifest(manifest, entries) {
  const selected = new Map();
  const errors = [];
  for (const selector of manifest.skills) {
    const { matches, error } = resolveSelector(selector, entries);
    if (error) { errors.push(error); continue; }
    for (const m of matches) selected.set(m.name, m);
  }
  return { selected: [...selected.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
}

module.exports = { indexDump, resolveSelector, resolveManifest };
