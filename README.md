# Agent Brain

**An injectable operating brain for agentic coding.** One source of truth becomes the file layout every coding tool expects, so any repository can be run by the same agent personas, enforcing the same conventions, working from the same skills.

```
   you ──▶ /brain-pm            a request becomes a ticket, then a refined idea,
                                a spec, or a PRD, whichever you pick

   you ──▶ /brain-pe-backend    a PRD becomes a design: domain model, interfaces, plan
           /brain-pe-web

   you ──▶ /brain-em            a design becomes milestones and ready tickets

   you ──▶ /brain-swe-backend   one ticket, story or bug, becomes a pull request
           /brain-review-backend · /brain-qa · /brain-security · /brain-webperf

   each role does one step, then hands back and names what could run next.
   it never invokes the next one. you decide what runs, and what to skip.
```

There is no entry point. You invoke whichever role the work needs, in any order. A bug can go straight to an engineer with no PRD and no design step.

## Quick start

In this repository:

```bash
npm run all                              # validate, select, build every target into build/product/
npm run inject -- /path/to/your-repo     # install into a repository
```

Then open your coding agent **in that repository** and invoke whichever role the work needs:

```
/brain-pm      turn a request into a ticket, then a refined idea, a spec, or a PRD
/brain-em      turn an approved design into milestones and ready tickets
/brain-swe-backend   build one ticket, story or bug, with tests and a pull request
/brain-review-backend   review a pull request
/brain-qa      verify a story independently
```

There is no entry point and no order you must follow. Each command confirms which model and thinking effort to run at, asks for the inputs its persona declares, does one step, and hands back naming what should run next. It never invokes the next role itself.

Every command is namespaced `brain-`, so it cannot collide with a command from another tool. Commands are discovered when a session starts, so start a new session after injecting.

**Codex differs in two ways.** Custom prompts are namespaced, so the command is `/prompts:brain-pm`, and they are read only from `$CODEX_HOME/prompts` (default `~/.codex/prompts`), never from a repository. Injection installs them there for you and retires any `brain-*` command it no longer produces, leaving files it does not own alone. Pass `--no-install-commands` to manage that directory yourself. Restart Codex afterwards. Skills and `AGENTS.md` need no such step, because Codex scans `.agents/skills` up from the working directory.

| Harness | How you invoke a role |
|---|---|
| Claude Code, Cursor, Gemini CLI, OpenCode, Copilot | `/brain-pm` |
| Codex | `/prompts:brain-pm`, after a restart |

The equivalent from a shell, useful for scripts and for harnesses without commands, is:

```bash
node .agent-brain/control-plane/brain.js context --role ceo --harness claude-code \
  --model <your model id> --effort <your effort>
```

## What lands in your repository

| Path | What it is |
|---|---|
| `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/`, `.github/copilot-instructions.md` | The organization as a managed block; your own text outside the markers is kept |
| `.claude/skills/`, `.agents/skills/`, and the other per-tool skill directories | The selected skills plus one per persona |
| `.claude/agents/` and the other per-tool agent directories | The personas as subagents, for when you approve delegation |
| `.agent-brain/control-plane/` | SQLite store, CLI, local UI, and the hooks that capture usage |
| `.agent-brain/ORG.md`, `agents-reports/`, `references/`, `docs/`, `services/` | The rules, report formats, and per-service documents |
| `.claude/settings.json`, `.mcp.json` and their per-tool equivalents | Usage-capture hooks and the Linear and GitHub MCP servers, merged with whatever is already there |

Re-injecting updates what the brain owns and leaves your own state alone.

## The control plane

One SQLite database holds everything that changes while agents work:

```bash
node .agent-brain/control-plane/brain.js status     # tree, blocked, stale, path conflicts
node .agent-brain/control-plane/brain.js quota      # what each provider will actually serve
node .agent-brain/control-plane/brain.js serve      # local UI, editable, zero dependencies
node .agent-brain/control-plane/brain.js export langfuse   # ship traces, tokens and cost to Langfuse
```

The local UI answers "what is running right now" and deliberately stays minimal. For trace timelines, agent graphs, filtering, retention and cost dashboards, export to **Langfuse**: set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` (a `.env` file is read too) and the control plane posts OTLP spans with no dependency to install. Each agent becomes a trace named by its role, nested under the agent that assigned it, with model calls as generations carrying real token counts and cost. `langfuse_export` controls when it ships: `off`, `session-end` (default), or `turn`.

Events are metadata only, so nothing you or an agent wrote can leave the machine through this path.

It records sessions, the agent tree with the model and effort actually in use, token and cost usage per agent and per model, provider quota snapshots, and an audit trail of every change. Usage is captured automatically from harness hooks, so tokens and cost are real numbers rather than estimates.

Documents that humans read stay as markdown. State that changes while agents work lives in the database.


## Repository layout

```
org/              ordered parts emitted as one always-on ORG.md
agents/           the personas; discipline variants extend a base with `extends:`
agents-reports/   one uniform report template per role
skills/           the flat skill dump; `category:` groups them at build time
control-plane/    SQLite schema, CLI, UI, usage hooks, quota and Langfuse adapters
references/       shared checklists and the cross-cutting contracts
templates/        what gets stamped into a project: global docs, service docs, the entry command (every command is named brain-*)
scripts/brain/    validate · select · build · inject · import
docs/             brain.md, persona-anatomy.md, skill-anatomy.md
evals/            trigger and routing evals; every skill needs a case
build/            everything generated: the two selections and build/{product,self}/<tool>/
```

Start with [docs/brain.md](docs/brain.md) for how the pieces fit, [docs/persona-anatomy.md](docs/persona-anatomy.md) to add a role, and [docs/skill-anatomy.md](docs/skill-anatomy.md) to add a skill.

## Tools it composes

Built here only where nothing existed. Everything else is borrowed:

| Tool | Role |
|---|---|
| [quota-axi](https://github.com/kunchenguid/quota-axi) | provider quota, pace, runway, and spend priority across Claude, Codex, Cursor, Copilot, Grok, Kimi, Z.AI, OpenCode |
| [Linear](https://linear.app) | the tracker: milestones, sprints, tickets, bugs, blockers, reports |
| [GitHub](https://github.com) | pull requests, reviews, CI/CD, releases |
| [Langfuse](https://langfuse.com) | trace timelines, agent graphs, and cost dashboards; the recommended UI |

The reasoning, including what was evaluated and rejected, is in [references/agent-observability.md](references/agent-observability.md).

## Requirements

Node 22.5 or newer, for the built-in SQLite the control plane uses. No other dependencies.

## Credits

This repository began as a fork of [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) and still uses its skill format, several of its engineering skills, its shared checklists, and its eval framework. Those parts remain MIT licensed under the original copyright; see [LICENSE](LICENSE). The organization, control plane, and injection pipeline are new work.
