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
 *   - exactly two independent reviewers on different models, plus a synthesis
 *   - each harness's model id shape and the efforts its CLI accepts
 *   - the lines that select reviewers in each AGENTS.md point to the config
 *   - neither AGENTS.md names a model, by a configured label or id or by a
 *     model-like name such as "GPT 6.1 Sol", "Opus 5.5" or "Claude Opus"
 *     (a heuristic over the GPT and Claude families, not a guarantee)
 *
 * Usage: node scripts/validate-review-models.js [--root <dir>]
 * Exit codes: 0 = all clear, 1 = one or more errors
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Each harness: what an exact model id looks like, and the efforts its CLI accepts
// (`pi --help` --thinking, `claude --help` --effort).
const HARNESSES = new Map([
  ['pi', { model: /^[a-z0-9-]+\/[a-z0-9][a-z0-9.-]*$/, efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }],
  ['claude', { model: /^claude-[a-z0-9][a-z0-9-]*$/, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }],
]);
const ENTRY_KEYS = ['label', 'harness', 'model', 'effort'];
// The line that selects each reviewer must point to the config.
const SELECTION = {
  'AGENTS.md': ['**Two independent review passes.**', '**Third-agent synthesis.**'],
  'project/AGENTS.md': ['except for a `code-reviewer`'],
};
// A heuristic, not a guarantee: after normalize(), this catches the usual spellings
// of the GPT and Claude families ("GPT 6.1 Sol", "Claude Opus", "opus5.5"). The
// configured labels and ids are matched exactly. Other families are not covered.
const MODEL_LIKE = /\bgpt-?\d[\w.]*|\bclaude-(?:opus|sonnet|haiku|fable)\b|\b(?:opus|sonnet|haiku|fable)-?\d+(?:\.\d+)?\b/g;
const FAILED = Symbol('failed');

function normalize(text) {
  return text.toLowerCase().replace(/[\s\u00a0\u2010-\u2015_-]+/g, '-');
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function checkEntry(entry, where, errors) {
  if (!isObject(entry)) {
    errors.push(`${where}: must be an object with ${ENTRY_KEYS.join(', ')}`);
    return;
  }
  const extra = Object.keys(entry).filter(k => !ENTRY_KEYS.includes(k));
  if (extra.length) errors.push(`${where}: unknown field(s) ${extra.join(', ')}`);
  for (const k of ENTRY_KEYS) {
    if (typeof entry[k] !== 'string' || !entry[k].trim()) errors.push(`${where}.${k}: required non-empty string`);
  }
  if (typeof entry.harness !== 'string') return;
  const spec = HARNESSES.get(entry.harness);
  if (!spec) {
    errors.push(`${where}.harness: "${entry.harness}" is not one of ${[...HARNESSES.keys()].join(', ')}`);
    return;
  }
  if (typeof entry.model === 'string' && !spec.model.test(entry.model)) {
    errors.push(`${where}.model: "${entry.model}" is not an exact ${entry.harness} model id`);
  }
  if (typeof entry.effort === 'string' && !spec.efforts.includes(entry.effort)) {
    errors.push(`${where}.effort: "${entry.effort}" is not one of ${entry.harness}'s ${spec.efforts.join(', ')}`);
  }
}

// FAILED when the file cannot be read or parsed (already reported); otherwise the parsed value, null included.
function readJson(file, rel, errors) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (err) { errors.push(`${rel}: cannot read (${err.code || err.message})`); return FAILED; }
  try { return JSON.parse(text); }
  catch (err) { errors.push(`${rel}: invalid JSON (${err.message})`); return FAILED; }
}

function checkGate(cfg, errors) {
  const rel = 'review-models.json';
  if (cfg === FAILED) return [];
  if (!isObject(cfg)) { errors.push(`${rel}: must be an object`); return []; }
  const extra = Object.keys(cfg).filter(k => !['independent', 'synthesis'].includes(k));
  if (extra.length) errors.push(`${rel}: unknown field(s) ${extra.join(', ')}`);
  if (!Array.isArray(cfg.independent) || cfg.independent.length !== 2) {
    errors.push(`${rel}.independent: needs exactly two independent reviewers (AGENTS.md's double pass)`);
  }
  const independent = Array.isArray(cfg.independent) ? cfg.independent : [];
  independent.forEach((e, i) => checkEntry(e, `${rel}.independent[${i}]`, errors));
  const models = independent.map(e => isObject(e) ? e.model : undefined);
  if (new Set(models).size !== models.length) errors.push(`${rel}.independent: the reviewers must use different models`);
  checkEntry(cfg.synthesis, `${rel}.synthesis`, errors);
  return [...independent, cfg.synthesis];
}

function checkProject(cfg, errors) {
  const rel = 'project/review-models.json';
  if (cfg === FAILED) return [];
  if (!isObject(cfg)) { errors.push(`${rel}: must be an object`); return []; }
  const extra = Object.keys(cfg).filter(k => k !== 'code-reviewer');
  if (extra.length) errors.push(`${rel}: unknown field(s) ${extra.join(', ')}`);
  checkEntry(cfg['code-reviewer'], `${rel}.code-reviewer`, errors);
  return [cfg['code-reviewer']];
}

function checkProse(root, rel, entries, errors) {
  let text;
  try { text = fs.readFileSync(path.join(root, rel), 'utf8'); }
  catch (err) { errors.push(`${rel}: cannot read (${err.code || err.message})`); return; }
  const lines = text.split('\n');
  for (const anchor of SELECTION[rel]) {
    const at = lines.findIndex(l => l.includes(anchor));
    if (at === -1) errors.push(`${rel}: cannot find the reviewer-selection instruction containing ${anchor}`);
    else if (!lines[at].includes('review-models.json')) errors.push(`${rel}:${at + 1}: the reviewer-selection instruction must point to review-models.json`);
  }
  const named = new Set();
  for (const e of entries) {
    if (!isObject(e)) continue;
    for (const k of ['label', 'model']) if (typeof e[k] === 'string' && e[k].trim()) named.add(normalize(e[k].trim()));
  }
  lines.forEach((line, i) => {
    const norm = normalize(line);
    const hits = new Set();
    for (const n of named) if (norm.includes(n)) hits.add(n);
    for (const m of norm.matchAll(MODEL_LIKE)) hits.add(m[0]);
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
