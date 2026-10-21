# Development-session tracing with Langfuse

**Remediation is still under review.** The [historical live audit](langfuse-audit-2026-10-20.md) found sensitive synthetic content persisted by the official plugins and missing Herdr child observations. This revision replaces those exporters with first-party **metadata-only** adapters. Do not treat the old official-plugin setup, a draft PR, or unit tests as verified protection.

This observes Pi/Claude development sessions, not the consuming application's AI calls. Ordinary brain pulls install resources but do not enable telemetry. The complete policy/protocol lives in [the runtime README](../runtime/langfuse/README.md).

## Install a reviewed revision

Use a revision containing this runtime, **not an older published revision with the leaking official-plugin setup**:

```bash
npx --yes --package=github:akash2991/agent-skills#<reviewed-first-party-commit> agent-brain pull --langfuse
```

Requirements: Node 22+, npm, Pi 1.3.0+, Claude Code 2.1.304+, and a project you have reviewed and chosen to trust. No Python/uv dependency. The installer does not approve project code, pass permission-bypass flags, or alter saved trust decisions.

The flag prepares exact pinned SDK dependencies in a private cache, registers a native Pi **extension file** and native Claude project hooks, writes the non-secret metadata-only opt-in marker, and removes/disables known legacy project exporters. It preserves unrelated settings/hooks/local permissions. Direct legacy extension paths, manual Python hooks and conflicting Claude local overrides require explicit reconciliation instead of an unsafe success message.

Commit the managed brain assets and the project `.pi/settings.json`, `.claude/settings.json`, `.agent-brain/tracing.json` declarations; they contain no credentials. Native settings/marker are not brain-owned prune state. Repeat `--langfuse` to reconcile setup. Ordinary pulls preserve native declarations; dry runs invoke no CLIs or dependency installs. Dependency/native setup follows the brain asset pull and is not a multi-file atomic transaction: failures can leave installed assets or partial registration. Inspect the stated failure and retry; do not assume rollback or delivery.

### Old-base worktrees

To opt into **user-level Pi package registration** for discovery in old worktree bases:

```bash
agent-brain pull --langfuse --worktree-bootstrap
```

This explicitly installs the project-gated bootstrap through native `pi install` and removes a known legacy user exporter if present. It does not enable tracing in unrelated repositories, copy new files into old worktrees, or grant trust. The principal repository must be opted in. Existing sessions in both harnesses must restart.

Herdr daemon panes do not automatically inherit the parent's environment. Use the supported exact launch/binding protocol; see the runtime README and `herdr-fanout`. A ready pane is not evidence that the child exported anything. Surface approval/startup blockers immediately rather than describing an unconfirmed child as running.

## Credentials: once per developer, outside Git

Create an owner-only `0600` regular file at `~/.config/agent-brain/langfuse.json` yourself:

```json
{
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "baseUrl": "https://us.cloud.langfuse.com"
}
```

Use the correct regional HTTPS host. Never paste real values into chat, argv, generated scripts, committed files or review evidence. Existing private `~/.pi/agent/langfuse.json` is a compatibility fallback used by **both** adapters. Alternatively supply the complete exported `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` tuple from your secret manager. A partial higher-priority tuple fails closed; host and keys are not merged across sources.

The installer does not load `.env`, copy credentials, or read Claude's native plugin credential store. Developers previously using only that store must configure the shared file/environment themselves. Teammates configure their own keys and native approvals.

## Attribution and capture

Only validated non-secret identifiers and numeric accounting are exported: canonical project/worktree, runtime name, persona/ticket and provenance, harness, model/effort, invoked/loaded skills, timing/outcomes, token/cache usage and available costs. Prompts, completions, reasoning, tool bodies, arbitrary errors and media are not exported. Do not put sensitive content into identifier labels; metadata validation is not an arbitrary-PII guarantee.

`/brain`/`brain_context` record adopted context, not permitted-skills lists. Unknown fields remain unknown. Native child IDs and exact launch capabilities establish lineage; names, process proximity and ambient `TRACEPARENT` do not. Supported descendants use AGENT nodes with generations/tools under the appropriate actor. Unsupported harnesses, provider-internal calls, and application runtime calls are not covered.

## Disable

Both first-party adapters honor either common kill switch:

```bash
BRAIN_TRACING_ENABLED=false pi
BRAIN_TRACING_ENABLED=false claude
```

Or set the project's marker `enabled` to `false` and restart. These switches do not disable unrelated third-party exporters. Keep legacy exporters disabled when evaluating this policy.

## Verification status

Live synthetic Pi tests on this remediation's working revision fetched actual observations from Langfuse:

- Direct Pi: 6 unique observations — one AGENT, three generations and two tools — with actual model/usage, backend-engineer/ticket attribution, no input/output content and no five injected canaries.
- Pi subprocess child: 12 unique observations in one trace/session, including two correctly nested AGENT nodes and each actor's generations/tools. No injected canaries or configured secret in fetched data; outbox empty after transport completion.
- Native Claude Agent: seven unique nodes, two AGENTs and four actual Opus 5.5 generations, with the Read under the child.
- Herdr daemon pane: twelve unique nodes under exact prebound native session/pane identities, verified after server retrieval rather than readiness alone.
- Both cross-harness directions: Pi→Claude (eleven unique nodes) and Claude→Pi (twelve) shared the correct parent/child trace/session and persona/ticket context.
- Native wiring: isolated principal/old-worktree discovery, legacy factory suppression, repeated setup, ordinary pulls and unrelated settings/trust preservation. No model requests in this suite.

See the [remediation evidence and remaining checks](langfuse-remediation-2026-10-21.md). These do **not** yet certify the stock Herdr worktree path, every resume/persistent/error/abort variant, or the final revision. The remaining live checks and required independent review gate remain outstanding. Slop's main project tracing registration has not been changed; the Pi probes used explicit per-process extension loading and read only synthetic fixtures.

Maintainer checks:

```bash
npm run test:pull
npm run test:langfuse-runtime
npm run test:langfuse-native
```

The runtime tests need the pinned SDK dependencies (`npm ci --prefix runtime/langfuse --ignore-scripts --no-audit --no-fund --legacy-peer-deps`). Native wiring downloads SDKs into temporary configuration/cache stores but makes no model or Langfuse calls. For live acceptance, fetch observations after indexing delay and check positive unique-ID coverage, node types/parentage, model/usage, metadata, outcomes and absent content/canaries. Raw list APIs may expose revisions; row counts are not billed-call counts. Never equate registration, readiness, queueing or transport acceptance with verified ingestion.
