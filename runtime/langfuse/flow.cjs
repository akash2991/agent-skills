'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ContextStore } = require('./context.cjs');
const { sanitizeObservation } = require('./privacy.cjs');
const { queueObservation, flushOutbox } = require('./export.cjs');

const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const id = seed => seed === undefined ? crypto.randomBytes(8).toString('hex') : hash(seed).slice(0, 16);
const MAX_STATE = 1024 * 1024;
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
    fs.writeFileSync(temp, content, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  };
  const readState = key => readFile(fileFor(key));
  const writeState = (key, data) => writeFile(fileFor(key), data);
  const inboundIdentity = env.BRAIN_TRACE_LAUNCH_ID ? { nonce: env.BRAIN_TRACE_LAUNCH_ID }
    : env.PI_SUBAGENT_ID ? { launchId: env.PI_SUBAGENT_ID }
      : env.PI_SUBAGENT_SESSION ? { sessionFile: env.PI_SUBAGENT_SESSION } : null;

  function remember(run, extra = {}) {
    if (typeof extra.pendingIdentity === 'string') extra = { ...extra, pendingIdentity: { launchId: extra.pendingIdentity } };
    const old = readState(`run:${run.rootSpanId}`) || {};
    writeState(`run:${run.rootSpanId}`, { ...old, run, ...extra });
    return run;
  }

  function resolve(run, seen = new Set()) {
    if (!run || seen.has(run.rootSpanId) || seen.size > 32) return null;
    seen.add(run.rootSpanId);
    const entry = readState(`run:${run.rootSpanId}`);
    if (!entry) return run;
    let parent = entry.parent || null;
    let child = {};
    let resolvedHint;
    if (entry.pendingIdentity) {
      const inspected = store.inspectLaunch(entry.pendingIdentity);
      if (inspected?.parent) {
        resolvedHint = resolve(inspected.parent, seen);
        if (!resolvedHint) return null;
      }
      const binding = store.resolveLaunch(entry.pendingIdentity);
      if (!binding) return null;
      store.takePending(entry.pendingIdentity);
      const canonical = store.getRun(entry.run.runId);
      if (!canonical || canonical.traceId !== binding.parent.traceId || canonical.parentSpanId !== binding.parent.rootSpanId) return null;
      parent = binding.parent;
      child = binding.child || {};
    }
    if (!parent) return entry.run;
    const currentParent = resolvedHint || resolve(parent, seen);
    if (!currentParent) return null;
    const updated = {
      ...entry.run, traceId: currentParent.traceId, parentSpanId: currentParent.rootSpanId,
      sessionId: currentParent.sessionId, parentSessionId: currentParent.nativeSessionId,
      persona: child.persona || entry.run.persona || null,
      agentName: child.agentName || entry.run.agentName,
      ticketId: child.ticketId || entry.run.ticketId || currentParent.ticketId,
      ticketSource: child.ticketId ? 'explicit' : entry.run.ticketSource || currentParent.ticketSource
    };
    remember(updated, { parent: currentParent, pendingIdentity: null });
    return updated;
  }

  function begin(opts) {
    const savedLaunch = readState(`native-launch:${harness}:${opts.nativeSessionId}`);
    let identity = (typeof opts.pendingIdentity === 'string' ? { launchId: opts.pendingIdentity } : opts.pendingIdentity)
      || (!opts.parent ? (savedLaunch ? { nonce: savedLaunch.nonce } : inboundIdentity) : null);
    if (!identity && !opts.parent) {
      const exact = { launchId: `brain:${harness}:${opts.nativeSessionId}` };
      if (store.resolveLaunch(exact)) identity = exact;
    }
    const binding = identity ? store.resolveLaunch(identity) : null;
    const boundNonce = identity?.nonce || binding?.nonce;
    if (boundNonce) {
      const scope = readState(`pane:${boundNonce}`);
      if (scope && (scope.paneId !== env.HERDR_PANE_ID || scope.expiresAt < clock()
        || (scope.nativeSessionHash && scope.nativeSessionHash !== hash(opts.nativeSessionId)))) {
        throw new Error('Scoped launch binding does not match this child');
      }
    }
    const parent = opts.parent || binding?.parent || null;
    const run = store.createRun({ ...opts, harness, parent,
      persona: opts.persona || binding?.child?.persona,
      agentName: binding?.child?.agentName || opts.agentName,
      ticketId: opts.ticketId || binding?.child?.ticketId });
    if (identity && !binding) store.hold({ identity, run, records: [] });
    remember(run, { ...(parent ? { parent } : {}), ...(identity && !binding ? { pendingIdentity: identity } : {}) });
    if (boundNonce && binding) {
      const scope = readState(`pane:${boundNonce}`);
      if (scope) writeState(`pane:${boundNonce}`, { ...scope, nativeSessionHash: hash(opts.nativeSessionId) });
      writeState(`launch-ack:${boundNonce}`, { nativeSessionId: run.nativeSessionId, rootSpanId: run.rootSpanId, harness,
        ...(env.HERDR_PANE_ID ? { paneId: env.HERDR_PANE_ID } : {}), acknowledgedAt: clock(), phase: 'adapter-started' });
    }
    return run;
  }

  function acknowledgeSession(nativeSessionId) {
    const savedLaunch = readState(`native-launch:${harness}:${nativeSessionId}`);
    const identity = savedLaunch ? { nonce: savedLaunch.nonce } : inboundIdentity || { launchId: `brain:${harness}:${nativeSessionId}` };
    const binding = store.resolveLaunch(identity);
    const nonce = identity.nonce || binding?.nonce;
    if (!nonce) return false;
    const scope = readState(`pane:${nonce}`);
    if (!binding && !(savedLaunch && scope)) return false;
    if (scope && (scope.paneId !== env.HERDR_PANE_ID || scope.expiresAt < clock()
      || (scope.nativeSessionHash && scope.nativeSessionHash !== hash(nativeSessionId)))) return false;
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
    return run ? (resolve(run) || run) : null;
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
    const safe = finished.map(record => sanitizeObservation({ ...record,
      traceId: current?.traceId || run.traceId, sessionId: current?.sessionId || run.sessionId,
      nativeSessionId: run.nativeSessionId,
      parentId: record.id === run.rootSpanId ? current?.parentSpanId || run.parentSpanId || null : record.parentId,
      context: { ...(record.context || {}), ...(current || run) } }));
    if (!safe.length) return { queued: 0, pending: 0 };
    const retain = batch => {
      if (fs.readdirSync(pendingDir).length >= 2048) {
        writeState('health', { lineageLossObserved: true, reason: 'pending_capacity' });
        throw new Error('Pending tracing capacity reached; capture loss recorded');
      }
      writeFile(path.join(pendingDir, `${crypto.randomUUID()}.json`), { runId: run.rootSpanId, records: batch, createdAt: clock() });
    };
    if (!current) {
      retain(safe);
      return { queued: 0, pending: safe.length };
    }
    for (let i = 0; i < safe.length; i++) {
      if (enqueue(safe[i], { stateDir })?.queued === false) {
        retain(safe.slice(i));
        return { queued: i, pending: safe.length - i };
      }
    }
    return { queued: safe.length, pending: 0 };
  }

  async function flush(opts = {}) {
    const deadline = Date.now() + (Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 3000);
    if (['false', '0'].includes(String(env.BRAIN_TRACING_ENABLED || '').toLowerCase()) || ['false', '0'].includes(String(env.LANGFUSE_TRACING_ENABLED || '').toLowerCase())) return { queued: 0, accepted: 0, disabled: true };
    // Recover an interrupted pending-to-outbox transfer. Stable observation IDs
    // make replay at-least-once; never pretend a stranded claim was delivered.
    for (const name of fs.readdirSync(pendingDir).filter(name => /^[a-f0-9-]+\.json\.[a-f0-9-]+\.claim$/.test(name))) {
      const file = path.join(pendingDir, name);
      try {
        if (clock() - fs.lstatSync(file).mtimeMs > 120000 && readFile(file)) fs.renameSync(file, path.join(pendingDir, `${crypto.randomUUID()}.json`));
      } catch { /* A concurrent flusher may own or have recovered this claim. */ }
    }
    for (const name of fs.readdirSync(pendingDir).filter(name => /^[a-f0-9-]+\.json$/.test(name)).slice(0, 256)) {
      const file = path.join(pendingDir, name);
      const batch = readFile(file);
      if (batch && clock() - batch.createdAt > 7 * 24 * 3600 * 1000) {
        writeState('health', { lineageLossObserved: true, reason: 'pending_expired' });
        try { fs.unlinkSync(file); } catch { /* Another flusher may have claimed it. */ }
        continue;
      }
      const entry = batch && readState(`run:${batch.runId}`);
      const run = entry && resolve(entry.run);
      if (!run) continue;
      const claim = `${file}.${crypto.randomUUID()}.claim`;
      try { fs.renameSync(file, claim); } catch { continue; }
      try {
        for (const record of batch.records) {
          const result = enqueue({ ...record, traceId: run.traceId, sessionId: run.sessionId,
            parentId: record.id === run.rootSpanId ? run.parentSpanId : record.parentId,
            context: { ...record.context, ...(run.parentSessionId ? { parentSessionId: run.parentSessionId } : {}) } }, { stateDir });
          if (result?.queued === false) throw new Error('Observation queue unavailable');
        }
        fs.unlinkSync(claim);
      } catch {
        // Preserve only sanitized records after any queue/delivery failure.
        try { fs.renameSync(claim, file); } catch { /* The private claim remains recoverable. */ }
      }
    }
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

  return { store, stateDir, harness, inboundIdentity, begin, acknowledgeSession, createToolLaunch, actorForTool, remember, resolve, session, update, submit, flush, id,
    readState, writeState, stateFile: fileFor, knownPersona, knownSkill, captureBrainCommand, captureSkill, now: clock };
}

module.exports = { createFlow, safeState };
