#!/usr/bin/env node
'use strict';

// Installs the git hooks that run brain-git-check.js: commit-msg (P3, P4) and pre-push (P5).
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
    : `node "$CHECK" push`;
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
    if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes(MARKER)) {
      results.push(`${name}: skipped, a hook this script did not write is already there (${file})`);
      continue;
    }
    fs.writeFileSync(file, hookBody(name, checkPathFromRoot), { mode: 0o755 });
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
  // An absolute core.hooksPath outside this repository (set globally, or shared by other repositories) would install
  // these hooks for every repository that uses it: refuse rather than reach beyond this one.
  let configured = '';
  try { configured = git(['config', '--get', 'core.hooksPath']); } catch { /* unset */ }
  if (configured && path.isAbsolute(configured) && !path.resolve(configured).startsWith(root + path.sep) && !path.resolve(configured).startsWith(path.resolve(git(['rev-parse', '--git-common-dir'])) + path.sep)) {
    console.error(`install-hooks: core.hooksPath is ${configured}, outside this repository, so hooks there would run for other repositories too: set a repository-local core.hooksPath (or unset it) and run again`);
    process.exit(1);
  }
  const results = install(hooksDir, rel);
  // A relative core.hooksPath resolves inside each worktree, so these hooks guard only this one: run it in every
  // worktree (development-setup DS2 creates them).
  let hooksPath = '';
  try { hooksPath = git(['config', '--get', 'core.hooksPath']); } catch { /* unset: hooks are shared by every worktree */ }
  if (hooksPath && !path.isAbsolute(hooksPath)) results.push(`note: core.hooksPath (${hooksPath}) is relative, so these hooks cover this worktree only: run install-hooks.js in each worktree`);
  for (const line of results) console.log(line);
  // A skipped hook means the rules are not enforced here: say so through the exit code too.
  if (results.some(r => r.includes('skipped'))) process.exitCode = 1;
}

module.exports = { hookBody, install, MARKER, shellQuote };
