# Contributing

This repository is the source of an injectable agent organization. Changes here change how every project that has the brain installed behaves, so the bar is: the sources stay the single place a rule lives, and the checks stay green.

Read [CLAUDE.md](CLAUDE.md) first for what produces what. `Goal.md` is the specification of record; never edit it.

## Before you change anything

```bash
npm run all      # validate the sources, select, build every target
```

If that fails on a clean checkout, fix that before adding to it.

## Adding a skill

1. Check it is not already covered. Most ideas overlap an existing skill, and extending one beats adding a near-duplicate.
2. Create `skills/<kebab-name>/SKILL.md` following [docs/skill-anatomy.md](docs/skill-anatomy.md): frontmatter with `name`, a `description` that says what it does and then "Use when", an optional `category`, and the sections Overview, When to Use, a process, Common Rationalizations, Red Flags, Verification.
3. Add an eval case at `evals/cases/<name>.json` with at least three positive trigger prompts, two negatives that belong to other skills, and one behavioral eval. The eval run fails without it.
4. Add the skill to `manifest.json` if it should be built.
5. Run `npm run all && node scripts/run-evals.js --min-rank1 80`.

Importing one from elsewhere: `npm run import -- <path> --category <category>`. It warns when a skill links outside its own directory; vendor those files in so the skill travels whole.

## Adding a persona

Follow [docs/persona-anatomy.md](docs/persona-anatomy.md). Prefer `extends:` on an existing base over a new base persona. A persona lists the only skills it may use, ends its Authorization with a refusal of out-of-scope work, and carries no model or effort. Add it to `manifest.json` to have it built.

## Changing the organization's rules

Rules live in `org/`, one topic per numbered part, emitted as a single `ORG.md`. Add a part rather than growing one past its subject. Never edit an emitted file.

## Changing the control plane

`control-plane/` is plain Node with no dependencies, on the built-in SQLite. Anything that touches sessions, budgets, the agent tree, or usage ingestion needs a test in `scripts/brain/control-plane-test.js`. The properties worth protecting: usage is never double-counted, the CEO lock cannot be taken twice, a child allocation cannot exceed its parent, and no event ever carries message content.

## What not to do

- Do not hand-edit anything under `build/`, or an emitted `ORG.md`.
- Do not duplicate a rule across a skill, a persona, and a reference. One owns it; the others point.
- Do not add a command that starts a persona or a skill directly. Requests route through the CEO, and `/brain-pm` is the only command.
- If a command is ever added, name it `brain-<something>`: `templates/commands/` is validated against that prefix, because commands share a directory with the project's own and with other tools'.
- Do not weaken a validator to make a change pass. Change the code it checks, or change the contract deliberately and update its test with the reason.
