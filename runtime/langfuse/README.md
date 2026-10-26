# Brain development-session tracing

First-party Pi extension and Claude command hooks. This is development-session telemetry, not instrumentation of an application's own AI requests.

## Privacy boundary

Capture is **metadata-only**, with no content-export switch. Prompts, system/context text, completions, reasoning, tool inputs/results, arbitrary errors, attachments and images are not observation fields. Neither payloads nor their hashes are persisted in tracing checkpoints/outboxes. Native harness transcripts remain the harness's responsibility; this adapter does not remove their local content.

Allowed metadata includes validated project/worktree identities, branch/runtime/agent labels, adopted persona, ticket ID and provenance, harness, model/effort, observed skill names, timing, outcomes, token/cache usage and available costs. Labels must themselves be non-secret identifiers; validation and known-pattern defenses are not an arbitrary-PII guarantee. Do not put task bodies or secrets into names, branches or context identifiers.

`privacy.cjs` is the strict projection used before queueing and again before export. The public Langfuse SDK has masking enabled and media uploads disabled. Authentication is used only for the configured transport, never as observation metadata.

## Opt-in and migration

The brain pull installs these managed resources under `.agent-brain/observability/`; their presence alone does not enable tracing. The authoring repository's native declarations instead point directly to `runtime/langfuse`, selected by its own marker; no generated source copies are needed. `agent-brain pull --langfuse` prepares pinned SDK dependencies in a private lock-fingerprinted user cache and registers:

- Pi: one native project `extensions` file entry. Registering the SDK package directory instead would let Pi install its dependencies during startup.
- Claude: native project command hooks referencing the private, project-gated bootstrap.
- Project marker `.agent-brain/tracing.json`: schema 1, enabled, metadata-only.

Known legacy project exporters are removed/disabled. Conflicting local overrides, direct legacy extension paths and manual Python hooks fail preflight instead of being silently ignored. Existing sessions must restart. Unrelated settings, local permissions, credentials and trust decisions are not replaced.

For old worktree bases missing the adapter, explicitly add `--worktree-bootstrap`. This registers the project-gated Pi bootstrap in native **user** package settings and removes a known legacy user exporter if present. It does not opt unrelated repositories into tracing. Principal-repository opt-in and native project trust are still required. It does not modify old worktree files or grant trust.

Both harnesses honor `BRAIN_TRACING_ENABLED=false` or `LANGFUSE_TRACING_ENABLED=false`. Disable the project marker to disable future automatic discovery. These switches do not disable unrelated third-party exporters.

## Credentials

Credential precedence is one complete tuple, never mixed-source host/key merging:

1. Exported `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`.
2. Private `~/.config/agent-brain/langfuse.json`.
3. Existing private `~/.pi/agent/langfuse.json` compatibility configuration.

JSON keys are `publicKey`, `secretKey`, `baseUrl`. Files must be owner-only regular files (`0600`), not links. HTTPS regional host only. Both adapters use this shared loader independently of cwd and isolated Pi agent directories. No `.env` loading, keychain scraping or credential copying. A partial/invalid higher-priority tuple fails closed. Legacy Claude plugin credential-store entries are not read; configure the shared file or environment yourself, never through agent chat or argv.

## Context and lineage

- `ContextStore` allocates identities before work. Unfinished AGENT roots stay local and are exported with terminal evidence, not as competing ended-span heartbeats; their generations/children may therefore appear before the root finishes. Root prompts have distinct run/trace identities where the adapter supports turns; descendants share the parent's trace/session with distinct AGENT span IDs.
- Disabled, invalid or unreadable tracing declarations stop both direct Pi capture and discovery; a more-specific refusal cannot fall back to an enabled Git root or principal checkout. Marker-absent Pi probes require explicit `-e <runtime>/pi.js --brain-tracing`; the pane helper adds this flag. Resource presence alone grants no consent, and explicit target refusal, native trust refusal and kill switches still win.
- Correlation uses exact native child IDs, session-file aliases, or launch capabilities, never names, timing, nearest processes or arbitrary ambient `TRACEPARENT`.
- Unresolved native children are held before tools. Their records and descendants remain deferred until the exact dispatch response binds them; they are not exported as guessed orphan traces.
- The daemon does not inherit the caller terminal's environment. Stock Pi subagent capture therefore needs discovery in the child plus the shared context store. Explicit Pi/Claude pane launches use `brain-trace.cjs launch`, which prebinds native session/pane identities and supplies native resource arguments.
- Startup acknowledgement, CLI readiness, queueing, transport acceptance and verified server ingestion are different states. An unconfirmed launch must be inspected for approval/startup blockers, not blindly repeated.

Shared state defaults to `~/.cache/agent-brain/tracing-state`, independent of cwd and `PI_CODING_AGENT_DIR`. A custom `BRAIN_TRACE_STATE_DIR` must be identical in every participating launcher, including daemon children; setting it only in the parent breaks that contract.

Use Pi's `brain_context` tool. Claude's startup/prompt/subagent hooks supply a stable local actor capability in `additionalContext`; use that actor's value explicitly (never a parent's):

```bash
node "$HOME/.cache/agent-brain/bootstrap/brain-trace.cjs" context --actor <current-hook-actor> set --persona backend-engineer --ticket TEAM-123
node "$HOME/.cache/agent-brain/bootstrap/brain-trace.cjs" context --actor <current-hook-actor> status
```

Only register an actually adopted persona/established ticket. Unknown attribution stays unknown. An unbound native child may update its own metadata through an exact tool capability, but reports `ancestryPending` and no shared session identity until binding; this never enables premature export. Delivery diagnostics are shared-outbox accounting, not per-actor ingestion proof. Branch-inferred tickets are marked inferred. Successful `Skill` execution/known skill expansion and successful skill-file reads are separate invoked/loaded evidence; installed or persona-permitted skills are not usage evidence. `/brain` is a command, not itself an invoked skill.

## Native authorization and headless fixtures

Tracing does not authorize a context or child command. Claude's repository `.claude/settings.json` allow rules require trust for the repository itself; `--print` skipping the dialog does not activate those grants. Operator-owned, untracked `.claude/settings.local.json` rules have different native trust semantics; tracked files and symlinked `.claude` directories do not receive that exception. See the [native workspace-trust contract](https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust). Use the authorization scope appropriate to your normal workflow, not broader rules or helper overrides. In synthetic headless tests, validate native settings and the untracked/nonsymlink local-policy provenance, then run an identical narrow-prefix native control before claiming traced authorization. Sending a dialog keystroke, successful Read/printf, zero process exit or correct lineage alone does not prove the context command was authorized.

## Reliability limits

Skill attribution keeps at most 32 valid names per invoked/loaded list in an observation (capture retains at most 128). `skillsInvokedStatus` / `skillsLoadedStatus` explicitly report `filtered`, `truncated` or `refused` evidence, survive replay, and carry no arbitrary error text. Capture overflow retains prior evidence; exported truncation is not a complete skill inventory. The 16 KiB observation budget still applies.

Claude hooks currently await a bounded delivery attempt, including tool hooks. Under an outage, this can add per-hook latency; duplicate project/per-run hooks can compound it. The transfer budget is 2.5 seconds with a 3.5-second async guard, **not a universal wall-clock ceiling** for synchronous filesystem/lock work. Outage/load latency has not been measured. Do not remove replay attempts or broaden native permissions to hide latency; diagnose the delivery state instead.

State/outboxes are private and bounded. Enqueue rejection must retain sanitized records rather than count them as queued; export acknowledgement removes only the exact accepted queue version. Queued revisions are coalesced by observation time before replay, and senders are serialized so an older actor snapshot cannot overwrite a newer completion. Delivery is at-least-once with stable IDs, not exactly-once. Raw observation-list APIs may expose multiple revisions of the same ID; do not equate row counts to model calls or add their costs blindly.

Adapter checkpoints and deferred batches share a 2,048-file/32 MiB admission bound, with seven-day retention and conservative reclamation of completed, unreferenced state. Live actors, unresolved descendants and replay dependencies are protected; capacity refusal is not successful capture. Durable deferred suffixes advance after each enqueue, so count/byte-limited queues do not continually replay the same prefix. Historical rebasing preserves the active native turn and the captured model/effort/skill evidence.

Context launch/pending TTL is 24 hours, allowing normal permission/trust pauses without losing exact invocation bindings; expired aliases are tombstoned for another 24 hours. Pane launch scopes bind the expected native session before startup, not merely whichever process first acknowledges the pane. Adapter deferred batches have separate capacity/retention guards and persistent loss indicators. Capacity exhaustion and malformed state are not successful delivery. Queue, flush and context transactions use uniquely named process-identity claims: dead owners recover automatically without deleting a replacement owner's lock, while live/paused owners and unprovable or malformed ownership fail closed. PID reuse is checked against process birth time on supported POSIX hosts. No age-only lock stealing, trust changes or guessed reparenting is permitted. Stop controllers from earlier unreleased draft versions before upgrading their directory-lock protocol.

Capture-order tickets and synchronized pre-send revision floors survive ACK/removal and same-timestamp replay. Their lifetime ledger is capped at 16,384 observation identities/4 MiB and currently has no expiry: exhaustion refuses capture rather than reopening stale replay. Unticketed legacy queue/pending records remain intact and blocked, not assigned guessed chronology. Stop earlier controllers before protocol upgrades; operator-reviewed migration/rotation must not leave live publishers or outstanding replay dependencies behind.

New lock claims require supported process birth identity before publication. Identity-named temporary publications recover only provably dead owners. Live legacy null-birth claims and ambiguous partial legacy temporaries remain conservative failures requiring offline operator inspection, not age-only stealing.

Claude Bash input is never rewritten and hooks do not return permission decisions. Explicit subprocess tracing uses `brain-trace.cjs exec --actor <current-hook-actor> --harness pi|claude [--cwd PATH] -- <native-args>`; pane tracing uses `launch --actor <current-hook-actor> ...`. Pi callers may pass their bound `$BRAIN_TRACE_LAUNCH_ID` explicitly to exec. The helper preserves argv boundaries, stdio and exit/signal semantics without a shell or settings writes, prebinds an exact fresh native session, and refuses session/resource/permission overrides. `exec` accepts a bounded native option subset, not arbitrary passthrough: unknown options, short clusters/attached short values, session selectors, permission grants, settings, plugin/MCP loaders and administrative commands are refused before spawn. Pi option values use split form; Claude long value options also accept `=value`. Claude split `--tools` takes one comma-separated value, followed by another option, native `--`, or end of argv. Native `--` preserves remaining literal prompt arguments; option values are consumed by arity, not scanned for forbidden words. `--allowedTools`/`--allowed-tools`, `--permission-prompt-tool`, `--add-dir` and `--mcp-config` are not accepted caller controls. Configure any ordinary narrow authorization in the target's own native policy; never allow-list the helper broadly. Arbitrary Bash-spawned processes outside this protocol are not promised shared lineage. An opted-in caller can target a trusted marker-absent project explicitly; target refusal and kill switches still win. For a marker-absent caller, use the complete runtime's `brain-trace.cjs`, not the small discovery-only bootstrap cache. Never weaken native allow rules to enable tracing.

Normal abort/error/shutdown hooks are best effort. SIGKILL, indefinitely lagging transcripts, provider-internal calls and unsupported native schemas cannot be promised complete capture. Unknown model labels are omitted; available usage/cost is not proof of a subscription bill. Other harnesses and application runtimes are not covered.

## Verification

Offline suites exercise projections, protocol races, adapters, outbox retries and local synthetic HTTP. Native wiring tests use temporary configuration/trust stores without model calls. Live acceptance requires fetching actual observations after indexing delay and checking positive coverage, IDs/types/nesting, metadata, unique model/tool counts, outcomes, and absence of synthetic canaries/content. Neither a passing test, an empty outbox nor HTTP 200 proves that by itself.
