#!/usr/bin/env node
/**
 * validate-models.js
 *
 * The models and the artifact map live in config, never in prose:
 *   models.json          this repository's double-pass gate (AGENTS.md), its artifact-sync model and artifacts
 *   project/models.json  a project's default code-reviewer and artifact-sync model; its artifacts start empty
 *
 * Checks (errors block CI):
 *   - both files parse and have the expected shape
 *   - exactly two independent reviewers on different models (agy effort
 *     variants of one model are the same model), plus a synthesis
 *   - an artifact-sync entry on a harness the sync runner can start (artifact-sync.js: claude, pi; not agy),
 *     and artifacts as { path, sources, then?, outputs? } (documentation W12); in this
 *     repository every artifact path and output exists
 *   - each model family runs on one harness: Codex models on pi, Claude
 *     models on claude (Claude Code), Gemini models on agy (Antigravity)
 *   - each harness's model id shape and the efforts its CLI accepts; an agy id
 *     must end in the entry's effort (gemini-4-hydrogen-high with "high"):
 *     agy refuses --effort for ids without one, and a different one
 *   - the lines that select reviewers in each AGENTS.md point to the config
 *   - neither AGENTS.md names a model, by a configured label or id or by a
 *     model-like name such as "GPT 6.1 Sol", "Opus 5.5", "Claude Opus" or
 *     "Gemini 4 Hydrogen" (a heuristic over the GPT, Claude and Gemini
 *     families, not a guarantee)
 *
 * Usage: node scripts/validate-models.js [--root <dir>]
 * Exit codes: 0 = all clear, 1 = one or more errors
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Each harness runs one model family (the owner's rule: Claude and Gemini models on
// their native harness, Codex models on pi): what an exact model id looks like, and
// the efforts its CLI accepts (`pi --help` --thinking, `claude --help` --effort,
// `agy --help` --effort). agy is Antigravity; its ids are the ones `agy models` lists.
const HARNESSES = new Map([
  ['pi', { model: /^openai-codex\/[a-z0-9][a-z0-9.-]*$/, ids: 'openai-codex/<id> (Codex models)', efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }],
  ['claude', { model: /^claude-[a-z0-9][a-z0-9-]*$/, ids: 'claude-<id> (Claude models)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }],
  ['agy', { model: /^gemini-[a-z0-9.-]*[a-z0-9]$/, ids: 'gemini-<id> (Gemini models)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], effortInId: true }],
]);
// The artifact sync launches its own agent, so its entry is limited to the harnesses its runner can start.
const SYNC_HARNESSES = Object.keys(require('../skills/documentation/scripts/artifact-sync').HARNESSES);
const ENTRY_KEYS = ['label', 'harness', 'model', 'effort'];
// The line that selects each reviewer must point to the config.
const SELECTION = {
  'AGENTS.md': ['**Two independent review passes.**', '**Third-agent synthesis.**'],
  'project/AGENTS.md': ['except for a `code-reviewer`'],
};
// A heuristic, not a guarantee: after normalize(), this catches the usual spellings
// of the GPT, Claude and Gemini families ("GPT 6.1 Sol", "Claude Opus", "opus5.5",
// "Gemini 4 Hydrogen", "Gemini Flash"). The configured labels and ids are matched
// exactly. Other families are not covered. A bare "gemini" is not a model: it is
// also the Gemini CLI and its .gemini/ directory.
const GEMINI_NAMES = 'pro|flash|ultra|nano|hydrogen|helium|lithium|neon|argon|xenon';
const MODEL_LIKE = new RegExp(String.raw`\bgpt-?\d[\w.]*|\bclaude-(?:opus|sonnet|haiku|fable)\b|\b(?:opus|sonnet|haiku|fable)-?\d+(?:\.\d+)?\b`
  + String.raw`|\bgemini-?\d[\w.]*|\bgemini-(?:${GEMINI_NAMES})\b`, 'g');
const FAILED = Symbol('failed');

function normalize(text) {
  return text.toLowerCase().replace(/[\s\u00a0\u2010-\u2015_-]+/g, '-');
}

// "<base>-<effort>" for a harness that puts the effort in the id, else null.
function splitEffort(model, spec) {
  const m = model.match(new RegExp(`^(.+)-(${spec.efforts.join('|')})$`));
  return m ? { base: m[1], effort: m[2] } : null;
}

// What makes two reviewers the same model: the id, without an agy effort suffix.
function modelKey(entry) {
  if (!isObject(entry) || typeof entry.model !== 'string') return undefined;
  const spec = HARNESSES.get(entry.harness);
  const parsed = spec && spec.effortInId ? splitEffort(entry.model, spec) : null;
  return `${entry.harness}:${parsed ? parsed.base : entry.model}`;
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
  const idOk = typeof entry.model === 'string' && spec.model.test(entry.model);
  if (typeof entry.model === 'string' && !idOk) {
    errors.push(`${where}.model: "${entry.model}" is not an exact ${entry.harness} model id; ${entry.harness} runs ${spec.ids}`);
  }
  if (typeof entry.effort === 'string' && !spec.efforts.includes(entry.effort)) {
    errors.push(`${where}.effort: "${entry.effort}" is not one of ${entry.harness}'s ${spec.efforts.join(', ')}`);
  }
  if (spec.effortInId && idOk && typeof entry.effort === 'string') {
    const parsed = splitEffort(entry.model, spec);
    if (!parsed || parsed.effort !== entry.effort) {
      errors.push(`${where}.model: "${entry.model}" must be an agy id that ends in its effort "-${entry.effort}", as \`agy models\` lists it`);
    }
  }
}

function checkSync(entry, where, errors) {
  checkEntry(entry, where, errors);
  if (isObject(entry) && HARNESSES.has(entry.harness) && !SYNC_HARNESSES.includes(entry.harness)) {
    errors.push(`${where}.harness: "${entry.harness}" cannot run the artifact sync; its runner starts ${SYNC_HARNESSES.join(', ')}`);
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

const ARTIFACT_KEYS = ['path', 'sources', 'then', 'outputs'];

function safeRel(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\')
    && value.split('/').every(p => p && p !== '.' && p !== '..');
}

// root is set for this repository, where every artifact must exist; a project's list is filled in by the project.
function checkArtifacts(list, rel, errors, root) {
  if (!Array.isArray(list)) { errors.push(`${rel}.artifacts: must be an array (empty when nothing is mapped yet)`); return; }
  const seen = new Set();
  list.forEach((a, i) => {
    const where = `${rel}.artifacts[${i}]`;
    if (!isObject(a)) { errors.push(`${where}: must be an object with path and sources`); return; }
    const extra = Object.keys(a).filter(k => !ARTIFACT_KEYS.includes(k));
    if (extra.length) errors.push(`${where}: unknown field(s) ${extra.join(', ')}`);
    if (!safeRel(a.path)) errors.push(`${where}.path: required repository-relative path`);
    else if (a.path === 'models.json') errors.push(`${where}.path: models.json is config, never an artifact`);
    else if (seen.has(a.path)) errors.push(`${where}.path: ${a.path} is mapped twice`);
    else seen.add(a.path);
    if (!Array.isArray(a.sources) || !a.sources.length || !a.sources.every(s => typeof s === 'string' && s.trim())) {
      errors.push(`${where}.sources: required non-empty array of globs`);
    }
    if (a.then !== undefined && (typeof a.then !== 'string' || !a.then.trim())) errors.push(`${where}.then: must be a non-empty command`);
    if (a.outputs !== undefined && (!Array.isArray(a.outputs) || !a.outputs.every(safeRel))) errors.push(`${where}.outputs: must be an array of repository-relative paths`);
    if (Array.isArray(a.outputs) && a.outputs.includes('models.json')) errors.push(`${where}.outputs: models.json is config, never an artifact`);
    if (a.outputs !== undefined && a.then === undefined) errors.push(`${where}.outputs: only a then command writes outputs`);
    if (root) {
      for (const f of [a.path, ...(Array.isArray(a.outputs) ? a.outputs : [])]) {
        if (safeRel(f) && !fs.existsSync(path.join(root, f))) errors.push(`${where}: ${f} does not exist`);
      }
    }
  });
}

function checkGate(cfg, errors, root) {
  const rel = 'models.json';
  if (cfg === FAILED) return [];
  if (!isObject(cfg)) { errors.push(`${rel}: must be an object`); return []; }
  const extra = Object.keys(cfg).filter(k => !['independent', 'synthesis', 'artifact-sync', 'artifacts'].includes(k));
  if (extra.length) errors.push(`${rel}: unknown field(s) ${extra.join(', ')}`);
  if (!Array.isArray(cfg.independent) || cfg.independent.length !== 2) {
    errors.push(`${rel}.independent: needs exactly two independent reviewers (AGENTS.md's double pass)`);
  }
  const independent = Array.isArray(cfg.independent) ? cfg.independent : [];
  independent.forEach((e, i) => checkEntry(e, `${rel}.independent[${i}]`, errors));
  const models = independent.map(modelKey);
  if (new Set(models).size !== models.length) errors.push(`${rel}.independent: the reviewers must use different models`);
  checkEntry(cfg.synthesis, `${rel}.synthesis`, errors);
  checkSync(cfg['artifact-sync'], `${rel}.artifact-sync`, errors);
  checkArtifacts(cfg.artifacts, rel, errors, root);
  return [...independent, cfg.synthesis, cfg['artifact-sync']];
}

function checkProject(cfg, errors) {
  const rel = 'project/models.json';
  if (cfg === FAILED) return [];
  if (!isObject(cfg)) { errors.push(`${rel}: must be an object`); return []; }
  const extra = Object.keys(cfg).filter(k => !['code-reviewer', 'artifact-sync', 'artifacts'].includes(k));
  if (extra.length) errors.push(`${rel}: unknown field(s) ${extra.join(', ')}`);
  checkEntry(cfg['code-reviewer'], `${rel}.code-reviewer`, errors);
  checkSync(cfg['artifact-sync'], `${rel}.artifact-sync`, errors);
  checkArtifacts(cfg.artifacts, rel, errors);
  return [cfg['code-reviewer'], cfg['artifact-sync']];
}

function checkProse(root, rel, entries, errors) {
  let text;
  try { text = fs.readFileSync(path.join(root, rel), 'utf8'); }
  catch (err) { errors.push(`${rel}: cannot read (${err.code || err.message})`); return; }
  const lines = text.split('\n');
  for (const anchor of SELECTION[rel]) {
    const at = lines.findIndex(l => l.includes(anchor));
    if (at === -1) errors.push(`${rel}: cannot find the reviewer-selection instruction containing ${anchor}`);
    else if (!lines[at].includes('models.json')) errors.push(`${rel}:${at + 1}: the reviewer-selection instruction must point to models.json`);
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
    if (hits.size) errors.push(`${rel}:${i + 1}: names a model (${[...hits].map(h => `"${h}"`).join(', ')}); name the role and point to models.json`);
  });
}

function validate(root) {
  const errors = [];
  const gate = checkGate(readJson(path.join(root, 'models.json'), 'models.json', errors), errors, root);
  const project = checkProject(readJson(path.join(root, 'project', 'models.json'), 'project/models.json', errors), errors);
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
  console.log('models: config valid, artifacts mapped, no model named in AGENTS.md or project/AGENTS.md');
}

module.exports = { validate };
