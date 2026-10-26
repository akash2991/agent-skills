#!/usr/bin/env node
'use strict';

// Merges a pull request the one way the organisation allows (git-workflow-and-versioning P7, P10, P12, P15):
// a merge commit that carries the ticket id, remote and local branch deleted, only when CI is green and the
// PR is approved. Usage: merge-pr.js <pr-number> [--review-optional]
// --review-optional is for a ticket that made review optional (P8); pass it only then.

const { execFileSync } = require('child_process');
const { ticketSource } = require('./brain-git-check');

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

// owner/name of the repository whose origin this is: gh would otherwise act on the default (often upstream) repository.
function originRepo() {
  const url = git(['remote', 'get-url', 'origin']).trim();
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) throw new Error(`origin is not a GitHub remote: ${url}`);
  return `${m[1]}/${m[2]}`;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

// view is the parsed `gh pr view --json title,headRefName,headRefOid,reviewDecision,statusCheckRollup,state` output.
// An empty check rollup is not green: Actions may not have registered its checks yet.
function mergeBlockers(view, { reviewOptional = false } = {}, env = process.env) {
  const blockers = [];
  if (view.state !== 'OPEN') blockers.push(`PR is ${view.state}, not OPEN`);
  const ticket = new RegExp(`^(${ticketSource(env)})(:|\\s)`).exec(view.title || '');
  if (!ticket) blockers.push('PR title does not start with the ticket id (P10)');
  const checks = view.statusCheckRollup || [];
  if (!checks.length) blockers.push('no CI checks have reported on this head; wait for them (P12)');
  const failing = checks.filter(c => !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion || c.state));
  if (failing.length) blockers.push(`CI is not green: ${failing.map(c => c.name || c.context).join(', ')} (P12)`);
  if (!reviewOptional && view.reviewDecision !== 'APPROVED') blockers.push(`review decision is ${view.reviewDecision || 'none'}, not APPROVED (P10)`);
  return { blockers, ticket: ticket && ticket[1] };
}

function main(argv) {
  const pr = argv.find(a => /^\d+$/.test(a));
  if (!pr) { console.error('usage: merge-pr.js <pr-number> [--review-optional]'); process.exit(2); }
  const repo = originRepo();
  const view = JSON.parse(gh(['pr', 'view', pr, '--repo', repo, '--json', 'title,headRefName,headRefOid,reviewDecision,statusCheckRollup,state']));
  const { blockers, ticket } = mergeBlockers(view, { reviewOptional: argv.includes('--review-optional') });
  if (blockers.length) {
    for (const b of blockers) console.error(`merge-pr: ${b}`);
    process.exit(1);
  }
  // Merge only the head that was inspected: a push after the view fails the merge instead of merging unchecked code.
  gh(['pr', 'merge', pr, '--repo', repo, '--merge', '--delete-branch', '--match-head-commit', view.headRefOid, '--subject', `Merge pull request #${pr} [${ticket}]`]);
  try { git(['branch', '-d', view.headRefName]); } catch { /* already gone, or checked out in another worktree */ }
  console.log(`merged #${pr} with a merge commit; branch ${view.headRefName} deleted on the remote`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { mergeBlockers, originRepo };
