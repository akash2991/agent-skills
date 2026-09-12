# Agent Observability and Control

This is the architecture decision for complete visibility into Agent Brain work. It was researched against the live project documentation on 2026-09-12 and revised on 2026-09-13 when the store moved to SQLite and quota-axi was adopted.

## Decision

Use a composed stack. Nothing off the shelf models the organization's own semantics (a CEO → PM → EM → engineer tree, a budget chain where a child's allocation cannot exceed its parent's, and per-agent model and effort changeable at runtime), so that part is ours and everything else is borrowed.

1. **quota-axi for provider tokens, quota, and cost.** [quota-axi](https://github.com/kunchenguid/quota-axi) (MIT) reports percent remaining, reset time, burn pace, usable runway, and a comparative `spendPriority` per provider scope across Claude, Codex, Cursor, Copilot, Grok, Kimi, Z.AI, Alibaba, OpenCode, and Antigravity. It reads local credential stores and calls first-party endpoints, and it explicitly does not route. We shell out to it, so it is optional and its absence degrades to `UNKNOWN` rather than failing. This is the authoritative answer to "how much is left on the plan", which no amount of local instrumentation can infer.
2. **A SQLite control plane for the organization semantics.** One database (`control-plane/brain.db`, Node's built-in `node:sqlite`, no dependencies) holds harness sessions with the single-CEO lock, the agent registry with parentage and current model and effort, metadata-only observability events, budget allocations and asks, and an audit trail of every mutation. The CLI and the local UI are two faces of the same store, so an edit in either is the same audited change.
3. **Herdr for runtime control.** Herdr is an Apache-2.0 terminal workspace manager for coding agents. It keeps real agent terminals in persistent panes, recognizes common agents, exposes state, and offers CLI and socket operations to focus, prompt, send keys, read output, wait, and attach. It is the control plane, not the tracker: its own documentation does not claim token, cost, context, skill-load, turn, or tool telemetry, and it has no concept of our hierarchy.
4. **OpenTelemetry GenAI as the interoperability baseline.** Standard agent, workflow, model, and tool concepts and the `gen_ai.usage.*` fields map onto our events; Agent Brain additions use an `agent_brain.*` namespace in exporters.
5. **Langfuse OSS as the optional trace backend.** Self-hostable, accepts OpenTelemetry or custom instrumentation, and gives trace trees, agent graphs, sessions, and token and cost dashboards. It observes executions that send it traces; it cannot focus, prompt, or interrupt a terminal, so it complements Herdr rather than replacing it.

Do not build a terminal runtime, a provider quota reader, or a full web observability platform. The local UI exists only as the zero-dependency view of our own semantics, which none of the borrowed tools can provide.

### Considered and not adopted

**[Mission Control](https://github.com/builderz-labs/mission-control)** (MIT, alpha) is the closest existing fit: a self-hosted control plane with SQLite, a web UI, REST, MCP, and a CLI, covering agent registration, presence, sessions, configuration, cost analysis, and runtime adapters for Claude Code and Codex. It was not adopted as the primary store for three reasons: it is alpha with changing schemas, it needs pnpm and a Next.js service where our constraint is that an injected repository runs with no dependencies, and its task board would compete with the tracker, which is the single source of truth for work. It remains a reasonable **optional fleet UI**: mirror registrations and usage to its REST API (`POST /api/agents/register` and the endpoints in its OpenAPI document) and use its dashboards for agent tracking only, never for tasks.

**[axi](https://github.com/kunchenguid/axi)** is a design framework for agent-native CLIs, not a runtime library, so there is nothing to depend on. Its principles (content-first output, no help banners in normal output, token-efficient formats) are applied to our own CLI instead, and its authoring skill can be imported if agents are asked to write new CLIs.

## Requirement ownership

| Requirement | Owner | Notes |
|---|---|---|
| Provider quota, reset, pace, runway, spend priority | quota-axi | `brain.js quota`. The authoritative account-level figure; degrades to `UNKNOWN` when the CLI is absent. |
| One live CEO across terminals | Control plane | A partial unique index on unreleased `role='ceo'` sessions. A stale heartbeat is reclaimable; a live one refuses with exit 3. |
| Parent/child organization tree | Control plane `agents.parent` | Herdr organizes workspaces, tabs, and panes, not the CEO → PM → EM hierarchy. |
| Current model and effort per agent | Control plane, mutable | Changed by `agent set` or the UI, audited in `changes`; also corrected from observed events. |
| Budget allocation, roll-up, asks, guards | Control plane | Recursive subtree spend over `agents.parent`; allocations exceeding the grantor are refused. |
| Live agents and state | Herdr + control-plane reconciliation | Herdr state is runtime evidence; registry state is reported. Show both when both are available. |
| Jump to an agent | Herdr `agent focus` / attach | Requires `runtime='herdr'` and a `runtime_ref` on the agent's row. |
| Steer an agent | Herdr `agent prompt` | Prompting a blocked agent can be refused by Herdr; inspect it first. |
| Interrupt an agent | Herdr `agent send-keys ... ctrl+c` | Explicit confirmation required; safer than closing the pane. |
| Stop an agent | Herdr `agent get` then `pane close` | Explicit confirmation required; terminates every process in that pane. Whole-session stop is out of scope. |
| Skills and documents used, and their context cost | Control-plane events | Record name, path, bytes, hash, and token count with its measurement, never content. |
| Context input and window | Host or provider hook → event | Exact only when the host exposes it. Otherwise `UNKNOWN`. |
| Turns | Control-plane events | One `turn.completed` per agent turn. |
| Tool calls, failures, duration | Host hook → event | Arguments and results are excluded by design. |
| Model tokens and cost per agent and per model | Provider or runtime → `model.completed` | Provider values win; a calculated cost names its pricing source. |
| Local live view and runtime editing | Control plane UI (`brain.js serve`) | Zero dependencies, loopback only; every edit is an audited mutation. |
| Trace timeline, graph, filtering, retention | Langfuse | Optional export; the local database remains fully usable without it. |
| Hosted fleet dashboards | Mission Control | Optional mirror for agent tracking only; the tracker stays the source of truth for work. |

## Why Herdr is necessary but insufficient

Herdr provides the best match for interactive control because it operates the real coding-agent terminal rather than wrapping the agent SDK. Its automation API supports supported agent kinds including Claude, Codex, Cursor, Kimi, Gemini, OpenCode, and Copilot. It exposes focus, prompt, send-keys, wait, read, session snapshots, and event subscriptions.

Herdr's integrations primarily report lifecycle authority or native session identity. Its metadata tokens are presentation key and value labels, not LLM token accounting. The product documentation does not claim cost, prompt or context composition, skill-load, turn, or tool-call tracing. Those signals come from the control plane's events, provider quota comes from quota-axi, and an optional Langfuse export gives the trace views.

## Why Langfuse is optional rather than the control plane

Langfuse supplies the mature telemetry views that would be wasteful to rebuild: trace trees, agent graphs, sessions, model generations, tool observations, dashboards, token/cost tracking, and self-hosting. Its core is MIT-licensed; enterprise governance features have separate licensing.

Langfuse observes application/agent executions that send it traces. It does not own arbitrary Codex/Claude/Kimi terminal processes and cannot safely focus, prompt, or interrupt those sessions. It complements Herdr.

## Event and trace mapping

| Agent Brain event | OTel/Langfuse representation |
|---|---|
| `agent.started` … `agent.completed` | Agent invocation span; `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name`, `gen_ai.agent.id` where supported. |
| Root orchestration session | Workflow span; `gen_ai.operation.name=invoke_workflow`, `gen_ai.workflow.name=agent_brain_delivery`. |
| `model.completed` | Generation/model span with `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, and cache-token fields. |
| `tool.completed` | Execute-tool span/observation; bounded tool name, outcome, duration, and `error.type`. |
| `skill.loaded` | Span event/observation with `agent_brain.artifact.kind=skill`, name/path/hash/bytes/tokens. |
| `budget.changed` | Span event with `agent_brain.budget.action`, holder, grantor, request id, and the token figures. |
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
- Herdr plugins run as the local user and are not sandboxed; inspect and pin third-party plugin sources before installation.

## Operating flow

1. Claim the session and load the organization with the harness's entry command, which runs `brain.js context`. It refuses if the role is already held by a live session.
2. Register each agent before it acts, with `--parent` set to whoever assigned the work and the model and effort actually in use; bind `runtime` and `runtime_ref` when the harness exposes them.
3. Emit `skill.loaded` and `document.loaded` only when the content actually entered the working context, not when a file was merely read.
4. Emit turn, model-usage, and tool-completion events from runtime or provider measurements. Heartbeat at every meaningful step.
5. Read provider quota before routing or reporting, and record the figures with their read time.
6. Reconcile the control plane against the live runtime, git, and the tracker before claiming any state is current (`delivery-status`).
7. Use the control commands only with a Herdr binding. Inspect a blocked agent before steering it; confirm interrupts and pane-closing stops, and prefer interrupt.
8. Export to Langfuse or another OTLP backend, or mirror to Mission Control, only after the user configures the endpoint and credentials.

## Sources

- Herdr concepts and live agent state: https://herdr.dev/docs/concepts/
- Herdr agent automation and supported agents: https://herdr.dev/docs/agent-automation/
- Herdr CLI control commands: https://herdr.dev/docs/cli-reference/
- Herdr socket API and session snapshots/events: https://herdr.dev/docs/socket-api/
- Herdr integration scope and metadata behavior: https://herdr.dev/docs/integrations/
- Herdr plugin trust model: https://herdr.dev/docs/plugins/
- Herdr source and Apache-2.0 license: https://github.com/herdrdev/herdr
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
