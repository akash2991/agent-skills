#!/usr/bin/env node
'use strict';

// Creates this agent's own worktree and prints the names derived from it (development-setup DS2, DS3).
//   new-worktree.js create <TICKET-slug> [--base <ref>] [--ports <n>] [--dry-run]
//   new-worktree.js remove <TICKET-slug>
// Run from the main checkout or any worktree of it. The worktree is placed beside the main checkout, never inside it.
// Prints shell exports: AGENT_NAME (the worktree basename), COMPOSE_PROJECT_NAME (lowercase), and n free host ports.

const { execFileSync } = require('child_process');
const fs = require('fs');
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

// Single-quote a value for POSIX shell so a path with spaces or metacharacters is set verbatim.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function git(args, cwd) {
  return execFileSync('git', args, { encoding: 'utf8', cwd }).trim();
}

// The first entry of `git worktree list` is the main checkout, also for separate-git-dir repos and submodules.
function mainCheckout() {
  const first = git(['worktree', 'list', '--porcelain']).split('\n').find(l => l.startsWith('worktree '));
  return first.slice('worktree '.length);
}

// The default base is origin's default branch when it is known; `main` is only the fallback.
// A fetched origin/<default> is the base: a local main that is days behind would start every ticket branch stale.
function defaultBase(root, { fetch = true } = {}) {
  let name;
  try { name = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root).replace(/^origin\//, ''); }
  catch { return 'main'; }
  if (!fetch) return `origin/${name}`;
  try { git(['fetch', '--quiet', 'origin', name], root); return `origin/${name}`; }
  catch { return name; }
}

// Ports this agent claims are recorded in the common git dir so agents started in parallel do not get the same ones.
function claimFile(root) {
  return path.join(path.resolve(root, git(['rev-parse', '--git-common-dir'], root)), 'brain-port-claims.json');
}

function readClaims(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// Parallel agents must not read the same free ports: take an exclusive lock file in the common git dir around
// read, probe and write. A lock left by a crashed run is removed once it is older than a minute.
async function withLock(file, fn) {
  const lock = `${file}.lock`;
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; } // released between the two calls
      if (age > 60000) { fs.rmSync(lock, { force: true }); continue; }
      if (attempt > 600) throw new Error(`port claim file is locked: ${lock}`);
      await new Promise(r => setTimeout(r, 100));
    }
  }
  try { return await fn(); } finally { fs.rmSync(lock, { force: true }); }
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
  const dryRun = rest.includes('--dry-run');
  if (cmd === 'remove') {
    git(['worktree', 'remove', p.worktree], root);
    const file = claimFile(root);
    await withLock(file, () => {
      const claims = readClaims(file);
      delete claims[p.name];
      fs.writeFileSync(file, JSON.stringify(claims, null, 2));
    });
    console.log(`removed ${p.worktree}`);
    return;
  }
  const base = optionValue(rest, '--base') || defaultBase(root, { fetch: !dryRun });
  const count = Number(optionValue(rest, '--ports') || 0);
  // Ports are claimed before the worktree exists, so a failure here leaves nothing behind to clean up by hand.
  let ports = [];
  if (count) {
    let psOutput = '';
    try { psOutput = execFileSync('docker', ['ps', '--format', '{{.Ports}}'], { encoding: 'utf8' }); } catch { /* docker not running: only the bind test applies */ }
    const file = claimFile(root);
    ports = await withLock(file, async () => {
      const claims = readClaims(file);
      const claimed = new Set(Object.entries(claims).filter(([k]) => k !== p.name).flatMap(([, v]) => v));
      const found = await freePorts(count, new Set([...usedHostPorts(psOutput), ...claimed]));
      if (found.length < count) throw new Error(`only ${found.length} of ${count} host ports are free; free some or ask for fewer`);
      claims[p.name] = found;
      if (!dryRun) fs.writeFileSync(file, JSON.stringify(claims, null, 2));
      return found;
    });
  }
  if (dryRun) {
    console.error(`would run: git worktree add ${git(['branch', '--list', p.branch], root) ? '' : `-b ${p.branch} `}${p.worktree} ${base}`);
  } else if (fs.existsSync(p.worktree)) {
    // Reuse only this repository's worktree on this branch; any other directory with the name is someone else's.
    const listed = git(['worktree', 'list', '--porcelain'], root).split('\n').includes(`worktree ${path.resolve(p.worktree)}`);
    const onBranch = listed && git(['rev-parse', '--abbrev-ref', 'HEAD'], p.worktree) === p.branch;
    if (!onBranch) throw new Error(`${p.worktree} exists and is not this repository's worktree on ${p.branch}; refusing to reuse it`);
    console.error(`reusing existing worktree ${p.worktree}`);
  } else {
    try {
      const exists = git(['branch', '--list', p.branch], root) !== '';
      // --no-track: the branch does not track origin/main, so a plain push cannot land on main.
      git(exists ? ['worktree', 'add', p.worktree, p.branch] : ['worktree', 'add', '--no-track', '-b', p.branch, p.worktree, base], root);
    } catch (err) {
      if (count) {
        const file = claimFile(root);
        await withLock(file, () => {
          const claims = readClaims(file);
          delete claims[p.name];
          fs.writeFileSync(file, JSON.stringify(claims, null, 2));
        });
      }
      throw err;
    }
  }
  console.log(`export AGENT_NAME=${shellQuote(p.name)}`);
  console.log(`export WORKTREE=${shellQuote(p.worktree)}`);
  console.log(`export COMPOSE_PROJECT_NAME=${shellQuote(p.composeProject)}`);
  ports.forEach((port, i) => console.log(`export HOST_PORT_${i + 1}=${shellQuote(port)}`));
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => { console.error(`new-worktree: ${err.message}`); process.exit(1); });
}

module.exports = { plan, usedHostPorts, freePorts, shellQuote, mainCheckout, withLock };
