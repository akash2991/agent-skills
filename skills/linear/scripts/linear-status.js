#!/usr/bin/env node
'use strict';

// Checks a Linear state move against the workflow and renders the status update that must accompany it (M3, M5).
//   check  <from> <to> [--reason <why>] [--left <state>]    exit 0 when the move is legal, 1 when not
//   render --persona P --model M --effort E --harness H --field F --from A --to B --reason R --evidence E --next N
//          [--pr <url>] [--review opened|"changes requested (n)"|approved|merged] [--skip-reason S]
//          [--left <state>] [--blocker-type T --blocker-dependency D --blocker-requirement Q --blocker-owner O]
//          (--left is the state a Blocked issue returns to; a move out of Blocked needs it)
// The legal moves are data in ../workflow.json; the update's shape is ../templates/status-update.md.

const fs = require('fs');
const path = require('path');

const WORKFLOW = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflow.json'), 'utf8'));
const BLOCKER_TYPES = ['product ambiguity', 'technical decision', 'dependency', 'environment', 'ownership', 'external service', 'missing access'];
const REVIEWS = /^(opened|approved|merged|changes requested \(\d+\))$/;

const typeOf = name => (WORKFLOW.states.find(s => s.name === name) || {}).type;
const isTerminal = name => ['completed', 'canceled', 'duplicate'].includes(typeOf(name));

// Returns { ok, skipped, error }. skipped lists the states passed over on a forward skip.
function checkMove(from, to, { reason, left } = {}) {
  if (!typeOf(from)) return { ok: false, error: `unknown state "${from}"` };
  if (!typeOf(to)) return { ok: false, error: `unknown state "${to}"` };
  if (from === to) return { ok: false, error: `issue is already ${to}` };
  if (isTerminal(from)) return { ok: false, error: `${from} has no way out; a regression is a new bug issue` };
  if (to === 'Canceled' || to === 'Duplicate') return { ok: true, skipped: [] };
  if (to === 'Blocked') {
    return ['unstarted', 'started'].includes(typeOf(from)) ? { ok: true, skipped: [] } : { ok: false, error: `${from} cannot be Blocked` };
  }
  if (from === 'Blocked') {
    if (!left) return { ok: false, error: 'a Blocked issue returns to the state it left: pass --left <state>' };
    if (!['unstarted', 'started'].includes(typeOf(left)) || left === 'Blocked') {
      return { ok: false, error: `${left} cannot be the state a Blocked issue left: it must be a live state other than Blocked` };
    }
    return to === left ? { ok: true, skipped: [] } : { ok: false, error: `a Blocked issue returns to ${left}, not ${to}` };
  }
  if ((WORKFLOW.transitions[from] || []).includes(to)) return { ok: true, skipped: [] };
  if (!reason) return { ok: false, error: `${from} → ${to} skips states or goes off the workflow; record the reason with --reason (M3)` };
  return { ok: true, skipped: passedOver(from, to) };
}

// The states a move jumps over: the intermediate states of the shortest legal path from `from` to `to`.
// A move with no legal path at all (a backwards move) skips nothing and is named as such by the caller.
function passedOver(from, to) {
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const here = queue.shift();
    if (here === to) break;
    for (const next of WORKFLOW.transitions[here] || []) {
      if (!prev.has(next)) { prev.set(next, here); queue.push(next); }
    }
  }
  if (!prev.has(to)) return [];
  const path = [];
  for (let s = prev.get(to); s !== null && s !== from; s = prev.get(s)) path.unshift(s);
  return path;
}

function renderUpdate(f) {
  const errors = [];
  for (const key of ['persona', 'model', 'effort', 'harness', 'field', 'from', 'to', 'reason', 'evidence', 'next']) {
    if (!f[key]) errors.push(`missing ${key}`);
  }
  if (f.review && !REVIEWS.test(f.review)) errors.push(`review must be opened, approved, merged, or "changes requested (n)": got "${f.review}"`);
  // Any spelling of the state field is the state field: a lowercase or padded name must not skip the move checks.
  const isState = typeof f.field === 'string' && f.field.trim().toLowerCase() === 'state';
  const blocked = isState && f.to === 'Blocked';
  const blockerKeys = ['blockerType', 'blockerDependency', 'blockerRequirement', 'blockerOwner'];
  if (blocked) {
    for (const k of blockerKeys) if (!f[k]) errors.push(`a Blocked update needs ${k}`);
    if (f.blockerType && !BLOCKER_TYPES.includes(f.blockerType)) errors.push(`blocker type must be one of: ${BLOCKER_TYPES.join(' | ')}`);
  } else if (blockerKeys.some(k => f[k])) {
    errors.push('blocker fields only belong on a move to Blocked');
  }
  let skipped = [];
  if (isState && f.from && f.to) {
    const move = checkMove(f.from, f.to, { reason: f.skipReason, left: f.left });
    if (!move.ok) errors.push(move.error);
    else skipped = move.skipped;
  }
  if (errors.length) return { errors };
  const change = `${f.field} ${f.from} → ${f.to}`;
  // A reason is recorded whenever one was given for a move that is not on the workflow: either states were passed over,
  // or the move has no forward path at all (a regression). A clean move names no skip.
  const clean = (WORKFLOW.transitions[f.from] || []).includes(f.to);
  let note = '';
  if (skipped.length) note = ` (skipped ${skipped.join(', ')}${f.skipReason ? `: ${f.skipReason}` : ''})`;
  else if (!clean && f.skipReason) note = ` (off-path move: ${f.skipReason})`;
  const lines = [
    '### Status update',
    `- By: ${f.persona} on ${f.model} / ${f.effort} / ${f.harness}`,
    `- Change: ${change}${note}`,
    `- PR: ${f.pr || 'n/a'} — review: ${f.review || 'n/a'}`,
    `- Reason: ${f.reason}`,
    `- Evidence: ${f.evidence}`,
    `- Next action: ${f.next}`,
  ];
  if (blocked) {
    lines.push('- Blocker (only when Blocked):', `  - Type: ${f.blockerType}`, `  - Dependency: ${f.blockerDependency}`, `  - Requirement: ${f.blockerRequirement}`, `  - Owner: ${f.blockerOwner}`);
  }
  return { text: lines.join('\n') };
}

function parseFlags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument: ${argv[i]}`);
    f[argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[i + 1];
  }
  return f;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'check') {
      const [from, to, ...flags] = rest;
      const result = checkMove(from, to, parseFlags(flags));
      if (!result.ok) { console.error(`linear-status: ${result.error}`); process.exit(1); }
      console.log(result.skipped.length ? `ok, skipped: ${result.skipped.join(', ')}` : 'ok');
      return;
    }
    if (cmd === 'render') {
      const result = renderUpdate(parseFlags(rest));
      if (result.errors) { for (const e of result.errors) console.error(`linear-status: ${e}`); process.exit(1); }
      console.log(result.text);
      return;
    }
  } catch (err) {
    console.error(`linear-status: ${err.message}`);
    process.exit(2);
  }
  console.error('usage: linear-status.js check <from> <to> [--reason R] [--left S] | render --persona P --model M ... [--left S] ...');
  process.exit(2);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { checkMove, renderUpdate, BLOCKER_TYPES };
