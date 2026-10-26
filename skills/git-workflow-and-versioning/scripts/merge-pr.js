#!/usr/bin/env node
'use strict';

// Merges a pull request the one way the organisation allows (git-workflow-and-versioning P3, P7, P10, P12, P15):
// a merge commit that carries the ticket id and the Model / Thinking-effort / Harness trailers, remote and local
// branch deleted, only when CI is green and the PR is approved.
// Usage: merge-pr.js <pr-number> --model <m> --effort <e> --harness <h> [--review-optional] [--repo [host/]owner/name]
// --review-optional is for a ticket that made review optional (P8); pass it only then.

const { execFileSync } = require('child_process');
const { ticketSource, checkPrTitle, extraLongLived, loadDotenv, checkCommitMessage, checkOneTicket } = require('./brain-git-check');

// Exit codes: 0 merged and cleaned up, 1 not merged (a blocker or a failed merge), 2 bad usage, 4 the merge's outcome
// could not be read (nothing deleted; run merge-pr again to verify and clean up), 3 merged but P7
// cleanup left to do (reported on stderr).
const CLEANUP_INCOMPLETE = 3;
const OUTCOME_UNKNOWN = 4;

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

function jobId(c) {
  return ((c.detailsUrl || '').match(/\/job\/(\d+)/) || [])[1] || '';
}

// The checks that decide CI, grouped by workflow file, event, and check name. Within a group only the newest workflow
// run counts (by its creation time), and within that run only its newest attempt (re-runs share the run id; each job
// carries its own attempt). Every job of that run and attempt counts, so two jobs or matrix legs that share a name are
// siblings, never one superseding the other. When attempts are unknown, every job of the newest run counts: that can
// only keep a stale failure, never hide one. A run whose jobs for this name were all SKIPPED or NEUTRAL (an `if:` that
// excluded the event) does not supersede an older run that executed. A check from outside Actions has no run identity
// and is always kept.
function latestRuns(checks) {
  const at = raw => (!raw || raw.startsWith('0001-') ? Infinity : Date.parse(raw) || 0);
  const passive = c => ['SKIPPED', 'NEUTRAL'].includes(c.conclusion);
  const groups = new Map();
  const kept = [];
  for (const [i, c] of checks.entries()) {
    const producer = c.workflowPath ? `${c.workflowPath}|${c.event}` : runId(c) ? `run:${runId(c)}` : c.workflowName ? `workflow:${c.workflowName}` : '';
    if (!producer) { kept.push(c); continue; }
    const key = `${producer}/${c.name || c.context}`;
    (groups.get(key) || groups.set(key, []).get(key)).push({ c, i });
  }
  for (const members of groups.values()) {
    const runs = new Map();
    for (const m of members) {
      const id = runId(m.c) || m.c.runCreated || `job:${m.i}`;
      const run = runs.get(id) || { created: at(m.c.runCreated || m.c.startedAt || m.c.createdAt), jobs: [] };
      run.jobs.push(m.c);
      runs.set(id, run);
    }
    const ordered = [...runs.values()].sort((a, b) => b.created - a.created);
    const latestAttempt = jobs => {
      if (!jobs.every(j => Number(j.jobAttempt))) return jobs;
      const top = Math.max(...jobs.map(j => Number(j.jobAttempt)));
      return jobs.filter(j => Number(j.jobAttempt) === top);
    };
    const executed = ordered.map(r => latestAttempt(r.jobs)).find(jobs => jobs.some(j => !passive(j)));
    kept.push(...(executed || latestAttempt(ordered[0].jobs)));
  }
  return kept;
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

// The newest APPROVED or CHANGES_REQUESTED verdict of each eligible reviewer.
function verdicts(view) {
  const newest = new Map();
  for (const r of view.reviews || []) {
    const login = r.author && r.author.login;
    if (!login || (view.author && login === view.author.login)) continue;
    if (view.writers ? !view.writers.has(login) : !WRITE_ACCESS.includes(r.authorAssociation)) continue;
    if (r.state !== 'APPROVED' && r.state !== 'CHANGES_REQUESTED') continue;
    newest.set(login, { state: r.state, oid: r.commit && r.commit.oid });
  }
  return [...newest.values()];
}

// A writer's outstanding change request blocks even when review is optional: optional means no approval is needed,
// not that a request for changes may be merged over.
function changesRequested(view) {
  return verdicts(view).some(v => v.state === 'CHANGES_REQUESTED');
}

function isApproved(view) {
  return !changesRequested(view) && verdicts(view).some(v => v.state === 'APPROVED' && v.oid === view.headRefOid);
}

// view is the parsed `gh pr view --json title,headRefName,headRefOid,reviewDecision,reviews,author,statusCheckRollup,state` output.
// An empty check rollup is not green: Actions may not have registered its checks yet.
function mergeBlockers(view, { reviewOptional = false } = {}, env = process.env) {
  const blockers = [];
  if (view.state !== 'OPEN') blockers.push(`PR is ${view.state}, not OPEN`);
  // The same title rule CI checks: "<ticket>: <goal>". The title, branch, and commits are checked again here, because a
  // pr-rules success on this head may predate a retitle (the head SHA does not change).
  blockers.push(...checkPrTitle(view.title, env));
  if (view.commits) blockers.push(...checkOneTicket({ branch: view.headRefName, title: view.title, messages: view.commits.map(c => `${c.messageHeadline}\n\n${c.messageBody || ''}`) }, env));
  const ticket = new RegExp(`^(${ticketSource(env)}):`).exec(view.title || '');
  const checks = latestRuns(view.statusCheckRollup || []);
  if (!checks.length) blockers.push('no CI checks have reported on this head; wait for them (P12)');
  // P3, P11, and P13 are checked only by the project's pr-rules workflow: its check must have run and passed; a
  // skipped or neutral pr-rules never checked anything.
  const rules = checks.filter(c => (c.name || c.context) === 'pr-rules');
  const passed = rules.filter(c => (c.conclusion || c.state) === 'SUCCESS');
  if (checks.length && !passed.length) blockers.push('no passing pr-rules check on this head: install templates/pr-rules.yml so P3, P11, and P13 are checked (P10)');
  // The head SHA does not change when the title, body, or base does: a pass that started before the last such change
  // checked other metadata (a removed Size-exception, a retitle, a new base). Wait for the run the edit triggers.
  const changed = Date.parse(view.metadataChangedAt || '') || 0;
  if (passed.length && changed && !passed.some(c => (Date.parse(c.startedAt || '') || 0) >= changed)) {
    blockers.push(`pr-rules last passed before the PR's title, body, or base changed (${view.metadataChangedAt}); wait for the run that change triggers (P10, P11)`);
  }
  const pending = checks.filter(isPending);
  if (pending.length) blockers.push(`CI is still running: ${pending.map(c => c.name || c.context).join(', ')} (P12)`);
  const failing = checks.filter(c => !isPending(c) && !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion || c.state));
  if (failing.length) blockers.push(`CI is not green: ${failing.map(c => c.name || c.context).join(', ')} (P12)`);
  if (changesRequested(view)) blockers.push('a reviewer with write access requested changes; their newest verdict still stands (P10)');
  else if (!reviewOptional && !isApproved(view)) blockers.push(`no approval of the current head from a reviewer other than the author (review decision: ${view.reviewDecision || 'none'}) (P10)`);
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
      try { runs.set(id, JSON.parse(gh(['api', '--hostname', host, `repos/${owner}/${name}/actions/runs/${id}`, '--jq', '{path: .path, event: .event, created: .created_at, attempt: .run_attempt}']))); }
      catch { runs.set(id, null); }
    }
    const run = runs.get(id);
    if (run && run.path) Object.assign(c, { workflowPath: run.path, event: run.event, runCreated: run.created });
    // Each job's own attempt: a re-run's jobs share the run id and its current attempt number.
    const job = jobId(c);
    if (job) { try { c.jobAttempt = Number(gh(['api', '--hostname', host, `repos/${owner}/${name}/actions/jobs/${job}`, '--jq', '.run_attempt']).trim()) || undefined; } catch { /* unknown */ } }
  }
  return checks;
}

// main, the default branch, and release/* are long-lived (P16): merging from them never deletes them.
// BRAIN_LONG_LIVED adds a pattern for other long-lived branches P16 allows (e.g. ^(staging|develop)$), as in brain-git-check.
function longLived(branch, defaultBranch, env = process.env) {
  return branch === 'main' || branch === defaultBranch || branch.startsWith('release/') || extraLongLived(branch, env);
}

// Review threads still open on the PR (P10: every review comment is resolved), across every page. gh pr view does
// not report them.
// When the PR's title, body, or base last changed: the newest of lastEditedAt and the title-rename and base-change events.
function metadataChangedAt(repo, pr) {
  const { host, owner, name } = splitRepo(repo);
  const query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){lastEditedAt timelineItems(last:100,itemTypes:[RENAMED_TITLE_EVENT,BASE_REF_CHANGED_EVENT]){nodes{... on RenamedTitleEvent{createdAt} ... on BaseRefChangedEvent{createdAt}}}}}}';
  const out = JSON.parse(gh(['api', 'graphql', '--hostname', host, '--jq', '.data.repository.pullRequest | [.lastEditedAt] + [.timelineItems.nodes[].createdAt] | map(select(. != null))',
    '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${pr}`]) || '[]');
  return out.sort().pop() || '';
}

function unresolvedThreads(repo, pr) {
  const { host, owner, name } = splitRepo(repo);
  const query = 'query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$endCursor){nodes{isResolved}pageInfo{hasNextPage endCursor}}}}}';
  const out = gh(['api', 'graphql', '--hostname', host, '--paginate', '--jq', '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not) | 1',
    '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${pr}`]);
  return out.split('\n').filter(Boolean).length;
}

function localTip(branch) {
  try { return git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).trim(); } catch { return ''; }
}

const USAGE = 'usage: merge-pr.js <pr-number> --model <m> --effort <e> --harness <h> [--review-optional] [--repo [host/]owner/name]';

function parseArgs(argv) {
  const opts = { reviewOptional: false };
  const valued = { '--repo': 'repo', '--model': 'model', '--effort': 'effort', '--harness': 'harness' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (/^\d+$/.test(a) && !opts.pr) opts.pr = a;
    else if (a === '--review-optional') opts.reviewOptional = true;
    else if (valued[a] && argv[i + 1] && !argv[i + 1].startsWith('--')) opts[valued[a]] = argv[++i];
    else return null; // an unknown or incomplete option is refused, never ignored
  }
  return opts.pr && opts.model && opts.effort && opts.harness ? opts : null;
}

// Whether the base branch has a merge queue: a queue takes over the merge (and its method), so merge-pr refuses.
function hasMergeQueue(repo, base) {
  const { host, owner, name } = splitRepo(repo);
  const query = 'query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){mergeQueue(branch:$branch){id}}}';
  return gh(['api', 'graphql', '--hostname', host, '--jq', '.data.repository.mergeQueue.id // empty',
    '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `branch=${base}`]).trim() !== '';
}

// What is wrong with the merge commit `oid` for head `head`: it must have two parents, one of them the inspected head
// (P15: a merge commit, not a squash or rebase), and carry the ticket and the P3 trailers. Empty when it is right.
function mergeCommitProblems(repo, oid, head) {
  if (!oid) return ['no merge commit is recorded'];
  const { host, owner, name } = splitRepo(repo);
  const c = JSON.parse(gh(['api', '--hostname', host, `repos/${owner}/${name}/commits/${oid}`, '--jq', '{parents: [.parents[].sha], message: .commit.message}']));
  const problems = [];
  if (c.parents.length !== 2 || !c.parents.includes(head)) problems.push(`${oid.slice(0, 8)} is not a merge commit of the inspected head (P15)`);
  problems.push(...checkCommitMessage(c.message, process.env, { isMerge: true }));
  return problems;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (!opts) { console.error(USAGE); process.exit(2); }
  loadDotenv();
  const { pr } = opts;
  const repo = opts.repo || originRepo();
  if (!/^([^/]+\/)?[^/]+\/[^/]+$/.test(repo)) { console.error('merge-pr: --repo takes [host/]owner/name'); process.exit(2); }
  // Branch cleanup goes through this checkout's origin, so it runs only when origin is the target repository.
  let ownRepo = !opts.repo;
  if (!ownRepo) {
    // Compare [host/]owner/name by parts, case-insensitively: github.com/o/r names the same repository as o/r.
    const same = (a, b) => ['host', 'owner', 'name'].every(k => a[k].toLowerCase() === b[k].toLowerCase());
    try { ownRepo = same(splitRepo(originRepo()), splitRepo(repo)); } catch { ownRepo = false; }
  }
  const view = JSON.parse(gh(['pr', 'view', pr, '--repo', repo, '--json', 'title,headRefName,headRefOid,baseRefName,reviewDecision,reviews,author,statusCheckRollup,state,isCrossRepository,mergeCommit,commits']));
  // Already merged (an earlier run whose outcome was unknown, or someone else): skip the gates and the merge, and go
  // on to cleanup only if the merge commit proves P15 and P3.
  const alreadyMerged = view.state === 'MERGED';
  view.unresolvedThreads = unresolvedThreads(repo, pr);
  view.metadataChangedAt = alreadyMerged ? '' : metadataChangedAt(repo, pr);
  runIdentity(repo, view.statusCheckRollup || []);
  const defaultBranch = gh(['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']).trim();
  // BRAIN_LONG_LIVED as pr-rules sees it: the repository variable when neither the environment nor .env defines it.
  // An invalid or unreadable pattern cannot say which branches are long-lived, so no branch is deleted.
  let patternInvalid = false;
  if (process.env.BRAIN_LONG_LIVED === undefined) {
    try { process.env.BRAIN_LONG_LIVED = gh(['variable', 'get', 'BRAIN_LONG_LIVED', '--repo', repo]).trim(); } catch (err) {
      if (!/not found|404/i.test(String(err.stderr || err.message))) patternInvalid = true;
    }
  }
  if (process.env.BRAIN_LONG_LIVED) { try { new RegExp(process.env.BRAIN_LONG_LIVED); } catch { patternInvalid = true; } }
  // A protected branch is never deleted either, whatever its name.
  const { host: h, owner: o, name: n } = splitRepo(repo);
  // An unknown protection state keeps the branch: only "no such branch" (a fork's head) counts as unprotected.
  let isProtected = false;
  let protectionUnknown = false;
  try { isProtected = gh(['api', '--hostname', h, `repos/${o}/${n}/branches/${encodeURIComponent(view.headRefName)}`, '--jq', '.protected']).trim() === 'true'; } catch (err) {
    if (!/404|Not Found|Branch not found/i.test(String(err.stderr || err.message))) {
      protectionUnknown = true;
    }
  }
  const keep = longLived(view.headRefName, defaultBranch) || isProtected || protectionUnknown || patternInvalid;
  const reviewers = new Set((view.reviews || []).filter(r => ['APPROVED', 'CHANGES_REQUESTED'].includes(r.state)).map(r => r.author && r.author.login).filter(Boolean));
  view.writers = writers(repo, [...reviewers]);
  const { blockers, ticket } = alreadyMerged ? { blockers: [], ticket: '' } : mergeBlockers(view, { reviewOptional: opts.reviewOptional });
  if (!alreadyMerged && hasMergeQueue(repo, view.baseRefName)) blockers.push(`${view.baseRefName} has a merge queue, which merge-pr does not support: the queue would choose the merge method (P15)`);
  if (blockers.length) {
    for (const b of blockers) console.error(`merge-pr: ${b}`);
    process.exit(1);
  }
  // Merge only the head that was inspected: a push after the view fails the merge instead of merging unchecked code.
  // gh deletes no branch here: the remote deletion below is leased to the merged head.
  const body = `Model: ${opts.model}\nThinking-effort: ${opts.effort}\nHarness: ${opts.harness}`;
  let mergeError = '';
  if (!alreadyMerged) {
    try {
      gh(['pr', 'merge', pr, '--repo', repo, '--merge', '--match-head-commit', view.headRefOid, '--subject', `Merge pull request #${pr} [${ticket}]`, '--body', body]);
    } catch (err) { mergeError = String(err.stderr || err.message).trim(); }
  }
  let after;
  try { after = JSON.parse(gh(['pr', 'view', pr, '--repo', repo, '--json', 'state,mergeCommit'])); } catch (err) {
    console.error(`merge-pr: could not read PR #${pr} after the merge call (${String(err.stderr || err.message).trim()}); nothing was deleted: run merge-pr again to verify and clean up`);
    process.exit(OUTCOME_UNKNOWN);
  }
  if (after.state !== 'MERGED') {
    console.error(`merge-pr: PR #${pr} is ${after.state}, not merged${mergeError ? `: ${mergeError}` : ' (auto-merge or a queue may have taken it)'}`);
    process.exit(1);
  }
  // Whoever merged it, cleanup runs only when the merge commit is a real merge of the inspected head with the ticket and
  // trailers; otherwise the branches stay as evidence.
  let problems;
  try { problems = mergeCommitProblems(repo, after.mergeCommit && after.mergeCommit.oid, view.headRefOid); } catch (err) {
    console.error(`merge-pr: PR #${pr} is merged, but its merge commit could not be read (${String(err.stderr || err.message).trim()}); nothing was deleted: run merge-pr again`);
    process.exit(OUTCOME_UNKNOWN);
  }
  if (problems.length) {
    console.error(`merge-pr: PR #${pr} is merged${mergeError || alreadyMerged ? ', but not by this run' : ''}, and its merge commit does not meet the rules; the branches were kept:`);
    for (const p of problems) console.error(`merge-pr:   ${p}`);
    process.exitCode = CLEANUP_INCOMPLETE;
    return;
  }
  if (keep && patternInvalid && !longLived(view.headRefName, defaultBranch)) {
    console.error(`merge-pr: merged #${pr}; BRAIN_LONG_LIVED is not a valid regular expression or could not be read, so ${view.headRefName} was kept (P7)`);
    process.exitCode = CLEANUP_INCOMPLETE;
    return;
  }
  if (keep && protectionUnknown && !longLived(view.headRefName, defaultBranch)) {
    console.error(`merge-pr: merged #${pr}; could not read whether ${view.headRefName} is protected, so it was kept: delete it by hand if it is not (P7)`);
    process.exitCode = CLEANUP_INCOMPLETE;
    return;
  }
  if (keep && !longLived(view.headRefName, defaultBranch)) {
    console.error(`merge-pr: merged #${pr}; ${view.headRefName} is protected, so it was kept: delete it by hand if it is a ticket branch (P7)`);
    process.exitCode = CLEANUP_INCOMPLETE;
    return;
  }
  if (keep) {
    console.log(`merged #${pr} with a merge commit; ${view.headRefName} is long-lived and stays (P7 does not apply)`);
    return;
  }
  if (view.isCrossRepository || !ownRepo) {
    console.error(`merge-pr: merged #${pr}; ${view.headRefName} is ${view.isCrossRepository ? "in the fork" : "not in origin's repository"} and was not deleted: delete it there (P7)`);
    process.exitCode = CLEANUP_INCOMPLETE;
    return;
  }
  // Remote: delete the branch only while it still points at the merged head; a commit pushed since survives. The push
  // goes to origin's configured URL, the one checked against the repository above, never to a separate pushurl.
  const url = git(['config', '--get', 'remote.origin.url']).trim();
  const remoteRef = `refs/heads/${view.headRefName}`;
  // A url.*.insteadOf or pushInsteadOf rule would send the push somewhere other than the verified URL: leave the
  // branch then.
  if (git(['ls-remote', '--get-url', url]).trim() !== url) {
    console.error(`merge-pr: merged #${pr}; an insteadOf rule rewrites ${url}, so the remote branch ${view.headRefName} was left: delete it by hand (P7)`);
    process.exitCode = CLEANUP_INCOMPLETE;
    return;
  }
  let rewrites = [];
  try { rewrites = git(['config', '--get-regexp', '^url\\..*\\.pushinsteadof$']).split('\n').filter(Boolean).map(l => l.split(' ').slice(1).join(' ')); } catch { /* none */ }
  if (rewrites.some(prefix => url.startsWith(prefix))) {
    console.error(`merge-pr: merged #${pr}; a pushInsteadOf rule rewrites ${url}, so the remote branch ${view.headRefName} was left: delete it by hand (P7)`);
    process.exitCode = CLEANUP_INCOMPLETE;
    return;
  }
  const stillThere = () => git(['ls-remote', url, remoteRef]).trim() !== '';
  try {
    if (stillThere()) git(['push', '--quiet', `--force-with-lease=${remoteRef}:${view.headRefOid}`, url, `:${remoteRef}`]);
  } catch (err) {
    // GitHub's automatic head-branch deletion may have removed it first: that is P7 done, not left undone.
    let gone = false;
    try { gone = !stillThere(); } catch { /* unknown */ }
    if (!gone) {
      console.error(`merge-pr: remote branch ${view.headRefName} not deleted (${String(err.stderr || err.message).trim()}); it may have moved past the merged head (P7)`);
      process.exitCode = CLEANUP_INCOMPLETE;
    }
  }
  // Local: a same-named branch is this PR's only when it points at the merged head; the fetched base must contain it.
  // update-ref deletes exactly that commit, so work committed meanwhile survives; a branch checked out in a worktree
  // (P6) is left to that worktree.
  const local = localTip(view.headRefName);
  if (local && local !== view.headRefOid) {
    console.error(`merge-pr: local branch ${view.headRefName} is not the merged head ${view.headRefOid.slice(0, 8)}; left alone (P7: delete it by hand if it is this PR's)`);
    process.exitCode = CLEANUP_INCOMPLETE;
  } else if (local) {
    try {
      git(['fetch', '--quiet', 'origin', view.baseRefName]);
      git(['merge-base', '--is-ancestor', local, `origin/${view.baseRefName}`]);
      const checkedOut = git(['worktree', 'list', '--porcelain']).split('\n').includes(`branch refs/heads/${view.headRefName}`);
      if (checkedOut) throw new Error('it is checked out in a worktree: remove that worktree (or detach it), then delete the branch');
      git(['update-ref', '-d', `refs/heads/${view.headRefName}`, local]);
      // Its tracking config goes too, unless a branch of that name was created again meanwhile.
      if (!localTip(view.headRefName)) { try { git(['config', '--remove-section', `branch.${view.headRefName}`]); } catch { /* no tracking config */ } }
    } catch (err) {
      console.error(`merge-pr: local branch ${view.headRefName} not deleted (${String(err.stderr || err.message).trim()}); P7 is not complete`);
      process.exitCode = CLEANUP_INCOMPLETE;
    }
  }
  console.log(process.exitCode === CLEANUP_INCOMPLETE
    ? `merged #${pr} with a merge commit; cleanup of ${view.headRefName} is incomplete (see above)`
    : `merged #${pr} with a merge commit; ${view.headRefName} deleted on the remote and locally`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { mergeBlockers, originRepo, splitRepo, latestRuns, isApproved, isPending, longLived };
