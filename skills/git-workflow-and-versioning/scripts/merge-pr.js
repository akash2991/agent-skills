#!/usr/bin/env node
'use strict';

// Merges a pull request the one way the organisation allows (git-workflow-and-versioning P7, P8, P10, P12, P15, P17):
// a merge commit that carries the ticket id, remote and local branch deleted, only when the PR is ready (not a draft),
// its blast radius is graded, CI is green, no reviewer's change request is outstanding, and, when its blast radius is
// high or the ticket asks for review, a reviewer approved the head.
// Usage: merge-pr.js <pr-number> [--require-review] [--repo owner/name]
// --require-review is for a ticket that asks for review on a low or medium PR (P8); a high PR always needs it.
// A human approval the ticket asks for is not checked here: it is recorded on the ticket before anyone runs this.

const { execFileSync } = require('child_process');
const { ticketSource, parseBlastRadius, headerFields } = require('./brain-git-check');

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

// owner/name of the GitHub repository behind origin. Works for SSH host aliases (git@github-work:org/app.git) and
// ssh:// URLs; a host that is not GitHub is refused, and --repo overrides it (a fork's PR lives on upstream).
function originRepo() {
  const url = git(['remote', 'get-url', 'origin']).trim();
  const host = (url.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)/) || [])[1] || '';
  const repo = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!repo || !/github/i.test(host)) throw new Error(`origin is not a GitHub remote (${url}); pass --repo <owner/name>`);
  return `${repo[1]}/${repo[2]}`;
}

function isPending(c) {
  return (c.status && c.status !== 'COMPLETED') || ['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS'].includes(c.state);
}

const ROLES = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const NATIVE = Symbol('native review');
// Without a header verdict, any of these anywhere in the body is read as a change request: it can block, never approve.
// "Verdict" as a word (a heading needs no colon), and requested changes even across Markdown emphasis.
// Underscores count as separators and emphasis too: REQUEST_CHANGES, CHANGES_REQUESTED, __Verdict__.
const VERDICT_LIKE = /(?<![A-Za-z])verdict(?![A-Za-z])|request(?:ed)?[\W_]*changes|changes[\W_]*requested/i;

// A comment review's verdict lives in its opening block of "Key: value" lines (headerFields): one "Reviewer:" naming the
// review assignment, e.g. "FAC-12 review (code-reviewer)", and one "Verdict:". Prose follows after a blank line and is
// commentary only. A header "Verdict: APPROVE" (any case) with exactly one real reviewer name approves; "comment only" is
// a reply; anything else (another value, two verdicts, the unfilled template, an APPROVE without exactly one real
// reviewer name) is a malformed verdict and requests changes, with a note saying why. With no header verdict, a body that
// mentions a verdict or requested changes anywhere requests changes; anything else is a reply. A malformed or unnamed
// verdict is repaired only by the agent that posted it, keeping its verdict (P17).
function parseVerdict(body) {
  const fields = headerFields(body) || [];
  const verdicts = fields.filter(f => f.key === 'verdict');
  const reviewers = fields.filter(f => f.key === 'reviewer');
  // An unfilled template name ("[your assignment name …]" or "<…>") is no name.
  const name = reviewers.length === 1 ? reviewers[0].value.replace(/[`*]/g, '').trim() : '';
  const reviewer = name && !/^[[<].*[\]>]$/.test(name) ? name : null;
  if (verdicts.length === 1) {
    const value = verdicts[0].value.replace(/[`*]/g, '').trim();
    if (/^comment( only)?$/i.test(value)) return null;
    if (/^request[ _-]*changes$/i.test(value)) return { state: 'CHANGES_REQUESTED', reviewer, note: reviewer ? undefined : 'REQUEST CHANGES without a Reviewer: name, so no later approval can clear it' };
    if (/^approve$/i.test(value) && reviewer) return { state: 'APPROVED', reviewer };
    const note = /^approve$/i.test(value) ? 'APPROVE without exactly one real Reviewer: name' : `Verdict "${value}" is not APPROVE or REQUEST CHANGES`;
    return { state: 'CHANGES_REQUESTED', reviewer, note };
  }
  if (verdicts.length > 1) return { state: 'CHANGES_REQUESTED', reviewer, note: 'more than one Verdict: line' };
  if (VERDICT_LIKE.test(body || '')) return { state: 'CHANGES_REQUESTED', reviewer, note: 'a verdict or change request outside the opening Reviewer:/Verdict: lines' };
  return null;
}

// Every reviewer's newest verdict. A GitHub APPROVED or CHANGES_REQUESTED counts from anyone with a role in the repository
// but the author. GitHub refuses an approval from the PR's own account, so agents that share it post their verdict as a
// comment review with the verdict and reviewer lines; each named reviewer is tracked on its own, and a replacement
// reviewer takes over an assignment by using the same name. A comment change request without a reviewer name stays in
// force until its body is edited to name the reviewer. On an account that is
// not the author's, one reviewer may switch between a native review and a named comment verdict: when that account has
// exactly one reviewer on record and one side is native, the new verdict replaces it; with several named reviewers on
// the account a native review clears none of them. The script cannot tell a reviewer agent from the authoring agent on a
// shared account: P17 forbids the author's verdict, and main() reports which review passed the gate. A change request
// stays in force, across pushes and format switches, until the same reviewer approves the current head: an approval of
// another commit (or of no known commit) never clears it.
function reviewState(view) {
  const byLogin = new Map();
  for (const r of view.reviews || []) {
    const login = r.author && r.author.login;
    if (!login || !ROLES.includes(r.authorAssociation)) continue;
    const own = Boolean(view.author && login === view.author.login);
    let state;
    let reviewer = null;
    let key;
    let note;
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED') {
      if (own) continue;
      state = r.state;
      key = NATIVE;
    } else if (r.state === 'COMMENTED') {
      const verdict = parseVerdict(r.body);
      if (!verdict) continue;
      ({ state, reviewer } = verdict);
      ({ note } = verdict);
      key = reviewer || `unnamed:${r.id || byLogin.size}`;
    } else continue;
    const entries = byLogin.get(login) || new Map();
    byLogin.set(login, entries);
    const [only] = entries.size === 1 ? [...entries.keys()] : [];
    const named = k => typeof k === 'string' && !k.startsWith('unnamed:');
    const switching = !own && only !== undefined && only !== key && (only === NATIVE ? named(key) : key === NATIVE && named(only));
    const prior = entries.get(key) || (switching ? entries.get(only) : undefined);
    const oid = r.commit && r.commit.oid;
    if (prior && prior.state === 'CHANGES_REQUESTED' && state === 'APPROVED' && (!oid || oid !== view.headRefOid)) continue;
    if (switching) entries.delete(only);
    entries.set(key, { state, login, reviewer, own, native: key === NATIVE, note: key === NATIVE ? undefined : note, id: r.id, oid });
  }
  const verdicts = [...byLogin.values()].flatMap(e => [...e.values()]);
  return {
    blocking: verdicts.filter(v => v.state === 'CHANGES_REQUESTED'),
    approvals: verdicts.filter(v => v.state === 'APPROVED' && v.oid === view.headRefOid),
  };
}

function isApproved(view) {
  const { blocking, approvals } = reviewState(view);
  return !blocking.length && approvals.length > 0;
}

function describe(v) {
  const who = v.reviewer ? `${v.reviewer} (${v.login})` : v.native ? `${v.login} (GitHub review ${v.id || 'without id'})` : `${v.login} in unnamed review ${v.id || 'without id'}`;
  return v.note ? `${who}: ${v.note}; only the agent that posted it repairs its opening Reviewer: and Verdict: lines, keeping its verdict; the author never edits another agent's review (P17, github)` : who;
}

// view is the parsed `gh pr view --json title,body,isDraft,headRefName,headRefOid,reviews,author,statusCheckRollup,state` output.
// An empty check rollup is not green: Actions may not have registered its checks yet.
function mergeBlockers(view, { requireReview = false } = {}, env = process.env) {
  const blockers = [];
  if (view.state !== 'OPEN') blockers.push(`PR is ${view.state}, not OPEN`);
  if (view.isDraft) blockers.push('PR is a draft; mark it ready for review (P11)');
  const { level: radius, error } = parseBlastRadius(view.body);
  if (error) blockers.push(`${error}; if pr-rules already failed on this head, push a new commit after fixing the body`);
  const ticket = new RegExp(`^(${ticketSource(env)})(:|\\s)`).exec(view.title || '');
  if (!ticket) blockers.push('PR title does not start with the ticket id (P10)');
  // Every run on the head counts. A failed run blocks the merge until a new commit replaces the head: a re-run of the
  // same commit that now passes does not clear it. A run still in progress blocks too.
  const checks = view.statusCheckRollup || [];
  if (!checks.length) blockers.push('no CI checks have reported on this head; wait for them (P12)');
  const pending = checks.filter(isPending);
  if (pending.length) blockers.push(`CI is still running: ${pending.map(c => c.name || c.context).join(', ')} (P12)`);
  const failing = checks.filter(c => !isPending(c) && !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion || c.state));
  if (failing.length) blockers.push(`CI is not green: ${failing.map(c => c.name || c.context).join(', ')} (P12)`);
  // An outstanding change request blocks at every grade; an approval is required only for high or a requested review.
  const { blocking, approvals } = reviewState(view);
  if (blocking.length) blockers.push(`changes requested by ${blocking.map(describe).join(', ')}; the same reviewer approves the head before merge (P10)`);
  else if ((radius === 'high' || requireReview) && !approvals.length) {
    blockers.push(`review required (${radius === 'high' ? 'blast radius high' : '--require-review'}): no reviewer verdict approves this head (P8, P17)`);
  }
  return { blockers, ticket: ticket && ticket[1], radius, approvals };
}

// A mistyped flag must not drop a requested review: anything but one PR number, --require-review, and --repo <owner/name> is refused.
function argvProblem(argv) {
  const rest = [...argv];
  const repo = rest.indexOf('--repo');
  if (repo !== -1) rest.splice(repo, 2);
  const unknown = rest.filter(a => a !== '--require-review' && !/^\d+$/.test(a));
  if (unknown.length) return `unknown argument${unknown.length > 1 ? 's' : ''}: ${unknown.join(' ')}`;
  if (rest.filter(a => /^\d+$/.test(a)).length !== 1) return 'give exactly one PR number';
  return null;
}

function main(argv) {
  const usage = 'usage: merge-pr.js <pr-number> [--require-review] [--repo owner/name]';
  if (argv.includes('--review-optional')) { console.error('merge-pr: --review-optional is gone; review follows the PR\'s blast radius (P17)'); process.exit(2); }
  const problem = argvProblem(argv);
  if (problem) { console.error(`merge-pr: ${problem}\n${usage}`); process.exit(2); }
  const pr = argv.find(a => /^\d+$/.test(a));
  const flag = argv.indexOf('--repo');
  const repo = flag === -1 ? originRepo() : argv[flag + 1];
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) { console.error('merge-pr: --repo takes owner/name'); process.exit(2); }
  const view = JSON.parse(gh(['pr', 'view', pr, '--repo', repo, '--json', 'title,body,isDraft,headRefName,headRefOid,reviews,author,statusCheckRollup,state,isCrossRepository']));
  const { blockers, ticket, approvals, radius } = mergeBlockers(view, { requireReview: argv.includes('--require-review') });
  if (blockers.length) {
    for (const b of blockers) console.error(`merge-pr: ${b}`);
    process.exit(1);
  }
  // The audit trail: which review passed the gate, and a warning when it came from the author's own account.
  console.log(`merge-pr: blast radius ${radius}${approvals.length ? '' : ', no review required or given (P17)'}`);
  for (const a of approvals) {
    console.log(`merge-pr: approved by ${describe(a)} in review ${a.id || '(no id)'} on ${a.oid}`);
    if (a.own) console.error(`merge-pr: warning: that approval came from the author's account ${a.login}; the reviewer's independence is not authenticated (P17)`);
  }
  // The remote is resolved before the merge: if none points at this repository, nothing is merged and nothing is deleted.
  // Long-lived branches and fork branches are never deleted here, so they need no remote.
  const longLivedHead = view.headRefName === 'main' || view.headRefName.startsWith('release/');
  let remote = null;
  if (!view.isCrossRepository && !longLivedHead) {
    try { remote = remoteFor(repo); } catch (err) { console.error(`merge-pr: ${err.message}`); process.exit(1); }
  }
  // Merge only the head that was inspected: a push after the view fails the merge instead of merging unchecked code.
  // No --delete-branch: a merge queue refuses that flag. The merge is pinned to the inspected head; the remote branch is
  // removed afterwards, once GitHub reports the PR merged, and only for a non-fork branch on the remote that fetches and pushes this repository.
  gh(['pr', 'merge', pr, '--repo', repo, '--merge', '--match-head-commit', view.headRefOid, '--subject', `Merge pull request #${pr} [${ticket}]`]);
  const after = JSON.parse(gh(['pr', 'view', pr, '--repo', repo, '--json', 'state']));
  // 2: a merge queue only enqueues. Nothing is deleted until GitHub reports the PR merged.
  if (after.state !== 'MERGED') {
    console.error(`merge-pr: PR #${pr} is ${after.state}, not MERGED: it was queued or not merged. Nothing was deleted; check the queue, then run this again.`);
    process.exitCode = 1;
    return;
  }
  // Long-lived branches are never deleted: main, the default branch, and release/* (P16).
  if (!view.isCrossRepository && !longLivedHead) {
    let outcome;
    try { outcome = deleteRemoteBranch(view.headRefName, view.headRefOid, remote); } catch (err) {
      console.error(`merge-pr: ${err.message}; P7 is not complete: delete ${view.headRefName} on the remote by hand`);
      process.exitCode = 1;
      return;
    }
    if (outcome === 'kept') {
      console.error(`merge-pr: ${view.headRefName} moved after the merge; it is kept`);
      process.exitCode = 1;
      return;
    }
  }
  // gh deletes the head branch only when it lives in the repository merged into; a fork's branch stays and P7 is not complete.
  if (view.isCrossRepository) {
    console.error(`merge-pr: branch ${view.headRefName} lives in the fork and was not deleted; delete it in the fork (P7)`);
    process.exitCode = 1;
  }
  // The local branch may be checked out in the agent's worktree (P6), whose teardown deletes it, or hold unpushed work:
  // report it, do not hide it.
  if (!longLivedHead) {
    try { git(['branch', '-d', view.headRefName]); } catch (err) {
      const text = String(err.stderr || err.message);
      const outcome = localBranchOutcome(text);
      const holder = outcome === 'worktree' ? pendingTeardown(view.headRefName, process.cwd(), view.headRefOid) : null;
      if (holder) {
        console.log(`merge-pr: local branch ${view.headRefName} is pending the teardown of ${holder} (development-setup DS11), which deletes it`);
      } else if (outcome !== 'gone') {
        console.error(`merge-pr: local branch ${view.headRefName} not deleted (${text.trim()}); P7 is not complete: delete it by hand`);
        process.exitCode = 1;
      }
    }
  }
  console.log(`merged #${pr} with a merge commit; branch ${view.headRefName} ${view.isCrossRepository ? 'lives in the fork' : 'removed on the remote'}`);
}

if (require.main === module) main(process.argv.slice(2));

// The remote whose fetch and push URLs both name the repository merged into (a remote can fetch from one repository
// and push to another). Compared case-insensitively, on github.com only (an SSH alias or GitHub Enterprise host is
// refused). Refuses when none does, so a branch is never deleted from the wrong repository.
function remoteFor(repo) {
  const want = repo.toLowerCase();
  const nameOf = url => {
    const host = (url.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)/) || [])[1] || '';
    const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
    return m && host.toLowerCase() === 'github.com' ? `${m[1]}/${m[2]}`.toLowerCase() : null;
  };
  for (const name of git(['remote']).split('\n').filter(Boolean)) {
    const fetch = nameOf(git(['remote', 'get-url', name]).trim());
    const pushes = git(['remote', 'get-url', '--push', '--all', name]).split('\n').filter(Boolean).map(nameOf);
    if (fetch === want && pushes.length && pushes.every(p => p === want)) return name;
  }
  throw new Error(`no git remote fetches and pushes ${repo}; nothing was merged: add a remote for github.com/${repo} and run this again`);
}

// Deletes the remote branch only while it is still at the commit that was merged. The lease is git's own check, so a
// push that lands between the merge and the delete makes the delete refuse. Refused on a stale lease, the branch is
// re-listed: gone (removed by GitHub meanwhile) counts as done; at another commit it is kept; otherwise it throws.
// Any other failure is thrown with git's own message. The pre-push hook is skipped: a deletion has nothing for it to check.
function deleteRemoteBranch(branch, mergedSha, remote = 'origin') {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const ref = `refs/heads/${branch}`;
  const listedSha = () => {
    const out = execFileSync('git', ['ls-remote', '--heads', remote, ref], { encoding: 'utf8', env }).trim();
    return out ? out.split(/\s/)[0] : '';
  };
  if (!listedSha()) return 'gone';
  try {
    execFileSync('git', ['push', '--no-verify', `--force-with-lease=${ref}:${mergedSha}`, remote, '--delete', ref], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    return 'deleted';
  } catch (err) {
    const text = String(err.stderr || err.message).trim();
    if (/remote ref does not exist/.test(text)) return 'gone';
    if (/stale info/.test(text)) {
      const now = listedSha();
      if (!now) return 'gone';
      if (now !== mergedSha) return 'kept';
      throw new Error(`git refused to delete ${branch} although it is at the merged commit: ${text}`);
    }
    throw new Error(`git push --delete ${branch} failed: ${text}`);
  }
}

// What a failed `git branch -d` of the merged branch means. No local branch at all (merged from another checkout) is
// already the outcome P7 asks for; a branch checked out in a worktree may be left to that worktree's teardown, when
// pendingTeardown proves it will delete it; anything else (unpushed work, an unmerged branch) leaves P7 incomplete.
function localBranchOutcome(text) {
  if (/not found|did not match any/.test(text)) return 'gone';
  if (/used by worktree at|checked out at/.test(text)) return 'worktree';
  return 'failed';
}

// The worktree whose teardown will delete this local branch, or null. Only a spawned environment qualifies: the
// local tip is part of the merged PR head (a local-only commit means P7 is open now), the ledger in the git common
// dir names the branch as one spawn created and the tip still continues the commit spawn recorded, exactly one
// worktree holds it, that worktree is the environment's, and its registration carries spawn's mark
// (development-setup agent-env.js).
function pendingTeardown(branch, cwd, mergedHead) {
  const fs = require('fs');
  const path = require('path');
  const run = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(path.join(path.resolve(cwd, run(['rev-parse', '--git-common-dir'])), 'brain-env-ledger.json'), 'utf8')); } catch { return null; }
  const holders = [];
  let current = null;
  for (const line of run(['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    if (line === `branch refs/heads/${branch}`) holders.push(current);
  }
  if (holders.length !== 1) return null;
  const entry = Object.values(ledger).find(e => e && e.branch === branch && e.branchCreated === true && e.mark);
  if (!entry || path.resolve(entry.worktree) !== path.resolve(holders[0])) return null;
  const isAncestor = (a, b) => { try { run(['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } };
  let tip;
  try { tip = run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); } catch { return null; }
  if (!mergedHead || !isAncestor(tip, mergedHead)) return null;
  if (!entry.branchTip || !isAncestor(entry.branchTip, tip)) return null;
  try {
    const admin = run(['-C', holders[0], 'rev-parse', '--absolute-git-dir']);
    return fs.readFileSync(path.join(admin, 'brain-env-mark'), 'utf8').trim() === entry.mark ? holders[0] : null;
  } catch { return null; }
}

module.exports = { pendingTeardown, argvProblem, mergeBlockers, originRepo, isApproved, reviewState, parseVerdict, isPending, deleteRemoteBranch, remoteFor, localBranchOutcome };
