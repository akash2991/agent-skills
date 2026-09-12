# agent-brain

This repository is the **source** of an injectable agent organization. It is not a project the organization runs; it is what gets injected into projects that the organization then runs. Read that distinction before changing anything: the rules here describe how to build the brain, not how to deliver a feature with it.

> Working on a repository that has the brain **installed**? Then `.agent-brain/ORG.md` is your operating contract, `/brain` claims your role, and nothing here applies. This file is for developing the brain itself.

`Goal.md` holds the owner's running requirements, numbered by update. It is the specification of record. Never edit it.

## What produces what

```
org/         ──┐
agents/      ──┤
skills/      ──┼──▶ scripts/brain/{validate,select,build} ──▶ dist/<tool>/ ──▶ inject ──▶ a project
control-plane/ ┤
templates/   ──┘
```

Edit the sources. `build/` and `dist/` are generated and git-ignored; never hand-edit them, and never edit an emitted `ORG.md`.

| Source | Holds | Emitted as |
|---|---|---|
| `org/NN-*.md` | the always-on organization, as ordered parts | one `ORG.md` plus the managed block in each tool's always-on file |
| `agents/*.md` | personas; discipline variants use `extends:` | a skill per persona, and a subagent file where the tool has them (never the CEO) |
| `skills/<name>/SKILL.md` | the flat skill dump; `category:` only groups the output | one directory per selected skill |
| `agents-reports/*.md` | one uniform report per role | `.agent-brain/agents-reports/` |
| `control-plane/` | SQLite schema, CLI, UI, usage hooks, adapters | `.agent-brain/control-plane/` |
| `references/*.md` | shared checklists and cross-cutting contracts | `.agent-brain/references/`, with skill links rewritten |
| `templates/` | what is stamped into a project: global docs, service docs, the entry command | global docs and service-doc template, plus `/brain` in each tool's command format |
| `manifest.json` | which skills, personas, and tools get built | — |

## Commands

| Purpose | Command |
|---|---|
| Validate the sources | `npm run validate` |
| Select, build, and validate | `npm run all` |
| Inject into a repository | `npm run inject -- <path> [--targets a,b] [--dry-run]` |
| Import a skill from elsewhere | `npm run import -- <path> --category <category>` |
| Control-plane tests | `npm run test:control-plane` |
| Skill anatomy | `node scripts/validate-skills.js` |
| Trigger and routing evals | `node scripts/run-evals.js --min-rank1 80` |
| Reference links | `node scripts/validate-reference-links.js` |

CI runs all of these plus an inject-and-exercise smoke test. Node 22.5 or newer is required, for the built-in SQLite.

## Conventions

- **A skill** lives at `skills/<kebab-name>/SKILL.md` with `name`, `description` (what it does, then "Use when"), and an optional `category`. It follows [docs/skill-anatomy.md](docs/skill-anatomy.md): Overview, When to Use, a process section, Common Rationalizations, Red Flags, Verification. Every skill needs an eval case in `evals/cases/<name>.json`, or the eval run fails.
- **A persona** lives at `agents/<kebab-name>.md` and follows [docs/persona-anatomy.md](docs/persona-anatomy.md). It lists the only skills it may use, and it carries **no model or effort**: those are per-task decisions recorded in the control plane, and the linter rejects them in frontmatter.
- **The organization's rules** live in `org/`, one topic per numbered part. Add a part rather than growing one.
- **Shared material** goes in `references/` when more than one skill or persona needs it; a skill's own supporting file stays in `skills/<name>/references/`.
- **Never duplicate content** between a skill, a persona, and a reference. Point at the one that owns it.
- **Skill links to shared references** are written `../../references/<file>.md`; the build rewrites them to the injected copy.

## Boundaries

- **Always** run `npm run all` after changing a source, and add an eval case with a new skill.
- **Always** keep `Goal.md` untouched, and treat its updates as the requirements they are.
- **Never** hand-edit `build/`, `dist/`, or an emitted `ORG.md`.
- **Never** put a model or effort on a persona, or reintroduce a per-persona allowlist.
- **Never** add a slash command that starts a persona or a skill directly: in this organization every request routes through the CEO, and `/brain` is the only command.
- **Ask first** before deleting material that is not clearly a relic of the upstream fork, and before changing a validator's contract rather than the code it checks.

## Attribution

Forked from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills), which is the origin of the skill format, several engineering skills, the shared checklists, and the eval framework. Those parts stay MIT licensed under the original copyright.
