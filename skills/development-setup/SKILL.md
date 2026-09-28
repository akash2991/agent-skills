---
name: development-setup
description: Development setup rules DS1–DS17 for each agent's isolated environment — a sibling git worktree that shares the main repository's parent but is never inside it, matching main-agent and subagent names, independent Docker containers, LocalStack, a database snapshot or seed, optional observability, and cleanup after the PR — plus shared EC2 dev machines with capacity and cost guards, Android builds on EC2, explicitly approved iOS builds on EAS, and contract-first parallel work. Use when starting any task that writes, runs, tests, debugs, or builds code; when development or a mobile build runs in the cloud; or when agents, frontend, and backend work on one repository concurrently.
category: delivery
---

# Development setup

## Overview

What is in place before development starts: an environment that belongs to this agent alone, on this machine or on a shared EC2 machine, so several agents work on one repository without interfering and the user's checkout stays untouched; the cost guards that keep cloud machines few, right-sized, and short-lived; where a mobile app is built; and the contracts that let frontend, backend, and dependent services proceed in parallel.

## When to Use

- At the start of every task that writes, runs, tests, or debugs code.
- Before running the app or tests for a ticket.
- When several agents work on the same repository, or the frontend and the backend build the same feature at once.
- When development runs on a cloud machine, or an Android or iOS app is built.
- NOT for the branch, commit, and PR rules (`git-workflow-and-versioning`), how to slice and ship the work (`continuous-delivery`), the testing rules (`test-driven-development`), or the CI pipelines that build on every push (`ci-cd-and-automation`).

## Environment

| ID | Rule |
| --- | --- |
| DS1 | **Every agent creates its own environment.** Everything below is ephemeral and belongs to this agent only; the user's checkout stays untouched. |
| DS2 | **A git worktree beside the main repository, never inside it, with the agent named after it.** If the main checkout is `<workspace-root>/<repo-name>`, create the worktree at `<workspace-root>/<ticket>-<slug>` so both directories share the same parent. The visible runtime name of each main agent and subagent is exactly the basename of that agent's assigned worktree, `<ticket>-<slug>`; persona, role, and immutable harness IDs remain separate metadata. The worktree also never belongs inside a harness directory (such as a `herdr` or `claude` root) or the agent brain. Remove it after the PR is open. |
| DS3 | **The service runs in its own Docker containers**; Docker is the local development standard. Never reuse another agent's containers. |
| DS4 | **LocalStack mocks AWS.** The app never calls a real AWS service from a development environment, local or on EC2; an EC2 machine hosts the environment, it is not a backend for the app. |
| DS5 | **Its own data:** a snapshot of the database or a seed script. Never the shared database. |
| DS6 | **Its own observability, metrics and logs, when debugging** (optional). |

## Cloud machines

The procedure, the scripts, and the one-time setup are in [cloud.md](cloud.md).

| ID | Rule |
| --- | --- |
| DS10 | **Development runs locally or on a shared EC2 dev machine, reached through `scripts/cloud-up.sh`.** One machine hosts several agents at once, and each keeps DS1–DS6 on it: its own clone at `~/work/<ticket>-<slug>` in place of the worktree, its own Compose project named after that directory with its own host ports, its own LocalStack, data, and observability. |
| DS11 | **Metrics decide when another machine launches.** An agent joins a live machine whose metrics show headroom (`scripts/cloud-capacity.sh`: 15-minute CPU under 70%, memory under 75%, disk under 80%, read from the metrics its watchdog records every minute); another machine launches only when none has. Never a machine per agent by habit; never another agent on a saturated one. |
| DS12 | **The default type, anything else with permission.** A new machine is `m8i.2xlarge` (`CLOUD_DEFAULT_TYPE`, unless `docs/DEVELOPMENT.md` records another). Any other type, more than `CLOUD_MAX_MACHINES` (2) live at once, and every new Mac host only on the user's explicit permission for that machine, asked with the evidence (the metrics, an out-of-memory kill) and recorded on the ticket. Permission for one machine never carries to the next. |
| DS13 | **An unused machine dies.** A machine terminates itself after `CLOUD_IDLE_MINUTES` (30) with no SSH connection and no load, and at its deadline regardless, `CLOUD_MAX_HOURS` (8) after the last agent joined; an AWS-side schedule terminates it at that deadline if it cannot. Terminate, never stop: a stopped machine still bills its disk. |
| DS14 | **Leave when done, reap at every start and end.** `scripts/cloud-down.sh <instance-id> <work-dir>` removes your clone and containers, and terminates the machine when no other agent's work is left on it; `scripts/cloud-reap.sh` at the start and the end of every session that uses the cloud. |
| DS15 | **Nothing lives only on the machine, and nothing of yours goes onto it.** Commit and push before every pause: termination deletes the disk. Git reaches the remote through SSH agent forwarding; this machine's AWS credentials, tokens, and keys are never copied there. Services are reached through SSH tunnels, never through opened ports. Another agent's directory, containers, and ports are never touched. |
| DS16 | **Android builds on EC2 by default; EAS is used solely for iOS.** During local development and testing, an Android build is the default because multiple Android builds are cheaper than iOS builds on EAS. An iOS build is only built with explicit user permission, to test UI bugs if any, because functionality should not differ between platforms. `scripts/android-ec2-build.sh` builds Android on an EC2 dev machine in Docker; `scripts/ios-eas-build.sh` builds iOS on EAS when the user explicitly approves it. The user may override either path; the choice and reason are recorded on the ticket. |
| DS17 | **An iOS build on AWS is a 24-hour commitment.** An EC2 Mac runs on a dedicated host billed for at least 24 hours. This is an override path, not the default: ask with that stated (DS12), reuse an allocated host for every iOS build in those 24 hours instead of allocating another, and let the scheduled release free it at the 24-hour mark. |

## Parallel work

| ID | Rule |
| --- | --- |
| DS7 | **API contract first, so frontend and backend work independently.** While an API does not exist yet, the frontend mocks it from the contract; the backend returns labelled mock data for integration testing until complete. |
| DS8 | **Once the DB model and the API contracts are decided, backend services work concurrently**, including service-to-service communication. |
| DS9 | **A dependency's shape and type are resolved before anything else is done.** No code is written against a dependency on another service whose shape or type is still open. |

## Procedure

1. Decide where the work runs: this machine by default, EC2 when the user or the ticket says so or this machine cannot run the stack. An Android build goes to EC2 by default; an iOS build goes to EAS only with explicit user permission (DS16).
2. Locally: from the main repository, run `git worktree add ../<ticket>-<slug>` so the worktree is its sibling, not its child. Have the launcher set this main agent's visible runtime name, and every launched subagent's, to exactly the basename of that agent's assigned worktree before work starts. In the cloud, apply the same naming rule to the clone at `~/work/<ticket>-<slug>`; run `scripts/cloud-reap.sh`, then `scripts/cloud-up.sh <ticket>`, which joins a machine with headroom or launches one (DS2, DS10–DS14, [cloud.md](cloud.md)).
3. Start Docker and LocalStack for the services you touch (DS3, DS4), in the cloud as the Compose project `<ticket>-<slug>` on your own ports; snapshot or seed the database (DS5).
4. Confirm the API contract, DB model, and every dependency's shape exist for the slice you are about to build (DS7–DS9); if not, that is the first task, not a thing to work around.
5. Work; run the app and tests inside this environment. In the cloud, push before every pause (DS15).
6. Open the PR, then remove the worktree, containers, and snapshot (DS2); in the cloud, `scripts/cloud-down.sh <instance-id> <ticket>-<slug>` and `scripts/cloud-reap.sh` (DS14).

## Interaction with other skills

- `git-workflow-and-versioning` owns the branch, commit, and PR rules the worktree serves; `continuous-delivery` owns how the work is sliced and shipped.
- `test-driven-development` runs its tests inside this environment and against the contract mocks set up here.
- `ci-cd-and-automation` owns the builds CI runs on every push and release; DS16 and DS17 cover a build an agent starts itself.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll just work in the user's checkout." | Every agent creates its own environment; the user's checkout stays untouched (DS1). |
| "The main repository or harness directory is a convenient place for the worktree." | The worktree is a sibling of the main repository: both share one parent, but neither contains the other (DS2). |
| "A role-based agent name is more descriptive." | The persona and role are separate metadata. The visible runtime name exactly matches the worktree basename so parallel agents reveal their ticket at a glance (DS2). |
| "Another agent's containers are already running, I'll reuse them." | Everything is ephemeral and belongs to this agent only (DS3). |
| "I'll hit real AWS / the shared database for this test." | LocalStack and your own snapshot or seed (DS4, DS5). |
| "I'll clean up the worktree later." | Open the PR, then remove the worktree, containers, and snapshot (DS2). |
| "I'll launch my own machine; sharing is messy." | Join a machine with headroom; another launches only when the metrics say none has room (DS11). |
| "The machine feels slow, I'll squeeze in anyway." | A machine without headroom by its metrics takes no one else (DS11). |
| "A bigger machine would be faster; it's only a few dollars." | Any type but the default only with the user's explicit permission for that machine (DS12). |
| "The user approved a large machine yesterday." | Permission is for one machine; ask again (DS12). |
| "I'll stop the machine instead of terminating it, to keep my state." | A stopped machine still bills its disk, and state lives in the pushed branch (DS13, DS15). |
| "I'm done, so I'll terminate the machine." | `cloud-down.sh` terminates it only when no other agent's work is left on it (DS14). |
| "Opening port 3000 on the security group is quicker than a tunnel." | Services are reached through SSH tunnels (DS15). |
| "I'll build iOS on EAS without asking the user." | iOS on EAS requires explicit user permission; functionality should not differ (DS16). |
| "Android builds are cheaper on EAS, so I'll use that." | Android builds on EC2 by default; EAS is iOS-only (DS16). |
| "Another Mac host is faster than waiting for the scrubbed one." | A new host is another 24-hour charge; reuse the allocated one (DS17). |
| "I'll build the frontend once the backend is done." | The contract comes first; the frontend mocks it, the backend returns labelled mock data until complete (DS7). |
| "I'll figure out the dependency's shape as I go." | It is resolved before anything else is done (DS9). |

## Red Flags

- Code changes appearing in the user's checkout instead of an agent worktree (DS1).
- A worktree created inside the main repository, a harness directory, or the agent brain instead of beside the main repository (DS2).
- A main agent or subagent whose visible runtime name differs from its assigned worktree basename, including a persona or role appended to the name (DS2).
- Two agents sharing a container, a database, or a worktree (DS3, DS5).
- Tests run against real AWS or a shared database (DS4, DS5).
- Worktrees, containers, or snapshots left behind after the PR is open (DS2).
- A machine launched while a live one had headroom, or an agent placed on a machine without it (DS11).
- A machine of another type, a third live machine, or a new Mac host with no permission recorded on the ticket (DS12, DS17).
- A `brain=dev` machine running with nobody using it, stopped instead of terminated, or listed by `cloud-reap.sh` after its agents left (DS13, DS14).
- Unpushed work on a cloud machine, credentials copied to it, a security group open beyond SSH, or two agents in one Compose project or on the same ports (DS10, DS15).
- An Android build run on EAS, or an iOS build run without explicit user permission recorded on the ticket (DS16).
- Frontend and backend serialized because no contract exists (DS7).
- Backend services blocked on each other after the DB model and contracts are fixed (DS8).
- Code written against a dependency whose shape or type is still open (DS9).

## Verification

Before starting work:

- [ ] Each main agent and subagent has a git worktree at `<workspace-root>/<ticket>-<slug>` beside `<workspace-root>/<repo-name>`, not inside it, and its visible runtime name is exactly that worktree's basename (DS2); or, in the cloud, `cloud-up.sh` placed you on a machine with headroom or launched the default type, or a type the user approved on the ticket (DS10–DS12).
- [ ] For an Android build, EC2 was used, or the override to EAS is recorded on the ticket; for an iOS build, explicit user permission is recorded (DS16).
- [ ] Docker containers and LocalStack are running for the services you touch and belong to this agent only (DS3, DS4).
- [ ] The database is snapshotted or seeded for this agent (DS5).
- [ ] The API contract, DB model, and dependency shapes for this slice exist (DS7–DS9).

Before finishing:

- [ ] The app and tests were run inside this environment.
- [ ] The PR is open, and the worktree, containers, and snapshot are removed (DS2).
- [ ] In the cloud: the branch is pushed, `cloud-down.sh` removed your directory and containers, and `cloud-reap.sh` lists no machine without agents (DS14, DS15).
