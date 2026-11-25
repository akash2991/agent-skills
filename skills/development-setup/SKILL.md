---
name: development-setup
description: Development setup rules for each agent's isolated environment — a sibling git worktree that shares the main repository's parent but is never inside it, main-agent and subagent names made of the worktree basename and the persona, independent Docker containers on their own ports, LocalStack, a database snapshot or seed, optional observability, all made by one spawn that a resumed session runs again and removed by one teardown after the merge that touches only what spawn created — plus Android builds in that environment, explicitly approved iOS builds on EAS, and contract-first parallel work. Use when starting or resuming any task that writes, runs, tests, debugs, or builds code; when tearing an environment down after a merge or a canceled ticket; when a mobile build is needed; or when agents, frontend, and backend work on one repository concurrently.
category: delivery
---

# Development setup

## Overview

What is in place before development starts: an environment that belongs to this agent alone, so several agents work on one repository without interfering and the user's checkout stays untouched; where a mobile app is built; and the contracts that let frontend, backend, and dependent services proceed in parallel. The rules are the same wherever the agent runs — a laptop, a cloud machine, a sandbox; which machine that is, and how it is provisioned, is decided before the agent starts and is not the agent's concern.

## When to Use

- At the start of every task that writes, runs, tests, or debugs code.
- Before running the app or tests for a ticket.
- When several agents work on the same repository, or the frontend and the backend build the same feature at once.
- When an Android or iOS app is built.
- NOT for the branch, commit, and PR rules (`git-workflow-and-versioning`), how to slice and ship the work (`continuous-delivery`), the testing rules (`test-driven-development`), or the CI pipelines that build on every push (`ci-cd-and-automation`).

## Environment

| ID | Rule |
| --- | --- |
| DS1 | **Every agent creates its own environment.** Everything below is ephemeral and belongs to this agent only; the user's checkout stays untouched. Nothing lives only in the environment: commit and push before every pause. |
| DS2 | **A git worktree beside the main repository, never inside it, with the agent named after it and its persona.** If the main checkout is `<workspace-root>/<repo-name>`, create the worktree at `<workspace-root>/<ticket>-<slug>` so both directories share the same parent. The visible runtime name of each main agent and subagent is the basename of that agent's assigned worktree followed by its persona in parentheses, `<ticket>-<slug> (<persona>)`; an agent without a worktree is named `<ticket> <scope> (<persona>)`. The visible name is what the harness shows people (Claude's agent description, Pi's subagent name, a Herdr tab label); where a harness accepts only a restricted identifier, such as a Herdr agent name (`[a-z][a-z0-9_-]{0,31}`), that identifier stays a lowercase handle and the name goes on its free-text label. This rule overrides a harness's own naming guidance, such as pi-herdr-agents' `<task>-<role>`. Immutable harness IDs remain separate metadata. The worktree also never belongs inside a harness directory (such as a `herdr` or `claude` root) or the agent brain. It lives from spawn to teardown (DS10, DS11). |
| DS3 | **The service runs in its own Docker containers**; Docker is the local development standard. The Compose project is named after the worktree in lowercase (Compose accepts no capitals: `eng-123-login` for `ENG-123-login`), on host ports no other project on this machine uses (`docker ps --format '{{.Ports}}'`). Never reuse or touch another agent's containers, ports, or directory. |
| DS4 | **LocalStack mocks AWS.** The app never calls a real AWS service from a development environment, wherever that environment runs, and no AWS credentials are copied into it. |
| DS5 | **Its own data:** a snapshot of the database or a seed script, kept in the Compose project's volumes so teardown removes it. Never the shared database. |
| DS6 | **Its own observability, metrics and logs, when debugging** (optional). |
| DS10 | **Spawn before work, and again on resume.** One command, `scripts/agent-env.js spawn`, gives the agent everything it needs to start: the worktree and branch (DS2), its visible name, host ports and Compose project (DS3), `.env` copied from the main checkout when git ignores it there, dependencies from the root lockfile, and the services, LocalStack and data the project's compose file defines (DS3–DS5). Setup beyond the root lockfile and the compose file belongs in the compose file (an init or seed service), so spawn runs it. Spawn is re-entrant: a resumed session runs it again and gets the same environment back, restored when it was lost or torn down. |
| DS11 | **Teardown after the merge, and only what spawn created.** `scripts/agent-env.js teardown` runs once the branch has merged, or with `--abandon` for a canceled ticket; never when the PR opens, because review changes still need the environment. It refuses uncommitted work and removes only what the environment ledger records: the Compose project's containers, networks, and volumes when spawn claimed the project and every container came from this worktree; the worktree; the local branch when spawn created it and it has merged; and the port claims. Whatever it did not create stays and is named. |

## Mobile builds

| ID | Rule |
| --- | --- |
| DS16 | **Android builds in this agent's own environment; EAS is used solely for iOS, with explicit permission.** Android: the project's own `scripts/build-android.sh`, else `eas build --platform android --local` in a Docker container with the JDK and Android SDK the project pins, signed in with the project's `EXPO_TOKEN` from `.env` — never on EAS's servers, whose builds are the cost. iOS only with the user's explicit permission, to test UI bugs, because functionality should not differ between platforms: this skill's `scripts/ios-eas-build.sh`, run from the app directory; its "free builds used up" (exit 4), "queue too long, canceled" (exit 5), and "build failed" (exit 1, after reading `eas build:view <id>`) each go to the user as a decision. An iOS build anywhere else, such as locally on macOS, also needs explicit permission and the Xcode version the project pins. Every override and its reason is recorded on the ticket. |

## Parallel work

| ID | Rule |
| --- | --- |
| DS7 | **API contract first, so frontend and backend work independently.** While an API does not exist yet, the frontend mocks it from the contract; the backend returns labelled mock data for integration testing until complete. |
| DS8 | **Once the DB model and the API contracts are decided, backend services work concurrently**, including service-to-service communication. |
| DS9 | **A dependency's shape and type are resolved before anything else is done.** No code is written against a dependency on another service whose shape or type is still open. |

## Procedure

### Spawn

1. Move the ticket to In Progress with a status update (`linear`) and declare the persona (`/brain`).
2. From the main repository or any worktree, run `skills/development-setup/scripts/agent-env.js spawn <ticket>-<slug> --owner <your-name> --persona <persona> [--ports <n>]` and `eval` the exports it prints (DS10). A resumed session runs the same command first. It refuses an environment another owner holds, a directory the ledger does not record, and a Compose project with containers started elsewhere or resources it did not create.
3. Have the launcher set this main agent's visible runtime name, and every launched subagent's, to `AGENT_NAME`: the worktree basename followed by the persona, `<ticket>-<slug> (<persona>)` (DS2).
4. Confirm the API contract, DB model, and every dependency's shape exist for the slice you are about to build (DS7–DS9); if not, that is the first task, not a thing to work around.

### Work

5. Run the app and tests inside this environment, and push before every pause (DS1). Build Android here; iOS on EAS only with explicit permission (DS16). Open the PR, answer the review, and merge (`git-workflow-and-versioning`).

### Teardown

6. After `merge-pr.js` reports the merge, run `agent-env.js teardown <ticket>-<slug> --owner <your-name>`; for a canceled ticket add `--abandon`, which keeps the unmerged branch (DS11). It refuses before the merge and on uncommitted or untracked work, and names anything it left.
7. Close the Herdr tabs this agent opened (`herdr-fanout`).

## Interaction with other skills

- `git-workflow-and-versioning` owns the branch, commit, and PR rules the worktree serves, and deletes the remote branch at merge (P7) while teardown deletes the local one; `continuous-delivery` owns how the work is sliced and shipped.
- `test-driven-development` runs its tests inside this environment and against the contract mocks set up here.
- `ci-cd-and-automation` owns the builds CI runs on every push and release; DS16 covers a build an agent starts itself.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll just work in the user's checkout." | Every agent creates its own environment; the user's checkout stays untouched (DS1). |
| "The main repository or harness directory is a convenient place for the worktree." | The worktree is a sibling of the main repository: both share one parent, but neither contains the other (DS2). |
| "I'll lead the name with the persona; it is more descriptive." | The ticket comes first so parallel agents reveal it at a glance, even when a narrow pane cuts the name short; the persona follows in parentheses (DS2). |
| "Another agent's containers are already running, I'll reuse them." | Everything is ephemeral and belongs to this agent only, in its own Compose project on its own ports (DS3). |
| "I'll hit real AWS / the shared database for this test." | LocalStack and your own snapshot or seed (DS4, DS5). |
| "The environment keeps my work, so pushing can wait." | Nothing lives only in the environment; push before every pause (DS1). |
| "I'll set up the worktree and containers by hand; it is quicker." | Spawn makes the whole environment and records it, so teardown can remove it and a resumed session can get it back (DS10). |
| "The PR is open, so I'll tear down now." | Review changes still need the environment; teardown runs after the merge (DS11). |
| "Teardown can sweep up that other container while it is at it." | Teardown removes only what spawn created; anything else is someone else's (DS11). |
| "I'll build iOS on EAS without asking the user." | iOS on EAS requires explicit user permission; functionality should not differ (DS16). |
| "Android builds are cheaper on EAS, so I'll use that." | Android builds in this environment; EAS is iOS-only (DS16). |
| "I'll build the frontend once the backend is done." | The contract comes first; the frontend mocks it, the backend returns labelled mock data until complete (DS7). |
| "I'll figure out the dependency's shape as I go." | It is resolved before anything else is done (DS9). |

## Red Flags

- Code changes appearing in the user's checkout instead of an agent worktree (DS1).
- Unpushed work at a pause (DS1).
- A worktree created inside the main repository, a harness directory, or the agent brain instead of beside the main repository (DS2).
- A main agent or subagent whose visible runtime name is not `<ticket>-<slug> (<persona>)` for its own worktree and persona, or `<ticket> <scope> (<persona>)` without a worktree (DS2).
- Two agents sharing a container, a Compose project, host ports, a database, or a worktree (DS3, DS5).
- Tests run against real AWS or a shared database, or AWS credentials copied into the environment (DS4, DS5).
- An environment made by hand instead of by spawn, or a resumed session working before spawn ran again (DS10).
- Worktrees, containers, or snapshots left behind after the merge, or torn down while the PR is still open (DS11).
- Containers, volumes, branches, or directories removed that the environment ledger does not record (DS11).
- An Android build run on EAS, or an iOS build run without explicit user permission recorded on the ticket (DS16).
- Frontend and backend serialized because no contract exists (DS7).
- Backend services blocked on each other after the DB model and contracts are fixed (DS8).
- Code written against a dependency whose shape or type is still open (DS9).

## Verification

Before starting work:

- [ ] `agent-env.js spawn` ran for this ticket, again if the session was resumed (DS10).
- [ ] Each agent that writes, runs, tests, or builds code has a git worktree at `<workspace-root>/<ticket>-<slug>` beside `<workspace-root>/<repo-name>`, not inside it, and its visible runtime name is `<ticket>-<slug> (<persona>)` (DS2).
- [ ] Each agent without a worktree, such as a read-only reviewer, is named `<ticket> <scope> (<persona>)` (DS2).
- [ ] Docker containers and LocalStack are running for the services you touch, as this agent's own Compose project on its own ports (DS3, DS4).
- [ ] The database is snapshotted or seeded for this agent (DS5).
- [ ] The API contract, DB model, and dependency shapes for this slice exist (DS7–DS9).
- [ ] For an Android build, this environment is used; for an iOS build, explicit user permission is recorded (DS16).

Before finishing:

- [ ] The app and tests were run inside this environment.
- [ ] The branch is pushed and the PR is open (DS1).

After the merge, or when the ticket is canceled:

- [ ] `agent-env.js teardown` ran, with `--abandon` only for a canceled ticket, and anything it named as left behind is accounted for (DS11).
