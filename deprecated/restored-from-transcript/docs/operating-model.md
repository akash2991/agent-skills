# Delivery Operating Model

This optional extension combines accountable product leadership, durable delivery
state, specialist personas, and this repository's SDLC skills. It provides one
consistent working model across projects without loading every detailed workflow
into every session.

## Layers

| Layer | Purpose | Installed where |
|---|---|---|
| Global instructions | Persistent CEO/captain behavior and non-negotiable working agreements | User-level agent configuration |
| Project instructions | Stack, commands, boundaries, defaults, and state protocol for one repository | Project root |
| Skills | Executable workflows with steps, checks, and exit criteria—the **how** | Installed through this skill pack |
| Personas | Focused roles, perspectives, and report contracts—the **who** | Installed through this persona pack |
| Commands | User-facing lifecycle entry points and safe orchestration | Harness-specific command locations |
| Control plane | Durable project state, stories, agents, blockers, decisions, usage, and handoff | Project repository |

## One-Time Setup

1. Install this repository as a skill/plugin pack using the appropriate guide under `docs/`.
2. Merge the [global instruction template](../templates/operating-model/global/AGENTS.md) into your agent's user-level instruction file.
3. Start a new agent session and ask it to list the instruction sources it loaded.

For Codex, the verified global location is `~/.codex/AGENTS.md` unless `CODEX_HOME` points elsewhere. Codex reads the global file first, then project `AGENTS.md` files from repository root toward the working directory, with closer project guidance taking precedence. See the [official OpenAI AGENTS.md documentation](https://developers.openai.com/codex/guides/agents-md).

For other harnesses, use their user-level rules mechanism. Keep this file as the canonical content and avoid maintaining divergent hand-edited copies when a symlink or managed synchronization is available.

## Per-Project Setup

Copy or merge the contents of the [project template](../templates/operating-model/project/) into a project root.

Do not overwrite an established project blindly:

1. Inspect its existing `AGENTS.md`, `CLAUDE.md`, rules files, tracker, architecture docs, and CI commands.
2. Merge compatible rules into the existing convention.
3. Use the existing task tracker if it already provides equivalent durable state; record the mapping in `.agents/README.md`.
4. Fill the project-specific placeholders before implementation.
5. Keep stack defaults only where the project has not already decided differently.

The minimum useful adoption is:

```text
AGENTS.md
CONSTRAINTS.md
.agents/PROJECT_STATE.md
.agents/CURRENT_MILESTONE.md
.agents/BLOCKERS.md
.agents/DECISIONS.md
.agents/HANDOFF.md
```

Add the full story, execution, usage, and architecture artifacts for multi-story, multi-session, or multi-agent work.

## Operating Model

```text
User
  ↓
Main agent as CEO/captain
  ├── Product Manager
  ├── Technical Program Manager
  ├── Principal Engineer
  ├── Engineering Manager
  ├── Staff / Frontend / Backend Engineers
  └── Test Engineer acting as independent QA

DEFINE → PLAN → BUILD → VERIFY → REVIEW → SHIP
   │        │       │        │        │       │
   └──────────── durable project control plane ─┘
```

The main agent selects or invokes personas. Personas never invoke other personas. Personas may use applicable skills.

## Governance Skills

- `project-captaincy` — runs the accountable product-delivery loop and routes to existing SDLC skills.
- `delivery-visibility` — refreshes and reports truthful project, agent, blocker, model, token, time, and cost state.

Existing skills continue to own specification, planning, implementation, testing, debugging, review, security, documentation, git, and shipping.

## Repository Integration

- [Global instruction template](../templates/operating-model/global/AGENTS.md) — persistent operating contract.
- [Project template](../templates/operating-model/project/) — project-local instructions and durable control plane.
- [Conflict register](operating-model-conflicts.md) — explicit reconciliation decisions.
- [`project-captaincy`](../skills/project-captaincy/SKILL.md) and [`delivery-visibility`](../skills/delivery-visibility/SKILL.md) — governance workflows.
- [`agents/`](../agents/) — installable specialist personas.
- [`references/orchestration-patterns.md`](../references/orchestration-patterns.md) — supported composition patterns.

## Maintenance Rule

When a new preference conflicts with an existing rule, update the
[conflict register](operating-model-conflicts.md) and the canonical repository
artifact. Source material used to derive this extension remains external guidance,
not part of the distributable operating model.
