# Agent Observability and Control

This is the architecture decision for visibility into Agent Brain work. It was researched on 2026-09-12, revised on 2026-09-13 when the store moved to SQLite, and revised again on 2026-09-14 when the crew moved to firstmate.

## Decision

Use a composed stack, and build only the part nobody else provides.

1. **firstmate runs and shows the crew.** [firstmate](https://github.com/kunchenguid/firstmate) spawns each role as its own worker in a herdr or tmux pane with its own worktree, sets the harness, model, and effort per task from its crew dispatch profile or a per-task override, supervises and steers the worker, lands its work, and reads provider quota through quota-axi when choosing where to dispatch. Who is running, where, on what, and whether it is stuck is firstmate's crew state. The brain keeps no second copy of any of it.
2. **A SQLite control plane for recorded usage.** One database (`control-plane/brain.db`, Node's built-in `node:sqlite`, no dependencies) holds the metadata-only events that harness hooks capture: tokens including cache and reasoning, cost where reported, turns, tool outcomes, and the skills and documents that entered context. firstmate records none of this, which is why it stays here.
3. **OpenTelemetry GenAI as the interoperability baseline.** Standard agent, workflow, model, and tool concepts and the `gen_ai.usage.*` fields map onto our events; Agent Brain additions use an `agent_brain.*` namespace in exporters.
4. **Langfuse as the trace UI, shipped and wired.** Self-hostable, accepts OpenTelemetry, and gives trace trees, agent graphs, sessions, and token and cost dashboards. This is where a human looks at what happened and what it cost.

Do not build a terminal runtime, a fleet view, a provider quota reader, or a web observability platform. Each already exists in the stack above.

### How the Langfuse export works

`control-plane/langfuse.js` posts OTLP/HTTP JSON straight to `/api/public/otel/v1/traces` with basic auth and the `x-langfuse-ingestion-version: 4` header. The Langfuse SDK is the better choice in an application that already has a package manager; here it would break the zero-install guarantee, and Node's built-in `fetch` is enough.

| Control plane | Langfuse |
|---|---|
| an agent id: a firstmate task id, an explicit `BRAIN_AGENT_ID`, or the harness session | root span, `observation.type=agent`, named by **role** when an event carried one, otherwise by the agent id |
| `parent_agent_id` on an agent's events | `parentSpanId`, when the parent's span is in the same payload |
| `model.completed` | `generation` with model, `usage_details` including cache and reasoning tokens, and cost |
| `tool.completed` | `tool`, named `call-tool: <name>` |
| `turn.completed` | `span` named `run-turn`, with the number in metadata |
| everything else | `event` |

There is no registry: role, parent, ticket, model, effort, and status on the root span are whatever the agent's own events last reported.

Three rules this follows, from Langfuse's own best-practice guidance:

- **Names are an API.** Never the model and never a run-specific value, because every evaluator, dashboard and saved view targets the name. The model lives in its own attribute, the turn number in metadata.
- **Specific observation types.** A generic span renders but tells you less; the type is what drives per-model analytics and the agent graph.
- **Input and output on every observation**, built only from metadata: the assignment on the way in, the status and counts on the way out. The event contract has no field that can carry content, so the privacy boundary holds by construction rather than by discipline.

Span and trace ids are derived from event and agent ids, so a re-export updates the same spans instead of duplicating them. `exports` records what has shipped, so an interrupted run resumes. Automatic shipping is controlled by `langfuse_export` (`off`, `session-end`, `turn`), and nothing leaves the machine unless `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set.

### Attribution

The usage hook attributes each event to `--agent-id` or `BRAIN_AGENT_ID` when set, then to `FM_TASK_ID`, which firstmate exports into every crew pane, and otherwise to `session-<first 8 characters of the harness session id>`. Under firstmate, tokens therefore line up with the task that spent them.

One gap remains: a sidechain turn in a Claude Code transcript is attributed to the session's agent, because the hook cannot tell which child produced it. Roles no longer spawn subagents, so this only affects delegation a harness does on its own.

### History

Herdr was adopted for runtime control on 2026-09-12 and removed on 2026-09-13, because a subagent runs inside its parent's process with no pane to attach to, so the hierarchy was invisible in it. It returned on 2026-09-14 as firstmate's backend: every role is now its own session in its own pane, so the objection no longer applies. The same day, the brain's own session claim, agent registry, quota adapter, and local UI were archived under `deprecated/removed-for-firstmate/`, because firstmate covers each of them.

### Considered and not adopted

**[Mission Control](https://github.com/builderz-labs/mission-control)** (MIT, alpha) is a self-hosted fleet UI with agent registration, presence, and cost analysis. It was not adopted because it needs pnpm and a Next.js service where an injected repository must run with nothing installed, and its task board would compete with the tracker. firstmate now covers the fleet view it would have provided.

**[axi](https://github.com/kunchenguid/axi)** is a design framework for agent-native CLIs, not a runtime library. Its principles (content-first output, no help banners in normal output, token-efficient formats) are applied to our own CLI.

## Requirement ownership

| Requirement | Owner | Notes |
|---|---|---|
| Spawning a role, with its own pane and worktree | firstmate | herdr or tmux backend |
| Harness, model, and effort per task | firstmate crew dispatch profile, or a per-task override | A persona carries none; the hook records what actually ran |
| Running, waiting, stuck, or done | firstmate crew state and fleet view | Label it `REPORTED` unless you checked the pane or branch yourself |
| Steering, supervision, landing | firstmate | |
| Provider quota, reset, pace, runway, spend priority | firstmate, through quota-axi | Consulted when dispatching |
| Skills and documents used, and their context cost | Control-plane events | Record name, path, bytes, hash, and token count with its measurement, never content |
| Context input and window | Host or provider hook → event | Exact only when the host exposes it. Otherwise `UNKNOWN` |
| Turns | Control-plane events | One `turn.completed` per agent turn |
| Tool calls, failures, duration | Host hook → event | Arguments and results are excluded by design |
| Model tokens and cost per agent and per model | Provider or runtime → `model.completed` | Provider values win; a calculated cost names its pricing source |
| Thinking effort and reasoning tokens | Harness → hook → event | Claude Code exposes `CLAUDE_EFFORT` and `output_tokens_details.thinking_tokens`; both are recorded rather than guessed |
| Binding captured usage to a task | `FM_TASK_ID` in the crew pane | Falls back to the harness session |
| Trace timeline, graph, filtering, retention, cost dashboards | Langfuse | `brain.js export langfuse`, automatic per `langfuse_export`. The local database stays fully usable without it |

## Why Langfuse is the UI

Langfuse supplies the mature telemetry views that would be wasteful to rebuild: trace trees, agent graphs, sessions, model generations, tool observations, dashboards, token and cost tracking, and self-hosting. Its core is MIT-licensed; enterprise governance features have separate licensing.

Langfuse observes executions that send it traces. It has no concept of which role or task an execution belonged to, so events carry `role`, `ticket`, and `parent_agent_id` where they are known, and the export projects them as names, metadata, and nesting.

## Event and trace mapping

| Agent Brain event | OTel/Langfuse representation |
|---|---|
| `agent.started` … `agent.completed` | Agent invocation span; `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name`, `gen_ai.agent.id` where supported. |
| `model.completed` | Generation/model span with `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, and cache-token fields. |
| `tool.completed` | Execute-tool span/observation; bounded tool name, outcome, duration, and `error.type`. |
| `skill.loaded` | Span event/observation with `agent_brain.artifact.kind=skill`, name/path/hash/bytes/tokens. |
| `document.loaded` | Span event/observation with `agent_brain.artifact.kind`, path/hash/bytes/tokens. |
| `turn.completed` | Child span with `agent_brain.turn.number`, outcome, duration, and context/window measurements. |
| Parent | Span parent when an agent's events name `parent_agent_id` and the parent was exported; always also `agent_brain.parent_agent_id`. |

OpenTelemetry's GenAI agent conventions are still marked Development. Keep this mapping in one adapter so changes do not leak into personas or dashboards.

## Measurement rules

- `exact`: supplied by the tokenizer/provider/runtime for the actual model request.
- `estimated`: calculated by a named tokenizer or documented approximation. Any view must retain this label.
- `unknown`: the source cannot expose the value. Omit the numeric field.
- Provider-reported billed token counts take precedence over local estimates.
- Provider-reported cost takes precedence; calculated cost requires a versioned pricing source.
- Context contribution counts describe what entered a turn, not merely the bytes read from disk. A file read is not automatically proof it reached the model context.
- A view must never turn missing events into zero usage. An agent with no usage events reports `NO_USAGE_RECORDED`, not `0`.

## Privacy and security defaults

- `content_capture` is `false` and v1 events have no fields for raw prompt, response, reasoning, system instructions, document bodies, tool arguments, or tool output.
- Record stable names, paths relative to the repository, byte counts, SHA-256 hashes, token counts, timings, and outcomes.
- Do not record credentials, environment-variable values, authorization headers, full command output, user PII, or repository content.
- Keep the control-plane database out of git (the injected `.gitignore` does this) and define retention before long-running use. It is live state, not product history.
- OpenTelemetry marks input messages, output messages, system instructions, and tool definitions as opt-in and warns that they can contain sensitive data. Any future content mode requires an explicit user decision, redaction policy, retention limit, and access control.

## Operating flow

1. firstmate dispatches a role into its own session. The injected hooks start capturing usage with no command run.
2. Emit `skill.loaded` and `document.loaded` only when the content actually entered the working context, not when a file was merely read.
3. Turn, model-usage, and tool-completion events come from the hook reading the transcript. Never self-report a number.
4. Read recorded usage with `brain.js status`, and crew state from firstmate. Label each by freshness.
5. Reconcile both against git and the tracker before claiming any state is current (`delivery-status`).
6. Export to Langfuse automatically per `langfuse_export`, or on demand with `brain.js export langfuse`. Nothing leaves the machine until the credentials are set.

## Sources

- firstmate (crew spawning, supervision, dispatch, fleet state): https://github.com/kunchenguid/firstmate
- quota-axi (provider quota, used by firstmate): https://github.com/kunchenguid/quota-axi
- axi design principles for agent-native CLIs: https://github.com/kunchenguid/axi
- Mission Control (considered as an optional fleet UI): https://github.com/builderz-labs/mission-control
