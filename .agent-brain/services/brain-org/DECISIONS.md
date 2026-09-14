# brain-org Decisions

Service-scoped decisions and escalation answers. Cross-service decisions go to the global `DECISIONS.md`. Append only.

| ID | Date | Question (ticket / Q-id) | Decision | Decided by | Reversible |
|---|---|---|---|---|---|
| D-1 | 2026-09-13 | Must the brain follow its own project flow when working on itself | No, partially. The brain skips the steps that exist to coordinate many people across many services: no HLD, no PRD, and milestones and sprints only when work is large enough to need them. Intake, budgets, specialists-only, code review, tests, verification, and the guard rule all still stand. A repository the brain is injected into follows every step. The exemptions are enumerated in the `self-improvement` skill and nowhere else | owner | yes |
| D-2 | 2026-09-13 | Where do the self-only artifacts live | In the same sources, selected by `self.add` and `self.omit` in `manifest.json`, with a leak check proving no product artifact depends on one. A separate repository would drift | owner | yes |
| D-3 | 2026-09-13 | May the brain's own stack differ from the stack it enforces | Yes. The enforced stack in the global `CONVENTIONS.md` binds every injected project; the brain's own services record their divergence as a decision. See brain-platform D-2 | owner | yes |
| D-4 | 2026-09-14 | Who spawns roles and chooses their model and effort | firstmate. Personas ship only as skills and no tool gets subagent files. A role never spawns another and never asks which model or effort to use: rule 1 no longer asks, and rule 4 is now "do not spawn subagents". Supersedes the native-subagent approach of Goal.md update 18 | owner | yes |
