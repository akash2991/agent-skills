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
// override 400 and 10; PR_TITLE and PR_BODY supply the title and body (CI passes them without shell quoting).
// The protected branches are main plus the repository's default branch (origin/HEAD), when one is known.

const { execFileSync } = require('child_process');
const fs = require('fs');

const TYPES = 'feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert';
// git's own merge subjects: "Merge pull request #n ..." and "Merge branch ...". Anything else starting "Merge " is a commit.
const GIT_MERGE = /^Merge (pull request #\d+|branch |remote-tracking branch )/;
const LOCKFILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|composer\.lock|Gemfile\.lock)$/;
const CHANGELOG = /(^|\/)CHANGELOG\.md$/;
const SIZE_EXCEPTION = /^Size-exception:[ \t]*\S/m;

function ticketSource(env = process.env) {
  return env.LINEAR_TEAM ? `${env.LINEAR_TEAM.replace(/[^A-Za-z0-9]/g, '')}-\\d+` : '[A-Z][A-Z0-9]*-\\d+';
}

// allowFixup is for the local commit-msg hook only: autosquash folds fixup!/squash! commits before a PR merges, and CI
// (which runs without it) rejects any that are left unsquashed.
function checkCommitMessage(raw, env = process.env, { allowFixup = false } = {}) {
  const message = raw.split(/\r?\n/).filter(l => !l.startsWith('#')).join('\n').trim();
  const ticket = ticketSource(env);
  const subject = message.split('\n')[0] || '';
  // A git revert keeps the subject shape of git's own "Revert \"…\"", but still needs its ticket and trailers (P2, P3).
  // fixup!/squash! are not exempt: they must be autosquashed before the PR is merged, so the commit that lands is checked.
  const revert = /^Revert ".*"/.test(subject);
  const errors = [];
  if (revert && !new RegExp(`\\b${ticket}\\b`).test(message)) errors.push('revert commit: name the ticket id it belongs to (P2)');
  if (allowFixup && /^(fixup! |squash! )/.test(subject)) return [];
  if (GIT_MERGE.test(subject)) {
    if (!new RegExp(`\\b${ticket}\\b`).test(message)) errors.push('merge commit: put the ticket id in the message (P15)');
    return errors;
  }
  if (!revert && !new RegExp(`^(${TYPES})(\\([a-z0-9._/,-]+\\))?!?: \\S.* \\[${ticket}\\]$`).test(subject)) {
    errors.push(`subject must be "<type>(<scope>): <what changed> [<TICKET-ID>]", type one of ${TYPES.split('|').join(', ')} (P2, P3): got "${subject}"`);
  }
  for (const trailer of ['Model', 'Thinking-effort', 'Harness']) {
    if (!new RegExp(`^${trailer}:[ \\t]*\\S`, 'm').test(message)) errors.push(`missing trailer "${trailer}: <value>" (P3)`);
  }
  return errors;
}

function checkBranchName(name, env = process.env) {
  if (name === 'main' || name.startsWith('release/')) return [];
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
// P13 needs a line in the global changelog and in the changelog of every service the change touches. A service's
// changelog is the nearest CHANGELOG.md above a changed file. `allChangelogs` is the repository's list of them.
// The brain's documentation map keeps the project changelog in docs/ (references/documentation-map.md). A root
// CHANGELOG.md, whatever tool writes it, is not the project's global changelog.
const GLOBAL_CHANGELOGS = ['docs/CHANGELOG.md'];

function requiredChangelogs(changedPaths, allChangelogs) {
  const required = new Set();
  const global = GLOBAL_CHANGELOGS.find(c => allChangelogs.includes(c));
  if (global) required.add(global);
  for (const p of changedPaths) {
    if (CHANGELOG.test(p) || p.startsWith('templates/')) continue;
    const dir = p.split('/').slice(0, -1);
    while (dir.length) {
      const candidate = [...dir, 'CHANGELOG.md'].join('/');
      if (allChangelogs.includes(candidate)) { required.add(candidate); break; }
      dir.pop();
    }
  }
  return [...required];
}

function checkChangelog(files, allChangelogs = ['docs/CHANGELOG.md']) {
  // P13 needs a global changelog. A service changelog does not stand in for it, and a repository with none cannot pass.
  if (!GLOBAL_CHANGELOGS.some(c => allChangelogs.includes(c))) {
    return [`no global changelog (${GLOBAL_CHANGELOGS.join(' or ')}) in this repository, so P13 cannot be met: add one (P13)`];
  }
  const changed = files.map(f => f.path);
  const missing = requiredChangelogs(changed, allChangelogs).filter(c => {
    const entry = files.find(f => f.path === c);
    return !entry || entry.added < 1;
  });
  return missing.length ? [`no added changelog line in ${missing.join(', ')} (P13: global and per-service)`] : [];
}

// The refs git's pre-push hook receives on stdin: "<local ref> <local sha> <remote ref> <remote sha>".
// The remote ref is the name that is judged: `git push origin HEAD:name` pushes HEAD under another name.
// Deletions (all-zero local sha) and tags are not branch updates. Direct pushes to main are refused (P8).
function checkPushedRefs(stdin, env = process.env, protectedBranches = ['main']) {
  const errors = [];
  for (const line of stdin.split('\n').filter(Boolean)) {
    const [, localSha, remoteRef] = line.split(' ');
    if (/^0+$/.test(localSha) || !remoteRef || !remoteRef.startsWith('refs/heads/')) continue;
    const branch = remoteRef.slice('refs/heads/'.length);
    if (protectedBranches.includes(branch)) { errors.push(`direct push to ${branch} is refused: open a PR (P8)`); continue; }
    if (branch.startsWith('release/')) continue;
    errors.push(...checkBranchName(branch, env));
  }
  return errors;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// Every CHANGELOG.md tracked in the repository; the PR's own checkout is the source of truth.
// Every CHANGELOG.md the PR touches or could require: those in the checkout and those on the base branch. A changelog the
// PR deletes is still on the base branch, so the service it belongs to still needs its entry (P13).
// ':/' anchors the pattern at the repository root, so a run from a subdirectory sees the same paths as the diff.
function listChangelogs(base) {
  const here = git(['ls-files', '--full-name', '--', ':/*CHANGELOG.md']).split('\n');
  const onBase = base ? git(['ls-tree', '-r', '--name-only', base]).split('\n') : [];
  return [...new Set([...here, ...onBase.filter(f => /(^|\/)CHANGELOG\.md$/.test(f))])]
    .filter(f => f && !f.startsWith('templates/'));
}

// The repository's default branch, as far as this checkout knows it. Pushes to it are refused like pushes to main.
function protectedBranches() {
  const names = new Set(['main']);
  try { names.add(git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim().replace(/^origin\//, '')); } catch { /* no origin/HEAD */ }
  return [...names];
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
    return report(checkCommitMessage(fs.readFileSync(rest[0], 'utf8'), process.env, { allowFixup: true }));
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
    return report(checkPushedRefs(fs.readFileSync(0, 'utf8'), process.env, protectedBranches()));
  }
  if (cmd === 'pr') {
    const base = optionValue(rest, '--base');
    if (!base) { console.error('usage: pr --base <ref> [--head <ref>] [--title <t>]'); process.exit(2); }
    const head = optionValue(rest, '--head') || 'HEAD';
    const files = parseNumstat(git(['diff', '--numstat', '--no-renames', `${base}...${head}`]));
    const body = process.env.PR_BODY || '';
    return report([
      ...checkPrTitle(optionValue(rest, '--title') || process.env.PR_TITLE),
      ...checkSize(files, body),
      ...checkChangelog(files, listChangelogs(base)),
    ]);
  }
  console.error('usage: brain-git-check.js commit-msg <file> | branch [<name>] | commits --base <ref> | pr --base <ref>');
  process.exit(2);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { checkCommitMessage, checkBranchName, checkPrTitle, parseNumstat, checkSize, checkChangelog, requiredChangelogs, checkPushedRefs, ticketSource, GLOBAL_CHANGELOGS };
