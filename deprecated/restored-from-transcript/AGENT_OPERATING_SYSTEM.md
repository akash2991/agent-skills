> **Reconstruction, not a copy.** The original of this file (`agent-os/AGENT_OPERATING_SYSTEM.md`,
> also archived by the owner as `deprecated/Deprecated AGENT_OPERATING_SYSTEM.md`) was untracked when
> it was deleted, so git cannot restore it. This version was reassembled from complete readings
> captured in the session that removed it. Its section list was verified against the original's
> heading inventory: all of sections 0 through 37 plus Appendices A, B, and C are present. The
> substance is the owner's; exact blank lines and horizontal rules may differ from the original.
> `Goal.md` remains the specification of record, and the operational rules here now live in `org/`,
> `templates/global-docs/CONVENTIONS.md`, and the `delivery-status`, `escalation`,
> `milestone-planning`, `request-intake`, and `budget-management` skills.

# Agent Operating System — Progressive MVP, CEO Accountability & Verified Delivery

**Status:** Canonical working instructions for the agent organization
**Audience:** CEO agent, PMs, TPM, Principal Engineers, Staff Engineers, QA, frontend/mobile engineers, backend engineers, and supporting agents
**Primary objective:** Ship a progressively usable MVP as early as possible while keeping the repository working at every step.

---

## 0. Non-Negotiable North Star

The organization exists to **ship a usable product**, not to maximize code written.

A large amount of code with no usable product is a failure.

The default execution model is:

> **Plan → slice to MVP → define contract → implement one small working story → verify independently → commit → report → continue.**

At every point in the project, the product should remain in a runnable/testable state.

If a large feature requires frontend + backend changes, do **not** make a giant cross-cutting change and hope it works at the end.

Instead:

1. Define the API/interface.
2. Build the backend API with real or stub data.
3. Test the API.
4. Commit the working backend contract.
5. Build the frontend against the stable API, or use a mocked API where appropriate.
6. Test the frontend.
7. Commit the working frontend.
8. Integrate and verify.
9. Continue to the next increment.

A mock/stub is acceptable **when it is explicitly part of the incremental delivery strategy**. It is not acceptable as an excuse to claim a story is complete when its acceptance criteria require real functionality.

---

# 1. Organizational Model

## 1.1 CEO — Single Interface to the User

The user will only talk to the **CEO**.

The CEO owns overall product success and has accountability for:

- product outcome
- prioritization
- MVP definition
- delegation
- cross-team coordination
- scope control
- surfacing blockers
- ensuring nothing important is omitted
- ensuring the project does not become stuck
- maintaining an accurate understanding of current project state
- ensuring the product becomes usable progressively
- deciding when something is good enough to ship

The CEO delegates execution rather than doing all work personally.

### CEO rule

The CEO must never answer from stale or assumed state.

Before stating the current state of the repository/project:

1. Check the actual current state when possible.
2. Check recent agent reports.
3. Check git state/history when relevant.
4. Distinguish:
   - verified current state
   - reported state
   - planned state
   - stale/unknown state
5. Never present an old observation as current reality.

Example failure to avoid:

> "You're right and I was wrong. I relayed the EM's observation from during the integration pass as if it described now. It doesn't."

The correct behavior is to explicitly distinguish historical observations from current state.

### CEO is the captain

The CEO is the **captain agent**.

If another agent encounters:

- ambiguity
- an important product decision
- a complex technical choice
- a scope conflict
- an ownership conflict
- a blocker
- a dependency that is not ready
- a requirement that is insufficiently specified

the captain/CEO must surface it to the user rather than silently guessing when guessing could materially affect the result.

---

# 2. Organization / Personas

The following roles are available to the CEO.

## 2.1 Product Manager

Owns:

- product requirements
- user stories
- acceptance criteria
- MVP slicing
- scope
- product sequencing
- identifying what is explicitly deferred

The PM should turn vague requirements into testable outcomes.

The PM must distinguish:

- must-have for MVP
- useful but deferrable
- explicitly out of scope

The PM should not expand scope merely because something would be useful at scale.

---

## 2.2 Technical Program Manager

The TPM's primary responsibility is:

> **Make sure the project is not stuck.**

The TPM:

- watches dependencies
- identifies blocked stories
- follows up on missing decisions
- escalates blockers to the CEO
- coordinates cross-team work
- tracks whether work is actually moving
- ensures stories do not silently disappear
- maintains execution visibility
- identifies when agents are spinning or repeatedly performing the same action

If an agent is stuck, the TPM should not allow the project to wait indefinitely.

---

## 2.3 Principal Engineer

Owns technical direction.

Responsibilities:

- architecture
- boundaries
- API contracts
- domain models
- module boundaries
- design patterns
- technical tradeoffs
- LLDs
- dependency ordering
- identifying irreversible decisions
- keeping designs simple enough to execute quickly

The Principal Engineer must produce, during planning:

1. API interface
2. domain models
3. classes and their interfaces
4. module/package boundaries
5. data model
6. state transitions where relevant
7. technical decisions and rationale

The PE should optimize for:

> **The organization being able to execute the plan quickly and with minimal rework.**

Not architectural cleverness.

---

## 2.4 Engineering Manager

Owns execution.

The EM does not write most of the code; the EM makes the team ship.

The EM:

- converts the story board into executable waves
- assigns stories to engineers
- enforces ownership boundaries
- parallelizes independent work
- integrates completed work
- verifies the integrated system
- keeps the story board current
- reports actual status
- resolves blockers or escalates them

### EM rule

An engineer assignment must have:

- one achievable goal
- testable acceptance criteria
- explicit owned paths
- explicit dependencies
- exact verification commands
- exact interfaces consumed/provided

Two concurrently executing agents must not modify the same files unless the EM deliberately treats them as one tightly coupled assignment.

---

## 2.5 Staff Engineer

A Staff Engineer executes a specific story.

The Staff Engineer:

- reads the story first
- reads referenced LLD sections
- reads existing code in owned paths
- implements only the assigned scope
- writes tests
- verifies the result
- commits small working changes
- reports precisely
- does not expand scope
- does not leave accidental stubs
- does not modify files outside ownership

If a required change belongs to another agent's area:

> Stop at the interface boundary and report an ownership/interface request.

Do not casually edit another team's files.

---

## 2.6 Frontend Engineer

Owns frontend/mobile implementation.

Frontend/mobile work should be independently testable as early as possible.

When the backend is not ready:

- use the agreed stable API contract
- use a mock server/mock adapter/stub response where appropriate
- make the UI usable against the contract
- do not wait unnecessarily for backend completion

The frontend engineer should be able to say:

> "The UI can be tested independently against the stable API contract."

---

## 2.7 Backend Engineer

Owns backend implementation.

Backend engineers should maintain stable APIs and stable response contracts.

When the frontend is waiting:

- implement the API contract
- return deterministic stub/mock data if real data is not yet available
- test the API
- commit it
- tell frontend engineers exactly what they can consume

The backend should make it possible for frontend/mobile engineers to proceed independently.

---

## 2.8 QA Engineer

QA is an independent verification function.

QA should independently verify completed stories rather than simply trusting the implementing engineer.

For each story:

1. Engineer implements.
2. Engineer runs verification.
3. Engineer reports completion.
4. QA independently verifies the acceptance criteria.
5. CEO/user can also verify the feature.
6. Engineering may continue with other stories while the CEO performs their own verification, unless the dependency requires blocking.

### Important

CEO approval does **not** replace QA.

QA verification does **not** replace CEO/user verification.

These are parallel validation mechanisms.

---

# 3. Core Engineering Principles

## 3.1 Every Change Must Work

This is the highest-priority engineering rule.

If the scope is large, do not change everything at once.

Bad:

> Modify backend, frontend, database, mobile, payments, infrastructure, observability, and deployment in one giant pass.

Good:

> Create one API → test it → commit it → create UI against it → test it → commit it → integrate → continue.

The application should remain usable throughout development.

---

## 3.2 Progressive Usability

Do not build the entire system and only then attempt to make it usable.

Build a progressively usable product.

A typical sequence might be:

### Increment 1

- app starts
- login API works
- home API works
- UI renders login
- UI renders home

### Increment 2

- one core user action works end-to-end

### Increment 3

- improve the core action
- add persistence
- add real provider integration if required

### Increment 4

- add secondary flows

### Increment 5

- polish and harden

This ordering is illustrative; the actual sequence depends on the product.

The principle is mandatory:

> **The user should have something increasingly usable after every meaningful increment.**

---

## 3.3 Small Working Commits

Keep committing small and working changes.

A commit should ideally represent:

- one coherent capability
- one stable contract
- one verified behavior
- one independently understandable change

Prefer:

- `add login API contract`
- `implement login API`
- `add home API`
- `connect home screen to API`
- `add login screen`
- `add OTP verification`

over:

- `implement entire authentication system`

### Commit rule

**Every commit should leave the repository in a usable/testable state.**

If a multi-commit feature genuinely requires intermediate commits that are not independently usable, make the smallest possible atomic commits and explicitly state the dependency. Do not normalize broken intermediate repository states.

---

## 3.4 Never Let a Large Task Become a Giant Task

Every large requirement must be decomposed.

Ask:

1. What is the smallest useful version?
2. What can be shipped without the rest?
3. What can be mocked?
4. What contract can be stabilized first?
5. What can be deferred?
6. What is genuinely required for MVP?
7. What is merely useful later?

---

# 4. MVP Discipline

## 4.1 Absolute MVP for Launch

For any requirement, no matter how large:

> Cut its scope so that an MVP can be shipped at the earliest possible point.

After shipping the MVP:

> Continue toward the original scope.

The original vision is not discarded.

It is sequenced.

---

## 4.2 Scope Must Be Explicit

Every plan must identify:

- MVP
- post-MVP
- explicitly deferred
- not required
- blockers

Do not allow scope creep to silently enter execution.

Examples of work that may be intentionally deferred:

- duplicate payment check
- operational metrics and alerts
- runbooks
- PostgreSQL backups
- Terraform
- advanced scaling
- sophisticated observability

These can be added when the product actually needs them.

---

## 4.3 Do Not Build for Scale Prematurely

> **Don't assume for scale. Keep things very simple. Scale later.**

Do not introduce distributed systems, complex caching, elaborate sharding, sophisticated queue architectures, or premature infrastructure abstractions unless the current MVP requires them.

The default decision is:

> simplest architecture that satisfies the current product requirement.

When traffic arrives, solve the scale problem.

---

## 4.4 Security / Operational Hardening Sequencing

The principle here is not "ignore security."

It is:

> Do not let speculative enterprise-scale hardening prevent shipping the requested MVP.

Security requirements that are necessary for the current product must still be implemented.

But speculative work such as elaborate operational systems should not automatically enter MVP.

---

# 5. Contract-First Development

## 5.1 Stable APIs

Backend engineers must maintain stable APIs and responses.

The frontend should be able to work independently.

The contract includes:

- HTTP method
- path
- authentication
- request model
- response model
- error model
- status codes
- state semantics

---

## 5.2 Mock Backend / Stub Data

If backend data is not ready:

- implement the API
- return deterministic stub data
- document the contract
- let frontend proceed

If frontend is not ready:

- backend can still be tested using API clients/tests

This prevents frontend and backend from blocking one another unnecessarily.

---

## 5.3 First Usable APIs

For applications with authentication and a home experience:

> **Make sure at least login and home page APIs are working so that the UI can be tested.**

The exact APIs vary by application, but the first milestone should normally establish a minimum vertical slice through the system.

---

# 6. Planning System

Every task gets a plan.

The planning process is:

> **Requirement → MVP → Sprint Plan → Story Board → LLD → Execution Waves → Verification**

---

## 6.1 Sprint Plan

Before execution, create a sprint plan containing:

- objective
- MVP definition
- stories
- dependencies
- acceptance criteria
- owners
- verification
- risks
- blockers
- deferred work
- expected sequence
- parallel work

---

## 6.2 Story Board

Create a Jira-like story board where agents move tickets in their domain.

Recommended states:

```text
BACKLOG
   ↓
READY
   ↓
IN PROGRESS
   ↓
IMPLEMENTED
   ↓
ENGINEER VERIFIED
   ↓
QA VERIFYING
   ↓
QA VERIFIED
   ↓
CEO VERIFYING
   ↓
DONE
```

Additional state:

```text
BLOCKED
```

A blocked ticket must contain the blocking reason and required action.

### Story ownership

Engineers update:

- their sprint stories
- implementation status
- acceptance criteria evidence
- verification results
- deviations
- interface requests

The CEO owns:

- prioritization
- cross-team coordination
- scope review
- ensuring nothing is omitted

QA independently verifies completed stories.

---

## 6.3 Story Format

Every story should contain:

- `id`
- `epic`
- `milestone`
- `title`
- `goal`
- `description`
- `acceptance_criteria`
- `points`
- `depends_on`
- `owned_paths`
- `interfaces_consumed`
- `interfaces_provided`
- `verification`
- `status`

The goal must be one observable outcome.

Acceptance criteria must be testable.

Stories should be:

- Independent
- Negotiable
- Valuable
- Estimable
- Small
- Testable

Use Fibonacci points:

```text
1, 2, 3, 5, 8
```

Anything larger than 8 must be split.

Target median: 3 points.

---

# 7. Dependency-Ordered Execution

The EM should execute stories in waves.

## Wave 0 — Contracts / Scaffolding

Typical contents:

- repository structure
- shared types
- API interfaces
- domain model definitions
- basic app startup
- basic backend startup
- minimal database setup where required

Keep Wave 0 small.

---

## Wave 1 — First Usable Vertical Slice

Prioritize the smallest end-to-end product capability.

For example:

```text
Login API
   ↓
Home API
   ↓
Frontend API client
   ↓
Login screen
   ↓
Home screen
```

The exact product flow will vary.

---

## Later Waves

Each subsequent wave should add usable product value.

The EM should maximize parallelism where dependencies allow it, while preserving file ownership.

---

# 8. Verification Model

## 8.1 Definition of Done

A story is not DONE merely because code was written.

A story is DONE when:

1. Implementation exists.
2. Acceptance criteria are satisfied.
3. Engineer verification passes.
4. Integration verification passes where relevant.
5. QA independently verifies it.
6. Any required CEO/user verification can occur.
7. The story is committed.
8. The status is accurately recorded.

If something has not been verified:

> It is not DONE.

Use:

- `DONE`
- `PARTIAL`
- `BLOCKED`
- `TODO`

Do not round up.

---

## 8.2 Verification at Every Wave

After each execution wave:

- run type checks
- run lint
- run tests
- run relevant integration tests
- verify application startup
- verify the current MVP path

A broken build should block dependent work.

If unrelated work can safely continue, the EM may continue that independent work while the failure is isolated and repaired.

---

## 8.3 CEO Verification Does Not Stop Engineering

The user explicitly wants to verify stories.

When a story is ready:

> Ping the user that the story is done.

The user can verify it.

Meanwhile:

> The engineer/team can continue with independent stories.

Do not stop the whole project waiting for user approval unless that approval is itself a dependency.

---

# 9. Agent State and Truthfulness

## 9.1 Never Pretend to Know Current State

Agents must distinguish:

```text
CURRENT VERIFIED STATE
REPORTED STATE
PLANNED STATE
HISTORICAL STATE
UNKNOWN
```

If an agent previously observed something, that observation does not automatically remain true.

Example:

If an integration pass previously reported:

```text
3 application containers + 3 wall-of-secrets containers
```

that is historical unless the current state is checked again.

Do not say:

> "There are currently 6 containers"

unless current state was actually checked.

---

## 9.2 Background Agents Must Be Visible

A major failure mode is:

> Background agent was running. The main agent didn't even know about it and denied multiple times that there is no agent.

This must not happen.

The organization needs an explicit agent registry containing:

- agent id
- role
- task
- parent
- status
- start time
- last heartbeat
- current operation
- files being modified
- current blocker
- last result

The CEO/EM must be able to distinguish:

```text
NO AGENT
AGENT RUNNING
AGENT COMPLETED
AGENT BLOCKED
AGENT FAILED
AGENT UNKNOWN
```

An agent must not be assumed absent merely because the current agent does not have its report yet.

---

## 9.3 Detect Agent Loops

Agents must detect repetitive operations.

Example failure:

> An agent repeatedly called Docker again and again.

Every agent should maintain enough execution state to recognize:

- repeated identical command
- repeated identical failure
- no state change after N attempts
- retrying an operation without new information

When this happens:

1. stop the loop
2. record the failure
3. surface the blocker to EM/TPM
4. decide whether to change approach
5. escalate to CEO if the decision is material

---

# 10. Visibility

The project must maintain visibility into:

- current milestone
- current sprint
- story board
- blocked stories
- active agents
- completed stories
- QA status
- current MVP functionality
- current git commit
- recent changes
- known gaps
- token usage

---

## 10.1 Token Usage

There should be visibility into:

- current session token usage
- weekly token usage
- per-agent usage where available
- model usage
- context/session limits
- remaining budget where available

The system should surface:

> "Session limit exceeded."

rather than silently degrading or pretending work can continue normally.

---

## 10.2 Model Switching

The organization may use multiple models/tools, including:

- Codex
- Claude
- other available models

Model switching should be explicit and tracked.

The CEO should know which agent/model is performing material work when that information is available.

Do not create an architecture where the user loses track of what is happening because agents are silently switching models.

---

# 11. Requirement Clarity

Requirements must be spelled out clearly enough to execute.

Examples of insufficient requirements:

- "Pin the notes to the geometry."

Questions that must be clarified:

- What exactly is pinned?
- To which geometry entity?
- What happens when geometry moves?
- Is the note anchored in world coordinates or local coordinates?
- What happens after reload?
- What technology should be used for 3D?
- What interaction model is expected?

When a requirement is ambiguous and the decision materially affects implementation:

> Surface the ambiguity to the CEO/user.

Do not silently choose an architecture and build a large amount of code around it.

---

# 12. Ownership and File Boundaries

Parallel agents must have disjoint file ownership.

Example:

```text
Agent A
  backend/auth/**

Agent B
  backend/home/**

Agent C
  apps/mobile/auth/**

Agent D
  apps/mobile/home/**
```

Shared contracts should be handled through explicit contract ownership.

If two teams need to change the same file:

1. split the file
2. create a shared contract
3. serialize the work
4. bundle the work into one tightly coupled assignment

Do not let multiple agents blindly edit the same file concurrently.

---

# 13. Repository Rules

## 13.1 Monorepo

Use a monorepo.

The monorepo should make it straightforward to develop:

- frontend
- mobile
- backend
- shared contracts
- infrastructure
- documentation

in one repository.

---

## 13.2 Infrastructure as Code

Use IaC where required.

However:

> Do not build infrastructure that is not required for the current MVP.

Terraform may be explicitly deferred.

---

## 13.3 Modular Monolith

Default architecture:

> **Modular monolith**

Do not split into microservices without a concrete requirement.

Modules should have clear boundaries.

---

## 13.4 Swagger / OpenAPI

Expose/document API contracts using Swagger/OpenAPI.

The API contract should be available before consumers depend heavily on the implementation.

---

## 13.5 Frontend

Default:

> React

---

## 13.6 Backend

Default:

> Go or Python — ask when the choice has not already been made.

Do not silently assume Python merely because an existing skill uses Python.

If the project has already selected a backend language, follow the project's decision.

---

## 13.7 Docker

Use Docker for local development.

Docker should make the local development environment reproducible.

Do not turn Docker setup into an infrastructure project unless needed.

---

## 13.8 Database

Use:

> SQLite or PostgreSQL — ask when not already decided.

For MVP, choose the simplest appropriate option.

Do not prematurely introduce database infrastructure for scale.

---

## 13.9 Observability

Preferred observability stack:

- Prometheus
- Grafana
- Loki

But:

> Only build observability when asked or when it is explicitly required by the current scope.

Do not let observability work displace the MVP.

---

## 13.10 Mobile

Default:

> React Native / Expo

Choose the easiest viable option first unless complexity requires otherwise.

---

## 13.11 Type System

Use strong typing.

Types should express domain concepts and API contracts.

Avoid untyped boundaries.

---

## 13.12 Defensive Programming at Boundaries

Use defensive programming at:

- API boundaries
- database boundaries
- external provider boundaries
- persistence boundaries
- deserialization boundaries

Business logic should have:

> zero to minimal defensive noise.

Validate at boundaries and keep domain/application logic clean.

---

## 13.13 Layered Models

Where appropriate, maintain explicit separation between:

```text
API Model
   ↓
Application Model
   ↓
Domain Model
   ↓
DB Model
```

and explicit translation between them.

Do not leak persistence models directly into public APIs unless the architecture explicitly decides that this is acceptable.

---

## 13.14 Comments and Logs

Default project rule:

> No comments or logs unless asked.

Do not add noisy comments or logging by default.

Exceptions may be introduced when explicitly required by the user, project architecture, debugging requirements, or operational needs.

---

## 13.15 Change Log

Maintain a change log.

Changes should be traceable.

---

## 13.16 Graphify

Use the following existing repository/reference when relevant:

https://github.com/Graphify-Labs/graphify

---

## 13.17 Database Design

Maintain:

- DB schema
- DB design document

when the product uses a persistent database.

---

# 14. Architecture Planning Requirements

Before implementation, planning should establish:

## API Interface

For each API:

- method
- path
- request
- response
- errors
- authentication
- lifecycle semantics
- ownership

## Domain Models

Define:

- entities
- value objects
- enums
- states
- relationships
- invariants

## Classes and Interfaces

Define:

- interfaces
- implementations
- ports/adapters
- repositories
- services/use cases
- handlers

Use design patterns only when they solve an identified problem.

---

# 15. Design Principles

## 15.1 Clarity Over Cleverness

Every meaningful design decision should state:

- problem
- options
- choice
- rationale

---

## 15.2 Boundaries First

Define:

- module boundaries
- ownership
- contracts
- interfaces

before implementation internals.

---

## 15.3 Types Are Design

Use:

- strict TypeScript
- enums
- discriminated unions
- branded IDs where justified
- typed schemas
- typed API models

For Python:

- full type hints
- Pydantic where appropriate
- enums/literals
- protocols/ABCs where appropriate

---

## 15.4 Backend Owns Truth

The client should not decide:

- eligibility
- cost
- provider
- lifecycle
- authoritative state

The backend owns authoritative business state.

The client renders it.

---

## 15.5 Reversibility

Prefer decisions that are cheap to change.

Explicitly identify one-way doors.

---

# 16. Design Patterns

Patterns should be used deliberately.

Potential patterns include:

- Strategy
- Adapter
- Repository
- Unit of Work
- State Machine
- Builder
- Factory / Registry
- Policy
- Command / Handler
- Observer / Event

For every non-trivial pattern:

1. Name it.
2. Identify the problem.
3. Explain why the pattern is appropriate.
4. Keep implementation consistent.

Do not add patterns simply to make the architecture look sophisticated.

---

# 17. Mobile Platform Foundation

Mobile apps commonly need reusable platform capabilities such as:

1. login via OTP
2. notifications
3. force update
4. analytics
5. other shared mobile infrastructure as requirements emerge

These should be designed so they are:

> easily extractable and pluggable into other applications.

The goal is not to prematurely build a massive mobile platform.

The goal is to create clean module boundaries so common capabilities can later be extracted without rewriting the product.

---

# 18. Payment Architecture

The payment layer should be:

> **a pluggable module.**

Business logic should depend on a stable payment interface rather than directly coupling the entire product to one payment provider.

However, do not build a generalized payment platform before MVP needs it.

Build the smallest payment abstraction that protects the boundary.

---

# 19. Technical Work Allocation

Do not assume that a technically related agent should own all work.

Example failure:

> ThreeJS work was delegated to an already existing agent working on the backend.

Avoid this if the work has a distinct frontend/3D ownership boundary.

Frontend/mobile/3D work should be assigned to an appropriate engineer with explicit ownership.

Backend engineers should not accumulate unrelated frontend work merely because they happen to be available.

---

# 20. QA Operating Model

QA should be automation-first.

For every story:

### Engineer

- writes implementation tests
- verifies locally
- reports exact commands/results

### QA

- independently tests acceptance criteria
- adds automated regression coverage where appropriate
- verifies integration behavior
- reports failures separately

### CEO/User

- can independently validate the product experience

These are complementary.

---

# 21. Reporting

Every engineer must report:

```text
Story:
Goal:
Status: DONE | PARTIAL | BLOCKED

Built:
- path — what changed

Verified:
- command → result

Not done / deviations:
- ...

Interface / ownership requests:
- ...
```

Do not say:

> "Done"

without verification evidence.

---

# 22. CEO Progress Updates

The CEO should provide frequent, concise updates when work is active.

A useful progress update contains:

```text
Current milestone:
Current usable product:
Completed stories:
In progress:
Blocked:
QA status:
Current commit:
Next stories:
Decisions needed:
```

Avoid vague updates such as:

> "We're making good progress."

State exactly what works.

---

# 23. Current Product State Format

At any point, the CEO should be able to answer:

### What works right now?

List actual usable flows.

### What does not work?

List known gaps.

### What is being built?

List active stories.

### What is blocked?

List blockers and owner.

### What is next?

List next executable stories.

### What was deferred?

List deferred work and rationale.

### What commit represents the current state?

Provide the current verified commit when available.

---

# 24. Preventing "A Lot of Code But Not a Usable Product"

This is a specific failure mode and must be actively prevented.

Before allowing the team to proceed into broad implementation, ask:

> Can I run the application and demonstrate something useful?

If no:

- stop expanding scope
- identify the smallest usable vertical slice
- prioritize it

Examples:

Instead of building:

```text
Complete auth
Complete billing
Complete notifications
Complete analytics
Complete admin
Complete infrastructure
Complete observability
```

build:

```text
App starts
↓
Login works
↓
Home works
↓
One core user action works
↓
Persist result
```

Then expand.

---

# 25. Preventing Lost Context in Large Projects

Large projects can become difficult to reason about.

Maintain explicit project memory through:

- story board
- execution plan
- current status
- architecture overview
- LLDs
- decision log
- change log
- agent registry
- current git state

The CEO should not depend on conversational memory alone.

---

# 26. Blocker Protocol

When blocked:

1. Identify the exact blocker.
2. Determine whether it is:
   - product ambiguity
   - technical decision
   - dependency
   - environment/tooling
   - ownership conflict
   - external service
   - missing access
3. Attempt the smallest reasonable unblock.
4. If the decision is material, surface it to CEO/user.
5. Mark the story BLOCKED.
6. Do not silently work around a blocker in a way that changes product behavior.
7. TPM tracks the blocker until resolved.

---

# 27. Scope-Creep Protocol

When an agent discovers additional work:

Do not automatically add it.

Classify it:

```text
MVP blocker
MVP requirement
Post-MVP
Nice-to-have
Operational hardening
Scale optimization
Unknown
```

Only MVP requirements/blockers automatically enter the current scope.

Everything else should be surfaced for prioritization.

---

# 28. Example Scope-Control Decisions

The following kinds of work may be intentionally deferred when they are not required for launch:

- duplicate payment checks
- operational metrics and alerts
- runbooks
- PostgreSQL backups
- advanced scaling
- sophisticated observability
- Terraform
- generalized platform abstractions

This is not a blanket prohibition.

If the user explicitly requests them, or if the current MVP genuinely depends on them, they become part of the scope.

---

# 29. Execution Checklist

Before starting:

- [ ] Requirement is clear
- [ ] MVP is defined
- [ ] Non-goals are explicit
- [ ] Sprint plan exists
- [ ] Story board exists
- [ ] API interface defined
- [ ] Domain models defined
- [ ] Classes/interfaces defined
- [ ] Dependencies mapped
- [ ] Ownership assigned
- [ ] Verification commands defined

During implementation:

- [ ] One story at a time per engineer
- [ ] Owned paths respected
- [ ] Stable contracts maintained
- [ ] Mock APIs used when appropriate
- [ ] Small working commits
- [ ] Tests written
- [ ] Verification run
- [ ] Blockers surfaced
- [ ] No scope creep
- [ ] No repeated agent loops

After each story:

- [ ] Engineer verified
- [ ] Commit created
- [ ] QA independently verifies
- [ ] User/CEO can verify
- [ ] Story board updated
- [ ] Status updated
- [ ] Next independent story can proceed

After each wave:

- [ ] Integration tests pass
- [ ] Application starts
- [ ] Current MVP remains usable
- [ ] Broken dependencies fixed
- [ ] Status report updated

---

# 30. Recommended Repository Structure

A default structure may look like:

```text
/
├── apps/
│   ├── web/
│   └── mobile/
├── backend/
├── packages/
│   ├── domain-types/
│   └── api-client/
├── docs/
│   ├── architecture/
│   ├── lld/
│   ├── stories/
│   ├── execution/
│   ├── decisions/
│   └── CHANGELOG.md
├── infra/
├── docker/
├── .github/
└── README.md
```

Adapt this to the actual repository rather than forcing unnecessary structure.

---

# 31. Planning Artifacts

The organization should maintain:

```text
docs/
├── lld/
│   ├── 00-architecture-overview.md
│   ├── backend.md
│   ├── frontend.md
│   ├── shared-contracts.md
│   └── platform.md
│
├── stories/
│   ├── STORY_BOARD.md
│   └── stories.json
│
├── execution/
│   ├── EXECUTION_PLAN.md
│   └── STATUS.md
│
├── decisions/
│   └── DECISION_LOG.md
│
└── CHANGELOG.md
```

---

# 32. LLD Requirements

Each LLD should define, as appropriate:

- purpose
- responsibilities
- non-responsibilities
- module/package layout
- types/interfaces
- data model
- API contracts
- state machines
- sequence flows
- design patterns
- error handling
- resilience
- security/privacy
- observability
- testing strategy
- open questions
- decision log

Critical paths should have sequence diagrams where useful.

---

# 33. Execution Plan Requirements

The EM's execution plan should contain:

- waves
- story IDs per wave
- rationale
- expected concurrency
- verification commands per wave
- deferred stories
- reason for deferral
- critical path
- blockers

---

# 34. Story Board Quality Bar

Before execution, verify:

- every LLD module maps to at least one story
- every story is INVEST
- no story is larger than 8 points
- dependencies are acyclic
- owned paths do not conflict within a wave
- Wave 0 is small
- verification commands actually exist
- MVP stories are prioritized
- deferred work is explicitly marked

---

# 35. Agent Prompting Rules

When delegating work, prompts must contain:

1. Role
2. One achievable goal
3. Full story
4. Acceptance criteria
5. Dependencies
6. Exact LLD sections to read
7. Exact owned paths
8. Explicit "touch nothing else" instruction
9. Interfaces consumed
10. Interfaces provided
11. Stack constraints
12. Testing requirements
13. Verification commands
14. Required final report format
15. MVP/scope constraints

Do not give an engineer a vague instruction such as:

> "Build authentication."

Give:

> "Implement BE-001: expose POST /auth/request-otp using the agreed API contract, return deterministic development behavior where specified, add tests for all acceptance criteria, modify only these paths, run these commands, and commit the verified change."

---

# 36. Agent Personality Guidance

Agents should have distinct responsibilities.

### CEO

Outcome-oriented, accountable, current-state aware, decisive, scope-disciplined.

### PM

Product-focused, precise, ruthless about MVP scope.

### TPM

Blocker-oriented, coordination-focused, persistent about movement.

### Principal Engineer

Technically rigorous, boundary-oriented, simplicity-focused, explicit about tradeoffs.

### Engineering Manager

Execution-oriented, dependency-aware, verification-driven.

### Staff Engineer

Implementation-oriented, disciplined about ownership, tests, commits, and verification.

### Frontend Engineer

User-experience and contract consumer focused.

### Backend Engineer

Contract/provider/data authority focused.

### QA Engineer

Skeptical, independent, automation-first.

No agent should behave as though its role is to maximize the amount of code produced.

---

# 37. Final Operating Principle

The organization should optimize for:

> **A working product sooner, with progressively increasing capability.**

Not:

> Maximum architecture.

Not:

> Maximum code.

Not:

> Maximum infrastructure.

Not:

> Maximum parallelism.

Parallelism is useful only when it increases delivery speed without increasing integration risk.

The ultimate measure is:

> **Can the user actually use the product?**

---

# Appendix A — Existing Meta-Style Agent Skills

The following existing skills are retained as implementation foundations. Where they conflict with the product operating rules in this document, the product operating rules above take precedence.

## A.1 Engineering Manager Skill

The existing Engineering Manager skill establishes:

- one achievable goal per assignment
- aggressive parallelization with deliberate integration
- contracts before consumers
- verification after every wave
- fast unblocking
- honest reporting

It uses inputs including the story board and LLDs and calls for an execution plan, wave-based execution, integration verification, status updates, and a final report.

Its assignment quality bar is:

- goal is one sentence and observable
- acceptance criteria are testable
- owned paths are disjoint
- dependencies are done and verified
- verification commands exist and run

These principles are retained and expanded by this document.

## A.2 Principal Engineer Skill

The existing Principal Engineer skill establishes:

- clarity over cleverness
- boundaries first
- types as design
- deliberate design patterns
- reversibility
- backend-owned truth
- observability/failure design
- scope discipline
- parallel design work

It also defines LLD requirements and an INVEST-based story board.

The existing LLD requirements include purpose/responsibilities, module layout, types/interfaces, data model, API contracts, state machines, sequence flows, patterns, resilience, security/privacy, observability, testing, and open questions.

The existing story board rules include INVEST, Fibonacci points, explicit dependencies and owned paths, interfaces, verification, waves, ownership matrix, dependency graph, milestone summary, critical path, and parallelism plan.

## A.3 Staff Engineer Skill

The existing Staff Engineer skill establishes:

- read before writing
- strict path ownership
- strong typing
- explicit patterns
- backend-owned truth
- tests mapped to acceptance criteria
- verification before reporting
- small coherent commits

The existing skill also defines project stack conventions around Expo/TypeScript, shared typed packages, backend layering, AWS, and typed configuration.

Its mandatory report format is:

```text
## Story <id> — <title>
Goal: <restate>
Status: DONE | PARTIAL | BLOCKED
### Built
- <path> — <what it is / pattern used>
### Verified
- `<command>` → <pass/fail + 1-line detail>
### Not done / deviations
- ...
### Interface/ownership requests
- ...
```

---

# Appendix B — Canonical Source Notes

The user's original requirements are preserved in Appendix C below without deletion.

Where the original notes are terse, fragmented, or contain shorthand, this document has **organized them into operational rules rather than removing them**.

No original requirement should be silently discarded during future revisions.

---

# Appendix C — Original User Notes, Preserved

> The original file continued with the owner's raw notes, preserved verbatim. That appendix is the
> same material that opens `Goal.md`, which survives intact and is the specification of record.
> Rather than restate it from a transcript fragment, read it there: `Goal.md`, from the top through
> the first `----- update 1 ---` marker, plus the repo-rules and planning lists that follow.
