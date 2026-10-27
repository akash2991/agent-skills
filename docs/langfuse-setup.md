# Development-session tracing with Langfuse

**Remediation is still under review.** The [historical live audit](langfuse-audit-2026-10-20.md) found sensitive synthetic content persisted by the official plugins and missing Herdr child observations. This revision replaces those exporters with first-party adapters: **metadata-only by default**, or explicitly consented **full-content** with PII retention and best-effort credential redaction. Do not treat the old official-plugin setup, a draft PR, or unit tests as verified protection.

**Do not roll out before the final review gate.** The earlier automatic Bash rewrite broke narrow native allow rules. It has been replaced with explicit actor/context/launch helpers: ordinary commands are unchanged and no permission override is installed. A fresh native Claude 2.1.310 control/traced comparison passed the narrow `Bash(printf *)` rule with zero denials. See the [explicit protocol and reliability limits](../runtime/langfuse/README.md#reliability-limits).

This observes Pi/Claude development sessions, not the consuming application's AI calls. Ordinary brain pulls install resources but do not enable telemetry. The complete policy/protocol lives in [the runtime README](../runtime/langfuse/README.md).

## Install a reviewed revision

Use a revision containing this runtime, **not an older published revision with the leaking official-plugin setup**:

```bash
npx --yes --package=github:akash2991/agent-skills#<reviewed-first-party-commit> agent-brain pull --langfuse
```

Requirements: Node 22+, npm, Pi 1.3.0+, Claude Code 2.1.304+, and a project you have reviewed and chosen to trust. No Python/uv dependency. The installer does not approve project code, pass permission-bypass flags, or alter saved trust decisions.

The flag prepares exact pinned SDK dependencies in a private cache, registers a native Pi **extension file** and native Claude project hooks, writes the non-secret opt-in marker (new opt-ins default to metadata-only), and removes/disables known legacy project exporters. It preserves unrelated settings/hooks/local permissions. Direct legacy extension paths, manual Python hooks and conflicting Claude local overrides require explicit reconciliation instead of an unsafe success message.

Commit the managed brain assets and the project `.pi/settings.json`, `.claude/settings.json`, `.agent-brain/tracing.json` declarations; they contain no credentials. Native settings/marker are not brain-owned prune state. Repeat `--langfuse` to reconcile setup; omission of `--capture-mode` preserves an existing explicit policy and disabled marker. Ordinary pulls preserve native declarations; dry runs invoke no CLIs or dependency installs. Dependency/native setup follows the brain asset pull and is not a multi-file atomic transaction: failures can leave installed assets or partial registration. Inspect the stated failure and retry; do not assume rollback or delivery.

### Explicit full-content consent

Only after reviewing the [complete privacy/storage contract](../runtime/langfuse/README.md#privacy-boundary), choose:

```bash
agent-brain pull --langfuse --capture-mode full-content
```

This captures **available actual prompt/context, response and tool argument/result JSON**, not merely metadata or summaries. It intentionally retains PII such as names, emails, SSNs and ordinary URLs. Credential redaction is best effort using configured literals/common patterns, not a guarantee against unknown/encoded secrets. Private durable checkpoints/deferred batches/outboxes contain content before export; access and retention now matter locally as well as remotely. It never places body content in `ContextStore`, copies credentials or discovers arbitrary secrets.

Full-content uses an explicit schema-2 marker with version-1 capture/redaction policies, `pii:"retain"` and `durableRetry:true`; every consent fact is required. Existing schema-1 markers, ordinary pulls, `--worktree-bootstrap` and the old marker-absent `--brain-tracing` flag do **not** expand consent. Marker-absent full-content exec/launch is not promised. No native permissions or global enablement are added. A disabled marker stays disabled even when a new mode is selected; review and deliberately edit `enabled` to resume it.

Complete canonical observations are capped at **256 KiB**, with a **4 MiB / 256-record outbox** and **1 MiB serialized requests**. No successful prefix/truncation substitutes for full content. Typed input/output statuses distinguish `captured`, `credential_redacted`, `unavailable`, `unsupported` and `refused_size`. Binary/media is unsupported; hidden Claude provider request/system context, hidden reasoning and unexposed native fields are unavailable, not guessed. See the runtime contract for JSON traversal/retention limits.

To select metadata-only explicitly:

```bash
agent-brain pull --langfuse --capture-mode metadata-only
```

This stops new body capture, not immutable retry of previously consented content. There is no retroactive historical-content backfill or remote deletion promise. Use a kill switch to stop delivery too; inspect private local state with controllers stopped when withdrawing consent. Test with `--dry-run` first if you only want to inspect the planned policy; no registration or consent marker is written.

### Old-base worktrees

To opt into **user-level Pi package registration** for discovery in old worktree bases:

```bash
agent-brain pull --langfuse --worktree-bootstrap
```

This explicitly installs the project-gated bootstrap through native `pi install` and removes a known legacy user exporter if present. It does not enable tracing in unrelated repositories, copy new files into old worktrees, or grant trust. The principal repository must be opted in. Existing sessions in both harnesses must restart.

Herdr daemon panes do not automatically inherit the parent's environment. Use the supported exact launch/binding protocol: Claude uses its hook-supplied `--actor` with `brain-trace.cjs launch` for panes or `exec` for subprocesses; Pi may pass its bound tool capability. Ordinary Bash does not automatically establish child lineage. See the runtime README and `herdr-fanout`. A ready pane is not evidence that the child exported anything. Surface approval/startup blockers immediately rather than describing an unconfirmed child as running.

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

In metadata-only mode, only validated non-secret identifiers and numeric accounting are exported: canonical project/worktree, runtime name, persona/ticket and provenance, harness, model/effort, invoked/loaded skills, timing/outcomes, token/cache usage and available costs. Prompt/response/tool bodies are not traversed or exported in that mode. Explicit full-content additionally exports supported available body JSON under the contract above. Identifier labels remain strict non-secret metadata in both modes; intentional body PII retention does not relax label validation.

`/brain`/`brain_context` record adopted context, not permitted-skills lists. Unknown fields remain unknown. Native child IDs and exact launch capabilities establish lineage; names, process proximity and ambient `TRACEPARENT` do not. Supported descendants use AGENT nodes with generations/tools under the appropriate actor. Unsupported harnesses, provider-internal calls, and application runtime calls are not covered.

## Disable

Both first-party adapters honor either common kill switch:

```bash
BRAIN_TRACING_ENABLED=false pi
BRAIN_TRACING_ENABLED=false claude
```

Or set the project's marker `enabled` to `false` and restart to stop future capture/discovery. Marker downgrade/removal/disable does not revoke retry authority on already captured content; either kill switch stops delivery too. Neither change deletes local spooled content or remote records. These switches do not disable unrelated third-party exporters. Keep legacy exporters disabled when evaluating this policy.

## Verification status

The following historical **metadata-only** synthetic tests fetched actual observations from Langfuse; they do not verify the new full-content contract:

- Direct Pi: 6 unique observations — one AGENT, three generations and two tools — with actual model/usage, backend-engineer/ticket attribution, no input/output content and no five injected canaries.
- Pi subprocess child: 12 unique observations in one trace/session, including two correctly nested AGENT nodes and each actor's generations/tools. No injected canaries or configured secret in fetched data; outbox empty after transport completion.
- Native Claude Agent: seven unique nodes, two AGENTs and four actual Opus 5.5 generations, with the Read under the child.
- Herdr daemon pane: twelve unique nodes under exact prebound native session/pane identities, verified after server retrieval rather than readiness alone.
- Both cross-harness directions: Pi→Claude (eleven unique nodes) and Claude→Pi (twelve) shared the correct parent/child trace/session and persona/ticket context.
- Stock Herdr worktree: twelve unique nodes with automatic result delivery, common project/trace/session, distinct worktree IDs and correct completed actor roots.
- Native skill/error/abort: eleven unique nodes, exactly one actual invoked/loaded skill, real missing-file error and aborted AGENT; automatic default-outbox recovery after a terminated probe.
- Native wiring: isolated principal/old-worktree discovery, legacy factory suppression, repeated setup, ordinary pulls and unrelated settings/trust preservation. No model requests in this suite.

See the [remediation evidence and remaining checks](langfuse-remediation-2026-10-21.md). These do **not** certify every resume/persistent/error/abort variant or complete the final-revision review gate. The remaining live checks and required independent review gate remain outstanding. Slop's main project tracing registration has not been changed; the Pi probes used explicit per-process extension loading and read only synthetic fixtures.

Maintainer checks:

```bash
npm run test:pull
npm run test:langfuse-runtime
npm run test:langfuse-native
```

The runtime tests need the pinned SDK dependencies (`npm ci --prefix runtime/langfuse --ignore-scripts --no-audit --no-fund --legacy-peer-deps`). Native wiring downloads SDKs into temporary configuration/cache stores but makes no model or Langfuse calls. For live acceptance, fetch observations after indexing delay and check positive unique-ID coverage, node types/parentage, model/usage, metadata and outcomes. Metadata-only requires absent body content/canaries; full-content requires positive actual prompt/response/tool coverage, retained synthetic PII, redacted credential canaries and honest missing/unsupported/size statuses. Fresh native full-content verification remains outstanding, not established by the historical evidence. Raw list APIs may expose revisions; row counts are not billed-call counts. Never equate registration, readiness, queueing or transport acceptance with verified ingestion.
