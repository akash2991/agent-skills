#!/usr/bin/env node
/**
 * validate-review-models.js
 *
 * The review models live in config, never in prose:
 *   review-models.json          this repository's double-pass gate (AGENTS.md)
 *   project/review-models.json  a project's default code-reviewer (project/AGENTS.md)
 *
 * Checks (errors block CI):
 *   - both files parse and have the expected shape
 *   - each AGENTS.md points to its file
 *   - neither AGENTS.md names a model, by a configured label or id or by a
 *     model-like name such as "GPT-6.1 Sol", "Opus 5.5" or "claude-opus-5-5"
 *
 * Usage: node scripts/validate-review-models.js [--root <dir>]
 * Exit codes: 0 = all clear, 1 = one or more errors
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HARNESS_MODEL = {
  pi: /^[a-z0-9-]+\/[a-z0-9][a-z0-9.-]*$/,
  claude: /^claude-[a-z0-9][a-z0-9-]*$/,
};
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const ENTRY_KEYS = ['label', 'harness', 'model', 'effort'];
const MODEL_LIKE = /\bgpt-\d[\w.-]*|\bclaude-(?:opus|sonnet|haiku|fable)\b[\w.-]*|\b(?:opus|sonnet|haiku|fable) \d+(?:\.\d+)?\b/gi;

function checkEntry(entry, where, errors) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push(`${where}: must be an object with ${ENTRY_KEYS.join(', ')}`);
    return;
  }
  const extra = Object.keys(entry).filter(k => !ENTRY_KEYS.includes(k));
  if (extra.length) errors.push(`${where}: unknown field(s) ${extra.join(', ')}`);
  for (const k of ENTRY_KEYS) {
    if (typeof entry[k] !== 'string' || !entry[k].trim()) errors.push(`${where}.${k}: required non-empty string`);
  }
  if (typeof entry.harness === 'string' && !HARNESS_MODEL[entry.harness]) {
    errors.push(`${where}.harness: "${entry.harness}" is not one of ${Object.keys(HARNESS_MODEL).join(', ')}`);
  } else if (typeof entry.model === 'string' && HARNESS_MODEL[entry.harness] && !HARNESS_MODEL[entry.harness].test(entry.model)) {
    errors.push(`${where}.model: "${entry.model}" is not an exact ${entry.harness} model id`);
  }
  if (typeof entry.effort === 'string' && !EFFORTS.has(entry.effort)) {
    errors.push(`${where}.effort: "${entry.effort}" is not one of ${[...EFFORTS].join(', ')}`);
  }
}

function readJson(file, rel, errors) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (err) { errors.push(`${rel}: cannot read (${err.code || err.message})`); return null; }
  try { return JSON.parse(text); }
  catch (err) { errors.push(`${rel}: invalid JSON (${err.message})`); return null; }
}

function checkGate(cfg, errors) {
  const rel = 'review-models.json';
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { if (cfg !== null) errors.push(`${rel}: must be an object`); return []; }
  const extra = Object.keys(cfg).filter(k => !['independent', 'synthesis'].includes(k));
  if (extra.length) errors.push(`${rel}: unknown field(s) ${extra.join(', ')}`);
  if (!Array.isArray(cfg.independent) || cfg.independent.length < 2) {
    errors.push(`${rel}.independent: needs at least two independent reviewers`);
  } else {
    cfg.independent.forEach((e, i) => checkEntry(e, `${rel}.independent[${i}]`, errors));
    const models = cfg.independent.map(e => e && e.model);
    if (new Set(models).size !== models.length) errors.push(`${rel}.independent: the reviewers must use different models`);
  }
  checkEntry(cfg.synthesis, `${rel}.synthesis`, errors);
  return [...(Array.isArray(cfg.independent) ? cfg.independent : []), cfg.synthesis];
}

function checkProject(cfg, errors) {
  const rel = 'project/review-models.json';
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { if (cfg !== null) errors.push(`${rel}: must be an object`); return []; }
  const extra = Object.keys(cfg).filter(k => k !== 'code-reviewer');
  if (extra.length) errors.push(`${rel}: unknown field(s) ${extra.join(', ')}`);
  checkEntry(cfg['code-reviewer'], `${rel}.code-reviewer`, errors);
  return [cfg['code-reviewer']];
}

function checkProse(root, rel, entries, errors) {
  let text;
  try { text = fs.readFileSync(path.join(root, rel), 'utf8'); }
  catch (err) { errors.push(`${rel}: cannot read (${err.code || err.message})`); return; }
  if (!text.includes('review-models.json')) errors.push(`${rel}: must point to review-models.json for the review models`);
  const lines = text.split('\n');
  const named = new Set();
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    for (const k of ['label', 'model']) if (typeof e[k] === 'string' && e[k].trim()) named.add(e[k].trim().toLowerCase());
  }
  lines.forEach((line, i) => {
    const lower = line.toLowerCase();
    const hits = new Set();
    for (const n of named) if (lower.includes(n)) hits.add(n);
    for (const m of line.matchAll(MODEL_LIKE)) hits.add(m[0]);
    if (hits.size) errors.push(`${rel}:${i + 1}: names a model (${[...hits].map(h => `"${h}"`).join(', ')}); name the role and point to review-models.json`);
  });
}

function validate(root) {
  const errors = [];
  const gate = checkGate(readJson(path.join(root, 'review-models.json'), 'review-models.json', errors), errors);
  const project = checkProject(readJson(path.join(root, 'project', 'review-models.json'), 'project/review-models.json', errors), errors);
  const all = [...gate, ...project];
  checkProse(root, 'AGENTS.md', all, errors);
  checkProse(root, 'project/AGENTS.md', all, errors);
  return errors;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--root');
  if (i !== -1 && !args[i + 1]) { console.error('missing value for --root'); process.exit(2); }
  const root = i === -1 ? path.resolve(__dirname, '..') : path.resolve(args[i + 1]);
  const errors = validate(root);
  if (errors.length) {
    for (const e of errors) console.error(`  ✗ ${e}`);
    console.error(`\n${errors.length} error(s)`);
    process.exit(1);
  }
  console.log('review models: config valid, no model named in AGENTS.md or project/AGENTS.md');
}

module.exports = { validate };
