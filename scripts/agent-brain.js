#!/usr/bin/env node
'use strict';

const path = require('path');
const { pullInstall } = require('./lib/pull-install');
const { RUNTIME_PATH, planLangfuseMarker, preflightLangfuse, installLangfuse } = require('./lib/langfuse');

function help() {
  console.log(`Usage: agent-brain pull [--target <existing-dir>] [--dry-run] [--langfuse [--capture-mode metadata-only|full-content]] [--worktree-bootstrap]\n\nPull the complete agent brain into a repository.\nReplaces brain-owned files; preserves only AGENTS.md's "## This project" section.\nNo backups are created. Use Git to review or revert changes.\n\nOptions:\n  --target <existing-dir>  Install into this existing directory (default: current directory)\n  --dry-run                Show the planned changes without writing files\n  --langfuse               Register first-party Pi + Claude tracing (new opt-ins: metadata-only)\n  --capture-mode <mode>    With --langfuse: metadata-only or explicit full-content consent\n                           Full-content retains PII with best-effort credential redaction,\n                           private durable retries and bounded available native content.\n                           Omission preserves the existing policy, including disabled.\n  --worktree-bootstrap     With --langfuse, explicitly register the project-gated Pi user\n                           bootstrap for old worktree bases; remove known legacy user exporter\n  --help, -h               Show help\n`);
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
    } else if (arg === '--capture-mode') {
      if (opts.captureMode !== undefined) return { error: 'duplicate --capture-mode' };
      const mode = rest[++i];
      if (!['metadata-only', 'full-content'].includes(mode)) return { error: 'invalid --capture-mode: expected metadata-only or full-content' };
      opts.captureMode = mode;
    } else if (arg === '--worktree-bootstrap') {
      opts.worktreeBootstrap = true;
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }
  if (opts.captureMode !== undefined && !opts.langfuse) return { error: '--capture-mode requires --langfuse' };
  if (opts.worktreeBootstrap && !opts.langfuse) return { error: '--worktree-bootstrap requires --langfuse' };
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
  const tracingOptions = { worktreeBootstrap: parsed.worktreeBootstrap, captureMode: parsed.captureMode };
  const policy = parsed.langfuse ? planLangfuseMarker(parsed.target, tracingOptions) : null;
  if (parsed.langfuse && !parsed.dryRun) preflightLangfuse(parsed.target, undefined, tracingOptions);
  const result = pullInstall({ target: parsed.target, dryRun: parsed.dryRun });
  console.log(result.message);
  console.log(`target: ${result.targetRoot}`);
  if (parsed.langfuse) {
    console.log(parsed.dryRun
      ? `would register Pi/Claude adapters from ${RUNTIME_PATH}; ${policy.enabled ? policy.captureMode : `disabled (configured ${policy.captureMode}; refusal preserved)`}; disable known legacy project exporters; no credentials copied${policy.captureMode === 'full-content' ? '\nfull-content consent retains PII; best-effort credential redaction, private durable retries and bounded available native content' : ''}${parsed.worktreeBootstrap ? '\nwould explicitly register a project-gated Pi user bootstrap for old worktrees and remove known legacy user package' : ''}`
      : installLangfuse(result.targetRoot, undefined, tracingOptions));
  }
} catch (err) {
  console.error(err.message);
  process.exit(err.code === 'PULL_CONFLICT' ? 1 : 2);
}
