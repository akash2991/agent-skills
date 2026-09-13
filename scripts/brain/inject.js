#!/usr/bin/env node
'use strict';
// Copy a built target into another repository.
//   node scripts/inject.js <repo-path> [--targets claude-code,codex] [--dry-run] [--install-commands]
// Rules: never deletes anything in the target repo; overwrites only files agent-brain owns;
// seeds (registry, global docs) are created only when missing; always-on files are merged as a
// managed block; MCP config is merged by server name.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DIST_DIR, DIST_SELF_DIR, exists, isDir, listDirs, ensureDir, readJson, writeJson } = require('./lib/fs-utils');

const START = '<!-- agent-brain:start -->';
const END = '<!-- agent-brain:end -->';

const args = process.argv.slice(2);
const repo = args.find(a => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
// --self installs the build that also carries the brain-development artifacts. Only the brain's own
// repository should ever use it; a project consuming the brain gets the product build.
const selfBuild = args.includes('--self');
const sourceDir = selfBuild ? DIST_SELF_DIR : DIST_DIR;
// Some harnesses discover commands only under a home directory, never inside a repository. The repo
// copy is still the version-controlled source; this opts into installing it where the harness looks.
const installCommands = args.includes('--install-commands');
const tIdx = args.indexOf('--targets');
const only = tIdx === -1 ? null : args[tIdx + 1].split(',').map(s => s.trim()).filter(Boolean);

if (!repo) { console.error('usage: node scripts/inject.js <repo-path> [--targets a,b] [--dry-run] [--install-commands]'); process.exit(2); }
const repoAbs = path.resolve(repo);
if (!isDir(repoAbs)) { console.error(`not a directory: ${repoAbs}`); process.exit(1); }
const built = listDirs(sourceDir);
if (!built.length) { console.error(`${path.relative(process.cwd(), sourceDir)}/ is empty: run \`npm run ${selfBuild ? 'build:self' : 'build'}\` first`); process.exit(1); }
const targets = only ? only.filter(t => { if (!built.includes(t)) console.error(`WARN  no build for target "${t}"`); return built.includes(t); }) : built;

// Commands a harness only reads from a home directory. Collected while injecting, then either
// installed (with --install-commands) or printed as the one manual step that makes them resolve.
const globalCommands = [];

function resolveHome(spec) {
  const fromEnv = spec.homeEnv && process.env[spec.homeEnv];
  const base = fromEnv || (spec.home || '').replace(/^~(?=$|\/)/, os.homedir());
  return base ? path.resolve(base, spec.installDir || '') : null;
}

function mergeManagedBlock(existing, block) {
  const s = existing.indexOf(START), e = existing.indexOf(END);
  if (s !== -1 && e !== -1 && e > s) return existing.slice(0, s) + block.trim() + existing.slice(e + END.length);
  const sep = existing.length && !existing.endsWith('\n') ? '\n\n' : existing.length ? '\n' : '';
  return existing + sep + block.trim() + '\n';
}

// Hook config is arrays keyed by event name. Ours are appended to whatever the project already has,
// deduplicated by the command string, so re-injecting is idempotent and a user's own hooks survive.
function mergeHooks(existingText, incoming, key) {
  let existing = {};
  try { existing = existingText ? JSON.parse(existingText) : {}; } catch { console.error('WARN  existing hook file is not valid JSON; leaving it untouched'); return null; }
  const target = existing[key] && typeof existing[key] === 'object' ? existing[key] : {};
  const commands = entry => (entry.hooks || []).map(h => h.command).join('|');
  for (const [event, entries] of Object.entries(incoming[key] || {})) {
    const current = Array.isArray(target[event]) ? target[event] : [];
    const seen = new Set(current.map(commands));
    target[event] = [...current, ...entries.filter(e => !seen.has(commands(e)))];
  }
  existing[key] = target;
  return JSON.stringify(existing, null, 2) + '\n';
}

function mergeMcp(existingText, incoming, key) {
  let existing = {};
  try { existing = existingText ? JSON.parse(existingText) : {}; } catch { console.error('WARN  existing MCP file is not valid JSON; leaving it untouched'); return null; }
  for (const [k, v] of Object.entries(incoming)) if (k !== key && !(k in existing)) existing[k] = v;
  existing[key] = { ...(existing[key] || {}), ...(incoming[key] || {}) };
  return JSON.stringify(existing, null, 2) + '\n';
}

const summary = { injectedAt: new Date().toISOString(), source: sourceDir, selfBuild, targets: {} };
// What the previous injection wrote. A file the brain owned and no longer produces, because it was
// renamed or dropped, has to be removed: leaving it behind means a repository keeps answering to a
// command or loading a skill that no longer exists anywhere in the source.
const previousFile = path.join(repoAbs, '.agent-brain', 'injected.json');
const previous = exists(previousFile) ? (readJson(previousFile) || {}) : {};
const retired = [];
let count = 0;
for (const id of targets) {
  const base = path.join(sourceDir, id);
  const build = readJson(path.join(base, 'agent-brain.build.json'));
  const done = [];
  let overwritten = 0;
  const seeds = new Set(build.seeds || []);
  const files = [...new Set(build.files.concat(build.seeds || [], [build.alwaysOn],
    build.mcpFile ? [build.mcpFile] : [], build.hooksFile ? [build.hooksFile] : []))];
  let kept = 0;
  for (const rel of files) {
    const from = path.join(base, rel);
    if (!exists(from)) continue;
    const to = path.join(repoAbs, rel);
    const existing = exists(to) ? fs.readFileSync(to, 'utf8') : '';
    let content;
    let action;
    if (rel === build.alwaysOn) {
      // For .mdc rules the whole file is ours; for CLAUDE.md/AGENTS.md/etc. merge into the user's file.
      const incoming = fs.readFileSync(from, 'utf8');
      if (rel.endsWith('.mdc')) { content = incoming; action = existing ? 'overwrite' : 'create'; }
      else { content = mergeManagedBlock(existing, incoming); action = existing ? (existing.includes(START) ? 'update block' : 'append block') : 'create'; }
    } else if (seeds.has(rel)) {
      if (existing) { kept++; continue; }
      content = fs.readFileSync(from); action = 'seed';
    } else if (rel === build.hooksFile) {
      content = mergeHooks(existing, readJson(from), build.hooksKey || 'hooks');
      if (content === null) continue;
      action = existing ? 'merge hooks' : 'create';
    } else if (rel === build.mcpFile) {
      content = mergeMcp(existing, readJson(from), build.mcpKey || 'mcpServers');
      if (content === null) continue;
      action = existing ? 'merge' : 'create';
    } else {
      content = fs.readFileSync(from);
      action = existing ? 'overwrite' : 'create';
    }
    if (!dryRun) { ensureDir(path.dirname(to)); fs.writeFileSync(to, content); }
    done.push(rel);
    count++;
    if (action === 'overwrite') overwritten++;
    else console.log(`  ${dryRun ? '[dry-run] ' : ''}${action.padEnd(12)} ${rel}`);
  }
  if (build.commands && build.commands.scope === 'global') {
    const dest = resolveHome(build.commands);
    for (const rel of done.filter(r => r.startsWith(`${build.commands.dir}/`))) {
      globalCommands.push({ id, rel, from: path.join(sourceDir, id, rel), to: dest ? path.join(dest, path.basename(rel)) : null, why: build.commands.why });
    }
  }
  // Only ever remove a path this target wrote last time and does not write now. A seed is never
  // retired whatever the record says: it is created once and then belongs to the project, so its
  // content is the user's. The same goes for always-on files and merged config, which are shared.
  const ownedBefore = (previous.targets && previous.targets[id] && previous.targets[id].files) || [];
  const ownedNow = new Set(done);
  const untouchable = new Set([build.alwaysOn, build.mcpFile, build.hooksFile].filter(Boolean));
  for (const rel of ownedBefore) {
    if (ownedNow.has(rel) || seeds.has(rel) || untouchable.has(rel)) continue;
    const abs = path.join(repoAbs, rel);
    if (!exists(abs)) continue;
    if (!dryRun) fs.rmSync(abs, { force: true });
    retired.push(rel);
    console.log(`  ${dryRun ? '[dry-run] ' : ''}retire       ${rel}`);
  }
  summary.targets[id] = { builtAt: build.builtAt, files: done };
  console.log(`  ${id}: ${done.length} file(s)${overwritten ? `, ${overwritten} overwritten` : ''}${kept ? `, ${kept} seed(s) kept as-is` : ''}`);
}
if (!dryRun) {
  const first = targets[0] && readJson(path.join(sourceDir, targets[0], 'agent-brain.build.json'));
  const orgDir = first ? first.orgDir : '.agent-brain';
  writeJson(path.join(repoAbs, orgDir, 'injected.json'), summary);
}
console.log(`\n${dryRun ? 'would inject' : 'injected'} ${count} file(s)${retired.length ? `, retired ${retired.length}` : ''} into ${repoAbs} for: ${targets.join(', ')}`);

if (globalCommands.length) {
  console.log(`\nharness-global commands (${globalCommands[0].why})`);
  for (const c of globalCommands) {
    if (!c.to) { console.log(`  ${c.id}: cannot resolve the harness home directory; copy ${c.rel} there yourself`); continue; }
    if (installCommands && !dryRun) {
      ensureDir(path.dirname(c.to));
      fs.copyFileSync(c.from, c.to);
      console.log(`  installed     ${c.to}`);
    } else {
      console.log(`  ${dryRun ? '[dry-run] ' : ''}not installed: ${c.to}`);
      console.log(`    re-run with --install-commands, or: mkdir -p ${path.dirname(c.to)} && cp ${path.join(repoAbs, c.rel)} ${c.to}`);
    }
  }
}
