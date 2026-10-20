'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { setMaxListeners } = require('node:events');
const { sanitizeObservation, safeIdentity, LIMITS } = require('./privacy.cjs');
const { loadDependencies } = require('./dependencies.cjs');

const OUTBOX_LIMITS = Object.freeze({ records: 256, bytes: 4 * 1024 * 1024, flush: 32, scan: 512 });
const FILE_PATTERN = /^[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{32}\.json$/;
const MAX_FILE_BYTES = LIMITS.recordBytes + 256;
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
function privateRead(file, maximum) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || !privateOwner(stat) || (stat.mode & 0o077) || stat.size > maximum || stat.nlink !== 1) throw new Error('Unsafe tracing file');
    const bytes = Buffer.alloc(maximum + 1);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (size > maximum) throw new Error('Tracing file exceeds budget');
    return bytes.subarray(0, size);
  } finally { fs.closeSync(fd); }
}

function queueObservation(record, { stateDir = defaultStateDir() } = {}) {
  let safe;
  try { safe = sanitizeObservation(record); }
  catch { return { queued: false, reason: 'invalid_record' }; }
  let file, lock, created = false;
  try {
    const directory = outboxDirectory(stateDir);
    // A crash leaves a fail-closed lock rather than an unbounded queue. The
    // owner may remove an abandoned empty queue.lock directory before retrying.
    const lockPath = path.join(stateDir, 'queue.lock');
    try { fs.mkdirSync(lockPath, { mode: 0o700 }); lock = lockPath; }
    catch { return { queued: false, reason: 'busy' }; }
    const files = filesIn(directory);
    let bytes = 0;
    for (const name of files) {
      const stat = fs.lstatSync(path.join(directory, name));
      if (!stat.isFile() || stat.isSymbolicLink()) return { queued: false, reason: 'unsafe_outbox' };
      bytes += stat.size;
    }
    const version = randomBytes(16).toString('hex');
    const payload = JSON.stringify({ schema: 1, version, record: safe });
    if (files.length >= OUTBOX_LIMITS.records || bytes + Buffer.byteLength(payload) > OUTBOX_LIMITS.bytes) return { queued: false, reason: 'capacity' };
    file = path.join(directory, `${safe.traceId}-${safe.id}-${version}.json`);
    const fd = fs.openSync(file, 'wx', 0o600);
    created = true;
    try { fs.writeFileSync(fd, payload); } finally { fs.closeSync(fd); }
    return { queued: true, id: safe.id, traceId: safe.traceId, version, privacy: 'metadata-only' };
  } catch {
    if (created) { try { fs.unlinkSync(file); } catch {} }
    return { queued: false, reason: 'state_unavailable' };
  } finally { if (lock) { try { fs.rmdirSync(lock); } catch {} } }
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

function readEntries(directory) {
  const entries = [];
  let invalid = 0;
  for (const name of filesIn(directory)) {
    if (!FILE_PATTERN.test(name)) { invalid++; continue; }
    try {
      const file = path.join(directory, name);
      const bytes = privateRead(file, MAX_FILE_BYTES);
      const envelope = JSON.parse(bytes.toString('utf8'));
      const record = sanitizeObservation(envelope.record);
      if (envelope.schema !== 1 || !/^[a-f0-9]{32}$/.test(envelope.version)
        || name !== `${record.traceId}-${record.id}-${envelope.version}.json`
        || JSON.stringify({ schema: 1, version: envelope.version, record }) !== bytes.toString('utf8')) throw new Error();
      entries.push({ file, bytes, record });
    } catch { invalid++; }
    if (entries.length >= OUTBOX_LIMITS.flush) break;
  }
  return { entries, invalid };
}

function sdkMask({ data }) {
  if (typeof data === 'string') return safeIdentity(data) || null;
  if (typeof data === 'number') return Number.isFinite(data) && data >= 0 && data <= 1e12 ? data : null;
  if (Array.isArray(data) && data.length <= LIMITS.skills && data.every(value => safeIdentity(value))) return data;
  return null;
}
function attributesFor(record) {
  const attrs = {
    'langfuse.observation.type': record.type,
    'session.id': record.sessionId,
    'langfuse.trace.name': record.name,
    'langfuse.observation.metadata.privacy': JSON.stringify('metadata-only'),
    'langfuse.observation.metadata.nativeSessionId': JSON.stringify(record.nativeSessionId)
  };
  const tags = ['privacy:metadata-only', `type:${record.type.toLowerCase()}`];
  for (const [key, value] of Object.entries(record.context || {})) {
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
  if (record.outcome) attrs['langfuse.observation.metadata.outcome'] = JSON.stringify(record.outcome);
  return attrs;
}

const otlpValue = value => Array.isArray(value) ? { arrayValue: { values: value.map(otlpValue) } }
  : typeof value === 'boolean' ? { boolValue: value } : typeof value === 'number' ? { doubleValue: value } : { stringValue: value };
const nanos = time => (BigInt(time[0]) * 1000000000n + BigInt(time[1])).toString();

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
        const wireSpans = spans.map(span => ({
          traceId: span.spanContext().traceId, spanId: span.spanContext().spanId,
          ...(span.parentSpanContext ? { parentSpanId: span.parentSpanContext.spanId } : {}),
          name: span.name, kind: 1, startTimeUnixNano: nanos(span.startTime), endTimeUnixNano: nanos(span.endTime),
          attributes: Object.entries(span.attributes).map(([key, value]) => ({ key, value: otlpValue(value) })),
          status: { code: span.status.code === 2 ? 2 : 1 }
        }));
        const body = JSON.stringify({ resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ scope: { name: 'agent-brain.metadata', version: '1' }, spans: wireSpans }] }] });
        if (Buffer.byteLength(body) > 1024 * 1024) return done(1);
        const url = new URL('/api/public/otel/v1/traces', credentials.baseUrl);
        const client = url.protocol === 'https:' ? https : http;
        const req = client.request(url, {
          method: 'POST', signal, timeout: timeoutMs, headers: {
            'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
            authorization: `Basic ${Buffer.from(`${credentials.publicKey}:${credentials.secretKey}`).toString('base64')}`,
            'x-langfuse-ingestion-version': '4', 'x-langfuse-sdk-name': 'agent-brain.metadata'
          }
        }, response => {
          // OTLP may report partial rejection in a 200 response. Fail closed on
          // any partialSuccess message and do not acknowledge queued spans.
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
              done(response.statusCode >= 200 && response.statusCode < 300 && result && !Array.isArray(result) && Object.keys(result).length === 0 ? 0 : 1);
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

async function flushOutbox({ stateDir = defaultStateDir(), credentials, dependencyRoot, timeoutMs = 3000, exporterFactory } = {}) {
  const result = { queued: 0, accepted: 0, failed: 0, attempted: 0, invalid: 0, verified: false, status: 'offline' };
  let directory, entries;
  try {
    directory = outboxDirectory(stateDir);
    result.queued = filesIn(directory).length;
    const read = readEntries(directory);
    entries = read.entries;
    result.invalid = read.invalid;
  } catch { result.status = 'state_unavailable'; return result; }
  if (!entries.length) { result.status = result.queued ? 'invalid_outbox' : 'empty'; return result; }
  const config = credentials === undefined && !exporterFactory ? loadCredentials() : validateCredentials(credentials, true);
  if (!config && !exporterFactory) return result;
  // One whole-flush deadline, including an injected factory/SDK shutdown.
  timeoutMs = Number.isFinite(timeoutMs) ? Math.max(10, Math.min(10000, Math.floor(timeoutMs))) : 3000;
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
    const exporter = {
      export(spans, callback) {
        const batch = spans.map(span => spanEntries.get(span));
        if (!active || batch.some(entry => !entry)) { callback({ code: 1 }); return; }
        let called = false;
        const done = response => {
          if (called) return;
          called = true;
          controller.signal.removeEventListener('abort', cancel);
          const success = active && response?.code === 0;
          if (success) for (const entry of batch) accepted.add(entry);
          // Never pass arbitrary transport errors into SDK diagnostics.
          callback({ code: success ? 0 : 1 });
        };
        const cancel = () => done({ code: 1 });
        controller.signal.addEventListener('abort', cancel, { once: true });
        try {
          const returned = delegate.export(spans, done);
          // Resolving a promise is NOT an ack; rejection is still a failure.
          if (returned && typeof returned.then === 'function') Promise.resolve(returned).catch(() => done({ code: 1 }));
        } catch { done({ code: 1 }); }
      },
      async shutdown() { await delegate.shutdown?.(); },
      async forceFlush() { await delegate.forceFlush?.(); }
    };
    const processor = new sdk.LangfuseSpanProcessor({
      exporter, exportMode: 'immediate', mediaUploadEnabled: false,
      publicKey: '', secretKey: '', baseUrl: 'https://invalid.invalid',
      environment: 'metadata-only', release: 'metadata-only',
      flushAt: OUTBOX_LIMITS.flush, flushInterval: 1, timeout: timeoutMs / 1000,
      mask: sdkMask, shouldExportSpan: () => true
    });
    let current;
    provider = new sdk.NodeTracerProvider({
      resource: sdk.emptyResource(), sampler: new sdk.AlwaysOnSampler(), spanProcessors: [processor], forceFlushTimeoutMillis: timeoutMs,
      idGenerator: { generateTraceId: () => current.traceId, generateSpanId: () => current.id }
    });
    const tracer = provider.getTracer('agent-brain.metadata', '1');
    for (const entry of entries) {
      if (!active) break;
      const record = entry.record;
      current = record;
      const parent = record.parentId ? sdk.trace.setSpanContext(sdk.ROOT_CONTEXT, {
        traceId: record.traceId, spanId: record.parentId, traceFlags: sdk.TraceFlags.SAMPLED, isRemote: true
      }) : sdk.ROOT_CONTEXT;
      const span = tracer.startSpan(record.name, { startTime: record.startTime, attributes: attributesFor(record) }, parent);
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
      if (privateRead(entry.file, MAX_FILE_BYTES).equals(entry.bytes)) {
        fs.unlinkSync(entry.file);
        result.accepted++;
      }
    } catch {}
  }
  result.failed = result.attempted - result.accepted;
  try { result.queued = filesIn(directory).length; } catch {}
  if (result.status === 'complete') result.status = result.failed ? 'failed' : 'transport_accepted';
  return result;
}

module.exports = { queueObservation, flushOutbox, loadCredentials, OUTBOX_LIMITS };
