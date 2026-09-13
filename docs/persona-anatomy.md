# Persona Anatomy

Every member of the organization is a persona: one file in `agents/<name>.md`. Personas listed in `manifest.json` form the organization; abstract bases are never emitted. Every file in `agents/` follows this anatomy, including the specialist reviewers and auditors that the slash commands also use. A persona is the *who*: it says what the role owns, how it communicates, what it may do, and which skills it may use. Skills are the *how* and live in `skill-dump/`.

## Frontmatter (required)

```yaml
---
name: staff-engineer                      # lowercase-hyphen; equals the file name
command: brain-swe                        # the command that invokes this role; always brain-<something>
description: <what the role does>. Use when <trigger>.   # third person, then "Use when"
skills: test-driven-development, lld, escalation, linear   # the ONLY skills this persona may use
---
```

`skills` is validated: every name must resolve to a selected skill in `manifest.json` (the flat `skills/` dump), and the build lists them in the persona body. A persona must not invoke a skill it does not list.

A persona carries **no model and no effort**. Any agent may run any model at any thinking effort: the engineering manager chooses per task from complexity, the remaining budget allocation, and live provider quota (`model-routing`), the spawner passes that choice to the harness, and the control plane records what actually ran. The linter rejects `model`, `effort`, and `allowed` in frontmatter so a per-persona allowlist cannot creep back. Current policy: planning and coding personas (principal engineers, engineering manager, staff engineers) default to `claude-fable-5-1` at `high`; every other persona defaults to `claude-opus-5` at `high`. Change the policy by editing the base personas; specializations inherit.

Every persona is a specialist: its `## Authorization` ends with a refusal of work outside its Role. A task no persona covers is a hiring request to the CEO (`references/hiring.md`), never an improvised assignment.

## Sections (required, in this order)

| Section | Answers |
|---|---|
| `## Role` | One paragraph: who this is and what it owns. |
| `## Responsibilities` | Bullet list of what the role is accountable for. |
| `## Goals` | What "good" looks like for this role, as outcomes. |
| `## Inputs` | Exactly what the coordinator must supply before this role can start. The role asks for these and never guesses one. |
| `## Output` | The structured result the role ends with, and what should be invoked next. This is the whole handover: there is no separate protocol section, because the protocol is the same for every role and lives in the org rules. |
| `## Success Criteria` | Measurable checks the role is judged on. |
| `## Tools` | Tool access: tracker, repository, shell, subagents, external services. |
| `## Authorization` | Three lists: may do alone, must ask (and whom), never. |
| `## Way of Working` | Numbered, repeatable process for a unit of work. |
| `## Quality Non-negotiables` | Rules this role never trades away. |
| `## Skills` | The skills from the frontmatter with one line on when each is used. |
| `## Composition` | How this persona enters the work: which command reaches it, and the rule that it never invokes another persona and hands its output back to the coordinator. |
| `## Red Flags` | Observable signs the persona is off-track. |

## Optional sections

Add these only when the role needs them; put them after `## Skills` and before `## Composition`.

| Section | Use for |
|---|---|
| `## Discipline` | Discipline-specific rules of a specialization (backend, web, mobile). |
| `## Framework` | A fixed review or audit lens: the axes or scope checked every time, and the severity scale. Reviewer and auditor personas carry one. |
| `## Operating Modes` | Distinct modes with different evidence (for example quick source scan versus measured audit). |

When a new persona needs a structure or sub-field not covered here, add it to this document first; the anatomy is the contract every persona is linted against.

## Specializations with `extends`

Engineers and reviewers are split by discipline: `backend-`, `web-` (React), and `mobile-` (React Native) principal engineers, staff engineers, and code reviewers. A specialization is a short file that extends a base persona:

```yaml
---
name: web-staff-engineer
description: ...Use when...
extends: staff-engineer            # base persona; its frontmatter and sections are inherited
skills: test-driven-development, end-to-end-testing, frontend-ui-engineering, escalation, linear   # replaces the base list
---
# Web Staff Engineer            # replaces the base title
## Role                         # a section with the same heading replaces the base section
## Discipline                   # a new heading is inserted before Red Flags
## Skills
```

Base personas carry `abstract: true` and are never emitted; only the specializations are. Selection is by name in `manifest.json` (`personas`). Frontmatter keys not set by the child (`model`, `effort`) come from the base. Linting runs on the resolved persona, so a child only needs the sections it changes.

## How personas are emitted per tool

- Tools with subagents (Claude Code, Gemini CLI, OpenCode, Copilot): one subagent file per persona except the CEO, who is always the main session.
- Every tool: one skill directory per persona so a single session can adopt the role.
- `model` and `effort` feed subagent frontmatter where the tool supports it and are stripped elsewhere.
