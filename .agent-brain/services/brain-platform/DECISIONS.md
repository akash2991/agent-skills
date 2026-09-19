# brain-platform Decisions

Service-scoped decisions and escalation answers. Cross-service decisions go to the global `DECISIONS.md`. Append only.

| ID | Date | Question (ticket / Q-id) | Decision | Decided by | Reversible |
|---|---|---|---|---|---|
| D-1 | 2026-09-13 | Which database for the control plane | SQLite through Node's built-in `node:sqlite`. It is a SQL database and needs no install, which is what lets an injected repository run the control plane immediately | owner | yes, at the cost of the recursive roll-up query and the zero-install guarantee |
| D-2 | 2026-09-13 | Must this service follow the stack the brain enforces (Node with TypeScript, React with TypeScript) | No. The brain's own stack may differ from the one it enforces. This service stays plain Node JavaScript with a single HTML page, because the injected output must run anywhere with nothing installed and there is no compile step to hide. Types are a later improvement, not a conformance gap | owner | yes |
| D-3 | 2026-09-13 | How is the zero-install guarantee protected | No dependencies at all, and no compile step: what is written is what is injected. CI proves it by injecting into a scratch directory and running the CLI with nothing installed | brain-platform EM | no: this is the constraint that makes injection viable |
| D-4 | 2026-09-13 | Does this service need an HLD | No. Two services, no public API, and one deployable artifact do not justify one. A small LLD per service is the design record | owner | yes |
| D-5 | 2026-09-14 | What does the control plane own now that firstmate runs the crew | Recorded usage only: hook capture, the event store, the usage summary, and the Langfuse export. The session claim, agent registry, quota adapter, and local UI are archived under `deprecated/removed-for-firstmate/`, because firstmate spawns, supervises, tracks, and dispatches by quota already, and a second copy would drift. Usage is attributed to the `FM_TASK_ID` firstmate exports into each crew pane | owner | yes |
