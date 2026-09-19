# brain-platform Conventions

Read the global `CONVENTIONS.md` first, then note that this service deliberately does not follow all of it. The brain enforces a stack on the projects it is injected into; its own stack is chosen for a different constraint, which is that the injected output must run anywhere with nothing installed. That is a sanctioned divergence, recorded as D-2, not a gap to close.

## Overrides

| Global ID | Global default | This service | Reason | Decided in |
|---|---|---|---|---|
| O-1 | Monorepo with `apps/`, `backend/`, `packages/` | `control-plane/` and `scripts/brain/` at the repository root | The deliverable is injected into other repositories, not deployed | this file |
| O-3 | Contract-first HTTP APIs with OpenAPI | The CLI's argument surface and the event schema are the contracts | There is no service to document; `event.schema.json` is the one wire format | this file |
| O-4 | React with TypeScript | Plain HTML with inline JavaScript, one self-contained page | React would need a bundler and a toolchain in every repository the page is injected into. The page is a read-only dashboard with a few audited inputs; the framework would cost more than it returns | D-2 |
| O-5 | React Native with Expo | Not applicable: the brain has no mobile surface, and the mobile personas are omitted from the self build | No app to build | `manifest.json` `self.omit` |
| O-6 | Node with TypeScript | Node with plain JavaScript. Types are welcome later and are not a blocker | Shipping TypeScript would force a compile step on every consumer; compiling here would add build tooling before there is a problem to solve | D-2 |
| O-7 | A SQL database | SQLite via Node's built-in `node:sqlite`, which is a SQL database and needs no install | An injected repository must run the control plane with nothing installed | D-1 |
| O-13 | Feature-first layout | Flat module-per-responsibility inside `control-plane/` | Eleven small files with one job each; a feature tree would be ceremony | this file |
| O-23 | GitHub Actions on every PR | Same, in `.github/workflows/checks.yml` | — | — |

## Additions

| ID | Rule |
|---|---|
| S-1 | Zero dependencies, build-time or runtime. A repository that consumes the brain must not need `npm install`, and this service must not need one either. Adding a dependency is a decision, not a convenience. |
| S-1b | No compile step. What is written is what is injected, so a consumer can read the code that is running. If types arrive later, they arrive as a compile step whose output is identical in shape, and CI must still prove the scratch repository installs nothing. |
| S-2 | Every module has one responsibility and no cycles. `state.js` is the read side; `brain.js` owns commands and mutations; `server.js` and the CLI both depend on `state.js` and never on each other. |
| S-3 | Every mutation is recorded in `changes` with an actor and a reason. |
| S-4 | No observability event may carry message content. The schema has no field for it, and a test asserts that. |
| S-5 | Usage ingestion is idempotent: an event id derived from the source message, checked before insert. Double-counting tokens is the worst failure this service has. |
| S-6 | A missing value is `UNKNOWN`, never zero. A holder with no usage events reports `NO_USAGE_RECORDED`. |
| S-7 | A property worth protecting gets a test in `control-plane-test.js`, at the CLI level when the property is only observable there. |
| S-8 | A hook must never break the session it observes: it reports the problem and exits 0. |

## Commands

| Purpose | Command |
|---|---|
| Setup | none; Node 22.5+ only |
| Focused test | `npm run test:control-plane` |
| Full test | `npm run validate && npm run test:control-plane` |
| Build | `npm run all` |
| End-to-end check | inject into a scratch directory, then `brain.js context`, `status`, and `budget` |
