#!/usr/bin/env node
'use strict';

// Checks the mechanical git-workflow-and-versioning rules so no agent has to remember them:
//   commit-msg <file>            P3, P4   message anatomy: type(scope), ticket id, Model / Thinking-effort / Harness trailers
//   branch [<name>]              P5       branch is <ticket>-<slug>
//   commits --base <ref>         P3, P4   every commit in <base>..<head> passes commit-msg
//   push [<remote> <url>]        P5, P8   stdin from git's pre-push hook: each pushed refs/heads/* branch is <ticket>-<slug>;
//                                         a push to, or deletion of, main or the remote's default branch is refused
//   pr --base <ref>              P2, P4, P11, P13   one ticket across branch/title/commits, title "<ticket>: <goal>", size, changelog
// Exit 0 when every check passes, 1 with one line per failure, 2 on bad usage.
// Environment: LINEAR_TEAM narrows the ticket pattern to the team's key (or comma-separated keys) (read from the repository's .env when unset); BRAIN_PR_MAX_LINES and BRAIN_PR_MAX_FILES
// override 400 and 10; PR_TITLE and PR_BODY supply the title and body (CI passes them without shell quoting).
// The protected branches are main plus the repository's default branch (origin/HEAD), when one is known.

const { execFileSync } = require('child_process');
const fs = require('fs');

const TYPES = 'feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert';
// git's own merge subjects: "Merge pull request #n ..." and "Merge branch ...". Anything else starting "Merge " is a commit.
const GIT_MERGE = /^Merge (pull request #\d+|branch |branches |remote-tracking branch |commit '|tag ')/;
const CHANGELOG = /(^|\/)CHANGELOG\.md$/;
const SIZE_EXCEPTION = /^Size-exception:[ \t]*\S/m;

// LINEAR_TEAM: one team key (ENG) or several separated by commas (ENG,OPS); teamError reports any other value.
function ticketSource(env = process.env) {
  if (!env.LINEAR_TEAM) return '[A-Z][A-Z0-9]*-\\d+';
  const keys = env.LINEAR_TEAM.split(',').map(k => k.trim()).filter(Boolean);
  return keys.length === 1 ? `${keys[0]}-\\d+` : `(?:${keys.join('|')})-\\d+`;
}

function teamError(env = process.env) {
  if (!env.LINEAR_TEAM) return null;
  return env.LINEAR_TEAM.split(',').every(k => /^[A-Z][A-Z0-9]*$/.test(k.trim()))
    ? null : `LINEAR_TEAM must be Linear team keys such as ENG or ENG,OPS: got "${env.LINEAR_TEAM}" (P4)`;
}

// allowFixup is for the local commit-msg hook only: autosquash folds fixup!/squash! commits before a PR merges, and CI
// (which runs without it) rejects any that are left unsquashed.
// isMerge: whether the commit has more than one parent, when the caller knows (commits mode); a one-parent commit
// with a merge-like subject is then checked like any other. The commit-msg hook cannot know, so it goes by the subject.
// stripComments: only for the commit-msg hook, where git has not yet removed the editor's # lines; a stored commit
// (CI, merge verification) is checked exactly as it is.
function checkCommitMessage(raw, env = process.env, { allowFixup = false, isMerge, stripComments = true } = {}) {
  // git commit -v appends the diff below a scissors line, which git removes with everything after it.
  const lines = raw.split(/\r?\n/);
  const scissors = stripComments ? lines.indexOf('# ------------------------ >8 ------------------------') : -1;
  const message = (scissors >= 0 ? lines.slice(0, scissors) : lines).filter(l => !(stripComments && l.startsWith('#'))).join('\n').trim();
  const ticket = ticketSource(env);
  const subject = message.split('\n')[0] || '';
  // A git revert keeps the subject shape of git's own "Revert \"…\"", but still needs its ticket and trailers (P2, P3).
  // fixup!/squash! are not exempt: they must be autosquashed before the PR is merged, so the commit that lands is checked.
  const revert = /^(Revert|Reapply) ".*"$/.test(subject);
  const errors = [];
  if (revert && !new RegExp(`\\b${ticket}\\b`).test(message)) errors.push('revert commit: name the ticket id it belongs to (P2)');
  if (allowFixup && /^(fixup! |squash! |amend! )/.test(subject)) return [];
  const merge = GIT_MERGE.test(subject) && isMerge !== false;
  if (merge && !new RegExp(`\\b${ticket}\\b`).test(message)) errors.push('merge commit: put the ticket id in the message (P15)');
  if (!revert && !merge && !new RegExp(`^(${TYPES})(\\([a-z0-9._/,-]+\\))?!?: \\S.* \\[${ticket}\\]$`).test(subject)) {
    errors.push(`subject must be "<type>(<scope>): <what changed> [<TICKET-ID>]", type one of ${TYPES.split('|').join(', ')} (P2, P3): got "${subject}"`);
  }
  // Trailers are what git reads as trailers (`git interpret-trailers --parse`, %(trailers)): a final paragraph of
  // "Key: value" lines, with no prose among them. Without git, the same paragraph rule is applied strictly.
  const trailerBlock = gitTrailers(message);
  for (const trailer of ['Model', 'Thinking-effort', 'Harness']) {
    if (!new RegExp(`^${trailer}:[ \\t]*\\S`, 'm').test(trailerBlock)) errors.push(`missing trailer "${trailer}: <value>" in the message's trailer block, its last paragraph (P3)`);
  }
  return errors;
}

function gitTrailers(message) {
  try {
    return execFileSync('git', ['interpret-trailers', '--parse', '--no-divider'], { input: `${message}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    const paragraphs = message.split(/\n[ \t]*\n/);
    const last = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1] : '';
    return last.split('\n').every(l => /^[A-Za-z0-9][A-Za-z0-9-]*:[ \t]/.test(l) || /^[ \t]+\S/.test(l)) ? last : '';
  }
}

// BRAIN_LONG_LIVED: a regular expression for further long-lived branches P16 allows (e.g. staging|develop). It must
// match the whole name, so `develop` never covers `ENG-12-develop-login`. An invalid pattern counts every branch as
// long-lived (nothing is deleted) and is reported by longLivedPatternError, which each mode checks first.
function extraLongLived(name, env = process.env) {
  if (!env.BRAIN_LONG_LIVED) return false;
  try { return new RegExp(`^(?:${env.BRAIN_LONG_LIVED})$`).test(name); } catch { return true; }
}

function longLivedPatternError(env = process.env) {
  if (!env.BRAIN_LONG_LIVED) return null;
  try { new RegExp(env.BRAIN_LONG_LIVED); return null; } catch (err) { return `BRAIN_LONG_LIVED is not a valid regular expression (${err.message}) (P16)`; }
}

// The repository's default branch: DEFAULT_BRANCH (pr-rules passes it) or origin/HEAD.
function defaultBranch(env = process.env) {
  if (env.DEFAULT_BRANCH) return env.DEFAULT_BRANCH;
  try {
    return execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/^origin\//, '');
  } catch { return ''; }
}

// Long-lived branches (P16): main, the default branch, release/*, and BRAIN_LONG_LIVED; the same set merge-pr keeps.
// A head from a fork is never long-lived here: its "main" is the fork's (HEAD_REPO and REPO, passed by pr-rules, differ).
function isLongLived(name, env = process.env) {
  if (env.HEAD_REPO && env.REPO && env.HEAD_REPO !== env.REPO) return false;
  return name === 'main' || name.startsWith('release/') || extraLongLived(name, env) || (!!name && name === defaultBranch(env));
}

// A ticket branch: <ticket>-<slug>, the only kind merge-pr ever deletes.
function isTicketBranch(name, env = process.env) {
  return new RegExp(`^${ticketSource(env)}-[a-z0-9]+(-[a-z0-9]+)*$`).test(name || '');
}

function checkBranchName(name, env = process.env) {
  if (isLongLived(name, env)) return [];
  if (!isTicketBranch(name, env)) {
    return [`branch "${name}" is not <ticket>-<slug>, for example ENG-123-login-form (P5)`];
  }
  return [];
}

// One ticket per PR (P2, P4): the branch, the title, and every commit name the same ticket. A commit names its ticket
// in the subject's [TICKET] (git's merge subjects carry it in the message).
// A long-lived head (P16 promotion, e.g. release/1.0 into main) carries many tickets' merges: only its title is checked.
// A commit's own ticket: the subject's trailing [TICKET]; for git's "Merge ... into <branch>", that branch's ticket; for
// a revert, the ticket named outside the quoted subject of the commit it reverts; otherwise the first in the message.
function commitTicket(msg, id) {
  const subject = msg.split('\n')[0] || '';
  const bracket = /\[([^\]]+)\]\s*$/.exec(subject);
  if (bracket && id.test(bracket[1])) return bracket[1];
  const into = /^Merge .* into (\S+)/.exec(subject);
  if (into && id.test(into[1])) return id.exec(into[1])[1];
  // An explicit [TICKET] wins over a ticket-shaped token in prose (UTF-8, SHA-256 under the generic pattern).
  const explicit = text => { const b = new RegExp(`\\[(${id.source.replace(/^\\b\(|\)\\b$/g, '')})\\]`).exec(text); return b ? b[1] : ''; };
  if (/^(Revert|Reapply) ".*"/.test(subject)) {
    const own = msg.replace(/^(Revert|Reapply) ".*"/, '');
    if (explicit(own)) return explicit(own);
    if (id.test(own)) return id.exec(own)[1];
  }
  if (explicit(msg)) return explicit(msg);
  const any = id.exec(msg);
  return any ? any[1] : '';
}

// promotion, when given, says whether the head is a long-lived promotion (merge-pr knows it from the PR itself).
function checkOneTicket({ branch, title, messages, promotion }, env = process.env) {
  const id = new RegExp(`\\b(${ticketSource(env)})\\b`);
  const named = new Map();
  const add = (where, ticket) => { if (ticket) (named.get(ticket) || named.set(ticket, []).get(ticket)).push(where); };
  const longLivedHead = promotion !== undefined ? promotion : branch && isLongLived(branch, env);
  if (branch && !longLivedHead) add('branch', (id.exec(branch) || [])[1]);
  add('title', (id.exec(title || '') || [])[1]);
  if (!longLivedHead) for (const [i, msg] of (messages || []).entries()) add(`commit ${i + 1}`, commitTicket(msg, id));
  if (named.size <= 1) return [];
  return [`one ticket per PR: ${[...named].map(([t, w]) => `${t} (${w.join(', ')})`).join(' vs ')} (P2, P4)`];
}

function checkPrTitle(title, env = process.env) {
  if (!new RegExp(`^${ticketSource(env)}: \\S`).test(title || '')) {
    return [`PR title must be "<ticket>: <goal>": got "${title || ''}" (P2, P4)`];
  }
  return [];
}

// numstat is the output of `git diff --numstat`: "<added>\t<deleted>\t<path>", binary files as "-\t-\t<path>".
// `git diff -z --numstat` output (NUL-separated, paths unquoted; newline-separated is accepted for tests).
function parseNumstat(numstat) {
  return numstat.split(numstat.includes('\0') ? '\0' : '\n').filter(Boolean).map(line => {
    const [added, deleted, ...rest] = line.split('\t');
    return { path: rest.join('\t'), added: Number(added) || 0, lines: (Number(added) || 0) + (Number(deleted) || 0) };
  });
}

// `git diff -z --numstat -M`: a rename is "added\tdeleted\t\0old\0new\0"; it counts once, under its new path.
function parseNumstatRenames(numstat) {
  const parts = numstat.split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    const [added, deleted, path] = parts[i].split('\t');
    const name = path === '' ? parts[(i += 2)] : path;
    const from = path === '' ? parts[i - 1] : path;
    out.push({ path: name, from, binary: added === '-', added: Number(added) || 0, lines: (Number(added) || 0) + (Number(deleted) || 0) });
  }
  return out;
}

// A blob's content without NUL bytes when the rest is UTF-8 text; '' for a blob that does not exist; null for a real
// binary.
// A UTF-16 file with a byte-order mark is decoded as UTF-16; anything else has its NULs removed and must be UTF-8.
function nulText(spec) {
  let buf;
  try { buf = execFileSync('git', ['cat-file', 'blob', spec], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 30 }); } catch { return ''; }
  const bom = buf[0] === 0xff && buf[1] === 0xfe ? 'utf-16le' : buf[0] === 0xfe && buf[1] === 0xff ? 'utf-16be' : null;
  try { return bom ? new TextDecoder(bom, { fatal: true }).decode(buf) : new TextDecoder('utf-8', { fatal: true }).decode(buf.filter(b => b !== 0)); } catch { return null; }
}

// Changed lines between two blobs git calls binary, diffed as text with the NULs removed; 0 when either is a real
// binary.
function nulTextLines(before, after) {
  const a = nulText(before);
  const b = nulText(after);
  if (a === null || b === null) return 0;
  const dir = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'brain-p11-'));
  try {
    fs.writeFileSync(`${dir}/a`, a);
    fs.writeFileSync(`${dir}/b`, b);
    const r = require('child_process').spawnSync('git', ['diff', '--no-index', '--numstat', '--', `${dir}/a`, `${dir}/b`], { encoding: 'utf8' });
    const [added, deleted] = (r.stdout || '').split('\t');
    return (Number(added) || 0) + (Number(deleted) || 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function currentBranch() {
  try { const b = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(); return b === 'HEAD' ? undefined : b; } catch { return undefined; }
}

// Every path in a tree, unquoted (git quotes non-ASCII names without -z).
function treeFiles(ref) {
  return git(['ls-tree', '-r', '-z', '--full-tree', '--name-only', ref]).split('\0').filter(Boolean);
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
  // The global changelog that survives at the head; the base's one if the PR deleted it.
  const global = (headFiles && GLOBAL_CHANGELOGS.find(c => headFiles.includes(c))) || GLOBAL_CHANGELOGS.find(c => allChangelogs.includes(c));
  if (global) required.add(global);
  for (const p of changedPaths) {
    if (p.startsWith('templates/')) continue;
    if (CHANGELOG.test(p)) {
      // A service changelog the PR touches is a change to that service: it needs an added line, and one the PR deletes
      // while its service stays is still required (and so fails). Only a service removed with it is exempt.
      const dir = p.split('/').slice(0, -1).join('/');
      if (dir && !GLOBAL_CHANGELOGS.includes(p) && (!headFiles || headFiles.includes(p) || headFiles.some(f => f.startsWith(`${dir}/`)))) required.add(p);
      continue;
    }
    const dir = p.split('/').slice(0, -1);
    // The nearest service changelog above the file: <service>/CHANGELOG.md or <service>/docs/CHANGELOG.md.
    service: while (dir.length) {
      for (const candidate of [[...dir, 'CHANGELOG.md'].join('/'), [...dir, 'docs', 'CHANGELOG.md'].join('/')]) {
        // A global location (docs/CHANGELOG.md) is never a service changelog: the global requirement covers it, even
        // after the PR moves the global changelog to the other location.
        if (GLOBAL_CHANGELOGS.includes(candidate)) break service;
        if (allChangelogs.includes(candidate)) {
          const serviceDir = `${dir.join('/')}/`;
          if (!headFiles || headFiles.some(f => f.startsWith(serviceDir))) required.add(candidate);
          break service;
        }
      }
      dir.pop();
    }
  }
  return [...required];
}

// renamed: the same diff with renames detected; a changelog moved unchanged gains no line there, so it is the one that
// says whether a line was added (the rename-free list still decides which changelogs are required).
function checkChangelog(files, allChangelogs = ['CHANGELOG.md'], headFiles, renamed = files) {
  // P13 needs a global changelog. A service changelog does not stand in for it, and a repository with none cannot pass.
  if (!GLOBAL_CHANGELOGS.some(c => allChangelogs.includes(c))) {
    return [`no global changelog (${GLOBAL_CHANGELOGS.join(' or ')}) in this repository, so P13 cannot be met: add one (P13)`];
  }
  const changed = files.map(f => f.path);
  const missing = requiredChangelogs(changed, allChangelogs, headFiles).filter(c => {
    const entry = renamed.find(f => f.path === c);
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
    // A long-lived branch (release/*, BRAIN_LONG_LIVED) is never deleted by a push either (P16).
    if (deletion && isLongLived(branch, env)) { errors.push(`deleting the long-lived branch ${branch} is refused (P16)`); continue; }
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
function listChangelogs(base, head = 'HEAD') {
  // From the trees compared, never the checkout: `pr --head <ref>` must not depend on what is checked out.
  const here = treeFiles(head).filter(f => CHANGELOG.test(f));
  const onBase = base ? treeFiles(base).filter(f => CHANGELOG.test(f)) : [];
  return [...new Set([...here, ...onBase])].filter(f => f && !f.startsWith('templates/'));
}

// A key from the repository's .env (LINEAR_TEAM, BRAIN_LONG_LIVED) when the environment lacks it: hooks do not load
// .env. Never in CI, where the checkout is the PR's own.
// The key from this worktree's .env, else from the main checkout's: .env is untracked, so a ticket worktree (P6) may
// have none, or one without this key.
// skipEmpty: an empty value (LINEAR_TEAM= as .env.example ships it) does not count as defined.
function dotenvValue(key, { skipEmpty = false } = {}) {
  try {
    const here = git(['rev-parse', '--show-toplevel']).trim();
    // The main checkout is the first worktree git lists; a bare repository has none, so only this worktree counts.
    const first = git(['worktree', 'list', '--porcelain']).split('\n\n')[0];
    const main = /^bare$/m.test(first) ? null : (/^worktree (.+)$/m.exec(first) || [])[1];
    const pattern = new RegExp(`^\\s*(export\\s+)?${key}\\s*=`);
    // A quoted value is taken as written; an unquoted one ends at an inline " #" comment. Emptiness is judged on the
    // parsed value, so LINEAR_TEAM="" is as unset as LINEAR_TEAM=.
    const parse = l => {
      const value = l.split('=').slice(1).join('=').trim();
      const quoted = /^(['"])(.*?)\1/.exec(value);
      return quoted ? quoted[2] : value.replace(/(^|\s+)#.*$/, '').trim();
    };
    for (const file of [`${here}/.env`, ...(main ? [`${main}/.env`] : [])]) {
      if (!fs.existsSync(file)) continue;
      const line = fs.readFileSync(file, 'utf8').split('\n').find(l => pattern.test(l) && !(skipEmpty && parse(l) === ''));
      if (line) return parse(line);
    }
    return null;
  } catch { return null; }
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
  loadDotenv();
  const [cmd, ...rest] = argv;
  if (teamError()) return report([teamError()]);
  if (cmd !== 'commit-msg' && longLivedPatternError()) return report([longLivedPatternError()]);
  // In CI the ticket pattern must be the team's: the generic one also matches tokens such as UTF-8 or SHA-256.
  if (process.env.CI && !process.env.LINEAR_TEAM && ['commits', 'pr', 'branch'].includes(cmd)) {
    console.error('brain-git-check: LINEAR_TEAM is not set; set it as a repository variable for pr-rules.yml (P4)');
    process.exit(1);
  }
  if (cmd === 'commit-msg') {
    if (!rest[0] || !fs.existsSync(rest[0])) { console.error('usage: commit-msg <message-file>'); process.exit(2); }
    // A merge commit is being made when MERGE_HEAD exists. Amending one leaves no MERGE_HEAD: the message then keeps
    // HEAD's own merge subject, so a message whose subject is HEAD's while HEAD is a merge is that amend. Anything
    // else that merely reads "Merge branch …" is an ordinary commit. CI, which knows the parents, has the last word.
    const raw = fs.readFileSync(rest[0], 'utf8');
    let isMerge = false;
    try {
      if (fs.existsSync(git(['rev-parse', '--git-path', 'MERGE_HEAD']).trim())) isMerge = true;
      else if (execFileSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(' ').length > 2) {
        const subject = raw.split(/\r?\n/).find(l => !l.startsWith('#') && l.trim()) || '';
        if (subject.trim() === git(['log', '-1', '--format=%s', 'HEAD']).trim()) isMerge = true;
      }
    } catch { /* outside a repository, or no commit yet */ }
    return report(checkCommitMessage(raw, process.env, { allowFixup: true, isMerge }));
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
      for (const e of checkCommitMessage(git(['log', '-1', '--format=%B', sha]), process.env, { isMerge, stripComments: false })) errors.push(`${sha.slice(0, 8)}: ${e}`);
    }
    return report(errors);
  }
  if (cmd === 'push') {
    // git passes the remote's name and URL to pre-push: protect that remote's own default branch, which a clone may
    // not know (no origin/HEAD after `git remote add`). If it cannot be read, refuse rather than guess.
    const protect = protectedBranches();
    const url = rest[1] || rest[0];
    if (url) {
      let out;
      try { out = execFileSync('git', ['ls-remote', '--symref', url, 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch {
        return report([`could not read the default branch of ${url}; push again when the remote is reachable (P8)`]);
      }
      const m = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(out);
      if (m) protect.push(m[1]);
    }
    return report(checkPushedRefs(fs.readFileSync(0, 'utf8'), process.env, protect));
  }
  if (cmd === 'pr') {
    const base = optionValue(rest, '--base');
    if (!base) { console.error('usage: pr --base <ref> [--head <ref>] [--title <t>] [--branch <name>]'); process.exit(2); }
    const head = optionValue(rest, '--head') || 'HEAD';
    // The one-ticket rule needs the PR's branch: named, given by CI, or HEAD's own; never guessed for another head.
    const prBranch = optionValue(rest, '--branch') || process.env.HEAD_REF || (head === 'HEAD' ? currentBranch() : undefined);
    if (!prBranch) { console.error('usage: pr needs the PR\'s branch: pass --branch <name> (or HEAD_REF) when checking a detached or explicit --head'); process.exit(2); }
    // Every line counts for P11, whatever any .gitattributes says (`package-lock.json -diff` has no exemption, and a PR's
    // own .gitattributes cannot hide its lines): attributes are read from the empty tree, so none apply.
    const noAttrs = git(['hash-object', '-t', 'tree', '/dev/null']).trim();
    // Without --attr-source (git before 2.41) the PR's own .gitattributes would apply: refuse rather than count wrong.
    let numstat;
    try { numstat = git(['--attr-source', noAttrs, 'diff', '--ignore-submodules=none', '-z', '--numstat', '--no-renames', '--text', `${base}...${head}`]); }
    catch (err) { return report([`git ${git(['--version']).trim().replace(/^git version /, '')} cannot count lines independently of .gitattributes (needs --attr-source, git 2.41 or later): ${String(err.stderr || err.message).trim().split('\n')[0]}`]); }
    const files = parseNumstat(numstat);
    // P11 counts a rename as one file with its own line changes; P13 keeps the rename-free list above.
    const sized = parseNumstatRenames(git(['--attr-source', noAttrs, 'diff', '--ignore-submodules=none', '-z', '--numstat', '-M', '--text', `${base}...${head}`]));
    // git reports a file with a NUL in its first 8000 bytes as binary, with no line counts, --text notwithstanding:
    // count such a file's lines from its blobs when it is text apart from NULs (generated or minified output). A real
    // binary (an image) is not valid UTF-8 and stays one file with no lines.
    const mergeBase = git(['merge-base', base, head]).trim();
    for (const f of sized) if (f.binary) f.lines = nulTextLines(`${mergeBase}:${f.from}`, `${head}:${f.path}`);
    const body = process.env.PR_BODY || '';
    return report([
      ...checkPrTitle(optionValue(rest, '--title') || process.env.PR_TITLE),
      ...checkOneTicket({
        branch: prBranch,
        title: optionValue(rest, '--title') || process.env.PR_TITLE,
        messages: git(['rev-list', `${base}..${head}`]).split('\n').filter(Boolean).map(sha => git(['log', '-1', '--format=%B', sha])),
      }),
      ...checkSize(sized, body),
      ...checkChangelog(files, listChangelogs(base, head), treeFiles(head), sized),
    ]);
  }
  console.error('usage: brain-git-check.js commit-msg <file> | branch [<name>] | commits --base <ref> | push [<remote> <url>] | pr --base <ref>');
  process.exit(2);
}

if (require.main === module) main(process.argv.slice(2));

// Precedence per key: the environment, then this worktree's .env, then the main checkout's .env (then, in merge-pr,
// the repository variable). The first that defines the key wins, even when empty: `BRAIN_LONG_LIVED=` means no long-lived
// branches beyond main, the default branch, release/*, and protected ones. Never in CI.
function loadDotenv(env = process.env) {
  if (env.CI) return;
  // An empty LINEAR_TEAM is unset (the generic pattern would accept any team); an empty BRAIN_LONG_LIVED means none.
  if (env.LINEAR_TEAM === '') delete env.LINEAR_TEAM;
  for (const key of ['LINEAR_TEAM', 'BRAIN_LONG_LIVED']) if (env[key] === undefined) {
    const v = dotenvValue(key, { skipEmpty: key === 'LINEAR_TEAM' });
    if (v !== null) env[key] = v;
  }
}

module.exports = { isTicketBranch, isLongLived, longLivedPatternError, teamError, checkOneTicket, loadDotenv, parseNumstatRenames, extraLongLived, checkCommitMessage, checkBranchName, checkPrTitle, parseNumstat, checkSize, checkChangelog, requiredChangelogs, checkPushedRefs, ticketSource, GLOBAL_CHANGELOGS };
