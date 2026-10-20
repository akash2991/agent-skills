#!/usr/bin/env node
'use strict';

// Maintainer-only, offline verifier for captured synthetic live-test evidence.
// This does not launch agents, fetch traces, implement redaction, or repair it.
const fs = require('node:fs');
const CANARIES = ['langfuse_key', 'provider_key', 'password', 'email', 'ssn'];

function auditPrivacy(rows, canaries) {
  if (!Array.isArray(rows) || !rows.length || !canaries || CANARIES.some(key => typeof canaries[key] !== 'string' || !canaries[key])) {
    return { status: 'incomplete', observationCount: Array.isArray(rows) ? rows.length : 0 };
  }
  const findings = {};
  for (const key of CANARIES) {
    const counts = {};
    for (const field of ['input', 'output', 'metadata']) {
      counts[field] = rows.filter(row => JSON.stringify(row?.[field] ?? '').includes(canaries[key])).length;
    }
    findings[key] = { status: Object.values(counts).some(Boolean) ? 'persisted' : 'not_observed', observationCounts: counts };
  }
  return {
    status: Object.values(findings).some(item => item.status === 'persisted') ? 'leak_detected' : 'no_canary_observed',
    observationCount: rows.length,
    // Absence alone is NOT proof of masking: the model might not have exercised
    // a surface, SDK truncation may apply, or collection may be incomplete.
    maskingVerified: false,
    canaries: findings
  };
}

function auditChild(rows, matchesChild, runtimeCompleted) {
  if (!Array.isArray(rows)) return { status: 'incomplete' };
  const children = rows.filter(row => row && matchesChild(row));
  if (children.length !== 1) return { status: children.length ? 'ambiguous' : 'missing', runtimeCompleted: runtimeCompleted === true, childObservationCount: children.length };
  const child = children[0];
  const parent = rows.find(row => row && row.id === child.parentObservationId && row.traceId === child.traceId);
  const nested = rows.filter(row => row && row.parentObservationId === child.id && row.traceId === child.traceId);
  const generations = nested.filter(row => row.type === 'GENERATION');
  const tools = nested.filter(row => row.type === 'TOOL');
  const duplicateDispatch = rows.some(row => row && ['Tool: Agent', 'Tool: subagent'].includes(row.name)
    && row.parentObservationId === child.parentObservationId && row.traceId === child.traceId);
  const grouped = Boolean(parent && child.sessionId && parent.sessionId === child.sessionId);
  const typed = child.type === 'AGENT';
  // A partial capture never receives a passing status, even if runtime exit=0.
  const complete = Boolean(parent && grouped && generations.length && tools.length && typed && !duplicateDispatch && runtimeCompleted === true);
  return {
    status: complete ? 'pass' : 'partial', runtimeCompleted: runtimeCompleted === true,
    parentLinked: Boolean(parent), sessionGrouped: grouped, agentTyped: typed,
    nestedGenerations: generations.length, nestedTools: tools.length, duplicateDispatch
  };
}

function audit(bundle) {
  if (!bundle || bundle.schema !== 1 || !bundle.observations || typeof bundle.observations !== 'object') throw new Error('Invalid audit bundle');
  const rows = bundle.observations;
  const expected = bundle.expected || {};
  const runtime = bundle.runtimeCompleted || {};
  const privacy = {};
  for (const label of ['piParent', 'piChild', 'piDirect', 'claude']) {
    privacy[label] = auditPrivacy(rows[label], bundle.canaries?.[label === 'claude' ? 'claude' : 'pi']);
  }
  const subagents = {
    piHerdr: typeof expected.piHerdrChildSessionId === 'string' && expected.piHerdrChildSessionId
      ? auditChild([...(Array.isArray(rows.piParent) ? rows.piParent : []), ...(Array.isArray(rows.piChild) ? rows.piChild : [])],
        row => ['SPAN', 'AGENT'].includes(row.type) && (row.metadata?.session_id === expected.piHerdrChildSessionId
          || (!row.parentObservationId && row.sessionId === expected.piHerdrChildSessionId)),
        runtime.piHerdr)
      : { status: 'incomplete' },
    piDirect: typeof expected.piDirectChildSessionId === 'string' && expected.piDirectChildSessionId
      ? auditChild(rows.piDirect, row => row.metadata?.session_id === expected.piDirectChildSessionId, runtime.piDirect)
      : { status: 'incomplete' },
    claude: typeof expected.claudeChildName === 'string' && expected.claudeChildName
      ? auditChild(rows.claude, row => row.name === expected.claudeChildName, runtime.claude)
      : { status: 'incomplete' }
  };
  return { schema: 1, privacy, subagents, certifiesPrivacy: false };
}

if (require.main === module) {
  if (process.argv.length !== 3) {
    console.error('Usage: node scripts/langfuse-audit.js <local-synthetic-evidence.json>');
    process.exitCode = 2;
  } else {
    try {
      const report = audit(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
      // Do not echo canary values, inputs, outputs, raw metadata or parse errors.
      console.log(JSON.stringify(report, null, 2));
      // This diagnostic cannot certify privacy from absence; keep the gate red.
      process.exitCode = 1;
    } catch {
      console.error('Unable to audit evidence: invalid or unreadable bundle (contents omitted).');
      process.exitCode = 2;
    }
  }
}

module.exports = { audit, auditPrivacy, auditChild };
