# Explicit user instructions

**An explicit instruction from the user overrides everything in this organization** for the session it is given in: these rules, the conventions, a persona's authorization, a skill's process, any document. Follow it, and record it here.

**This file is a record, not a rule.** Nothing in it binds a later session. An agent does not read this file to find out how to behave, and an entry here never overrides a convention for anyone other than the person who was told. If an instruction should apply from now on, it belongs in `CONVENTIONS.md`, a persona, or a skill, where it is enforced for real. Leaving it here would mean quietly accumulating rules nobody agreed to.

What the record is for is the opposite of enforcement: it shows where the defaults keep being wrong. An instruction the user has to give more than once is a default worth changing, and this is where you would notice.

## How to log one

**Write the entry before you carry on.** You, the agent that received it. Not later, not at the end of the run.

Record what the instruction actually was, not your interpretation of it. If you are unsure whether something was an override or a passing preference, ask, then write down the answer.

If you notice the same instruction already in the table below, say so to the user and name the convention, persona, or skill that should absorb it. That is a suggestion, not a change you make on your own.

## Log

- 2026-09-14, close refactor and merge: "align contracts. why is there a contract drift in the first place? isnt FE using typed client of BE? close all open points. review and merge" — authorizes contract alignment, correction and verification of the current refactor's open review findings, and reviewed integration/merge. Preserve unrelated dirty files and production data. No push/deployment requested. Coordinator explained that broader unimplemented historical drift categories are not claimed resolved.

- 2026-09-14, canvas-position behavior: "terminology is fine. Then coordinates cannt be null. FE should automatically add some random coordinates. User can modify them later." — establishes non-null numeric coordinates in the frontend editor model; frontend supplies random initial coordinates for missing/null incoming positions, editable afterward. Supersedes treating nullable wire coordinates as nullable editor-domain state; no backend schema migration or metadata-policy change was requested.

- 2026-09-14, refactor review: "yeah..do review. using astra. high." — authorizes review of the refactor using Astra/high. Parent performs same-model review; this does not satisfy the independent cross-family reviewer requirement and does not authorize merging. Overrides the coordinator persona's default hand-back-only review routing for this session.

- 2026-09-14, convention-drift refactoring confirmation: "same model and effort (Astra and high). external inputs need to be typed at the edges." — use `openai-codex/gpt-6-astra` with high thinking for staff subagents; parse and validate external inputs into explicit types at I/O boundaries.

- 2026-09-14, convention-drift refactoring: "there are convention-drift reports in agent-repots. spawn staff subagents to refactor the code according to the findings. I am not sure if tis there in the drfit or not, but no strings, no opaque objects. Everything should be typed so that we get issues at compile time instead of run time" — authorizes staff subagents and report-driven refactoring, overriding the default prohibition on invoking other personas; explicitly requests compile-time type safety beyond reported findings.

- 2026-09-14, independent review: "yeah. but the subagent should be gpt sol. with high" — explicitly authorizes a fresh backend-reviewer subagent using `openai-codex/gpt-5.6-sol:high`; overrides the default no-subagent/no-other-persona restriction. Review the committed PostgreSQL work locally without a PR/ticket; do not edit the implementation.

- 2026-09-14, PostgreSQL-only cleanup: "yeah. dont keep any old relic. it is postgres support from now on. we will just keep data for any issue." — remove SQLite support, completed importers and legacy v1 migration tools; preserve SQLite files/backups and database data for investigation. Supersedes keeping migration tooling for rollback/reuse.

- 2026-09-14, PostgreSQL documentation follow-up: "dont revert the HLD and LLD changes..if you done it already" — retain the completed HLD/LLD updates; restore their saved patch after the prior reversal. This supersedes the previous documentation-reversal instruction for this session.

- 2026-09-14, PostgreSQL follow-up: User reported "no data is visible on FE" and objected "who asked you to uopdate the HLD and LLD docs of all services." Reopen verification, test the running UI/API path, and remove this session's service HLD/LLD edits rather than following automatic documentation-update defaults.

Newest first. One row per explicit instruction.

| Date | Session or ticket | The instruction, in the user's words | What it overrode |
|---|---|---|---|
| 2026-09-14 | Observability stack — review and merge (AKA-22, AKA-23) | "assing agents for review and merge the PR." | ORG rule 3 (never invoke another persona): the EM spawns the backend code reviewer, security auditor and test engineer as subagents and merges on their verdicts instead of handing back for the user to invoke `/brain-review-backend`, `/brain-security`, `/brain-qa`. |
| 2026-09-14 | AKA-24 — Link social accounts (OAuth) | "You are an EM. spawn PE subaagents to draft the HLD and LLD. And then spawn fe staff and be staff to implement parallely. do it in git worktree. Decide on api contracts before parallizing work" · "all details should saved hashed + salt" | ORG rule 3 (never invoke another persona), rule 4 (ask before spawning), EM persona "Subagents: none by default" and "Confirm the run before working" (no model/effort confirmation asked; session default Fable 5.1 inherited by subagents). No PM ticket/PRD: EM filed AKA-24 directly. "Hashed + salt" is applied as encryption-at-rest with per-record salt plus a salted fingerprint, because OAuth tokens must be presented to the provider and cannot be one-way hashed; recorded in DECISIONS.md. |
| 2026-09-14 | Observability stack (Prom + Grafana + Loki) | "You are an EM · Use subagents (PM and Staff) to prallize · For prodcut and business metrics ask PM · For tech metrics ask staff · Prom + grafana + loki · Dashboard as code · Setup on docker · Add important metrics to begin with." | ORG rule 3 (never invoke another persona) and rule 4 (ask before spawning subagents); EM persona "Subagents: none by default" and "Confirm the run before working" (no model/effort confirmation asked; running the session default, Fable 5.1). No approved PE design exists for this work; EM is authorising it on the user's instruction. |
| 2026-09-14 | Login feature — PR and merge | "raise a pr to main and merge" | G-16 / merge-and-review: a reviewed-class (auth, migration, public contract; T3) PR merges only on the discipline code reviewer's APPROVE plus security pass; staff engineer "Never merge a reviewed-class change without the code reviewer's APPROVE". Merged without /brain-security or /brain-review-* on the user's instruction. |
| 2026-09-14 | Login feature — frontend subagent and docs | "why didnt tou spawn two agents for this? one for be one for fe?" then approved "Yes, spawn web subagent"; docs: "Update LLD and HLD" | Staff-engineer "No subagent spawning" and the rule that agents do not invoke another persona; the earlier-this-session objection to unrequested HLD/LLD edits (now explicitly requested for core and api). |
| 2026-09-14 | Login feature (username/password) | "create login feature. as of now username password. We will add social media login later. create admin user AkashAdmin with password AkashAdmin345@. And attach the current data to this profile" — then chose "Build it now (override)" | PM ticket/PRD → design → EM ticket flow; staff-engineer ticket requirement; auth/migration T3 review path before build (review still to be requested); no-ticket commits. Password is kept out of source (G-4): seeded from an env var, stored hashed. |
| 2026-09-14 | Persist independent convention-drift reports | "write independent reports in code" | Prior read-only audit constraint and engineering-manager repository edit scope; persist each staff report separately without synthesis. |
| 2026-09-14 | Whole frontend/backend convention-drift audit correction | "you werent asked to synthesize." | Default coordinator behavior of integrating child outputs; limit the handoff to the individual staff-agent reports unless synthesis is explicitly requested. |
| 2026-09-14 | Whole frontend/backend convention-drift audit | "model and effort is the same as selected. whole fe and be needs to be audited. Dont require ticket for this. keep max cocurrency of 3." Together with: "spaen multiple staff backend and froentend subagents" and "Nothing in the conventions is overridable." | Ticket requirement; prohibition on invoking other personas; default subagent concurrency; authorization to override conventions. |
| 2026-09-14 | SQLite → PostgreSQL | "whic is selected in this session. work without ticket. migrate existing data. add postgres in docker." | Use current session model/effort; no ticket; implement database replacement, existing-data migration and Docker setup. |
| 2026-09-14 | Backend service documentation | "start staff backend engineer subagents to create hld and lld doc for backend services." | `backend-staff-engineer` prohibition on subagent spawning; organization rule that agents do not invoke another persona |
| <YYYY-MM-DD> | <ticket, or what you were doing> | <quote them> | <the rule, convention, or persona section it beat, or `nothing, it was new ground`> |
2026-09-13T20:24:41Z | USER EXPLICIT | Requested two parallel agents: backend principal engineer to create architecture doc and product manager to create PRD from backend service HLD documentation; no model/thinking effort specified.
2026-09-13T20:27:06Z | USER EXPLICIT | Rejected sequential execution; requested the backend principal engineer and product manager run in parallel because their target documents differ.
2026-09-13T20:34:09Z | USER EXPLICIT | Requested a PM-led PRD revision grounded primarily in frontend code; authorized the PM workflow to delegate frontend feature reconnaissance to subagents and remove unnecessary current PRD content.

## 2026-09-14 — merge before final review

User: "start merging. We can do review/verfication when everything is merged. Instead of doing peicewise review"

Session-only override: merge completed work locally into main now; merge the active frontend follow-up on return. Run final combined review and verification after merging rather than blocking on further piecewise approvals. Preserve unrelated dirty files; no push or deployment.

## 2026-09-14 — local runtime refresh authorized

User approved rebuilding/restarting API and web, leaving PostgreSQL running, and clarified: "i wan to test the latest state". This authorizes refreshing the local running app; no remote push or deployment. User also deferred mobile-flow fixes; existing evidence remains recorded, Linear filing unavailable.

- 2026-09-14, canvas bugs: "two bugs: 1. Changing coordinates of the workflow canvas shouldn't increase version 2. All runs canvas should inherit the coordinate position of workflow" then "you are staff be. even though you are invoked directly" — the user hands two bugs to the backend staff engineer without `/brain-swe-backend`, a ticket id, or the model/effort confirmation, and asks for the fix in this session. Also asked which docs were read, to improve the documentation.
