# Hiring: adding a persona when no one covers a task

The organization has specialists only. When a task arrives that no persona's Role covers, nobody improvises: the EM raises a hiring request, the CEO drafts the persona, the user approves, and the persona is added to the brain and re-injected. The task stays blocked until then.

## Flow

1. **Refusal.** The assigned persona posts the out-of-scope block (`escalation` skill) and returns the ticket to the EM.
2. **Reassign or request.** The EM checks the persona list in `ORG.md`. If a covering persona exists, reassign. If not, post the hiring request block on the ticket, mark it `Blocked` (blocker type: `missing access` is wrong here; use `technical decision`), and reassign to the CEO.
3. **Draft.** The CEO drafts the persona per `docs/library/persona-anatomy.md` into `{{ORG_DIR}}/hiring/<name>.md`: role, responsibilities, goals, communication, success criteria, tools, authorization (including the out-of-scope refusal), way of working, quality non-negotiables, skills (existing ones, plus any skill that must be written), composition, red flags, and the frontmatter with the default `model/effort` pair and the `allowed` pairs per the routing policy. Prefer extending an existing base persona (`extends:`) over a new base.
4. **Approve.** The CEO puts the hire in the "Decisions I need from you" section of the CEO report: role, why no existing persona fits, the draft path, cost implication (model and effort).
5. **Add.** On approval the user moves the draft into the brain repository's `agents/`, adds it to `manifest.json` `personas`, writes any missing skill with its eval case, runs `npm run all`, and re-injects. Until then the ticket stays blocked; the CEO may re-plan around it.
6. **Unblock.** The EM assigns the ticket to the new persona with an assignment packet.

## Hiring request block

Defined in the `escalation` skill:

```markdown
### Hiring request H-<ticket>-<n>
- Task: <ticket and one-sentence goal>
- Personas consulted: <names> — each refused as out of scope
- Role needed: <one sentence>
- Discipline: backend | web | mobile | cross-cutting
- Skills needed: <existing skill names, plus any that must be written>
- Suggested model / effort: <from the routing policy>
- Blocking: yes | no — default if unanswered: <ticket stays blocked>
```

## Rules

- No task starts on a persona whose Role does not cover it, however available or capable that persona is.
- A hire is a user decision; the CEO drafts, the user approves.
- A drafted persona that duplicates an existing one is a reassignment, not a hire.
