## Agent work observability

The organization stays inspectable while it works. One SQLite control plane holds sessions, the agent registry, observability events, budgets, and an audit trail of every change; `node {{ORG_DIR}}/control-plane/brain.js status` prints it and `brain.js serve` opens a local UI where model, effort, status, and allocations are editable.

- Register before acting, with `--parent` set to whoever assigned the work, so the hierarchy and the budget roll-up are correct. Heartbeat at each meaningful step; a stale heartbeat is reported as stale, never as progress.
- Emit `agent.started`, skill and document loads, turn boundaries, model usage, tool completions, status changes, `budget.changed`, and `agent.completed` through `brain.js event` or `control-plane/emit.js`. If a host hook captures an event authoritatively, do not double-report it.
- A skill or document load event means the artifact entered model context, not merely that a file was read. Record name, path, bytes, hash, and token count with its measurement. Never emit its body.
- Provider and runtime figures win. A missing value is `UNKNOWN`, never zero, and a dashboard never turns a missing event into proof that no work or spend happened.
- Raw prompts, responses, reasoning, system instructions, repository content, tool arguments and results, secrets, credentials, and personal data are not observability payloads.
- Provider quota, pace, runway, and comparative spend priority come from quota-axi (`brain.js quota`, the `quota-axi` skill). It answers what the provider will serve; the budget ledger answers what the organization allocated. Both bind.
- Herdr is the optional runtime control plane. Focus, steer, interrupt, and stop require a `runtime=herdr` binding on the agent's row. Inspect a blocked agent before steering it; interrupt and stop require confirmation, and interrupt comes first. Stopping a whole Herdr session needs separate authorization.
- Langfuse is the trace UI. `brain.js export langfuse` ships the metadata-only events as OTLP spans: one trace per agent, named by role, nested under whoever assigned the work, with model calls as generations carrying token counts and cost. `langfuse_export` decides when (`off`, `session-end`, `turn`), and nothing is sent unless the credentials are set. The local UI answers what is running now; Langfuse answers what happened and what it cost.
- Herdr cannot see subagents, and that is structural: a subagent runs inside its parent's process and has no terminal pane. The hierarchy lives in the control plane and in Langfuse; Herdr controls the terminals you actually started.

Before reporting status, the CEO or EM runs the `delivery-status` skill: refresh the control plane, compare it with the live runtime, git, and the tracker, and label every claim by freshness.
