# brain-platform Current Milestone

- Milestone: none in flight
- Usable outcome: the control plane runs in any injected repository with nothing installed, which it does today
- Budget: not allocated; work is admitted per friction ticket
- Verification: `npm run validate && npm run test:control-plane`, then inject into a scratch directory and run `brain.js context`, `status`, and `budget` with no `npm install`

## Known divergences, deliberately not gaps

Recorded as decisions rather than debt, so nobody "fixes" them into a regression.

| Divergence from the enforced stack | Why it stands | Decision |
|---|---|---|
| Plain JavaScript, not TypeScript | No compile step means what is written is what is injected, and no dependency is needed to build it. Types are welcome later behind the same output shape | D-2 |
| One HTML page, not React | A bundler in every consuming repository costs more than a framework returns for a read-only dashboard | D-2 |
| No HLD, only this LLD | Two services, no public API, one artifact | D-4 |

## Tasks

| Ticket | Sprint | Points | Goal | Engineer | Tier / model / effort | Status | Review | QA |
|---|---|---|---:|---|---|---|---|---|
| — | — | — | none in flight; the next change comes from a friction ticket | — | — | — | — | — |

## Blockers

| Ticket | Blocker type | Dependency | Requirement | Owner | Escalated to | Since |
|---|---|---|---|---|---|---|

## Open bugs

Query the tracker: label `bug`, service `<name>`, state not `Done`. Do not copy them here.

## Next milestone

- <name and usable outcome>
