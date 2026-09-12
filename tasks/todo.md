# Agent Work Observatory Tasks

## Task 1: Define telemetry contract and architecture

**Description:** Record the researched tool decision, privacy defaults, capability matrix, and a versioned event contract.

**Acceptance criteria:**
- [x] Every Update 11 signal and control maps to a component.
- [x] Event fields distinguish exact, measured values from unavailable values.
- [x] Sources for Herdr, OpenTelemetry, and Langfuse are recorded.

**Verification:**
- [x] Schema and examples are exercised by the focused test.

**Dependencies:** None

**Files likely touched:** `references/agent-observability.md`, `templates/observability/event.schema.json`

**Estimated scope:** Small

## Task 2: Build the event emitter

**Description:** Add a dependency-free CLI/module that validates a telemetry envelope and appends one JSON object per line.

**Acceptance criteria:**
- [x] Invalid events are rejected without writing.
- [x] Valid events receive missing timestamp/event id values and append atomically enough for single-host agent use.
- [x] Event content cannot include raw prompt/response/document bodies.

**Verification:**
- [x] `npm run test:observability`

**Dependencies:** Task 1

**Files likely touched:** `templates/observability/emit.js`, `scripts/brain/observability-test.js`

**Estimated scope:** Small

## Task 3: Build the local tree dashboard and controls

**Description:** Aggregate registry and event data into a human and JSON dashboard, with explicit Herdr focus/steer/interrupt/stop commands.

**Acceptance criteria:**
- [x] Parent-child tree and per-agent usage/skill/document/tool summaries render correctly.
- [x] Missing measurements display as `UNKNOWN`.
- [x] Controls require a Herdr runtime binding and invoke argv without a shell; interrupt and pane-closing stop require confirmation.

**Verification:**
- [x] `npm run test:observability`

**Dependencies:** Tasks 1-2

**Files likely touched:** `templates/observability/dashboard.js`, `scripts/brain/observability-test.js`, `templates/registry/registry-entry.schema.json`

**Estimated scope:** Medium

## Checkpoint: Local dashboard

- [x] Focused tests pass.
- [x] A fixture renders the expected hierarchy and totals.

## Task 4: Wire assets into build and validation

**Description:** Copy observability templates into every generated target and fail validation when required assets are missing.

**Acceptance criteria:**
- [x] Every target contains `.agent-brain/observability/`.
- [x] Config is a seed; maintained scripts/schema/docs are owned files.
- [x] Build validation covers required assets.

**Verification:**
- [x] `npm run validate`
- [x] `npm run all`

**Dependencies:** Tasks 1-3

**Files likely touched:** `scripts/brain/build.js`, `scripts/brain/validate.js`, `package.json`

**Estimated scope:** Medium

## Task 5: Add organization obligations and operator docs

**Description:** Make telemetry emission and runtime binding part of delegation, registry, CEO/EM visibility, and the injected brain guide.

**Acceptance criteria:**
- [x] Agents report skill/document/turn/tool/model usage at defined lifecycle points.
- [x] CEO status flow uses the dashboard and never treats reported data as runtime truth.
- [x] Herdr and Langfuse setup remains optional and requires explicit installation/configuration.

**Verification:**
- [x] `npm run validate`
- [x] `npm run all`

**Dependencies:** Task 4

**Files likely touched:** `templates/org/`, `templates/registry/`, `agents/`, `docs/brain.md`, `skills/observability-and-instrumentation/SKILL.md`

**Estimated scope:** Medium

## Checkpoint: Complete

- [x] All success criteria in `SPEC.md` are met.
- [x] Focused tests, validation, and all target builds pass.
