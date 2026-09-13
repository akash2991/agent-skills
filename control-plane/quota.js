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

// Persist a reading so the database records what the account actually had, rather than only what a
// command printed once. A quota figure is only current when just read; the timestamp is what lets a
// later report say `HISTORICAL` honestly instead of implying freshness it does not have.
function snapshot(db, reading) {
  if (!db || !reading || !reading.scopes || !reading.scopes.length) return 0;
  const at = reading.generated_at || new Date().toISOString();
  const insert = db.prepare(`INSERT OR REPLACE INTO provider_quota
    (read_at, provider, scope, plan, status, percent_remaining, spend_priority, runway_status,
     runway_seconds, projected_exhausted_at, pace_status, burn_multiple, provider_state, stale)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const s of reading.scopes) {
    insert.run(at, s.provider, s.scope, s.plan ?? null, s.status ?? null,
      s.percent_remaining ?? null, s.spend_priority ?? null, s.runway_status ?? null,
      s.runway_seconds ?? null, s.projected_exhausted_at ?? null, s.pace_status ?? null,
      s.burn_multiple ?? null, s.provider_state ?? null, s.stale === undefined ? null : (s.stale ? 1 : 0));
  }
  return reading.scopes.length;
}

// The most recent reading per scope, for a report that must not re-run the CLI.
function latest(db) {
  return db.prepare(`SELECT p.* FROM provider_quota p
    JOIN (SELECT provider, scope, MAX(read_at) read_at FROM provider_quota GROUP BY provider, scope) m
      ON m.provider = p.provider AND m.scope = p.scope AND m.read_at = p.read_at
    ORDER BY p.spend_priority DESC`).all();
}

function isSeeded(db) {
  return Boolean(db.prepare('SELECT 1 FROM provider_quota LIMIT 1').get());
}

module.exports = { read, normalize, preferred, snapshot, latest, isSeeded, PROVIDERS };
