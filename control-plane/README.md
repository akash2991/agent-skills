# Control Plane

One SQLite database holds **recorded agent-work usage**: the metadata-only events harness hooks capture (tokens, cache traffic, cost, turns, tool outcomes, skills and documents loaded) and which of them have been shipped to Langfuse. Durable **documents** stay as markdown: `ORG.md`, `CONVENTIONS.md`, `DECISIONS.md`, and the service `HLD.md`/`LLD.md`.

Node 22.5 or newer, no dependencies: the store is Node's built-in `node:sqlite`.

## What is not here

The crew runs under [firstmate](https://github.com/kunchenguid/firstmate), which already owns these, so the brain does not duplicate them:

| Concern | Owner |
|---|---|
| Spawning a role as a worker, in its own pane and worktree | firstmate, on the herdr or tmux backend |
| Which harness, model, and effort a worker runs | firstmate's crew dispatch profile, or a per-task override |
| Who is running, waiting, stuck, or done | firstmate's crew state and fleet view |
| Steering a worker, supervising it, landing its work | firstmate |
| Provider quota and choosing a model by it | firstmate, through quota-axi |

The session claim, the agent registry, the quota adapter, and the local UI that used to cover these are archived under `deprecated/removed-for-firstmate/`. Running one of their old commands prints a pointer instead of failing silently.

## Usage capture

Nothing needs to be run by hand. The injected harness hooks call `hook.js` on session start, after each tool, at each turn end, and at session end. It reads the transcript, records one `model.completed` and one `turn.completed` per assistant message it has not seen, and never double-counts: ids are derived from the message, so a replay or a double-fired hook adds nothing.

Usage is attributed, in order, to `--agent-id` or `BRAIN_AGENT_ID` when set, then to `FM_TASK_ID`, which firstmate exports into every crew pane, and otherwise to `session-<first 8 of the harness session id>`. Under firstmate, tokens therefore line up with the task that spent them.

```bash
node brain.js status            # usage by agent and session, newest first, and whether tracing is on
node brain.js status --json
```

## Observability events

```bash
node brain.js event --event '{"schema_version":"1.0","type":"model.completed","agent_id":"t-42","session_id":"s","usage":{"input_tokens":1200,"output_tokens":300,"cost_usd":0.05,"source":"provider"}}'
node emit.js --stdin            # equivalent, for host hooks
```

The contract is `event.schema.json`: metadata only. Raw prompts, responses, reasoning, document bodies, tool arguments, and tool output are not representable. A missing value is `UNKNOWN`, never zero. Event types: `agent.started`, `agent.status_changed`, `agent.completed`, `skill.loaded`, `document.loaded`, `turn.started`, `turn.completed`, `model.completed`, `tool.completed`. An event may carry `role`, `parent_agent_id`, and `ticket`; the Langfuse export uses them to name and nest traces.

## Langfuse

```bash
node brain.js export langfuse [--limit N] [--all] [--dry-run]
node brain.js config set --key langfuse_export --value off|session-end|turn
```

Exported automatically per `langfuse_export` (default `turn`) once `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set in the environment, a `.env` in the project or any directory above it, or `~/.agent-brain/.env`. Nothing leaves the machine without them. See `../references/agent-observability.md` for the mapping and the privacy rules.

## Files

| File | Role |
|---|---|
| `schema.sql` | the events and exports tables, plus config |
| `db.js` | open and migrate, config, and the per-agent usage summary with its input basis |
| `brain.js` | the CLI: status, event, export, config |
| `emit.js` | event validation and ingestion, shared with hooks |
| `hook.js` | turning harness transcripts and tool calls into events, idempotently |
| `langfuse.js` | Langfuse OTLP export adapter |
| `event.schema.json` | the metadata-only event contract |
