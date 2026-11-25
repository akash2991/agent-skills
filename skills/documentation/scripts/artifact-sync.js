#!/usr/bin/env node
'use strict';

// Keeps artifacts current (documentation W12): the md, html, and similar files that are built from code or describe it.
// models.json at the repository root maps each artifact to its sources and names the model that updates it.
//
//   hook [--cwd <dir>]                    an agent finished: when committed code since the last sync touches an
//                                         artifact's sources, start `run` in the background and return at once
//   run --root <dir> --branch <b> --base <sha> --head <sha>
//                                         (background) update the artifacts in their own worktree on <b>-artifacts,
//                                         commit, push, and open a PR into <b>
//   due [--cwd <dir>]                     print what `hook` would sync now, without starting anything
//   scope --base <ref> [--head <ref>]     exit 0 when every file changed in base...head is an artifact or an artifact's
//                                         output in <base>'s models.json: the PR skips the double-pass review
//
// Code decides everything but the edit: which artifacts are due, the worktree, the commit, the push, and the PR.
// Only the edit itself is the agent's. BRAIN_ARTIFACT_SYNC=1 marks the sync agent, so its own finish starts nothing.

const { execFileSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIG = 'models.json';
const ENV_FLAG = 'BRAIN_ARTIFACT_SYNC';
const SUFFIX = '-artifacts';
const AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const STALE_START_MS = 60 * 1000;
const HARNESSES = {
  claude: (entry, prompt) => ['claude', ['-p', prompt, '--model', entry.model, '--effort', entry.effort,
    '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Edit,Write,Glob,Grep,Bash(git diff:*),Bash(git log:*),Bash(git show:*)']],
  pi: (entry, prompt) => {
    const slash = entry.model.indexOf('/');
    return ['pi', ['-p', '--provider', entry.model.slice(0, slash), '--model', entry.model.slice(slash + 1),
      '--thinking', entry.effort, '--tools', 'read,bash,grep,find,ls,edit,write', prompt]];
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

function safeName(branch) {
  return branch.replace(/[^A-Za-z0-9._-]/g, '_');
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

// One sync per code branch. The lock holds the sync's pid; a lock whose pid is gone, or that never got one within a
// minute, is stale and taken over.
function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, 'starting', { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let held = true;
      try {
        const pid = Number(fs.readFileSync(file, 'utf8'));
        held = pid ? alive(pid) : Date.now() - fs.statSync(file).mtimeMs < STALE_START_MS;
      } catch { held = false; }
      if (held) return false;
      fs.rmSync(file, { force: true });
    }
  }
  return false;
}

function defaultBranch(root) {
  const ref = tryGit(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], root);
  return ref ? ref.replace(/^refs\/remotes\/origin\//, '') : 'main';
}

// What `hook` would do now, and with what. Never writes anything.
function plan(cwd, env = process.env) {
  if (env[ENV_FLAG]) return { skip: 'this is the sync agent' };
  const root = tryGit(['rev-parse', '--show-toplevel'], cwd);
  if (!root) return { skip: 'not a git repository' };
  const config = loadConfig(root);
  if (!config || !config.artifacts.length) return { skip: `no artifacts in ${CONFIG}` };
  if (!config.sync) return { skip: `no artifact-sync model in ${CONFIG}` };
  const branch = tryGit(['branch', '--show-current'], root);
  if (!branch) return { skip: 'detached HEAD' };
  const main = defaultBranch(root);
  if (branch === main || branch === 'main' || branch.endsWith(SUFFIX)) return { skip: `branch ${branch} is not a code branch` };
  if (!tryGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], root)) return { skip: `${branch} is not on origin yet` };
  const head = git(['rev-parse', 'HEAD'], root);
  const dir = stateDir(root);
  const state = readState(dir, branch);
  if (state.synced === head || state.attempted === head) return { skip: `${head.slice(0, 7)} already synced or attempted` };
  const fromState = state.synced && tryGit(['merge-base', '--is-ancestor', state.synced, head], root) !== null ? state.synced : null;
  const base = fromState || tryGit(['merge-base', head, `refs/remotes/origin/${main}`], root) || tryGit(['merge-base', head, main], root);
  if (!base) return { skip: `no base to compare ${branch} with` };
  const changed = lines(git(['diff', '--name-only', base, head], root));
  const due = dueEntries(config.artifacts, changed);
  return { root, branch, base, head, dir, due, config };
}

function hook(cwd, env = process.env, launch = spawn) {
  const p = plan(cwd, env);
  if (p.skip) return p.skip;
  if (!p.due.length) {
    writeState(p.dir, p.branch, { synced: p.head });
    return 'no artifact is due';
  }
  const lock = path.join(p.dir, `${safeName(p.branch)}.lock`);
  if (!acquireLock(lock)) return 'a sync is already running for this branch';
  writeState(p.dir, p.branch, { attempted: p.head });
  const log = fs.openSync(path.join(p.dir, `${safeName(p.branch)}.log`), 'a');
  const child = launch(process.execPath, [__filename, 'run', '--root', p.root, '--branch', p.branch, '--base', p.base, '--head', p.head],
    { cwd: p.root, detached: true, stdio: ['ignore', log, log], env: { ...env, [ENV_FLAG]: '1' } });
  fs.writeFileSync(lock, String(child.pid));
  child.unref();
  fs.closeSync(log);
  return `started the artifact sync for ${p.due.map(d => d.path).join(', ')}`;
}

function prompt({ branch, base, head, due }) {
  const list = due.map(d => `- ${d.path}\n  changed sources: ${d.changed.join(', ')}`).join('\n');
  return [
    `You keep this repository's artifacts current. Commits ${base.slice(0, 7)}..${head.slice(0, 7)} on branch ${branch} changed code that these artifacts describe:`,
    '',
    list,
    '',
    `Read what changed (git diff ${base} ${head} -- <source>) and the code as it is now, then update each artifact so it is accurate for the code at ${head.slice(0, 7)}.`,
    'Edit only the artifact files listed above. Do not edit code, tests, config, or any other file. Do not commit, push, or run builds: the caller does that.',
    'If an artifact is already accurate, leave it unchanged. Keep each artifact\'s existing structure and voice; follow the repository\'s AGENTS.md and documentation conventions.',
  ].join('\n');
}

function sh(command, cwd) {
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`"${command}" failed: ${(r.stderr || r.stdout || '').trim().slice(-2000)}`);
}

function worktreePath(root, name) {
  const main = path.dirname(path.resolve(root, git(['rev-parse', '--git-common-dir'], root)));
  return path.join(path.dirname(main), `${path.basename(main)}-worktrees`, safeName(name));
}

// The sync's own worktree on <branch>-artifacts, brought up to <head>. Reused between syncs.
function prepareWorktree(root, branch, head, ticket) {
  const name = `${branch}${SUFFIX}`;
  const dir = worktreePath(root, name);
  const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
  const listed = lines(git(['worktree', 'list', '--porcelain'], root))
    .some(l => l.startsWith('worktree ') && real(l.slice('worktree '.length)) === real(dir));
  if (!listed) {
    if (tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], root)) git(['worktree', 'add', dir, name], root);
    else git(['worktree', 'add', '-b', name, dir, head], root);
  }
  git(['reset', '--hard', '--quiet'], dir);
  git(['clean', '-fdq'], dir);
  if (git(['branch', '--show-current'], dir) !== name) throw new Error(`${dir} is not on ${name}`);
  if (tryGit(['merge-base', '--is-ancestor', head, 'HEAD'], dir) === null) {
    const message = `Merge branch '${branch}' into ${name}${ticket ? ` [${ticket}]` : ''}`;
    try { git(['merge', '--no-edit', '-m', message, head], dir); }
    catch (err) { tryGit(['merge', '--abort'], dir); throw new Error(`cannot merge ${head.slice(0, 7)} into ${name}: ${err.message}`); }
  }
  return { dir, name };
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
    `Artifact sync for \`${branch}\` at ${head.slice(0, 7)} (from ${base.slice(0, 7)}).${ticket ? ` Ticket: ${ticket}.` : ''}`,
    '',
    ...due.map(d => `- \`${d.path}\`: sources changed: ${d.changed.map(f => `\`${f}\``).join(', ')}`),
    '',
    'Only artifact paths from `models.json` change here; `artifact-sync.js scope --base <code branch>` checks that. Merge it into the code branch.',
  ].join('\n');
}

// deps.spawnSync runs the agent and gh, deps.push the push: tests replace them, never git itself.
function run({ root, branch, base, head }, deps = {}) {
  const exec = deps.spawnSync || spawnSync;
  const dir = stateDir(root);
  const lock = path.join(dir, `${safeName(branch)}.lock`);
  try {
    const config = loadConfig(root);
    if (!config || !config.sync || !HARNESSES[config.sync.harness]) throw new Error(`no usable artifact-sync entry in ${CONFIG}`);
    const changed = lines(git(['diff', '--name-only', base, head], root));
    const due = dueEntries(config.artifacts, changed);
    if (!due.length) { writeState(dir, branch, { synced: head }); return 'no artifact is due'; }
    const ticket = ticketOf(branch);
    const wt = prepareWorktree(root, branch, head, ticket);
    const [cmd, args] = HARNESSES[config.sync.harness](config.sync, prompt({ branch, base, head, due }));
    const env = { ...process.env, [ENV_FLAG]: '1' };
    const agent = exec(cmd, args, { cwd: wt.dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: AGENT_TIMEOUT_MS, env });
    if (agent.error || agent.status !== 0) throw new Error(`${cmd} failed: ${agent.error ? agent.error.message : (agent.stderr || '').trim().slice(-2000)}`);
    for (const d of due) if (d.then) sh(d.then, wt.dir);
    const touched = [...new Set([...lines(git(['diff', '--name-only', 'HEAD'], wt.dir)), ...lines(git(['ls-files', '--others', '--exclude-standard'], wt.dir))])];
    if (!touched.length) { writeState(dir, branch, { synced: head }); return 'artifacts already current'; }
    const outside = touched.filter(f => !ownedPaths(due).has(f));
    if (outside.length) throw new Error(`the sync agent changed files that are not its artifacts, nothing committed: ${outside.join(', ')}`);
    git(['add', '--', ...touched], wt.dir);
    execFileSync('git', ['commit', '--quiet', '-F', '-'], { cwd: wt.dir, input: commitMessage({ due, head, ticket, sync: config.sync }), env, stdio: ['pipe', 'pipe', 'pipe'] });
    (deps.push || (() => git(['push', '--quiet', '-u', 'origin', wt.name], wt.dir)))();
    const open = exec('gh', ['pr', 'list', '--head', wt.name, '--state', 'open', '--json', 'number', '--jq', '.[0].number'], { cwd: wt.dir, encoding: 'utf8' });
    let pr = open.status === 0 ? (open.stdout || '').trim() : '';
    if (!pr) {
      const title = `${ticket ? `${ticket}: ` : ''}artifacts for ${branch} at ${head.slice(0, 7)}`;
      const made = exec('gh', ['pr', 'create', '--base', branch, '--head', wt.name, '--title', title, '--body', prBody({ branch, base, head, due, ticket })], { cwd: wt.dir, encoding: 'utf8' });
      if (made.status !== 0) throw new Error(`pushed ${wt.name}, but gh pr create failed: ${(made.stderr || '').trim()}`);
      pr = (made.stdout || '').trim();
    }
    writeState(dir, branch, { synced: head, error: null });
    return `artifacts committed on ${wt.name}; PR ${pr}`;
  } catch (err) {
    writeState(dir, branch, { error: `${new Date().toISOString()} ${head.slice(0, 7)}: ${err.message}` });
    throw err;
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

// Files changed in base...head that are not artifacts in <base>'s models.json. The base's config, so a PR cannot
// widen its own exemption; models.json is never an artifact, so a PR that edits it is never exempt.
function scope(root, base, head = 'HEAD') {
  const config = configAt(root, base);
  const changed = lines(git(['diff', '--name-only', `${base}...${head}`], root));
  if (!config || !config.artifacts.length) return { changed, outside: changed };
  const owned = ownedPaths(config.artifacts);
  return { changed, outside: changed.filter(f => !owned.has(f)) };
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
    if (Object.values(opts).some(v => !v)) { console.error('run needs --root, --branch, --base and --head'); return 2; }
    try { console.log(`${new Date().toISOString()} ${run(opts)}`); return 0; }
    catch (err) { console.error(`${new Date().toISOString()} artifact sync failed: ${err.message}`); return 1; }
  }
  if (cmd === 'scope') {
    const base = option(args, '--base');
    if (!base) { console.error('scope needs --base <ref>'); return 2; }
    const root = git(['rev-parse', '--show-toplevel'], process.cwd());
    const { changed, outside } = scope(root, base, option(args, '--head'));
    if (!changed.length) { console.error('no change against the base: not an artifact PR'); return 1; }
    if (outside.length) { console.error(`not artifact-only; the full review applies. Outside the artifacts in ${CONFIG}:\n${outside.map(f => `  ${f}`).join('\n')}`); return 1; }
    console.log(`artifact-only: ${changed.length} file(s), all artifacts in ${CONFIG}`);
    return 0;
  }
  console.error('usage: artifact-sync.js hook [--cwd <dir>] | due [--cwd <dir>] | scope --base <ref> [--head <ref>] | run --root <dir> --branch <b> --base <sha> --head <sha>');
  return 2;
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });

module.exports = { CONFIG, ENV_FLAG, HARNESSES, globToRegExp, matchesAny, parseConfig, dueEntries, ownedPaths, ticketOf, plan, hook, run, scope, prompt, commitMessage, acquireLock };
