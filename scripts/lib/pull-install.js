'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildBrain } = require('./build-brain');
const { lstatIfPresent, isWithin, canonicalPath, validateManagedRelPath } = require('./install-paths');

const STATE_DIR = '.agent-brain';
const STATE_PATH = '.agent-brain/install-state.json';
const STATE_SCHEMA = 1;
const HASH_RE = /^[a-f0-9]{64}$/;
const VALID_MODES = new Set(['0644', '0755']);

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function toPosix(rel) {
  return rel.split(path.sep).join('/');
}

const validateRelPath = validateManagedRelPath;

function modeOf(stat) {
  return (stat.mode & 0o111) ? '0755' : '0644';
}

function fileInfo(abs) {
  const st = fs.lstatSync(abs);
  if (!st.isFile()) throw new Error(`not a regular file: ${abs}`);
  const content = fs.readFileSync(abs);
  return { sha256: sha256Buffer(content), mode: modeOf(st), content };
}

function sameInfo(a, b) {
  return a && b && a.sha256 === b.sha256 && a.mode === b.mode;
}

function checkPathComponents(targetRoot, rel) {
  const parts = rel.split('/');
  let cur = targetRoot;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = path.join(cur, parts[i]);
    const st = lstatIfPresent(cur);
    if (!st) continue;
    if (!st.isDirectory()) throw new Error(`path component is not a directory: ${cur}`);
  }
}

function checkStateLocation(targetRoot) {
  const dir = path.join(targetRoot, STATE_DIR);
  const st = lstatIfPresent(dir);
  if (st) {
    if (!st.isDirectory()) throw new Error(`state directory is not a directory: ${dir}`);
  }
}

function readState(targetRoot) {
  checkStateLocation(targetRoot);
  const stateAbs = path.join(targetRoot, STATE_PATH);
  const st = lstatIfPresent(stateAbs);
  if (!st) return { files: new Map(), present: false };
  checkPathComponents(targetRoot, STATE_PATH);
  if (!st.isFile()) throw new Error(`state file is not a regular file: ${stateAbs}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(stateAbs, 'utf8'));
  } catch (err) {
    throw new Error(`invalid ${STATE_PATH}: ${err.message}`);
  }
  if (!parsed || parsed.schema !== STATE_SCHEMA || !Array.isArray(parsed.files)) {
    throw new Error(`invalid ${STATE_PATH}: expected schema ${STATE_SCHEMA} with files array`);
  }
  const files = new Map();
  for (const entry of parsed.files) {
    if (!entry || typeof entry !== 'object') throw new Error(`invalid ${STATE_PATH}: malformed file entry`);
    const rel = validateRelPath(entry.path, 'state path');
    if (files.has(rel)) throw new Error(`invalid ${STATE_PATH}: duplicate path ${rel}`);
    if (typeof entry.sha256 !== 'string' || !HASH_RE.test(entry.sha256)) throw new Error(`invalid ${STATE_PATH}: malformed hash for ${rel}`);
    if (!VALID_MODES.has(entry.mode)) throw new Error(`invalid ${STATE_PATH}: malformed mode for ${rel}`);
    files.set(rel, { sha256: entry.sha256, mode: entry.mode });
  }
  return { files, present: true };
}

function writeStateAtomic(targetRoot, files) {
  const entries = [...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([rel, info]) => ({ path: rel, sha256: info.sha256, mode: info.mode }));
  const state = { schema: STATE_SCHEMA, files: entries };
  const content = `${JSON.stringify(state, null, 2)}\n`;
  checkStateLocation(targetRoot);
  const dir = path.join(targetRoot, STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(targetRoot, STATE_PATH);
  const tmp = path.join(dir, `.install-state.json.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, content, { mode: 0o644 });
  fs.renameSync(tmp, finalPath);
}

function walkFiles(root) {
  const out = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) out.push(abs);
      else throw new Error(`build output contains nonregular file: ${abs}`);
    }
  }
  walk(root);
  return out;
}

function collectBuildFiles(buildRoot, targetRoot) {
  const files = new Map();
  const skillHosts = ['.agents', '.claude', '.gemini'];
  // Refresh pre-existing legacy copies without introducing new Pi/Hermes
  // discovery directories. Pi normally discovers .agents/skills directly.
  for (const host of ['.pi', '.hermes']) {
    if (targetRoot && lstatIfPresent(path.join(targetRoot, host, 'skills'))) skillHosts.push(host);
  }
  const personaHosts = ['.agents', '.claude', '.gemini', '.pi'];
  function add(rel, info) {
    validateRelPath(rel, 'install path');
    if (files.has(rel)) throw new Error(`duplicate install path: ${rel}`);
    files.set(rel, { ...info });
  }
  function route(text, host) {
    return text.replace(/(?<![\w./-])skills\//g, `${host}/skills/`)
      .replace(/(?<![\w./-])agents\//g, `${host}/agents/`);
  }
  for (const abs of walkFiles(buildRoot)) {
    const relative = toPosix(path.relative(buildRoot, abs));
    if (relative === 'README.md') continue;
    validateRelPath(relative, 'build path');
    const info = { ...fileInfo(abs), abs };
    if (relative.startsWith('skills/')) {
      for (const host of skillHosts) add(`${host}/${relative}`, info);
      continue;
    }
    if (relative.startsWith('agents/')) {
      for (const host of personaHosts) add(`${host}/${relative}`, info);
      continue;
    }
    // Verbatim copies need sibling references/templates for ../../ links.
    if (/^(references|templates)\//.test(relative)) {
      for (const host of skillHosts) add(`${host}/${relative}`, info);
    }
    let host;
    if (relative === 'AGENTS.md' || relative.startsWith('commands/')) host = '.agents';
    else if (/^\.(claude|gemini|pi|codex)\/(commands|prompts)\//.test(relative)) {
      host = relative.split('/')[0];
      if (host === '.codex') host = '.agents';
    }
    if (host) {
      info.content = Buffer.from(route(info.content.toString('utf8'), host));
      info.sha256 = sha256Buffer(info.content);
    }
    add(relative, info);
  }
  return files;
}

function assertExistingTarget(targetRoot) {
  const st = lstatIfPresent(targetRoot);
  if (!st) throw new Error(`target does not exist: ${targetRoot}`);
  if (!st.isDirectory()) throw new Error(`target is not a directory: ${targetRoot}`);
}

function assertNoSourceTargetOverlap(sourceRoot, targetRoot) {
  const source = canonicalPath(sourceRoot);
  const target = canonicalPath(targetRoot);
  if (isWithin(source, target) || isWithin(target, source)) {
    throw new Error(`refusing to install with overlapping source and target: source=${source} target=${target}`);
  }
}

// Only this section belongs to the consuming project. All other instructions
// come from the brain. Refuse an ambiguous document rather than guessing.
function mergeProjectAgents(incoming, existing) {
  function section(text) {
    const headings = [...text.matchAll(/^## This project[ \t]*\r?$/gm)];
    if (headings.length !== 1) throw new Error('AGENTS.md must contain exactly one "## This project" heading');
    const start = headings[0].index;
    const remainder = text.slice(start + headings[0][0].length);
    const next = remainder.search(/^## /m);
    return { start, end: next === -1 ? text.length : start + headings[0][0].length + next };
  }
  const source = section(incoming);
  const project = section(existing);
  return incoming.slice(0, source.start) + existing.slice(project.start, project.end) + incoming.slice(source.end);
}

function planInstall(sourceRoot, targetRoot, buildRoot) {
  assertExistingTarget(targetRoot);
  assertNoSourceTargetOverlap(sourceRoot, targetRoot);
  const desired = collectBuildFiles(buildRoot, targetRoot);
  const state = readState(targetRoot);
  const conflicts = [];
  const writes = [];
  const adopts = [];
  const prunes = [];
  const unchanged = [];
  const nextState = new Map();

  for (const [rel, desiredInfo] of desired) {
    nextState.set(rel, { sha256: desiredInfo.sha256, mode: desiredInfo.mode });
    let existing = null;
    const destAbs = path.join(targetRoot, rel);
    try {
      checkPathComponents(targetRoot, rel);
      if (lstatIfPresent(destAbs)) existing = fileInfo(destAbs);
    } catch (err) {
      conflicts.push(`${rel}: ${err.message}`);
      continue;
    }
    if (rel === 'AGENTS.md' && existing) {
      try {
        let merged = mergeProjectAgents(desiredInfo.content.toString('utf8'), existing.content.toString('utf8'));
        // Keep project instructions, but repair exact references to brain files
        // whose old root copies are no longer installed. Do not rewrite custom
        // project paths or arbitrary uses of the words skills/agents.
        for (const installed of desired.keys()) {
          if (!/^\.agents\/(skills|agents)\//.test(installed)) continue;
          const previous = installed.slice('.agents/'.length);
          const escaped = previous.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          merged = merged.replace(new RegExp(`(?<![\\w./-])${escaped}(?![\\w.-])`, 'g'), installed);
        }
        desiredInfo.content = Buffer.from(merged);
        desiredInfo.sha256 = sha256Buffer(desiredInfo.content);
        nextState.set(rel, { sha256: desiredInfo.sha256, mode: desiredInfo.mode });
      } catch (err) {
        conflicts.push(`${rel}: ${err.message}`);
        continue;
      }
    }
    if (!sameInfo(existing, desiredInfo)) writes.push(rel);
    else if (!state.files.has(rel)) adopts.push(rel);
    else unchanged.push(rel);
  }

  for (const rel of state.files.keys()) {
    if (desired.has(rel)) continue;
    const destAbs = path.join(targetRoot, rel);
    try {
      checkPathComponents(targetRoot, rel);
      if (!lstatIfPresent(destAbs)) continue;
      fileInfo(destAbs); // Still refuse symlinks and nonregular paths.
      prunes.push(rel);
    } catch (err) {
      conflicts.push(`${rel}: ${err.message}`);
    }
  }

  return { desired, nextState, conflicts, writes, adopts, prunes, unchanged };
}

function chmodFromMode(abs, mode) {
  fs.chmodSync(abs, mode === '0755' ? 0o755 : 0o644);
}

function writeFileAtomic(destAbs, info) {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  const tmp = path.join(path.dirname(destAbs), `.${path.basename(destAbs)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, info.content, { mode: info.mode === '0755' ? 0o755 : 0o644 });
  chmodFromMode(tmp, info.mode);
  fs.renameSync(tmp, destAbs);
  chmodFromMode(destAbs, info.mode);
}

function applyPlan(targetRoot, plan) {
  for (const rel of plan.prunes) {
    checkPathComponents(targetRoot, rel);
    fs.unlinkSync(path.join(targetRoot, rel));
    // Remove only empty directories left by previously managed files, never
    // recursively remove a consumer directory or sweep up untracked content.
    let dir = path.dirname(path.join(targetRoot, rel));
    while (dir !== targetRoot) {
      try { fs.rmdirSync(dir); }
      catch (err) { if (['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(err.code)) break; throw err; }
      dir = path.dirname(dir);
    }
  }
  for (const rel of plan.writes) {
    checkPathComponents(targetRoot, rel);
    writeFileAtomic(path.join(targetRoot, rel), plan.desired.get(rel));
  }
  for (const rel of plan.adopts) {
    checkPathComponents(targetRoot, rel);
    chmodFromMode(path.join(targetRoot, rel), plan.desired.get(rel).mode);
  }
  writeStateAtomic(targetRoot, plan.nextState);
}

function formatPlan(plan, dryRun) {
  const lines = [];
  lines.push(`${dryRun ? 'would install' : 'installed'} ${plan.nextState.size} managed file(s)`);
  if (plan.writes.length) lines.push(`write/update:\n${plan.writes.map(p => `  ${p}`).join('\n')}`);
  if (plan.adopts.length) lines.push(`adopt identical:\n${plan.adopts.map(p => `  ${p}`).join('\n')}`);
  if (plan.prunes.length) lines.push(`prune retired:\n${plan.prunes.map(p => `  ${p}`).join('\n')}`);
  lines.push('AGENTS.md: preserve the existing "## This project" section; replace shared instructions');
  if (!plan.writes.length && !plan.adopts.length && !plan.prunes.length) lines.push('already up to date');
  return lines.join('\n');
}

function formatConflicts(conflicts) {
  return [
    'agent-brain pull refused because these paths need reconciliation:',
    ...conflicts.map(c => `  - ${c}`),
    '',
    'Fix the unsafe paths or identify the project-specific section in AGENTS.md, then rerun agent-brain pull. No files were changed.'
  ].join('\n');
}

function pullInstall(options = {}) {
  const sourceRoot = canonicalPath(options.sourceRoot || path.resolve(__dirname, '..', '..'));
  const targetRoot = canonicalPath(options.target || process.cwd());
  const dryRun = !!options.dryRun;
  assertExistingTarget(targetRoot);
  assertNoSourceTargetOverlap(sourceRoot, targetRoot);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-brain-build-'));
  try {
    const buildDir = path.join(tmp, 'build');
    buildBrain({ root: sourceRoot, out: buildDir });
    const plan = planInstall(sourceRoot, targetRoot, buildDir);
    if (plan.conflicts.length) {
      const err = new Error(formatConflicts(plan.conflicts));
      err.code = 'PULL_CONFLICT';
      throw err;
    }
    if (!dryRun) applyPlan(targetRoot, plan);
    return { targetRoot, dryRun, plan, message: formatPlan(plan, dryRun) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = {
  STATE_PATH,
  pullInstall,
  planInstall,
  collectBuildFiles,
  readState,
  validateRelPath,
  formatConflicts,
  formatPlan,
  mergeProjectAgents
};
