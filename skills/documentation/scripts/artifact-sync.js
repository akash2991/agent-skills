#!/usr/bin/env node
'use strict';

// Keeps artifacts current (documentation W12): the md, html, and similar files that are built from code or describe it.
// models.json at the repository root maps each artifact to its sources and names the model that updates it.
//
//   hook [--cwd <dir>]                    an agent finished: when committed code since the last sync touches an
//                                         artifact's sources, start `run` in the background and return at once
//   run --root <dir> --branch <b> --base <sha> --head <sha>
//                                         (background) update the artifacts in a fresh worktree at <head>, commit once,
//                                         push that commit to <b>-artifacts, and open a PR into <b>
//   due [--cwd <dir>]                     print what `hook` would sync now, without starting anything
//   scope --pr <number>                   exit 0 when the PR is this clone's published sync commit on <base>-artifacts,
//                                         from the same repository, and changes only validated data artifacts whose
//                                         outputs the base's renderer reproduces: it skips the double-pass review
//   merge --pr <number>                   scope, then merge exactly the head it checked (--match-head-commit)
//
// Code decides everything but the edit: which artifacts are due, the worktree, the commit, the push, and the PR.
// Only the edit itself is the agent's. BRAIN_ARTIFACT_SYNC=1 marks the sync agent, so its own finish starts nothing.

const { execFileSync, spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG = 'models.json';
const ENV_FLAG = 'BRAIN_ARTIFACT_SYNC';
const SUFFIX = '-artifacts';
const AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const STALE_START_MS = 60 * 1000;
const RENDER_TIMEOUT_MS = 10 * 60 * 1000;
const HARNESSES = {
  claude: (entry, prompt) => ['claude', ['-p', prompt, '--model', entry.model, '--effort', entry.effort,
    '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Edit,Write,Glob,Grep,Bash(git diff:*),Bash(git log:*),Bash(git show:*)']],
  pi: (entry, prompt) => {
    const slash = entry.model.indexOf('/');
    return ['pi', ['-p', '--provider', entry.model.slice(0, slash), '--model', entry.model.slice(slash + 1),
      '--thinking', entry.effort, '--tools', 'read,grep,find,ls,edit,write', prompt]];
  },
};

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(args, cwd) {
  try { return git(args, cwd); } catch { return null; }
}

function lines(text) {
  return text ? text.split('\n').filter(Boolean) : [];
}

// Globs are repository-relative: `**` crosses directories, `*` and `?` stay within one. `*.md` matches only root
// files; `**/*.md` matches at any depth.
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*';
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function matchesAny(file, globs) {
  return globs.some(g => globToRegExp(g).test(file));
}

// The two keys this script reads. models.json's shape is checked by scripts/validate-models.js in the brain.
function parseConfig(text) {
  let cfg;
  try { cfg = JSON.parse(text); } catch { return null; }
  if (!cfg || typeof cfg !== 'object') return null;
  const artifacts = Array.isArray(cfg.artifacts) ? cfg.artifacts.filter(a => a && typeof a.path === 'string' && Array.isArray(a.sources)) : [];
  return { sync: cfg['artifact-sync'] || null, artifacts };
}

function loadConfig(root) {
  try { return parseConfig(fs.readFileSync(path.join(root, CONFIG), 'utf8')); } catch { return null; }
}

function configAt(root, ref) {
  const text = tryGit(['show', `${ref}:${CONFIG}`], root);
  return text === null ? null : parseConfig(text);
}

// An entry is due when a file changed in the range matches one of its sources and is not the artifact itself.
function dueEntries(artifacts, changed) {
  return artifacts
    .map(a => ({ ...a, changed: changed.filter(f => f !== a.path && !(a.outputs || []).includes(f) && matchesAny(f, a.sources)) }))
    .filter(a => a.changed.length);
}

function ownedPaths(artifacts) {
  return new Set(artifacts.flatMap(a => [a.path, ...(a.outputs || [])]));
}

function ticketOf(branch) {
  const m = /^([A-Za-z][A-Za-z0-9]*-\d+)(?:-|$)/.exec(branch);
  return m ? m[1].toUpperCase() : null;
}

// A readable file name for a branch that two branches can never share.
function safeName(branch) {
  return `${branch.replace(/[^A-Za-z0-9._-]/g, '_')}-${crypto.createHash('sha1').update(branch).digest('hex').slice(0, 8)}`;
}

function stateDir(root) {
  const common = path.resolve(root, git(['rev-parse', '--git-common-dir'], root));
  return path.join(common, 'agent-brain', 'artifact-sync');
}

function readState(dir, branch) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, `${safeName(branch)}.json`), 'utf8')); } catch { return {}; }
}

function writeState(dir, branch, patch) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeName(branch)}.json`);
  const next = { ...readState(dir, branch), ...patch };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return next;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// One sync per code branch. The lock holds "starting:<token>" while the hook reserves it, then the sync's pid. A
// lock whose pid is gone, or a reservation older than a minute, is stale. Staleness is judged on one read, and the
// lock is taken over only if it still holds exactly what was judged; anything ambiguous fails closed.
function acquireLock(file, token) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, `starting:${token}`, { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let raw;
      let stale;
      try {
        raw = fs.readFileSync(file, 'utf8');
        stale = raw.startsWith('starting:') ? Date.now() - fs.statSync(file).mtimeMs >= STALE_START_MS : !alive(Number(raw));
      } catch { return false; }
      if (!stale) return false;
      const aside = `${file}.stale-${process.pid}`;
      try { fs.renameSync(file, aside); } catch { return false; }
      if (fs.readFileSync(aside, 'utf8') !== raw) {
        try { fs.linkSync(aside, file); } catch { /* a newer lock is there */ }
        fs.rmSync(aside, { force: true });
        return false;
      }
      fs.rmSync(aside, { force: true });
    }
  }
  return false;
}

function releaseLock(file, holder) {
  try { if (fs.readFileSync(file, 'utf8') === holder) fs.rmSync(file, { force: true }); } catch { /* already gone */ }
}

// run's side of the lock: the reservation its hook made (by token), or a free lock when run is started by hand,
// becomes this process's. Anything else is another sync's, and run refuses.
function claimLock(file, token) {
  const mine = String(process.pid);
  if (token) {
    let held = null;
    try { held = fs.readFileSync(file, 'utf8'); } catch { /* gone */ }
    if (held !== `starting:${token}`) throw new Error(`the lock ${path.basename(file)} is not this sync's reservation (${held})`);
    const tmp = `${file}.${mine}.tmp`;
    fs.writeFileSync(tmp, mine);
    fs.renameSync(tmp, file);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, mine, { flag: 'wx' }); }
  catch (err) { if (err.code === 'EEXIST') throw new Error(`another sync holds ${path.basename(file)} (${fs.readFileSync(file, 'utf8')})`); throw err; }
}

// owner/name of origin on GitHub; every gh call names it, so gh never infers another repository.
function originRepo(root) {
  const url = tryGit(['remote', 'get-url', 'origin'], root) || '';
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) throw new Error(`origin (${url || 'none'}) is not a GitHub repository`);
  return m[1];
}

function remoteTip(root, branch) {
  const out = tryGit(['ls-remote', 'origin', `refs/heads/${branch}`], root);
  return out ? out.split(/\s/)[0] : '';
}

function defaultBranch(root) {
  const ref = tryGit(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], root);
  return ref ? ref.replace(/^refs\/remotes\/origin\//, '') : 'main';
}

// What `hook` would do now, and with what. Never writes anything; `hook` repeats it under the lock.
function plan(cwd, env = process.env) {
  if (env[ENV_FLAG]) return { skip: 'this is the sync agent' };
  const root = tryGit(['rev-parse', '--show-toplevel'], cwd);
  if (!root) return { skip: 'not a git repository' };
  const branch = tryGit(['branch', '--show-current'], root);
  if (!branch) return { skip: 'detached HEAD' };
  const main = defaultBranch(root);
  if (branch === main || branch === 'main' || branch.endsWith(SUFFIX)) return { skip: `branch ${branch} is not a code branch` };
  // Only published code is synced: the remote-tracking tip, never local commits that are not pushed yet.
  const head = tryGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`], root);
  if (!head) return { skip: `${branch} is not on origin yet` };
  const config = configAt(root, head);
  if (!config || !config.artifacts.length) return { skip: `no artifacts in ${CONFIG} at ${head.slice(0, 7)}` };
  if (!config.sync) return { skip: `no artifact-sync model in ${CONFIG}` };
  const dir = stateDir(root);
  const state = readState(dir, branch);
  if (state.synced === head || state.attempted === head) return { skip: `${head.slice(0, 7)} already synced or attempted${state.error ? `; last error: ${state.error}` : ''}` };
  // Work is computed from the baseline: the last code commit whose artifacts are in the code branch. A publication
  // not merged yet does not move it, so the next sync redoes that work too instead of dropping it.
  const isAncestor = (a, b) => !!a && tryGit(['merge-base', '--is-ancestor', a, b], root) !== null;
  const merged = state.published && state.publishedFor && isAncestor(state.published, head) ? state.publishedFor : null;
  const known = [merged, state.baseline].filter(c => isAncestor(c, head));
  const latest = known.length === 2 ? (isAncestor(known[0], known[1]) ? known[1] : known[0]) : known[0];
  const base = latest || tryGit(['merge-base', head, `refs/remotes/origin/${main}`], root) || tryGit(['merge-base', head, main], root);
  if (!base) return { skip: `no base to compare ${branch} with` };
  const due = dueEntries(config.artifacts, changedFiles([base, head], root));
  return { root, branch, base, head, dir, due, config };
}

function hook(cwd, env = process.env, launch = spawn) {
  const first = plan(cwd, env);
  if (first.skip) return first.skip;
  const lock = path.join(first.dir, `${safeName(first.branch)}.lock`);
  const token = crypto.randomBytes(8).toString('hex');
  if (!acquireLock(lock, token)) return 'a sync is already running for this branch';
  const reserved = `starting:${token}`;
  let handedOff = false;
  try {
    // Plan again under the lock: a sync that just finished may have moved the state.
    const p = plan(cwd, env);
    if (p.skip) return p.skip;
    if (!p.due.length) {
      writeState(p.dir, p.branch, { synced: p.head, baseline: p.head });
      return 'no artifact is due';
    }
    writeState(p.dir, p.branch, { attempted: p.head });
    const log = fs.openSync(path.join(p.dir, `${safeName(p.branch)}.log`), 'a');
    const child = launch(process.execPath, [__filename, 'run', '--root', p.root, '--branch', p.branch, '--base', p.base, '--head', p.head, '--token', token],
      { cwd: p.root, detached: true, stdio: ['ignore', log, log], env: { ...env, [ENV_FLAG]: '1' } });
    child.unref();
    fs.closeSync(log);
    handedOff = true;
    return `started the artifact sync for ${p.due.map(d => d.path).join(', ')}`;
  } finally {
    if (!handedOff) releaseLock(lock, reserved);
  }
}

function prompt({ branch, base, head, due, harness = 'claude' }) {
  const list = due.map(d => `- ${d.path}\n  changed sources: ${d.changed.join(', ')}`).join('\n');
  return [
    `You keep this repository's artifacts current. Commits ${base.slice(0, 7)}..${head.slice(0, 7)} on branch ${branch} changed code that these artifacts describe:`,
    '',
    list,
    '',
    harness === 'claude'
      ? `Read what changed (git diff ${base} ${head} -- <source>) and the code as it is now, then update each artifact so it is accurate for the code at ${head.slice(0, 7)}.`
      : `Read the changed sources as they are now, then update each artifact so it is accurate for the code at ${head.slice(0, 7)}.`,
    'Edit only the artifact files listed above. Do not edit code, tests, config, or any other file. Do not commit, push, or run builds: the caller does that.',
    'If an artifact is already accurate, leave it unchanged. Keep each artifact\'s existing structure and voice; follow the repository\'s AGENTS.md and documentation conventions.',
  ].join('\n');
}

function sh(command, cwd) {
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: RENDER_TIMEOUT_MS });
  if (r.error || r.status !== 0) throw new Error(`"${command}" failed: ${(r.stderr || r.stdout || '').trim().slice(-2000)}`);
}

// A fresh detached worktree at <head>, private to this run and removed after it: nobody else's work is ever in it.
function freshWorktree(root, head) {
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-sync-'));
  const dir = path.join(holder, 'wt');
  git(['worktree', 'add', '--quiet', '--detach', dir, head], root);
  return { dir, remove: () => { tryGit(['worktree', 'remove', '--force', dir], root); fs.rmSync(holder, { recursive: true, force: true }); tryGit(['worktree', 'prune'], root); } };
}

// The commit to be pushed, checked as an object: one parent, <head>; only the allowed paths; each one an added or
// modified regular file. Whatever the agent or a commit hook did, nothing else can be published.
function checkPublication(cwd, head, commit, allowed) {
  const parents = git(['rev-list', '--parents', '-n', '1', commit], cwd).split(' ').slice(1);
  if (parents.length !== 1 || parents[0] !== head) throw new Error(`the artifact commit's parent is not ${head.slice(0, 7)}; not pushed`);
  const raw = execFileSync('git', ['diff-tree', '-r', '--no-renames', '-z', head, commit], { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);
  const bad = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const [oldMode, newMode, , , status] = raw[i].replace(/^:/, '').split(' ');
    const file = raw[i + 1];
    const regular = ['100644', '100755'];
    const ok = allowed.has(file) && regular.includes(newMode) && (status === 'A' ? oldMode === '000000' : status === 'M' && oldMode === newMode);
    if (!ok) bad.push(`${file} (${status} ${oldMode}->${newMode})`);
  }
  if (bad.length) throw new Error(`the artifact commit changes more than its artifacts; not pushed: ${bad.join(', ')}`);
}

function commitMessage({ due, head, ticket, sync }) {
  return [
    `docs(artifacts): bring ${due.length} artifact${due.length === 1 ? '' : 's'} up to date with ${head.slice(0, 7)}${ticket ? ` [${ticket}]` : ''}`,
    '',
    'Updated by the artifact sync (documentation W12) for:',
    ...due.map(d => `- ${d.path}`),
    '',
    `Model: ${sync.model}`,
    `Thinking-effort: ${sync.effort}`,
    `Harness: ${sync.harness}`,
  ].join('\n');
}

function prBody({ branch, base, head, due, ticket }) {
  return [
    ...(ticket ? [`Ticket: ${ticket}`] : []),
    'Blast-radius: low — only artifact files mapped in models.json change; no code, config, or tests (documentation W12).',
    '',
    `Artifact sync for \`${branch}\` at ${head.slice(0, 7)} (from ${base.slice(0, 7)}).`,
    '',
    ...due.map(d => `- \`${d.path}\`: sources changed: ${d.changed.map(f => `\`${f}\``).join(', ')}`),
    '',
    'Only artifact files from `models.json` change here, in one commit on the code branch\'s pushed tip. Merge it into the code branch through the usual review and merge path.',
  ].join('\n');
}

// NUL-delimited and with rename detection off, so every path arrives literally and both ends of a move are listed.
function changedFiles(args, cwd) {
  return execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', ...args], { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);
}

// deps.spawnSync runs the agent and gh, deps.push the push: tests replace them, never git itself.
// The run owns the lock from its first check to its last state write, and works only from <head>, the code branch's
// tip on origin: it re-checks that tip, builds one commit on it in a fresh worktree, validates that exact commit, and
// pushes it to <branch>-artifacts without overwriting anything it did not publish itself.
function run({ root, branch, base, head, token }, deps = {}) {
  const exec = deps.spawnSync || spawnSync;
  const dir = stateDir(root);
  const lock = path.join(dir, `${safeName(branch)}.lock`);
  claimLock(lock, token);
  let wt = null;
  try {
    const state = readState(dir, branch);
    if (state.synced === head) return `${head.slice(0, 7)} is already synced`;
    const tipOf = deps.remoteTip || (b => remoteTip(root, b));
    const checkTip = () => {
      const live = tipOf(branch);
      if (live !== head) throw new Error(`${branch} is at ${live ? live.slice(0, 7) : 'nothing'} on origin, not ${head.slice(0, 7)}; the next agent finish syncs it`);
    };
    checkTip();
    const repo = deps.repo || originRepo(root);
    // The config the commits themselves carry, not whatever the working copy holds now.
    const config = configAt(root, head);
    if (!config || !config.sync || !HARNESSES[config.sync.harness]) throw new Error(`no usable artifact-sync entry in ${CONFIG} at ${head.slice(0, 7)}`);
    const due = dueEntries(config.artifacts, changedFiles([base, head], root));
    if (!due.length) { writeState(dir, branch, { synced: head, baseline: head, error: null }); return 'no artifact is due'; }
    const ticket = ticketOf(branch);
    const name = `${branch}${SUFFIX}`;
    wt = freshWorktree(root, head);
    const env = { ...process.env, [ENV_FLAG]: '1' };
    const [cmd, args] = HARNESSES[config.sync.harness](config.sync, prompt({ branch, base, head, due, harness: config.sync.harness }));
    const agent = exec(cmd, args, { cwd: wt.dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: AGENT_TIMEOUT_MS, env });
    if (agent.error || agent.status !== 0) throw new Error(`${cmd} failed: ${agent.error ? agent.error.message : (agent.stderr || '').trim().slice(-2000)}`);
    if (git(['rev-parse', 'HEAD'], wt.dir) !== head || tryGit(['symbolic-ref', '-q', 'HEAD'], wt.dir) !== null) {
      throw new Error('the sync agent moved HEAD or checked out a branch; nothing published');
    }
    for (const d of due) if (d.then) sh(d.then, wt.dir);
    const allowed = ownedPaths(due);
    const touched = [...new Set([...changedFiles(['HEAD'], wt.dir),
      ...execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: wt.dir, encoding: 'utf8' }).split('\0').filter(Boolean)])];
    const outside = touched.filter(f => !allowed.has(f));
    if (outside.length) throw new Error(`the sync agent changed files that are not its artifacts, nothing published: ${outside.join(', ')}`);
    if (!touched.length) { writeState(dir, branch, { synced: head, baseline: head, error: null }); return 'artifacts already current'; }
    git(['add', '--', ...touched], wt.dir);
    execFileSync('git', ['commit', '--quiet', '-F', '-'], { cwd: wt.dir, input: commitMessage({ due, head, ticket, sync: config.sync }), env, stdio: ['pipe', 'pipe', 'pipe'] });
    const commit = git(['rev-parse', 'HEAD'], wt.dir);
    checkPublication(wt.dir, head, commit, allowed);
    // <branch>-artifacts is replaced only when it is absent or still holds what this clone last published.
    checkTip(); // the code branch may have moved while the agent worked
    const current = tipOf(name);
    if (current && current !== state.published) throw new Error(`${name} on origin is at ${current.slice(0, 7)}, which this sync did not publish; not overwritten`);
    (deps.push || (() => git(['push', '--quiet', `--force-with-lease=refs/heads/${name}:${current}`, 'origin', `${commit}:refs/heads/${name}`], wt.dir)))(commit, current);
    writeState(dir, branch, { published: commit, publishedFor: head });
    const open = exec('gh', ['pr', 'list', '--repo', repo, '--head', name, '--base', branch, '--state', 'open', '--json', 'url,headRefOid,headRefName,baseRefName,isCrossRepository'], { cwd: wt.dir, encoding: 'utf8' });
    if (open.error || open.status !== 0) throw new Error(`pushed ${name}, but gh pr list failed: ${open.error ? open.error.message : (open.stderr || '').trim()}`);
    let found;
    try { found = JSON.parse(open.stdout || '[]'); } catch { throw new Error(`pushed ${name}, but gh pr list returned no JSON`); }
    const match = found.find(x => x.headRefName === name && x.baseRefName === branch && x.isCrossRepository === false);
    if (match && match.headRefOid !== commit) throw new Error(`the open PR for ${name} is at ${String(match.headRefOid).slice(0, 7)}, not the pushed ${commit.slice(0, 7)}`);
    let pr = match ? match.url : '';
    if (!pr) {
      const title = `${ticket ? `${ticket}: ` : ''}artifacts for ${branch} at ${head.slice(0, 7)}`;
      const made = exec('gh', ['pr', 'create', '--repo', repo, '--base', branch, '--head', name, '--title', title, '--body', prBody({ branch, base, head, due, ticket })], { cwd: wt.dir, encoding: 'utf8' });
      if (made.error || made.status !== 0) throw new Error(`pushed ${name}, but gh pr create failed: ${made.error ? made.error.message : (made.stderr || '').trim()}`);
      pr = (made.stdout || '').trim();
    }
    writeState(dir, branch, { synced: head, error: null });
    return `artifacts ${commit.slice(0, 7)} on ${name}; PR ${pr}`;
  } catch (err) {
    writeState(dir, branch, { error: `${new Date().toISOString()} ${head.slice(0, 7)}: ${err.message}` });
    throw err;
  } finally {
    if (wt) wt.remove();
    releaseLock(lock, String(process.pid));
  }
}

// What may skip review: validated documentation data, and nothing else. An entry qualifies only when its artifact is a
// data file (JSON, YAML, diagrams as code) with a `then` renderer and declared outputs: prScope re-renders it from the
// head's data with the base's renderer, which both validates the data and proves the outputs. Any other mapping, a
// Markdown page or a hand-written HTML page included, is still synced but keeps the normal review.
const DATA_ARTIFACT = /\.(json|mmd|drawio|csv|ya?ml)$/i;

function exemptEntries(artifacts) {
  return artifacts.filter(a => DATA_ARTIFACT.test(a.path) && a.path !== CONFIG && a.then && (a.outputs || []).length && !(a.outputs || []).includes(CONFIG));
}

function exemptPaths(artifacts) {
  return new Set(exemptEntries(artifacts).flatMap(a => [a.path, ...a.outputs]));
}

// Files changed in base...head that may not skip review under <base>'s models.json. The base's config, so a PR cannot
// widen its own exemption; models.json is never exempt.
function scope(root, base, head = 'HEAD') {
  const config = configAt(root, base);
  const changed = changedFiles([`${base}...${head}`], root);
  if (!config || !config.artifacts.length) return { changed, outside: changed };
  const exempt = exemptPaths(config.artifacts);
  return { changed, outside: changed.filter(f => !exempt.has(f)) };
}

// The review exemption for one PR, checked against the PR's own base and head commits: its head branch is
// <base>-artifacts, its head commit is the one this clone's sync published for that branch (the sync's record, not a
// copyable trailer), and every file it changes may skip review.
function prScope(root, number, deps = {}) {
  const view = (deps.prView || (n => JSON.parse(execFileSync('gh', ['api', `repos/${originRepo(root)}/pulls/${n}`, '--jq',
    '{base: .base.ref, baseSha: .base.sha, head: .head.ref, headSha: .head.sha, headRepo: .head.repo.full_name, baseRepo: .base.repo.full_name, state: .state}'], { cwd: root, encoding: 'utf8' }))))(number);
  const reasons = [];
  if (view.state && view.state !== 'open') reasons.push(`the PR is ${view.state}`);
  if (view.headRepo !== view.baseRepo) reasons.push(`head ${view.headRepo} is not the base repository ${view.baseRepo}`);
  if (view.head !== `${view.base}${SUFFIX}`) reasons.push(`head branch ${view.head} is not ${view.base}${SUFFIX}`);
  const published = readState(stateDir(root), view.base).published;
  if (published !== view.headSha) reasons.push(`head ${String(view.headSha).slice(0, 7)} is not the commit this clone's sync published for ${view.base} (${published ? published.slice(0, 7) : 'none'})`);
  if (!reasons.length) {
    if (!deps.prView) tryGit(['fetch', '--quiet', 'origin', view.baseSha, view.headSha], root);
    const { changed, outside } = scope(root, view.baseSha, view.headSha);
    if (!changed.length) reasons.push('the PR changes nothing');
    if (outside.length) reasons.push(`files that may not skip review: ${outside.join(', ')}`);
    // Every exempt entry the PR touches is re-rendered from the head's data with the base's renderer: the render
    // validates the data, and its outputs must be exactly what the PR carries.
    const config = configAt(root, view.baseSha);
    const rendered = config ? exemptEntries(config.artifacts).filter(a => [a.path, ...a.outputs].some(f => changed.includes(f))) : [];
    if (!outside.length && rendered.length) {
      const wt = freshWorktree(root, view.headSha);
      try {
        for (const a of rendered) sh(a.then, wt.dir);
        const differs = changedFiles(['HEAD'], wt.dir);
        if (differs.length) reasons.push(`outputs that their renderer does not reproduce: ${differs.join(', ')}`);
      } catch (err) { reasons.push(`the renderer failed: ${err.message}`); }
      finally { wt.remove(); }
    }
  }
  return { view, reasons };
}

function readStdin(timeoutMs = 500) {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const done = () => resolve(data);
    setTimeout(done, timeoutMs).unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => { data += d; });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

function option(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

async function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === 'hook') {
    // A hook never fails the agent: whatever happens, exit 0. Claude passes its cwd on stdin, Pi with --cwd.
    try {
      let cwd = option(args, '--cwd');
      if (!cwd) { try { cwd = JSON.parse(await readStdin() || '{}').cwd; } catch { /* no payload */ } }
      console.error(`artifact-sync: ${hook(cwd || process.cwd())}`);
    } catch (err) { console.error(`artifact-sync: ${err.message}`); }
    return 0;
  }
  if (cmd === 'due') {
    const p = plan(option(args, '--cwd') || process.cwd());
    console.log(p.skip ? `nothing to do: ${p.skip}` : p.due.length ? p.due.map(d => `${d.path}  <-  ${d.changed.join(', ')}`).join('\n') : 'no artifact is due');
    return 0;
  }
  if (cmd === 'run') {
    const opts = { root: option(args, '--root'), branch: option(args, '--branch'), base: option(args, '--base'), head: option(args, '--head') };
    const token = option(args, '--token');
    if (Object.values(opts).some(v => !v)) { console.error('run needs --root, --branch, --base and --head'); return 2; }
    try { console.log(`${new Date().toISOString()} ${run({ ...opts, token })}`); return 0; }
    catch (err) { console.error(`${new Date().toISOString()} artifact sync failed: ${err.message}`); return 1; }
  }
  if (cmd === 'scope') {
    const pr = option(args, '--pr');
    if (!pr) { console.error('scope needs --pr <number>, run in the clone whose sync published it'); return 2; }
    const root = git(['rev-parse', '--show-toplevel'], process.cwd());
    const { view, reasons } = prScope(root, pr);
    if (reasons.length) { console.error(`PR #${pr} is not an exempt artifact PR; the full review applies:\n${reasons.map(r => `  ${r}`).join('\n')}`); return 1; }
    console.log(`PR #${pr}: artifact-only, published by this clone's sync; it may skip the double-pass review.\nMerge exactly this head: --match-head-commit ${view.headSha}`);
    return 0;
  }
  if (cmd === 'merge') {
    // The exemption, used: check the PR, then merge exactly the head that was checked. gh refuses if the head moved.
    const pr = option(args, '--pr');
    if (!pr) { console.error('merge needs --pr <number>'); return 2; }
    const root = git(['rev-parse', '--show-toplevel'], process.cwd());
    const { view, reasons } = prScope(root, pr);
    if (reasons.length) { console.error(`PR #${pr} is not an exempt artifact PR; review it as usual:\n${reasons.map(r => `  ${r}`).join('\n')}`); return 1; }
    const merged = spawnSync('gh', ['pr', 'merge', pr, '--repo', originRepo(root), '--merge', '--match-head-commit', view.headSha], { cwd: root, encoding: 'utf8', stdio: 'inherit' });
    return merged.status === 0 ? 0 : 1;
  }
  console.error('usage: artifact-sync.js hook [--cwd <dir>] | due [--cwd <dir>] | scope --pr <number> | merge --pr <number> | run --root <dir> --branch <b> --base <sha> --head <sha>');
  return 2;
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });

module.exports = { CONFIG, ENV_FLAG, HARNESSES, changedFiles, exemptEntries, originRepo, releaseLock, exemptPaths, prScope, safeName, claimLock, globToRegExp, matchesAny, parseConfig, dueEntries, ownedPaths, ticketOf, plan, hook, run, scope, prompt, commitMessage, acquireLock };
