'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const { sanitizeObservation, safeIdentity, configurePrivacy } = require('../runtime/langfuse/privacy.cjs');
const fixture = '6848460d-0ddc-43d7-a2bc-b9a44b19774c';
const record = uuid => ({ id: '1234567890abcdef', traceId: '1234567890abcdef1234567890abcdef', parentId: null,
  sessionId: uuid, nativeSessionId: uuid, type: 'AGENT', startTime: 1700000000000, endTime: 1700000000001,
  outcome: 'completed', context: { runId: uuid, parentSessionId: uuid } });

test('typed native UUIDs are not decoded as encoded free-form metadata labels', () => {
  assert.equal(safeIdentity(fixture), undefined, 'generic labels retain encoded CR/LF defenses');
  const result = sanitizeObservation(record(fixture));
  assert.equal(result.sessionId, fixture);
  assert.equal(result.nativeSessionId, fixture);
  assert.equal(result.context.runId, fixture);
  assert.equal(result.context.parentSessionId, fixture);
  for (let i = 0; i < 1000; i++) {
    const h = crypto.createHash('sha256').update(`synthetic-native-id-${i}`).digest('hex');
    const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
    assert.equal(sanitizeObservation(record(uuid)).nativeSessionId, uuid);
  }
});

test('typed IDs retain literal rejection and invalid UUID/encoded-label defenses', () => {
  configurePrivacy({ sensitiveLiterals: [fixture] });
  try { assert.throws(() => sanitizeObservation(record(fixture)), /Invalid metadata/); }
  finally { configurePrivacy(); }
  for (const value of ['00000000-0000-0000-0000-000000000000', 'private@example.invalid', 'Bearer:abc', 'f'.repeat(32)]) {
    assert.throws(() => sanitizeObservation(record(value)), /Invalid metadata/);
  }
  assert.equal(safeIdentity(Buffer.from('Bearer private-auth-token').toString('base64url')), undefined);
});

test('typed ID checks never coerce objects or invoke payload getters', () => {
  let calls = 0;
  const value = { toString() { calls++; throw Error('must not traverse'); } };
  assert.throws(() => sanitizeObservation(record(value)), /Invalid metadata/);
  assert.equal(calls, 0);
});
