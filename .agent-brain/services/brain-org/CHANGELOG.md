# brain-org Changelog

Newest first. One line per merged task, written by the staff engineer, checked by the EM at milestone close.

## Unreleased

- F-self-26 — automation removed. The coordinator is a person: every role is invoked by its own `brain-*` command, confirms model and effort, asks for declared inputs, returns a structured output, and names what should run next without invoking it — org-staff-engineer
- F-self-27 — escalation, request intake, and model routing deleted; assignment packets, orchestration patterns, cross-harness delegation, and hiring deleted with them. Every blocker goes straight to the coordinator. Archived under `deprecated/removed-coordination/` — org-staff-engineer
- F-self-28 — the always-on organization cut from 255 lines to 77: north star, roster, how agents behave, where things live. The detail moved to references that a role loads when it needs them — org-staff-engineer
- F-self-29 — personas gained required `## Inputs` and `## Output` sections, and `## Communication` became `## Handover` — org-staff-engineer
- F-self-22 — context scope added as org part 45: what each role reads, what it reads on demand, and what it must not read, with a new global `ARCHITECTURE.md` as the one page the CEO and PM plan from — org-staff-engineer
- F-self-23 — rule 3b: the chain is a default, not a toll booth. A step that adds nothing is skipped and the skip is recorded; intake, review, QA and escalation are never skipped — org-staff-engineer
- F-self-14 — vendored the Langfuse skill from github.com/langfuse/skills verbatim, with a documented section-check exemption so it can be re-synced from upstream rather than forked — org-staff-engineer
- F-self-7 — `budget-management` never mentioned provider quota although rule 20 and the `quota-axi` skill both point at it. Added the two-limits section, the three rules that follow, and quota reads at allocation and at ask time — org-staff-engineer
- F-self-3 — the self-only flow exemptions written down in the `self-improvement` skill: no PRD, no HLD, a small LLD, conditional design review, optional sprints; intake, budgets, specialists-only, review, tests, verification, and the guard rule unchanged (brain-org D-1) — org-staff-engineer
- F-self-4 — enforced stack in the global `CONVENTIONS.md` set to Node with TypeScript, React with TypeScript, and a SQL database, and separated from the brain's own stack (brain-org D-3) — org-staff-engineer
- F-self-5 — `HLD.md` replaced by a small `LLD.md` for this service; stale `dist/` paths corrected; `SPEC.md` and `usage.md` archived under `deprecated/superseded-during-development/` — org-staff-engineer
