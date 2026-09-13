# Orchestration Patterns

Reference catalog of agent orchestration patterns this repo endorses, plus anti-patterns to avoid. Read this before adding a new slash command that coordinates multiple personas, or before introducing a new persona that "wraps" existing ones.

The governing rule in this repository: **the CEO session is the only orchestrator. Nothing is invoked directly, and personas do not invoke other personas.** Every request reaches the CEO, which admits it with a budget and an owner or parks it as a prioritized ticket (`request-intake`), because budget, org-level priority, and how much runs in parallel cannot be judged from inside a single task. Skills are mandatory hops inside a persona's workflow.

The patterns below are the shapes the CEO may compose. Pattern 1 is kept for what it teaches about cost, but in this organization even a single-perspective request arrives through the CEO rather than straight from the user.

---

## Endorsed patterns

### 1. Single persona, single perspective

One persona, one perspective, one artifact. The cheapest shape, and the one to compare everything else against.

```
user → CEO (admits, allocates) → code-reviewer → report → CEO → user
```

**Use when:** the work is one perspective on one artifact and you can describe it in one sentence. The CEO hop is not ceremony: it is where the budget is allocated and the request is ranked against what is already running.

**Examples:**
- "Review this PR" → `code-reviewer`
- "Find security issues in `auth.ts`" → `security-auditor`
- "What tests are missing for the checkout flow?" → `test-engineer`

**Cost:** one round trip. The baseline you should always compare orchestrated patterns against.

---

### 2. The session entry command

One command, `/brain`, claims a role for the session and loads the organization. It is the only user-facing command, because a command that starts a specialist directly would bypass the CEO's budget and priority decisions.

```
/brain → claims the role in the control plane → loads ORG.md, the persona, current state → ready
```

**Use when:** every session start.

**Cost:** one command run plus the state read.

**Anti-signal:** a new command that starts a persona or a skill. That is the thing this organization deliberately does not have; route the request through the CEO instead.

---

### 3. Parallel fan-out with merge

Multiple personas operate on the same input concurrently, each producing an independent report. A merge step (in the main agent's context) synthesizes them into a single decision.

```
                          ┌─→ backend-code-reviewer ─┐
CEO → fan out (one change)┼─→ security-auditor       ─┤→ merge → go/no-go + rollback
                          └─→ test-engineer          ─┘
```

**Use when:**
- The sub-tasks are genuinely independent (no shared mutable state, no ordering dependency)
- Each sub-agent benefits from its own context window
- The merge step is small enough to stay in the main context
- Wall-clock latency matters

**Example:** the CEO admitting a pre-merge gate fans out the discipline code reviewer, `security-auditor`, and `test-engineer` on one change, then merges their verdicts.

**Cost:** N parallel sub-agent contexts + one merge turn. Higher than direct invocation, but faster wall-clock and produces better reports because each sub-agent stays focused on its single perspective.

**Validation checklist before adopting this pattern:**
- [ ] Can I run all sub-agents at the same time without ordering issues?
- [ ] Does each persona produce a different *kind* of finding, not just the same finding from a different angle?
- [ ] Will the merge step fit in the main agent's remaining context?
- [ ] Is the user's wait time long enough that parallelism is actually noticeable?

If any answer is "no," fall back to direct invocation or a single-persona command.

---

### 4. Sequential lifecycle coordination

Dependent lifecycle phases run in a defined order, carrying durable artifacts and
commit history between them. The user drives the sequence by default:

```
CEO: intake → spec → PRD → design → design review → milestones → sprints → build → review → QA → ship
```

When the user explicitly delegates an end-to-end multi-story outcome, the main

```
user → main session as captain → focused persona/skill → durable artifact → next phase
```

The main session remains accountable and invokes each focused persona directly.
It is not a persona, and no persona invokes the next persona.

**Use when:** the workflow has dependencies and either human judgment between
steps adds value or the user has explicitly delegated lifecycle continuity.

**Examples in this repo:** the entire DEFINE → PLAN → BUILD → VERIFY → REVIEW →
SHIP lifecycle; the brain organization ([docs/brain.md](../docs/brain.md)) for
delegated multi-story delivery, where the CEO session is the captain.

**Cost:** user-driven sequencing has no extra orchestration context. Delegated
captaincy adds main-session coordination and state-maintenance cost, justified when
the user values continuity, visibility, and a single accountable interface.

**Guardrails for delegated captaincy:** keep handoffs in project files, preserve
human gates that affect product direction or authority, avoid paraphrasing-only
persona hops, and use a single agent when delegation costs more than it saves.

---

### 5. Research isolation (context preservation)

When a task requires reading large amounts of material that shouldn't pollute the main context, spawn a research sub-agent that returns only a digest.

```
main agent → research sub-agent (reads 50 files) → digest → main agent continues
```

**Use when:**
- The main session needs to stay focused on a downstream task
- The investigation result is much smaller than the input it consumes
- The decision quality benefits from the main agent having room to think after

**Examples:** "Find every call site of this deprecated API across the monorepo," "Summarize what these 30 ADRs say about caching."

**Cost:** one isolated sub-agent context. Worth it any time the alternative is loading hundreds of files into the main context.

**On Claude Code, use the built-in `Explore` subagent** rather than defining a custom research persona. `Explore` runs on Haiku, is denied write/edit tools, and is purpose-built for this pattern. Define a custom research subagent only when `Explore` doesn't fit (e.g. you need a domain-specific system prompt the model wouldn't infer).

---

## Claude Code compatibility

This catalog is harness-agnostic, but most readers will run it on Claude Code. Here's how each pattern maps onto Claude Code's primitives — and where the platform enforces our rules for us.

### Where personas live

Personas are injected into the project as subagent files (`.claude/agents/` for Claude Code, and the equivalent for each other harness), so they are discovered without any path configuration. The CEO is never emitted as a subagent: it is the main session.

### Subagents vs. Agent Teams

Claude Code has two parallelism primitives. Pattern 3 (parallel fan-out with merge) maps to **subagents**. If you need teammates that talk to each other, use **Agent Teams** instead.

| | Subagents | Agent Teams |
|--|-----------|-------------|
| Coordination | Main agent fans out, sub-agents only report back | Teammates message each other, share a task list |
| Context | Own context window per subagent | Own context window per teammate |
| When to use | Independent tasks producing reports | Collaborative work needing discussion |
| Status | Stable | Experimental — requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` |
| Cost | Lower | Higher — each teammate is a separate Claude instance |

**The personas work in both modes.** When spawned as subagents by the CEO session, they report findings back to it. When spawned as teammates (`Spawn a teammate using the security-auditor agent type…`), they can challenge each other's findings directly. The persona definition is the same; only the spawning context changes.

One subtlety: the `skills` and `mcpServers` frontmatter fields in a persona are honored when it runs as a subagent but **ignored when it runs as a teammate** — teammates load skills and MCP servers from your project and user settings, the same as a regular session. If a persona depends on a specific skill or MCP server being loaded, configure it at the session level so it's available in both modes.

### Platform-enforced rules

Two rules in this catalog aren't just convention — Claude Code enforces them:

- **"Subagents cannot spawn other subagents"** (verbatim from the docs). Anti-pattern B (persona-calls-persona) and Anti-pattern D (deep persona trees) cannot exist on Claude Code by construction.
- **"No nested teams"** — teammates cannot spawn their own teams. Same anti-patterns blocked at the team level.

This means you can adopt the patterns in this catalog without worrying about contributors accidentally building the anti-patterns. They'll just fail to load.

### How the brain organization maps onto these primitives

- The CEO session is the delegated captain (Pattern 4). Personas (PM, EM, PEs, engineers, reviewers, test engineer, auditors) are subagents or teammates; none invokes another.
- The EM's model routing is a **decision**, not a router persona (Anti-pattern A): it has domain value (tier, budget, review path) and produces an assignment packet. Because subagents cannot spawn subagents, the CEO session **executes** that decision by spawning the persona with the packet's `model/effort` pair, verbatim. On a harness that allows nested spawning the EM would execute its own decision; in a single-session tool the session applies the pair before playing the role. The build renders the applicable mode into `ORG.md` and the `model-routing` skill.
- Code review, security audit, and QA on one change are independent and fan out in parallel with a merge in the CEO session (Pattern 3); the merge gate itself is the discipline code reviewer's verdict.
- Every hand-off is an assignment packet in the tracker, never a paraphrase (Anti-pattern C); orchestration depth stays at one (Anti-pattern D).

### Built-in subagents to know about

Before defining a custom subagent, check whether one of these covers the role:

| Built-in | Purpose |
|----------|---------|
| `Explore` | Read-only codebase search and analysis. Use this for Pattern 5 (research isolation). |
| `Plan` | Read-only research during plan mode. |
| `general-purpose` | Multi-step tasks needing both exploration and modification. |

Don't redefine these. Layer your specialist personas (code-reviewer, security-auditor, test-engineer) on top of them.

### Frontmatter restrictions for plugin agents

Plugin subagents do **not** support the `hooks`, `mcpServers`, or `permissionMode` frontmatter fields — these are silently ignored. If a future persona needs any of those, the user must copy the file into `.claude/agents/` or `~/.claude/agents/` instead.

The fields that DO work in plugin agents are: `name`, `description`, `tools`, `disallowedTools`, `model`, `maxTurns`, `skills`, `memory`, `background`, `effort`, `isolation`, `color`, `initialPrompt`. Use `model` per-persona if you want to optimize cost (e.g. Haiku for `test-engineer` coverage scans, Sonnet for `code-reviewer`, Opus for `security-auditor`).

### Spawning multiple subagents in parallel

In Claude Code, parallel fan-out (Pattern 3) requires issuing **multiple Agent tool calls in a single assistant turn**. Sequential turns serialize execution, so a CEO fanning out a pre-merge gate must spawn all of the reviewers in one turn.

---

## Worked example: Agent Teams for competing-hypothesis debugging

This example shows when to reach for **Agent Teams** instead of a subagent fan-out. The two patterns look similar from a distance — both spawn the same three personas — but the value comes from a different place.

### The scenario

> *Checkout occasionally hangs for ~30 seconds before completing. It happens roughly once every 50 sessions. No errors in logs. Started after last week's release.*

Plausible root causes (mutually exclusive, all fit the symptoms):

1. A race condition in the new payment-confirmation flow
2. An auth check that occasionally falls through to a slow synchronous network call
3. A missing index on a query that scales with cart size
4. A flaky third-party API where the SDK retries silently before timing out

A single agent will pick the first plausible theory and stop investigating. A a subagent fan-out would have each persona report independently — but their reports never meet, so nothing rules out the wrong theories.

This is exactly the case the Agent Teams docs describe: *"With multiple independent investigators actively trying to disprove each other, the theory that survives is much more likely to be the actual root cause."*

### Why this is not a fan-out job

| | Fan-out (subagents) | Agent Teams |
|--|--------------------|-------------|
| Sub-agents see | The same diff, different lenses | A shared task list, each other's messages |
| Output | Three independent reports → one merge | Adversarial debate → consensus root cause |
| Right when | You want a verdict on a known artifact | You want to *find* the artifact among hypotheses |

A fan-out produces a verdict; Agent Teams produces an investigation.

### Setup (one-time, per-environment)

Agent Teams is experimental. In `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

Requires Claude Code v2.1.32 or later. The personas in this repo are picked up automatically — no team-config files to author by hand.

### The trigger prompt

Type into the lead session, in natural language:

```
Users report checkout hangs for ~30 seconds intermittently after last
week's release. No errors in logs.

Create an agent team to debug this with competing hypotheses. Spawn
three teammates using the existing agent types:

  - code-reviewer  — investigate race conditions and blocking calls
                     in the checkout code path
  - security-auditor — investigate auth checks, session handling,
                       and any synchronous network calls added recently
  - test-engineer  — propose tests that would distinguish between the
                     hypotheses and check coverage gaps in checkout

Have them message each other directly to challenge each other's
theories. Update findings as consensus emerges. Only converge when
two teammates agree they can disprove the others'.
```

The lead spawns three teammates referencing the existing persona names. The persona body is **appended** to each teammate's system prompt as additional instructions (on top of the team-coordination instructions the lead installs); the trigger prompt above becomes their task.

### What happens

1. Each teammate runs in its own context window, exploring the codebase from its own lens.
2. Teammates use `message` to send findings to each other directly. The lead doesn't have to relay.
3. The shared task list shows who's investigating what — visible at any time with `Ctrl+T` (in-process mode) or in a tmux pane (split mode).
4. When `code-reviewer` finds a `Promise.all` that should be sequential, it messages `security-auditor` to confirm the auth call isn't part of the race. `security-auditor` checks and replies — either confirming the race is the real issue or producing counter-evidence.
5. `test-engineer` proposes a focused integration test for whichever theory is winning, which the team uses to verify before declaring consensus.
6. The lead synthesizes the converged finding and presents it to you.

You can interrupt at any teammate by cycling with `Shift+Down` and typing — useful for redirecting an investigator who's gone down a wrong path.

### When to clean up

When the investigation lands on a root cause, tell the lead:

```
Clean up the team
```

Always cleanup through the lead, not a teammate (per the docs: teammates lack full team context for cleanup).

### Cost expectation

Three teammates running for ten to fifteen minutes of investigation costs noticeably more than the same three personas spawned as subagents, and it comes out of a real allocation, so the CEO admits it deliberately. The justification is quality of conclusion: for production debugging where the wrong fix is expensive, the extra tokens are a bargain. For a routine review, use the fan-out.

### Anti-pattern in this scenario

Do **not** rebuild this as a `/debug` slash command that fans out subagents. Subagents can't message each other — you'd lose the adversarial debate that makes the pattern work. If a workflow keeps coming up, record the trigger prompt in the CEO's intake notes rather than wrapping it in a command that misuses subagents.

### When *not* to use Agent Teams

- Production-bound verdict on a known diff → a CEO-admitted fan-out of subagents.
- One specialist perspective on one artifact → direct persona invocation.
- Sequential lifecycle (spec → design → build) → the CEO session driving the phases (Pattern 4).
- Read-heavy research with a small digest → built-in `Explore` subagent.

Reach for Agent Teams only when teammates **need** to challenge each other to produce the right answer.

---

## Anti-patterns

### A. Router persona ("meta-orchestrator")

A persona whose only job is to decide which other persona to call. Note the difference from the CEO: the CEO decides *whether work happens at all*, at what priority, and against which budget, which is a decision with consequences. A router that only forwards adds a hop and loses context.

```
/work → router-persona → "this needs a review" → code-reviewer → router (paraphrases) → user
```

**Why it fails:**
- Pure routing layer with no domain value
- Adds two paraphrasing hops → information loss + roughly 2× token cost
- The requester already knew they wanted a review; the CEO can route it to the reviewer in one hop
- Replicates the work that slash commands and intent mapping in `AGENTS.md` already do

**What to do instead:** let the CEO route the request. Intent-to-skill mapping belongs in the skill descriptions, which is what makes them discoverable.

---

### B. Persona that calls another persona

A `code-reviewer` that internally invokes `security-auditor` when it sees auth code.

**Why it fails:**
- Personas were designed to produce a single perspective; chaining them defeats that
- The summary the calling persona passes loses context the called persona needs
- Failure modes multiply (which persona's output format wins? whose rules apply?)
- Hides cost from the user

**What to do instead:** have the calling persona *recommend* a follow-up audit in its report. The user or a slash command runs the second pass.

---

### C. Sequential orchestrator that paraphrases

An agent that calls `/spec`, then `/plan`, then `/build`, etc. on the user's behalf.

**Why it fails:**
- Loses the human checkpoints that catch wrong-direction work
- Each hand-off summarizes context — accumulated drift over a long pipeline
- Doubles token cost: orchestrator turn + sub-agent turn for every step
- Removes user agency at exactly the points where judgment matters most

**What to do instead:** keep the CEO accountable for the sequence, with the human gates that affect product direction intact.

---

### D. Deep persona trees

The CEO calls a `pre-ship-coordinator` that calls a `quality-coordinator` that calls a code reviewer.

**Why it fails:**
- Each layer adds latency and tokens with no decision value
- Debugging becomes a multi-level investigation
- The leaf personas lose context to multiple summarization steps

**What to do instead:** keep the orchestration depth at most 1 (slash command → personas). The merge happens in the main agent.

---

## Decision flow

When considering a new orchestrated workflow, walk this flow:

```
Is the work one perspective on one artifact?
├── Yes → Direct invocation. Stop.
└── No  → Will the same composition repeat?
         ├── No  → Direct invocation, ad hoc. Stop.
         └── Yes → Are sub-tasks independent?
                  ├── No  → Sequential slash commands run by user (Pattern 4).
                  └── Yes → Parallel fan-out with merge (Pattern 3).
                           Validate against the checklist above.
                           If any check fails → fall back to single-persona command (Pattern 2).
```

---

## When to add a new pattern to this catalog

Add a new entry only after:

1. You've used the pattern at least twice in real work
2. You can name a concrete artifact in this repo that demonstrates it
3. You can explain why an existing pattern wouldn't have worked
4. You can describe its anti-pattern shadow (what people will mistakenly build instead)

Premature catalog entries become aspirational documentation that no one follows.
