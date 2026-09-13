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
