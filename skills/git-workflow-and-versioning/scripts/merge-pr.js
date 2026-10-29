#!/usr/bin/env node
'use strict';

// Merges a pull request the one way the organisation allows (git-workflow-and-versioning P7, P10, P12, P15):
// a merge commit that carries the ticket id, remote and local branch deleted, only when CI is green and the
// PR is approved. Usage: merge-pr.js <pr-number> [--review-optional] [--repo owner/name]
// --review-optional is for a ticket that made review optional (P8); pass it only then.

const { execFileSync } = require('child_process');
const { ticketSource } = require('./brain-git-check');

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

// Approved means: branch protection says so, or every reviewer's newest verdict (APPROVED or CHANGES_REQUESTED, on any
// commit) is not a change request, and at least one such verdict is an APPROVED given on the current head. A change
// request stays in force after a new push until its reviewer approves or dismisses it. COMMENTED reviews are replies.
function isApproved(view) {
  const newest = new Map();
  for (const r of view.reviews || []) {
    const login = r.author && r.author.login;
    if (!login || (view.author && login === view.author.login)) continue;
    if (r.state !== 'APPROVED' && r.state !== 'CHANGES_REQUESTED') continue;
    // Only people with a standing role in the repository (owner, member, collaborator) can approve; any other login is not a reviewer.
    if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(r.authorAssociation)) continue;
    newest.set(login, { state: r.state, oid: r.commit && r.commit.oid });
  }
  const verdicts = [...newest.values()];
  if (verdicts.some(v => v.state === 'CHANGES_REQUESTED')) return false;
  return verdicts.some(v => v.state === 'APPROVED' && v.oid === view.headRefOid);
}

// view is the parsed `gh pr view --json title,headRefName,headRefOid,reviewDecision,reviews,author,statusCheckRollup,state` output.
// An empty check rollup is not green: Actions may not have registered its checks yet.
function mergeBlockers(view, { reviewOptional = false } = {}, env = process.env) {
  const blockers = [];
  if (view.state !== 'OPEN') blockers.push(`PR is ${view.state}, not OPEN`);
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
  if (!reviewOptional && !isApproved(view)) blockers.push('no approval of this head from a reviewer other than the author (P10)');
  return { blockers, ticket: ticket && ticket[1] };
}

function main(argv) {
  const pr = argv.find(a => /^\d+$/.test(a));
  if (!pr) { console.error('usage: merge-pr.js <pr-number> [--review-optional]'); process.exit(2); }
  const flag = argv.indexOf('--repo');
  const repo = flag === -1 ? originRepo() : argv[flag + 1];
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) { console.error('merge-pr: --repo takes owner/name'); process.exit(2); }
  const view = JSON.parse(gh(['pr', 'view', pr, '--repo', repo, '--json', 'title,headRefName,headRefOid,reviewDecision,reviews,author,statusCheckRollup,state,isCrossRepository']));
  const { blockers, ticket } = mergeBlockers(view, { reviewOptional: argv.includes('--review-optional') });
  if (blockers.length) {
    for (const b of blockers) console.error(`merge-pr: ${b}`);
    process.exit(1);
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
  // The local branch may be checked out in another worktree (P6) or hold unpushed work: report it, do not hide it.
  if (!longLivedHead) {
    try { git(['branch', '-d', view.headRefName]); } catch (err) {
      const text = String(err.stderr || err.message);
      // No local branch at all (merged from another checkout) is already the outcome P7 asks for.
      if (!/not found|did not match any/.test(text)) {
        console.error(`merge-pr: local branch ${view.headRefName} not deleted (${text.trim()}); P7 is not complete: delete it by hand from the worktree that holds it`);
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

module.exports = { mergeBlockers, originRepo, isApproved, isPending, deleteRemoteBranch, remoteFor };
