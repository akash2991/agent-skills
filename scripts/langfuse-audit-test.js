'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { audit, auditPrivacy, auditChild } = require('./langfuse-audit');

const canaries = {
  langfuse_key: 'sk-lf-BRAIN_SYNTHETIC_ONLY_INVALID',
  provider_key: 'sk-proj-BRAIN_SYNTHETIC_ONLY_INVALID',
  password: 'BRAIN_SYNTHETIC_PASSWORD_INVALID',
  email: 'brain-canary@example.invalid', ssn: '000-00-0000'
};

function nested(type = 'AGENT') {
  return [
    { id: 'parent', traceId: 'trace', sessionId: 'parent-session', type: 'SPAN' },
    { id: 'child', parentObservationId: 'parent', traceId: 'trace', sessionId: 'parent-session', type,
      name: 'Subagent: synthetic test', metadata: { session_id: 'child-session' } },
    { id: 'generation', parentObservationId: 'child', traceId: 'trace', type: 'GENERATION' },
    { id: 'tool', parentObservationId: 'child', traceId: 'trace', type: 'TOOL' }
  ];
}

const child = row => row.id === 'child';

test('privacy scan detects every synthetic secret/PII class in all supported surfaces', () => {
  const text = Object.values(canaries).join('\n');
  const result = auditPrivacy([{ input: text, output: { content: text }, metadata: { note: text } }], canaries);
  assert.equal(result.status, 'leak_detected');
  for (const finding of Object.values(result.canaries)) {
    assert.equal(finding.status, 'persisted');
    assert.deepEqual(finding.observationCounts, { input: 1, output: 1, metadata: 1 });
  }
  for (const value of Object.values(canaries)) assert.ok(!JSON.stringify(result).includes(value), 'report must not echo input content');
});

test('missing observations/canaries never count as successfully redacted', () => {
  for (const rows of [undefined, []]) assert.equal(auditPrivacy(rows, canaries).status, 'incomplete');
  assert.equal(auditPrivacy([{}], {}).status, 'incomplete');
  const absent = auditPrivacy([{ output: '[redacted]' }], canaries);
  assert.equal(absent.status, 'no_canary_observed');
  assert.equal(absent.maskingVerified, false);
  assert.equal(absent.canaries.langfuse_key.status, 'not_observed');
});

test('reproduces pinned Pi 0.1.2 generic-key regex bypass on escaped newlines, not plugin execution', () => {
  // Mirrors its published pattern only; live SDK/export evidence is documented
  // separately. A successful reproduction is evidence of a BUG, not masking.
  const upstreamPattern = /\b[sp]k-lf-[\w-]+\b/g;
  const quoted = JSON.stringify({ output: canaries.langfuse_key });
  const multiline = JSON.stringify({ output: `synthetic heading\n${canaries.langfuse_key}` });
  assert.ok(!quoted.replace(upstreamPattern, '[redacted]').includes(canaries.langfuse_key));
  assert.ok(multiline.replace(upstreamPattern, '[redacted]').includes(canaries.langfuse_key));
});

test('runtime success without child telemetry is a missing-subtree finding', () => {
  assert.deepEqual(auditChild([], child, true), { status: 'missing', runtimeCompleted: true, childObservationCount: 0 });
});

test('nested generic spans are partial, not correctly typed agents', () => {
  const result = auditChild(nested('SPAN'), child, true);
  assert.equal(result.status, 'partial');
  assert.equal(result.parentLinked, true);
  assert.equal(result.sessionGrouped, true);
  assert.equal(result.agentTyped, false);
  assert.equal(result.nestedGenerations, 1);
  assert.equal(result.nestedTools, 1);
});

test('child capture requires matching parent trace/session and actual nested work', () => {
  assert.equal(auditChild(nested(), child, true).status, 'pass');
  for (const change of [rows => { rows[1].traceId = 'other-trace'; }, rows => { rows[1].sessionId = 'other-session'; },
    rows => { rows.pop(); }, rows => { rows.splice(2, 1); }]) {
    const rows = nested(); change(rows);
    assert.equal(auditChild(rows, child, true).status, 'partial');
  }
  assert.equal(auditChild(nested(), child, false).status, 'partial');
});

test('duplicate dispatch and child execution cannot pass agent-tree checks', () => {
  const rows = nested();
  rows.push({ id: 'dispatch', parentObservationId: 'parent', traceId: 'trace', name: 'Tool: Agent', type: 'TOOL' });
  const result = auditChild(rows, child, true);
  assert.equal(result.status, 'partial');
  assert.equal(result.duplicateDispatch, true);
});

test('bundle without expected child identity is incomplete, not a pass', () => {
  const result = audit({ schema: 1, observations: {} });
  assert.ok(Object.values(result.subagents).every(row => row.status === 'incomplete'));
  assert.equal(result.certifiesPrivacy, false);
});

test('CLI reports findings or inconclusive evidence with nonzero exit; malformed input omits contents', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'langfuse-audit-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'evidence.json');
  const run = () => spawnSync(process.execPath, [path.join(__dirname, 'langfuse-audit.js'), file], { encoding: 'utf8' });
  fs.writeFileSync(file, JSON.stringify({ schema: 1, observations: { claude: [{ output: canaries.password }] }, canaries: { claude: canaries } }));
  const result = run();
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).privacy.claude.status, 'leak_detected');
  for (const value of Object.values(canaries)) assert.ok(!result.stdout.includes(value));
  fs.writeFileSync(file, '{"SECRET_CONTENT":');
  const invalid = run();
  assert.equal(invalid.status, 2);
  assert.ok(!invalid.stderr.includes('SECRET_CONTENT'));
});
