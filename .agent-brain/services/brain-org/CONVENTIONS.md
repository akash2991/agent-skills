# brain-org Conventions

Read the global `CONVENTIONS.md` first. This service owns the organization's own artifacts: the rules, personas, skills, references, report templates, and project templates. Its output is prose that other agents obey, so the quality bar is "cannot be misread, and something checks it" rather than "reads well".

## Overrides

| Global ID | Global default | This service | Reason | Decided in |
|---|---|---|---|---|
| O-2 | Modular monolith | Not applicable: the deliverable is a set of documents and a build pipeline, not a running service | The artifacts have no runtime | this file |
| O-11 | Typing detail | Not applicable to markdown artifacts; applies to `brain-platform` | — | this file |
| O-14 | Comments explain the why | Inverted: these artifacts *are* the why, and they explain themselves to an agent under time pressure | The reader is a model, not a maintainer with context | this file |

## Additions

| ID | Rule |
|---|---|
| S-1 | One artifact owns a topic. A rule lives in one org part, a workflow in one skill, a role's duties in one persona. Everything else points at it. |
| S-2 | Every rule names how it is observed to hold: a validator, an eval case, a report field, or a red flag. Unenforceable prose is a defect. |
| S-3 | A new skill ships with an eval case: three positive triggers, two negatives owned by other skills, one behavioral eval. |
| S-4 | A skill's Common Rationalizations table is mandatory, because naming the excuse is what changes behaviour. |
| S-5 | Changes are motivated by a friction ticket from real work. A redesign with no friction behind it cannot be evaluated and is parked. |
| S-6 | Read the rendered output under `build/` for any artifact changed: placeholders only resolve at build time. |
| S-7 | A change that weakens a guard needs the user's recorded agreement, never an internal review alone. |

## Commands

| Purpose | Command |
|---|---|
| Setup | `npm install` is not required; Node 22.5+ only |
| Focused check | `npm run validate` |
| Full test | `node scripts/validate-skills.js && node scripts/run-evals.js --min-rank1 80 && node scripts/validate-reference-links.js` |
| Build | `npm run all` |
| End-to-end check | `npm run bootstrap` then start a new session and run `/brain` |
