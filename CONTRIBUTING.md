# Contributing

Read [AGENTS.md](AGENTS.md) for the layout and the checks. `Goal.md` and `User.md` are the owner's requirements; never edit them.

## Before proposing a new skill

1. Search the catalog: most ideas overlap an existing skill. Extend it rather than adding a near-duplicate.
2. Check open pull requests (`gh pr list --state open`).
3. Search the [skill-change rejection ledger](evals/skill-impact.md) for earlier proposals that overlap with the idea and review their eval evidence before repeating the work.
4. Read [docs/skill-anatomy.md](docs/skill-anatomy.md) and confirm the idea is an actionable workflow with verification, not vague advice.
5. Say which gap the skill fills that no existing skill, open PR, or rejected proposal does.
6. Strip model-specific workarounds. If a step only makes sense by naming a model, model version, or private tool name, describe the capability instead.

## Adding a skill

1. `skills/<kebab-name>/SKILL.md` per [docs/skill-anatomy.md](docs/skill-anatomy.md): frontmatter with `name`, a `description` that says what it does and then "Use when", an optional `category`; sections Overview, When to Use, a process, Common Rationalizations, Red Flags, Verification.
2. A skill copied from elsewhere goes into `skills/` as it is and is refactored to the anatomy after its eval. A skill written here follows the anatomy from the start.
3. `evals/cases/<name>.json` with at least three positive prompts, two negatives owned by other skills when possible, and one behavioral eval. Execution evals must use real fixtures under `evals/fixtures/`; conversation-shaped skills may use a reviewer-gated `kind: "dialogue"` eval.
4. Add it to `manifest.json` if the brain should carry it.
5. `node scripts/validate-skills.js && node scripts/run-evals.js --min-rank1 80`.

## Adding a persona

Follow [docs/persona-anatomy.md](docs/persona-anatomy.md): a narrow role, high-level guidelines, what it never does, the only skills and tools it may use, no model or effort. Add it to `manifest.json` and to the table in `project/AGENTS.md`. `node scripts/validate-agents.js`.

## Modifying existing skills

Before proposing a change, search the [skill-change rejection ledger](evals/skill-impact.md) for previous attempts affecting the same skill and review their eval evidence.

- Keep changes focused and minimal.
- Preserve the existing structure and tone.
- Test that YAML frontmatter remains valid after edits.

If a skill or description change is rejected based on eval results, add one row to the ledger with the date, affected skill, concise attempted change, before-to-after rank-1 score, and rejected PR link and outcome. Land that ledger-only update separately on the default branch.

## Changing the rules or the conventions

`project/AGENTS.md` and the rule tables in the convention skills are short on purpose. Tightening is ordinary work; loosening is the owner's call. Anything longer than a rule goes into a reference the rule points at.

## Repo-scoped files

`AGENTS.md` and `CLAUDE.md` at the repo root configure agents working on this repository itself. When writing setup guides or docs, do not instruct users to copy those root files into their own projects; the project brain uses the files built from `project/` and `manifest.json`.

## Testing hooks

The session-start script (`hooks/session-start.sh`) injects the `using-agent-skills` meta-skill when wired into a host's `SessionStart` hook. Claude Code routes skills natively, so the Claude Code plugin does not register it. Run the regression test before opening any PR that touches `hooks/session-start.sh` or `skills/using-agent-skills/SKILL.md`:

```bash
bash hooks/session-start-test.sh
```

Expected output: `session-start JSON payload OK`.

## What not to do

- Do not duplicate a rule across a skill, a persona, and a reference. One owns it; the others point.
- Do not weaken a validator to make a change pass.
- Do not put model or effort on a persona; the user sets them per run.
- Do not add skills that are vague advice instead of actionable processes.
- Do not create supporting files unless the content exceeds 100 lines.
- Do not put reference material inside skill directories unless it is skill-specific; use `references/` for shared material.
- Do not add translated copies of docs or skills; keep contributions in English so they do not drift.
