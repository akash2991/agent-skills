'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ContextStore } = require('./context.cjs');
const { sanitizeObservation } = require('./privacy.cjs');
const { queueObservation, reserveRevisions, flushOutbox } = require('./export.cjs');
const { claimLock } = require('./locks.cjs');

const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const id = seed => seed === undefined ? crypto.randomBytes(8).toString('hex') : hash(seed).slice(0, 16);
const MAX_STATE = 1024 * 1024;
const ADAPTER_LIMITS = Object.freeze({ files: 2048, bytes: 32 * 1024 * 1024, retentionMs: 7 * 24 * 3600 * 1000 });
const ACCOUNTING_KEYS = new Set(['input', 'output', 'total', 'input_tokens', 'output_tokens',
  'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_reasoning_tokens']);
const FORBIDDEN = /^(input|output|prompt|content|command|args|arguments|env|environment|errorMessage|last_assistant_message|tool_response|tool_input|delta|reasoning|images?|attachments?|authorization|password|secret|token|cookie)$/i;
const SENSITIVE = /(?:[sp]k-lf-|sk-proj-|BRAIN_SYNTHETIC_|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\b\d{3}-\d{2}-\d{4}\b)/i;

function privateDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)
    || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe tracing state directory');
  return fs.realpathSync(dir);
}

// State is only IDs, timestamps, vetted metadata and numeric accounting. This
// guard catches accidental payload persistence in adapter checkpoint changes.
function safeState(value, depth = 0, seen = new Set()) {
  if (depth > 24) throw new Error('Tracing checkpoint budget exceeded');
  if (value === null || value === undefined || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (value.length > 8192 || SENSITIVE.test(value)) throw new Error('Sensitive tracing checkpoint rejected');
    return value;
  }
  if (typeof value !== 'object' || seen.has(value)) throw new Error('Invalid tracing checkpoint');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    if (value.length > 4096) throw new Error('Tracing checkpoint budget exceeded');
    result = value.map(item => safeState(item, depth + 1, seen));
  } else {
    const entries = Object.entries(value);
    if (entries.length > 4096) throw new Error('Tracing checkpoint budget exceeded');
    result = Object.create(null);
    for (const [key, field] of entries) {
      if (['usage', 'cost'].includes(key) && field !== undefined) {
        if (!field || typeof field !== 'object' || Array.isArray(field)) throw new Error('Invalid numeric accounting checkpoint');
        const counters = Object.entries(field);
        if (counters.some(([name, number]) => !ACCOUNTING_KEYS.has(name) || !Number.isFinite(number) || number < 0 || number > 1e12)) throw new Error('Invalid numeric accounting checkpoint');
        result[key] = Object.fromEntries(counters);
        continue;
      }
      if (FORBIDDEN.test(key) || SENSITIVE.test(key)) throw new Error('Raw tracing payload rejected');
      result[key] = safeState(field, depth + 1, seen);
    }
  }
  seen.delete(value);
  return result;
}

// Reconciliation changes identity/lineage and fills missing attribution only.
// Model/effort and skill evidence belong to the observation's capture time.
function rebaseObservation(record, run) {
  const context = { ...record.context };
  for (const key of ['traceId', 'rootSpanId', 'parentSpanId', 'sessionId', 'nativeSessionId', 'runId', 'parentSessionId']) {
    if (run[key] !== undefined) context[key] = run[key];
  }
  for (const key of ['persona', 'agentName']) if (!context[key] && run[key]) context[key] = run[key];
  if (!context.ticketId && run.ticketId) {
    context.ticketId = run.ticketId;
    context.ticketSource = run.ticketSource;
  }
  return { ...record, traceId: run.traceId, sessionId: run.sessionId, nativeSessionId: run.nativeSessionId,
    parentId: record.id === run.rootSpanId ? run.parentSpanId : record.parentId, context };
}

function createFlow(options = {}) {
  const env = options.env || process.env;
  const stateDir = privateDir(options.stateDir || env.BRAIN_TRACE_STATE_DIR || path.join(os.homedir(), '.cache', 'agent-brain', 'tracing-state'));
  const adapterDir = privateDir(path.join(stateDir, 'adapters'));
  const pendingDir = privateDir(path.join(adapterDir, 'pending'));
  const store = options.store || new ContextStore({ stateDir, ...(options.clock ? { now: options.clock } : {}) });
  const harness = options.harness || 'pi';
  const enqueue = options.queueObservation || queueObservation;
  const deliver = options.flushOutbox || flushOutbox;
  const clock = options.clock || Date.now;
  const fileFor = key => path.join(adapterDir, `${hash(key)}.json`);
  const readFile = file => {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE || (stat.mode & 0o077)
        || (process.getuid && stat.uid !== process.getuid())) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { return null; }
  };
  const writeFile = (file, data) => {
    const content = JSON.stringify(safeState(data));
    if (Buffer.byteLength(content) > MAX_STATE) throw new Error('Tracing checkpoint budget exceeded');
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe tracing checkpoint');
    }
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, file);
      const dir = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } finally { try { fs.unlinkSync(temp); } catch {} }
  };
  let actor = null, adapterLockDepth = 0;
  function transaction(fn) {
    if (adapterLockDepth) return fn();
    const deadlineAt = Date.now() + 5000;
    const lock = claimLock(adapterDir, 'context', { deadlineAt });
    try {
      while (lock.blocked()) {
        if (Date.now() >= deadlineAt) throw new Error('Tracing checkpoints are busy');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      adapterLockDepth++;
      try { return fn(); } finally { adapterLockDepth--; }
    } finally { lock.release(); }
  }
  const unwrap = data => data?.checkpointVersion === 1 ? data.state : data;
  const readState = key => unwrap(readFile(fileFor(key)));
  const sessionKey = run => `${run.harness}:${hash(run.nativeSessionId)}`;
  const checkpointFiles = () => [adapterDir, pendingDir].flatMap(dir => fs.readdirSync(dir)
    .filter(name => dir === pendingDir || /\.(?:json|tmp)$/.test(name))
    .map(name => path.join(dir, name)));

  // Opaque native adapter keys cannot be reverse-mapped to a session. Record
  // their owner at the flow boundary, without persisting keys or native paths.
  // Legacy/ownerless checkpoints are reclaimed only when no references survive.
  function collect(deadlineAt = Infinity) {
    if (Date.now() >= deadlineAt) return;
    const files = checkpointFiles(), entries = new Map();
    for (const file of files) {
      if (Date.now() >= deadlineAt) return;
      entries.set(file, readFile(file));
    }
    const roots = new Set(), sessions = new Set();
    const addRun = run => {
      if (!run?.rootSpanId) return;
      roots.add(run.rootSpanId);
      if (run.nativeSessionId) {
        const harnesses = ['pi', 'claude'].includes(run.harness) ? [run.harness] : ['pi', 'claude'];
        for (const harness of harnesses) sessions.add(`${harness}:${hash(run.nativeSessionId)}`);
      }
    };
    const addRecord = record => {
      if (!record?.nativeSessionId) return;
      const harnesses = ['pi', 'claude'].includes(record.context?.harness) ? [record.context.harness] : ['pi', 'claude'];
      for (const harness of harnesses) sessions.add(`${harness}:${hash(record.nativeSessionId)}`);
    };
    addRun(actor); // An in-process actor may still be running after store TTL.
    if (typeof store._transaction !== 'function' || Date.now() >= deadlineAt) return; // Unknown stores fail closed.
    const state = store._transaction(state => state);
    for (const item of [...Object.values(state.runs), ...Object.values(state.sessions), ...Object.values(state.pending)]) addRun(item.run);
    for (const item of Object.values(state.launches)) if (item.expiresAt > clock()) addRun(item.parent);
    // Recent checkpoints can themselves be live/replay references after the
    // store TTL (for example a tool whose completion hook arrives much later).
    for (const [file, envelope] of entries) if (path.dirname(file) === adapterDir
      && ![fileFor('health'), fileFor('delivery')].includes(file) && envelope) {
      if (Date.now() >= deadlineAt) return;
      const updatedAt = envelope.checkpointVersion === 1 ? envelope.updatedAt : fs.lstatSync(file).mtimeMs;
      if (Number.isFinite(updatedAt) && clock() - updatedAt <= ADAPTER_LIMITS.retentionMs) {
        if (envelope.ownerRoot) roots.add(envelope.ownerRoot);
        if (envelope.ownerSession) sessions.add(envelope.ownerSession);
        const data = unwrap(envelope);
        for (const run of [data?.run, data?.parent, data?.caller]) addRun(run);
      }
    }
    let unknownReference = false;
    for (const [file, batch] of entries) if (path.dirname(file) === pendingDir) {
      if (Date.now() >= deadlineAt) return;
      if (!batch) { unknownReference = true; continue; }
      roots.add(batch.runId);
      for (const record of batch.records || []) addRecord(record);
    }
    const outbox = path.join(stateDir, 'outbox');
    if (fs.existsSync(outbox)) for (const name of fs.readdirSync(outbox)) {
      if (Date.now() >= deadlineAt) return;
      // Outbox records are independently projected/validated by the exporter.
      const record = readFile(path.join(outbox, name))?.record;
      if (!record) { unknownReference = true; continue; }
      addRecord(record);
    }
    // Close over saved parent/caller/run dependencies, including ancestors that
    // have aged out of ContextStore while a deferred descendant still needs them.
    let changed = true;
    while (changed) {
      const before = roots.size + sessions.size;
      for (const [file, envelope] of entries) {
        if (Date.now() >= deadlineAt) return;
        if (path.dirname(file) !== adapterDir || !envelope) continue;
        const data = unwrap(envelope);
        if (roots.has(data?.run?.rootSpanId) || roots.has(envelope.ownerRoot)
          || sessions.has(envelope.ownerSession)) {
          for (const run of [data?.run, data?.parent, data?.caller]) addRun(run);
          if (data?.rootSpanId) roots.add(data.rootSpanId);
        }
      }
      changed = before !== roots.size + sessions.size;
    }
    for (const [file, envelope] of entries) {
      if (Date.now() >= deadlineAt) return;
      if (path.dirname(file) !== adapterDir || !envelope || file === fileFor('health')) continue;
      const data = unwrap(envelope), stat = fs.lstatSync(file);
      const updatedAt = envelope.checkpointVersion === 1 ? envelope.updatedAt : stat.mtimeMs;
      if (!Number.isFinite(updatedAt) || clock() - updatedAt <= ADAPTER_LIMITS.retentionMs) continue;
      if (unknownReference || roots.has(data?.run?.rootSpanId) || roots.has(data?.rootSpanId)
        || roots.has(envelope.ownerRoot) || sessions.has(envelope.ownerSession)) continue;
      if (!envelope.ownerSession && (roots.size || sessions.size)) continue;
      fs.unlinkSync(file);
    }
  }
  function reserve(writes) {
    const fits = () => {
      const sizes = new Map(checkpointFiles().map(file => [file, fs.lstatSync(file).size]));
      for (const [file, data] of writes) sizes.set(file, Buffer.byteLength(JSON.stringify(safeState(data))));
      // Leave room for persistent health/delivery diagnostics even at refusal.
      const diagnosticFiles = [fileFor('health'), fileFor('delivery')];
      const diagnostics = writes.every(([file]) => diagnosticFiles.includes(file));
      const ordinary = [...sizes].filter(([file]) => !diagnosticFiles.includes(file));
      return sizes.size <= ADAPTER_LIMITS.files
        && [...sizes.values()].reduce((sum, size) => sum + size, 0) <= ADAPTER_LIMITS.bytes
        && (diagnostics || (ordinary.length <= ADAPTER_LIMITS.files - 2
          && ordinary.reduce((sum, [, size]) => sum + size, 0) <= ADAPTER_LIMITS.bytes - 8192));
    };
    if (!fits()) { collect(); if (!fits()) throw new Error('Tracing checkpoint capacity exceeded'); }
  }
  const writeState = (key, data) => transaction(() => {
    const file = fileFor(key);
    const previous = readFile(file);
    // Pi can complete several roots out of order in one process. Its explicit
    // root key or saved run takes precedence over the last active hook actor.
    const owner = data?.run || (/^pi-root:[a-f0-9]{16}$/.test(key) ? readState(`run:${key.slice(8)}`)?.run : actor);
    const envelope = { checkpointVersion: 1, updatedAt: clock(),
      ...(['health', 'delivery'].includes(key) ? {} : previous?.ownerRoot
        ? { ownerRoot: previous.ownerRoot, ownerSession: previous.ownerSession }
        : owner ? { ownerRoot: owner.rootSpanId, ownerSession: sessionKey(owner) } : {}), state: data };
    reserve([[file, envelope]]);
    writeFile(file, envelope);
  });
  const inboundIdentity = env.BRAIN_TRACE_LAUNCH_ID ? { nonce: env.BRAIN_TRACE_LAUNCH_ID }
    : env.PI_SUBAGENT_ID ? { launchId: env.PI_SUBAGENT_ID }
      : env.PI_SUBAGENT_SESSION ? { sessionFile: env.PI_SUBAGENT_SESSION } : null;

  function remember(run, extra = {}) {
    actor = run;
    if (typeof extra.pendingIdentity === 'string') extra = { ...extra, pendingIdentity: { launchId: extra.pendingIdentity } };
    for (const key of ['pendingIdentity', 'launchIdentity']) if (extra[key]) extra = { ...extra, [key]: store.referenceLaunch(extra[key]) };
    const old = readState(`run:${run.rootSpanId}`) || {};
    writeState(`run:${run.rootSpanId}`, { ...old, run, ...extra });
    return run;
  }

  function resolve(run, seen = new Set()) {
    if (!run || seen.has(run.rootSpanId) || seen.size > 32) return null;
    actor = run;
    seen.add(run.rootSpanId);
    const cached = readState(`run:${run.rootSpanId}`);
    let entry = cached;
    const publication = store.getPublication(run.runId);
    // Missing/incomplete adapter publication is never evidence of a resolved
    // root. Recover from the same authoritative transaction that selected the
    // session, including its exact ownership identity and pending hold.
    if (!entry && !publication?.published) {
      // An interrupted pre-publication-protocol run has no recoverable owner.
      // Keep this refusal through metadata updates/duplicate hooks instead of
      // letting their newly written cache turn it into evidence of a root.
      if (publication?.run) remember(publication.run, { publicationBlocked: true });
      return null;
    }
    if (entry?.publicationBlocked && !publication?.published) return null;
    if (publication?.published) {
      entry = { ...entry, run: publication.run, parent: publication.parent,
        ...(publication.identity ? publication.unresolved
          ? { pendingIdentity: publication.identity, launchIdentity: null }
          : { pendingIdentity: null, launchIdentity: publication.identity } : {}) };
    }
    if (publication?.unresolved && !entry?.pendingIdentity) return null;
    // Rebuild even an unresolved cache before returning: a terminal hook may
    // retain observations now, then a parent-only flush must find them later.
    if (!cached) remember(entry.run, { parent: entry.parent,
      pendingIdentity: entry.pendingIdentity, launchIdentity: entry.launchIdentity });
    let parent = entry.parent || null;
    let child = {};
    let resolvedHint;
    if (entry.pendingIdentity) {
      const inspected = store.inspectLaunch(entry.pendingIdentity);
      if (inspected?.parent) {
        resolvedHint = resolve(inspected.parent, seen);
        if (!resolvedHint) return null;
      }
      const binding = store.claimLaunch(entry.pendingIdentity, { claimId: `${entry.run.harness}:${entry.run.nativeSessionId}` });
      if (!binding) return null;
      store.takePending(entry.pendingIdentity);
      const canonical = store.getRun(entry.run.runId);
      if (!canonical || canonical.traceId !== binding.parent.traceId || canonical.parentSpanId !== binding.parent.rootSpanId) return null;
      parent = binding.parent;
      child = binding.child || {};
    }
    if (entry.launchIdentity) {
      const binding = store.claimLaunch(entry.launchIdentity,
        { claimId: `${entry.run.harness}:${entry.run.nativeSessionId}` });
      if (!binding) return null;
      parent = binding.parent;
      child = binding.child || {};
    }
    if (!parent) {
      if (entry.run.parentSpanId) return null;
      actor = entry.run;
      return entry.run;
    }
    const currentParent = resolvedHint || resolve(parent, seen);
    if (!currentParent) return null;
    const updated = {
      ...entry.run, traceId: currentParent.traceId, parentSpanId: currentParent.rootSpanId,
      sessionId: currentParent.sessionId, parentSessionId: currentParent.nativeSessionId,
      persona: child.persona || entry.run.persona || null,
      agentName: child.agentName || entry.run.agentName,
      ticketId: child.ticketId || entry.run.ticketId || currentParent.ticketId,
      ticketSource: child.ticketId ? 'explicit' : entry.run.ticketId ? entry.run.ticketSource : currentParent.ticketSource
    };
    // Validate and persist the same winning ticket/provenance pair in both
    // stores. updateRun otherwise starts from ContextStore's pre-binding copy.
    // Changed historical runs must persist without selecting an older turn.
    // ContextStore checks the active selector inside the persistence lock.
    const changed = JSON.stringify(updated) !== JSON.stringify(entry.run);
    const saved = changed ? store.saveRun(updated) : entry.run;
    if (changed || entry.pendingIdentity || !cached) remember(saved, { parent: currentParent, pendingIdentity: null,
      ...(entry.pendingIdentity ? { launchIdentity: entry.pendingIdentity } : {}) });
    actor = saved;
    return saved;
  }

  function begin(opts) {
    // Normalize UUID spelling before deriving the stable cross-process owner.
    opts = { ...opts, nativeSessionId: opts.nativeSessionId.toLowerCase() };
    const savedLaunch = readState(`native-launch:${harness}:${opts.nativeSessionId}`);
    const savedIdentity = readState(`native-identity:${harness}:${opts.nativeSessionId}`)?.identity;
    let identity = (typeof opts.pendingIdentity === 'string' ? { launchId: opts.pendingIdentity } : opts.pendingIdentity)
      || (!opts.parent ? (savedLaunch ? { nonce: savedLaunch.nonce } : inboundIdentity || savedIdentity) : savedIdentity);
    if (!identity && !opts.parent) {
      const exact = { launchId: `brain:${harness}:${opts.nativeSessionId}` };
      // Exact identity exists even when its parent is still provisional.
      // Resolved-only lookup would misclassify recovery descendants as roots.
      if (store.inspectLaunch(exact)) identity = exact;
    }
    let binding = identity ? store.resolveLaunch(identity) : null;
    const boundNonce = identity?.nonce || identity?.capability || binding?.nonce;
    if (boundNonce) {
      const scope = readState(`pane:${boundNonce}`);
      if (scope && (scope.paneId !== env.HERDR_PANE_ID || scope.expiresAt < clock()
        || (scope.nativeSessionHash && scope.nativeSessionHash !== hash(opts.nativeSessionId)))) {
        throw new Error('Scoped launch binding does not match this child');
      }
    }
    // Pane scope checks must precede the irreversible ownership claim: an
    // unauthorized pane must not poison the legitimate child's capability.
    if (identity) binding = store.claimLaunch(identity, { claimId: `${harness}:${opts.nativeSessionId}` });
    const parent = binding?.parent || opts.parent || null;
    const run = store.createRun({ ...opts, harness, parent, publication: true, publicationIdentity: identity,
      persona: opts.persona || binding?.child?.persona,
      agentName: binding?.child?.agentName || opts.agentName,
      ticketId: opts.ticketId || binding?.child?.ticketId });
    // A racing duplicate may have won createRun/reuseSession. Never replace
    // its authoritative publication with this caller's pre-create snapshot.
    const publication = store.getPublication(run.runId);
    remember(publication?.run || run, { ...(publication?.parent ? { parent: publication.parent } : {}),
      ...(publication?.identity ? { pendingIdentity: publication.identity } : {}) });
    if (publication?.identity) writeState(`native-identity:${harness}:${opts.nativeSessionId}`, { identity: publication.identity });
    if (boundNonce && binding) {
      const scope = readState(`pane:${boundNonce}`);
      if (scope) writeState(`pane:${boundNonce}`, { ...scope, nativeSessionHash: hash(opts.nativeSessionId) });
      writeState(`launch-ack:${boundNonce}`, { nativeSessionId: run.nativeSessionId, rootSpanId: run.rootSpanId, harness,
        ...(env.HERDR_PANE_ID ? { paneId: env.HERDR_PANE_ID } : {}), acknowledgedAt: clock(), phase: 'adapter-started' });
    }
    return resolve(run) || run;
  }

  function acknowledgeSession(nativeSessionId) {
    nativeSessionId = nativeSessionId.toLowerCase();
    const savedLaunch = readState(`native-launch:${harness}:${nativeSessionId}`);
    const identity = savedLaunch ? { nonce: savedLaunch.nonce } : inboundIdentity || { launchId: `brain:${harness}:${nativeSessionId}` };
    const binding = store.resolveLaunch(identity);
    const nonce = identity.nonce || binding?.nonce;
    if (!nonce) return false;
    const scope = readState(`pane:${nonce}`);
    if (!binding && !(savedLaunch && scope)) return false;
    if (scope && (scope.paneId !== env.HERDR_PANE_ID || scope.expiresAt < clock()
      || (scope.nativeSessionHash && scope.nativeSessionHash !== hash(nativeSessionId)))) return false;
    if (binding && !store.claimLaunch(identity, { claimId: `${harness}:${nativeSessionId.toLowerCase()}` })) return false;
    if (scope) writeState(`pane:${nonce}`, { ...scope, nativeSessionHash: hash(nativeSessionId) });
    writeState(`launch-ack:${nonce}`,  { nativeSessionHash: hash(nativeSessionId), harness,
      ...(env.HERDR_PANE_ID ? { paneId: env.HERDR_PANE_ID } : {}), acknowledgedAt: clock(), phase: 'adapter-started' });
    return true;
  }

  function createToolLaunch(run) {
    const actor = resolve(run) || run;
    const binding = store.createLaunch(actor, { multiUse: true });
    writeState(`actor-capability:${binding.nonce}`, { rootSpanId: actor.rootSpanId, runId: actor.runId, expiresAt: binding.expiresAt });
    return binding;
  }

  function actorCapability(run) {
    return transaction(() => {
      const actor = resolve(run) || run;
      const key = `actor-reference:${actor.runId}`;
      const saved = readState(key);
      if (saved?.expiresAt > clock() && actorForTool(saved.nonce)?.runId === actor.runId) return saved;
      const binding = createToolLaunch(actor);
      const reference = { nonce: binding.nonce, expiresAt: binding.expiresAt };
      writeState(key, reference);
      return reference;
    });
  }

  function actorForTool(nonce) {
    if (!/^[a-z0-9_-]{32,128}$/i.test(nonce || '')) return null;
    const capability = readState(`actor-capability:${nonce}`);
    if (!capability || capability.expiresAt <= clock()) return null;
    const actor = readState(`run:${capability.rootSpanId}`)?.run;
    if (!actor || actor.runId !== capability.runId) return null;
    const binding = store.resolveLaunch({ nonce });
    return !binding || binding.parent.rootSpanId === actor.rootSpanId ? actor : null;
  }

  function session(nativeSessionId) {
    const run = store.getSession(harness, nativeSessionId);
    if (!run) return null;
    actor = resolve(run) || run;
    return actor;
  }

  function update(run, patch) {
    const current = resolve(run) || readState(`run:${run.rootSpanId}`)?.run || run;
    const updated = store.updateRun(current, patch);
    return remember(updated);
  }

  function submit(run, records) {
    if (['false', '0'].includes(String(env.BRAIN_TRACING_ENABLED || '').toLowerCase()) || ['false', '0'].includes(String(env.LANGFUSE_TRACING_ENABLED || '').toLowerCase())) return { queued: 0, pending: 0, disabled: true };
    const current = resolve(run);
    // Allocate roots locally before tools, but export their span only with
    // terminal evidence. Competing unfinished snapshots can otherwise replace
    // terminal metadata during asynchronous OTLP ingestion.
    const finished = records.filter(record => !(record.type === 'AGENT' && [undefined, 'unknown', 'pending'].includes(record.outcome)));
    const safe = finished.map(record => sanitizeObservation(rebaseObservation({ ...record,
      context: { ...run, ...record.context } }, current || run)));
    if (!safe.length) return { queued: 0, pending: 0 };
    let revisions;
    try { revisions = reserveRevisions(safe, { stateDir }); }
    catch (error) {
      writeState('health', { replayBlocked: true, reason: error.message === 'Revision capacity exceeded'
        ? 'revision_capacity' : 'revision_unavailable' });
      throw error;
    }
    const retain = (batch, tickets) => transaction(() => {
      // A native reconciliation can exceed both queue capacity and the single
      // checkpoint budget. Split before writing, and reserve the entire suffix.
      const writes = []; let chunk = [], chunkRevisions = [], bytes = 256;
      const finish = () => {
        if (chunk.length) writes.push([path.join(pendingDir, `${crypto.randomUUID()}.json`),
          { runId: run.rootSpanId, records: chunk, revisions: chunkRevisions, createdAt: clock() }]);
        chunk = []; chunkRevisions = []; bytes = 256;
      };
      for (const [index, record] of batch.entries()) {
        const size = Buffer.byteLength(JSON.stringify(record)) + 32;
        if (bytes + size > MAX_STATE || chunk.length >= 4096) finish();
        chunk.push(record); chunkRevisions.push(tickets[index]); bytes += size;
      }
      finish();
      try { reserve(writes); }
      catch (error) {
        writeState('health', { lineageLossObserved: true, reason: 'pending_capacity' });
        throw error;
      }
      for (const [file, data] of writes) writeFile(file, data);
    });
    if (!current) {
      retain(safe, revisions);
      return { queued: 0, pending: safe.length };
    }
    let superseded = 0;
    for (let i = 0; i < safe.length; i++) {
      const result = enqueue(safe[i], { stateDir, revision: revisions[i] });
      if (result?.obsolete) { superseded++; continue; }
      if (result?.queued === false) {
        retain(safe.slice(i), revisions.slice(i));
        return { queued: i - superseded, pending: safe.length - i, ...(superseded ? { superseded } : {}) };
      }
    }
    return { queued: safe.length - superseded, pending: 0, ...(superseded ? { superseded } : {}) };
  }

  async function flush(opts = {}) {
    const budget = Math.max(0, Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 3000);
    const deadline = Date.now() + budget;
    // Transfer/fsync work gets a bounded share; leave time to export its prefix.
    // A synchronous enqueue/fsync already in flight cannot be preempted.
    const transferDeadline = deadline - Math.min(1000, budget / 2);
    if (['false', '0'].includes(String(env.BRAIN_TRACING_ENABLED || '').toLowerCase()) || ['false', '0'].includes(String(env.LANGFUSE_TRACING_ENABLED || '').toLowerCase())) return { queued: 0, accepted: 0, disabled: true };
    transaction(() => {
      // The process-identity adapter lock excludes every live transfer. Any
      // remaining claim is interrupted, not a live owner inferred from age.
      for (const name of fs.readdirSync(pendingDir).filter(name => /^[a-f0-9-]+\.json\.[a-f0-9-]+\.claim$/.test(name))) {
        if (Date.now() >= transferDeadline) break;
        const file = path.join(pendingDir, name);
        try {
          if (readFile(file)) fs.renameSync(file, path.join(pendingDir, `${crypto.randomUUID()}.json`));
        } catch { /* Leave unreadable/unrecoverable claims fail-closed. */ }
      }
      for (const name of fs.readdirSync(pendingDir).filter(name => /^[a-f0-9-]+\.json$/.test(name)).slice(0, 256)) {
        if (Date.now() >= transferDeadline) break;
        const file = path.join(pendingDir, name);
        const batch = readFile(file);
        // Pre-ticket checkpoints have no provable same-timestamp order. Never
        // invent it at replay or expire these records as if transfer succeeded.
        // Keep the bounded payload intact and surface the recovery limitation.
        if (batch && (!Array.isArray(batch.revisions) || batch.revisions.length !== batch.records.length)) {
          writeState('health', { replayBlocked: true, reason: 'pending_revision_missing' });
          continue;
        }
        if (batch && clock() - batch.createdAt > ADAPTER_LIMITS.retentionMs) {
          writeState('health', { lineageLossObserved: true, reason: 'pending_expired' });
          fs.unlinkSync(file);
          continue;
        }
        const entry = batch && readState(`run:${batch.runId}`);
        const run = entry && resolve(entry.run);
        if (!run) continue;
        const claim = `${file}.${crypto.randomUUID()}.claim`;
        fs.renameSync(file, claim);
        try {
          while (batch.records.length && Date.now() < transferDeadline) {
            const record = batch.records[0];
            // Unticketed legacy suffixes cannot establish same-timestamp
            // capture order. Keep them visible/pending rather than guess.
            if (!batch.revisions || batch.revisions.length !== batch.records.length) throw new Error('Missing capture revisions');
            const result = enqueue(rebaseObservation(record, run), { stateDir, revision: batch.revisions[0] });
            if (result?.queued === false && !result.obsolete) throw new Error('Observation queue unavailable');
            // A crash between enqueue and this durable suffix may replay one ID,
            // never permanently restart an oversized batch at its first record.
            batch.records = batch.records.slice(1);
            batch.revisions = batch.revisions.slice(1);
            writeFile(claim, batch);
          }
          if (batch.records.length) fs.renameSync(claim, file);
          else fs.unlinkSync(claim);
        } catch {
          // Preserve only sanitized records after any queue/delivery failure.
          try { fs.renameSync(claim, file); } catch { /* The private claim remains recoverable. */ }
          break;
        }
      }
      collect(transferDeadline);
    });
    let result = { queued: 0, accepted: 0, failed: 0, attempted: 0, verified: false, status: 'timeout' };
    if (Date.now() < deadline - 10) {
      result = await deliver({ stateDir, env, ...opts, timeoutMs: deadline - Date.now() });
      for (let pass = 0; pass < 7 && result.accepted > 0 && result.queued > 0 && Date.now() < deadline - 10; pass++) {
        const next = await deliver({ stateDir, env, ...opts, timeoutMs: deadline - Date.now() });
        result = { ...next, accepted: (result.accepted || 0) + (next.accepted || 0),
          failed: (result.failed || 0) + (next.failed || 0), attempted: (result.attempted || 0) + (next.attempted || 0) };
        if (!next.accepted) break;
      }
    } else {
      try { result.queued = fs.readdirSync(path.join(stateDir, 'outbox')).length; } catch {}
    }
    result.deferred = fs.readdirSync(pendingDir).length;
    writeState('delivery', { status: result.status, queued: result.queued, accepted: result.accepted, failed: result.failed,
      deferred: result.deferred, verified: false, sharedOutbox: true });
    return result;
  }

  function knownPersona(cwd, persona) {
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(persona || '') || SENSITIVE.test(persona)) return false;
    const roots = [cwd];
    const runtime = require('./bootstrap.js').findRuntimeSync(cwd);
    if (runtime) roots.push(path.dirname(path.dirname(path.dirname(runtime))));
    return [...new Set(roots)].some(root => ['.pi/agents', '.claude/agents', '.agents/agents',
      ...(runtime === path.join(root, 'runtime/langfuse/pi.js') ? ['agents'] : [])].some(dir => {
      try { return fs.statSync(path.join(root, dir, `${persona}.md`)).isFile(); } catch { return false; }
    }));
  }

  function knownSkill(cwd, skill) {
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(skill || '') || SENSITIVE.test(skill)) return false;
    const entry = require('./bootstrap.js').findRuntimeSync(cwd);
    const roots = [cwd, ...(entry ? [path.dirname(path.dirname(path.dirname(entry)))] : [])];
    return roots.some(root => {
      return ['.agents/skills', ...(entry === path.join(root, 'runtime/langfuse/pi.js') ? ['skills'] : [])].some(dir => {
        try { return fs.statSync(path.join(root, dir, skill, 'SKILL.md')).isFile(); } catch { return false; }
      });
    });
  }

  function captureBrainCommand(run, event = {}) {
    const text = typeof event.text === 'string' ? event.text : '';
    const match = /^\s*\/brain(?:\s+([^\r\n]*))?\s*$/i.exec(text);
    const args = event.commandName === 'brain' ? event.commandArgs || '' : match?.[1];
    if (args === undefined) return run;
    const persona = /^\s*["']?([a-z][a-z0-9-]{0,79})(?:["']?)(?:\s|$)/.exec(args)?.[1];
    const cwd = event.cwd || options.cwd || process.cwd();
    const ticket = /(?:^|\s)--ticket(?:=|\s+)([A-Z][A-Z0-9]{1,15}-[1-9]\d*)\b/i.exec(args)?.[1]
      || new RegExp(`^\\s*["']?${persona || '(?!)'}["']?\\s+([A-Z][A-Z0-9]{1,15}-[1-9]\\d*)\\b`, 'i').exec(args)?.[1];
    return update(run, { ...(knownPersona(cwd, persona) ? { persona } : {}), ...(ticket ? { ticketId: ticket.toUpperCase(), ticketSource: 'explicit' } : {}), evidenceSource: 'command' });
  }

  function captureSkill(run, event = {}) {
    if (!event.success) return run;
    const args = event.input || {};
    let skill;
    let invoked = event.invoked || /^(skill|Skill)$/.test(event.toolName || '');
    if (invoked) skill = typeof args.skill === 'string' ? args.skill : event.skill;
    else if (/^(read|Read)$/.test(event.toolName || '')) {
      const file = args.path || args.file_path;
      if (typeof file === 'string') {
        skill = /(?:^|[\\/])(?:\.agents|\.claude|\.pi)[\\/]skills[\\/]([a-z0-9-]+)[\\/]SKILL\.md$/.exec(file)?.[1];
        if (!skill) {
          const cwd = event.cwd || options.cwd || process.cwd();
          const entry = require('./bootstrap.js').findRuntimeSync(cwd);
          const sourceRoot = entry && path.dirname(path.dirname(path.dirname(entry)));
          const candidate = /(?:^|[\\/])skills[\\/]([a-z0-9-]+)[\\/]SKILL\.md$/.exec(file)?.[1];
          if (entry === path.join(sourceRoot || '', 'runtime/langfuse/pi.js') && candidate &&
            path.resolve(cwd, file) === path.join(sourceRoot, 'skills', candidate, 'SKILL.md')) skill = candidate;
        }
      }
    }
    if (!/^[a-z][a-z0-9-]{0,79}(?::[a-z][a-z0-9-]{0,79})?$/.test(skill || '') || skill.length > 128 || SENSITIVE.test(skill)) return run;
    const field = invoked ? 'skillsInvoked' : 'skillsLoaded';
    return update(run, { [field]: [...new Set([...(run[field] || []), skill])].slice(0, 128) });
  }

  return { store, stateDir, harness, inboundIdentity, begin, acknowledgeSession, createToolLaunch, actorCapability, actorForTool, remember, resolve, session, update, submit, flush, id,
    readState, writeState, stateFile: fileFor, knownPersona, knownSkill, captureBrainCommand, captureSkill, now: clock };
}

module.exports = { createFlow, safeState, ADAPTER_LIMITS };
