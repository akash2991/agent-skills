# Agent Brain

**An injectable operating brain for agentic coding.** One source of truth becomes the file layout every coding tool expects, so any repository can be run by the same agent organization with the same rules, budgets, and records.

```
                        ┌─────────────────────────────────────────┐
   your request ───────▶│  CEO   admits it, or parks it ranked    │
                        └──────────────────┬──────────────────────┘
                                           ▼
                    PM  ──▶ Principal Engineers ──▶ EM per service
                   (PRD)     (HLD, domain model)    (milestones, sprints,
                                                     model routing)
                                           ▼
                 Staff Engineers · Code Reviewers · Test Engineer · Auditors
                        backend  ·  web  ·  mobile
                                           ▼
                  SQLite control plane: who is running, on which model,
                  how many tokens, how much budget is left
```

Nothing is invoked directly. Every request reaches the CEO, which is the only role that can see the whole budget, the priority order, and how much is already running.

## Quick start

In this repository:

```bash
npm run all                              # validate, select, build every target
npm run inject -- /path/to/your-repo     # install into a repository
```

Then open your coding agent **in that repository** and type the slash command:

```
/brain
```

It claims the CEO role, records the model and effort your session is actually running, prints the current state, and refuses if another terminal already holds the role. Give it a role and an instruction when you want one: `/brain ceo add saved carts`.

`/brain` is a command inside the agent, not a shell command. Project commands are discovered when a session starts, so start a new session in that repository after injecting. The equivalent from a shell, useful for scripts and for harnesses without commands, is:

```bash
node .agent-brain/control-plane/brain.js context --role ceo --harness claude-code \
  --model <your model id> --effort <your effort>
```

## What lands in your repository

| Path | What it is |
|---|---|
| `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/`, `.github/copilot-instructions.md` | The organization as a managed block; your own text outside the markers is kept |
| `.claude/skills/`, `.agents/skills/`, and the other per-tool skill directories | The selected skills plus one per persona |
| `.claude/agents/` and the other per-tool agent directories | The personas as subagents, never the CEO |
| `.agent-brain/control-plane/` | SQLite store, CLI, local UI, and the hooks that capture usage |
| `.agent-brain/ORG.md`, `agents-reports/`, `references/`, `docs/`, `services/` | The rules, report formats, and per-service documents |
| `.claude/settings.json`, `.mcp.json` and their per-tool equivalents | Usage-capture hooks and the Linear and GitHub MCP servers, merged with whatever is already there |

Re-injecting updates what the brain owns and leaves your own state alone.

## The control plane

One SQLite database holds everything that changes while agents work:

```bash
node .agent-brain/control-plane/brain.js status     # tree, budgets, blocked, stale, conflicts
node .agent-brain/control-plane/brain.js budget     # allocated, spent, remaining per holder
node .agent-brain/control-plane/brain.js quota      # what each provider will actually serve
node .agent-brain/control-plane/brain.js serve      # local UI, editable, zero dependencies
```

It records sessions with a single-CEO lock, the agent tree with the model and effort actually in use, token and cost usage per agent and per model, budget allocations with a chain where no child may exceed its parent, and an audit trail of every change. Usage is captured automatically from harness hooks, so tokens and cost are real numbers rather than estimates.

Documents that humans read stay as markdown. State that changes while agents work lives in the database.

## Budgets

The CEO holds the company budget and allocates down the reporting tree; an agent that reaches its allocation stops at a safe point and asks its grantor, and asks bubble up until the CEO asks you.

Prompt caching makes the definition of an input token a real choice, so it is explicit. In a measured session, 40 assistant messages billed 80 fresh input tokens, 767k cache writes, and 29M cache reads. `budget_input_basis` selects `fresh`, `new` (the default: fresh plus cache writes), or `billable` (everything the provider counted), and every component is always shown next to the total.

## Repository layout

```
org/              ordered parts emitted as one always-on ORG.md
agents/           the personas; discipline variants extend a base with `extends:`
agents-reports/   one uniform report template per role
skills/           the flat skill dump; `category:` groups them at build time
control-plane/    SQLite schema, CLI, UI, usage hooks, quota and Herdr adapters
references/       shared checklists and the cross-cutting contracts
templates/        what gets stamped into a project: global docs, service docs, the entry command
scripts/brain/    validate · select · build · inject · import
docs/             brain.md, persona-anatomy.md, skill-anatomy.md
evals/            trigger and routing evals; every skill needs a case
```

Start with [docs/brain.md](docs/brain.md) for how the pieces fit, [docs/persona-anatomy.md](docs/persona-anatomy.md) to add a role, and [docs/skill-anatomy.md](docs/skill-anatomy.md) to add a skill.

## Tools it composes

Built here only where nothing existed. Everything else is borrowed:

| Tool | Role |
|---|---|
| [quota-axi](https://github.com/kunchenguid/quota-axi) | provider quota, pace, runway, and spend priority across Claude, Codex, Cursor, Copilot, Grok, Kimi, Z.AI, OpenCode |
| [Linear](https://linear.app) | the tracker: milestones, sprints, tickets, bugs, blockers, reports |
| [GitHub](https://github.com) | pull requests, reviews, CI/CD, releases |
| [Herdr](https://herdr.dev) | optional control of live agent terminals: focus, steer, interrupt, stop |
| [Langfuse](https://langfuse.com) | optional trace timelines, graphs, and cost dashboards |

The reasoning, including what was evaluated and rejected, is in [references/agent-observability.md](references/agent-observability.md).

## Requirements

Node 22.5 or newer, for the built-in SQLite the control plane uses. No other dependencies.

## Credits

This repository began as a fork of [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) and still uses its skill format, several of its engineering skills, its shared checklists, and its eval framework. Those parts remain MIT licensed under the original copyright; see [LICENSE](LICENSE). The organization, control plane, budgets, and injection pipeline are new work.
