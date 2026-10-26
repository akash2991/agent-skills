#!/usr/bin/env node
'use strict';

// Merges a pull request the one way the organisation allows (git-workflow-and-versioning P3, P7, P10, P12, P15):
// a merge commit that carries the ticket id and the Model / Thinking-effort / Harness trailers, remote and local
// branch deleted, only when CI is green and the PR is approved.
// Usage: merge-pr.js <pr-number> --model <m> --effort <e> --harness <h> [--review-optional] [--repo [host/]owner/name]
// --review-optional is for a ticket that made review optional (P8); pass it only then.

const { execFileSync } = require('child_process');
const { ticketSource, checkPrTitle, loadDotenv, checkCommitMessage, checkOneTicket, isTicketBranch, isLongLived, longLivedPatternError, teamError } = require('./brain-git-check');

// Exit codes: 0 merged and cleaned up, 1 not merged (a blocker or a failed merge), 2 bad usage, 4 the merge's outcome
// could not be read (nothing deleted; run merge-pr again to verify and clean up), 3 merged but P7
// cleanup left to do (reported on stderr).
const CLEANUP_INCOMPLETE = 3;
const OUTCOME_UNKNOWN = 4;

// stderr is captured into the error, not printed: an expected "not found" is not noise on the caller's terminal.
function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

// The github.com repository behind origin, as owner/name. Only github.com is inferred: ssh.github.com, and an SSH host
// alias (git@github-work:org/app.git) whose `ssh -G` HostName is github.com. Any other host, GitHub Enterprise
// included, is refused rather than guessed, so gh never acts on a same-named repository elsewhere: pass
// --repo <host>/<owner>/<name> for it (and for a fork's PR, which lives on upstream).
function originRepo() {
  const { url, host, owner, name } = originParts();
  if (resolvedHost(host, url) !== 'github.com') {
    throw new Error(`origin (${url}) is not a github.com remote; pass --repo <host>/<owner>/<name>`);
  }
  return `${owner}/${name}`;
}

// origin's single URL split into host, owner, and name, for any host (an explicit --repo may name GitHub Enterprise).
function originParts() {
  // The URL as configured, before any url.*.insteadOf rewrite: that is the repository the user named.
  // One URL only: with several, git fetches from the first while `config --get` returns the last, so the repository
  // is ambiguous; refuse rather than pick one.
  const urls = git(['config', '--get-all', 'remote.origin.url']).split('\n').filter(Boolean);
  if (urls.length !== 1) throw new Error(`origin has ${urls.length} URLs; pass --repo <host>/<owner>/<name>`);
  const url = urls[0].trim();
  // Only GitHub's transports: a file:// URL (file://github.com/tmp/o/r.git is a local path) names no GitHub repository.
  const scheme = (url.match(/^([a-z][a-z0-9+.-]*):\/\//i) || [])[1];
  if (scheme && !['https', 'http', 'ssh', 'git', 'git+ssh', 'ssh+git'].includes(scheme.toLowerCase())) {
    throw new Error(`origin (${url}) is not a GitHub transport; pass --repo <host>/<owner>/<name>`);
  }
  const host = ((url.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)/) || [])[1] || '').toLowerCase();
  // The path must be exactly owner/name: https://github.com/a/b/c.git names no repository a/b or b/c.
  const repoPath = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, '').replace(/^[^@/]+@[^:/]+:/, '').replace(/^[^@/:]+:(?!\/)/, '');
  const repo = /^([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repoPath);
  if (!repo || !host) throw new Error(`origin (${url}) does not name a host/owner/name repository; pass --repo <host>/<owner>/<name>`);
  return { url, host, owner: repo[1], name: repo[2] };
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
    // The ref a run was for is part of its identity: a push run for a tag or another branch at the same SHA does
    // not stand for this branch's push run.
    const producer = c.workflowPath ? `${c.workflowPath}|${c.event}|${c.runBranch || ''}` : runId(c) ? `run:${runId(c)}` : c.workflowName ? `workflow:${c.workflowName}` : '';
    if (!producer) { kept.push(c); continue; }
    const key = `${producer}/${c.name || c.context}`;
    (groups.get(key) || groups.set(key, []).get(key)).push({ c, i });
  }
  for (const members of groups.values()) {
    const runs = new Map();
    for (const m of members) {
      const id = runId(m.c) || m.c.runCreated || `job:${m.i}`;
      const run = runs.get(id) || { created: at(m.c.runCreated || m.c.startedAt || m.c.createdAt), id: Number(runId(m.c)) || 0, jobs: [] };
      run.jobs.push(m.c);
      runs.set(id, run);
    }
    // Creation times have one-second precision: on a tie the higher run id, which GitHub assigns in order, is newer.
    const ordered = [...runs.values()].sort((a, b) => (b.created - a.created) || (b.id - a.id));
    // The newest attempt stands in for the run only when it re-ran every job of that name: a partial re-run of one of
    // two same-named jobs cannot say which earlier job it replaces, so then every job of the run counts.
    const latestAttempt = jobs => {
      if (!jobs.every(j => Number(j.jobAttempt))) return jobs;
      const byAttempt = new Map();
      for (const j of jobs) byAttempt.set(Number(j.jobAttempt), (byAttempt.get(Number(j.jobAttempt)) || 0) + 1);
      const top = Math.max(...byAttempt.keys());
      if ([...byAttempt.values()].some(n => n > byAttempt.get(top))) return jobs;
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
    // A dismissed review withdraws that reviewer's verdict; it does not bring back an earlier one.
    if (r.state === 'DISMISSED') { newest.delete(login); continue; }
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
// A run of a pull_request workflow belongs to the PRs GitHub lists for it, at the head it ran on. A run that GitHub
// ties to other PRs only, or to another head, says nothing about this PR: it neither passes nor supersedes.
// GitHub's PR list on a run is every open PR with that head, not the PR that triggered it: a pr-rules run names its
// PR in its run name (templates/pr-rules.yml), and one naming another PR, or none, is not this PR's.
function forThisPr(c, view) {
  if (!c.workflowPath || c.event !== 'pull_request') return true;
  if (c.runHead && view.headRefOid && c.runHead !== view.headRefOid) return false;
  if ((c.name || c.context) === 'pr-rules' && c.runTitle !== `pr-rules #${Number(view.number)}`) return false;
  return !c.runPrs || !c.runPrs.length || !view.number || c.runPrs.includes(Number(view.number));
}

function mergeBlockers(view, { reviewOptional = false } = {}, env = process.env) {
  const blockers = [];
  if (view.state !== 'OPEN') blockers.push(`PR is ${view.state}, not OPEN`);
  // The same title rule CI checks: "<ticket>: <goal>". The title, branch, and commits are checked again here, because a
  // pr-rules success on this head may predate a retitle (the head SHA does not change).
  blockers.push(...checkPrTitle(view.title, env));
  // A head that is not a ticket branch is a promotion (CI judged it with the full long-lived configuration); a fork's
  // head never is.
  if (view.commitMessages) blockers.push(...checkOneTicket({ branch: view.headRefName, title: view.title, messages: view.commitMessages,
    promotion: !view.isCrossRepository && (!isTicketBranch(view.headRefName, env) || isLongLived(view.headRefName, env)) }, env));
  const ticket = new RegExp(`^(${ticketSource(env)}):`).exec(view.title || '');
  const checks = latestRuns((view.statusCheckRollup || []).filter(c => forThisPr(c, view)));
  if (!checks.length) blockers.push('no CI checks have reported on this head; wait for them (P12)');
  // Two open PRs from one head branch share their runs' PR lists, so one PR's newer pass would replace the other's
  // failure: merge-pr does not judge such a PR.
  const others = [...new Set((view.statusCheckRollup || []).filter(c => c.event === 'pull_request').flatMap(c => c.runPrs || []).filter(n => n !== Number(view.number)))];
  if (others.length) blockers.push(`another open PR (#${others.join(', #')}) shares this head branch, so its CI runs cannot be told from this PR's: a reviewer merges it by hand (P12)`);
  // P3, P11, and P13 are checked only by the project's pr-rules workflow: its check must have run and passed; a
  // skipped or neutral pr-rules never checked anything.
  // Only an Actions check whose run was identified counts as pr-rules: a commit status, or a check whose run could
  // not be looked up, can be posted by anything.
  // ...and only a run GitHub ties to this very PR: a fork's runs carry no PR list, so they never qualify here.
  const rules = checks.filter(c => (c.name || c.context) === 'pr-rules' && c.workflowPath && (c.runPrs || []).includes(Number(view.number)));
  // A pass counts only when the Actions job behind it is a pr-rules job of that very run, on this head, that succeeded:
  // an integration can post a check named pr-rules with a details URL pointing at some other job.
  const passed = rules.filter(c => (c.conclusion || c.state) === 'SUCCESS' && c.jobName === 'pr-rules' && c.jobConclusion === 'success'
    && c.jobRun === runId(c) && c.jobHead === view.headRefOid);
  if (checks.length && !passed.length) blockers.push('no passing pr-rules Actions check (with an identified run) on this head: install the git-workflow-and-versioning skill\'s templates/pr-rules.yml so P3, P11, and P13 are checked (P10)');
  // A PR that touches any workflow can change what certifies it: a reviewer merges it by hand.
  if ((view.changedFiles || []).some(f => f.startsWith('.github/workflows/'))) blockers.push('this PR changes .github/workflows/, which could change its own checks: a reviewer merges it by hand (P10)');
  // The same for merge-pr and its checker: run from the PR's worktree, a changed copy would judge its own merge.
  if ((view.changedFiles || []).some(f => /(^|\/)skills\/git-workflow-and-versioning\/scripts\//.test(f))) blockers.push('this PR changes the git-workflow scripts (merge-pr, brain-git-check), which could change its own checks: a reviewer merges it by hand (P10)');
  if (view.changedFilesIncomplete) blockers.push('the PR\'s changed-file list could not be read in full, so a workflow change cannot be ruled out: a reviewer merges it by hand (P10)');
  if (view.commitMessages && view.commitMessages.length >= 250) blockers.push('the PR has 250 or more commits, more than the API lists, so the ticket check cannot see them all: split it (P11)');
  // The head SHA does not change when the title, body, or base does. A run checks the PR as it was when the run was
  // created (a re-run keeps that snapshot), so only a pass from a run created after the last such change counts; a
  // pass whose run time is unknown does not.
  const changed = Date.parse(view.metadataChangedAt || '') || 0;
  // Strictly after: times have one-second precision, so a run created in the same second as the edit may have
  // checked the PR as it was before it.
  if (passed.length && changed && !passed.some(c => (Date.parse(c.runCreated || '') || 0) > changed)) {
    blockers.push(`pr-rules last passed before the PR's title, body, or base changed (${view.metadataChangedAt}); wait for the run that change triggers. A re-run checks the old snapshot: if no run starts (an edit by a workflow token), make a fresh edit or close and reopen the PR (P10, P11)`);
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
      try { runs.set(id, JSON.parse(gh(['api', '--hostname', host, `repos/${owner}/${name}/actions/runs/${id}`, '--jq', '{path: .path, event: .event, created: .created_at, attempt: .run_attempt, prs: [.pull_requests[].number], head: .head_sha, branch: .head_branch, title: .display_title}']))); }
      catch { runs.set(id, null); }
    }
    // The job itself, from the Actions API: a check's details URL is chosen by whoever posted the check, so only the
    // job record says which job ran, in which run, on which head, and how it ended. A check gets its run's identity
    // (and so may supersede, or be superseded by, other runs) only when that job is a job of this name in that run;
    // otherwise it stays an unidentified check, which never counts as pr-rules and never hides another run.
    const job = jobId(c);
    let j = null;
    if (job) {
      try { j = JSON.parse(gh(['api', '--hostname', host, `repos/${owner}/${name}/actions/jobs/${job}`, '--jq', '{attempt: .run_attempt, name: .name, conclusion: .conclusion, run: .run_id, head: .head_sha}'])); } catch { /* unverified */ }
    }
    if (!j || j.name !== c.name || String(j.run || '') !== id) continue;
    // Each job's own attempt: a re-run's jobs share the run id and its current attempt number.
    Object.assign(c, { jobAttempt: Number(j.attempt) || undefined, jobName: j.name, jobConclusion: j.conclusion, jobRun: String(j.run || ''), jobHead: j.head });
    const run = runs.get(id);
    if (run && run.path) Object.assign(c, { workflowPath: run.path, event: run.event, runCreated: run.created, runPrs: run.prs || [], runHead: run.head, runBranch: run.branch, runTitle: run.title });
  }
  return checks;
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

// Every changed path (REST lists up to 3000 across pages; gh pr view stops at 100), with the PR's own count to compare.
function prFiles(repo, pr) {
  const { host, owner, name } = splitRepo(repo);
  const pages = JSON.parse(gh(['api', '--hostname', host, '--paginate', '--slurp', `repos/${owner}/${name}/pulls/${pr}/files?per_page=100`]) || '[]');
  const total = Number(gh(['api', '--hostname', host, `repos/${owner}/${name}/pulls/${pr}`, '--jq', '.changed_files']).trim()) || 0;
  // A renamed file counts under both names: moving a workflow out of .github/workflows/ also changes it.
  const records = pages.flat();
  return { files: records.flatMap(f => [f.filename, f.previous_filename].filter(Boolean)), records: records.length, total };
}

// The PR's commit messages in full (GraphQL's messageHeadline is cut at about 70 characters).
function prCommitMessages(repo, pr) {
  const { host, owner, name } = splitRepo(repo);
  const pages = JSON.parse(gh(['api', '--hostname', host, '--paginate', '--slurp', `repos/${owner}/${name}/pulls/${pr}/commits?per_page=100`]) || '[]');
  return pages.flat().map(c => c.commit.message);
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
    else if (valued[a] && argv[i + 1] && !argv[i + 1].startsWith('--') && argv[i + 1].trim() && !/[\r\n]/.test(argv[i + 1])) opts[valued[a]] = argv[++i];
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
// ticket: this PR's own ticket, from its title; the merge commit must name it, not merely some ticket (P15).
function mergeCommitProblems(repo, oid, head, ticket) {
  if (!oid) return ['no merge commit is recorded'];
  const { host, owner, name } = splitRepo(repo);
  const c = JSON.parse(gh(['api', '--hostname', host, `repos/${owner}/${name}/commits/${oid}`, '--jq', '{parents: [.parents[].sha], message: .commit.message}']));
  const problems = [];
  if (c.parents.length !== 2 || !c.parents.includes(head)) problems.push(`${oid.slice(0, 8)} is not a merge commit of the inspected head (P15)`);
  problems.push(...checkCommitMessage(c.message, process.env, { isMerge: true, stripComments: false }));
  const subject = c.message.split('\n')[0];
  if (!ticket) problems.push(`the PR title names no ticket, so the merge commit cannot be tied to one (P15)`);
  else if (!new RegExp(`\\[${ticket}\\]`).test(subject)) problems.push(`${oid.slice(0, 8)} does not name this PR's ticket ${ticket} in its subject (P15)`);
  return problems;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (!opts) { console.error(USAGE); process.exit(2); }
  loadDotenv();
  const { pr } = opts;
  const given = opts.repo || originRepo();
  if (!/^([^/]+\/)?[^/]+\/[^/]+$/.test(given)) { console.error('merge-pr: --repo takes [host/]owner/name'); process.exit(2); }
  // Every gh command gets host/owner/name: a bare owner/name would follow GH_HOST to another host.
  const { host: rh, owner: ro, name: rn } = splitRepo(given);
  const repo = `${rh}/${ro}/${rn}`;
  // Commands without a host argument (gh variable get) follow GH_HOST: pin it to the same host.
  process.env.GH_HOST = rh;
  // Branch cleanup goes through this checkout's origin, so it runs only when origin is the target repository.
  let ownRepo = !opts.repo;
  if (!ownRepo) {
    // Compare [host/]owner/name by parts, case-insensitively: github.com/o/r names the same repository as o/r.
    const same = (a, b) => ['host', 'owner', 'name'].every(k => a[k].toLowerCase() === b[k].toLowerCase());
    // github.com through inference (SSH aliases included); any other host only when origin names it exactly.
    try { ownRepo = same(splitRepo(originRepo()), splitRepo(repo)); } catch { ownRepo = false; }
    if (!ownRepo) { try { const o = originParts(); ownRepo = same(o, splitRepo(repo)); } catch { ownRepo = false; } }
  }
  // The origin URL as verified now; cleanup uses this one and stops if origin is changed meanwhile.
  let verifiedUrl = '';
  if (ownRepo) {
    try {
      const urls = git(['config', '--get-all', 'remote.origin.url']).split('\n').filter(Boolean);
      if (urls.length === 1) verifiedUrl = urls[0].trim(); else ownRepo = false;
    } catch { ownRepo = false; }
  }
  // Everything the gates judge, read in one place: once before the checks, and again just before the merge.
  const readGates = () => {
    const v = JSON.parse(gh(['pr', 'view', pr, '--repo', repo, '--json', 'title,body,headRefName,headRefOid,baseRefName,reviewDecision,reviews,author,statusCheckRollup,state,isCrossRepository,mergeCommit']));
    v.number = Number(pr);
    v.unresolvedThreads = unresolvedThreads(repo, pr);
    if (v.state !== 'MERGED') {
      v.commitMessages = prCommitMessages(repo, pr);
      const { files, records, total } = prFiles(repo, pr);
      v.changedFiles = files;
      // Records, not names: a rename adds a second name, which must not make up for a record the API left out.
      v.changedFilesIncomplete = records < total;
      v.metadataChangedAt = metadataChangedAt(repo, pr);
    }
    runIdentity(repo, v.statusCheckRollup || []);
    const reviewers = new Set((v.reviews || []).filter(r => ['APPROVED', 'CHANGES_REQUESTED'].includes(r.state)).map(r => r.author && r.author.login).filter(Boolean));
    v.writers = writers(repo, [...reviewers]);
    return v;
  };
  const view = readGates();
  // Already merged (an earlier run whose outcome was unknown, or someone else): skip the gates and the merge, and go
  // on to cleanup only if the merge commit proves P15 and P3.
  const alreadyMerged = view.state === 'MERGED';
  const defaultBranch = gh(['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']).trim();
  // The same default branch for the checks merge-pr re-runs (P5 and one-ticket promotion) as for cleanup.
  process.env.DEFAULT_BRANCH = defaultBranch;
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
  // merge-pr deletes only a ticket branch (<ticket>-<slug>) of this repository: main, the default branch, release/*,
  // and any other long-lived branch are not ticket branches, so no retention configuration is needed to keep them.
  // A ticket-shaped name that is configured long-lived (BRAIN_LONG_LIVED from the environment, .env, or the repository
  // variable), or is the default branch, is not a ticket branch; an unreadable variable keeps the head.
  let longLivedUnknown = false;
  if (!process.env.LINEAR_TEAM) { try { process.env.LINEAR_TEAM = gh(['variable', 'get', 'LINEAR_TEAM', '--repo', repo]).trim(); } catch { /* checked below */ } }
  if (process.env.BRAIN_LONG_LIVED === undefined) {
    try { process.env.BRAIN_LONG_LIVED = gh(['variable', 'get', 'BRAIN_LONG_LIVED', '--repo', repo]).trim(); } catch (err) {
      if (!/not found|404/i.test(String(err.stderr || err.message))) longLivedUnknown = true;
    }
  }
  // A malformed LINEAR_TEAM or BRAIN_LONG_LIVED is reported as such before any pattern is built from it.
  const configError = teamError() || longLivedPatternError();
  if (configError) {
    console.error(`merge-pr: ${configError}${alreadyMerged ? `; PR #${pr} is already merged, and nothing was cleaned up` : '; nothing was merged'}`);
    process.exit(alreadyMerged ? CLEANUP_INCOMPLETE : 1);
  }
  const ticketBranch = !view.isCrossRepository && isTicketBranch(view.headRefName) && !isLongLived(view.headRefName) && !longLivedUnknown;
  const keep = !ticketBranch || isProtected || protectionUnknown;
  const { blockers, ticket } = alreadyMerged ? { blockers: [], ticket: '' } : mergeBlockers(view, { reviewOptional: opts.reviewOptional });
  // GitHub's "Automatically delete head branches" deletes any unprotected same-repository head on merge: a head that
  // must be kept has to be protected first.
  if (!alreadyMerged && keep && !isProtected && !view.isCrossRepository) {
    let autoDelete = true;
    try { autoDelete = gh(['api', '--hostname', h, `repos/${o}/${n}`, '--jq', '.delete_branch_on_merge']).trim() !== 'false'; } catch { /* unknown: assume it deletes */ }
    if (autoDelete && longLivedUnknown && isTicketBranch(view.headRefName)) blockers.push(`the repository variable BRAIN_LONG_LIVED could not be read, so ${view.headRefName} cannot be shown to be a ticket branch, and the repository deletes head branches on merge: set BRAIN_LONG_LIVED in .env (empty if there are no long-lived branches) or give the token read access to variables (P16)`);
    else if (autoDelete) blockers.push(`${view.headRefName} must be kept but is not known to be protected, and the repository deletes head branches on merge (or that could not be read): protect it first (P16)`);
  }
  // The merge commit must meet P3 and P15 before it exists: check the planned message.
  if (!alreadyMerged) for (const p of checkCommitMessage(`Merge pull request #${pr} [${ticket || ''}]\n\nModel: ${opts.model}\nThinking-effort: ${opts.effort}\nHarness: ${opts.harness}`, process.env, { isMerge: true })) blockers.push(`planned merge commit: ${p}`);
  // As in CI: the generic ticket pattern also matches UTF-8 or SHA-256, so the team's must be known.
  if (!alreadyMerged && longLivedPatternError()) blockers.push(longLivedPatternError());
  if (!alreadyMerged && teamError()) blockers.push(teamError());
  if (!alreadyMerged && !process.env.LINEAR_TEAM) blockers.push('LINEAR_TEAM is not set (environment, .env, or the repository variable) (P4)');
  if (!alreadyMerged && hasMergeQueue(repo, view.baseRefName)) blockers.push(`${view.baseRefName} has a merge queue, which merge-pr does not support: the queue would choose the merge method (P15)`);
  if (blockers.length) {
    for (const b of blockers) console.error(`merge-pr: ${b}`);
    process.exit(1);
  }
  // Merge only the head that was inspected: a push after the view fails the merge instead of merging unchecked code.
  // gh deletes no branch here: the remote deletion below is leased to the merged head.
  // A waived review leaves its trace in the merge commit (P8: only the ticket may make review optional).
  const body = `Model: ${opts.model}\nThinking-effort: ${opts.effort}\nHarness: ${opts.harness}${opts.reviewOptional ? '\nReview: optional (per the ticket)' : ''}`;
  let mergeError = '';
  if (!alreadyMerged) {
    // gh pins the head but nothing else: a PR retargeted, edited, reviewed, or given a new thread or CI result during the
    // checks above would merge on gates that judged something else. Read every gate input again and judge it afresh;
    // anything unreadable refuses. What changes after this read is caught after the merge (base, title, body) or by
    // the base branch's own protection.
    let now;
    try { now = readGates(); } catch (err) {
      console.error(`merge-pr: could not read PR #${pr} again before merging (${String(err.stderr || err.message).trim()}); nothing was merged`);
      process.exit(1);
    }
    const changed = ['baseRefName', 'title', 'body', 'headRefOid'].filter(k => (now[k] || '') !== (view[k] || ''));
    if (changed.length) {
      const what = changed.includes('baseRefName') ? `now targets ${now.baseRefName || 'an unreadable base'}, not ${view.baseRefName} as checked` : `changed (${changed.join(', ')}) during the checks`;
      console.error(`merge-pr: PR #${pr} ${what}; run merge-pr again`);
      process.exit(1);
    }
    const late = now.state === 'OPEN' ? mergeBlockers(now, { reviewOptional: opts.reviewOptional }).blockers : [`PR #${pr} is ${now.state}`];
    if (late.length) {
      for (const b of late) console.error(`merge-pr: just before merging: ${b}`);
      process.exit(1);
    }
    try {
      gh(['pr', 'merge', pr, '--repo', repo, '--merge', '--match-head-commit', view.headRefOid, '--subject', `Merge pull request #${pr} [${ticket}]`, '--body', body]);
    } catch (err) { mergeError = String(err.stderr || err.message).trim(); }
  }
  let after;
  try { after = JSON.parse(gh(['pr', 'view', pr, '--repo', repo, '--json', 'state,mergeCommit,baseRefName,title,body'])); } catch (err) {
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
  const prTicket = ticket || ((new RegExp(`^(${ticketSource()}): `).exec(view.title || '') || [])[1] || '');
  try { problems = mergeCommitProblems(repo, after.mergeCommit && after.mergeCommit.oid, view.headRefOid, prTicket); } catch (err) {
    console.error(`merge-pr: PR #${pr} is merged, but its merge commit could not be read (${String(err.stderr || err.message).trim()}); nothing was deleted: run merge-pr again`);
    process.exit(OUTCOME_UNKNOWN);
  }
  if (after.baseRefName && after.baseRefName !== view.baseRefName) problems.push(`it was merged into ${after.baseRefName}, not ${view.baseRefName} as checked`);
  // The re-read before the merge leaves a moment GitHub cannot close: an edit in it is caught here, and the branches stay.
  if (!alreadyMerged) for (const k of ['title', 'body']) if (after[k] !== undefined && (after[k] || '') !== (view[k] || '')) problems.push(`its ${k} changed while it was being merged`);
  if (problems.length) {
    console.error(`merge-pr: PR #${pr} is merged${mergeError || alreadyMerged ? ', but not by this run' : ''}, and its merge commit does not meet the rules; the branches were kept:`);
    for (const p of problems) console.error(`merge-pr:   ${p}`);
    process.exitCode = CLEANUP_INCOMPLETE;
    return;
  }
  if (keep && longLivedUnknown && isTicketBranch(view.headRefName) && !view.isCrossRepository) {
    console.error(`merge-pr: merged #${pr}; the repository variable BRAIN_LONG_LIVED could not be read, so ${view.headRefName} was kept: delete it by hand if it is not long-lived (P7)`);
    process.exitCode = CLEANUP_INCOMPLETE;
    return;
  }
  if (keep && protectionUnknown) {
    console.error(`merge-pr: merged #${pr}; could not read whether ${view.headRefName} is protected, so it was kept: delete it by hand if it is not (P7)`);
    process.exitCode = CLEANUP_INCOMPLETE;
    return;
  }
  if (keep && ticketBranch) {
    console.error(`merge-pr: merged #${pr}; ${view.headRefName} is protected, so it was kept: delete it by hand if it should go (P7)`);
    process.exitCode = CLEANUP_INCOMPLETE;
    return;
  }
  if (keep && !view.isCrossRepository) {
    console.log(`merged #${pr} with a merge commit; ${view.headRefName} is not a ticket branch and stays (P7 applies to ticket branches)`);
    return;
  }
  if (view.isCrossRepository || !ownRepo) {
    console.error(`merge-pr: merged #${pr}; ${view.headRefName} is ${view.isCrossRepository ? "in the fork" : "not in origin's repository"} and was not deleted: delete it there (P7)`);
    process.exitCode = CLEANUP_INCOMPLETE;
    return;
  }
  // Remote: delete the branch only while it still points at the merged head; a commit pushed since survives. The push
  // goes to origin's configured URL, the one checked against the repository above, never to a separate pushurl.
  const url = verifiedUrl;
  const remoteRef = `refs/heads/${view.headRefName}`;
  let nowUrl = '';
  try { nowUrl = git(['config', '--get-all', 'remote.origin.url']).trim(); } catch { /* removed */ }
  if (nowUrl !== url) {
    console.error(`merge-pr: merged #${pr}; origin changed during the run (${url} -> ${nowUrl || 'none'}), so ${view.headRefName} was left: delete it by hand (P7)`);
    process.exitCode = CLEANUP_INCOMPLETE;
    return;
  }
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
    // A push to a URL leaves origin's tracking ref behind: drop it too, only at the merged head.
    try { git(['update-ref', '--no-deref', '-d', `refs/remotes/origin/${view.headRefName}`, view.headRefOid]); } catch { /* absent or moved */ }
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
  // A symbolic ref (ENG-1-x -> main) would make a deletion follow it to another branch: never touch one.
  let symbolic = false;
  try { execFileSync('git', ['symbolic-ref', '-q', `refs/heads/${view.headRefName}`], { stdio: 'ignore' }); symbolic = true; } catch { /* not symbolic */ }
  if (local && symbolic) {
    console.error(`merge-pr: local ${view.headRefName} is a symbolic ref; left alone (P7)`);
    process.exitCode = CLEANUP_INCOMPLETE;
  } else if (local && local !== view.headRefOid) {
    console.error(`merge-pr: local branch ${view.headRefName} is not the merged head ${view.headRefOid.slice(0, 8)}; left alone (P7: delete it by hand if it is this PR's)`);
    process.exitCode = CLEANUP_INCOMPLETE;
  } else if (local) {
    try {
      // From the verified URL, not the origin remote, which may have changed.
      // Into a ref of merge-pr's own, never origin/<base>: a symbolic remote ref there would carry the fetch onto a branch.
      const scratch = `refs/merge-pr/${process.pid}/base`;
      git(['fetch', '--quiet', '--no-write-fetch-head', url, `+refs/heads/${view.baseRefName}:${scratch}`]);
      try { git(['merge-base', '--is-ancestor', local, scratch]); }
      finally { try { git(['update-ref', '--no-deref', '-d', scratch]); } catch { /* already gone */ } }
      const checkedOut = git(['worktree', 'list', '--porcelain']).split('\n').includes(`branch refs/heads/${view.headRefName}`);
      if (checkedOut) throw new Error('it is checked out in a worktree: remove that worktree (or detach it), then delete the branch');
      git(['update-ref', '--no-deref', '-d', `refs/heads/${view.headRefName}`, local]);
      // Its tracking config goes too, unless a branch of that name was created again meanwhile.
      if (!localTip(view.headRefName)) { try { execFileSync('git', ['config', '--remove-section', `branch.${view.headRefName}`], { stdio: 'ignore' }); } catch { /* no tracking config */ } }
    } catch (err) {
      console.error(`merge-pr: local branch ${view.headRefName} not deleted (${String(err.stderr || err.message).trim()}); P7 is not complete`);
      process.exitCode = CLEANUP_INCOMPLETE;
    }
  }
  console.log(process.exitCode === CLEANUP_INCOMPLETE
    ? `merged #${pr} with a merge commit; cleanup of ${view.headRefName} is incomplete (see above)`
    : `merged #${pr} with a merge commit; ${view.headRefName} deleted on the remote${local ? ' and locally' : ' (there was no local branch)'}`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { mergeBlockers, originRepo, splitRepo, latestRuns, isApproved, isPending };
