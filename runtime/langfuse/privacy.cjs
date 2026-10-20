'use strict';

// Metadata-only is unconditional. Content is neither traversed nor hashed.
const CONTEXT_FIELDS = Object.freeze([
  'projectId', 'projectName', 'persona', 'ticketId', 'ticketSource', 'runtimeName',
  'agentName', 'harness', 'worktreeId', 'branch', 'parentSessionId', 'runId',
  'launchId', 'requestedModel', 'observedModel', 'requestedEffort', 'observedEffort',
  'evidenceSource'
]);
const TYPES = new Set(['AGENT', 'GENERATION', 'TOOL', 'SPAN']);
const OUTCOMES = new Set(['success', 'error', 'failed', 'completed', 'cancelled', 'aborted', 'timeout', 'unknown']);
const LIMITS = Object.freeze({ identity: 128, skills: 32, metrics: 24, recordBytes: 16384, literals: 64 });
let sensitiveLiterals = [];

function invalid() { throw new Error('Invalid metadata-only observation'); }
function own(object, key) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

// An additional caller-configured defense, not a content-export switch. Invalid
// configuration fails closed and leaves the previous configuration unchanged.
function configurePrivacy({ sensitiveLiterals: literals = [] } = {}) {
  if (!Array.isArray(literals) || literals.length > LIMITS.literals) invalid();
  const next = [];
  for (const value of literals) {
    if (typeof value !== 'string' || value.length < 4 || value.length > 512) invalid();
    next.push(value.toLowerCase());
  }
  sensitiveLiterals = next;
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

function requiredIdentity(value) { const safe = safeIdentity(value); if (!safe) invalid(); return safe; }
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
function skillList(value) {
  if (!Array.isArray(value) || value.length > LIMITS.skills) return undefined;
  const result = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    const safe = safeIdentity(descriptor && descriptor.value);
    if (safe && !result.includes(safe)) result.push(safe);
  }
  return result.length ? result.sort() : undefined;
}

function sanitizeObservation(record) {
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
      const safe = safeIdentity(own(context, field));
      if (safe) normalized[field] = safe;
    }
    for (const field of ['skillsInvoked', 'skillsLoaded']) {
      const safe = skillList(own(context, field));
      if (safe) normalized[field] = safe;
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
    if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.recordBytes) invalid();
    return result;
  } catch { invalid(); }
}

module.exports = { sanitizeObservation, configurePrivacy, safeIdentity, CONTEXT_FIELDS, LIMITS };
