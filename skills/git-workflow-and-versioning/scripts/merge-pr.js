#!/usr/bin/env node
'use strict';

// Merges a pull request the one way the organisation allows (git-workflow-and-versioning P7, P10, P12, P15):
// a merge commit that carries the ticket id, remote and local branch deleted, only when CI is green and the
// PR is approved. Usage: merge-pr.js <pr-number> [--review-optional] [--repo owner/name]
// --review-optional is for a ticket that made review optional (P8); pass it only then.

const { execFileSync } = require('child_process');
const { ticketSource, checkPrTitle } = require('./brain-git-check');

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

// The github.com repository behind origin, as owner/name. Only github.com is inferred: ssh.github.com, and an SSH host
// alias (git@github-work:org/app.git) whose `ssh -G` HostName is github.com. Any other host, GitHub Enterprise
// included, is refused rather than guessed, so gh never acts on a same-named repository elsewhere: pass
// --repo <host>/<owner>/<name> for it (and for a fork's PR, which lives on upstream).
function originRepo() {
  // The URL as configured, before any url.*.insteadOf rewrite: that is the repository the user named.
  const url = git(['config', '--get', 'remote.origin.url']).trim();
  const host = ((url.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)/) || [])[1] || '').toLowerCase();
  const repo = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!repo || resolvedHost(host, url) !== 'github.com') {
    throw new Error(`origin (${url}) is not a github.com remote; pass --repo <host>/<owner>/<name>`);
  }
  return `${repo[1]}/${repo[2]}`;
}

function resolvedHost(host, url) {
  if (host === 'ssh.github.com') return 'github.com';
  if (host.includes('.') || /^[a-z+]+:\/\//.test(url) && !url.startsWith('ssh://')) return host;
  try {
    const out = execFileSync('ssh', ['-G', host], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const name = ((out.match(/^hostname (\S+)$/m) || [])[1] || host).toLowerCase();
    return name === 'ssh.github.com' ? 'github.com' : name;
  } catch { return host; }
}

// [host/]owner/name split into its parts; host is github.com when absent.
function splitRepo(repo) {
  const parts = repo.split('/');
  return parts.length === 3 ? { host: parts[0], owner: parts[1], name: parts[2] } : { host: 'github.com', owner: parts[0], name: parts[1] };
}

// GitHub keeps every run of a check on the head: a failed run, then a passing run after the title is fixed (an
// `edited` event) or a re-run, are both listed. A check is keyed by its workflow file, event, and name, and the newest
// run counts, so two workflows sharing a display name, or a job's push and pull_request runs, are judged apart while
// a newer run of the same workflow and event replaces an older one. main() reads path and event from the Actions API
// (runIdentity); without them the run id stands in, which can only keep a stale failure, never hide one.
// A run that has not completed is pending, and pending blocks.
function runId(c) {
  return ((c.detailsUrl || '').match(/\/actions\/runs\/(\d+)/) || [])[1] || '';
}

// A check from outside Actions (another CI app or a commit status) has no run identity at all: each one is kept,
// never collapsed with a same-named check from another provider.
function latestRuns(checks) {
  const byKey = new Map();
  for (const [i, c] of checks.entries()) {
    const producer = c.workflowPath ? `${c.workflowPath}|${c.event}` : runId(c) || (c.workflowName ? `workflow:${c.workflowName}` : `external:${i}`);
    const key = `${producer}/${c.name || c.context}`;
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

// Only reviewers with write permission count, approving or requesting changes: on a public repository anyone can
// leave a review. view.writers is the set main() verified through the collaborators permission API; without it
// (unit tests) authorAssociation stands in. Approved means every such reviewer's newest verdict (APPROVED or CHANGES_REQUESTED, on any commit) is not a change
// request, and at least one such verdict is an APPROVED given on the current head. A change request stays in force after
// a new push until its reviewer approves or dismisses it. COMMENTED reviews are replies. The branch-protection
// reviewDecision is not trusted alone: without dismissal of stale approvals it stays APPROVED after a push.
const WRITE_ACCESS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

function isApproved(view) {
  const newest = new Map();
  for (const r of view.reviews || []) {
    const login = r.author && r.author.login;
    if (!login || (view.author && login === view.author.login)) continue;
    if (view.writers ? !view.writers.has(login) : !WRITE_ACCESS.includes(r.authorAssociation)) continue;
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
  // The same title rule CI checks: "<ticket>: <goal>".
  blockers.push(...checkPrTitle(view.title, env));
  const ticket = new RegExp(`^(${ticketSource(env)}):`).exec(view.title || '');
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

// The reviewers among `logins` whose permission on the repository is write or higher. A login the API rejects (a
// bot, which gh reports without its [bot] suffix, or a deleted account) is not a writer.
function writers(repo, logins) {
  const { host, owner, name } = splitRepo(repo);
  const set = new Set();
  for (const login of logins) {
    let out;
    try { out = JSON.parse(gh(['api', '--hostname', host, `repos/${owner}/${name}/collaborators/${login}/permission`])); } catch (err) {
      // Only "no such user" makes a reviewer ineligible; an auth or service failure stops the merge.
      if (/404|not a user|Not Found/i.test(String(err.stderr || err.message))) { console.error(`merge-pr: ${login} is not a collaborator; their review does not count`); continue; }
      throw err;
    }
    if (['admin', 'maintain', 'write'].includes(out.permission) || ['admin', 'write'].includes(out.role_name)) set.add(login);
  }
  return set;
}

// Adds workflowPath and event to each Actions check, from its run (one API call per run id).
function runIdentity(repo, checks) {
  const { host, owner, name } = splitRepo(repo);
  const runs = new Map();
  for (const c of checks) {
    const id = runId(c);
    if (!id) continue;
    if (!runs.has(id)) {
      try { runs.set(id, JSON.parse(gh(['api', '--hostname', host, `repos/${owner}/${name}/actions/runs/${id}`, '--jq', '{path: .path, event: .event}']))); }
      catch { runs.set(id, null); }
    }
    const run = runs.get(id);
    if (run && run.path) Object.assign(c, { workflowPath: run.path, event: run.event });
  }
  return checks;
}

// main, the default branch, and release/* are long-lived (P16): merging from them never deletes them.
function longLived(branch, defaultBranch) {
  return branch === 'main' || branch === defaultBranch || branch.startsWith('release/');
}

// Review threads still open on the PR (P10: every review comment is resolved), across every page. gh pr view does
// not report them.
function unresolvedThreads(repo, pr) {
  const { host, owner, name } = splitRepo(repo);
  const query = 'query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$endCursor){nodes{isResolved}pageInfo{hasNextPage endCursor}}}}}';
  const out = gh(['api', 'graphql', '--hostname', host, '--paginate', '--jq', '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not) | 1',
    '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${pr}`]);
  return out.split('\n').filter(Boolean).length;
}

function localTip(branch) {
  try { return git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).trim(); } catch { return ''; }
}

function main(argv) {
  const pr = argv.find(a => /^\d+$/.test(a));
  if (!pr) { console.error('usage: merge-pr.js <pr-number> [--review-optional] [--repo [host/]owner/name]'); process.exit(2); }
  const flag = argv.indexOf('--repo');
  const repo = flag === -1 ? originRepo() : argv[flag + 1];
  // Local cleanup is safe only for the repository this checkout's origin points at.
  let ownRepo = flag === -1;
  if (!ownRepo) { try { ownRepo = originRepo() === repo; } catch { ownRepo = false; } }
  if (!repo || !/^([^/]+\/)?[^/]+\/[^/]+$/.test(repo)) { console.error('merge-pr: --repo takes [host/]owner/name'); process.exit(2); }
  const view = JSON.parse(gh(['pr', 'view', pr, '--repo', repo, '--json', 'title,headRefName,headRefOid,baseRefName,reviewDecision,reviews,author,statusCheckRollup,state,isCrossRepository']));
  view.unresolvedThreads = unresolvedThreads(repo, pr);
  runIdentity(repo, view.statusCheckRollup || []);
  const defaultBranch = gh(['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']).trim();
  const keep = longLived(view.headRefName, defaultBranch);
  const reviewers = new Set((view.reviews || []).filter(r => ['APPROVED', 'CHANGES_REQUESTED'].includes(r.state)).map(r => r.author && r.author.login).filter(Boolean));
  view.writers = writers(repo, [...reviewers]);
  const { blockers, ticket } = mergeBlockers(view, { reviewOptional: argv.includes('--review-optional') });
  if (blockers.length) {
    for (const b of blockers) console.error(`merge-pr: ${b}`);
    process.exit(1);
  }
  // Merge only the head that was inspected: a push after the view fails the merge instead of merging unchecked code.
  // A repository with a merge queue refuses --delete-branch; merge-pr does not support merge queues.
  let remoteDeleted = !view.isCrossRepository && !keep;
  try {
    gh(['pr', 'merge', pr, '--repo', repo, '--merge', ...(keep ? [] : ['--delete-branch']), '--match-head-commit', view.headRefOid, '--subject', `Merge pull request #${pr} [${ticket}]`]);
  } catch (err) {
    // gh can fail after the merge itself, for example when deleting the remote branch: go on only if the PR merged.
    const state = JSON.parse(gh(['pr', 'view', pr, '--repo', repo, '--json', 'state'])).state;
    if (state !== 'MERGED') { console.error(`merge-pr: gh pr merge failed: ${String(err.stderr || err.message).trim()}`); process.exit(1); }
    console.error(`merge-pr: merged, but gh reported: ${String(err.stderr || err.message).trim()}; check the remote branch (P7)`);
    remoteDeleted = false;
    process.exitCode = 1;
  }
  // gh deletes the head branch only when it lives in the repository merged into; a fork's branch stays and P7 is not complete.
  if (view.isCrossRepository) {
    console.error(`merge-pr: branch ${view.headRefName} lives in the fork and was not deleted; delete it in the fork (P7)`);
    process.exitCode = 1;
  }
  // The local branch is deleted once the fetched base contains its tip; `git branch -d` would compare against the
  // local HEAD, which does not have the merge yet. Unpushed work, or a branch checked out in another worktree (P6),
  // is reported, not hidden.
  // A same-named local branch is this PR's only when it points at the merged head and the PR is not from a fork:
  // a fork's head named main must not delete this checkout's main.
  if (keep) {
    console.log(`merged #${pr} with a merge commit; ${view.headRefName} is long-lived and stays (P7 does not apply)`);
    return;
  }
  const local = localTip(view.headRefName);
  if (local && (!ownRepo || view.isCrossRepository || local !== view.headRefOid)) {
    console.error(`merge-pr: local branch ${view.headRefName} is not the merged head ${view.headRefOid.slice(0, 8)}; left alone (P7: delete it by hand if it is this PR's)`);
    process.exitCode = 1;
  } else if (local) {
    try {
      git(['fetch', '--quiet', 'origin', view.baseRefName]);
      git(['merge-base', '--is-ancestor', local, `origin/${view.baseRefName}`]);
    } catch {
      console.error(`merge-pr: local branch ${view.headRefName} has commits that are not on origin/${view.baseRefName}; not deleted, P7 is not complete`);
      process.exitCode = 1;
      return;
    }
    // Delete exactly the verified commit: update-ref refuses if the branch moved since it was read, so work committed
    // meanwhile survives. A branch checked out in a worktree (P6) is left to that worktree.
    const checkedOut = git(['worktree', 'list', '--porcelain']).split('\n').includes(`branch refs/heads/${view.headRefName}`);
    try {
      if (checkedOut) throw new Error('it is checked out in a worktree');
      git(['update-ref', '-d', `refs/heads/${view.headRefName}`, local]);
    } catch (err) {
      console.error(`merge-pr: local branch ${view.headRefName} not deleted (${String(err.stderr || err.message).trim()}); P7 is not complete: delete it from the worktree that holds it`);
      process.exitCode = 1;
    }
  }
  console.log(`merged #${pr} with a merge commit${remoteDeleted ? `; branch ${view.headRefName} deleted on the remote` : ''}`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { mergeBlockers, originRepo, splitRepo, latestRuns, isApproved, isPending, longLived };
