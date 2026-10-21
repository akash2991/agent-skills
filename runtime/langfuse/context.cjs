'use strict';

// Shared, synchronous, local-only protocol. No environment traceparent, transcript,
// prompt, tool payload, raw launch identifier, cwd, or remote URL is stored here.
const fs = require('node:fs');
const os = require('node:os');
const { claimLock } = require('./locks.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { safeIdentity, structuralIdentity } = require('./privacy.cjs');

const HOUR = 3600000;
// Permission/trust pauses can outlast an hour. Exact invocation identities
// remain bound for a day; pane scopes additionally bind the native session ID.
const TTL = { sessions: 7 * 24 * HOUR, runs: 7 * 24 * HOUR, launches: 24 * HOUR, pending: 24 * HOUR };
const RETENTION = 24 * HOUR; // Expired aliases remain tombstones; never silently rebind a stale pane.
const LIMIT = { sessions: 1024, runs: 2048, launches: 4096, pending: 256 };
const MAX_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_KEYS = new Set(['traceId', 'rootSpanId', 'parentSpanId', 'sessionId', 'nativeSessionId', 'runId',
  'projectId', 'projectName', 'worktreeId', 'branch', 'runtimeName', 'agentName', 'persona', 'ticketId',
  'ticketSource', 'harness', 'parentSessionId', 'skillsInvoked', 'skillsLoaded', 'startedAt',
  'requestedModel', 'requestedEffort', 'observedModel', 'observedEffort', 'evidenceSource']);
const RECORD_KEYS = new Set(['id', 'traceId', 'parentId', 'sessionId', 'nativeSessionId', 'type', 'name',
  'startTime', 'endTime', 'model', 'provider', 'usage', 'cost', 'context', 'outcome']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const randomHex = bytes => crypto.randomBytes(bytes).toString('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const fail = () => { throw new Error('Invalid tracing context'); };

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  return value;
}
function keys(value, allowed) {
  plain(value);
  if (Object.keys(value).some(key => !allowed.has(key))) fail();
}
function hex(value, size) {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${size}}$`, 'i').test(value) || /^0+$/.test(value)) fail();
  return value.toLowerCase();
}
function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)) fail();
  return value.toLowerCase();
}
function nativeId(value) {
  if (typeof value !== 'string') fail();
  if (UUID.test(value)) return uuid(value);
  if (/^(?:sha256:)?[0-9a-f]{16,128}$/i.test(value) && !/^(?:sha256:)?0+$/i.test(value)) return value.toLowerCase();
  fail();
}
function label(value) {
  if (value === undefined || value === null) return null;
  // Deliberately not a general text sanitizer: only normalized metadata tokens.
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_.:+-]{0,127}$/i.test(value) ||
      /(?:password|secret|bearer|api[_-]?key|sk-[a-z0-9]{12})/i.test(value) ||
      !(safeIdentity(value) || structuralIdentity('projectId', value) || structuralIdentity('worktreeId', value))) fail();
  return value;
}
function modelName(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 128 || value.split('/').length > 2) fail();
  value.split('/').forEach(part => { if (!label(part)) fail(); });
  return value;
}
function branchName(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_./+-]{0,199}$/i.test(value) || value.includes('..') || !safeIdentity(value)) fail();
  return value;
}
function ticket(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[a-z][a-z0-9]{1,15}-[1-9][0-9]{0,11}$/i.test(value)) fail();
  return value.toUpperCase();
}
function time(value) {
  const date = new Date(value);
  if ((typeof value !== 'string' && typeof value !== 'number') || !Number.isFinite(date.getTime())) fail();
  return date.toISOString();
}
function safeRun(input) {
  // Strip non-protocol fields rather than serializing caller-owned objects.
  plain(input);
  const out = {
    traceId: hex(input.traceId, 32), rootSpanId: hex(input.rootSpanId, 16),
    parentSpanId: input.parentSpanId == null ? null : hex(input.parentSpanId, 16),
    sessionId: uuid(input.sessionId), nativeSessionId: nativeId(input.nativeSessionId), runId: uuid(input.runId)
  };
  if (!['pi', 'claude'].includes(input.harness)) fail();
  out.harness = input.harness;
  for (const key of ['projectId', 'projectName', 'worktreeId', 'runtimeName', 'agentName', 'persona', 'requestedEffort', 'observedEffort', 'evidenceSource']) {
    out[key] = label(input[key]);
  }
  out.requestedModel = modelName(input.requestedModel);
  out.observedModel = modelName(input.observedModel);
  out.branch = branchName(input.branch);
  out.ticketId = ticket(input.ticketId);
  if (!['explicit', 'inferred', 'unknown'].includes(input.ticketSource) ||
      (out.ticketId === null) !== (input.ticketSource === 'unknown')) fail();
  out.ticketSource = input.ticketSource;
  if (input.parentSessionId != null) out.parentSessionId = nativeId(input.parentSessionId);
  for (const key of ['skillsInvoked', 'skillsLoaded']) {
    const values = input[key] || [];
    if (!Array.isArray(values) || values.length > 128) fail();
    out[key] = [...new Set(values.map(value => { if (value == null) fail(); return label(value); }))];
  }
  out.startedAt = time(input.startedAt);
  return out;
}
function numericMap(value, allowed) {
  keys(value, new Set(allowed));
  const out = {};
  for (const [key, number] of Object.entries(value)) {
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 1e15) fail();
    out[key] = number;
  }
  return out;
}
function safeRecord(input) {
  keys(input, RECORD_KEYS);
  const out = {
    id: UUID.test(input.id) ? uuid(input.id) : hex(input.id, 16), traceId: hex(input.traceId, 32),
    parentId: input.parentId == null ? null : UUID.test(input.parentId) ? uuid(input.parentId) : hex(input.parentId, 16),
    sessionId: uuid(input.sessionId), nativeSessionId: nativeId(input.nativeSessionId),
    type: label(input.type), name: label(input.name), startTime: time(input.startTime),
    endTime: input.endTime == null ? null : time(input.endTime)
  };
  if (!out.type || !out.name) fail();
  if (input.model != null) out.model = modelName(input.model);
  if (input.provider != null) out.provider = label(input.provider);
  if (input.usage != null) out.usage = numericMap(input.usage, ['input', 'output', 'total', 'inputTokens', 'outputTokens',
    'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cachedInputTokens', 'reasoningTokens']);
  if (input.cost != null) out.cost = typeof input.cost === 'number'
    ? numericMap({ total: input.cost }, ['total']).total : numericMap(input.cost, ['input', 'output', 'total']);
  if (input.outcome != null) {
    if (!['success', 'error', 'cancelled', 'aborted', 'unknown', 'pending', 'completed', 'ok'].includes(input.outcome)) fail();
    out.outcome = input.outcome;
  }
  if (input.context != null) {
    keys(input.context, RUN_KEYS);
    // Validate partial context using the same run schema, not recursive arbitrary metadata.
    const defaults = { ...out, rootSpanId: hash(out.id).slice(0, 16),
      parentSpanId: out.parentId && /^[0-9a-f]{16}$/.test(out.parentId) ? out.parentId : null, runId: crypto.randomUUID(),
      harness: 'pi', ticketSource: 'unknown', startedAt: out.startTime };
    const validated = safeRun({ ...defaults, ...input.context });
    out.context = {};
    for (const key of Object.keys(input.context)) out.context[key] = validated[key];
  }
  return out;
}

function git(cwd, args) {
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^GIT_(?:CONFIG|DIR$|WORK_TREE$|COMMON_DIR$|CEILING_DIRECTORIES$)/.test(key)) delete env[key];
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 2000, maxBuffer: 16384,
      stdio: ['ignore', 'pipe', 'ignore'], env: { ...env, GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull, GIT_OPTIONAL_LOCKS: '0' } }).trim();
  } catch { return null; }
}
function remoteIdentity(raw) {
  if (!raw || raw.length > 4096) return null;
  try {
    // SCP and URL syntax normalize to the same host/path identity. Userinfo,
    // query and fragment are never part of the identity, including its hash.
    let value = raw;
    if (!value.includes('://') && /^(?:[^/@:]+@)?[^/:]+:.+/.test(value)) {
      value = `ssh://${value.replace(/^(?:[^/@:]+@)?([^/:]+):/, '$1/')}`;
    }
    const url = new URL(value);
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname) return null;
    const repoPath = url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '');
    if (!repoPath || /%|[\s\\]/.test(repoPath)) return null;
    return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}${repoPath}`;
  } catch { return null; }
}
function project(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) fail();
  const actual = fs.realpathSync(cwd);
  const top = git(actual, ['rev-parse', '--show-toplevel']) || actual;
  const common = git(actual, ['rev-parse', '--git-common-dir']);
  const principal = common ? fs.realpathSync(path.resolve(actual, common)) : top;
  const remote = remoteIdentity(git(actual, ['remote', 'get-url', 'origin']));
  const canonical = remote || principal;
  const rawName = remote ? remote.split('/').pop() : path.basename(common ? path.dirname(principal) : top);
  const safeLabel = value => { try { return label(value); } catch { return 'unknown'; } };
  let branch = null;
  try { branch = branchName(git(actual, ['symbolic-ref', '--quiet', '--short', 'HEAD'])); } catch { /* unknown */ }
  return { projectId: `project-${hash(canonical).slice(0, 32)}`, projectName: safeLabel(rawName),
    worktreeId: `worktree-${hash(top).slice(0, 32)}`, branch, runtimeName: safeLabel(path.basename(top)) };
}
function childMetadata(child = {}) {
  keys(child, new Set(['persona', 'agentName', 'ticketId']));
  return { persona: label(child.persona), agentName: label(child.agentName), ticketId: ticket(child.ticketId) };
}
function identity(input) {
  plain(input);
  const aliases = [];
  for (const key of ['nonce', 'launchId', 'sessionFile']) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !value.length || value.length > 4096 || /[\x00-\x1f]/.test(value)) fail();
    if (key === 'nonce' && !/^[a-z0-9_-]{32,128}$/i.test(value)) fail();
    if (key === 'sessionFile' && !path.isAbsolute(value)) fail();
    aliases.push(`${key}:${hash(key === 'sessionFile' ? path.normalize(value) : value)}`);
  }
  if (!aliases.length) fail();
  return aliases;
}

function checkDir(dir, privateDir) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (stat.uid !== process.getuid() && (privateDir || stat.uid !== 0)) ||
      (privateDir ? (stat.mode & 0o077) !== 0 : (stat.mode & 0o022) !== 0 && !(stat.mode & 0o1000))) {
    throw new Error('Unsafe tracing state directory');
  }
}
function prepareDirectory(dir) {
  const parent = path.dirname(dir);
  if (parent !== dir) prepareAncestor(parent);
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  checkDir(dir, true);
}
function prepareAncestor(dir) {
  const parent = path.dirname(dir);
  if (parent !== dir) prepareAncestor(parent);
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  checkDir(dir, false);
}

class ContextStore {
  constructor({ stateDir, now = Date.now } = {}) {
    if (typeof now !== 'function') fail();
    this.stateDir = path.resolve(stateDir || path.join(os.homedir(), '.cache', 'agent-brain', 'tracing-state'));
    this.now = now;
    prepareDirectory(this.stateDir);
    this.file = path.join(this.stateDir, 'context-v1.json');
  }

  _transaction(fn) {
    // The same crash-recoverable protocol covers every read/prune/claim/write.
    prepareDirectory(this.stateDir);
    const deadline = Date.now() + 5000, lock = claimLock(this.stateDir, 'context', { deadlineAt: deadline });
    try {
      while (lock.blocked()) {
        if (Date.now() >= deadline) throw new Error('Tracing state is busy');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    } catch (error) { lock.release(); throw error; }
    let temporary;
    try {
      const now = this.now();
      if (!Number.isFinite(now)) fail();
      let state = { version: 1, sessions: {}, runs: {}, launches: {}, pending: {} };
      let fd;
      try {
        fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.nlink !== 1 || stat.size > MAX_BYTES) {
          throw new Error('Unsafe tracing state file');
        }
        try { state = JSON.parse(fs.readFileSync(fd, 'utf8')); }
        catch { throw new Error('Invalid tracing state'); }
        if (state.version !== 1) fail();
        for (const kind of Object.keys(LIMIT)) plain(state[kind]);
      } catch (error) { if (error.code !== 'ENOENT') throw error; } finally { if (fd !== undefined) fs.closeSync(fd); }
      for (const kind of Object.keys(LIMIT)) {
        for (const [key, value] of Object.entries(state[kind])) {
          if (value.expiresAt + (kind === 'launches' ? RETENTION : 0) <= now) delete state[kind][key];
        }
      }
      const result = fn(state, now);
      for (const kind of Object.keys(LIMIT)) {
        if (Object.keys(state[kind]).length > LIMIT[kind]) throw new Error('Tracing state capacity exceeded');
      }
      const data = JSON.stringify(state);
      if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('Tracing state capacity exceeded');
      temporary = path.join(this.stateDir, `.context-${randomHex(16)}.tmp`);
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file);
      const dirFd = fs.openSync(this.stateDir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      return result == null ? result : clone(result);
    } finally {
      try { if (temporary) { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } } }
      finally { lock.release(); }
    }
  }

  _sessionKey(harness, id) {
    if (!['pi', 'claude'].includes(harness)) fail();
    return hash(`${harness}:${nativeId(id)}`);
  }

  _save(state, run, now) {
    const sessionKey = this._sessionKey(run.harness, run.nativeSessionId);
    const session = state.sessions[sessionKey];
    const unresolved = state.runs[run.runId]?.unresolved || (session?.run.runId === run.runId && session.unresolved);
    state.runs[run.runId] = { run, expiresAt: now + TTL.runs,
      ...(unresolved ? { unresolved: true } : {}), ...(state.runs[run.runId]?.drained ? { drained: true } : {}) };
    state.sessions[sessionKey] = { run, expiresAt: now + TTL.sessions, ...(unresolved ? { unresolved: true } : {}) };
    return run;
  }

  getSession(harness, nativeSessionId) {
    const key = this._sessionKey(harness, nativeSessionId);
    return this._transaction(state => state.sessions[key]?.run || null);
  }

  getRun(runId) {
    runId = uuid(runId);
    return this._transaction(state => state.runs[runId]?.run || null);
  }

  _current(state, run) {
    const current = state.runs[run.runId]?.run;
    if (current && (current.rootSpanId !== run.rootSpanId || current.nativeSessionId !== run.nativeSessionId ||
        current.harness !== run.harness)) throw new Error('Mismatched tracing run');
    return current || run;
  }

  saveSession(run) {
    const safe = safeRun(run);
    return this._transaction((state, now) => {
      const current = this._current(state, safe);
      // A stale process must not undo an exact delayed-binding rebase.
      return this._save(state, safeRun({ ...safe, traceId: current.traceId, sessionId: current.sessionId,
        parentSpanId: current.parentSpanId, parentSessionId: current.parentSessionId, startedAt: current.startedAt }), now);
    });
  }

  updateRun(run, patch) {
    keys(patch, RUN_KEYS);
    // Identity and lineage are immutable outside the atomic pending rebase.
    const mutable = new Set(['agentName', 'persona', 'ticketId', 'ticketSource', 'runtimeName',
      'requestedModel', 'requestedEffort', 'observedModel', 'observedEffort', 'evidenceSource', 'skillsInvoked', 'skillsLoaded']);
    if (Object.keys(patch).some(key => !mutable.has(key))) fail();
    const original = safeRun(run);
    return this._transaction((state, now) => {
      const current = state.runs[original.runId]?.run || original;
      const next = { ...current, ...patch };
      for (const key of ['skillsInvoked', 'skillsLoaded']) if (patch[key]) {
        next[key] = [...new Set([...(current[key] || []), ...patch[key]])];
      }
      return this._save(state, safeRun(next), now);
    });
  }

  createRun(options) {
    plain(options);
    const info = project(options.cwd);
    const native = nativeId(options.nativeSessionId);
    const parent = options.parent ? safeRun(options.parent) : null;
    let ticketId = ticket(options.ticketId) || parent?.ticketId || null;
    let ticketSource = ticketId ? options.ticketId ? 'explicit' : parent.ticketSource : 'unknown';
    if (!ticketId) {
      const found = [...new Set((info.branch || '').toUpperCase().match(/\b[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,11}\b/g) || [])];
      if (found.length === 1) { ticketId = found[0]; ticketSource = 'inferred'; }
    }
    return this._transaction((state, now) => {
      const previous = state.sessions[this._sessionKey(options.harness, native)]?.run;
      const linkedParent = parent ? this._current(state, parent) : null;
      return this._save(state, safeRun({ ...info, harness: options.harness, nativeSessionId: native,
        traceId: linkedParent?.traceId || randomHex(16), rootSpanId: randomHex(8), parentSpanId: linkedParent?.rootSpanId || null,
        sessionId: linkedParent?.sessionId || previous?.sessionId || crypto.randomUUID(), runId: crypto.randomUUID(),
        ...(linkedParent ? { parentSessionId: linkedParent.nativeSessionId } : {}),
        runtimeName: options.runtimeName ?? info.runtimeName, agentName: options.agentName,
        persona: options.persona, ticketId, ticketSource, requestedModel: options.requestedModel,
        requestedEffort: options.requestedEffort, skillsInvoked: [], skillsLoaded: [], startedAt: now }), now);
    });
  }

  _binding(state, aliases, now) {
    const matches = Object.values(state.launches).filter(item => aliases.some(alias => item.aliases.includes(alias)));
    if (matches.length !== 1 || !aliases.every(alias => matches[0].aliases.includes(alias)) || matches[0].expiresAt <= now) return null;
    return matches[0];
  }

  _resolved(state, binding, nonce = null) {
    if (!binding) return null;
    const parent = state.runs[binding.parent.runId]?.run || binding.parent;
    // Nested children cannot export against a provisional parent. Draining the
    // outer pending context rebases these bindings before they become usable.
    const pendingRoots = new Set([...Object.values(state.pending).map(item => item.run.rootSpanId),
      ...Object.values(state.runs).filter(item => item.unresolved).map(item => item.run.rootSpanId)]);
    let ancestor = parent;
    const visited = new Set();
    while (ancestor && !visited.has(ancestor.rootSpanId)) {
      if (pendingRoots.has(ancestor.rootSpanId)) return null;
      visited.add(ancestor.rootSpanId);
      ancestor = Object.values(state.runs).find(item => item.run.traceId === parent.traceId &&
        item.run.rootSpanId === ancestor.parentSpanId)?.run;
    }
    return { parent, child: binding.child, nonce, multiUse: binding.multiUse, expiresAt: binding.expiresAt };
  }

  _launch(parentRun, { launchId, sessionFile, child, multiUse } = {}, existingNonce) {
    let parent = safeRun(parentRun);
    const metadata = child === undefined ? null : childMetadata(child);
    if (multiUse !== undefined && typeof multiUse !== 'boolean') fail();
    const nonce = existingNonce || crypto.randomBytes(32).toString('base64url');
    const aliases = identity({ nonce, launchId, sessionFile });
    return this._transaction((state, now) => {
      parent = this._current(state, parent);
      const matches = Object.values(state.launches).filter(item => aliases.some(alias => item.aliases.includes(alias)));
      if (matches.length > 1) throw new Error('Ambiguous tracing launch');
      let binding = matches[0];
      if (existingNonce && (!binding || !binding.aliases.includes(identity({ nonce: existingNonce })[0]))) {
        throw new Error('Unknown tracing launch capability');
      }
      if (binding) {
        const conflictingAlias = aliases.some(alias => !alias.startsWith('nonce:') &&
          binding.aliases.some(old => old.split(':')[0] === alias.split(':')[0] && old !== alias));
        if (binding.expiresAt <= now || binding.parent.runId !== parent.runId || binding.parent.traceId !== parent.traceId ||
            (metadata && JSON.stringify(binding.child) !== JSON.stringify(metadata)) ||
            (multiUse !== undefined && binding.multiUse !== multiUse) || binding.claim || conflictingAlias) {
          throw new Error('Mismatched or expired tracing launch');
        }
        binding.aliases = [...new Set([...binding.aliases, ...aliases])];
        if (binding.aliases.length > 16) throw new Error('Tracing alias capacity exceeded');
      } else {
        binding = { parent, child: metadata || childMetadata(), aliases, multiUse: multiUse || false, expiresAt: now + TTL.launches };
        state.launches[crypto.randomUUID()] = binding;
      }
      return { nonce, expiresAt: binding.expiresAt, multiUse: binding.multiUse };
    });
  }

  createLaunch(parent, options) { return this._launch(parent, options); }

  // A first-party launcher can allocate a capability before a pane exists,
  // then attach the exact returned pane/session identity without a new nonce.
  bindLaunch(parent, options = {}) {
    if (options.nonce !== undefined) identity({ nonce: options.nonce });
    return this._launch(parent, options, options.nonce);
  }

  resolveLaunch(input) {
    const aliases = identity(input);
    return this._transaction((state, now) => this._resolved(state, this._binding(state, aliases, now), input.nonce || null));
  }

  // Exact metadata inspection is not resolved lineage. Used only to walk the
  // local dependency graph or edit an actor's own context while export is held.
  inspectLaunch(input) {
    const aliases = identity(input);
    return this._transaction((state, now) => {
      const binding = this._binding(state, aliases, now);
      if (!binding) return null;
      return { parent: this._current(state, binding.parent), expiresAt: binding.expiresAt,
        ancestryPending: !this._resolved(state, binding) };
    });
  }

  // Optional exact, idempotent ownership claim. A different claimant cannot use
  // a single-use capability, even in a separate process. Read-only resolve is
  // intentionally available to the parent draining pending observations.
  claimLaunch(input, { claimId } = {}) {
    const aliases = identity(input);
    if (typeof claimId !== 'string' || !claimId.length || claimId.length > 1024) fail();
    const claim = hash(claimId);
    return this._transaction((state, now) => {
      const binding = this._binding(state, aliases, now);
      const result = this._resolved(state, binding, input.nonce || null);
      if (!result || (!binding.multiUse && binding.claim && binding.claim !== claim)) return null;
      if (!binding.multiUse) binding.claim = claim;
      return result;
    });
  }

  hold({ identity: input, run, records }) {
    const aliases = identity(input);
    const safe = safeRun(run);
    // An empty hold is an early unresolved marker, installed before tools can
    // launch grandchildren. It may be finalized once with sanitized records.
    if (!Array.isArray(records) || records.length > 256) fail();
    const normalized = records.map(safeRecord);
    const ids = new Set();
    for (const record of normalized) {
      if (record.traceId !== safe.traceId || record.sessionId !== safe.sessionId || ids.has(record.id)) fail();
      ids.add(record.id);
    }
    const payload = JSON.stringify(normalized);
    if (Buffer.byteLength(payload) > 256 * 1024) throw new Error('Tracing pending capacity exceeded');
    return this._transaction((state, now) => {
      // A completed run is held once. Equal retries are harmless; differing
      // retries are rejected. An early empty marker can be finalized once.
      const id = hash(safe.runId);
      const previous = state.pending[id];
      const digest = hash(JSON.stringify({ aliases: [...aliases].sort(), run: safe, records: normalized }));
      if (previous) {
        if (previous.digest === digest) return { pending: true };
        if (previous.records.length || !normalized.length || previous.run.traceId !== safe.traceId ||
            previous.run.rootSpanId !== safe.rootSpanId || previous.run.sessionId !== safe.sessionId ||
            JSON.stringify([...previous.aliases].sort()) !== JSON.stringify([...aliases].sort())) {
          throw new Error('Mismatched tracing replay');
        }
      }
      const stored = state.runs[safe.runId];
      if (stored?.drained) return { pending: false };
      state.pending[id] = { aliases, run: safe, records: normalized, digest, expiresAt: now + TTL.pending };
      this._save(state, safe, now);
      state.runs[safe.runId].unresolved = true;
      const session = state.sessions[this._sessionKey(safe.harness, safe.nativeSessionId)];
      if (session.run.runId === safe.runId) session.unresolved = true;
      return { pending: true };
    });
  }

  takePending(input) {
    const aliases = identity(input);
    return this._transaction((state, now) => {
      const binding = this._binding(state, aliases, now);
      const resolved = this._resolved(state, binding, input.nonce || null);
      if (!resolved) return [];
      const selected = Object.entries(state.pending).filter(([, item]) =>
        this._binding(state, item.aliases, now) === binding);
      const result = [];
      for (const [key, item] of selected) {
        const oldTrace = item.run.traceId;
        const oldSession = item.run.sessionId;
        const rebase = run => safeRun({ ...run, traceId: resolved.parent.traceId, sessionId: resolved.parent.sessionId,
          ...(run.runId === item.run.runId ? { parentSpanId: resolved.parent.rootSpanId,
            parentSessionId: resolved.parent.nativeSessionId } : {}) });
        const run = rebase(item.run);
        const records = item.records.map(record => ({ ...record, traceId: run.traceId, sessionId: run.sessionId,
          parentId: record.id === run.rootSpanId ? run.parentSpanId : record.parentId,
          ...(record.context ? { context: { ...record.context, traceId: run.traceId, sessionId: run.sessionId,
            ...((record.context.runId ? record.context.runId === run.runId :
              !record.context.rootSpanId || record.context.rootSpanId === run.rootSpanId)
              ? { parentSpanId: run.parentSpanId, parentSessionId: run.parentSessionId } : {}) } } : {}) }));
        // Rebase descendants already launched from the provisional trace, while
        // retaining every observation/run/span ID. No name or clock matching.
        for (const value of Object.values(state.runs)) if (value.run.traceId === oldTrace && value.run.sessionId === oldSession) value.run = rebase(value.run);
        for (const value of Object.values(state.sessions)) if (value.run.traceId === oldTrace && value.run.sessionId === oldSession) value.run = rebase(value.run);
        for (const value of Object.values(state.launches)) if (value.parent.traceId === oldTrace && value.parent.sessionId === oldSession) value.parent = rebase(value.parent);
        this._save(state, run, now);
        delete state.runs[run.runId].unresolved;
        const session = state.sessions[this._sessionKey(run.harness, run.nativeSessionId)];
        if (session.run.runId === run.runId) delete session.unresolved;
        if (item.records.length) state.runs[run.runId].drained = true;
        delete state.pending[key];
        result.push({ run, records });
      }
      return result;
    });
  }
}

module.exports = { ContextStore };
