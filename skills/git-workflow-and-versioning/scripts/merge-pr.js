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

// GitHub keeps every run of a check on the head: a failed run followed by a passing re-run is still listed.
// Runs are keyed by workflow and check name (two workflows may both have a job called "test"), and the newest by
// start time counts. A run that has not completed is pending, and pending blocks the merge.
function latestRuns(checks) {
  const byKey = new Map();
  for (const c of checks) {
    const key = `${c.workflowName || ''}/${c.name || c.context}`;
    // A run that has not started carries the zero time: it is newer than anything that finished.
    const raw = c.startedAt || c.createdAt || '';
    const when = !raw || raw.startsWith('0001-') ? Infinity : Date.parse(raw) || 0;
    const prev = byKey.get(key);
    if (!prev || when >= prev.when) byKey.set(key, { when, run: c });
  }
  return [...byKey.values()].map(v => v.run);
}

function isPending(c) {
  return (c.status && c.status !== 'COMPLETED') || ['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS'].includes(c.state);
}

// Approved means every reviewer's newest verdict (APPROVED or CHANGES_REQUESTED, on any commit) is not a change
// request, and at least one such verdict is an APPROVED given on the current head. A change request stays in force after
// a new push until its reviewer approves or dismisses it. COMMENTED reviews are replies. The branch-protection
// reviewDecision is not trusted alone: without dismissal of stale approvals it stays APPROVED after a push.
function isApproved(view) {
  const newest = new Map();
  for (const r of view.reviews || []) {
    const login = r.author && r.author.login;
    if (!login || (view.author && login === view.author.login)) continue;
    if (r.state !== 'APPROVED' && r.state !== 'CHANGES_REQUESTED') continue;
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
  const checks = latestRuns(view.statusCheckRollup || []);
  if (!checks.length) blockers.push('no CI checks have reported on this head; wait for them (P12)');
  const pending = checks.filter(isPending);
  if (pending.length) blockers.push(`CI is still running: ${pending.map(c => c.name || c.context).join(', ')} (P12)`);
  const failing = checks.filter(c => !isPending(c) && !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion || c.state));
  if (failing.length) blockers.push(`CI is not green: ${failing.map(c => c.name || c.context).join(', ')} (P12)`);
  if (!reviewOptional && !isApproved(view)) blockers.push(`no approval of the current head from a reviewer other than the author (review decision: ${view.reviewDecision || 'none'}) (P10)`);
  if (view.unresolvedThreads) blockers.push(`${view.unresolvedThreads} review thread(s) are unresolved (P10)`);
  return { blockers, ticket: ticket && ticket[1] };
}

// Review threads still open on the PR (P10: every review comment is resolved). gh pr view does not report them.
function unresolvedThreads(repo, pr) {
  const [owner, name] = repo.split('/');
  const query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}';
  const out = JSON.parse(gh(['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${pr}`]));
  return out.data.repository.pullRequest.reviewThreads.nodes.filter(t => !t.isResolved).length;
}

function localTip(branch) {
  try { return git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).trim(); } catch { return ''; }
}

function main(argv) {
  const pr = argv.find(a => /^\d+$/.test(a));
  if (!pr) { console.error('usage: merge-pr.js <pr-number> [--review-optional]'); process.exit(2); }
  const flag = argv.indexOf('--repo');
  const repo = flag === -1 ? originRepo() : argv[flag + 1];
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) { console.error('merge-pr: --repo takes owner/name'); process.exit(2); }
  const view = JSON.parse(gh(['pr', 'view', pr, '--repo', repo, '--json', 'title,headRefName,headRefOid,baseRefName,reviewDecision,reviews,author,statusCheckRollup,state,isCrossRepository']));
  view.unresolvedThreads = unresolvedThreads(repo, pr);
  const { blockers, ticket } = mergeBlockers(view, { reviewOptional: argv.includes('--review-optional') });
  if (blockers.length) {
    for (const b of blockers) console.error(`merge-pr: ${b}`);
    process.exit(1);
  }
  // Merge only the head that was inspected: a push after the view fails the merge instead of merging unchecked code.
  gh(['pr', 'merge', pr, '--repo', repo, '--merge', '--delete-branch', '--match-head-commit', view.headRefOid, '--subject', `Merge pull request #${pr} [${ticket}]`]);
  // gh deletes the head branch only when it lives in the repository merged into; a fork's branch stays and P7 is not complete.
  if (view.isCrossRepository) {
    console.error(`merge-pr: branch ${view.headRefName} lives in the fork and was not deleted; delete it in the fork (P7)`);
    process.exitCode = 1;
  }
  // The local branch is deleted once the fetched base contains its tip; `git branch -d` would compare against the
  // local HEAD, which does not have the merge yet. Unpushed work, or a branch checked out in another worktree (P6),
  // is reported, not hidden.
  const local = localTip(view.headRefName);
  if (local) {
    try {
      git(['fetch', '--quiet', 'origin', view.baseRefName]);
      git(['merge-base', '--is-ancestor', local, `origin/${view.baseRefName}`]);
    } catch {
      console.error(`merge-pr: local branch ${view.headRefName} has commits that are not on origin/${view.baseRefName}; not deleted, P7 is not complete`);
      process.exitCode = 1;
      return;
    }
    try { git(['branch', '-D', view.headRefName]); } catch (err) {
      console.error(`merge-pr: local branch ${view.headRefName} not deleted (${String(err.stderr || err.message).trim()}); P7 is not complete: delete it from the worktree that holds it`);
      process.exitCode = 1;
    }
  }
  console.log(`merged #${pr} with a merge commit; branch ${view.headRefName} deleted on the remote`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { mergeBlockers, originRepo, latestRuns, isApproved, isPending };
