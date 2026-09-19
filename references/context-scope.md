# Context scope

What each role reads and, more importantly, what it does not. Context is finite and every document you load competes with the one that matters. Loaded by every role before it starts pulling documents in.

Context is finite, and spending it is not a courtesy. Everything an agent loads costs tokens, competes for attention, and pushes the thing that actually matters further from the decision. A PM reading coding conventions is not better informed; it is worse informed, because the relevant half is now diluted.

So each role reads what its decisions need, and nothing else. The rule is not "read less". It is **read what you decide with**.

| Role | Always reads | Reads when the task needs it | Does not read |
|---|---|---|---|
| the user | `{{ORG_DIR}}/docs/PRD.md` and `ARCHITECTURE.md`, the tracker | anything they want; no scope binds them | |
| PM (project-wide) | `ORG.md`, its persona, the `PRD.md` it owns, `ARCHITECTURE.md`, the tracker | `DECISIONS.md` for anything it is about to re-decide | service `HLD.md` and `LLD.md`, `CONVENTIONS.md`, coding practices, test strategy, code |
| Principal engineer (project-wide) | `ORG.md`, its persona, the `ARCHITECTURE.md` it owns, `PRD.md`, global `CONVENTIONS.md` and `DECISIONS.md`, the `HLD.md` of every service in scope | a service's `LLD.md` at a boundary it is redesigning | service internals, ticket-level history |
| EM (one service) | `ORG.md`, its persona, its own service's docs in full, the approved design | `ARCHITECTURE.md` for how its service connects; the `HLD.md` of a service it integrates with | other services' internals, other EMs' tickets, `PRD.md` in full |
| Staff engineer (one service) | its persona, its ticket, the service `HLD.md` and `LLD.md` it owns, service and global `CONVENTIONS.md`, its owned paths | the contract of a service it calls | `PRD.md`, `ARCHITECTURE.md` beyond its own row, other services' code, other tickets |
| Code reviewer | its persona, the diff, the ticket, the `HLD.md` and `LLD.md` sections the change implements, `CONVENTIONS.md` | the contract a change moves | `PRD.md`, unrelated services |
| Test engineer | its persona, the story and its acceptance criteria, the service's `LLD.md` and test strategy | the contract under test | implementation internals it is meant to verify from outside |
| Specialist (security, performance) | its persona, the change or surface under audit, the relevant contract | whatever the finding forces it to open | everything outside the audit |

Two pages are written to be read by anyone: `PRD.md` says what the product is and `ARCHITECTURE.md` says what exists and where a change belongs. Both are deliberately thin, with no folder layout, class design, or coding conventions, because that is what lets a project-wide role name an owner without reading code.

Scope runs both ways. A project-wide role that starts reading service internals has lost its altitude; a service-scoped role that starts reading the whole product has left its lane. Either way the context fills with material that does not change the decision at hand.

Three rules follow:

1. **Give context, do not point at a directory.** A ticket names the sections to read. "Read the service docs" is not an instruction, it is a cost.
2. **A role that needs something outside its scope asks for it, in the ticket.** The answer is usually a summary from the role that owns it, not a document to read. If the same request happens twice, the artifact is wrong: file it as friction.
3. **Do not forward a document because you happened to have it open.** Passing your context down the chain is the most common way a small task becomes an expensive one.
