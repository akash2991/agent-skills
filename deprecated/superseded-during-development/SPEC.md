# Spec: Agent Work Observatory

## Objective

Add an injectable, local-first observability surface for the agent organization. A user must be able to see the live agent hierarchy, inspect which skills and documents each agent used, understand context/turn/tool/model usage and cost when the runtime exposes it, and safely focus, steer, interrupt, or stop a live agent.

The first usable release composes existing open-source systems instead of replacing them:

- Herdr is the recommended runtime and control plane for persistent agent terminals and focus/prompt/interrupt operations.
- Agent Brain emits a vendor-neutral JSONL event stream aligned with OpenTelemetry GenAI concepts.
- The injected local dashboard summarizes that stream together with the file-backed registry.
- Langfuse is an optional self-hosted trace UI and long-term store; later adapters may export the same events elsewhere.

Exact prompt, response, and document content is not captured by default. Unknown runtime data is reported as `UNKNOWN`, never inferred and presented as exact.

## Tech Stack

- Node.js 18+ with built-in modules only for the local emitter and dashboard.
- JSON Schema Draft 2020-12 for the event contract.
- JSON Lines for append-only local event storage.
- OpenTelemetry GenAI semantic conventions as the portability baseline.
- Herdr (Apache-2.0) as the optional local runtime/control plane.
- Langfuse OSS (MIT core) as the optional trace UI/backend.

## Commands

- Validate sources: `npm run validate`
- Run observability tests: `npm run test:observability`
- Build all injectable targets: `npm run all`
- Inspect generated output: `node dist/codex/.agent-brain/observability/dashboard.js --json`
- Emit an event in an injected repository: `node .agent-brain/observability/emit.js --event '<json>'`
- Show the local dashboard: `node .agent-brain/observability/dashboard.js` (add `--watch` for a live view)
- Open it as an opt-in Herdr tab: `herdr plugin link .agent-brain/observability && herdr plugin pane open --plugin agent-brain.observatory --entrypoint dashboard`

## Project Structure

- `templates/observability/` — injected event contract, emitter, dashboard, configuration, and operator guide.
- `templates/registry/` — durable agent identity, hierarchy, runtime binding, and current reported state.
- `scripts/brain/` — build/inject validation and tests for the observability assets.
- `references/agent-observability.md` — researched architecture, backend decision, event semantics, privacy, and runtime capability matrix.
- `skills/observability-and-instrumentation/` — workflow rules that require agent-work telemetry as well as product telemetry.
- `agents/` and `templates/org/` — persona obligations to register runtime identity and emit lifecycle/skill/context/tool/turn events.

## Code Style

Use dependency-free CommonJS, pure functions for parsing and aggregation, explicit validation at the CLI boundary, and machine-readable output for automation.

```js
function aggregateEvents(events) {
  return events.reduce((summary, event) => {
    summary.turns += event.type === 'turn.completed' ? 1 : 0;
    return summary;
  }, { turns: 0 });
}
```

## Testing Strategy

- Use `node:test` and `node:assert/strict`; no new dependency.
- Unit-test event validation, append/read behavior, hierarchy construction, and usage aggregation.
- Integration-test the dashboard against a temporary registry and JSONL event file.
- Exercise Herdr controls only through explicit CLI commands; tests use an injected command runner and never touch a live session.
- Run the repository validator and full brain build after focused tests pass.

## Boundaries

- Always: preserve parent-child identity; distinguish reported from runtime-verified state; label unavailable telemetry `UNKNOWN`; record control attempts; use exact provider token/cost data when available.
- Ask first: installing or starting Herdr/Langfuse, enabling content capture, adding a network exporter, or stopping a whole Herdr session.
- Never: log secrets or raw credentials; capture prompts/responses/document bodies by default; estimate exact billable tokens or cost without a named method/source; claim Herdr supplies telemetry it does not expose; make control commands silently destructive.

## Success Criteria

- An injected target contains a documented event schema, append-only emitter, zero-dependency dashboard, and opt-in Herdr pane manifest.
- The dashboard renders agents as a parent-child tree and aggregates per-agent turns, tool calls/failures, skills, documents, context tokens/bytes, model tokens, cost, and elapsed time.
- JSON output exposes the same data for future web/TUI adapters and clearly lists unavailable fields.
- Registry entries can bind an organization agent to a runtime session/agent reference.
- `focus`, `steer`, `interrupt`, and `stop` actions delegate to Herdr only when a runtime binding exists; interrupt and stop require confirmation, and unsupported actions fail safely.
- The architecture document explains why Herdr + OpenTelemetry-aligned events + optional Langfuse was selected and which requirements each part does and does not cover.
- Focused tests, repository validation, and all target builds pass.

## Open Questions

- Host-specific automatic capture of exact context composition and token usage varies. The first release accepts hook/adapter events and self-reported events; per-host collectors can be added without changing the event contract.
- A browser UI is deferred until real usage proves the local dashboard plus Langfuse and Herdr surfaces insufficient.
