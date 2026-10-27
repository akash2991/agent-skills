'use strict';

// The frozen metadata projection never traverses content. Full-content is a
// separate, explicitly versioned bounded JSON envelope; it is NOT live opt-in.
const { types: { isProxy } } = require('node:util');
const CONTEXT_FIELDS = Object.freeze([
  'projectId', 'projectName', 'persona', 'ticketId', 'ticketSource', 'runtimeName',
  'agentName', 'harness', 'worktreeId', 'branch', 'parentSessionId', 'runId',
  'launchId', 'requestedModel', 'observedModel', 'requestedEffort', 'observedEffort',
  'evidenceSource'
]);
const TYPES = new Set(['AGENT', 'GENERATION', 'TOOL', 'SPAN']);
const OUTCOMES = new Set(['success', 'error', 'failed', 'completed', 'cancelled', 'aborted', 'timeout', 'unknown', 'interrupted']);
const LIMITS = Object.freeze({ identity: 128, skills: 32, metrics: 24, recordBytes: 16384, literals: 64 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
let sensitiveLiterals = [];
let contentConfigurationValid = true;
const CONTENT_LIMITS = Object.freeze({ recordBytes: 256 * 1024, depth: 32, nodes: 16384, keys: 4096, additionalLiterals: 4096 });
const REDACTED = '[REDACTED]';
const CONTENT_STATUSES = new Set(['captured', 'credential_redacted', 'unavailable', 'unsupported', 'refused_size']);

function invalid() { throw new Error('Invalid metadata-only observation'); }
function own(object, key) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

// An additional caller-configured defense, not a content-export switch. Invalid
// configuration retains the previous metadata literal defense and refuses new
// content until valid reconfiguration. No credential/environment discovery.
function configurePrivacy(options = {}) {
  contentConfigurationValid = false;
  if (!plain(options)) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(options, 'sensitiveLiterals');
  if (descriptor && !Object.hasOwn(descriptor, 'value')) invalid();
  const literals = descriptor?.value === undefined ? [] : descriptor.value;
  if (!Array.isArray(literals) || isProxy(literals) || literals.length > LIMITS.literals) invalid();
  const next = [];
  for (let i = 0; i < literals.length; i++) {
    const value = Object.getOwnPropertyDescriptor(literals, String(i))?.value;
    if (typeof value !== 'string' || value.length < 4 || value.length > 512) invalid();
    next.push(value.toLowerCase());
  }
  sensitiveLiterals = next;
  contentConfigurationValid = true;
}

function detected(value) {
  const lower = value.toLowerCase();
  if (sensitiveLiterals.some(literal => lower.includes(literal))) return true;
  return /(?:sk[-_](?:lf[-_])?|pk[-_]lf[-_]|gh[pousr]_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{8}|AIza[0-9A-Za-z_-]{12}|Bearer\b|-----BEGIN|(?:password|passwd|secret|api[-_]?key|access[-_]?token)[\s:=_-])/i.test(value)
    || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)
    || /\b\d{3}[- .]\d{2}[- .]\d{4}\b/.test(value)
    || /\b(?:1[- .]?)?\d{3}[- .]?\d{3}[- .]?\d{4}\b/.test(value)
    || /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(value)
    || /(?:data:|https?:\/\/|[?&](?:key|token)=)/i.test(value);
}

function safeIdentity(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > LIMITS.identity) return undefined;
  // No whitespace, encoding escapes, email syntax, prose or media. Reject opaque
  // hex digests as metadata: IDs have their own dedicated, validated fields.
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) || /[a-f0-9]{32,}/i.test(value) || detected(value)) return undefined;
  // Recognize common encoded secret/PII forms as defense in depth. The identity
  // grammar already excludes percent escapes, JSON escapes and standard base64
  // padding; unpadded base64/base64url and hex still need inspection.
  const pending = [value, ...value.split(/[.:/-]/).filter(part => part !== value && part.length >= 8)];
  for (let depth = 0; depth < 16 && pending.length; depth++) {
    const current = pending.shift();
    for (const encoding of ['base64url', 'hex']) {
      if (encoding === 'hex' && (!/^[a-f0-9]+$/i.test(current) || current.length % 2)) continue;
      if (encoding === 'base64url' && !/^[A-Za-z0-9_/-]{8,}$/.test(current)) continue;
      const decoded = Buffer.from(current, encoding).toString('utf8');
      if (!decoded || !/^[\x09\x0a\x0d\x20-\x7e]+$/.test(decoded)) continue;
      if (detected(decoded) || /[\r\n]/.test(decoded)) return undefined;
      if (decoded !== current) pending.push(decoded);
    }
  }
  if (pending.length) return undefined;
  return value;
}

function nativeUuid(value) {
  // Native UUIDs are typed identifiers, not free-form labels or encoded text.
  // Decoding random UUID components can accidentally yield CR/LF or PII-like
  // bytes and must not reject legitimate sessions. Literal defenses still apply.
  return typeof value === 'string' && UUID.test(value)
    && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)
    && !sensitiveLiterals.some(literal => value.toLowerCase().includes(literal)) ? value.toLowerCase() : undefined;
}
function structuralIdentity(field, value) {
  if (['runId', 'parentSessionId'].includes(field)) return nativeUuid(value);
  const prefix = field === 'projectId' ? 'project' : field === 'worktreeId' ? 'worktree' : null;
  return prefix && typeof value === 'string' && new RegExp(`^${prefix}-[a-f0-9]{32}$`).test(value)
    && !sensitiveLiterals.some(literal => value.toLowerCase().includes(literal)) ? value : undefined;
}

function requiredIdentity(value) {
  const safe = typeof value === 'string' && UUID.test(value) ? nativeUuid(value) : safeIdentity(value);
  if (!safe) invalid();
  return safe;
}
function identifier(value, length) {
  if (typeof value !== 'string' || value.length !== length || !/^[a-f0-9]+$/i.test(value) || /^0+$/.test(value)
    || sensitiveLiterals.some(literal => value.toLowerCase().includes(literal))) invalid();
  return value.toLowerCase();
}
function numericMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.keys(value);
  if (entries.length > LIMITS.metrics) return undefined;
  const result = {};
  for (const key of entries) {
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(key) || !safeIdentity(key) || ['constructor', 'prototype', '__proto__'].includes(key)) continue;
    const number = own(value, key);
    if (typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 1e12) result[key] = number;
  }
  return Object.keys(result).length ? result : undefined;
}
// Output remains bounded to 32 names per list; inspect at most the capture
// schema's 128 entries. Never discard the valid prefix merely due to overflow.
// Status is an enum, not caller text. Severity only increases on replay, so a
// partial list can never be mistaken for complete evidence after projection.
const SKILL_STATUSES = Object.freeze(['filtered', 'truncated', 'refused']);
function skillList(value, previousStatus) {
  const result = [];
  let severity = SKILL_STATUSES.indexOf(previousStatus);
  const mark = status => { severity = Math.max(severity, SKILL_STATUSES.indexOf(status)); };
  if (value !== undefined && !Array.isArray(value)) mark('refused');
  if (Array.isArray(value)) {
    if (value.length > 128) mark('refused');
    for (let i = 0; i < Math.min(value.length, 128); i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      const safe = safeIdentity(descriptor && descriptor.value);
      if (!safe) { mark('filtered'); continue; }
      if (result.includes(safe)) continue;
      if (result.length === LIMITS.skills) { mark('truncated'); continue; }
      result.push(safe);
    }
  }
  return { values: result.length ? result.sort() : undefined, status: SKILL_STATUSES[severity] };
}

// Best effort only: arbitrary, encoded and novel credentials can escape these
// rules. PII (including emails/SSNs/names/URLs) is deliberately NOT masked here.
// Protect the replacement token itself so every rule and literal is idempotent.
function redactCredentials(text, additionalPattern) {
  const rules = [
    [/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gi, REDACTED],
    [/\b(?:sk[-_](?:lf[-_])?|pk[-_]lf[-_]|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]+/gi, REDACTED],
    [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
    [/\bAIza[A-Za-z0-9_-]{20,}\b/g, REDACTED],
    [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED],
    [/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, `$1 ${REDACTED}`],
    // Runtime capabilities, not placeholder prose (ACTOR/NONCE). Preserve the
    // complete command, including quoting, rather than refusing its surface.
    [/(\bBRAIN_TRACE_LAUNCH_ID\s*=\s*|--actor(?:=|\s+))(["']?)([A-Za-z0-9_-]{32,128})(?![A-Za-z0-9_-])\2/gi, `$1$2${REDACTED}$2`],
    [/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s@]+@/gi, `$1${REDACTED}@`],
    [/((?:["']?(?:password|passwd|secret|client_secret|api[-_]?key|access[-_]?token|refresh[-_]?token|token|authorization|cookie)["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi, `$1${REDACTED}`]
  ];
  if (additionalPattern) rules.push([additionalPattern, REDACTED]);
  for (const literal of sensitiveLiterals) {
    const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    rules.push([new RegExp(escaped, 'gi'), REDACTED]);
  }
  for (const [pattern, replacement] of rules) text = text.split(REDACTED).map(part => part.replace(pattern, replacement)).join(REDACTED);
  return text;
}
const credentialKey = key => /^(?:password|passwd|secret|client[-_]?secret|api[-_]?key|access[-_]?token|refresh[-_]?token|token|authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|(?:aws[-_]?)?(?:secret[-_]?access[-_]?key|access[-_]?key[-_]?id)|private[-_]?key)$/i.test(key);
// Concrete native binary payloads, not prose or schemas describing media.
// Called only on our own descriptor-validated JSON clone, never native getters.
function nativeBinaryShape(value) {
  const source = value.source;
  const mime = text => typeof text === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(text);
  return (['image', 'audio', 'file', 'document'].includes(value.type)
    && ((typeof value.data === 'string' && mime(value.mimeType))
      || (source?.type === 'base64' && typeof source.data === 'string')
      || (value.type === 'file' && typeof value.file?.file_data === 'string')))
    || (value.type === 'base64' && typeof value.data === 'string'
      && (mime(value.media_type) || mime(value.mimeType)))
    || (value.type === 'input_audio' && typeof value.input_audio?.data === 'string'
      && typeof value.input_audio.format === 'string')
    || (typeof value.inlineData?.data === 'string' && mime(value.inlineData.mimeType))
    || (typeof value.inline_data?.data === 'string' && mime(value.inline_data.mime_type));
}
function contentFailure(status) { throw Object.assign(new Error('Content refused'), { contentStatus: status }); }
function plain(value) {
  return value && typeof value === 'object' && !isProxy(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function fields(value, allowed) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))) contentFailure('unsupported');
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) contentFailure('unsupported');
  }
}
// Shared snapshot/redactor for admission AND wire revalidation. It never calls
// getters/toJSON, accepts no proxies/classes/prototype keys, and returns either
// the COMPLETE JSON value or a typed refusal, never a successful prefix.
function projectContent(value, options = {}) {
  if (!contentConfigurationValid) return { status: 'unavailable' };
  // Per-capture known runtime capabilities only. Never mutate configured
  // literals or discover environment/private state. Validate without getters.
  const additionalLiterals = [];
  try {
    fields(options, ['additionalSensitiveLiterals']);
    const descriptor = Object.getOwnPropertyDescriptor(options, 'additionalSensitiveLiterals');
    if (descriptor && !Object.hasOwn(descriptor, 'value')) contentFailure('unsupported');
    const literals = descriptor?.value;
    if (literals !== undefined) {
      if (!Array.isArray(literals) || isProxy(literals) || Object.getPrototypeOf(literals) !== Array.prototype) contentFailure('unsupported');
      if (literals.length > CONTENT_LIMITS.additionalLiterals) contentFailure('refused_size');
      if (Reflect.ownKeys(literals).length !== literals.length + 1) contentFailure('unsupported');
      for (let i = 0; i < literals.length; i++) {
        const literal = Object.getOwnPropertyDescriptor(literals, String(i))?.value;
        if (typeof literal !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(literal)) contentFailure('unsupported');
        additionalLiterals.push(literal.toLowerCase());
      }
    }
  } catch (error) { return { status: error.contentStatus || 'unsupported' }; }
  const additionalPattern = additionalLiterals.length
    ? new RegExp([...new Set(additionalLiterals)].sort((a, b) => b.length - a.length).join('|'), 'gi') : undefined;
  const ancestors = new Set();
  let nodes = 0, bytes = 0, redacted = false;
  const charge = amount => { bytes += amount; if (bytes > CONTENT_LIMITS.recordBytes) contentFailure('refused_size'); };
  function text(raw) {
    // Bound work before regex processing/JSON escaping, then bound both forms.
    if (raw.length > CONTENT_LIMITS.recordBytes) contentFailure('refused_size');
    charge(Buffer.byteLength(JSON.stringify(raw)));
    if (/^\s*data:(?:[a-z0-9.+-]+\/[a-z0-9.+-]+)?(?:;[^,\s]*)?,/i.test(raw)) contentFailure('unsupported');
    const safe = redactCredentials(raw, additionalPattern);
    if (safe !== raw) redacted = true;
    return safe;
  }
  function visit(raw, depth) {
    if (++nodes > CONTENT_LIMITS.nodes || depth > CONTENT_LIMITS.depth) contentFailure('refused_size');
    if (raw === null || typeof raw === 'boolean') { charge(raw === false ? 5 : 4); return raw; }
    if (typeof raw === 'number' && Number.isFinite(raw)) { charge(Buffer.byteLength(JSON.stringify(raw))); return Object.is(raw, -0) ? 0 : raw; }
    if (typeof raw === 'string') return text(raw);
    if (!raw || typeof raw !== 'object' || isProxy(raw) || ancestors.has(raw)) contentFailure('unsupported');
    const array = Array.isArray(raw);
    if (array ? Object.getPrototypeOf(raw) !== Array.prototype : !plain(raw)) contentFailure('unsupported');
    const keys = Reflect.ownKeys(raw);
    const count = keys.length - (array ? 1 : 0);
    if (count > CONTENT_LIMITS.keys || (array && raw.length > CONTENT_LIMITS.keys)) contentFailure('refused_size');
    if (array && count !== raw.length) contentFailure('unsupported');
    ancestors.add(raw); charge(2 + Math.max(0, count - 1) + (array ? 0 : count));
    const result = array ? [] : {};
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)
        || (array && !/^(?:0|[1-9][0-9]*)$/.test(key))) contentFailure('unsupported');
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) contentFailure('unsupported');
      const safeKey = array ? key : text(key);
      if (!array && (Object.hasOwn(result, safeKey) || ['__proto__', 'prototype', 'constructor'].includes(safeKey))) contentFailure('unsupported');
      if (credentialKey(key) || (/^BRAIN_TRACE_LAUNCH_ID$/i.test(key)
        && typeof descriptor.value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(descriptor.value))) { result[safeKey] = REDACTED; redacted = true; }
      else result[safeKey] = visit(descriptor.value, depth + 1);
    }
    ancestors.delete(raw);
    if (!array && nativeBinaryShape(result)) contentFailure('unsupported');
    return result;
  }
  try {
    const safe = visit(value, 0);
    if (Buffer.byteLength(JSON.stringify(safe)) > CONTENT_LIMITS.recordBytes) contentFailure('refused_size');
    return { status: redacted ? 'credential_redacted' : 'captured', value: safe };
  } catch (error) { return { status: error.contentStatus || 'unsupported' }; }
}
// Producer API (not consent or a native/provider schema): record.content =
// { version: 1, captureMode: 'full-content', redactionPolicyVersion: 1,
//   input: { status: 'captured', value: JSON }, output: { status: 'unavailable' } }.
// Both surfaces are required. Refusal/unavailable statuses carry NO value. The
// whole canonical record is capped at 256KiB in addition to traversal budgets;
// when the two complete surfaces together cannot fit, neither becomes a prefix.
// Future flow/adapter writers must project BEFORE their own managed persistence
// and keep this envelope on revisions; top-level input/output remain ignored.
function contentEnvelope(value) {
  fields(value, ['version', 'captureMode', 'redactionPolicyVersion', 'input', 'output']);
  if (own(value, 'version') !== 1 || own(value, 'captureMode') !== 'full-content' || own(value, 'redactionPolicyVersion') !== 1) contentFailure('unsupported');
  const result = { version: 1, captureMode: 'full-content', redactionPolicyVersion: 1 };
  for (const surface of ['input', 'output']) {
    const item = own(value, surface);
    fields(item, ['status', 'value']);
    const status = own(item, 'status');
    if (!CONTENT_STATUSES.has(status)) contentFailure('unsupported');
    if (['captured', 'credential_redacted'].includes(status)) {
      if (!Object.hasOwn(item, 'value')) contentFailure('unsupported');
      result[surface] = projectContent(own(item, 'value'));
      if (status === 'credential_redacted' && result[surface].status === 'captured') result[surface].status = status;
    } else {
      if (Object.hasOwn(item, 'value')) contentFailure('unsupported');
      result[surface] = { status };
    }
  }
  return result;
}

// Do not add policy-dependent behavior here: schema-2 canonical replay and its
// historical-prefix classifier deliberately call this frozen implementation.
function sanitizeMetadataObservation(record) {
  try {
    const type = own(record, 'type');
    if (!TYPES.has(type)) invalid();
    const startTime = own(record, 'startTime');
    const endTime = own(record, 'endTime');
    if (!Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime) || startTime <= 0 || endTime < startTime || endTime > 8640000000000000) invalid();
    const result = {
      id: identifier(own(record, 'id'), 16), traceId: identifier(own(record, 'traceId'), 32),
      parentId: own(record, 'parentId') === null ? null : identifier(own(record, 'parentId'), 16),
      sessionId: requiredIdentity(own(record, 'sessionId')),
      nativeSessionId: requiredIdentity(own(record, 'nativeSessionId')),
      type, startTime, endTime
    };
    if (result.parentId === result.id) invalid();
    const context = own(record, 'context');
    const normalized = {};
    for (const field of CONTEXT_FIELDS) {
      const value = own(context, field);
      const safe = structuralIdentity(field, value) || safeIdentity(value);
      if (safe) normalized[field] = safe;
    }
    for (const field of ['skillsInvoked', 'skillsLoaded']) {
      const safe = skillList(own(context, field), own(context, `${field}Status`));
      if (safe.values) normalized[field] = safe.values;
      if (safe.status) normalized[`${field}Status`] = safe.status;
    }
    const contextOutcome = own(context, 'outcome');
    if (OUTCOMES.has(contextOutcome)) normalized.outcome = contextOutcome;
    for (const field of ['model', 'provider', 'toolName']) {
      const safe = safeIdentity(own(record, field));
      if (safe) result[field] = safe;
    }
    for (const field of ['usage', 'cost']) {
      const safe = numericMap(own(record, field));
      if (safe) result[field] = safe;
    }
    const outcome = own(record, 'outcome');
    if (OUTCOMES.has(outcome)) result.outcome = outcome;
    if (Object.keys(normalized).length) result.context = normalized;
    // Ignore the caller's name entirely; descriptions cannot become span names.
    result.name = [type.toLowerCase(), normalized.persona, type === 'TOOL' ? result.toolName : undefined].filter(Boolean).join(':');
    // Skill evidence is expendable only with an explicit diagnostic. Keep the
    // rest of the metadata and as much of both bounded lists as the record fits.
    while (Buffer.byteLength(JSON.stringify(result)) > LIMITS.recordBytes) {
      const fields = ['skillsInvoked', 'skillsLoaded'].filter(field => normalized[field]?.length);
      if (!fields.length) invalid();
      const field = fields.sort((a, b) => JSON.stringify(normalized[b]).length - JSON.stringify(normalized[a]).length)[0];
      normalized[field].pop();
      if (!normalized[field].length) delete normalized[field];
      if (normalized[`${field}Status`] !== 'refused') normalized[`${field}Status`] = 'truncated';
    }
    return result;
  } catch { invalid(); }
}

function sanitizeObservation(record) {
  const result = sanitizeMetadataObservation(record);
  // The default path NEVER reads record.input/output, nor context content.
  const descriptor = record && Object.getOwnPropertyDescriptor(record, 'content');
  if (!descriptor) return result;
  try {
    if (!Object.hasOwn(descriptor, 'value')) contentFailure('unsupported');
    result.content = contentEnvelope(descriptor.value);
    if (Buffer.byteLength(JSON.stringify(result)) > CONTENT_LIMITS.recordBytes) {
      for (const surface of ['input', 'output']) {
        if (Object.hasOwn(result.content[surface], 'value')) result.content[surface] = { status: 'refused_size' };
      }
    }
    return result;
  } catch { throw new Error('Invalid full-content envelope'); }
}

module.exports = { sanitizeObservation, sanitizeMetadataObservation, projectContent, configurePrivacy, safeIdentity, structuralIdentity, CONTEXT_FIELDS, LIMITS, CONTENT_LIMITS };
