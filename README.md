# Agent Brain

A fork of [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) used as the base of one engineer's own agent brain: the upstream skills and personas, plus more personas, more skills, the conventions, and the way of working that every project the brain runs into follows.

```
you ──▶ /brain [persona] [request]     the main agent adopts one persona, declares
                                        persona · skills · tools · model · harness · effort,
                                        and starts subagents for long-running work
you ──▶ /brain-status                   who is running what, on which model
```

## What is here

| Path | What |
|---|---|
| `AGENTS.md` · `CLAUDE.md` | how to work on this repository; `CLAUDE.md` only points at `AGENTS.md` |
| `project/` | files copied as they are to a project's root: `AGENTS.md`, the organization every agent runs under, with the installed skills and personas filled in by the build; `SOUL.md`, how every agent carries itself |
| `agents/` | personas: root, product manager, backend, web, and mobile engineers, scout, the reviewers |
| `skills/` | the flat skill dump, including the convention skills, each a table of rules with ids, none overridable; `manifest.json` names the ones in the brain |
| `references/` | ticket anatomy, commit and PR anatomy, review guidelines, the development loop, the documentation map, context scope, the upstream checklists |
| `templates/` | the documents a project fills in: ARCHITECTURE, PRD, HLD, LLD, DOMAIN, ADR, DEVELOPMENT, DEPLOYMENT, CHANGELOG, LEARNINGS |
| `docs/` | skill and persona anatomies, per-tool setup guides |
| `evals/` | trigger and routing evals for every skill |

## Use it

Run this **inside the repository that wants the brain** (Node.js 22+, npm, and Git):

```bash
npx --yes --package=github:akash2991/agent-skills#main agent-brain pull
```

Run it again to pull updates; add `--dry-run` to preview them. The command installs the selected skills, personas, references, templates, project instructions, and `/brain` commands. Brain-owned files are replaced from this repo. Only the `## This project` section of an existing `AGENTS.md` is preserved; the shared instructions are updated. Use Git for history and rollback—no backups are created. Nothing is pushed into consuming repos or written to global tool configuration.

See [Pull installation](docs/pull-install.md) for version pinning, update behavior, and installing from a local checkout. Start a new agent session with `/brain`; host details are in [pi setup](docs/pi-setup.md) and [Codex setup](docs/codex-setup.md). The upstream skills-only/plugin approach remains available in [Getting Started](docs/getting-started.md).

## Change it

- New skill: `skills/<name>/SKILL.md` per [docs/skill-anatomy.md](docs/skill-anatomy.md), an eval case in `evals/cases/`, a line in `manifest.json`. A skill copied from elsewhere may keep its shape until it is refactored after its eval.
- New persona: `agents/<name>.md` per [docs/persona-anatomy.md](docs/persona-anatomy.md), a line in `manifest.json` and in `project/AGENTS.md`.
- Checks: `node scripts/validate-skills.js`, `validate-agents.js`, `validate-reference-links.js`, `validate-commands.js`, `run-evals.js --min-rank1 95`, and `node --test scripts/agent-brain-pull-test.js`.
- Assemble a bundle for inspection: `node scripts/build-brain.js` → `build/`. Consumers use the pull command instead of copying that output.

`Goal.md` and `User.md` are the owner's requirements and are never edited by agents.

## Credits

The skill format, most engineering skills, the shared checklists, the slash commands, and the eval framework are from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills), MIT licensed under the original copyright; see [LICENSE](LICENSE).
