#!/usr/bin/env node
'use strict';

// Checks the mechanical git-workflow-and-versioning rules so no agent has to remember them:
//   commit-msg <file>            P3, P4   message anatomy: type(scope), ticket id, Model / Thinking-effort / Harness trailers
//   branch [<name>]              P5       branch is <ticket>-<slug>
//   commits --base <ref>         P3, P4   every commit in <base>..<head> passes commit-msg
//   push                         P5       stdin from git's pre-push hook: each pushed refs/heads/* branch is <ticket>-<slug>
//   push                         P8       a push to, or deletion of, main or the default branch is refused
//   pr --base <ref>              P10, P11, P13   title is "<ticket>: <goal>", size within limits, changelog touched
// Exit 0 when every check passes, 1 with one line per failure, 2 on bad usage.
// Environment: LINEAR_TEAM narrows the ticket pattern to one team key (read from the repository's .env when unset); BRAIN_PR_MAX_LINES and BRAIN_PR_MAX_FILES
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
// isMerge: whether the commit has more than one parent, when the caller knows (commits mode); a one-parent commit
// with a merge-like subject is then checked like any other. The commit-msg hook cannot know, so it goes by the subject.
function checkCommitMessage(raw, env = process.env, { allowFixup = false, isMerge } = {}) {
  const message = raw.split(/\r?\n/).filter(l => !l.startsWith('#')).join('\n').trim();
  const ticket = ticketSource(env);
  const subject = message.split('\n')[0] || '';
  // A git revert keeps the subject shape of git's own "Revert \"…\"", but still needs its ticket and trailers (P2, P3).
  // fixup!/squash! are not exempt: they must be autosquashed before the PR is merged, so the commit that lands is checked.
  const revert = /^Revert ".*"/.test(subject);
  const errors = [];
  if (revert && !new RegExp(`\\b${ticket}\\b`).test(message)) errors.push('revert commit: name the ticket id it belongs to (P2)');
  if (allowFixup && /^(fixup! |squash! )/.test(subject)) return [];
  if (GIT_MERGE.test(subject) && isMerge !== false) {
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
const GLOBAL_CHANGELOGS = ['CHANGELOG.md', 'docs/CHANGELOG.md'];

// headFiles, when given, is every path at the PR head: a service changelog is then not required when its service is
// gone from the head entirely (removed or moved, and the move's new changelog is required where it lands).
function requiredChangelogs(changedPaths, allChangelogs, headFiles) {
  const required = new Set();
  const global = GLOBAL_CHANGELOGS.find(c => allChangelogs.includes(c));
  if (global) required.add(global);
  for (const p of changedPaths) {
    if (CHANGELOG.test(p) || p.startsWith('templates/')) continue;
    const dir = p.split('/').slice(0, -1);
    while (dir.length) {
      const candidate = [...dir, 'CHANGELOG.md'].join('/');
      if (allChangelogs.includes(candidate)) {
        const serviceDir = `${dir.join('/')}/`;
        if (!headFiles || headFiles.some(f => f.startsWith(serviceDir))) required.add(candidate);
        break;
      }
      dir.pop();
    }
  }
  return [...required];
}

function checkChangelog(files, allChangelogs = ['CHANGELOG.md'], headFiles) {
  // P13 needs a global changelog. A service changelog does not stand in for it, and a repository with none cannot pass.
  if (!GLOBAL_CHANGELOGS.some(c => allChangelogs.includes(c))) {
    return [`no global changelog (${GLOBAL_CHANGELOGS.join(' or ')}) in this repository, so P13 cannot be met: add one (P13)`];
  }
  const changed = files.map(f => f.path);
  const missing = requiredChangelogs(changed, allChangelogs, headFiles).filter(c => {
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
    if (!remoteRef || !remoteRef.startsWith('refs/heads/')) continue;
    const branch = remoteRef.slice('refs/heads/'.length);
    const deletion = /^0+$/.test(localSha);
    if (protectedBranches.includes(branch)) { errors.push(`${deletion ? 'deleting' : 'direct push to'} ${branch} is refused${deletion ? '' : ': open a PR'} (P8)`); continue; }
    if (deletion) continue;
    if (branch.startsWith('release/')) continue;
    errors.push(...checkBranchName(branch, env));
  }
  return errors;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// Every CHANGELOG.md tracked in the repository, plus every one on the base: deleting a service's changelog does not
// drop its P13 requirement.
function listChangelogs(base) {
  // ':/' anchors the pattern at the repository root, so a run from a subdirectory sees the same paths as the diff.
  const here = git(['ls-files', '--full-name', '--', ':/*CHANGELOG.md']).split('\n');
  const onBase = base ? git(['ls-tree', '-r', '--name-only', base]).split('\n').filter(f => CHANGELOG.test(f)) : [];
  return [...new Set([...here, ...onBase])].filter(f => f && !f.startsWith('templates/'));
}

// LINEAR_TEAM from the repository's .env when the environment lacks it: hooks do not load .env.
function teamFromDotenv() {
  try {
    const root = git(['rev-parse', '--show-toplevel']).trim();
    const line = fs.readFileSync(`${root}/.env`, 'utf8').split('\n').find(l => /^\s*(export\s+)?LINEAR_TEAM\s*=/.test(l));
    return line ? line.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '') : '';
  } catch { return ''; }
}

// The repository's default branch, as far as this checkout knows it. Pushes to it are refused like pushes to main.
function protectedBranches() {
  const names = new Set(['main']);
  try {
    const ref = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    names.add(ref.trim().replace(/^origin\//, ''));
  } catch { /* no origin/HEAD */ }
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
  // In CI the checkout is the PR's own: its .env must not choose the pattern that judges it.
  if (!process.env.LINEAR_TEAM && !process.env.CI) { const team = teamFromDotenv(); if (team) process.env.LINEAR_TEAM = team; }
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
      const isMerge = git(['log', '-1', '--format=%P', sha]).trim().split(/\s+/).length > 1;
      for (const e of checkCommitMessage(git(['log', '-1', '--format=%B', sha]), process.env, { isMerge })) errors.push(`${sha.slice(0, 8)}: ${e}`);
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
      ...checkChangelog(files, listChangelogs(base), git(['ls-tree', '-r', '--name-only', head]).split('\n').filter(Boolean)),
    ]);
  }
  console.error('usage: brain-git-check.js commit-msg <file> | branch [<name>] | commits --base <ref> | pr --base <ref>');
  process.exit(2);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { checkCommitMessage, checkBranchName, checkPrTitle, parseNumstat, checkSize, checkChangelog, requiredChangelogs, checkPushedRefs, ticketSource, GLOBAL_CHANGELOGS };
