---
name: development-setup
description: Development setup rules for each agent's isolated environment — a sibling git worktree that shares the main repository's parent but is never inside it, matching main-agent and subagent names, independent Docker containers on their own ports, LocalStack, a database snapshot or seed, optional observability, and cleanup after the PR — plus Android builds in that environment, explicitly approved iOS builds on EAS, and contract-first parallel work. Use when starting any task that writes, runs, tests, debugs, or builds code; when a mobile build is needed; or when agents, frontend, and backend work on one repository concurrently.
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
| DS2 | **A git worktree beside the main repository, never inside it, with the agent named after it.** If the main checkout is `<workspace-root>/<repo-name>`, create the worktree at `<workspace-root>/<ticket>-<slug>` so both directories share the same parent. The visible runtime name of each main agent and subagent is exactly the basename of that agent's assigned worktree, `<ticket>-<slug>`; persona, role, and immutable harness IDs remain separate metadata. The worktree also never belongs inside a harness directory (such as a `herdr` or `claude` root) or the agent brain. Remove it after the PR is open. |
| DS3 | **The service runs in its own Docker containers**; Docker is the local development standard. The Compose project is named after the worktree, `<ticket>-<slug>`, on host ports no other project on this machine uses (`docker ps --format '{{.Ports}}'`). Never reuse or touch another agent's containers, ports, or directory. |
| DS4 | **LocalStack mocks AWS.** The app never calls a real AWS service from a development environment, wherever that environment runs, and no AWS credentials are copied into it. |
| DS5 | **Its own data:** a snapshot of the database or a seed script. Never the shared database. |
| DS6 | **Its own observability, metrics and logs, when debugging** (optional). |

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

1. From the main repository, run `git worktree add ../<ticket>-<slug>` so the worktree is its sibling, not its child. Have the launcher set this main agent's visible runtime name, and every launched subagent's, to exactly the basename of that agent's assigned worktree before work starts (DS2).
2. Start Docker and LocalStack for the services you touch as the Compose project `<ticket>-<slug>` on free host ports (DS3, DS4); snapshot or seed the database (DS5).
3. Confirm the API contract, DB model, and every dependency's shape exist for the slice you are about to build (DS7–DS9); if not, that is the first task, not a thing to work around.
4. Work; run the app and tests inside this environment, and push before every pause (DS1). Build Android here; iOS on EAS only with explicit permission (DS16).
5. Open the PR, then remove the worktree, containers, and snapshot (DS2).

## Interaction with other skills

- `git-workflow-and-versioning` owns the branch, commit, and PR rules the worktree serves; `continuous-delivery` owns how the work is sliced and shipped.
- `test-driven-development` runs its tests inside this environment and against the contract mocks set up here.
- `ci-cd-and-automation` owns the builds CI runs on every push and release; DS16 covers a build an agent starts itself.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll just work in the user's checkout." | Every agent creates its own environment; the user's checkout stays untouched (DS1). |
| "The main repository or harness directory is a convenient place for the worktree." | The worktree is a sibling of the main repository: both share one parent, but neither contains the other (DS2). |
| "A role-based agent name is more descriptive." | The persona and role are separate metadata. The visible runtime name exactly matches the worktree basename so parallel agents reveal their ticket at a glance (DS2). |
| "Another agent's containers are already running, I'll reuse them." | Everything is ephemeral and belongs to this agent only, in its own Compose project on its own ports (DS3). |
| "I'll hit real AWS / the shared database for this test." | LocalStack and your own snapshot or seed (DS4, DS5). |
| "The environment keeps my work, so pushing can wait." | Nothing lives only in the environment; push before every pause (DS1). |
| "I'll clean up the worktree later." | Open the PR, then remove the worktree, containers, and snapshot (DS2). |
| "I'll build iOS on EAS without asking the user." | iOS on EAS requires explicit user permission; functionality should not differ (DS16). |
| "Android builds are cheaper on EAS, so I'll use that." | Android builds in this environment; EAS is iOS-only (DS16). |
| "I'll build the frontend once the backend is done." | The contract comes first; the frontend mocks it, the backend returns labelled mock data until complete (DS7). |
| "I'll figure out the dependency's shape as I go." | It is resolved before anything else is done (DS9). |

## Red Flags

- Code changes appearing in the user's checkout instead of an agent worktree (DS1).
- Unpushed work at a pause (DS1).
- A worktree created inside the main repository, a harness directory, or the agent brain instead of beside the main repository (DS2).
- A main agent or subagent whose visible runtime name differs from its assigned worktree basename, including a persona or role appended to the name (DS2).
- Two agents sharing a container, a Compose project, host ports, a database, or a worktree (DS3, DS5).
- Tests run against real AWS or a shared database, or AWS credentials copied into the environment (DS4, DS5).
- Worktrees, containers, or snapshots left behind after the PR is open (DS2).
- An Android build run on EAS, or an iOS build run without explicit user permission recorded on the ticket (DS16).
- Frontend and backend serialized because no contract exists (DS7).
- Backend services blocked on each other after the DB model and contracts are fixed (DS8).
- Code written against a dependency whose shape or type is still open (DS9).

## Verification

Before starting work:

- [ ] Each main agent and subagent has a git worktree at `<workspace-root>/<ticket>-<slug>` beside `<workspace-root>/<repo-name>`, not inside it, and its visible runtime name is exactly that worktree's basename (DS2).
- [ ] Docker containers and LocalStack are running for the services you touch, as this agent's own Compose project on its own ports (DS3, DS4).
- [ ] The database is snapshotted or seeded for this agent (DS5).
- [ ] The API contract, DB model, and dependency shapes for this slice exist (DS7–DS9).
- [ ] For an Android build, this environment is used; for an iOS build, explicit user permission is recorded (DS16).

Before finishing:

- [ ] The app and tests were run inside this environment.
- [ ] The branch is pushed; the PR is open, and the worktree, containers, and snapshot are removed (DS1, DS2).
