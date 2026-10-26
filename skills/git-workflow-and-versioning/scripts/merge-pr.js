#!/usr/bin/env node
'use strict';

// Merges a pull request the one way the organisation allows (git-workflow-and-versioning P7, P10, P12, P15):
// a merge commit that carries the ticket id, remote and local branch deleted, only when CI is green and the
// PR is approved. Usage: merge-pr.js <pr-number> [--review-optional]
// --review-optional is for a ticket that made review optional (P8); pass it only then.

const { execFileSync } = require('child_process');

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

// view is the parsed `gh pr view --json title,headRefName,reviewDecision,statusCheckRollup,state` output.
function mergeBlockers(view, { reviewOptional = false } = {}, ticketPattern = /^[A-Z][A-Z0-9]*-\d+/) {
  const blockers = [];
  if (view.state !== 'OPEN') blockers.push(`PR is ${view.state}, not OPEN`);
  const ticket = ticketPattern.exec(view.title || '');
  if (!ticket) blockers.push('PR title does not start with the ticket id (P10)');
  const checks = view.statusCheckRollup || [];
  const failing = checks.filter(c => !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion || c.state));
  if (failing.length) blockers.push(`CI is not green: ${failing.map(c => c.name || c.context).join(', ')} (P12)`);
  if (!reviewOptional && view.reviewDecision !== 'APPROVED') blockers.push(`review decision is ${view.reviewDecision || 'none'}, not APPROVED (P10)`);
  return { blockers, ticket: ticket && ticket[0] };
}

function main(argv) {
  const pr = argv.find(a => /^\d+$/.test(a));
  if (!pr) { console.error('usage: merge-pr.js <pr-number> [--review-optional]'); process.exit(2); }
  const view = JSON.parse(gh(['pr', 'view', pr, '--json', 'title,headRefName,reviewDecision,statusCheckRollup,state']));
  const { blockers, ticket } = mergeBlockers(view, { reviewOptional: argv.includes('--review-optional') });
  if (blockers.length) {
    for (const b of blockers) console.error(`merge-pr: ${b}`);
    process.exit(1);
  }
  gh(['pr', 'merge', pr, '--merge', '--delete-branch', '--subject', `Merge pull request #${pr} [${ticket}]`]);
  try { git(['branch', '-d', view.headRefName]); } catch { /* already gone, or checked out in another worktree */ }
  console.log(`merged #${pr} with a merge commit; branch ${view.headRefName} deleted on the remote`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { mergeBlockers };
