#!/usr/bin/env node
'use strict';

// Creates this agent's own worktree and prints the names derived from it (development-setup DS2, DS3).
//   new-worktree.js create <TICKET-slug> --owner <name> --persona <persona> [--base <ref>] [--ports <n>] [--dry-run]
//   new-worktree.js remove <TICKET-slug> --owner <name>
//
// The ledger (<git common dir>/brain-env-ledger.json) records every environment this script created: owner, branch,
// worktree path, ports. remove acts only on an entry the ledger holds for the same owner, whose worktree is registered
// with git, is on the recorded branch, and has no uncommitted or untracked changes. It never deletes a branch.
// Run from the main checkout or any worktree of it. The worktree is placed beside the main checkout, never inside it.
// Prints shell exports: AGENT_NAME (`<TICKET-slug> (<persona>)`, the visible name), COMPOSE_PROJECT_NAME (lowercase), and n free host ports.
//
// Create and remove each run whole under one lifecycle lock per repository (<git common dir>/brain-env-lifecycle.lock):
// every ownership check, worktree, ledger and port-claim change happens inside it. The port-claim lock is taken inside it,
// never the other way round.

const { execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const NAME = /^[A-Z][A-Z0-9]*-\d+-[a-z0-9]+(-[a-z0-9]+)*$/;
const PERSONA = /^[a-z0-9]+(-[a-z0-9]+)*$/;
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

// A port is free only when it binds on localhost and on every interface: a dev server on 127.0.0.1 and one on 0.0.0.0 both count.
function canListen(port) {
  const bindsOn = host => new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
  return bindsOn('127.0.0.1').then(ok => ok && bindsOn(undefined));
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
  catch {
    // A failed fetch never silently bases the work on a stale local branch: use the cached remote-tracking ref, or stop.
    try {
      git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`], root);
    } catch {
      throw new Error(`cannot fetch origin/${name} and no cached copy exists; pass --base <ref>`);
    }
    console.error(`warning: fetch of origin/${name} failed; basing on the cached origin/${name}`);
    return `origin/${name}`;
  }
}

// The repository's identity for port claims: its real common git dir, the same for the main checkout and every worktree,
// and different for two repositories that merely share an environment name.
function repoKey(root) {
  return fs.realpathSync(path.resolve(root, git(['rev-parse', '--git-common-dir'], root)));
}

function ledgerFile(root) {
  return path.join(path.resolve(root, git(['rev-parse', '--git-common-dir'], root)), 'brain-env-ledger.json');
}

// The one lock every create and remove in this repository takes first.
function lifecycleFile(root) {
  return path.join(path.resolve(root, git(['rev-parse', '--git-common-dir'], root)), 'brain-env-lifecycle');
}

// A missing file is empty. A file that exists but does not parse is an error: treating it as empty would make every
// entry look "not recorded" and let the next write erase them.
function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
  try { return JSON.parse(text); } catch { throw new Error(`${file} does not parse; fix or restore it before creating or removing environments`); }
}

// Write to a temporary file and rename it over the target, so a crash leaves the old content or the new, never half.
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// Port claims are machine-wide (DS3): two repositories on this machine must not get the same host ports before their
// containers start. The file lives in the user's home. Its shape is { "<repoKey>": { "<ENV-NAME>": [ports] } }.
function claimFile() {
  return path.join(require('os').homedir(), '.agent-brain', 'port-claims.json');
}

// Every port claimed by any entry other than this repository's entry for this environment. An entry in the older flat
// shape ({ "<ENV-NAME>": [ports] }, written by an earlier run of this script) has no repository: its ports stay claimed.
function claimedElsewhere(claims, repo, name) {
  const ports = new Set();
  for (const [r, envs] of Object.entries(claims)) {
    if (Array.isArray(envs)) {
      if (r !== name) for (const port of envs) ports.add(port);
      continue;
    }
    for (const [n, list] of Object.entries(envs)) {
      if (r === repo && n === name) continue;
      for (const port of list) ports.add(port);
    }
  }
  return ports;
}

// Parallel runs must not read the same free ports or the same ledger: take a lock file around each critical section.
// A lock records the process that holds it as "<pid> <time> <random>". It is reclaimed only when that process is gone,
// never by age alone, and release removes only the lock this run published.
//
// Atomicity: the token is written to a staging file and hard-linked to the lock name. link fails if the lock exists and
// publishes a complete file in one step, so no contender can read an empty or half-written lock.
//
// Stale reclamation: a contender that judges the holder dead renames the lock to a name only it uses. Of the contenders
// that judged the same dead lock, one rename wins and the others find nothing to rename. If the renamed file is not the
// token that was judged dead (the lock was republished in between), it is linked back to the lock name.
function holderAlive(text) {
  const pid = Number(String(text).split(' ')[0]);
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function unique() {
  return `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
}

function publish(lock, token) {
  const staging = `${lock}.${unique()}.tmp`;
  fs.writeFileSync(staging, token);
  try {
    fs.linkSync(staging, lock);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    fs.rmSync(staging, { force: true });
  }
}

function readToken(lock) {
  try { return fs.readFileSync(lock, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

function reclaimStale(lock, judged) {
  const grabbed = `${lock}.stale.${unique()}`;
  try { fs.renameSync(lock, grabbed); } catch (err) { if (err.code === 'ENOENT') return; throw err; }
  if (fs.readFileSync(grabbed, 'utf8') !== judged) {
    // We took a lock published after we judged the dead one: put it back if the name is still free.
    try { fs.linkSync(grabbed, lock); } catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
  fs.rmSync(grabbed, { force: true });
}

async function withLock(file, fn) {
  const lock = `${file}.lock`;
  const token = `${process.pid} ${Date.now()} ${Math.random()}`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let attempt = 0;
  while (!publish(lock, token)) {
    const held = readToken(lock);
    if (held === null) continue; // released between the two calls
    if (!holderAlive(held)) { reclaimStale(lock, held); continue; }
    if (attempt++ > 600) throw new Error(`lock file is held by another run: ${lock}`);
    await new Promise(r => setTimeout(r, 100));
  }
  try { return await fn(); } finally {
    if (readToken(lock) === token) fs.rmSync(lock, { force: true });
  }
}

// The owner is the name the agent declares with --owner on create and on remove. It guards against mistakes between
// agents on one machine; it is not an authentication, since anyone who can run the script can type any name.
function requireOwner(rest) {
  const owner = optionValue(rest, '--owner');
  if (!owner) throw new Error('--owner <name> is required: the same name on create and on remove');
  return owner;
}

function optionValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

// Releases this environment's port claim; used by remove and by a create that failed after claiming.
async function releaseClaim(repo, name) {
  const file = claimFile();
  await withLock(file, () => {
    const claims = readJson(file);
    if (claims[repo]) {
      delete claims[repo][name];
      if (Object.keys(claims[repo]).length === 0) delete claims[repo];
    }
    writeJson(file, claims);
  });
}

async function remove(p, root, owner, ledger) {
  const entry = readJson(ledger)[p.name];
  if (!entry) throw new Error(`${p.name} is not in the ledger: this script did not create it, so it is not removed`);
  if (entry.owner !== owner) throw new Error(`${p.name} belongs to ${entry.owner}, not ${owner}; refusing to touch it`);
  if (path.resolve(entry.worktree) !== path.resolve(p.worktree)) throw new Error(`ledger path ${entry.worktree} does not match ${p.worktree}`);
  const registered = git(['worktree', 'list', '--porcelain'], root).split('\n').includes(`worktree ${path.resolve(p.worktree)}`);
  if (!registered) throw new Error(`${p.worktree} is not a worktree of this repository; refusing to remove it`);
  if (fs.existsSync(p.worktree)) {
    const onBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], p.worktree);
    if (onBranch !== entry.branch) throw new Error(`${p.worktree} is on ${onBranch}, not ${entry.branch}; refusing to remove it`);
    if (git(['status', '--porcelain', '--untracked-files=all'], p.worktree) !== '') {
      throw new Error(`${p.worktree} has uncommitted or untracked changes; commit or stash them first, then remove`);
    }
    // No --force: git refuses a worktree with changes, and the branch is kept (a merged branch is deleted by its PR's cleanup).
    git(['worktree', 'remove', p.worktree], root);
  } else {
    // The directory was deleted by hand: git only needs its record pruned, and the ledger and ports are released.
    git(['worktree', 'prune'], root);
  }
  const all = readJson(ledger);
  delete all[p.name];
  writeJson(ledger, all);
  await releaseClaim(repoKey(root), p.name);
  console.log(`removed ${p.worktree}; branch ${entry.branch} kept`);
}

async function create(p, rest, root, owner, persona, dryRun, ledger) {
  const existing = readJson(ledger)[p.name];
  if (existing && existing.owner !== owner) throw new Error(`${p.name} belongs to ${existing.owner}, not ${owner}; refusing to take it over`);
  // A directory with this name that the ledger does not record is not ours to reuse: refuse before any port is claimed.
  if (!existing && fs.existsSync(p.worktree)) throw new Error(`${p.worktree} exists and the ledger does not record it; refusing to reuse it`);
  const base = optionValue(rest, '--base') || defaultBase(root, { fetch: !dryRun });
  const count = Number(optionValue(rest, '--ports') || 0);
  // Reuse only this repository's worktree on this branch; any other directory with the name is someone else's.
  let reuse = false;
  if (!dryRun && fs.existsSync(p.worktree)) {
    const listed = git(['worktree', 'list', '--porcelain'], root).split('\n').includes(`worktree ${path.resolve(p.worktree)}`);
    const onBranch = listed && git(['rev-parse', '--abbrev-ref', 'HEAD'], p.worktree) === p.branch;
    if (!onBranch) throw new Error(`${p.worktree} exists and is not this repository's worktree on ${p.branch}; refusing to reuse it`);
    reuse = true;
  }
  // Ports are claimed before the worktree exists, so a failure here leaves nothing behind to clean up by hand.
  let ports = [];
  const repo = repoKey(root);
  if (count) {
    let psOutput = '';
    try { psOutput = execFileSync('docker', ['ps', '--format', '{{.Ports}}'], { encoding: 'utf8' }); } catch { /* docker not running: only the bind test applies */ }
    const file = claimFile();
    ports = await withLock(file, async () => {
      const claims = readJson(file);
      // A reused worktree keeps the ports it already claimed, so its running containers keep their host ports.
      const mine = (claims[repo] || {})[p.name] || [];
      const kept = reuse ? mine.slice(0, count) : [];
      const claimed = claimedElsewhere(claims, repo, p.name);
      const more = count - kept.length;
      const found = more > 0 ? await freePorts(more, new Set([...usedHostPorts(psOutput), ...claimed, ...kept])) : [];
      if (found.length < more) throw new Error(`only ${found.length} of ${more} host ports are free; free some or ask for fewer`);
      const all = [...kept, ...found];
      if (!dryRun) {
        claims[repo] = { ...(claims[repo] || {}), [p.name]: all };
        writeJson(file, claims);
      }
      return all;
    });
  }
  if (dryRun) {
    console.error(`would run: git worktree add ${git(['branch', '--list', p.branch], root) ? '' : `-b ${p.branch} `}${p.worktree} ${base}`);
  } else if (reuse) {
    console.error(`reusing existing worktree ${p.worktree}`);
  } else {
    try {
      const exists = git(['branch', '--list', p.branch], root) !== '';
      // --no-track: the branch does not track origin/main, so a plain push cannot land on main.
      git(exists ? ['worktree', 'add', p.worktree, p.branch] : ['worktree', 'add', '--no-track', '-b', p.branch, p.worktree, base], root);
    } catch (err) {
      if (count) await releaseClaim(repo, p.name);
      throw err;
    }
  }
  if (!dryRun) {
    const all = readJson(ledger);
    // An entry that already exists keeps its owner: create cannot take over another agent's environment.
    if (all[p.name] && all[p.name].owner !== owner) throw new Error(`${p.name} belongs to ${all[p.name].owner}, not ${owner}; refusing to take it over`);
    all[p.name] = { owner, branch: p.branch, worktree: p.worktree,
      ports, composeProject: p.composeProject, createdAt: new Date().toISOString() };
    writeJson(ledger, all);
  }
  console.log(`export AGENT_NAME=${shellQuote(`${p.name} (${persona})`)}`);
  console.log(`export WORKTREE=${shellQuote(p.worktree)}`);
  console.log(`export COMPOSE_PROJECT_NAME=${shellQuote(p.composeProject)}`);
  ports.forEach((port, i) => console.log(`export HOST_PORT_${i + 1}=${shellQuote(port)}`));
}

async function main(argv) {
  const [cmd, name, ...rest] = argv;
  if (!['create', 'remove'].includes(cmd) || !name) {
    console.error('usage: new-worktree.js create <TICKET-slug> --persona <persona> [--base <ref>] [--ports <n>] [--dry-run] | remove <TICKET-slug>');
    process.exit(2);
  }
  const persona = optionValue(rest, '--persona');
  if (cmd === 'create' && !PERSONA.test(persona || '')) {
    console.error('new-worktree: create needs --persona <persona>, a kebab-case persona name such as backend-engineer (DS2)');
    process.exit(2);
  }
  const root = mainCheckout();
  const p = plan(name, root);
  const dryRun = rest.includes('--dry-run');
  const owner = requireOwner(rest);
  const ledger = ledgerFile(root);
  // The lifecycle lock covers the ownership checks and every mutation that follows them.
  await withLock(lifecycleFile(root), () => (cmd === 'remove'
    ? remove(p, root, owner, ledger)
    : create(p, rest, root, owner, persona, dryRun, ledger)));
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => { console.error(`new-worktree: ${err.message}`); process.exit(1); });
}

module.exports = { plan, usedHostPorts, freePorts, shellQuote, mainCheckout, withLock, ledgerFile, lifecycleFile, repoKey, claimFile, readJson };
