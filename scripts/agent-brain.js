#!/usr/bin/env node
'use strict';

const path = require('path');
const { pullInstall } = require('./lib/pull-install');
const { LANGFUSE_PACKAGE, preflightLangfuse, installLangfuse } = require('./lib/langfuse');

function help() {
  console.log(`Usage: agent-brain pull [--target <existing-dir>] [--dry-run] [--langfuse]\n\nPull the complete agent brain into a repository.\nReplaces brain-owned files; preserves only AGENTS.md's "## This project" section.\nNo backups are created. Use Git to review or revert changes.\n\nOptions:\n  --target <existing-dir>  Install into this existing directory (default: current directory)\n  --dry-run                Show the planned changes without writing files\n  --langfuse               Register the official Langfuse Pi plugin locally (requires Pi)\n                           Opt-in: session content is sent to your Langfuse project\n  --help, -h               Show help\n`);
}

function parse(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return { help: true };
  const [cmd, ...rest] = argv;
  if (cmd !== 'pull') return { error: `unknown command: ${cmd}` };
  const opts = { command: cmd, target: process.cwd(), dryRun: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--target') {
      if (!rest[i + 1] || rest[i + 1].startsWith('-')) return { error: 'missing value for --target' };
      opts.target = path.resolve(rest[++i]);
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--langfuse') {
      opts.langfuse = true;
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }
  return opts;
}

const parsed = parse(process.argv.slice(2));
if (parsed.help) {
  help();
  process.exit(0);
}
if (parsed.error) {
  console.error(parsed.error);
  help();
  process.exit(2);
}

try {
  if (parsed.langfuse && !parsed.dryRun) preflightLangfuse(parsed.target);
  const result = pullInstall({ target: parsed.target, dryRun: parsed.dryRun });
  console.log(result.message);
  console.log(`target: ${result.targetRoot}`);
  if (parsed.langfuse) {
    console.log(parsed.dryRun
      ? `would register ${LANGFUSE_PACKAGE} using pi install --local (no credentials copied)`
      : installLangfuse(result.targetRoot));
  }
} catch (err) {
  console.error(err.message);
  process.exit(err.code === 'PULL_CONFLICT' ? 1 : 2);
}
