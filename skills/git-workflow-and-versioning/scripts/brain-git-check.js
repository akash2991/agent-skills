#!/usr/bin/env node
'use strict';

// Checks the mechanical git-workflow-and-versioning rules so no agent has to remember them:
//   commit-msg <file>            P3, P4   message anatomy: type(scope), ticket id, Model / Thinking-effort / Harness trailers
//   branch [<name>]              P5       branch is <ticket>-<slug>
//   commits --base <ref>         P3, P4   every commit in <base>..<head> passes commit-msg
//   push                         P5       stdin from git's pre-push hook: each pushed refs/heads/* branch is <ticket>-<slug>
//   pr --base <ref>              P10, P11, P13   title starts with the ticket id, size within limits, changelog touched
// Exit 0 when every check passes, 1 with one line per failure, 2 on bad usage.
// Environment: LINEAR_TEAM narrows the ticket pattern to one team key; BRAIN_PR_MAX_LINES and BRAIN_PR_MAX_FILES
// override 400 and 10; PR_TITLE and PR_BODY stand in for --title and --body (CI passes them without shell quoting).

const { execFileSync } = require('child_process');
const fs = require('fs');

const TYPES = 'feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert';
const LOCKFILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|composer\.lock|Gemfile\.lock)$/;
const CHANGELOG = /(^|\/)CHANGELOG\.md$/;
const SIZE_EXCEPTION = /^Size-exception:[ \t]*\S/m;

function ticketSource(env = process.env) {
  return env.LINEAR_TEAM ? `${env.LINEAR_TEAM.replace(/[^A-Za-z0-9]/g, '')}-\\d+` : '[A-Z][A-Z0-9]*-\\d+';
}

function checkCommitMessage(raw, env = process.env) {
  const message = raw.split(/\r?\n/).filter(l => !l.startsWith('#')).join('\n').trim();
  const ticket = ticketSource(env);
  const subject = message.split('\n')[0] || '';
  // git's own revert and autosquash subjects carry no trailers; the commit they undo already passed.
  if (/^(Revert ".*"|fixup! |squash! |amend! )/.test(subject)) return [];
  const errors = [];
  if (/^Merge /.test(subject)) {
    if (!new RegExp(`\\b${ticket}\\b`).test(message)) errors.push('merge commit: put the ticket id in the message (P15)');
    return errors;
  }
  if (!new RegExp(`^(${TYPES})(\\([a-z0-9._/-]+\\))?!?: \\S.* \\[${ticket}\\]$`).test(subject)) {
    errors.push(`subject must be "<type>(<scope>): <what changed> [<TICKET-ID>]", type one of ${TYPES.split('|').join(', ')} (P2, P3): got "${subject}"`);
  }
  for (const trailer of ['Model', 'Thinking-effort', 'Harness']) {
    if (!new RegExp(`^${trailer}:[ \\t]*\\S`, 'm').test(message)) errors.push(`missing trailer "${trailer}: <value>" (P3)`);
  }
  return errors;
}

function checkBranchName(name, env = process.env) {
  if (!new RegExp(`^${ticketSource(env)}-[a-z0-9]+(-[a-z0-9]+)*$`).test(name)) {
    return [`branch "${name}" is not <ticket>-<slug>, for example ENG-123-login-form (P5)`];
  }
  return [];
}

function checkPrTitle(title, env = process.env) {
  if (!new RegExp(`^${ticketSource(env)}: \\S`).test(title || '')) {
    return [`PR title must be "<ticket>: <goal>": got "${title || ''}" (P10)`];
  }
  return [];
}

// numstat is the output of `git diff --numstat`: "<added>\t<deleted>\t<path>", binary files as "-\t-\t<path>".
function parseNumstat(numstat) {
  return numstat.split('\n').filter(Boolean).map(line => {
    const [added, deleted, ...rest] = line.split('\t');
    return { path: rest.join('\t'), added: Number(added) || 0, lines: (Number(added) || 0) + (Number(deleted) || 0) };
  }).filter(f => !LOCKFILES.test(f.path));
}

function checkSize(files, body = '', env = process.env) {
  const maxLines = Number(env.BRAIN_PR_MAX_LINES) || 400;
  const maxFiles = Number(env.BRAIN_PR_MAX_FILES) || 10;
  const lines = files.reduce((n, f) => n + f.lines, 0);
  if ((lines <= maxLines && files.length <= maxFiles) || SIZE_EXCEPTION.test(body)) return [];
  return [`PR changes ${lines} lines in ${files.length} files; split it at ${maxLines} lines or ${maxFiles} files, or record "Size-exception: <reason>" in the PR body (P11)`];
}

// A changelog must gain a line; deleting or leaving the file untouched does not satisfy P13.
function checkChangelog(files) {
  return files.some(f => CHANGELOG.test(f.path) && f.added > 0) ? [] : ['no added CHANGELOG.md line in this change (P13)'];
}

// The refs git's pre-push hook receives on stdin: "<local ref> <local sha> <remote ref> <remote sha>".
// Deletions (all-zero local sha), tags, and the protected trunk are not branch names to check.
function checkPushedRefs(stdin, env = process.env) {
  const errors = [];
  for (const line of stdin.split('\n').filter(Boolean)) {
    const [localRef, localSha] = line.split(' ');
    if (/^0+$/.test(localSha) || !localRef.startsWith('refs/heads/')) continue;
    const branch = localRef.slice('refs/heads/'.length);
    if (branch === 'main' || branch.startsWith('release/')) continue;
    errors.push(...checkBranchName(branch, env));
  }
  return errors;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function optionValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

function report(errors) {
  for (const e of errors) console.error(`brain-git-check: ${e}`);
  process.exit(errors.length ? 1 : 0);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'commit-msg') {
    if (!rest[0]) { console.error('usage: commit-msg <message-file>'); process.exit(2); }
    return report(checkCommitMessage(fs.readFileSync(rest[0], 'utf8')));
  }
  if (cmd === 'branch') {
    const name = rest[0] || git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    return report(checkBranchName(name));
  }
  if (cmd === 'commits') {
    const base = optionValue(rest, '--base');
    if (!base) { console.error('usage: commits --base <ref> [--head <ref>]'); process.exit(2); }
    const head = optionValue(rest, '--head') || 'HEAD';
    const errors = [];
    for (const sha of git(['rev-list', `${base}..${head}`]).split('\n').filter(Boolean)) {
      for (const e of checkCommitMessage(git(['log', '-1', '--format=%B', sha]))) errors.push(`${sha.slice(0, 8)}: ${e}`);
    }
    return report(errors);
  }
  if (cmd === 'push') {
    return report(checkPushedRefs(fs.readFileSync(0, 'utf8')));
  }
  if (cmd === 'pr') {
    const base = optionValue(rest, '--base');
    if (!base) { console.error('usage: pr --base <ref> [--head <ref>] [--title <t>]'); process.exit(2); }
    const head = optionValue(rest, '--head') || 'HEAD';
    const files = parseNumstat(git(['diff', '--numstat', `${base}...${head}`]));
    const body = process.env.PR_BODY || '';
    return report([
      ...checkPrTitle(optionValue(rest, '--title') || process.env.PR_TITLE),
      ...checkSize(files, body),
      ...checkChangelog(files),
    ]);
  }
  console.error('usage: brain-git-check.js commit-msg <file> | branch [<name>] | commits --base <ref> | pr --base <ref>');
  process.exit(2);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { checkCommitMessage, checkBranchName, checkPrTitle, parseNumstat, checkSize, checkChangelog, checkPushedRefs, ticketSource };
