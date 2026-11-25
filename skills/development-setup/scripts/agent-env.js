#!/usr/bin/env node
'use strict';

// Spawn and teardown of an agent's own environment (development-setup DS1-DS5, git-workflow-and-versioning P5-P7).
//   agent-env.js spawn <TICKET-slug> --owner <name> --persona <persona> [--base <ref>] [--ports <n>] [--no-install] [--no-compose] [--dry-run]
//   agent-env.js teardown <TICKET-slug> --owner <name> [--abandon]
//
// Spawn gives the agent everything it needs to start work, and is re-entrant: a resumed session runs it again.
//   1. The worktree beside the main checkout: reused while it exists; otherwise added on the local branch, else on
//      origin's branch of that name, else on a new branch from the base (origin's default branch, fetched).
//   2. Host ports, claimed machine-wide; a reused environment keeps the ports it holds.
//   3. `.env` copied from the main checkout when the worktree has none; an existing one is never overwritten.
//   4. Dependencies installed from the root lockfile (one JavaScript and one Python lockfile at most), once.
//   5. The Compose project (the worktree name, lowercase) brought up when the worktree has a compose file.
// Prints shell exports: AGENT_NAME (`<TICKET-slug> (<persona>)`, the visible name), WORKTREE, COMPOSE_PROJECT_NAME and
// HOST_PORT_<n>. Progress and tool output go to stderr, so stdout stays a list of exports.
//
// Teardown runs once the branch has merged into its base (P15 merge commits keep the branch tip an ancestor of it), or
// with --abandon for a canceled ticket. It refuses uncommitted or untracked work, and removes only what the ledger says
// this environment created:
//   - the Compose project's containers, networks and volumes, only when spawn found the project empty or already this
//     environment's (composeClaimed), and only while every container in it was started from this worktree;
//   - the worktree (no --force: git refuses a changed one) with the `.env` and dependencies inside it;
//   - the local branch, only when spawn created it and it has merged; an unmerged or pre-existing branch is kept;
//   - the port claims and the ledger entry.
// The remote branch is merge-pr.js's (P7). Anything else is left in place and named.
//
// The ledger (<git common dir>/brain-env-ledger.json) records every environment spawn made and the steps it completed;
// it is written before any step runs, so teardown can also clean up after a spawn that failed half-way.
// Run from the main checkout or any worktree of it. The worktree is placed beside the main checkout, never inside it.
//
// Spawn and teardown each run whole under one lifecycle lock per repository (<git common dir>/brain-env-lifecycle.lock):
// every ownership check, worktree, ledger, port-claim and Compose change happens inside it. The port-claim lock is
// taken inside it, never the other way round.

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

// The owner is the name the agent declares with --owner on spawn and on teardown. It guards against mistakes between
// agents on one machine; it is not an authentication, since anyone who can run the script can type any name.
function requireOwner(rest) {
  const owner = optionValue(rest, '--owner');
  if (!owner) throw new Error('--owner <name> is required: the same name on spawn and on teardown');
  return owner;
}

function optionValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
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

function registeredWorktree(root, worktree) {
  return git(['worktree', 'list', '--porcelain'], root).split('\n').includes(`worktree ${path.resolve(worktree)}`);
}

function branchExists(root, branch) {
  return git(['branch', '--list', branch], root) !== '';
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
  const remotes = git(['remote'], root).split('\n');
  if (!remotes.includes('origin')) return null;
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

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

function composeFile(worktree) {
  return COMPOSE_FILES.find(f => fs.existsSync(path.join(worktree, f)));
}

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function dockerReachable() {
  try { docker(['info', '--format', '{{.ServerVersion}}']); return true; } catch { return false; }
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

async function spawnEnv(p, rest, root, owner, persona, dryRun, ledger) {
  const existing = readJson(ledger)[p.name];
  if (existing && existing.owner !== owner) throw new Error(`${p.name} belongs to ${existing.owner}, not ${owner}; refusing to take it over`);
  // A directory with this name that the ledger does not record is not ours to reuse: refuse before any port is claimed.
  if (!existing && fs.existsSync(p.worktree)) throw new Error(`${p.worktree} exists and the ledger does not record it; refusing to reuse it`);
  const base = optionValue(rest, '--base') || (existing && existing.base) || defaultBase(root, { fetch: !dryRun });
  const count = Number(optionValue(rest, '--ports') || 0);
  const wantCompose = !rest.includes('--no-compose');
  // Reuse only this repository's worktree on this branch; any other directory with the name is someone else's.
  let reuse = false;
  if (fs.existsSync(p.worktree)) {
    const onBranch = registeredWorktree(root, p.worktree) && git(['rev-parse', '--abbrev-ref', 'HEAD'], p.worktree) === p.branch;
    if (!onBranch) throw new Error(`${p.worktree} exists and is not this repository's worktree on ${p.branch}; refusing to reuse it`);
    reuse = true;
  }
  // The Compose project must be empty, or already this environment's, before spawn claims it: whatever is in it later
  // was made by this environment, and teardown removes exactly that. Checked before anything is created.
  const reachable = wantCompose && dockerReachable();
  let composeClaimed = Boolean(existing && existing.composeClaimed);
  if (reachable) {
    const resources = composeResources(p.composeProject);
    const foreign = foreignContainers(resources, p.worktree);
    if (foreign.length) throw new Error(`Compose project ${p.composeProject} has containers started outside ${p.worktree} (${foreign.map(c => c.id).join(', ')}); refusing to share it (DS3)`);
    if (!composeClaimed && !resources.empty) throw new Error(`Compose project ${p.composeProject} already has resources this environment did not create; refusing to claim it (DS3)`);
    composeClaimed = true;
  }
  // Ports are claimed before the worktree exists, so a failure here leaves nothing behind to clean up by hand.
  let ports = [];
  const repo = repoKey(root);
  if (count) {
    let psOutput = '';
    try { psOutput = execFileSync('docker', ['ps', '--format', '{{.Ports}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* docker not running: only the bind test applies */ }
    const file = claimFile();
    ports = await withLock(file, async () => {
      const claims = readJson(file);
      // An environment the ledger holds keeps the ports it already claimed, so its containers keep their host ports.
      const mine = existing ? ((claims[repo] || {})[p.name] || []) : [];
      const kept = mine.slice(0, count);
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
  const exportsFor = () => {
    console.log(`export AGENT_NAME=${shellQuote(`${p.name} (${persona})`)}`);
    console.log(`export WORKTREE=${shellQuote(p.worktree)}`);
    console.log(`export COMPOSE_PROJECT_NAME=${shellQuote(p.composeProject)}`);
    ports.forEach((port, i) => console.log(`export HOST_PORT_${i + 1}=${shellQuote(port)}`));
  };
  if (dryRun) {
    console.error(reuse ? `would reuse ${p.worktree}` : `would add the worktree ${p.worktree} on ${p.branch}`);
    exportsFor();
    return;
  }

  // 1. The worktree. The ledger entry is written first, so a spawn that fails from here on can be torn down.
  let branchCreated = Boolean(existing && existing.branchCreated);
  if (!reuse) {
    if (existing) git(['worktree', 'prune'], root);
    let args;
    if (branchExists(root, p.branch)) {
      args = ['worktree', 'add', p.worktree, p.branch];
    } else {
      const remote = remoteBranch(root, p.branch);
      // A new branch does not track origin's default branch, so a plain push cannot land on it.
      args = remote ? ['worktree', 'add', '--track', '-b', p.branch, p.worktree, remote]
        : ['worktree', 'add', '--no-track', '-b', p.branch, p.worktree, base];
      branchCreated = true;
    }
    try { git(args, root); } catch (err) {
      if (count && !existing) await releaseClaim(repo, p.name);
      throw err;
    }
    console.error(`${existing ? 'restored' : 'added'} ${p.worktree} on ${p.branch}`);
  } else {
    console.error(`reusing ${p.worktree}`);
  }
  const all = readJson(ledger);
  // An entry that already exists keeps its owner: spawn cannot take over another agent's environment.
  if (all[p.name] && all[p.name].owner !== owner) throw new Error(`${p.name} belongs to ${all[p.name].owner}, not ${owner}; refusing to take it over`);
  all[p.name] = { envCopied: false, installed: false, ...all[p.name], owner, persona, branch: p.branch, worktree: p.worktree, base,
    ports, composeProject: p.composeProject, branchCreated, composeClaimed, spawnedAt: new Date().toISOString() };
  writeJson(ledger, all);
  const entry = all[p.name];

  // 2. .env from the main checkout, never over one the worktree already has, and only when git ignores it there:
  //    a copied secret git would commit is a leak waiting for `git add -A`.
  const source = path.join(root, '.env');
  const target = path.join(p.worktree, '.env');
  if (fs.existsSync(source) && !fs.existsSync(target)) {
    if (spawnSync('git', ['check-ignore', '-q', '.env'], { cwd: p.worktree }).status === 0) {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      updateEntry(ledger, p.name, { envCopied: true });
      console.error(`copied .env from ${root}`);
    } else {
      console.error(`.env not copied: git does not ignore it in ${p.worktree}; add it to .gitignore first`);
    }
  }

  // 3. Dependencies, once per environment; a failed install is retried by the next spawn.
  if (!rest.includes('--no-install') && !entry.installed) {
    for (const [lock, cmd, args] of installers(p.worktree)) {
      console.error(`installing from ${lock}: ${cmd} ${args.join(' ')}`);
      run(cmd, args, p.worktree, process.env);
    }
    updateEntry(ledger, p.name, { installed: true });
  }

  // 4. The Compose project, on the claimed ports.
  const file = composeFile(p.worktree);
  if (wantCompose && file) {
    if (!reachable) throw new Error(`${file} needs Docker, which is not reachable; start Docker and spawn again, or pass --no-compose`);
    const env = { ...process.env, COMPOSE_PROJECT_NAME: p.composeProject };
    ports.forEach((port, i) => { env[`HOST_PORT_${i + 1}`] = String(port); });
    console.error(`starting Compose project ${p.composeProject}`);
    run('docker', ['compose', '-p', p.composeProject, 'up', '-d'], p.worktree, env);
  }
  exportsFor();
}

async function teardown(p, rest, root, owner, ledger) {
  const entry = readJson(ledger)[p.name];
  if (!entry) throw new Error(`${p.name} is not in the ledger: spawn did not create it, so teardown does not touch it`);
  if (entry.owner !== owner) throw new Error(`${p.name} belongs to ${entry.owner}, not ${owner}; refusing to touch it`);
  if (path.resolve(entry.worktree) !== path.resolve(p.worktree)) throw new Error(`ledger path ${entry.worktree} does not match ${p.worktree}`);
  const abandon = rest.includes('--abandon');
  const present = fs.existsSync(p.worktree);

  // Every check runs before anything is removed.
  if (present) {
    if (!registeredWorktree(root, p.worktree)) throw new Error(`${p.worktree} is not a worktree of this repository; refusing to remove it`);
    const onBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], p.worktree);
    if (onBranch !== entry.branch) throw new Error(`${p.worktree} is on ${onBranch}, not ${entry.branch}; refusing to remove it`);
    if (git(['status', '--porcelain', '--untracked-files=all'], p.worktree) !== '') {
      throw new Error(`${p.worktree} has uncommitted or untracked changes; commit and push them first, then tear down`);
    }
  }
  const base = entry.base || defaultBase(root);
  refreshBase(root, base);
  const hasBranch = branchExists(root, entry.branch);
  let merged = !hasBranch;
  if (hasBranch) {
    try { git(['merge-base', '--is-ancestor', entry.branch, base], root); merged = true; } catch { merged = false; }
  }
  if (!merged && !abandon) {
    throw new Error(`${entry.branch} has not merged into ${base}; teardown runs after the merge, or with --abandon for a canceled ticket (the branch is then kept)`);
  }
  let resources = null;
  if (entry.composeClaimed) {
    if (!dockerReachable()) throw new Error(`Docker is not reachable, so Compose project ${entry.composeProject} cannot be checked; start Docker and tear down again`);
    resources = composeResources(entry.composeProject);
    const foreign = foreignContainers(resources, p.worktree);
    if (foreign.length) throw new Error(`Compose project ${entry.composeProject} has containers started outside ${p.worktree} (${foreign.map(c => c.id).join(', ')}); refusing to remove any of it`);
  }

  // 1. The Compose project, by its label, from an empty directory so no compose file is read.
  if (resources && !resources.empty) {
    const empty = fs.mkdtempSync(path.join(require('os').tmpdir(), 'brain-teardown-'));
    try {
      run('docker', ['compose', '-p', entry.composeProject, 'down', '--volumes', '--remove-orphans'], empty, process.env);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
    console.error(`removed Compose project ${entry.composeProject}: ${resources.containers.length} containers, ${resources.volumes.length} volumes, ${resources.networks.length} networks`);
  }
  // 2. The worktree, with the .env and dependencies inside it. No --force: git refuses a changed worktree.
  if (present) git(['worktree', 'remove', p.worktree], root);
  else git(['worktree', 'prune'], root);
  // 3. The local branch: only one spawn created, and only once it has merged.
  let branchNote;
  if (!hasBranch) branchNote = `branch ${entry.branch} already gone`;
  else if (!entry.branchCreated) branchNote = `branch ${entry.branch} kept: spawn did not create it`;
  else if (!merged) branchNote = `branch ${entry.branch} kept: it has not merged`;
  else { git(['branch', '-D', entry.branch], root); branchNote = `branch ${entry.branch} deleted`; }
  // 4. The ledger entry and the port claims.
  const all = readJson(ledger);
  delete all[p.name];
  writeJson(ledger, all);
  await releaseClaim(repoKey(root), p.name);
  if (!entry.composeClaimed) console.error(`Compose project ${entry.composeProject} not touched: spawn did not claim it (Docker was off or --no-compose)`);
  console.log(`tore down ${p.worktree}; ${branchNote}`);
}

const USAGE = 'usage: agent-env.js spawn <TICKET-slug> --owner <name> --persona <persona> [--base <ref>] [--ports <n>] [--no-install] [--no-compose] [--dry-run]\n'
  + '       agent-env.js teardown <TICKET-slug> --owner <name> [--abandon]';

async function main(argv) {
  const [cmd, name, ...rest] = argv;
  if (!['spawn', 'teardown'].includes(cmd) || !name) {
    console.error(USAGE);
    process.exit(2);
  }
  const persona = optionValue(rest, '--persona');
  if (cmd === 'spawn' && !PERSONA.test(persona || '')) {
    console.error('agent-env: spawn needs --persona <persona>, a kebab-case persona name such as backend-engineer (DS2)');
    process.exit(2);
  }
  const root = mainCheckout();
  const p = plan(name, root);
  const dryRun = rest.includes('--dry-run');
  const owner = requireOwner(rest);
  const ledger = ledgerFile(root);
  // The lifecycle lock covers the ownership checks and every change that follows them.
  await withLock(lifecycleFile(root), () => (cmd === 'teardown'
    ? teardown(p, rest, root, owner, ledger)
    : spawnEnv(p, rest, root, owner, persona, dryRun, ledger)));
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => { console.error(`agent-env: ${err.message}`); process.exit(1); });
}

module.exports = { plan, usedHostPorts, freePorts, shellQuote, mainCheckout, withLock, reclaimStale, ledgerFile, lifecycleFile, repoKey, claimFile, readJson, installers };
