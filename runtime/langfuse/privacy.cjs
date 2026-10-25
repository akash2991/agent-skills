'use strict';

// Metadata-only is unconditional. Content is neither traversed nor hashed.
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

module.exports = { sanitizeObservation, configurePrivacy, safeIdentity, structuralIdentity, CONTEXT_FIELDS, LIMITS };
