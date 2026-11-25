#!/usr/bin/env node
'use strict';

// Spawn and teardown of an agent's own environment (development-setup DS1-DS5, DS10, DS11; git-workflow-and-versioning P5-P7).
//   agent-env.js spawn <TICKET-slug> --owner <name> --persona <persona> [--base <ref>] [--ports <n>] [--no-install] [--no-compose] [--dry-run]
//   agent-env.js teardown <TICKET-slug> --owner <name> [--abandon]
// The owner is the name the agent declares on both; it guards against mistakes between agents on one machine, it is
// not an authentication.
//
// Spawn gives the agent everything it needs to start work, and is re-entrant: a resumed session runs it again.
//   1. Host ports, claimed machine-wide; a resumed spawn keeps the ports it holds, with or without --ports.
//   2. The worktree beside the main checkout: reused while it exists; otherwise added on the local branch, else on
//      origin's branch of that name, else on a new branch from the base (origin's default branch, fetched).
//   3. `.env` copied from the main checkout without AWS credentials (DS4), when git ignores it in the worktree and the
//      worktree has none; an existing one is never overwritten.
//   4. Dependencies installed from the root lockfile (one JavaScript and one Python lockfile at most), again whenever
//      the worktree is new or a lockfile changed.
//   5. The Compose project (the worktree name, lowercase), reserved machine-wide for this environment on this Docker
//      daemon and brought up, when the worktree has a compose file.
// Prints shell exports: AGENT_NAME (`<TICKET-slug> (<persona>)`, the visible name), WORKTREE, COMPOSE_PROJECT_NAME and
// HOST_PORT_<n>. Progress and tool output go to stderr, so stdout stays a list of exports.
//
// Ownership. The ledger (<git common dir>/brain-env-ledger.json) is written before the first side effect and records
// each one as it happens, so teardown can clean up a spawn that failed part-way. The worktree registration spawn made
// carries a random mark (in git's administrative directory) that the ledger repeats: a registration at the same path
// without it is not this environment's. The branch counts as spawn's only when the `add -b` that created it is proven
// spawn's (the intent recorded before `add` grants nothing), and only while it continues the commit spawn last
// recorded; a resume narrows that before it records a new commit. Teardown decides the branch once and records it;
// an interrupted delete is resolved by whether the branch is still there, never tried again. The Compose reservation (~/.agent-brain/compose-claims.json) makes everything
// under the project name this environment's while it is held; spawn takes it only for an empty project, and both
// commands refuse a project holding containers started outside this worktree.
//
// Teardown runs once the branch has merged into its base (P15 merge commits keep the branch tip an ancestor of it), or
// with --abandon for a canceled ticket. Every check runs before anything is removed: the owner, the mark, a clean
// worktree on its branch, the merge, and the Compose reservation on a reachable, matching daemon. Then, in order:
//   1. the worktree with everything inside it, ignored files included (no --force, so git can still refuse here);
//   2. the local branch, only when spawn created it, it merged, nothing holds it, and it is still at the verified tip;
//   3. the reserved Compose project's containers, networks and volumes (with the DS5 snapshot), and the reservation;
//   4. the port claims, then the ledger entry.
// The remote branch is merge-pr.js's (P7). Anything else is left in place and named. A teardown that stops part-way
// can be run again: whatever is already gone is skipped.
//
// Spawn and teardown each run whole under one lifecycle lock per repository (<git common dir>/brain-env-lifecycle.lock);
// the port-claim and Compose-reservation locks are taken inside it, never the other way round.

const { execFileSync, spawnSync } = require('child_process');
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

// The one lock every spawn and teardown in this repository takes first.
function lifecycleFile(root) {
  return path.join(path.resolve(root, git(['rev-parse', '--git-common-dir'], root)), 'brain-env-lifecycle');
}

// A missing file is empty. A file that exists but does not parse is an error: treating it as empty would make every
// entry look "not recorded" and let the next write erase them.
function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
  try { return JSON.parse(text); } catch { throw new Error(`${file} does not parse; fix or restore it before spawning or tearing down environments`); }
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
      for (const port of envs) ports.add(port);
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
// Stale reclamation: a dead token is removed only by the contender that creates the reclaim marker for that exact token
// (an exclusive create, so one contender at a time). While the marker exists, nobody else removes that lock, and the
// remover re-checks that the lock still holds the dead token. A lock already replaced by a live holder is left alone.
// Only a live holder can publish a new lock, and only when the name is free, so the check cannot race with a publish.
// A marker is never removed by age: a contender can be suspended between its check and its removal, so the marker stays
// until it is removed by hand. A marker left by a crashed contender blocks reclaiming that one dead lock; the timeout
// error names the lock so it can be cleared.
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

// Returns true when this call held the reclaim marker (and removed the lock only if it was still the dead token),
// false when another contender holds the marker.
function reclaimStale(lock, judged) {
  const digest = require('crypto').createHash('sha256').update(judged).digest('hex').slice(0, 16);
  const marker = `${lock}.reclaim-${digest}`;
  try {
    fs.writeFileSync(marker, unique(), { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return false;
  }
  try {
    // Only the marker holder removes this lock, so it is still the dead one unless it was already removed.
    if (readToken(lock) === judged) fs.rmSync(lock, { force: true });
  } finally {
    fs.rmSync(marker, { force: true });
  }
  return true;
}

async function withLock(file, fn) {
  const lock = `${file}.lock`;
  const token = `${process.pid} ${Date.now()} ${Math.random()}`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let attempt = 0;
  while (!publish(lock, token)) {
    const held = readToken(lock);
    const reclaimed = held !== null && !holderAlive(held) && reclaimStale(lock, held);
    if (reclaimed) continue;
    if (attempt++ > 600) throw new Error(`lock file is held by another run: ${lock} (if no run is active, remove it and any ${lock}.reclaim-* file)`);
    await new Promise(r => setTimeout(r, 100));
  }
  try { return await fn(); } finally {
    if (readToken(lock) === token) fs.rmSync(lock, { force: true });
  }
}


// Releases this environment's port claim; used by teardown and by a spawn that failed after claiming.
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

function claimedPorts(repo, name) {
  return ((readJson(claimFile())[repo] || {})[name]) || [];
}

// Compose project names are machine-wide in Docker, so their reservations are too: { "<project>": { repo, env, daemon } }.
// While a reservation is held, everything Docker holds under that project name belongs to that environment (DS11).
function composeClaimFile() {
  return path.join(require('os').homedir(), '.agent-brain', 'compose-claims.json');
}

function composeReservation(project) {
  return readJson(composeClaimFile())[project] || null;
}

async function releaseCompose(project, repo, name) {
  const file = composeClaimFile();
  await withLock(file, () => {
    const claims = readJson(file);
    const held = claims[project];
    if (held && held.repo === repo && held.env === name) {
      delete claims[project];
      writeJson(file, claims);
    }
  });
}

function registeredWorktree(root, worktree) {
  return git(['worktree', 'list', '--porcelain'], root).split('\n').includes(`worktree ${path.resolve(worktree)}`);
}

// Git's administrative directory for the worktree registered at this path, found by its `gitdir` file, also when the
// directory itself is gone. null when no registration names the path.
function adminDir(root, worktree) {
  const dir = path.join(path.resolve(root, git(['rev-parse', '--git-common-dir'], root)), 'worktrees');
  if (!fs.existsSync(dir)) return null;
  const wanted = new Set([path.join(path.resolve(worktree), '.git')]);
  try { wanted.add(path.join(resolvedWorktree(worktree), '.git')); } catch { /* parent gone */ }
  for (const id of fs.readdirSync(dir)) {
    let gitdir;
    try { gitdir = fs.readFileSync(path.join(dir, id, 'gitdir'), 'utf8').trim(); } catch { continue; }
    if (wanted.has(path.resolve(gitdir))) return path.join(dir, id);
  }
  return null;
}

// Spawn proves which registration it made with a random mark. The mark is recorded in the ledger and handed to git
// as the lock reason of `git worktree add --lock`, which git writes before the checkout starts, so even a spawn killed
// mid-checkout left proof; afterwards it is also written as a file in the registration and the lock is lifted.
// A registration is this environment's only when its mark file or its lock reason carries the ledger's mark and, while
// the directory exists, the checkout there points back to that same registration.
const MARK = 'brain-env-mark';
const LOCK_PREFIX = 'brain-env:';

function markOf(admin) {
  try { return fs.readFileSync(path.join(admin, MARK), 'utf8').trim(); } catch { return null; }
}

function lockReasonOf(admin) {
  try { return fs.readFileSync(path.join(admin, 'locked'), 'utf8').trim(); } catch { return null; }
}

// The registration at this path when it is provably this environment's, else null; throws when one exists but is not.
// A registration git still holds under spawn's own lock (a spawn interrupted after `add` began) is finished here:
// the mark file is written first, then only spawn's own lock is lifted.
function ownedRegistration(root, worktree, mark) {
  const admin = adminDir(root, worktree);
  if (!admin) return null;
  const byFile = Boolean(mark) && markOf(admin) === mark;
  const byLock = Boolean(mark) && lockReasonOf(admin) === `${LOCK_PREFIX}${mark}`;
  if (!byFile && !byLock) throw new Error(`the worktree registered at ${worktree} is not the one spawn made (no matching mark); leave it, or clean it up by hand`);
  if (fs.existsSync(worktree)) {
    let back;
    try { back = git(['rev-parse', '--absolute-git-dir'], worktree); } catch { back = null; }
    if (!back || fs.realpathSync(back) !== fs.realpathSync(admin)) {
      throw new Error(`${worktree} is not the checkout of spawn's registration; leave it, or clean it up by hand`);
    }
  }
  if (!byFile) fs.writeFileSync(path.join(admin, MARK), mark);
  if (byLock) git(['worktree', 'unlock', worktree], root);
  return admin;
}

function branchTip(root, branch) {
  try { return git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root); } catch { return null; }
}

function isAncestor(root, a, b) {
  try { git(['merge-base', '--is-ancestor', a, b], root); return true; } catch { return false; }
}

// The authority to delete the branch: spawn created it, and it still continues the commit spawn last recorded.
// A branch deleted and made again by hand at the same name does not continue it, so it is not spawn's.
function branchOwned(root, entry, tip) {
  return Boolean(entry.branchCreated && tip && entry.branchTip && isAncestor(root, entry.branchTip, tip));
}

// A branch spawn asked git to create (`add -b`, which refuses a branch that already exists) becomes spawn's only once
// the registration that add made is proven this spawn's, by its mark or spawn's lock reason, holds the branch, and
// the branch still continues the commit it was created from. The intent recorded before `add` grants nothing by
// itself; it is settled once, here, and then cleared.
function settleBranchIntent(root, ledger, name, worktree, branch) {
  const entry = readJson(ledger)[name];
  const pending = entry && entry.branchPending;
  if (!pending) return;
  const admin = adminDir(root, worktree);
  let proven = false;
  if (admin && pending.mark && pending.mark === entry.mark) {
    const byMark = markOf(admin) === pending.mark || lockReasonOf(admin) === `${LOCK_PREFIX}${pending.mark}`;
    let head = '';
    try { head = fs.readFileSync(path.join(admin, 'HEAD'), 'utf8').trim(); } catch { /* no HEAD: not proven */ }
    proven = byMark && head === `ref: refs/heads/${branch}`;
  }
  const tip = branchTip(root, branch);
  const fields = { branchPending: null };
  if (pending.create && proven && tip && pending.startTip && isAncestor(root, pending.startTip, tip)) {
    fields.branchCreated = true;
    fields.branchTip = tip;
  }
  updateEntry(ledger, name, fields);
}

// The worktrees that have this branch checked out.
function holdersOf(root, branch) {
  const holders = [];
  let current = null;
  for (const line of git(['worktree', 'list', '--porcelain'], root).split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    if (line === `branch refs/heads/${branch}`) holders.push(current);
  }
  return holders;
}

function updateEntry(ledger, name, fields) {
  const all = readJson(ledger);
  all[name] = { ...all[name], ...fields };
  writeJson(ledger, all);
}

// A base on origin is fetched first, so "merged" and "new branch" are judged against origin's copy; a failed fetch
// falls back to the cached ref with a warning. A local base (a repository without origin) is used as it is.
function refreshBase(root, base) {
  const m = /^origin\/(.+)$/.exec(base);
  if (!m) return;
  try { git(['fetch', '--quiet', 'origin', m[1]], root); } catch { console.error(`warning: fetch of ${base} failed; using the cached copy`); }
}

// Where an existing branch of this name lives on origin. `ls-remote` asks origin itself, because the cached
// remote-tracking ref outlives a branch merge-pr.js deleted. Unreachable origin: the cached ref, with a warning.
function remoteBranch(root, branch) {
  if (!git(['remote'], root).split('\n').includes('origin')) return null;
  const ref = `refs/remotes/origin/${branch}`;
  try {
    if (git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], root) === '') return null;
    git(['fetch', '--quiet', 'origin', `+refs/heads/${branch}:${ref}`], root);
    return `origin/${branch}`;
  } catch {
    try { git(['rev-parse', '--verify', '--quiet', ref], root); } catch { return null; }
    console.error(`warning: origin is unreachable; using the cached origin/${branch}`);
    return `origin/${branch}`;
  }
}

// Child output goes to stderr: stdout carries only the exports.
function run(cmd, args, cwd, env) {
  const r = spawnSync(cmd, args, { cwd, env, stdio: ['ignore', 2, 2] });
  if (r.error) throw new Error(`${cmd} could not run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
}

// One installer per ecosystem: the first lockfile found in each group, at the worktree root.
const INSTALLERS = [
  [['package-lock.json', 'npm', ['ci']], ['pnpm-lock.yaml', 'pnpm', ['install', '--frozen-lockfile']],
    ['yarn.lock', 'yarn', ['install', '--frozen-lockfile']], ['bun.lock', 'bun', ['install', '--frozen-lockfile']],
    ['bun.lockb', 'bun', ['install', '--frozen-lockfile']]],
  [['uv.lock', 'uv', ['sync', '--frozen']], ['poetry.lock', 'poetry', ['install']]],
];

function installers(worktree) {
  return INSTALLERS.map(group => group.find(([lock]) => fs.existsSync(path.join(worktree, lock)))).filter(Boolean);
}

// What a successful install covered: the selected lockfiles and their content. A changed lockfile installs again.
function lockFingerprint(worktree, selected) {
  const hash = require('crypto').createHash('sha256');
  for (const [lock] of selected) hash.update(`${lock}\0`).update(fs.readFileSync(path.join(worktree, lock))).update('\0');
  return hash.digest('hex');
}

// AWS credentials never enter a development environment (DS4): these variables are dropped from the copied .env.
const AWS_CREDENTIALS = /^\s*(export\s+)?(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_SECURITY_TOKEN|AWS_PROFILE|AWS_DEFAULT_PROFILE|AWS_ROLE_ARN|AWS_WEB_IDENTITY_TOKEN_FILE|AWS_CREDENTIAL_EXPIRATION)\s*=/;

function withoutAwsCredentials(text) {
  const dropped = [];
  const kept = text.split('\n').filter(line => {
    const m = AWS_CREDENTIALS.exec(line);
    if (m) dropped.push(m[2]);
    return !m;
  });
  return { text: kept.join('\n'), dropped };
}

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

function composeFile(worktree) {
  return COMPOSE_FILES.find(f => fs.existsSync(path.join(worktree, f)));
}

// Whether the commit a new worktree will check out has a compose file at its root.
function composeInRef(root, ref) {
  try { return git(['ls-tree', '--name-only', ref], root).split('\n').some(f => COMPOSE_FILES.includes(f)); } catch { return false; }
}

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Every Docker call in one run goes to one endpoint: the context current when the run starts is pinned through
// DOCKER_CONTEXT, which every docker child inherits, so a `docker context use` elsewhere cannot move the run.
function pinDockerContext() {
  if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT) return;
  try { const ctx = docker(['context', 'show']); if (ctx) process.env.DOCKER_CONTEXT = ctx; } catch { /* no docker */ }
}

// The ID of the Docker daemon the run talks to, or null when none answers. A reservation is bound to it.
function dockerDaemon() {
  try { return docker(['info', '--format', '{{.ID}}']) || null; } catch { return null; }
}

// Everything Docker holds under this Compose project, by Compose's own label; containers carry the directory they
// were started from (com.docker.compose.project.working_dir, a resolved path).
function composeResources(project) {
  const label = `label=com.docker.compose.project=${project}`;
  const lines = out => out.split('\n').filter(Boolean);
  const containers = lines(docker(['ps', '-a', '--filter', label, '--format', '{{.ID}}\t{{.Label "com.docker.compose.project.working_dir"}}']))
    .map(l => { const [id, dir] = l.split('\t'); return { id, dir }; });
  const volumes = lines(docker(['volume', 'ls', '-q', '--filter', label]));
  const networks = lines(docker(['network', 'ls', '-q', '--filter', label]));
  return { containers, volumes, networks, empty: !containers.length && !volumes.length && !networks.length };
}

// The resolved worktree path, as Compose records it, also before the worktree exists.
function resolvedWorktree(worktree) {
  return path.join(fs.realpathSync(path.dirname(worktree)), path.basename(worktree));
}

function foreignContainers(resources, worktree) {
  const mine = resolvedWorktree(worktree);
  return resources.containers.filter(c => c.dir !== mine);
}

// Why this environment may not use the Compose project, or null. Read-only; spawn asks it again under the lock.
function composeRefusal(project, repo, name, daemon, worktree) {
  const held = composeReservation(project);
  if (held && (held.repo !== repo || held.env !== name)) {
    return `Compose project ${project} is reserved by ${held.env} in ${held.repo}; two environments cannot share one name (DS3)`;
  }
  if (held && held.daemon !== daemon) return `Compose project ${project} is reserved on Docker daemon ${held.daemon}, not ${daemon}; switch back to that context`;
  const resources = composeResources(project);
  if (!held && !resources.empty) return `Compose project ${project} already has resources this environment did not create; refusing to claim it (DS3)`;
  const foreign = foreignContainers(resources, worktree);
  if (foreign.length) return `Compose project ${project} has containers started outside ${worktree} (${foreign.map(c => c.id).join(', ')}); refusing to share it (DS3)`;
  return null;
}

// An entry written by the earlier new-worktree.js carries no mark, so nothing proves which registration, branch, or
// stack it made: both commands refuse it before changing anything.
function refuseLegacy(entry, name) {
  if (entry && !('mark' in entry)) {
    throw new Error(`${name} is a legacy environment from new-worktree.js: inspect and clean up its worktree, branch, Compose stack and port claims by hand, then remove its entry from the ledger`);
  }
}

async function spawnEnv(p, opts, root, owner, persona, ledger) {
  const { dryRun } = opts;
  const repo = repoKey(root);
  const existing = readJson(ledger)[p.name];
  if (existing && existing.owner !== owner) throw new Error(`${p.name} belongs to ${existing.owner}, not ${owner}; refusing to take it over`);
  refuseLegacy(existing, p.name);
  const present = fs.existsSync(p.worktree);
  // A directory or registration with this name that the ledger does not record is not ours to reuse.
  if (!existing && (present || adminDir(root, p.worktree))) throw new Error(`${p.worktree} exists and the ledger does not record it; refusing to reuse it`);
  const admin = existing ? ownedRegistration(root, p.worktree, existing.mark) : null;
  if (existing && existing.branchPending && !dryRun) settleBranchIntent(root, ledger, p.name, p.worktree, p.branch);
  if (present && !admin) throw new Error(`${p.worktree} exists and is not a worktree of this repository; refusing to reuse it`);
  const reuse = present && Boolean(admin);
  if (reuse && git(['rev-parse', '--abbrev-ref', 'HEAD'], p.worktree) !== p.branch) {
    throw new Error(`${p.worktree} is not on ${p.branch}; refusing to reuse it`);
  }
  const base = opts.base || (existing && existing.base) || defaultBase(root, { fetch: !dryRun });

  // Ports: a resumed spawn keeps the ports it holds, also when --ports is left out; a different count is refused.
  const held = existing ? claimedPorts(repo, p.name) : [];
  if (opts.ports !== undefined && held.length && opts.ports !== held.length) {
    throw new Error(`${p.name} holds ${held.length} host ports; spawn again without --ports, or with --ports ${held.length}`);
  }
  const count = opts.ports !== undefined ? opts.ports : held.length;

  // Where a new worktree will start: the local branch, else origin's, else a new branch from the base.
  const tip = reuse ? null : branchTip(root, p.branch);
  const remote = reuse || tip ? null : remoteBranch(root, p.branch);
  const startRef = reuse ? null : (tip ? p.branch : (remote || base));

  // Compose, read-only, before anything is created, and only for a checkout that has a compose file or a project
  // this environment already reserved; checked again under the reservation lock before `up`.
  if (opts.compose) pinDockerContext();
  const daemon = opts.compose ? dockerDaemon() : null;
  const reservation = composeReservation(p.composeProject);
  const ownReservation = Boolean(reservation && reservation.repo === repo && reservation.env === p.name);
  const needsCompose = reuse ? Boolean(composeFile(p.worktree)) : composeInRef(root, startRef);
  if (daemon && (needsCompose || ownReservation)) {
    const refusal = composeRefusal(p.composeProject, repo, p.name, daemon, p.worktree);
    if (refusal) throw new Error(refusal);
  }

  const exportsFor = ports => {
    console.log(`export AGENT_NAME=${shellQuote(`${p.name} (${persona})`)}`);
    console.log(`export WORKTREE=${shellQuote(p.worktree)}`);
    console.log(`export COMPOSE_PROJECT_NAME=${shellQuote(p.composeProject)}`);
    ports.forEach((port, i) => console.log(`export HOST_PORT_${i + 1}=${shellQuote(port)}`));
  };
  if (dryRun) {
    console.error(reuse ? `would reuse ${p.worktree}` : `would add the worktree ${p.worktree} on ${p.branch} from ${startRef}`);
    exportsFor(held.slice(0, count));
    return;
  }

  // The ledger entry comes first: from here on every side effect is recorded, so teardown can clean up a failed spawn.
  const all = readJson(ledger);
  if (all[p.name] && all[p.name].owner !== owner) throw new Error(`${p.name} belongs to ${all[p.name].owner}, not ${owner}; refusing to take it over`);
  all[p.name] = { mark: null, branchCreated: false, branchTip: null, envCopied: false, installedFingerprint: null, ports: [],
    ...all[p.name], owner, persona, branch: p.branch, worktree: p.worktree, base, composeProject: p.composeProject,
    spawnedAt: new Date().toISOString() };
  delete all[p.name].branchOutcome;
  writeJson(ledger, all);

  // 1. Host ports, claimed machine-wide (DS3).
  let ports = held.slice(0, count);
  if (count > ports.length) {
    let psOutput = '';
    try { psOutput = execFileSync('docker', ['ps', '--format', '{{.Ports}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* docker not running: only the bind test applies */ }
    const file = claimFile();
    ports = await withLock(file, async () => {
      const claims = readJson(file);
      const claimed = claimedElsewhere(claims, repo, p.name);
      const more = count - ports.length;
      const found = await freePorts(more, new Set([...usedHostPorts(psOutput), ...claimed, ...ports]));
      if (found.length < more) throw new Error(`only ${found.length} of ${more} host ports are free; free some or ask for fewer`);
      const mine = [...ports, ...found];
      claims[repo] = { ...(claims[repo] || {}), [p.name]: mine };
      writeJson(file, claims);
      return mine;
    });
  }
  updateEntry(ledger, p.name, { ports });

  // 2. The worktree. The mark and the branch intent are recorded before `add`; git holds the mark as its lock reason.
  if (!reuse) {
    const entry = readJson(ledger)[p.name];
    // A lost directory whose registration is still spawn's: drop that one registration, nothing else (never prune).
    if (admin) git(['worktree', 'remove', '--force', p.worktree], root);
    const mark = require('crypto').randomBytes(16).toString('hex');
    // Ownership of an existing branch is only ever kept, never gained: it stays spawn's while it continues the tip
    // spawn recorded. A branch spawn is about to create is only an intent until the add is proven (settleBranchIntent).
    const branchCreated = tip ? branchOwned(root, entry, tip) : false;
    const startTip = tip ? null : git(['rev-parse', `${startRef}^{commit}`], root);
    updateEntry(ledger, p.name, { mark, branchCreated, branchPending: { create: !tip, mark, startTip }, installedFingerprint: null });
    const lock = ['--lock', '--reason', `${LOCK_PREFIX}${mark}`];
    const args = tip ? ['worktree', 'add', ...lock, p.worktree, p.branch]
      // A new branch does not track origin's default branch, so a plain push cannot land on it.
      : remote ? ['worktree', 'add', ...lock, '--track', '-b', p.branch, p.worktree, remote]
        : ['worktree', 'add', ...lock, '--no-track', '-b', p.branch, p.worktree, base];
    let failure = null;
    try { git(args, root); } catch (err) { failure = err; }
    // Even a failed add (a failing checkout hook) can leave a registration: it carries spawn's lock, so it is proven
    // spawn's, marked, and unlocked here; only then does the branch it created become spawn's.
    ownedRegistration(root, p.worktree, mark);
    settleBranchIntent(root, ledger, p.name, p.worktree, p.branch);
    if (failure) throw failure;
    console.error(`${existing ? 'restored' : 'added'} ${p.worktree} on ${p.branch}`);
  } else {
    console.error(`reusing ${p.worktree}`);
  }
  // The recorded commit moves forward only along the branch: authority is narrowed first when HEAD no longer continues
  // it (a branch rewritten in place), then HEAD is recorded.
  const head = git(['rev-parse', 'HEAD'], p.worktree);
  const now = readJson(ledger)[p.name];
  updateEntry(ledger, p.name, { branchCreated: Boolean(now.branchCreated && now.branchTip && isAncestor(root, now.branchTip, head)), branchTip: head });

  // 3. .env from the main checkout without AWS credentials (DS4), never over the worktree's own, and only when git
  //    ignores it there: a copied secret git would commit is a leak waiting for `git add -A`.
  const source = path.join(root, '.env');
  const target = path.join(p.worktree, '.env');
  if (fs.existsSync(source) && !fs.existsSync(target)) {
    if (spawnSync('git', ['check-ignore', '-q', '.env'], { cwd: p.worktree }).status === 0) {
      const { text, dropped } = withoutAwsCredentials(fs.readFileSync(source, 'utf8'));
      fs.writeFileSync(target, text, { flag: 'wx', mode: fs.statSync(source).mode & 0o777 });
      updateEntry(ledger, p.name, { envCopied: true });
      console.error(`copied .env from ${root}${dropped.length ? `, without ${dropped.join(', ')} (DS4)` : ''}`);
    } else {
      console.error(`.env not copied: git does not ignore it in ${p.worktree}; add it to .gitignore first`);
    }
  }

  // 4. Dependencies: installed again whenever the worktree is new or a selected lockfile changed.
  const selected = installers(p.worktree);
  if (opts.install && selected.length) {
    const fingerprint = lockFingerprint(p.worktree, selected);
    if (readJson(ledger)[p.name].installedFingerprint !== fingerprint) {
      for (const [lock, cmd, args] of selected) {
        console.error(`installing from ${lock}: ${cmd} ${args.join(' ')}`);
        run(cmd, args, p.worktree, process.env);
      }
      updateEntry(ledger, p.name, { installedFingerprint: fingerprint });
    }
  }

  // 5. The Compose project: reserved machine-wide for this environment on the daemon the run is pinned to, then
  //    brought up on the ports. The daemon is read again under the lock: a different one refuses.
  const file = composeFile(p.worktree);
  if (opts.compose && file) {
    if (!daemon) throw new Error(`${file} needs Docker, which is not reachable; start Docker and spawn again, or pass --no-compose`);
    await withLock(composeClaimFile(), () => {
      const now = dockerDaemon();
      if (now !== daemon) throw new Error(`the Docker daemon changed during spawn (${daemon} → ${now || 'none'}); nothing was reserved or started, spawn again`);
      const refusal = composeRefusal(p.composeProject, repo, p.name, daemon, p.worktree);
      if (refusal) throw new Error(refusal);
      const claims = readJson(composeClaimFile());
      if (!claims[p.composeProject]) {
        claims[p.composeProject] = { repo, env: p.name, daemon, reservedAt: new Date().toISOString() };
        writeJson(composeClaimFile(), claims);
      }
    });
    const env = { ...process.env, COMPOSE_PROJECT_NAME: p.composeProject };
    ports.forEach((port, i) => { env[`HOST_PORT_${i + 1}`] = String(port); });
    console.error(`starting Compose project ${p.composeProject}`);
    run('docker', ['compose', '-p', p.composeProject, 'up', '-d'], p.worktree, env);
  }
  exportsFor(ports);
}

async function teardown(p, opts, root, owner, ledger) {
  const repo = repoKey(root);
  const entry = readJson(ledger)[p.name];
  if (!entry) throw new Error(`${p.name} is not in the ledger: spawn did not create it, so teardown does not touch it`);
  if (entry.owner !== owner) throw new Error(`${p.name} belongs to ${entry.owner}, not ${owner}; refusing to touch it`);
  refuseLegacy(entry, p.name);
  if (path.resolve(entry.worktree) !== path.resolve(p.worktree)) throw new Error(`ledger path ${entry.worktree} does not match ${p.worktree}`);
  const present = fs.existsSync(p.worktree);

  // Every check runs before anything is removed.
  const admin = ownedRegistration(root, p.worktree, entry.mark);
  if (present && !admin) throw new Error(`${p.worktree} is not a worktree of this repository; refusing to remove it`);
  if (entry.branchPending) {
    settleBranchIntent(root, ledger, p.name, p.worktree, entry.branch);
    Object.assign(entry, readJson(ledger)[p.name]);
  }
  if (present) {
    const onBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], p.worktree);
    if (onBranch !== entry.branch) throw new Error(`${p.worktree} is on ${onBranch}, not ${entry.branch}; refusing to remove it`);
    if (git(['status', '--porcelain', '--untracked-files=all'], p.worktree) !== '') {
      throw new Error(`${p.worktree} has uncommitted or untracked changes; commit and push them first, then tear down`);
    }
  }
  // The branch is decided once. A teardown run again after the decision was recorded skips the merge gate and the
  // branch, and finishes the rest.
  let settled = entry.branchOutcome || null;
  // A delete that was interrupted is resolved once, by whether the branch is still there; it is never tried again.
  if (settled && settled.status === 'deleting') {
    settled = branchTip(root, entry.branch)
      ? { status: 'done', note: `branch ${entry.branch} kept: its delete was interrupted`, p7Open: true }
      : { status: 'done', note: `branch ${entry.branch} deleted`, p7Open: false };
    updateEntry(ledger, p.name, { branchOutcome: settled });
  }
  const base = entry.base || defaultBase(root);
  let tip = null;
  let merged = true;
  if (!settled) {
    refreshBase(root, base);
    // The tip is resolved once; only this exact commit is ever deleted, and only when it is in the base.
    tip = branchTip(root, entry.branch);
    merged = tip ? isAncestor(root, tip, base) : true;
    if (!merged && !opts.abandon) {
      throw new Error(`${entry.branch} has not merged into ${base}; teardown runs after the merge, or with --abandon for a canceled ticket (the branch is then kept)`);
    }
  }
  pinDockerContext();
  const reservation = composeReservation(entry.composeProject);
  const reserved = Boolean(reservation && reservation.repo === repo && reservation.env === p.name);
  let resources = null;
  if (reserved) {
    const daemon = dockerDaemon();
    if (!daemon) throw new Error(`Docker is not reachable, so Compose project ${entry.composeProject} cannot be checked; start Docker and tear down again`);
    if (daemon !== reservation.daemon) throw new Error(`Compose project ${entry.composeProject} is reserved on Docker daemon ${reservation.daemon}, not ${daemon}; switch back to that context`);
    resources = composeResources(entry.composeProject);
    const foreign = foreignContainers(resources, p.worktree);
    if (foreign.length) throw new Error(`Compose project ${entry.composeProject} has containers started outside ${p.worktree} (${foreign.map(c => c.id).join(', ')}); refusing to remove any of it`);
  }

  // 1. The worktree, with everything inside it, ignored files included (DS11). No --force: git refuses a changed or
  //    locked worktree, and that refusal comes before anything irreversible. A lost directory drops only its own registration.
  if (admin) git(present ? ['worktree', 'remove', p.worktree] : ['worktree', 'remove', '--force', p.worktree], root);
  // 2. The local branch, decided once: deleted only when spawn owns it, it merged, nothing holds it, and it is still at
  //    the verified tip. The authority is spent before the delete, so a rerun never deletes a branch made since.
  let outcome = settled;
  if (!outcome) {
    if (!tip) outcome = { note: `branch ${entry.branch} already gone`, p7Open: false };
    else if (!merged) outcome = { note: `branch ${entry.branch} kept: it has not merged`, p7Open: false };
    else if (!branchOwned(root, entry, tip)) outcome = { note: `branch ${entry.branch} kept: spawn did not create it, or it was made again since`, p7Open: true };
    else if (holdersOf(root, entry.branch).length) {
      outcome = { note: `branch ${entry.branch} kept: checked out in ${holdersOf(root, entry.branch).join(', ')}`, p7Open: true };
    } else {
      updateEntry(ledger, p.name, { branchCreated: false, branchOutcome: { status: 'deleting', tip } });
      try {
        git(['update-ref', '-d', `refs/heads/${entry.branch}`, tip], root);
        outcome = { note: `branch ${entry.branch} deleted`, p7Open: false };
      } catch {
        outcome = { note: `branch ${entry.branch} kept: it moved past the merged commit ${tip.slice(0, 12)}`, p7Open: true };
      }
    }
    updateEntry(ledger, p.name, { branchCreated: false, branchOutcome: outcome });
  }
  // 3. The Compose project this environment reserved, by its label, from an empty directory so no compose file is
  //    read; then the reservation.
  if (reserved) {
    if (!resources.empty) {
      const empty = fs.mkdtempSync(path.join(require('os').tmpdir(), 'brain-teardown-'));
      try {
        run('docker', ['compose', '-p', entry.composeProject, 'down', '--volumes', '--remove-orphans'], empty, process.env);
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
      console.error(`removed Compose project ${entry.composeProject}: ${resources.containers.length} containers, ${resources.volumes.length} volumes, ${resources.networks.length} networks`);
    }
    await releaseCompose(entry.composeProject, repo, p.name);
  } else if (reservation) {
    console.error(`Compose project ${entry.composeProject} not touched: it is reserved by ${reservation.env} in ${reservation.repo}`);
  }
  // 4. The port claims, then the ledger entry, so a failed release is retried by the next teardown.
  await releaseClaim(repo, p.name);
  const all = readJson(ledger);
  delete all[p.name];
  writeJson(ledger, all);
  console.log(`tore down ${p.worktree}; ${outcome.note}`);
  if (outcome.p7Open) {
    console.error(`agent-env: P7 is not complete: delete ${entry.branch} by hand once you have checked it`);
    process.exitCode = 1;
  }
}

const USAGE = 'usage: agent-env.js spawn <TICKET-slug> --owner <name> --persona <persona> [--base <ref>] [--ports <n>] [--no-install] [--no-compose] [--dry-run]\n'
  + '       agent-env.js teardown <TICKET-slug> --owner <name> [--abandon]';

// Each command takes only its own flags; an unknown flag, or one with a missing value, stops before anything runs.
const FLAGS = {
  spawn: { values: ['--owner', '--persona', '--base', '--ports'], switches: ['--no-install', '--no-compose', '--dry-run'] },
  teardown: { values: ['--owner'], switches: ['--abandon'] },
};

function parseFlags(cmd, rest) {
  const { values, switches } = FLAGS[cmd];
  const out = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (switches.includes(flag)) { out[flag] = true; continue; }
    if (!values.includes(flag)) throw new Error(`${cmd} does not take ${flag}`);
    const value = rest[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    out[flag] = value;
  }
  if (out['--ports'] !== undefined && !/^\d+$/.test(out['--ports'])) throw new Error('--ports needs a whole number');
  return out;
}

async function main(argv) {
  const [cmd, name, ...rest] = argv;
  if (!FLAGS[cmd] || !name) {
    console.error(USAGE);
    process.exit(2);
  }
  let flags;
  try { flags = parseFlags(cmd, rest); } catch (err) {
    console.error(`agent-env: ${err.message}\n${USAGE}`);
    process.exit(2);
  }
  const persona = flags['--persona'];
  if (cmd === 'spawn' && !PERSONA.test(persona || '')) {
    console.error('agent-env: spawn needs --persona <persona>, a kebab-case persona name such as backend-engineer (DS2)');
    process.exit(2);
  }
  const root = mainCheckout();
  const p = plan(name, root);
  const owner = flags['--owner'];
  if (!owner) throw new Error('--owner <name> is required: the same name on spawn and on teardown');
  const ledger = ledgerFile(root);
  const opts = {
    dryRun: Boolean(flags['--dry-run']), base: flags['--base'], abandon: Boolean(flags['--abandon']),
    ports: flags['--ports'] === undefined ? undefined : Number(flags['--ports']),
    install: !flags['--no-install'], compose: !flags['--no-compose'],
  };
  // The lifecycle lock covers the ownership checks and every change that follows them.
  await withLock(lifecycleFile(root), () => (cmd === 'teardown'
    ? teardown(p, opts, root, owner, ledger)
    : spawnEnv(p, opts, root, owner, persona, ledger)));
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => { console.error(`agent-env: ${err.message}`); process.exit(1); });
}

module.exports = { plan, usedHostPorts, freePorts, shellQuote, mainCheckout, withLock, reclaimStale, ledgerFile, lifecycleFile, repoKey, claimFile, composeClaimFile, readJson, installers, withoutAwsCredentials, MARK, LOCK_PREFIX };
