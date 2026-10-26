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

// A checkout that predates the brain pull has no check script: warn and let the commit or push through,
// instead of failing every command with MODULE_NOT_FOUND.
function hookBody(name, checkPath) {
  const run = name === 'commit-msg'
    ? `node "$CHECK" commit-msg "$1"`
    : `node "$CHECK" push`;
  return [
    '#!/bin/sh', MARKER,
    'ROOT="$(git rev-parse --show-toplevel)"',
    `CHECK="$ROOT/${checkPath}"`,
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
  for (const line of install(hooksDir, rel)) console.log(line);
}

module.exports = { hookBody, install, MARKER };
