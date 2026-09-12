'use strict';
// Provider quota, pace, and runway via quota-axi (https://github.com/kunchenguid/quota-axi, MIT).
// quota-axi is a standalone CLI, not a library: we shell out to it, so it is optional at runtime
// and its absence degrades to UNKNOWN instead of failing. It reads local credential stores and
// calls first-party provider endpoints; it reports figures and never routes. Routing decisions
// stay with the EM (`model-routing`).
const { spawnSync } = require('node:child_process');

const PROVIDERS = ['claude', 'codex', 'cursor', 'copilot', 'grok', 'kimi', 'zai', 'agy', 'alibaba', 'opencode-go'];

// Tries a local install first, then npx. Returns { available, scopes[], providers[], reason }.
function read({ providers, timeoutMs = 45000 } = {}) {
  const args = ['--json'];
  if (providers && providers.length) args.push('--provider', providers.join(','));
  const attempts = [['quota-axi', args], ['npx', ['-y', 'quota-axi', ...args]]];
  for (const [command, argv] of attempts) {
    const run = spawnSync(command, argv, { encoding: 'utf8', timeout: timeoutMs });
    if (run.error || run.status !== 0 || !run.stdout) continue;
    let payload;
    try { payload = JSON.parse(run.stdout); } catch { continue; }
    return { available: true, command, ...normalize(payload) };
  }
  return { available: false, reason: 'quota-axi not available (install: npm i -g quota-axi, or allow npx)', scopes: [], providers: [] };
}

// Flattens quota-axi's per-provider effectiveAvailability into one row per scope.
function normalize(payload) {
  const scopes = [];
  for (const provider of payload.providers || []) {
    const semantics = provider.quotaSemantics || {};
    for (const entry of semantics.effectiveAvailability || []) {
      scopes.push({
        provider: provider.provider,
        plan: provider.plan,
        scope: entry.scope,
        status: entry.status,
        percent_remaining: entry.effectivePercentRemaining,
        spend_priority: entry.selection ? entry.selection.spendPriority : undefined,
        runway_status: entry.runway ? entry.runway.status : undefined,
        runway_seconds: entry.runway ? entry.runway.usableRunwaySeconds : undefined,
        projected_exhausted_at: entry.runway ? entry.runway.projectedExhaustedAt : undefined,
        pace_status: entry.pace ? entry.pace.status : undefined,
        burn_multiple: entry.pace ? entry.pace.burnMultiple : undefined,
        provider_state: provider.state ? provider.state.status : undefined,
        stale: provider.state ? Boolean(provider.state.stale) : undefined
      });
    }
  }
  const providers = (payload.providers || []).map(p => ({
    provider: p.provider, plan: p.plan,
    state: p.state ? p.state.status : 'unknown',
    auth: p.state ? p.state.authStatus : undefined,
    remedy: p.state ? p.state.remedyCommand : undefined
  }));
  return { generated_at: payload.generatedAt, schema_version: payload.schemaVersion, scopes, providers };
}

// Rows a router should prefer first: highest spendPriority among healthy scopes.
function preferred(scopes) {
  return scopes
    .filter(s => s.status !== 'unknown' && typeof s.percent_remaining === 'number' && s.percent_remaining > 0)
    .sort((a, b) => (b.spend_priority ?? -101) - (a.spend_priority ?? -101));
}

module.exports = { read, normalize, preferred, PROVIDERS };
