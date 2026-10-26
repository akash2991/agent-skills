#!/usr/bin/env node
'use strict';

// Creates this agent's own worktree and prints the names derived from it (development-setup DS2, DS3).
//   new-worktree.js create <TICKET-slug> [--base <ref>] [--ports <n>] [--dry-run]
//   new-worktree.js remove <TICKET-slug>
// Run from the main checkout or any worktree of it. The worktree is placed beside the main checkout, never inside it.
// Prints shell exports: AGENT_NAME (the worktree basename), COMPOSE_PROJECT_NAME (lowercase), and n free host ports.

const { execFileSync } = require('child_process');
const net = require('net');
const path = require('path');

const NAME = /^[A-Z][A-Z0-9]*-\d+-[a-z0-9]+(-[a-z0-9]+)*$/;
const FORBIDDEN_PARENTS = /(^|\/)(\.?herdr|\.claude|\.agents|\.gemini|\.pi|\.hermes|\.agent-brain)(\/|$)/;

function plan(name, mainCheckout) {
  if (!NAME.test(name)) throw new Error(`"${name}" is not <TICKET>-<slug>, for example ENG-123-login-form (DS2)`);
  const worktree = path.join(path.dirname(mainCheckout), name);
  if (FORBIDDEN_PARENTS.test(worktree)) throw new Error(`${worktree} is inside a harness or brain directory (DS2)`);
  return { name, branch: name, worktree, composeProject: name.toLowerCase() };
}

// `docker ps --format '{{.Ports}}'` lines such as "0.0.0.0:5432->5432/tcp, :::5432->5432/tcp".
function usedHostPorts(dockerPs) {
  const ports = new Set();
  for (const m of dockerPs.matchAll(/:(\d+)(?:-(\d+))?->/g)) {
    for (let p = Number(m[1]); p <= Number(m[2] || m[1]); p++) ports.add(p);
  }
  return ports;
}

function canListen(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });
}

async function freePorts(count, used, start = 20000, end = 29999) {
  const found = [];
  for (let p = start; p <= end && found.length < count; p++) {
    if (!used.has(p) && await canListen(p)) found.push(p);
  }
  return found;
}

function git(args, cwd) {
  return execFileSync('git', args, { encoding: 'utf8', cwd }).trim();
}

function mainCheckout() {
  const common = path.resolve(git(['rev-parse', '--path-format=absolute', '--git-common-dir']));
  return path.dirname(common);
}

function optionValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

async function main(argv) {
  const [cmd, name, ...rest] = argv;
  if (!['create', 'remove'].includes(cmd) || !name) {
    console.error('usage: new-worktree.js create <TICKET-slug> [--base <ref>] [--ports <n>] [--dry-run] | remove <TICKET-slug>');
    process.exit(2);
  }
  const root = mainCheckout();
  const p = plan(name, root);
  if (cmd === 'remove') {
    git(['worktree', 'remove', p.worktree], root);
    console.log(`removed ${p.worktree}`);
    return;
  }
  const base = optionValue(rest, '--base') || 'main';
  const exists = git(['branch', '--list', p.branch], root) !== '';
  const args = exists ? ['worktree', 'add', p.worktree, p.branch] : ['worktree', 'add', '-b', p.branch, p.worktree, base];
  if (rest.includes('--dry-run')) {
    console.error(`would run: git ${args.join(' ')}`);
  } else {
    git(args, root);
  }
  const count = Number(optionValue(rest, '--ports') || 0);
  let ports = [];
  if (count) {
    let psOutput = '';
    try { psOutput = execFileSync('docker', ['ps', '--format', '{{.Ports}}'], { encoding: 'utf8' }); } catch { /* docker not running: only the bind test applies */ }
    ports = await freePorts(count, usedHostPorts(psOutput));
  }
  console.log(`export AGENT_NAME=${p.name}`);
  console.log(`export WORKTREE=${p.worktree}`);
  console.log(`export COMPOSE_PROJECT_NAME=${p.composeProject}`);
  ports.forEach((port, i) => console.log(`export HOST_PORT_${i + 1}=${port}`));
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => { console.error(`new-worktree: ${err.message}`); process.exit(1); });
}

module.exports = { plan, usedHostPorts, freePorts };
