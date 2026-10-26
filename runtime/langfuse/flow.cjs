'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ContextStore } = require('./context.cjs');
const { sanitizeObservation, sanitizeMetadataObservation, projectContent, CONTEXT_FIELDS } = require('./privacy.cjs');
const { findCapturePolicySync, METADATA_CAPTURE_POLICY: METADATA_POLICY,
  FULL_CAPTURE_POLICY: FULL_POLICY } = require('./bootstrap.js');
const { queueObservation, reserveRevisions, flushOutbox, recoverOutbox } = require('./export.cjs');
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

// Generic state is only IDs, timestamps, vetted metadata and numeric accounting.
// Keep this guard strict; only managedState's whole-file versioned schemas may
// carry projected observation bodies. Nested lookalikes are never exceptions.
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

const policyEquals = (value, expected) => value && typeof value === 'object'
  && Object.keys(value).length === Object.keys(expected).length
  && Object.entries(expected).every(([key, fact]) => Object.getOwnPropertyDescriptor(value, key)?.value === fact);
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};

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
  const killed = () => [env.BRAIN_TRACING_ENABLED, env.LANGFUSE_TRACING_ENABLED]
    .some(value => ['false', '0'].includes(String(value || '').toLowerCase()));
  // Native adapters must still enforce native trust before calling the flow.
  // An injected policy is a complete versioned test seam, never a mode string.
  const getCapturePolicy = () => {
    const policy = options.capturePolicy === undefined
      ? findCapturePolicySync(options.cwd || process.cwd()) : options.capturePolicy;
    return killed() ? null : policyEquals(policy, FULL_POLICY) ? FULL_POLICY
      : policy === null ? null : METADATA_POLICY;
  };
  const captureMode = () => getCapturePolicy()?.captureMode || 'disabled';
  const issuedCaptures = new WeakSet();
  const ownerFor = run => ({ rootSpanId: run.rootSpanId, runId: run.runId,
    nativeSessionId: run.nativeSessionId, harness: run.harness });
  function validateOwner(owner, record) {
    const safe = safeState(owner);
    if (!safe || Object.keys(safe).sort().join(',') !== 'harness,nativeSessionId,rootSpanId,runId'
      || !/^[a-f0-9]{16}$/.test(safe.rootSpanId) || !['pi', 'claude'].includes(safe.harness)
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(safe.runId)
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(safe.nativeSessionId)
      || (record && (record.nativeSessionId !== safe.nativeSessionId
        || record.context?.runId !== safe.runId || record.context?.harness !== safe.harness))) {
      throw new Error('Invalid observation owner');
    }
    return safe;
  }
  function projected(record, grant) {
    if (!policyEquals(grant, FULL_POLICY) && !policyEquals(grant, METADATA_POLICY)) throw new Error('Invalid capture grant');
    if (grant.captureMode === 'metadata-only' && Object.hasOwn(record, 'content')) throw new Error('Unversioned content rejected');
    return grant.captureMode === 'full-content' ? sanitizeObservation(record) : sanitizeMetadataObservation(record);
  }
  function validateCapture(value) {
    if (!value || Object.keys(value).sort().join(',') !== 'captureGrant,observationVersion,owner,record,revision'
      || value.observationVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error('Invalid observation checkpoint');
    const record = projected(value.record, value.captureGrant);
    if (JSON.stringify(record) !== JSON.stringify(value.record)) throw new Error('Noncanonical observation checkpoint');
    return { observationVersion: 1, captureGrant: value.captureGrant.captureMode === 'full-content' ? FULL_POLICY : METADATA_POLICY,
      owner: validateOwner(value.owner, record), record, revision: value.revision };
  }
  // Only these two WHOLE-file schemas bypass safeState for observation bodies.
  // Headers and every other checkpoint remain under the original strict guard.
  function managedState(data) {
    if (data?.checkpointVersion === 2) {
      const { state, ...header } = data;
      if (Object.keys(header).sort().join(',') !== 'checkpointVersion,ownerRoot,ownerSession,updatedAt') throw new Error('Invalid observation checkpoint');
      safeState(header);
      if (!Number.isSafeInteger(header.updatedAt) || header.updatedAt <= 0) throw new Error('Invalid checkpoint time');
      const capture = validateCapture(state);
      if (header.ownerRoot !== capture.owner.rootSpanId
        || header.ownerSession !== `${capture.owner.harness}:${hash(capture.owner.nativeSessionId)}`) throw new Error('Invalid observation owner');
      return { ...header, state: capture };
    }
    if (data?.pendingVersion === 2) {
      const { records, revisions, captureGrants, ...header } = data;
      safeState(header);
      if (Object.keys(header).sort().join(',') !== 'createdAt,owner,pendingVersion,runId'
        || !Number.isSafeInteger(header.createdAt) || header.createdAt <= 0
        || header.runId !== header.owner?.rootSpanId || !Array.isArray(records) || records.length > 4096
        || !Array.isArray(revisions) || !Array.isArray(captureGrants)
        || revisions.length !== records.length || captureGrants.length !== records.length) throw new Error('Invalid pending observations');
      validateOwner(header.owner);
      const captures = records.map((record, index) => validateCapture({ observationVersion: 1,
        owner: header.owner, record, revision: revisions[index], captureGrant: captureGrants[index] }));
      return { ...header, records: captures.map(item => item.record), revisions: captures.map(item => item.revision),
        captureGrants: captures.map(item => item.captureGrant) };
    }
    return safeState(data);
  }
  const serialize = data => {
    const bytes = JSON.stringify(managedState(data));
    if (Buffer.byteLength(bytes) > MAX_STATE) throw new Error('Tracing checkpoint budget exceeded');
    return bytes;
  };
  const readFile = file => {
    try {
      const before = fs.lstatSync(file); safeTemporary(before);
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const stat = fs.fstatSync(fd); safeTemporary(stat);
        if (!sameFile(before, stat) || before.size !== stat.size) return null;
        const bytes = Buffer.alloc(stat.size + 1), length = fs.readSync(fd, bytes, 0, bytes.length, 0);
        const after = fs.fstatSync(fd); safeTemporary(after);
        if (length !== stat.size || after.size !== stat.size || !sameFile(stat, after)) return null;
        return JSON.parse(bytes.subarray(0, length).toString('utf8'));
      } finally { fs.closeSync(fd); }
    } catch { return null; }
  };
  const checkpointSlot = path.join(adapterDir, '.checkpoint-v1.tmp');
  const uuidPart = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  const legacyAdapterTemp = new RegExp(`^[a-f0-9]{64}\\.json\\.${uuidPart}\\.tmp$`);
  const legacyPendingTemp = new RegExp(`^${uuidPart}\\.json(?:\\.${uuidPart}\\.claim)?\\.${uuidPart}\\.tmp$`);
  const unsafeCheckpoint = () => new Error('Unsafe tracing checkpoint publication; preserved for offline inspection');
  const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
  const safeTemporary = stat => {
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)
      || stat.nlink !== 1 || stat.size > MAX_STATE) throw unsafeCheckpoint();
  };
  const inspectTemporary = file => {
    const before = fs.lstatSync(file); safeTemporary(before);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd); safeTemporary(stat);
      if (!sameFile(before, stat) || before.size !== stat.size) throw unsafeCheckpoint();
      return stat;
    } finally { fs.closeSync(fd); }
  };
  const discardTemporary = (file, expected) => {
    const current = inspectTemporary(file);
    if (!sameFile(current, expected)) throw unsafeCheckpoint();
    const final = fs.lstatSync(file); safeTemporary(final);
    if (!sameFile(final, current) || final.size !== current.size) throw unsafeCheckpoint();
    fs.unlinkSync(file);
  };
  function recoverCheckpoints(deadlineAt) {
    // All checkpoint/pending/claim publications use the adapter lock. These
    // names identify uncommitted writes, never replayable records. No promotion.
    for (const dir of [adapterDir, pendingDir]) {
      const handle = fs.opendirSync(dir);
      try {
        for (let count = 0; ; count++) {
          if (Date.now() >= deadlineAt) throw new Error('Tracing checkpoint recovery pending');
          const entry = handle.readSync(); if (!entry) break;
          if (count >= ADAPTER_LIMITS.files + 2) throw new Error('Tracing checkpoint recovery pending');
          const file = path.join(dir, entry.name);
          if (file === checkpointSlot || (dir === adapterDir ? legacyAdapterTemp : legacyPendingTemp).test(entry.name)) {
            discardTemporary(file, inspectTemporary(file));
          } else if (entry.name.endsWith('.tmp')) throw unsafeCheckpoint();
        }
      } finally { handle.closeSync(); }
    }
  }
  const writeFile = (file, data) => {
    const content = serialize(data);
    try { inspectTemporary(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // One admitted 1 MiB slot, not an unbounded random temporary per crash.
    // reserve() accounts this slot in addition to the committed checkpoints.
    const temp = checkpointSlot;
    let published;
    try {
      const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try {
        published = fs.fstatSync(fd); safeTemporary(published);
        fs.writeFileSync(fd, content); fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      const current = inspectTemporary(temp);
      if (!sameFile(current, published) || current.size !== Buffer.byteLength(content)) throw unsafeCheckpoint();
      fs.renameSync(temp, file);
      for (const directory of new Set([adapterDir, path.dirname(file)])) {
        const dir = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      }
    } finally {
      if (published) {
        try { discardTemporary(temp, published); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  };
  let actor = null, adapterLockDepth = 0, recoveredPublications = 0;
  function transaction(fn) {
    if (adapterLockDepth) return fn();
    const deadlineAt = Date.now() + 5000;
    const lock = claimLock(adapterDir, 'context', { deadlineAt });
    try {
      while (lock.blocked()) {
        if (Date.now() >= deadlineAt) throw new Error('Tracing checkpoints are busy');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      recoverCheckpoints(deadlineAt);
      adapterLockDepth++;
      try { return fn(); } finally { adapterLockDepth--; }
    } finally { lock.release(); }
  }
  const unwrap = data => [1, 2].includes(data?.checkpointVersion) ? data.state : data;
  // Generic reads never become a content migration path.
  const readState = key => { const data = readFile(fileFor(key)); return data?.checkpointVersion === 2 ? null : unwrap(data); };
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
      const updatedAt = [1, 2].includes(envelope.checkpointVersion) ? envelope.updatedAt : fs.lstatSync(file).mtimeMs;
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
    // Recover under queue ownership BEFORE deciding whether references are
    // unknown. The adapter lock is held; the context transaction above has
    // finished. Exporters never acquire adapter/context locks while holding
    // queue ownership, so there is no queue -> adapter/context inversion.
    try {
      recoverOutbox({ stateDir, deadlineAt: Math.min(deadlineAt, Date.now() + 5000) }, outbox => {
        recoveredPublications += outbox.recovered;
        if (outbox.invalid) unknownReference = true;
        for (const record of outbox.records) addRecord(record);
        // Keep queue ownership until deletion is done: a new publisher cannot
        // introduce a reference between this snapshot and checkpoint reclamation.
        // This visitor performs no adapter/context lock acquisition.
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
          const updatedAt = [1, 2].includes(envelope.checkpointVersion) ? envelope.updatedAt : stat.mtimeMs;
          if (!Number.isFinite(updatedAt) || clock() - updatedAt <= ADAPTER_LIMITS.retentionMs) continue;
          if (unknownReference || roots.has(data?.run?.rootSpanId) || roots.has(data?.rootSpanId)
            || roots.has(envelope.ownerRoot) || sessions.has(envelope.ownerSession)) continue;
          if (!envelope.ownerSession && (roots.size || sessions.size)) continue;
          fs.unlinkSync(file);
        }
      });
    } catch { return; } // Unsafe/unknown state remains an explicit exporter refusal.
  }
  function reserve(writes) {
    const fits = () => {
      const sizes = new Map(checkpointFiles().map(file => [file, fs.lstatSync(file).size]));
      for (const [file, data] of writes) sizes.set(file, Buffer.byteLength(serialize(data)));
      // Leave room for persistent health/delivery diagnostics even at refusal.
      const diagnosticFiles = [fileFor('health'), fileFor('delivery')];
      const diagnostics = writes.every(([file]) => diagnosticFiles.includes(file));
      const ordinary = [...sizes].filter(([file]) => !diagnosticFiles.includes(file));
      return sizes.size + 1 <= ADAPTER_LIMITS.files
        && [...sizes.values()].reduce((sum, size) => sum + size, 0) + MAX_STATE <= ADAPTER_LIMITS.bytes
        && (diagnostics || (ordinary.length <= ADAPTER_LIMITS.files - 3
          && ordinary.reduce((sum, [, size]) => sum + size, 0) <= ADAPTER_LIMITS.bytes - MAX_STATE - 8192));
    };
    if (!fits()) { collect(); if (!fits()) throw new Error('Tracing checkpoint capacity exceeded'); }
  }
  const writeState = (key, data) => transaction(() => {
    data = safeState(data); // Never accept a typed-content bypass via the generic API.
    const file = fileFor(key);
    if (readFile(file)?.checkpointVersion === 2) throw new Error('Typed observation checkpoint requires typed API');
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

  // Adapter API (no raw state writes):
  // const content = flow.createContent({ input: nativeJSON }); // projects NOW
  // const open = flow.captureObservation(run, { ...idsAndTimes, content });
  // flow.writeObservation(key, open); // owner is explicit, never active actor
  // On completion capture a NEW revision with the same observation ID, retain
  // open.record.content.input and project the newly available output; then
  // writeObservation(key, completed) and closeObservation(key).
  // Restart: readObservation(key) -> closeObservation(key) retries the original
  // grant/ticket even after downgrade. It grants NO new raw capture. Kill stops
  // delivery. Generic readState/writeState cannot read/write these envelopes.
  function createContent(surfaces = {}) {
    if (captureMode() !== 'full-content') return undefined; // No body access in metadata mode.
    const result = { version: 1, captureMode: 'full-content', redactionPolicyVersion: 1 };
    for (const field of ['input', 'output']) {
      const descriptor = Object.getOwnPropertyDescriptor(surfaces, field);
      result[field] = !descriptor ? { status: 'unavailable' }
        : !Object.hasOwn(descriptor, 'value') ? { status: 'unsupported' } : projectContent(descriptor.value);
    }
    return freeze(result);
  }
  function atCapture(run, record, grant) {
    // Copy descriptors of ONLY known fields. In metadata mode even an accessor
    // named content/input/output is unread; no object spread of native bodies.
    const seed = {}, context = { ...run };
    const rawContext = Object.getOwnPropertyDescriptor(record, 'context')?.value;
    for (const key of [...CONTEXT_FIELDS, 'outcome', 'skillsLoaded', 'skillsInvoked', 'skillsLoadedStatus', 'skillsInvokedStatus']) {
      const descriptor = rawContext && Object.getOwnPropertyDescriptor(rawContext, key);
      if (descriptor) Object.defineProperty(context, key, { ...descriptor, configurable: true });
    }
    for (const key of ['id', 'parentId', 'type', 'startTime', 'endTime', 'model', 'provider', 'toolName', 'usage', 'cost', 'outcome',
      ...(grant.captureMode === 'full-content' ? ['content'] : [])]) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor) Object.defineProperty(seed, key, { ...descriptor, configurable: true });
    }
    // Root callers historically omit parentId: its exact run owns that edge,
    // including provisional roots which will be rebound only at publication.
    if (Object.getOwnPropertyDescriptor(seed, 'id')?.value === run.rootSpanId) {
      Object.defineProperty(seed, 'parentId', { value: run.parentSpanId || null, enumerable: true, configurable: true });
    }
    Object.assign(seed, { traceId: run.traceId, sessionId: run.sessionId, nativeSessionId: run.nativeSessionId, context });
    return grant.captureMode === 'full-content' ? sanitizeObservation(seed) : sanitizeMetadataObservation(seed);
  }
  function allocate(records) {
    try { return reserveRevisions(records, { stateDir }); }
    catch (error) {
      writeState('health', { replayBlocked: true, reason: error.message === 'Revision capacity exceeded'
        ? 'revision_capacity' : 'revision_unavailable' });
      throw error;
    }
  }
  function issue(capture) {
    const result = freeze(validateCapture(capture));
    issuedCaptures.add(result);
    return result;
  }
  function captureObservation(run, record) {
    const grant = getCapturePolicy();
    if (!grant) throw new Error('Tracing capture disabled');
    const saved = readState(`run:${run.rootSpanId}`)?.run;
    if (!saved || saved.runId !== run.runId || saved.nativeSessionId !== run.nativeSessionId || saved.harness !== run.harness) throw new Error('Unknown observation owner');
    const safe = atCapture(run, record, grant);
    return issue({ observationVersion: 1, captureGrant: grant, owner: ownerFor(run), record: safe, revision: allocate([safe])[0] });
  }
  function requireIssued(capture) {
    if (!issuedCaptures.has(capture)) throw new Error('Use captureObservation or readObservation for typed capture');
    return validateCapture(capture);
  }
  function writeObservation(key, capture) {
    return transaction(() => {
      const state = requireIssued(capture), file = fileFor(key), previous = readFile(file);
      if (previous) {
        if (previous.checkpointVersion !== 2) throw new Error('Observation checkpoint identity mismatch');
        const old = managedState(previous).state;
        if (JSON.stringify(old.owner) !== JSON.stringify(state.owner) || old.record.id !== state.record.id
          || old.record.type !== state.record.type) throw new Error('Observation checkpoint identity mismatch');
        if (state.revision < old.revision || state.record.endTime < old.record.endTime) throw new Error('Obsolete observation checkpoint');
        if (JSON.stringify(old.captureGrant) !== JSON.stringify(state.captureGrant)
          || (old.record.content && !state.record.content)) throw new Error('Observation capture policy cannot change');
      }
      const envelope = { checkpointVersion: 2, updatedAt: clock(), ownerRoot: state.owner.rootSpanId,
        ownerSession: `${state.owner.harness}:${hash(state.owner.nativeSessionId)}`, state };
      try { reserve([[file, envelope]]); writeFile(file, envelope); }
      catch (error) { writeState('health', { captureFailureObserved: true, reason: 'observation_retention_failed' }); throw error; }
      return capture;
    });
  }
  function readObservation(key) {
    const envelope = readFile(fileFor(key));
    if (!envelope) return null;
    if (envelope.checkpointVersion !== 2) throw new Error('Unversioned observation checkpoint');
    return issue(managedState(envelope).state);
  }
  function retained(run, records, revisions, captureGrants) {
    return transaction(() => {
      const writes = [], header = { pendingVersion: 2, runId: run.rootSpanId, owner: ownerFor(run), createdAt: clock() };
      let chunk = [], tickets = [], grants = [];
      const data = () => ({ ...header, records: chunk, revisions: tickets, captureGrants: grants });
      const emptyBytes = Buffer.byteLength(JSON.stringify(data()));
      let bytes = emptyBytes;
      const finish = () => {
        if (chunk.length) writes.push([path.join(pendingDir, `${crypto.randomUUID()}.json`), data()]);
        chunk = []; tickets = []; grants = []; bytes = emptyBytes;
      };
      try {
        // EXACT UTF-8 JSON lengths, including all three arrays' commas and
        // grant/ticket overhead, without quadratic whole-batch serialization.
        // reserve/writeFile independently measure the final canonical bytes.
        for (let i = 0; i < records.length; i++) {
          const itemBytes = [records[i], revisions[i], captureGrants[i]]
            .reduce((total, value) => total + Buffer.byteLength(JSON.stringify(value)), 0);
          if (emptyBytes + itemBytes > MAX_STATE) throw new Error('Tracing checkpoint budget exceeded');
          if (chunk.length >= 4096 || bytes + itemBytes + (chunk.length ? 3 : 0) > MAX_STATE) finish();
          bytes += itemBytes + (chunk.length ? 3 : 0);
          chunk.push(records[i]); tickets.push(revisions[i]); grants.push(captureGrants[i]);
        }
        finish(); reserve(writes);
        for (const [file, batch] of writes) writeFile(file, batch);
      } catch (error) {
        writeState('health', { lineageLossObserved: true, reason: error.message === 'Tracing checkpoint capacity exceeded'
          ? 'pending_capacity' : 'pending_retention_failed' });
        throw error;
      }
    });
  }
  function publish(run, records, revisions, grants) {
    if (killed()) return { queued: 0, pending: 0, disabled: true };
    const current = resolve(run);
    const safe = records.map(record => sanitizeObservation(rebaseObservation(record, current || run)));
    if (!current) { retained(run, safe, revisions, grants); return { queued: 0, pending: safe.length }; }
    let superseded = 0;
    for (let i = 0; i < safe.length; i++) {
      let result;
      try { result = enqueue(safe[i], { stateDir, revision: revisions[i] }); }
      catch { result = { queued: false }; }
      if (result?.obsolete) { superseded++; continue; }
      if (result?.queued === false) {
        retained(run, safe.slice(i), revisions.slice(i), grants.slice(i));
        return { queued: i - superseded, pending: safe.length - i, ...(superseded ? { superseded } : {}) };
      }
    }
    return { queued: safe.length - superseded, pending: 0, ...(superseded ? { superseded } : {}) };
  }
  const finished = record => !(record.type === 'AGENT' && [undefined, 'unknown', 'pending'].includes(record.outcome));
  function submit(run, records) {
    const grant = getCapturePolicy();
    if (!grant) return { queued: 0, pending: 0, disabled: true };
    const safe = records.map(record => atCapture(run, record, grant)).filter(finished);
    if (!safe.length) return { queued: 0, pending: 0 };
    return publish(run, safe, allocate(safe), safe.map(() => grant));
  }
  function submitCaptured(captures) {
    const checked = captures.map(requireIssued).filter(item => finished(item.record));
    if (!checked.length) return { queued: 0, pending: 0 };
    const owner = checked[0].owner;
    if (checked.some(item => JSON.stringify(item.owner) !== JSON.stringify(owner))) throw new Error('Mixed observation owners');
    const run = readState(`run:${owner.rootSpanId}`)?.run;
    if (!run || run.runId !== owner.runId || run.nativeSessionId !== owner.nativeSessionId || run.harness !== owner.harness) throw new Error('Unknown observation owner');
    return publish(run, checked.map(item => item.record), checked.map(item => item.revision), checked.map(item => item.captureGrant));
  }
  function closeObservation(key) {
    return transaction(() => {
      const capture = readObservation(key);
      if (!capture) return { queued: 0, pending: 0 };
      const result = submitCaptured([capture]);
      if ((result.queued || 0) + (result.pending || 0) + (result.superseded || 0) === 1) fs.unlinkSync(fileFor(key));
      return result; // Disabled/refused/unfinished captures remain durable.
    });
  }

  async function flush(opts = {}) {
    const budget = Math.max(0, Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 3000);
    const deadline = Date.now() + budget;
    // Transfer/fsync work gets a bounded share; leave time to export its prefix.
    // A synchronous enqueue/fsync already in flight cannot be preempted.
    const transferDeadline = deadline - Math.min(1000, budget / 2);
    if (killed()) return { queued: 0, accepted: 0, disabled: true };
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
        let batch = readFile(file);
        // Pre-ticket checkpoints cannot establish capture order. Preserve them
        // before interpreting policy or TTL; never invent replay tickets.
        if (batch && Array.isArray(batch.records)
          && (!Array.isArray(batch.revisions) || batch.revisions.length !== batch.records.length)) {
          writeState('health', { replayBlocked: true, reason: 'pending_revision_missing' });
          continue;
        }
        if (batch) {
          try {
            if (!Array.isArray(batch.records)) throw new Error('Invalid pending observations');
            if (batch.pendingVersion === 2) batch = managedState(batch);
            else {
              // Old private files never acquire content authority from today's
              // marker. Preserve ambiguous bodies without reading their values.
              if (batch.pendingVersion !== undefined || batch.records.some(record => Object.hasOwn(record, 'content'))) {
                writeState('health', { replayBlocked: true, reason: 'pending_capture_policy_missing' });
                continue;
              }
              safeState(batch);
            }
          } catch {
            writeState('health', { replayBlocked: true, reason: 'pending_capture_invalid' });
            continue;
          }
        }
        if (batch && clock() - batch.createdAt > ADAPTER_LIMITS.retentionMs) {
          writeState('health', { lineageLossObserved: true, reason: 'pending_expired' });
          fs.unlinkSync(file);
          continue;
        }
        const entry = batch && readState(`run:${batch.runId}`);
        const run = entry && resolve(entry.run);
        if (!run) continue;
        if (batch.pendingVersion === 2 && (run.rootSpanId !== batch.owner.rootSpanId || run.runId !== batch.owner.runId
          || run.nativeSessionId !== batch.owner.nativeSessionId || run.harness !== batch.owner.harness)) {
          writeState('health', { replayBlocked: true, reason: 'pending_owner_mismatch' });
          continue;
        }
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
            if (batch.pendingVersion === 2) batch.captureGrants = batch.captureGrants.slice(1);
            try { writeFile(claim, batch); }
            catch (error) {
              writeState('health', { replayBlocked: true, reason: 'pending_retention_failed' });
              throw error;
            }
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
    result.recovered = (result.recovered || 0) + recoveredPublications;
    recoveredPublications = 0;
    writeState('delivery', { status: result.status, queued: result.queued, accepted: result.accepted, failed: result.failed,
      deferred: result.deferred, recovered: result.recovered, verified: false, sharedOutbox: true });
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
    readState, writeState, stateFile: fileFor, getCapturePolicy, captureMode, createContent,
    captureObservation, writeObservation, readObservation, submitCaptured, closeObservation,
    knownPersona, knownSkill, captureBrainCommand, captureSkill, now: clock };
}

module.exports = { createFlow, safeState, ADAPTER_LIMITS };
