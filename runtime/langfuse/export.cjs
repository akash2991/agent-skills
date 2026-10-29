'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const http = require('node:http');
const { randomBytes, createHash } = require('node:crypto');
const { setMaxListeners } = require('node:events');
const { sanitizeObservation, sanitizeMetadataObservation, projectContent, safeIdentity, structuralIdentity, LIMITS, CONTENT_LIMITS } = require('./privacy.cjs');
const { loadDependencies } = require('./dependencies.cjs');
const { claimLock } = require('./locks.cjs');

const OUTBOX_LIMITS = Object.freeze({ records: 256, bytes: 4 * 1024 * 1024, flush: 32, scan: 512 });
const FILE_PATTERN = /^[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{32}\.json$/;
const LEGACY_FILE_BYTES = LIMITS.recordBytes + 512;
const MAX_FILE_BYTES = CONTENT_LIMITS.recordBytes + 512;
const MAX_REQUEST_BYTES = 1024 * 1024;
// Preserve the legacy size classifier: a larger file is admissible for private
// inspection only with the distinct new serializer prefix, never as old data.
function inspectOutbox(file) {
  const inspected = inspectPrivate(file, MAX_FILE_BYTES);
  if (inspected.bytes.length > LEGACY_FILE_BYTES && !inspected.bytes.subarray(0, 12).equals(Buffer.from('{"schema":3,'))) throw publicationError();
  return inspected;
}
function recoverOutboxSlot(file) {
  try { const inspected = inspectOutbox(file); discardPrivate(file, MAX_FILE_BYTES, inspected); return 1; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}
const OUTBOX_SLOT = '.outbox-v1.tmp';
// Lifetime floors deliberately have no TTL: pending/checkpoint references can
// outlive any wall-clock retention interval. Exhaustion is explicit refusal,
// never eviction that could authorize an obsolete replay.
const REVISION_LIMIT = 16384;
const REVISION_BYTES = 4 * 1024 * 1024;
const defaultStateDir = () => path.join(os.homedir(), '.local', 'state', 'agent-brain', 'langfuse');
const privateOwner = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !privateOwner(stat) || (stat.mode & 0o077)) throw new Error('Unsafe tracing state directory');
}
function outboxDirectory(stateDir) {
  privateDirectory(stateDir);
  const directory = path.join(stateDir, 'outbox');
  privateDirectory(directory);
  return directory;
}
function filesIn(directory) {
  const result = [];
  const handle = fs.opendirSync(directory);
  try {
    let entry;
    while ((entry = handle.readSync())) {
      if (result.length >= OUTBOX_LIMITS.scan) throw new Error('Tracing outbox capacity exceeded');
      result.push(entry.name);
    }
  } finally { handle.closeSync(); }
  return result.sort();
}
function publicationError(reason = 'outbox_inspection_required') {
  const error = new Error('Tracing publication preserved; stop controllers and inspect state offline');
  error.reason = reason;
  return error;
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
function safeFile(stat, maximum) {
  if (!stat.isFile() || !privateOwner(stat) || (stat.mode & 0o077) || stat.size > maximum || stat.nlink !== 1) throw publicationError();
}
function inspectPrivate(file, maximum) {
  const before = fs.lstatSync(file);
  safeFile(before, maximum);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    safeFile(stat, maximum);
    if (!sameFile(before, stat) || before.size !== stat.size) throw publicationError();
    const buffer = Buffer.alloc(stat.size + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const after = fs.fstatSync(fd);
    safeFile(after, maximum);
    if (size !== stat.size || after.size !== stat.size || !sameFile(stat, after)) throw publicationError();
    return { stat, bytes: buffer.subarray(0, size) };
  } finally { fs.closeSync(fd); }
}
function privateRead(file, maximum) { return inspectPrivate(file, maximum).bytes; }
function discardPrivate(file, maximum, expected) {
  const current = inspectPrivate(file, maximum);
  if (!sameFile(current.stat, expected.stat) || (expected.bytes && !current.bytes.equals(expected.bytes))) throw publicationError();
  const final = fs.lstatSync(file);
  safeFile(final, maximum);
  if (!sameFile(final, current.stat) || final.size !== current.stat.size) throw publicationError();
  fs.unlinkSync(file);
}
function recoverSlot(file, maximum) {
  try { discardPrivate(file, maximum, inspectPrivate(file, maximum)); return 1; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}
function publishPrivate(directory, slot, file, data, maximum) {
  const temporary = path.join(directory, slot), bytes = Buffer.from(data);
  let stat;
  try {
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      stat = fs.fstatSync(fd); safeFile(stat, maximum);
      fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const current = inspectPrivate(temporary, maximum);
    if (!sameFile(current.stat, stat) || !current.bytes.equals(bytes)) throw publicationError();
    fs.renameSync(temporary, file);
    syncDirectory(directory);
  } finally {
    if (stat) {
      try { discardPrivate(temporary, maximum, { stat }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
function supportedTruncation(name, bytes, revisions) {
  // Parse failure alone is NOT deletion authority. These bounded private spool
  // bytes must be an exact prefix of the current projected metadata serializer,
  // with matching filename identities and a provable capture ticket. Never
  // persist/promote the hypothetical completion or inspect parser error text.
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) return false;
  const head = /^\{"schema":2,"version":"([a-f0-9]{32})","revision":([1-9][0-9]*),"record":\{"id":"([a-f0-9]{16})","traceId":"([a-f0-9]{32})","parentId":(?:null|"[a-f0-9]{16}"),"sessionId":"[A-Za-z0-9_-]{1,128}","nativeSessionId":"([A-Za-z0-9_-]{1,128})",/.exec(text);
  if (!head || !Number.isSafeInteger(Number(head[2])) || name !== `${head[4]}-${head[3]}-${head[1]}.json`) return false;
  const closes = [];
  let quoted = false, escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') {
      if (closes.length === 32) return false;
      closes.push(char === '{' ? '}' : ']');
    } else if (char === '}' || char === ']') {
      if (closes.pop() !== char) return false;
    }
  }
  if (escaped || !closes.length) return false;
  try {
    const envelope = JSON.parse(text + (quoted ? '"' : '') + closes.reverse().join(''));
    const projected = sanitizeMetadataObservation(envelope.record);
    if (projected.id !== head[3] || projected.traceId !== head[4] || projected.nativeSessionId !== head[5]) return false;
    const canonical = JSON.stringify({ schema: 2, version: envelope.version, revision: envelope.revision, record: projected });
    if (!canonical.startsWith(text)) return false;
    // Hash only projected identities, not legacy bodies or parser diagnostics.
    const authority = revisions.entries[revisionKey(projected)];
    return !!authority && Number(head[2]) <= authority.allocated;
  } catch { return false; }
}
// Called only with exclusive queue ownership. Fixed slots are uncommitted,
// regardless of their contents. Historical final names require additional
// supported-publication evidence; syntax failure or a matching name alone is
// not deletion authority. Complete unsupported/noncanonical data is preserved.
function recoverQueue(stateDir, directory, deadlineAt) {
  let recovered = recoverSlot(path.join(stateDir, '.revisions-v1.tmp'), REVISION_BYTES)
    + recoverOutboxSlot(path.join(directory, OUTBOX_SLOT));
  const files = [], handle = fs.opendirSync(directory);
  let recoveryRevisions;
  try {
    for (let count = 0; ; count++) {
      if (Date.now() >= deadlineAt) throw publicationError('recovery_pending');
      const entry = handle.readSync();
      if (!entry) break;
      if (count >= OUTBOX_LIMITS.scan) throw publicationError('recovery_pending');
      if (!FILE_PATTERN.test(entry.name)) throw publicationError();
      const file = path.join(directory, entry.name), inspected = inspectOutbox(file);
      try { JSON.parse(inspected.bytes.toString('utf8')); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        try { recoveryRevisions ||= readRevisions(stateDir, true); }
        catch { throw publicationError('legacy_outbox_inspection_required'); }
        if (!supportedTruncation(entry.name, inspected.bytes, recoveryRevisions)) throw publicationError('legacy_outbox_inspection_required');
        discardPrivate(file, MAX_FILE_BYTES, inspected); recovered++; continue;
      }
      files.push({ name: entry.name, file, ...inspected });
    }
  } finally { handle.closeSync(); }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { files, recovered };
}
// Adapter GC uses a queue-locked snapshot, never interpreting a paused writer's
// slot as an unknown reference. The optional synchronous visitor keeps queue
// ownership through GC's reference closure/deletions; it must not acquire any
// adapter/context locks. Lock order: adapter -> queue, never the reverse.
// No credentials/SDK are needed to recover.
function recoverOutbox({ stateDir = defaultStateDir(), deadlineAt = Date.now() + 5000 } = {}, visit = inventory => inventory) {
  const directory = outboxDirectory(stateDir), lock = claimLock(stateDir, 'queue', { deadlineAt });
  try {
    while (lock.blocked()) {
      if (Date.now() >= deadlineAt) throw publicationError('recovery_pending');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    const inventory = recoverQueue(stateDir, directory, deadlineAt);
    const state = readRevisions(stateDir), records = [];
    let invalid = 0;
    for (const item of inventory.files) {
      try { records.push(canonicalEntry(item, state).record); } catch { invalid++; }
    }
    return visit({ recovered: inventory.recovered, invalid, records });
  } finally { lock.release(); }
}

function revisionKey(record) {
  // Only projected metadata is hashed, never caller payloads or native files.
  return createHash('sha256').update(`${record.nativeSessionId}:${record.id}`).digest('hex');
}
function readRevisions(stateDir, requireExisting = false) {
  try {
    const state = JSON.parse(privateRead(path.join(stateDir, 'revisions-v1.json'), REVISION_BYTES));
    if (state.schema !== 1 || !state.entries || typeof state.entries !== 'object' || Array.isArray(state.entries)
      || Object.keys(state).sort().join(',') !== 'entries,schema'
      || Object.keys(state.entries).length > REVISION_LIMIT) throw new Error('Invalid revision state');
    for (const [key, value] of Object.entries(state.entries)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(field => !['allocated', 'floor'].includes(field))
        || !Number.isSafeInteger(value.allocated) || value.allocated < 1
        || (value.floor !== undefined && (!value.floor || Object.keys(value.floor).sort().join(',') !== 'endTime,revision'
          || !Number.isSafeInteger(value.floor.revision) || value.floor.revision < 1
          || value.floor.revision > value.allocated || !Number.isSafeInteger(value.floor.endTime) || value.floor.endTime <= 0))) throw new Error('Invalid revision state');
    }
    return state;
  } catch (error) { if (error.code === 'ENOENT' && !requireExisting) return { schema: 1, entries: {} }; throw error; }
}
function writeRevisions(stateDir, state) {
  const data = JSON.stringify(state);
  if (Buffer.byteLength(data) > REVISION_BYTES) throw new Error('Revision capacity exceeded');
  // The queue lock excludes every live publisher; a fixed orphan slot keeps
  // repeated crashes bounded without age-based stealing or temp accumulation.
  recoverSlot(path.join(stateDir, '.revisions-v1.tmp'), REVISION_BYTES);
  publishPrivate(stateDir, '.revisions-v1.tmp', path.join(stateDir, 'revisions-v1.json'), data, REVISION_BYTES);
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function allocateRevisions(state, records) {
  return records.map(record => {
    const key = revisionKey(record);
    let entry = state.entries[key];
    if (!entry) {
      if (Object.keys(state.entries).length >= REVISION_LIMIT) throw new Error('Revision capacity exceeded');
      entry = state.entries[key] = { allocated: 0 };
    }
    if (entry.allocated >= Number.MAX_SAFE_INTEGER) throw new Error('Revision capacity exceeded');
    return ++entry.allocated;
  });
}
// Allocate at capture, BEFORE capacity refusal or unresolved lineage. The
// durable ticket travels with the crash-recoverable suffix, including rebases.
function reserveRevisions(records, { stateDir = defaultStateDir() } = {}) {
  const safe = records.map(record => sanitizeObservation(record));
  privateDirectory(stateDir);
  const deadlineAt = Date.now() + 5000;
  const lock = claimLock(stateDir, 'queue', { deadlineAt });
  try {
    while (lock.blocked()) {
      if (Date.now() >= deadlineAt) throw new Error('Revision state is busy');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    const inventory = recoverQueue(stateDir, outboxDirectory(stateDir), deadlineAt);
    const state = readRevisions(stateDir, inventory.files.length > 0);
    const revisions = allocateRevisions(state, safe);
    writeRevisions(stateDir, state);
    return revisions;
  } finally { lock.release(); }
}
function olderThanFloor(record, revision, floor) {
  return floor && (record.endTime < floor.endTime || (record.endTime === floor.endTime && revision < floor.revision));
}

function queueObservation(record, { stateDir = defaultStateDir(), revision } = {}) {
  let safe;
  try { safe = sanitizeObservation(record); }
  catch { return { queued: false, reason: 'invalid_record' }; }
  let lock;
  try {
    const directory = outboxDirectory(stateDir);
    const deadlineAt = Date.now() + 500;
    lock = claimLock(stateDir, 'queue', { deadlineAt });
    if (lock.blocked()) return { queued: false, reason: 'busy' };
    const inventory = recoverQueue(stateDir, directory, deadlineAt);
    const state = readRevisions(stateDir, inventory.files.length > 0);
    if (revision === undefined) {
      [revision] = allocateRevisions(state, [safe]);
      writeRevisions(stateDir, state);
    }
    const floor = state.entries[revisionKey(safe)];
    if (!Number.isSafeInteger(revision) || revision < 1 || !floor || revision > floor.allocated) return { queued: false, reason: 'invalid_revision' };
    if (olderThanFloor(safe, revision, floor.floor)) return { queued: false, obsolete: true, reason: 'superseded', revision };
    const files = inventory.files;
    const bytes = files.reduce((sum, item) => sum + item.stat.size, 0);
    const version = randomBytes(16).toString('hex');
    const payload = JSON.stringify({ schema: safe.content ? 3 : 2, version, revision, record: safe });
    // Reserve SDK-added attributes explicitly; no admitted singleton depends on
    // a permanently oversized request ever succeeding. Actual packing below is
    // measured again AFTER SDK masking/escaping.
    if (Buffer.byteLength(wireBody([wireRecord(safe)])) > MAX_REQUEST_BYTES - 16384) return { queued: false, reason: 'wire_refused_size' };
    if (files.length >= OUTBOX_LIMITS.records || bytes + Buffer.byteLength(payload) > OUTBOX_LIMITS.bytes) return { queued: false, reason: 'capacity' };
    const file = path.join(directory, `${safe.traceId}-${safe.id}-${version}.json`);
    // The slot itself consumes the admitted record/byte budget. Rename never
    // exposes an empty/partial final record, and recovery never promotes a slot.
    try { fs.lstatSync(file); throw publicationError(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    publishPrivate(directory, OUTBOX_SLOT, file, payload, MAX_FILE_BYTES);
    return { queued: true, id: safe.id, traceId: safe.traceId, version, revision, privacy: safe.content ? 'full-content' : 'metadata-only' };
  } catch (error) {
    return { queued: false, reason: error.reason || (error.message === 'Revision capacity exceeded' ? 'revision_capacity' : 'state_unavailable') };
  } finally { lock?.release(); }
}

function validateCredentials(value, synthetic = false) {
  if (!value || typeof value !== 'object') return null;
  const { publicKey, secretKey, baseUrl } = value;
  if (![publicKey, secretKey].every(key => typeof key === 'string' && key.length >= 4 && key.length <= 512 && /^[\x21-\x7e]+$/.test(key) && !key.includes(':'))) return null;
  if (typeof baseUrl !== 'string' || baseUrl.length > 2048) return null;
  try {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) return null;
    const syntheticLoopback = synthetic && value.syntheticLoopback === true && ['127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && syntheticLoopback)) return null;
    return { publicKey, secretKey, baseUrl: url.origin, ...(syntheticLoopback ? { syntheticLoopback: true } : {}) };
  } catch { return null; }
}

// Each source must supply the complete tuple. Never combine a host from one
// source with keys from another. No keychain, credential copying or CLI calls.
function loadCredentials({ env = process.env, home = os.homedir(), agentDir = path.join(home, '.pi', 'agent'), configPath } = {}) {
  try {
    const tuple = ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL'];
    if (tuple.some(key => env[key] !== undefined)) {
      return validateCredentials({ publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY, baseUrl: env.LANGFUSE_BASE_URL });
    }
    const candidates = configPath ? [configPath] : [path.join(home, '.config', 'agent-brain', 'langfuse.json'), path.join(agentDir, 'langfuse.json')];
    for (const file of candidates) {
      let bytes;
      try { bytes = privateRead(file, 8192); }
      catch (error) { if (error.code === 'ENOENT') continue; return null; }
      try { return validateCredentials(JSON.parse(bytes.toString('utf8'))); }
      catch { return null; }
    }
  } catch {}
  return null;
}

function canonicalEntry({ name, bytes }, state) {
  const envelope = JSON.parse(bytes.toString('utf8'));
  if (!envelope || ![2, 3].includes(envelope.schema)) throw new Error();
  // Schema 2 always uses the frozen metadata projection. Schema 3 MUST carry
  // the explicit content policy; changing a schema number cannot promote bytes.
  const record = envelope.schema === 2 ? sanitizeMetadataObservation(envelope.record) : sanitizeObservation(envelope.record);
  const revision = envelope.revision;
  const canonical = { schema: envelope.schema, version: envelope.version, revision, record };
  // Parseable legacy/noncanonical/unticketed data is ambiguous, not a crash
  // artifact. Preserve it, without replay-time tickets or guessed chronology.
  if ((envelope.schema === 3 && !record.content) || !/^[a-f0-9]{32}$/.test(envelope.version)
    || !Number.isSafeInteger(revision) || revision < 1
    || revision > (state.entries[revisionKey(record)]?.allocated || 0)
    || name !== `${record.traceId}-${record.id}-${envelope.version}.json`
    || JSON.stringify(canonical) !== bytes.toString('utf8')) throw new Error();
  return { record, revision };
}
function readEntries(inventory, state) {
  const latest = new Map();
  let invalid = 0;
  for (const item of inventory.files) {
    try {
      const { file, bytes, stat } = item;
      const { record, revision } = canonicalEntry(item, state);
      if (olderThanFloor(record, revision, state.entries[revisionKey(record)]?.floor)) {
        discardPrivate(file, MAX_FILE_BYTES, item); continue;
      }
      const entry = { file, bytes, stat, record, revision, superseded: [] };
      const key = revisionKey(record);
      const previous = latest.get(key);
      if (!previous) latest.set(key, entry);
      else if (record.endTime > previous.record.endTime || (record.endTime === previous.record.endTime && entry.revision > previous.revision)) {
        entry.superseded = [...previous.superseded, previous]; latest.set(key, entry);
      } else previous.superseded.push(entry);
    } catch { invalid++; }
  }
  return { entries: [...latest.values()].slice(0, OUTBOX_LIMITS.flush), invalid };
}

function sdkMask({ data }, approvedContent) {
  // The pinned SDK supplies no attribute key to mask(). Accept only exact
  // serialized I/O values from already validated records in THIS flush. Never
  // loosen the metadata mask into a generic JSON/string pass-through.
  if (typeof data === 'string' && approvedContent.has(data)) {
    try {
      const projected = projectContent(JSON.parse(data));
      if (Object.hasOwn(projected, 'value') && JSON.stringify(projected.value) === data) return data;
    } catch {}
    return null;
  }
  if (typeof data === 'string') return structuralIdentity('projectId', data) || structuralIdentity('worktreeId', data) || safeIdentity(data) || null;
  if (typeof data === 'number') return Number.isFinite(data) && data >= 0 && data <= 1e12 ? data : null;
  if (Array.isArray(data) && data.length <= LIMITS.skills && data.every(value => safeIdentity(value))) return data;
  return null;
}
function attributesFor(record) {
  const attrs = {
    'langfuse.observation.type': record.type.toLowerCase(),
    'session.id': record.sessionId,
    'langfuse.observation.metadata.privacy': JSON.stringify(record.content ? 'full-content' : 'metadata-only'),
    'langfuse.observation.metadata.nativeSessionId': JSON.stringify(record.nativeSessionId)
  };
  if (record.type === 'AGENT' && record.parentId === null) attrs['langfuse.trace.name'] = record.name;
  const tags = [`privacy:${record.content ? 'full-content' : 'metadata-only'}`, `type:${record.type.toLowerCase()}`];
  if (record.content) {
    attrs['langfuse.observation.metadata.captureVersion'] = JSON.stringify(record.content.version);
    attrs['langfuse.observation.metadata.redactionPolicyVersion'] = JSON.stringify(record.content.redactionPolicyVersion);
    for (const surface of ['input', 'output']) {
      const item = record.content[surface];
      attrs[`langfuse.observation.metadata.${surface}Status`] = JSON.stringify(item.status);
      if (Object.hasOwn(item, 'value')) attrs[`langfuse.observation.${surface}`] = JSON.stringify(item.value);
    }
  }
  for (const [key, value] of Object.entries(record.context || {})) {
    if (key === 'outcome' && value === 'unknown') continue;
    attrs[`langfuse.observation.metadata.${key}`] = JSON.stringify(value);
    // Loaded skill lists are never labelled "used" or "invoked".
    if (['projectId', 'projectName', 'persona', 'ticketId', 'runtimeName', 'harness'].includes(key)) tags.push(`${key}:${value}`);
    if (key === 'skillsInvoked' || key === 'skillsLoaded') for (const skill of value) tags.push(`${key}:${skill}`);
  }
  attrs['langfuse.trace.tags'] = tags;
  if (record.model) attrs['langfuse.observation.model.name'] = record.model;
  if (record.provider) attrs['langfuse.observation.metadata.provider'] = JSON.stringify(record.provider);
  if (record.toolName) attrs['langfuse.observation.metadata.toolName'] = JSON.stringify(record.toolName);
  if (record.usage) attrs['langfuse.observation.usage_details'] = JSON.stringify(record.usage);
  if (record.cost) attrs['langfuse.observation.cost_details'] = JSON.stringify(record.cost);
  // Unknown is absence of completion evidence, not a finished-span attribute
  // to race against a later terminal update during asynchronous ingestion.
  if (record.outcome && record.outcome !== 'unknown') attrs['langfuse.observation.metadata.outcome'] = JSON.stringify(record.outcome);
  return attrs;
}

const otlpValue = value => Array.isArray(value) ? { arrayValue: { values: value.map(otlpValue) } }
  : typeof value === 'boolean' ? { boolValue: value } : typeof value === 'number' ? { doubleValue: value } : { stringValue: value };
const nanos = time => (BigInt(time[0]) * 1000000000n + BigInt(time[1])).toString();
function wireSpan(span) {
  return {
    traceId: span.spanContext().traceId, spanId: span.spanContext().spanId,
    ...(span.parentSpanContext ? { parentSpanId: span.parentSpanContext.spanId } : {}),
    name: span.name, kind: 1, startTimeUnixNano: nanos(span.startTime), endTimeUnixNano: nanos(span.endTime),
    attributes: Object.entries(span.attributes).map(([key, value]) => ({ key, value: otlpValue(value) })),
    status: { code: span.status.code === 2 ? 2 : 1 }
  };
}
function wireRecord(record) {
  return {
    traceId: record.traceId, spanId: record.id, ...(record.parentId ? { parentSpanId: record.parentId } : {}),
    name: record.name, kind: 1,
    startTimeUnixNano: (BigInt(record.startTime) * 1000000n).toString(), endTimeUnixNano: (BigInt(record.endTime) * 1000000n).toString(),
    attributes: Object.entries(attributesFor(record)).map(([key, value]) => ({ key, value: otlpValue(value) })), status: { code: 1 }
  };
}
function wireScope(spans) {
  return spans.some(span => span.attributes.some(({ key, value }) => key === 'langfuse.observation.metadata.privacy' && value.stringValue === '"full-content"'))
    ? 'agent-brain.observations' : 'agent-brain.metadata';
}
function wireBody(spans) {
  return JSON.stringify({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: wireScope(spans), version: '1' }, spans }] }] });
}

// Public SpanExporter contract, with a deliberately small OTLP/HTTP JSON
// transport. Unlike exporter environment defaults, only this explicit host and
// these headers are used. No redirects, cookies, env headers, media or retries.
function transportExporter({ credentials, timeoutMs, signal }) {
  const requests = new Set();
  return {
    export(spans, callback) {
      let finished = false;
      const done = code => { if (!finished) { finished = true; callback({ code }); } };
      try {
        const serialized = spans.map(wireSpan);
        const body = wireBody(serialized);
        if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) return done(1);
        const url = new URL('/api/public/otel/v1/traces', credentials.baseUrl);
        const client = url.protocol === 'https:' ? https : http;
        const req = client.request(url, {
          method: 'POST', signal, timeout: timeoutMs, headers: {
            'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
            authorization: `Basic ${Buffer.from(`${credentials.publicKey}:${credentials.secretKey}`).toString('base64')}`,
            'x-langfuse-ingestion-version': '4', 'x-langfuse-sdk-name': wireScope(serialized)
          }
        }, response => {
          // OTLP may report partial rejection in a 200 response. Do not
          // acknowledge any batch with explicitly rejected or malformed counts.
          let responseBytes = 0;
          const chunks = [];
          response.on('data', chunk => {
            responseBytes += chunk.length;
            if (responseBytes > 8192) { response.destroy(); done(1); }
            else chunks.push(chunk);
          });
          response.on('error', () => done(1));
          response.on('end', () => {
            try {
              const text = Buffer.concat(chunks).toString('utf8');
              const result = text ? JSON.parse(text) : {};
              const object = result && typeof result === 'object' && !Array.isArray(result);
              const partials = [result?.partialSuccess, result?.data?.partialSuccess].filter(value => value !== undefined);
              const rejected = partials.some(value => !value || typeof value !== 'object' ||
                ![undefined, 0, '0'].includes(value.rejectedSpans));
              const explicitError = result?.error || result?.success === false ||
                (result?.errors && (!Array.isArray(result.errors) || result.errors.length));
              // Langfuse may wrap its ingestion receipt in {data: ...}; an
              // empty JSON body is not the only valid HTTP acknowledgement.
              // This is transport acceptance only, never persistence proof.
              done(response.statusCode >= 200 && response.statusCode < 300 && object && !rejected && !explicitError ? 0 : 1);
            } catch { done(1); }
          });
        });
        requests.add(req);
        req.on('close', () => requests.delete(req));
        req.on('timeout', () => { req.destroy(); done(1); });
        req.on('error', () => done(1));
        req.end(body);
      } catch { done(1); }
    },
    async shutdown() { for (const req of requests) req.destroy(); requests.clear(); },
    async forceFlush() {}
  };
}

async function flushOutbox({ stateDir = defaultStateDir(), credentials, dependencyRoot, timeoutMs = 3000, exporterFactory, env = process.env } = {}) {
  const result = { queued: 0, accepted: 0, failed: 0, attempted: 0, invalid: 0, verified: false, status: 'offline' };
  let directory, entries, config;
  try { directory = outboxDirectory(stateDir); }
  catch { result.status = 'state_unavailable'; return result; }
  // Recover even when empty/offline: neither credentials nor an exporter is
  // permission to clean crash artifacts, and missing credentials must not
  // indefinitely pin adapter references or queue capacity.
  // Serialize senders, recovering only uniquely named dead-process claims.
  timeoutMs = Number.isFinite(timeoutMs) ? Math.max(10, Math.min(10000, Math.floor(timeoutMs))) : 3000;
  const deadlineAt = Date.now() + timeoutMs;
  let lock, acquired = false;
  try {
    lock = claimLock(stateDir, 'flush', { deadlineAt });
    while (Date.now() < deadlineAt) {
      if (!lock.blocked()) { acquired = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } catch { lock?.release(); result.status = 'state_unavailable'; return result; }
  if (!acquired) { lock.release(); result.status = 'busy'; return result; }
  const unlock = () => lock.release();
  let queueLock;
  try {
    queueLock = claimLock(stateDir, 'queue', { deadlineAt });
    while (queueLock.blocked()) {
      if (Date.now() >= deadlineAt) throw new Error('Queue busy');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const inventory = recoverQueue(stateDir, directory, deadlineAt);
    result.recovered = inventory.recovered;
    result.queued = inventory.files.length;
    const state = readRevisions(stateDir);
    const fresh = readEntries(inventory, state); entries = fresh.entries; result.invalid = fresh.invalid;
    if (entries.length) config = credentials === undefined && !exporterFactory ? loadCredentials({ env }) : validateCredentials(credentials, true);
    if (entries.length && (config || exporterFactory)) {
      for (const entry of entries) {
        const head = state.entries[revisionKey(entry.record)];
        head.floor = { endTime: entry.record.endTime, revision: entry.revision };
      }
      // Persist BEFORE export. Never create/reset a ledger for invalid legacy
      // data, nor promote an uncommitted ledger slot after a crash.
      writeRevisions(stateDir, state);
    }
  } catch (error) { queueLock?.release(); unlock(); result.status = error.reason || 'state_unavailable'; return result; }
  queueLock.release();
  if (!entries.length) { unlock(); result.queued = filesIn(directory).length; result.status = result.queued ? 'invalid_outbox' : 'empty'; return result; }
  if (!config && !exporterFactory) { unlock(); return result; }
  timeoutMs = deadlineAt - Date.now();
  if (timeoutMs < 10) { unlock(); result.status = 'timeout'; return result; }
  const controller = new AbortController();
  // Per-flush only: at most one request and cancellation callback per span.
  setMaxListeners(OUTBOX_LIMITS.flush * 2 + 2, controller.signal);
  const accepted = new Set();
  let active = true, provider, delegate, timer;
  result.attempted = entries.length;
  const work = async () => {
    const sdk = loadDependencies({ dependencyRoot });
    delegate = await (exporterFactory || transportExporter)({ credentials: config, timeoutMs, signal: controller.signal });
    if (!active) { try { await delegate.shutdown?.(); } catch {} return; }
    if (!delegate || typeof delegate.export !== 'function') throw new Error();
    const spanEntries = new WeakMap();
    const approvedContent = new Set();
    for (const { record } of entries) for (const surface of ['input', 'output']) {
      const item = record.content?.[surface];
      if (item && Object.hasOwn(item, 'value')) approvedContent.add(JSON.stringify(item.value));
    }
    const exporter = {
      export(spans, callback) {
        const batch = spans.map(span => spanEntries.get(span));
        if (!active || batch.some(entry => !entry)) { callback({ code: 1 }); return; }
        // Refuse SDK truncation/masking changes instead of ACKing a prefix or
        // null as captured content. This check is on the real ended SDK spans.
        for (let i = 0; i < spans.length; i++) {
          const expected = attributesFor(batch[i].record);
          for (const surface of ['input', 'output']) {
            const key = `langfuse.observation.${surface}`;
            if (spans[i].attributes[key] !== expected[key]) {
              result.reason = 'sdk_content_mismatch'; callback({ code: 1 }); return;
            }
          }
        }
        const groups = [];
        let group = [], wire = [];
        for (const span of spans) {
          const serialized = wireSpan(span);
          if (Buffer.byteLength(wireBody([serialized])) > MAX_REQUEST_BYTES) {
            result.reason = 'wire_refused_size'; callback({ code: 1 }); return;
          }
          if (group.length && Buffer.byteLength(wireBody([...wire, serialized])) > MAX_REQUEST_BYTES) {
            groups.push(group); group = []; wire = [];
          }
          group.push(span); wire.push(serialized);
        }
        if (group.length) groups.push(group);
        let pending = groups.length, failed = false;
        if (!pending) { callback({ code: 0 }); return; }
        for (const subset of groups) {
          let called = false;
          const done = response => {
            if (called) return;
            called = true;
            controller.signal.removeEventListener('abort', cancel);
            const success = active && response?.code === 0;
            if (success) for (const span of subset) accepted.add(spanEntries.get(span));
            else failed = true;
            if (!--pending) callback({ code: failed ? 1 : 0 });
          };
          const cancel = () => done({ code: 1 });
          controller.signal.addEventListener('abort', cancel, { once: true });
          try {
            const returned = delegate.export(subset, done);
            // Resolving a promise is NOT an ack; rejection is still a failure.
            if (returned && typeof returned.then === 'function') Promise.resolve(returned).catch(() => done({ code: 1 }));
          } catch { done({ code: 1 }); }
        }
      },
      async shutdown() { await delegate.shutdown?.(); },
      async forceFlush() { await delegate.forceFlush?.(); }
    };
    const processor = new sdk.LangfuseSpanProcessor({
      exporter, exportMode: 'batched', mediaUploadEnabled: false,
      publicKey: '', secretKey: '', baseUrl: 'https://invalid.invalid',
      environment: entries.some(entry => entry.record.content) ? 'bounded-content' : 'metadata-only',
      release: entries.some(entry => entry.record.content) ? 'content-v1' : 'metadata-only',
      flushAt: OUTBOX_LIMITS.flush, flushInterval: 1, timeout: timeoutMs / 1000,
      mask: value => sdkMask(value, approvedContent), shouldExportSpan: () => true
    });
    let current;
    provider = new sdk.NodeTracerProvider({
      resource: sdk.emptyResource(), sampler: new sdk.AlwaysOnSampler(), spanProcessors: [processor], forceFlushTimeoutMillis: timeoutMs,
      // Do not inherit ambient OTEL_SPAN_* truncation/count limits.
      spanLimits: { attributeValueLengthLimit: CONTENT_LIMITS.recordBytes, attributeCountLimit: 256, eventCountLimit: 0, linkCountLimit: 0 },
      idGenerator: { generateTraceId: () => current.traceId, generateSpanId: () => current.id }
    });
    for (const entry of entries) {
      if (!active) break;
      const record = entry.record;
      current = record;
      const parent = record.parentId ? sdk.trace.setSpanContext(sdk.ROOT_CONTEXT, {
        traceId: record.traceId, spanId: record.parentId, traceFlags: sdk.TraceFlags.SAMPLED, isRemote: true
      }) : sdk.ROOT_CONTEXT;
      const tracer = provider.getTracer(record.content ? 'agent-brain.observations' : 'agent-brain.metadata', '1');
      const span = tracer.startSpan(record.name, { startTime: record.startTime, attributes: attributesFor(record) }, parent);
      // A shared flush can replay both policies. Do not relabel legacy metadata
      // spans with the processor's content environment/release in mixed batches.
      if (!record.content) span.setAttributes({ 'langfuse.environment': 'metadata-only', 'langfuse.release': 'metadata-only' });
      spanEntries.set(span, entry);
      span.setStatus({ code: ['error', 'failed', 'timeout'].includes(record.outcome) ? 2 : 1 });
      span.end(record.endTime);
    }
    await provider.forceFlush();
    await provider.shutdown();
  };
  try {
    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
    const completed = work().then(() => 'complete', () => 'failure');
    result.status = await Promise.race([completed, deadline]);
  } catch { result.status = 'failure'; }
  finally {
    active = false;
    clearTimeout(timer);
    controller.abort();
    // Cleanup is best effort, never await an untrusted/hung exporter here.
    try { Promise.resolve(delegate?.shutdown?.()).catch(() => {}); } catch {}
  }
  for (const entry of accepted) {
    try {
      discardPrivate(entry.file, MAX_FILE_BYTES, entry);
      result.accepted++;
      for (const older of entry.superseded) {
        try { discardPrivate(older.file, MAX_FILE_BYTES, older); } catch {}
      }
    } catch {}
  }
  result.failed = result.attempted - result.accepted;
  try { result.queued = filesIn(directory).length; } catch {}
  if (result.status === 'complete') result.status = result.failed ? 'failed' : 'transport_accepted';
  unlock();
  return result;
}

module.exports = { queueObservation, reserveRevisions, flushOutbox, recoverOutbox, loadCredentials, OUTBOX_LIMITS, REVISION_LIMIT };
