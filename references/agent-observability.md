# Agent Observability and Control

This is the architecture decision for complete visibility into Agent Brain work. It was researched against the live project documentation on 2026-09-12 and revised on 2026-09-13 when the store moved to SQLite and quota-axi was adopted.

## Decision

Use a composed stack. Nothing off the shelf models the organization's own semantics (the user → PM → EM → engineer tree, and per-agent model and effort changeable at runtime), so that part is ours and everything else is borrowed.

1. **quota-axi for provider tokens, quota, and cost.** [quota-axi](https://github.com/kunchenguid/quota-axi) (MIT) reports percent remaining, reset time, burn pace, usable runway, and a comparative `spendPriority` per provider scope across Claude, Codex, Cursor, Copilot, Grok, Kimi, Z.AI, Alibaba, OpenCode, and Antigravity. It reads local credential stores and calls first-party endpoints, and it explicitly does not route. We shell out to it, so it is optional and its absence degrades to `UNKNOWN` rather than failing. This is the authoritative answer to "how much is left on the plan", which no amount of local instrumentation can infer.
2. **A SQLite control plane for the organization semantics.** One database (`control-plane/brain.db`, Node's built-in `node:sqlite`, no dependencies) holds harness sessions, the agent registry with parentage and current model and effort, metadata-only observability events, provider quota snapshots, and an audit trail of every mutation. The CLI and the local UI are two faces of the same store, so an edit in either is the same audited change.
3. **No terminal control.** Controlling live agent terminals was tried with Herdr and removed; see "Terminal control, tried and dropped" below. Nothing replaces it, because the question it answered was not the one the organization needs answered.
4. **OpenTelemetry GenAI as the interoperability baseline.** Standard agent, workflow, model, and tool concepts and the `gen_ai.usage.*` fields map onto our events; Agent Brain additions use an `agent_brain.*` namespace in exporters.
5. **Langfuse as the trace UI, shipped and wired.** Self-hostable, accepts OpenTelemetry or custom instrumentation, and gives trace trees, agent graphs, sessions, and token and cost dashboards. This is where a human looks at what happened and what it cost; the local page only answers what is running right now.

Do not build a terminal runtime, a provider quota reader, or a full web observability platform. The local UI exists only as the zero-dependency view of our own semantics, which none of the borrowed tools can provide; it answers "what is happening right now", and nothing more should be invested in it.

### How the Langfuse export works

`control-plane/langfuse.js` posts OTLP/HTTP JSON straight to `/api/public/otel/v1/traces` with basic auth and the `x-langfuse-ingestion-version: 4` header. The Langfuse SDK is the better choice in an application that already has a package manager; here it would break the zero-install guarantee, and Node's built-in `fetch` is enough.

| Control plane | Langfuse |
|---|---|
| an agent, plus its ancestors | root span, `observation.type=agent`, named by **role** so the name stays stable |
| `agents.parent` | `parentSpanId`, which is what draws the organization as an agent graph |
| `model.completed` | `generation` with model, `usage_details` including cache and reasoning tokens, and cost |
| `tool.completed` | `tool`, named `call-tool: <name>` |
| `turn.completed` | `span` named `run-turn`, with the number in metadata |
| everything else | `event` |

Three rules this follows, from Langfuse's own best-practice guidance:

- **Names are an API.** Never the model and never a run-specific value, because every evaluator, dashboard and saved view targets the name. The model lives in its own attribute, the turn number and agent id in metadata.
- **Specific observation types.** A generic span renders but tells you less; the type is what drives per-model analytics and the agent graph.
- **Input and output on every observation**, built only from metadata: the assignment on the way in, the status and counts on the way out. The event contract has no field that can carry content, so the privacy boundary holds by construction rather than by discipline.

Span and trace ids are derived from event and agent ids, so a re-export updates the same spans instead of duplicating them. `exports` records what has shipped, so an interrupted run resumes. Automatic shipping is controlled by `langfuse_export` (`off`, `session-end`, `turn`), and nothing leaves the machine unless `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set.

### Terminal control, tried and dropped

Herdr was adopted for runtime control (focus, steer, interrupt, stop) and removed on 2026-09-13 by the owner's decision. The reason is structural: Herdr manages terminal panes and the agent processes inside them, and a subagent runs inside its parent's process with no pane to attach to. The hierarchy the organization cares about was therefore invisible in it, and no configuration would have changed that.

Nothing replaced it. Terminal control is out of scope. Subagents are visible where they were always going to be visible: in the control plane, because they register, and in Langfuse, where each is a trace nested under its parent. The archived adapter and the reasoning are in `deprecated/removed-integrations/`.

One gap remains: a sidechain turn in a Claude Code transcript is attributed to the session's agent, because the hook cannot tell which registered child produced it. Per-subagent token attribution is therefore `UNKNOWN` until the harness exposes the child's identity in the transcript.

### Considered and not adopted

**[Mission Control](https://github.com/builderz-labs/mission-control)** (MIT, alpha) is the closest existing fit: a self-hosted control plane with SQLite, a web UI, REST, MCP, and a CLI, covering agent registration, presence, sessions, configuration, cost analysis, and runtime adapters for Claude Code and Codex. It was not adopted as the primary store for three reasons: it is alpha with changing schemas, it needs pnpm and a Next.js service where our constraint is that an injected repository runs with no dependencies, and its task board would compete with the tracker, which is the single source of truth for work. It remains a reasonable **optional fleet UI**: mirror registrations and usage to its REST API (`POST /api/agents/register` and the endpoints in its OpenAPI document) and use its dashboards for agent tracking only, never for tasks.

**[axi](https://github.com/kunchenguid/axi)** is a design framework for agent-native CLIs, not a runtime library, so there is nothing to depend on. Its principles (content-first output, no help banners in normal output, token-efficient formats) are applied to our own CLI instead, and its authoring skill can be imported if agents are asked to write new CLIs.

## Requirement ownership

| Requirement | Owner | Notes |
|---|---|---|
| Provider quota, reset, pace, runway, spend priority | quota-axi | `brain.js quota`. The authoritative account-level figure; degrades to `UNKNOWN` when the CLI is absent. |
| Parent/child organization tree | Control plane `agents.parent` | Reproduced as span nesting in Langfuse, so the organization renders as an agent graph. |
| Current model and effort per agent | Control plane, mutable | Changed by `agent set` or the UI, audited in `changes`; also corrected from observed events. |
| Skills and documents used, and their context cost | Control-plane events | Record name, path, bytes, hash, and token count with its measurement, never content. |
| Context input and window | Host or provider hook → event | Exact only when the host exposes it. Otherwise `UNKNOWN`. |
| Turns | Control-plane events | One `turn.completed` per agent turn. |
| Tool calls, failures, duration | Host hook → event | Arguments and results are excluded by design. |
| Model tokens and cost per agent and per model | Provider or runtime → `model.completed` | Provider values win; a calculated cost names its pricing source. |
| Local live view and runtime editing | Control plane UI (`brain.js serve`) | Zero dependencies, loopback only; every edit is an audited mutation. |
| Trace timeline, graph, filtering, retention, cost dashboards | Langfuse | `brain.js export langfuse`, automatic per `langfuse_export`. The local database stays fully usable without it. |
| Thinking effort and reasoning tokens | Harness → hook → event | Claude Code exposes `CLAUDE_EFFORT` and `output_tokens_details.thinking_tokens`; both are recorded rather than guessed. |
| Binding captured usage to a role | `sessions.harness_session_id` | A hook only knows the harness's session id. Without the binding, usage lands on a synthetic agent instead of the role that spent it. |
| Hosted fleet dashboards | Mission Control | Optional mirror for agent tracking only; the tracker stays the source of truth for work. |

## Why Langfuse is the UI rather than the control plane

Langfuse supplies the mature telemetry views that would be wasteful to rebuild: trace trees, agent graphs, sessions, model generations, tool observations, dashboards, token/cost tracking, and self-hosting. Its core is MIT-licensed; enterprise governance features have separate licensing.

Langfuse observes executions that send it traces. It has no concept of the user → PM → EM tree or of which role was playing at the time, which is why that stays in the control plane and is projected into Langfuse as span nesting and metadata.

## Event and trace mapping

| Agent Brain event | OTel/Langfuse representation |
|---|---|
| `agent.started` … `agent.completed` | Agent invocation span; `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name`, `gen_ai.agent.id` where supported. |
| Root orchestration session | Workflow span; `gen_ai.operation.name=invoke_workflow`, `gen_ai.workflow.name=agent_brain_delivery`. |
| `model.completed` | Generation/model span with `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, and cache-token fields. |
| `tool.completed` | Execute-tool span/observation; bounded tool name, outcome, duration, and `error.type`. |
| `skill.loaded` | Span event/observation with `agent_brain.artifact.kind=skill`, name/path/hash/bytes/tokens. |
| `document.loaded` | Span event/observation with `agent_brain.artifact.kind`, path/hash/bytes/tokens. |
| `turn.completed` | Child span with `agent_brain.turn.number`, outcome, duration, and context/window measurements. |
| `control.completed` | Span event with action, target, outcome, and actor identity when available. |
| Organization parent | Span parent when execution nesting matches; always also `agent_brain.parent_agent_id`. |

OpenTelemetry's GenAI agent conventions are still marked Development. Keep this mapping in one adapter so changes do not leak into personas, registry files, or dashboards.

## Measurement rules

- `exact`: supplied by the tokenizer/provider/runtime for the actual model request.
- `estimated`: calculated by a named tokenizer or documented approximation. The UI must retain this label.
- `unknown`: the source cannot expose the value. Omit the numeric field.
- Provider-reported billed token counts take precedence over local estimates.
- Provider-reported cost takes precedence; calculated cost requires a versioned pricing source.
- Context contribution counts describe what entered a turn, not merely the bytes read from disk. A file read is not automatically proof it reached the model context.
- A dashboard must never turn missing events into zero usage. A holder with no usage events reports `NO_USAGE_RECORDED`, not `0%`.
- Provider quota is a burn-down against a reset clock: a figure is current only when just read, and `HISTORICAL` afterwards.

## Privacy and security defaults

- `content_capture` is `false` and v1 events have no fields for raw prompt, response, reasoning, system instructions, document bodies, tool arguments, or tool output.
- Record stable names, paths relative to the repository, byte counts, SHA-256 hashes, token counts, timings, and outcomes.
- Do not record credentials, environment-variable values, authorization headers, full command output, user PII, or repository content.
- Keep the control-plane database out of git (the injected `.gitignore` does this) and define retention before long-running use. It is live state, not product history.
- OpenTelemetry marks input messages, output messages, system instructions, and tool definitions as opt-in and warns that they can contain sensitive data. Any future content mode requires an explicit user decision, redaction policy, retention limit, and access control.

## Operating flow

1. Claim the session and load the organization with the harness's entry command, which runs `brain.js context`. It refuses if the role is already held by a live session.
2. Register each agent before it acts, with `--parent` set to whoever assigned the work and the model and effort actually in use.
3. Emit `skill.loaded` and `document.loaded` only when the content actually entered the working context, not when a file was merely read.
4. Emit turn, model-usage, and tool-completion events from runtime or provider measurements. Heartbeat at every meaningful step.
5. Read provider quota before routing or reporting, and record the figures with their read time.
6. Reconcile the control plane against git and the tracker before claiming any state is current (`delivery-status`).
7. Export to Langfuse automatically per `langfuse_export`, or on demand with `brain.js export langfuse`. Nothing leaves the machine until the credentials are set.

## Sources

- quota-axi (provider quota, pace, runway, spend priority): https://github.com/kunchenguid/quota-axi
- axi design principles for agent-native CLIs: https://github.com/kunchenguid/axi
- Mission Control (considered as an optional fleet UI): https://github.com/builderz-labs/mission-control
- Node.js built-in SQLite: https://nodejs.org/api/sqlite.html
- OpenTelemetry GenAI agent/workflow semantics: https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md
- Langfuse observability capabilities: https://langfuse.com/docs
- Langfuse trace-tree guidance: https://langfuse.com/docs/observability/best-practices
- Langfuse agent graphs: https://langfuse.com/docs/observability/features/agent-graphs
- Langfuse token and cost tracking: https://langfuse.com/docs/observability/features/token-and-cost-tracking
- Langfuse self-hosting: https://langfuse.com/self-hosting
