#!/usr/bin/env node
'use strict';

// Installs the git hooks that run brain-git-check.js: commit-msg (P3, P4) and pre-push (P5, P8, P16).
// Run from inside the project's checkout or any of its worktrees; hooks are shared by all of them.
// An existing hook that this script did not write is left alone and reported, never overwritten.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MARKER = '# brain-git-check hook';
const CHECK = path.join(__dirname, 'brain-git-check.js');

// Single-quote a value for the POSIX shell so nothing in a path is executed.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// A checkout that predates the brain pull has no check script: warn and let the commit or push through,
// instead of failing every command with MODULE_NOT_FOUND.
function hookBody(name, checkPath) {
  const run = name === 'commit-msg'
    ? `node "$CHECK" commit-msg "$1"`
    : `node "$CHECK" push "$@"`;
  return [
    '#!/bin/sh', MARKER,
    'ROOT="$(git rev-parse --show-toplevel)"',
    `CHECK="$ROOT"/${shellQuote(checkPath)}`,
    'if [ ! -f "$CHECK" ]; then echo "brain-git-check: $CHECK not found; skipping" >&2; exit 0; fi',
    run,
    '',
  ].join('\n');
}

function install(hooksDir, checkPathFromRoot) {
  const results = [];
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const name of ['commit-msg', 'pre-push']) {
    const file = path.join(hooksDir, name);
    // A hook file that is a symlink may point at a hook other repositories share: never write through it.
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
      results.push(`${name}: skipped, it is a symlink (${file} -> ${fs.readlinkSync(file)}); replace it with a plain file or remove it`);
      continue;
    }
    if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes(MARKER)) {
      results.push(`${name}: skipped, a hook this script did not write is already there (${file})`);
      continue;
    }
    fs.writeFileSync(file, hookBody(name, checkPathFromRoot), { mode: 0o755 });
    // The mode above applies only to a new file: a hook restored without its execute bit would be ignored by git.
    fs.chmodSync(file, 0o755);
    results.push(`${name}: installed`);
  }
  return results;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

if (require.main === module) {
  const root = git(['rev-parse', '--show-toplevel']);
  const hooksDir = path.resolve(git(['rev-parse', '--git-path', 'hooks']));
  const rel = path.relative(root, CHECK).split(path.sep).join('/');
  // The hook finds the checker relative to each worktree's root, so it must be this repository's own copy (the one
  // agent-brain pull installs): a path outside would resolve elsewhere from another worktree and skip every check.
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    console.error(`install-hooks: ${CHECK} is outside this repository; run the copy installed in it (.agents/skills/git-workflow-and-versioning/scripts/install-hooks.js)`);
    process.exit(1);
  }
  // A hook directory outside this repository (a global or shared core.hooksPath, ../shared-hooks, or a .git/hooks
  // symlinked elsewhere) would install these hooks for other repositories too: the resolved, canonical directory must
  // lie in this worktree or its git dir, or nothing is written.
  let configured = '';
  try { configured = git(['config', '--get', 'core.hooksPath']); } catch { /* unset */ }
  const real = p => { let head = path.resolve(p); const tail = []; while (!fs.existsSync(head)) { tail.unshift(path.basename(head)); head = path.dirname(head); } return path.join(fs.realpathSync(head), ...tail); };
  const within = (p, dir) => { const r = path.relative(real(dir), real(p)); return r && !r.startsWith('..') && !path.isAbsolute(r); };
  const homes = [root, git(['rev-parse', '--git-common-dir']), git(['rev-parse', '--git-dir'])];
  // Where it is set matters as much as where it points: a global or system core.hooksPath applies to every repository,
  // even when it names a directory inside this one.
  let scope = '';
  try { scope = git(['config', '--show-scope', '--get', 'core.hooksPath']).split('\t')[0].trim(); } catch { /* unset */ }
  if (configured && !['local', 'worktree'].includes(scope)) {
    console.error(`install-hooks: core.hooksPath (${configured}) is set in the ${scope || 'unknown'} git config, so it applies to other repositories too: set it in this repository's config (git config --local) or unset it, and run again`);
    process.exit(1);
  }
  if (!homes.some(d => within(hooksDir, d))) {
    console.error(`install-hooks: the hook directory ${configured ? `(core.hooksPath ${configured}) ` : ''}resolves to ${real(hooksDir)}, outside this repository, so hooks there would run for other repositories too: set a repository-local core.hooksPath (or unset it) and run again`);
    process.exit(1);
  }
  const results = install(hooksDir, rel);
  // A relative core.hooksPath resolves inside each worktree, so these hooks guard only this one: run it in every
  // worktree (development-setup DS2 creates them).
  let hooksPath = '';
  try { hooksPath = git(['config', '--get', 'core.hooksPath']); } catch { /* unset: hooks are shared by every worktree */ }
  if (hooksPath && !path.isAbsolute(hooksPath)) results.push(`note: core.hooksPath (${hooksPath}) is relative, so these hooks cover this worktree only: run install-hooks.js in each worktree`);
  // A skipped hook is a failure: it goes to stderr, like every other failure these scripts report.
  for (const line of results) (line.includes('skipped') ? console.error : console.log)(line);
  // A skipped hook means the rules are not enforced here: say so through the exit code too.
  if (results.some(r => r.includes('skipped'))) process.exitCode = 1;
}

module.exports = { hookBody, install, MARKER, shellQuote };
