'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildBrain } = require('./build-brain');
const { lstatIfPresent, isWithin, canonicalPath, validateManagedRelPath } = require('./install-paths');
const { nativePersona } = require('./persona-tools');
const { planArtifactSyncSettings, applyArtifactSyncSettings } = require('./artifact-sync-settings');
const { parseVersion, readBrainVersion, sectionsBetween, formatSections, describeDrift } = require('./brain-version');

const STATE_DIR = '.agent-brain';
const STATE_PATH = '.agent-brain/install-state.json';
const STATE_SCHEMA = 1;
const CHANGELOG_PATH = '.agent-brain/CHANGELOG.md';
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
  if (!st) return { files: new Map(), present: false, version: null };
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
    if (entry.owned !== undefined && (typeof entry.owned !== 'string' || !HASH_RE.test(entry.owned))) throw new Error(`invalid ${STATE_PATH}: malformed owned hash for ${rel}`);
    files.set(rel, { sha256: entry.sha256, mode: entry.mode, ...(entry.owned ? { owned: entry.owned } : {}) });
  }
  // Installs made before the brain was versioned carry no `brain`; that is not an error.
  let version = null;
  if (parsed.brain !== undefined) {
    version = parsed.brain && parsed.brain.version;
    if (!parseVersion(version)) throw new Error(`invalid ${STATE_PATH}: brain.version is not semver X.Y.Z`);
  }
  return { files, present: true, version };
}

function writeStateAtomic(targetRoot, files, version) {
  const entries = [...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([rel, info]) => ({ path: rel, sha256: info.sha256, mode: info.mode, ...(info.owned ? { owned: info.owned } : {}) }));
  const state = { schema: STATE_SCHEMA, brain: { version }, files: entries };
  const content = `${JSON.stringify(state, null, 2)}\n`;
  checkStateLocation(targetRoot);
  const dir = path.join(targetRoot, STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(targetRoot, STATE_PATH);
  const tmp = path.join(dir, `.install-state.json.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, content, { mode: 0o644 });
  fs.renameSync(tmp, finalPath);
}

// What going back from the installed version to `toVersion` takes away, read from the
// installed changelog. Only a copy that still matches its recorded hash is evidence;
// an edited or missing one is reported as such, never quoted.
function downgradeRange(targetRoot, state, toVersion) {
  const recorded = state.files.get(CHANGELOG_PATH);
  let current = null;
  try {
    checkPathComponents(targetRoot, CHANGELOG_PATH);
    if (lstatIfPresent(path.join(targetRoot, CHANGELOG_PATH))) current = fileInfo(path.join(targetRoot, CHANGELOG_PATH));
  } catch { /* not a regular file: unverified */ }
  if (!recorded || !current || current.sha256 !== recorded.sha256) {
    return { sections: [], note: `cannot list what this downgrade removes: ${CHANGELOG_PATH} is missing or was edited since the install` };
  }
  return { sections: sectionsBetween(current.content.toString('utf8'), toVersion, state.version), note: null };
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

function collectBuildFiles(buildRoot) {
  const files = new Map();
  // Native discovery, not folder presence, decides where a copy is needed.
  // Pi, Codex, Gemini and Hermes share .agents/skills. Claude uses its own
  // skill directory. Personas have separate discovery rules; see
  // docs/harness-layout.md before changing either list.
  const skillHosts = ['.agents', '.claude'];
  const personaHosts = ['.agents', '.claude', '.gemini', '.pi'];
  function add(rel, info) {
    validateRelPath(rel, 'install path');
    if (files.has(rel)) throw new Error(`duplicate install path: ${rel}`);
    files.set(rel, { ...info });
  }
  function relocateSharedLinks(relative, info) {
    if (!relative.endsWith('.md')) return info;
    const content = Buffer.from(info.content.toString('utf8').replace(
      /(?<![\w./-])((?:\.\.\/)+)(references|templates)\//g,
      (link, parents, folder) => {
        // Add the tool-directory level only for links to repo-root assets.
        // A skill's own references/ and templates/ remain next to that skill.
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), parents, folder));
        return resolved === folder ? `../${link}` : link;
      }
    ));
    return { ...info, content, sha256: sha256Buffer(content) };
  }
  // A harness that reads `tools:` as its own allowlist gets native tool names.
  function nativeCopy(host, info) {
    const harness = { '.claude': 'claude', '.gemini': 'gemini', '.pi': 'pi' }[host];
    if (!harness) return info;
    const content = Buffer.from(nativePersona(info.content.toString('utf8'), harness));
    return { ...info, content, sha256: sha256Buffer(content) };
  }
  function route(text, host) {
    const skillHost = host === '.claude' ? '.claude' : '.agents';
    return text.replace(/(?<![\w./-])skills\//g, `${skillHost}/skills/`)
      .replace(/(?<![\w./-])agents\//g, `${host}/agents/`);
  }
  for (const abs of walkFiles(buildRoot)) {
    const relative = toPosix(path.relative(buildRoot, abs));
    if (relative === 'README.md') continue;
    validateRelPath(relative, 'build path');
    const info = { ...fileInfo(abs), abs };
    // A project's root CHANGELOG.md is its own; the brain's sits with the install state.
    if (relative === 'CHANGELOG.md') {
      add(CHANGELOG_PATH, info);
      continue;
    }
    if (relative.startsWith('runtime/langfuse/')) {
      add(`.agent-brain/observability/${relative.slice('runtime/langfuse/'.length)}`, info);
      continue;
    }
    if (relative.startsWith('runtime/guard/')) {
      add(`.agent-brain/guard/${relative.slice('runtime/guard/'.length)}`, info);
      continue;
    }
    if (relative.startsWith('skills/')) {
      for (const host of skillHosts) add(`${host}/${relative}`, relocateSharedLinks(relative, info));
      continue;
    }
    if (relative.startsWith('agents/')) {
      for (const host of personaHosts) add(`${host}/${relative}`, nativeCopy(host, relocateSharedLinks(relative, info)));
      continue;
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
function projectSection(text) {
  const headings = [...text.matchAll(/^## This project[ \t]*\r?$/gm)];
  if (headings.length !== 1) throw new Error('AGENTS.md must contain exactly one "## This project" heading');
  const start = headings[0].index;
  const remainder = text.slice(start + headings[0][0].length);
  const next = remainder.search(/^## /m);
  return { start, end: next === -1 ? text.length : start + headings[0][0].length + next };
}

// The part of a merged file that is the brain's, by the same boundaries the merge uses:
// AGENTS.md without its "## This project" section, models.json without its artifacts list.
// Its hash is recorded at install, so status can tell a project's own edit from one a pull overwrites.
const PROJECT_PARTS = { 'AGENTS.md': 'its "## This project" section', 'models.json': 'its artifacts' };
function brainOwnedHash(rel, content) {
  const text = content.toString('utf8');
  if (rel === 'AGENTS.md') {
    const own = projectSection(text);
    return sha256Buffer(Buffer.from(`${text.slice(0, own.start)}\0${text.slice(own.end)}`));
  }
  const models = JSON.parse(text);
  if (!models || typeof models !== 'object' || Array.isArray(models)) throw new Error('models.json is not an object');
  // A pull keeps artifacts only when it is a list; missing or anything else, the pull replaces it,
  // so "is a list" is itself part of what the brain installed.
  const kept = Array.isArray(models.artifacts);
  if (kept) delete models.artifacts;
  return sha256Buffer(Buffer.from(JSON.stringify([kept, models])));
}

function mergeProjectAgents(incoming, existing) {
  const section = projectSection;
  const source = section(incoming);
  const project = section(existing);
  return incoming.slice(0, source.start) + existing.slice(project.start, project.end) + incoming.slice(source.end);
}

// models.json comes from the brain, except its artifacts: those are the project's own map (documentation W12).
function mergeProjectModels(incoming, existing) {
  let mine;
  try { mine = JSON.parse(existing); } catch { throw new Error('models.json is not valid JSON; fix it or remove it'); }
  const models = JSON.parse(incoming);
  if (!mine || !Array.isArray(mine.artifacts) || JSON.stringify(mine.artifacts) === JSON.stringify(models.artifacts)) return incoming;
  models.artifacts = mine.artifacts;
  return `${JSON.stringify(models, null, 2)}\n`;
}

function planInstall(sourceRoot, targetRoot, buildRoot) {
  assertExistingTarget(targetRoot);
  assertNoSourceTargetOverlap(sourceRoot, targetRoot);
  const desired = collectBuildFiles(buildRoot);
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
    // A models.json the brain never installed is the project's own file: never parse it as brain config.
    if (rel === 'models.json' && existing && !state.files.has(rel) && !sameInfo(existing, desiredInfo)) {
      conflicts.push(`${rel}: an existing file the brain did not install; move it aside, then pull`);
      continue;
    }
    if (rel === 'models.json' && existing) {
      try {
        desiredInfo.content = Buffer.from(mergeProjectModels(desiredInfo.content.toString('utf8'), existing.content.toString('utf8')));
        desiredInfo.sha256 = sha256Buffer(desiredInfo.content);
        nextState.set(rel, { sha256: desiredInfo.sha256, mode: desiredInfo.mode });
      } catch (err) {
        conflicts.push(`${rel}: ${err.message}`);
        continue;
      }
    }
    if (PROJECT_PARTS[rel]) nextState.get(rel).owned = brainOwnedHash(rel, desiredInfo.content);
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
      const current = fileInfo(destAbs); // Still refuse symlinks and nonregular paths.
      // The renamed review-models.json is pruned only as installed; an edited copy holds settings to carry over.
      if (rel === 'review-models.json' && !sameInfo(current, state.files.get(rel))) {
        conflicts.push(`${rel}: edited since it was installed; models.json replaces it and keeps only a project's own artifacts across pulls (the models come from the brain). Delete it, then pull`);
        continue;
      }
      prunes.push(rel);
    } catch (err) {
      conflicts.push(`${rel}: ${err.message}`);
    }
  }

  const version = readBrainVersion(sourceRoot);
  const drift = describeDrift(state.version, version);
  // What an update brings, or what a downgrade takes away. A first or unversioned install has no baseline to compare.
  const changelog = desired.get(CHANGELOG_PATH).content.toString('utf8');
  const changes = drift.kind === 'downgrade' ? [] : state.version ? sectionsBetween(changelog, state.version, version) : [];
  const dropped = drift.kind === 'downgrade' ? downgradeRange(targetRoot, state, version) : { sections: [], note: null };
  return { desired, nextState, conflicts, writes, adopts, prunes, unchanged, version, installedVersion: state.version, drift, changes, dropped };
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
  writeStateAtomic(targetRoot, plan.nextState, plan.version);
}

function formatPlan(plan, dryRun) {
  const lines = [plan.drift.line];
  if (plan.changes.length) lines.push(`changes since ${plan.installedVersion}:\n\n${formatSections(plan.changes)}\n`);
  if (plan.dropped.sections.length) lines.push(`this downgrade removes:\n\n${formatSections(plan.dropped.sections)}\n`);
  if (plan.dropped.note) lines.push(plan.dropped.note);
  if (plan.drift.kind === 'unversioned') lines.push(`changelog: ${CHANGELOG_PATH}`);
  lines.push(`${dryRun ? 'would install' : 'installed'} ${plan.nextState.size} managed file(s)`);
  if (plan.writes.length) lines.push(`write/update:\n${plan.writes.map(p => `  ${p}`).join('\n')}`);
  if (plan.adopts.length) lines.push(`adopt identical:\n${plan.adopts.map(p => `  ${p}`).join('\n')}`);
  if (plan.prunes.length) lines.push(`prune retired:\n${plan.prunes.map(p => `  ${p}`).join('\n')}`);
  lines.push('AGENTS.md: preserve the existing "## This project" section; replace shared instructions');
  lines.push('models.json: preserve the project\'s artifacts; replace the models');
  if (plan.settings && plan.settings.length) lines.push(`${dryRun ? 'would register' : 'registered'} the artifact sync hook in: ${plan.settings.map(w => w.rel).join(', ')}`);
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
    try { plan.settings = planArtifactSyncSettings(targetRoot); }
    catch (err) { plan.conflicts.push(`artifact sync hook: ${err.message}`); }
    if (plan.conflicts.length) {
      const err = new Error(formatConflicts(plan.conflicts));
      err.code = 'PULL_CONFLICT';
      throw err;
    }
    if (!dryRun) {
      applyPlan(targetRoot, plan);
      applyArtifactSyncSettings(plan.settings);
    }
    return { targetRoot, dryRun, plan, message: formatPlan(plan, dryRun) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Read-only: what is installed, how far it is from the brain this command came from, and what was edited since.
function installStatus(options = {}) {
  const sourceRoot = canonicalPath(options.sourceRoot || path.resolve(__dirname, '..', '..'));
  const targetRoot = canonicalPath(options.target || process.cwd());
  assertExistingTarget(targetRoot);
  const available = readBrainVersion(sourceRoot);
  const state = readState(targetRoot);
  if (!state.present) {
    return { targetRoot, installed: null, available, behind: false, modified: [], merged: [], missing: [], message: `brain: not installed in ${targetRoot}\navailable: ${available}\nrun: agent-brain pull` };
  }
  const modified = [];
  const merged = [];
  const missing = [];
  for (const [rel, recorded] of state.files) {
    const abs = path.join(targetRoot, rel);
    let current = null;
    try {
      checkPathComponents(targetRoot, rel);
      if (lstatIfPresent(abs)) current = fileInfo(abs);
    } catch {
      modified.push(rel);
      continue;
    }
    if (!current) missing.push(rel);
    else if (!sameInfo(current, recorded)) {
      // A merged file passes only when the brain's part and the mode are exactly as installed.
      let ownOnly = false;
      if (PROJECT_PARTS[rel] && recorded.owned && current.mode === recorded.mode) {
        try { ownOnly = brainOwnedHash(rel, current.content) === recorded.owned; } catch { /* a pull would refuse or replace it */ }
      }
      (ownOnly ? merged : modified).push(rel);
    }
  }
  const drift = describeDrift(state.version, available);
  const behind = ['unversioned', 'major', 'minor', 'patch'].includes(drift.kind);
  const changes = behind && state.version ? sectionsBetween(fs.readFileSync(path.join(sourceRoot, 'CHANGELOG.md'), 'utf8'), state.version, available) : [];
  const lines = [
    `installed: ${state.version || 'unversioned (installed before the brain had versions)'}`,
    `available: ${available}`
  ];
  if (drift.kind === 'same') lines.push('up to date');
  else if (drift.kind === 'downgrade') lines.push(`the install is newer than the brain this command came from; a pull would downgrade it`);
  else lines.push(`behind: ${drift.kind === 'unversioned' ? 'by an unknown amount' : `a ${drift.kind} update`}; run agent-brain pull to update`);
  const dropped = drift.kind === 'downgrade' ? downgradeRange(targetRoot, state, available) : { sections: [], note: null };
  if (dropped.sections.length) lines.push(`\nthe downgrade would remove:\n\n${formatSections(dropped.sections)}`);
  if (dropped.note) lines.push(dropped.note);
  if (changes.length) lines.push(`\nchanges since ${state.version}:\n\n${formatSections(changes)}`);
  if (modified.length) lines.push(`\nedited since install (a pull replaces these):\n${modified.map(p => `  ${p}`).join('\n')}`);
  if (merged.length) lines.push(`\nthe project's own part changed since install (a pull keeps it):\n${merged.map(p => `  ${p}: ${PROJECT_PARTS[p]}`).join('\n')}`);
  if (missing.length) lines.push(`\nmissing since install (a pull restores these):\n${missing.map(p => `  ${p}`).join('\n')}`);
  return { targetRoot, installed: state.version, available, drift, behind, changes, dropped, modified, merged, missing, message: lines.join('\n') };
}

module.exports = {
  STATE_PATH,
  CHANGELOG_PATH,
  installStatus,
  pullInstall,
  planInstall,
  collectBuildFiles,
  readState,
  validateRelPath,
  formatConflicts,
  formatPlan,
  mergeProjectAgents,
  mergeProjectModels
};
