# Removed coordination

Removed on 2026-09-13 by the owner's decision: every step is run manually by a human coordinator, so the organization no longer coordinates itself. Kept because they record how the automated version worked, not because anything reads them.

| Artifact | What it did | Why it went |
|---|---|---|
| `skill-escalation/` | A stuck agent reassigned its ticket one level up: staff → EM → PM → CEO → user | Every escalation now goes straight to the coordinator, who is a person. A ladder with one rung is not a ladder |
| `skill-request-intake/` | The CEO admitted a request with a budget and an owner, or parked it with a priority | The coordinator decides what runs and when. Nothing is admitted or parked by an agent |
| `skill-model-routing/` | The EM chose the model and thinking effort for another role's task | Each command asks the coordinator which model and effort to use, and says what it would pick. Nobody routes anybody else |
| `assignment-packet.md` | The handover format one persona used to brief another | Personas do not brief each other. Each declares its own inputs and asks the coordinator for them |
| `cross-harness-delegation.md` | Invoking an agent in a different harness | No agent invokes another agent |
| `orchestration-patterns.md` | Which orchestration shapes were endorsed, and how routing decisions were executed per harness | There is no orchestration left to pattern |
| `hiring.md` | An EM raised a hiring request, the CEO drafted a persona, the user approved | The coordinator adds a persona directly when one is missing |

What replaced all of it: a role does one step, states its structured output, says who should be invoked next, and stops. The coordinator invokes the next one.

Budget tracking was **not** removed. The control plane still records real token and cost usage per agent. What went is the allocation chain and the asks that bubbled up it.

## Second pass, 2026-09-13: budgets, the CEO lock, and what was left of routing

| Artifact | What it did | Why it went |
|---|---|---|
| `skill-budget-management/` | The CEO held a company budget and allocated it down the reporting tree; an agent that hit its allocation stopped and raised an ask that bubbled up | The coordinator decides what runs and for how long. An allocation tree with one decision-maker is a ledger nobody reads |
| `budget_allocations`, `budget_requests` tables, `brain.js budget`, the `/api/budget/*` routes and the Budgets tab | The ledger, its CLI, its HTTP surface, and its UI | Removed with the skill. Recorded usage stays: every model call still carries real input, output, cache and reasoning tokens, and cost |
| `budget.changed` event and its fields | The audit trail of allocations and asks | There is nothing left to audit |
| `sessions_single_live_ceo` unique index, `EXCLUSIVE_ROLES`, exit code 3 | A second terminal claiming the CEO role was refused | Roles are invoked by a person who knows what they already have running. A lock that protects against a coordinator the system no longer has is friction, not safety |
| `eval-budget-management.json`, `budget-test.js` | Their tests | Removed with what they tested |

`budget_input_basis` became `usage_input_basis`. The mechanism survives because prompt caching still makes "how many input tokens was that" a real question, with fresh, new, and billable differing by orders of magnitude. It is now a reporting choice rather than something an allocation is charged against.

Model routing had already gone in the first pass. What remained were mentions in personas and references, now removed: the model and effort come from the coordinator when a role is invoked, and the control plane records what actually ran.
