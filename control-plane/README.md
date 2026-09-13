# Control Plane

One SQLite database holds every piece of **mutable runtime state** for the organization: harness sessions, the agent registry, observability events, provider quota snapshots, and an audit trail of every change. Durable **documents** stay as markdown: `ORG.md`, `CONVENTIONS.md`, `DECISIONS.md`, and the service `HLD.md`/`LLD.md`. State that changes while agents work lives here; text that humans read and review lives there.

Node 22.5 or newer, no dependencies: the store is Node's built-in `node:sqlite`.

## Start a session

One command claims a role, records the session's own model and effort as that role's current values, and prints the whole state:

```bash
node .agent-brain/control-plane/brain.js context \
  --role ceo --harness claude-code --model <your model id> --effort <your effort>
```

It exits 3 and refuses if another live session already holds the role, so a second terminal cannot become a second CEO. A session whose heartbeat is older than `session_stale_minutes` (default 30) is reclaimable.

```bash
node brain.js session heartbeat --id <session>    # while you work
node brain.js session release   --id <session>    # when you stop
node brain.js session list
```

## Agents

```bash
node brain.js agent register --agent-id staff-ENG-42-1 --role backend-staff-engineer \
     --parent em-api-1 --ticket ENG-42 --model <id> --effort <level> --paths "backend/orders/**"
node brain.js agent heartbeat --agent-id staff-ENG-42-1 --operation "implementing refund endpoint"
node brain.js agent set --agent-id staff-ENG-42-1 --model <id> --effort <level> --reason "re-routed: T3"
node brain.js agent set --agent-id staff-ENG-42-1 --status BLOCKED --blocker B-ENG-42-1
node brain.js agent close --agent-id staff-ENG-42-1 --result DONE
node brain.js agent list ; node brain.js agent tree
```

Registration reports any path conflict with another running agent. There is no per-persona model allowlist: any agent may run any model at any effort, chosen by the coordinator when the role is invoked.


## Observability events

```bash
node brain.js event --event '{"schema_version":"1.0","type":"model.completed","agent_id":"staff-ENG-42-1","session_id":"s","usage":{"input_tokens":1200,"output_tokens":300,"cost_usd":0.05,"source":"provider"}}'
node .agent-brain/control-plane/emit.js --stdin   # equivalent, for host hooks
```

The contract is `event.schema.json`: metadata only. Raw prompts, responses, reasoning, document bodies, tool arguments, and tool output are not representable. A missing value is `UNKNOWN`, never zero. Event types: `agent.started`, `agent.status_changed`, `agent.completed`, `skill.loaded`, `document.loaded`, `turn.started`, `turn.completed`, `model.completed`, `tool.completed`, `control.completed`.

**Nothing emits these automatically.** Until a host hook is wired, token, cost, and context figures stay `UNKNOWN` and the provider view below is the reliable number.

## Provider quota, tokens, and cost

[quota-axi](https://github.com/kunchenguid/quota-axi) (MIT) reports plan quota, pace, runway, and a comparative `spendPriority` per provider scope across Claude, Codex, Cursor, Copilot, Grok, Kimi, Z.AI, OpenCode, Alibaba, and Antigravity. It is a CLI, so we shell out to it; it is optional and its absence degrades to `UNKNOWN`.

```bash
node brain.js quota                  # normalized rows plus a routing preference
npx -y quota-axi --tui               # live human dashboard
npm i -g quota-axi                   # avoid the npx fetch each call
```

It reads local credential stores and calls first-party provider endpoints. It reports figures and never routes; the EM routes.

## UI

```bash
node brain.js serve            # http://127.0.0.1:4173
```

Loopback only, zero dependencies. Shows the agent tree with status, model, effort, tokens, cost and heartbeat; provider quota; spend by model; which skills and documents entered context and their token cost; tool calls and failures; what needs attention; and the audit trail. Model, effort, status, and operation are editable, and every edit is the same audited mutation as the CLI.


## Optional external views

| Tool | What it adds | How |
|---|---|---|
| [quota-axi](https://github.com/kunchenguid/quota-axi) | plan quota, pace, runway, spend priority | already wired; `--tui` for a live view |
| [Langfuse](https://langfuse.com) | trace timelines, agent graphs, sessions, cost dashboards | export events through an OTLP adapter; opt-in |
| [Mission Control](https://github.com/builderz-labs/mission-control) | a hosted fleet UI | mirror registrations and usage to its REST API; alpha, and its task board is not used because the tracker is the source of truth for work |

See `../references/agent-observability.md` for the architecture decision, the OpenTelemetry GenAI field mapping, and the privacy rules.

## Files

| File | Role |
|---|---|
| `schema.sql` | tables, indexes, and the partial unique index that enforces one live CEO |
| `db.js` | open/migrate, config, audit, and the recursive subtree spend query |
| `state.js` | read side: agent tree, path conflicts, combined status |
| `brain.js` | the CLI (context, session, agent, budget, quota, status, event, control, serve, config) |
| `emit.js` | event validation and ingestion, shared with host hooks |
| `quota.js` | quota-axi adapter |
| `langfuse.js` | Langfuse OTLP export adapter |
| `server.js` + `ui.html` | local UI and JSON API |
| `event.schema.json` | the metadata-only event contract |
