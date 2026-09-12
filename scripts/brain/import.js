#!/usr/bin/env node
'use strict';
// Copy a skill (a directory containing SKILL.md, or a single SKILL.md) into the flat dump at skills/<name>/.
//   node scripts/brain/import.js <path> [--category <category>] [--name <name>] [--force]
const fs = require('fs');
const path = require('path');
const { DUMP_DIR, exists, isDir, copyTree, ensureDir } = require('./lib/fs-utils');
const fm = require('./lib/frontmatter');

const args = process.argv.slice(2);
const src = args.find(a => !a.startsWith('--'));
const opt = k => { const i = args.indexOf(`--${k}`); return i === -1 ? undefined : args[i + 1]; };
const force = args.includes('--force');
if (!src) { console.error('usage: node scripts/brain/import.js <path-to-skill-dir-or-SKILL.md> [--category <category>] [--name <name>] [--force]'); process.exit(2); }
const abs = path.resolve(src);
if (!exists(abs)) { console.error(`not found: ${abs}`); process.exit(1); }
const skillFile = isDir(abs) ? path.join(abs, 'SKILL.md') : abs;
if (!exists(skillFile)) { console.error(`no SKILL.md at ${skillFile}`); process.exit(1); }
const { data } = fm.parse(fs.readFileSync(skillFile, 'utf8'));
const name = opt('name') || data.name || (isDir(abs) ? path.basename(abs) : null);
if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) { console.error(`invalid or missing skill name "${name || ''}": pass --name in lowercase kebab-case`); process.exit(1); }
const dest = path.join(DUMP_DIR, name);
if (exists(dest) && !force) { console.error(`already exists: skills/${name} (use --force to overwrite)`); process.exit(1); }
if (isDir(abs)) copyTree(abs, dest); else { ensureDir(dest); fs.copyFileSync(abs, path.join(dest, 'SKILL.md')); }

const text = fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8');
const parsed = fm.parse(text);
const next = { ...parsed.data, name };
if (opt('category')) next.category = opt('category');
if (JSON.stringify(next) !== JSON.stringify(parsed.data)) fs.writeFileSync(path.join(dest, 'SKILL.md'), fm.stringify(next, parsed.body));
if (!next.description) console.log('WARN  frontmatter has no description; add one so the skill can be discovered');
if (!next.category) console.log('note: no category set; it will be grouped under "general" (add `category:` to the frontmatter)');
const escaping = [...text.matchAll(/\]\((\.\.\/[^)]+)\)|`(\.\.\/[^`]+)`/g)].map(m => m[1] || m[2]).filter(l => !/^(\.\.\/)+references\//.test(l));
if (escaping.length) console.log(`WARN  references outside the skill directory: ${[...new Set(escaping)].join(', ')}`);
console.log(`imported skills/${name}${next.category ? ` (category: ${next.category})` : ''}`);
