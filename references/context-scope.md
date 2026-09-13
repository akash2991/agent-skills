# Context scope

What each role reads and, more importantly, what it does not. Context is finite and every document you load competes with the one that matters. Loaded by every role before it starts pulling documents in.

Context is finite, and spending it is not a courtesy. Everything an agent loads costs tokens, competes for attention, and pushes the thing that actually matters further from the decision. A PM reading coding conventions is not better informed; it is worse informed, because the relevant half is now diluted.

So each role reads what its decisions need, and nothing else. The rule is not "read less". It is **read what you decide with**.

| Role | Always reads | Reads when the task needs it | Does not read |
|---|---|---|---|
| the user | `{{ORG_DIR}}/ORG.md`, its persona, `{{ORG_DIR}}/docs/ARCHITECTURE.md`, the tracker, the control plane | a PRD under review, `DECISIONS.md` | service `LLD.md`, `CONVENTIONS.md`, folder layout, code |
| PM | `ORG.md`, its persona, `ARCHITECTURE.md`, the PRD it owns, the tracker | `DECISIONS.md` for anything it is about to re-decide | `LLD.md`, `CONVENTIONS.md`, coding practices, test strategy, code |
| Principal engineer | `ORG.md`, its persona, `ARCHITECTURE.md`, the PRD, global `CONVENTIONS.md` and `DECISIONS.md`, the `LLD.md` of every service in scope | existing code at the boundaries it is redesigning | unrelated services, ticket-level history |
| EM | `ORG.md`, its persona, `ARCHITECTURE.md`, its own service's docs in full, the approved design | the `LLD.md` of a service it integrates with | other services' internals, other EMs' tickets |
| Staff engineer | its persona, its ticket, its service's `LLD.md` and `CONVENTIONS.md`, the global `CONVENTIONS.md`, its owned paths | the contract of a service it calls | the PRD in full, other services' code, other tickets |
| Code reviewer | its persona, the diff, the ticket, the `LLD.md` section the change implements, `CONVENTIONS.md` | the contract a change moves | the PRD, unrelated services |
| Test engineer | its persona, the story and its acceptance criteria, the service's `LLD.md` and test strategy | the contract under test | implementation internals it is meant to verify from outside |
| Specialist (security, performance) | its persona, the change or surface under audit, the relevant contract | whatever the finding forces it to open | everything outside the audit |

`ARCHITECTURE.md` is the shared page: one screen that says what exists, what each service is for, and where a change belongs, with no folder layout, class design, or coding conventions in it. That is what lets the user or PM name an owner without reading code, and it is why those details must stay out of it.

Three rules follow:

1. **Give context, do not point at a directory.** A ticket names the sections to read. "Read the service docs" is not an instruction, it is a cost.
2. **A role that needs something outside its scope asks for it, in the ticket.** The answer is usually a summary from the role that owns it, not a document to read. If the same request happens twice, the artifact is wrong: file it as friction.
3. **Do not forward a document because you happened to have it open.** Passing your context down the chain is the most common way a small task becomes an expensive one.
