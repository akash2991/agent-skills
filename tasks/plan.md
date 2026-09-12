# Implementation Plan: Agent Work Observatory

## Overview

Deliver one portable observability contract and local dashboard, using Herdr for live agent control and optional Langfuse for trace exploration. Keep the first increment dependency-free and injectable across all existing targets.

## Architecture Decisions

- Separate control from telemetry: Herdr owns terminal/runtime operations; Agent Brain owns organization identity and telemetry semantics.
- Store local events as append-only JSONL so every host can emit without an SDK dependency.
- Align standard model/agent/tool fields with OpenTelemetry GenAI and namespace Agent Brain additions for skills, documents, hierarchy, and control.
- Capture metadata by default, content only through an explicit future opt-in.
- Keep Langfuse optional because its dashboard solves trace/cost exploration but cannot steer or stop coding-agent terminals.

## Task List

### Phase 1: Contract and decision record

- [x] Task 1: Define the agent telemetry contract and researched architecture.

### Checkpoint: Contract

- [x] Schema examples validate and every Update 11 requirement maps to an owner.

### Phase 2: Local usable slice

- [x] Task 2: Test and implement the event emitter.
- [x] Task 3: Test and implement tree/usage aggregation and safe Herdr controls.

### Checkpoint: Local dashboard

- [x] Focused tests pass and the dashboard works from a temporary injected fixture.

### Phase 3: Injection and organization wiring

- [x] Task 4: Emit observability assets from every target and validate them.
- [x] Task 5: Update registry, personas, organization rules, and documentation.

### Checkpoint: Complete

- [x] `npm run test:observability`, `npm run validate`, and `npm run all` pass.
- [x] Generated Codex output contains the observability assets and documentation.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Agent hosts expose different hook payloads | High | Stable JSONL contract plus adapters; unavailable fields stay `UNKNOWN`. |
| Context capture leaks source or prompts | High | Metadata-only default; no content field in the v1 schema. |
| Herdr is mistaken for a full tracing backend | Medium | Explicit capability matrix and optional Langfuse integration. |
| Runtime control targets the wrong process | High | Require an explicit registry runtime binding and use argv execution, never a shell. |
| Generated assets drift | Medium | Build validation and generated-output assertions. |

## Open Questions

- Browser UI and automatic per-host hook installers are intentionally deferred pending use of the first local slice.
