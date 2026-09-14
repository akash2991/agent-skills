# Learnings

What the organization learned from running in real projects. This is step 0 of the `self-improvement` skill applied to imported evidence: each section reads one project's `USER-EXPLICIT.md` and `WORK.md`, names the patterns, and turns them into friction tickets against the sources.

The raw records are copied verbatim under `docs/learnings/<project>/` so the analysis can be checked. Nothing here is a rule. A learning becomes a rule only by going through intake, a designed change, review, `npm run all`, and re-injection, and a guard is only loosened by the user.

Append a section per intake. Newest first.

---

## 2026-09-14 — slop (ContentOS)

**Evidence.** `docs/learnings/slop/USER-EXPLICIT.md` and `docs/learnings/slop/WORK.md`, copied byte-for-byte from `/Users/akashagarwal/Desktop/slop/.agent-brain/docs/` (working tree after slop commit `5e83e8b`, including rows not yet committed there). `docs/learnings/slop/USER-NOTES.md` holds the owner's own notes from three sessions (login feature, convention-drift refactor, PostgreSQL migration), pasted on 2026-09-14. Slop was injected on 2026-09-13 22:21 UTC from the product build of this repository at `34d1af0`. The records cover 2026-09-13 20:24 UTC to 2026-09-14 19:15 IST: two days, 46 logged runs, 25 override entries, across five harnesses (Pi, Hermes, Codex, OpenCode, Claude Code) and seven model ids.

### Headline

The organization was overridden on the same three defaults over and over. The user did not fight the rules once and give up; they gave the same instruction more than ten times in two days. By the skill's own standard, that is the strongest signal the file can produce.

| Default | Times the user overrode it | Where it lives |
|---|---|---|
| No agent invokes another; ask before spawning subagents | 12 entries | `org/20-how-agents-behave.md` rules 3 and 4, `agents/engineering-manager.md` "Subagents: none by default", staff engineer "No subagent spawning" |
| Every piece of work needs a ticket and enters through the PM | 6 override entries, 8 "user waived ticket" rows | rule 1 ("do not guess a ticket id"), `agents/staff-engineer.md` inputs, `agents/product-manager.md` reached-by |
| Confirm model and effort before working | 5 answers of "same as the session", 3 runs where it was never asked | rule 1 |

Everything else below is real but smaller.

### Patterns from USER-EXPLICIT.md

**1. The user wants an orchestrating EM, not a hand-back-only one.**
Twelve separate instructions asked an agent to spawn PE, PM, staff, reviewer, security, or QA subagents and run them in parallel. The latest, "assign agents for review and merge the PR", has the EM spawn the code reviewer, security auditor, and test engineer and merge on their verdicts, which is the whole downstream half of the flow run by one agent. Earlier ones: "start staff backend engineer subagents", "spawn multiple staff backend and frontend subagents", "why didn't you spawn two agents for this? one for BE one for FE?", "Use subagents (PM and Staff) to parallelize", "spawn PE subagents to draft the HLD and LLD. And then spawn FE staff and BE staff to implement parallelly. do it in git worktree. Decide on API contracts before parallelizing work". The last one is close to a complete operating model in one sentence: fan out by discipline and fix the contract first. The worktree was asked for once and the owner has since said it is not mandatory. Goal.md update 18 asked for a manual flow where the user runs every step. In practice the user runs the EM and expects the EM to run the rest. This is a design decision for the user to make in Goal.md, not something an internal review can settle, because rule 3 is what keeps the "a person runs this" invariant true. Recommendation: the user records in Goal.md whether the EM (and PM and PE for documentation work) may orchestrate subagents by default, and if so the org principal engineer designs it with the constraints the user already stated: contract exported as code before fan-out, and child runs logged as rows. Isolation in a worktree is an option the EM may choose, not a rule.

**2. Small work does not want the full hierarchy.**
Six overrides waived the ticket or the PM step: "work without ticket", "don't require ticket for this", "you are staff BE even though you are invoked directly", "Build it now (override)" on the login feature, and two EM sessions that filed their own tickets because no PM ticket or PRD existed. Goal.md already says the hierarchy is context dependent and a PM can hand small work straight to an EM. The persona inputs do not reflect that: `staff-engineer.md` requires one ticket id, and the org rule says never guess one. The gap is between what Goal.md allows and what the personas demand.

**3. Model and effort confirmation is asked at the wrong moment.**
Every time the user was asked, the answer for the invoked agent was the session's own model and effort. The only time a specific model mattered was for a subagent: "the subagent should be GPT Sol, with high", "same model and effort (Astra and high)" for staff children, "do review using Astra, high". Three EM runs skipped the question entirely and inherited the session default, which is what the user would have said anyway. Rule 1 should default to the session's model and effort and ask only when a child is about to be spawned.

**4. Documentation edits were applied too widely, then wanted, then wanted again.**
The SQLite to PostgreSQL migration edited 22 service HLD and LLD files across all services. The user objected to the breadth ("who asked you to update the HLD and LLD docs of all services"), reversed the objection once the edits were seen ("don't revert the HLD and LLD changes"), and later asked for doc updates explicitly on the login feature. The "update the docs in the PR that changes them" rule is right for the owning service; a change that touches every service's docs is a cross-service change that should have gone to a principal engineer for the architecture page, not to twelve LLDs. `documentation-map.md` does not say what a staff engineer does when a change spans services.

**5. Synthesis was not wanted.**
"You weren't asked to synthesize" and "write independent reports in code": the coordinator merged three audit reports into one and the user wanted the three originals, persisted. The EM persona's output shape assumes it summarizes what children return. When children produce reports, the default should be to persist each verbatim and summarize only on request.

**6. The typing conventions exist but were not being applied to existing code.**
"No strings, no opaque objects, everything typed so we get issues at compile time", "external inputs need to be typed at the edges", and "coordinates cannot be null" restate G-1, G-7, G-18, G-19, G-20, and O-11 from the conventions template. The conventions were right; the brownfield code drifted from them and the user had to say so. The `brownfield-adoption` skill produces a gap analysis and a roadmap, but nothing made the drift visible until the user asked for an audit. That audit then needed four attempts to start (see below).

**7. The review gate was overridden three times.**
"Start merging, we can do review and verification when everything is merged", "raise a PR to main and merge" with no security or reviewer pass on a T3 auth change, and a same-model review accepted as the review. Each is a session-only override of a guard, and each was recorded correctly. The guard should not change on this evidence alone, because the skill says a guard is loosened only by the user. What the evidence does say is that piecewise review of a parallel fan-out is slower than the user tolerates. A designed option, for the user to accept or refuse: when children are integrated in one worktree, one combined review of the integrated candidate replaces per-child review, with the security pass still mandatory for T3.

**8. One-off instructions worth keeping as decisions, not rules.**
"Hashed + salt" for OAuth tokens became encryption at rest with a salted fingerprint, recorded in the project's DECISIONS.md. "Nothing in the conventions is overridable" is the user drawing the line between process (overridable per session) and conventions (not). Both are single sightings.

### From the owner's own notes

The owner's transcript excerpts (`docs/learnings/slop/USER-NOTES.md`) are from the login-feature session and name three problems the records only hint at.

**9. One agent played two disciplines.**
Asked "what is your role?", the agent answered "backend/web staff engineer". The roster splits staff engineers by discipline for a reason: each carries a different set of skills and a different verification standard, and a web change needs real-browser verification a backend engineer will not do. The agent absorbed the frontend because no rule stopped it and rule 3 stopped it from spawning the web engineer. This is the same root as pattern 1, seen from the other side: forbid fan-out and an agent widens itself instead. Marked by the owner as "Problem: Dual role".

**10. A T3 feature was built with no design document.**
Asked "did you create any doc? lld/hld?", the agent said it had touched only the override record. The login feature is auth plus a migration plus a public contract, which is the highest review tier, and it went from a one-line request to code with no LLD. The "build it now" override waived the PM ticket and the PRD; it did not waive the design. Nothing in the staff engineer persona says that an override of the ticket step still requires an LLD, so the agent read the override as waiving everything upstream.

**11. An unagreed API contract was flagged as a gap instead of treated as a stop.**
Asked "have you agreed on api contracts?", the agent confirmed the auth contract was "unagreed and drift-prone since it's not generated into contracts/" and offered to flag it rather than fix it, then carried on with data migration. The owner's rule, verbatim: "api contracts and typed client is mandatory before any parallelization". O-25 already requires generated typed clients; the missing piece is sequencing. A contract that is not exported and generated is not a known gap to note in a report, it is the thing that blocks the next step. This strengthens F-slop-10 from "should" to "must", and it belongs in the EM's fan-out step and in the staff engineer's first step for any change that adds or changes an endpoint.

The second set of notes is from the convention-drift refactor, where an EM coordinated three staff engineers in separate worktrees.

**12. The EM verified the children's work itself instead of handing to QA.**
The EM's own plan reads "I inspect each diff and check compatibility, bring accepted changes in sequentially and rerun combined checks", and it did exactly that, running the test suites and strict type checks on each returned worktree and sending corrections back. It even said "my inspection isn't independent reviewer approval" and kept going. The roster has a test engineer for this. The EM persona owns the merge rule but says nothing about who verifies a child's work before integration, so the EM did it, and its context filled with test output and diffs that belong in a QA report. Marked by the owner: "It should have handed it to qa agent". Same root as pattern 1 again: forbidden from spawning, the coordinator absorbed the role.

**13. No contract alignment before the fan-out, so the halves drifted and had to be reworked.**
Backend and frontend staff worked in parallel from the audit findings with no shared contract. When the worktrees came back, "HTTP graph fields still advertise generic JSON rather than the new graph schema" and "the frontend and backend disagree on some previously accepted values". Two correction rounds followed (drift-api-3, drift-ui-2, align-api-2, align-api-3 in the work log). This is F-slop-10 a fourth time, and the most expensive instance: the rework was the whole tail of the session.

**14. Integration was batched to the end.**
The plan was to land everything only after every child returned and every correction was in, and the session ran long enough that the owner intervened with "start merging, we can do review when everything is merged". The north star is continuous delivery: every change small enough to merge on its own. A fan-out that holds all branches until the last one is green is the opposite, and it is what turned three parallel tasks into one long serial integration. Progressive landing, one accepted worktree at a time behind the contract, is the default that matches the north star. Owner's note: "Ran for too long, unless asked to progressively merge".

The third set of notes is from the SQLite to PostgreSQL migration, done by one backend staff engineer.

**15. A cross-service change was handed to a service-scoped engineer, who then read and edited every service.**
The staff engineer is scoped to one service. A database migration touches all of them. With nobody else to hand to, the agent read the core and migration HLDs and LLDs, then updated the HLD and LLD of every service, 22 files. The owner's notes name both costs: context pollution from reading across services, and doc edits outside the engineer's scope. The owner's rule is "only update docs in your service", and the fix for the rest is either a principal engineer owning the cross-service change or the staff engineer asking to fan out one child per service. This is the cause behind pattern 4 and F-slop-11: the doc edits were not a documentation rule misfiring, they were the visible symptom of routing a cross-service change to a single-service role. `context-scope.md` was read and did not stop it, because it does not say what to do when the task itself crosses the scope.

**16. Done without restarting the backend, twice now.**
"Will it suggest for testing? Didn't restart the BE." The completion claim came before the running API was restarted on the new database, and the next session found the frontend empty. This is F-slop-9 from the owner's side; recurrence goes to 2.

**17. Four scoping questions on a request the user considered clear.**
The agent asked four questions about scope and existing-data migration before starting. The owner listed it without a "Problem" tag, so it is a cost worth noting, not a fault. The persona asks for a ticket, owned paths, and a service, and without them it interviews the user. F-slop-2 covers the cause.

**What worked here.** Asked to review its own migration, the staff engineer declined ("I authored these changes, so I shouldn't provide independent approval") and asked permission to spawn a reviewer on the user's chosen model. That is rules 3 and 4 working as written, and the owner recorded no complaint. The docs the agent read (conventions, context scope, ORG, three skills, two services' HLD and LLD, and the compose file) are a reasonable set for the task; the problem was the task, not the reading list.

The fourth set of notes is from the convention-drift audit, where the invoked agent made itself the EM and fanned out three staff auditors on Pi.

**18. The two records are read in every context, and nothing tells agents to.**
The audit EM's first two reads were `USER-EXPLICIT.md` and `WORK.md`, before the conventions and before its own persona. The owner's correction: both files are read in every context. Neither is meant to be. The override record says in its own header that an agent does not read it to find out how to behave, and the work log is append-only. No source lists either as something to read; rule 11 and the persona command only say to append a row. Agents open them anyway, and both grow without bound, so the cost rises every session. The fix is in two places: `context-scope.md` should exclude them explicitly for every role except the self-improvement loop, and a code appender (F-slop-13) removes the reason to open the file at all.

**19. The agent chose its own role.**
Told to "spawn multiple staff backend and frontend subagents", the invoked agent answered "I'll act as the engineering manager coordinating backend and web staff audits". The owner asked how. Nothing invoked an EM; the agent inferred the role from the task shape and then applied the EM persona's reporting duties, which is how the unasked-for synthesis (pattern 5) happened. Its own explanation names the harness line "the parent owns integration and verification" and the EM persona as the sources. A role is assigned by the command that invokes it, not chosen from the request. When a request does not fit the invoked role, rule 2 says refuse and name the door.

**20. The fan-out plan was invisible until asked.**
The owner had to ask "what is this api, build and ui breakup?" and "what is the initial prompt for these subagents?" to learn how the audit was partitioned, and one partition's name was misleading enough that the agent said so itself. The plan was sound: three non-overlapping scopes at concurrency three, one shared instruction, a fixed report table, the persona each child must read, and one model at one effort. It should have been shown before launch. Any fan-out should print the partition, each child's role, persona, and prompt, and the model and effort, and wait for a yes.

Both refactor notes also confirm the model-family point in F-slop-8: the EM asked for a "different model family" reviewer as if it were a gate, and then explained that its own review "won't clear the independent merge gate". No such gate exists in the sources.

### Patterns from WORK.md

| Column | What the 46 rows show | What it means for the brain |
|---|---|---|
| In and Out tokens | UNKNOWN on 44 of 46 rows. The two rows with numbers are a whole-session total and a per-child total with no input/output split | Rule 11 asks for a number the control plane cannot produce per run on any harness in use. Either the usage hooks attribute tokens to a run, or the two columns are dropped and the session total is logged once |
| Effort | UNKNOWN on 12 rows | Same cause as tokens: the harness does not expose it and the agent did not ask |
| Skills used | UNKNOWN on 3 rows, all subagents, "not enumerated in handoff" | The staff engineer report has no field for skills loaded, so the parent cannot log a child run honestly |
| Outcome | 23 done, 15 partial, 5 blocked, 1 stopped, 1 "done, awaiting review" | A third of runs are partial. Most partials are a parent integrating child work and stopping before merge: expected in a fan-out, invisible in the schema |
| Model | 7 distinct ids, one corrected mid-run (`openai-codex/gpt-5.6-sol`), one reviewer that never started because the provider's allowance refused it | The model catalog and the harness adapters matter as much as the personas. A model id that does not resolve costs a run |
| Friction | see below | |

**Recurring friction, in order of cost.**

1. **Pi cannot spawn subagents outside tmux or zellij.** Four blocked runs on 2026-09-13 22:24 to 23:12 and 2026-09-14 08:09, all with the same error, before anyone could start the audit. Nothing in the sources mentions a multiplexer. The Pi target should state the prerequisite in its command, and a persona that is about to offer subagents should check the environment first. Recurrence: seen four times.
2. **Subagent handoffs do not carry what the parent has to log.** Skills loaded, effort, and tokens come back as UNKNOWN because the child report has no field for them. Suspected artifact: `agents-reports/staff-engineer-report.md` and the other report templates. Recurrence: three rows.
3. **A reviewer ran on the persona alone and approved.** One review "admitted loading only persona" and had to be rerun with its supporting skills. "Use only the skills it lists" is being read as "load at most these", not "load these". The reviewer persona should name the skills it must load, not may. Recurrence: once, but the approve was on a T3 refactor.
4. **The organization has no rule about review by a different model family, but agents behave as if it does.** Three rows treat a same-model review as not independent and go looking for a cross-provider reviewer, one of which failed to start. The only source is a suggestion in `code-review-and-quality`. Either it is a rule, in `merge-and-review.md`, or the skill should say it is optional. Recurrence: three rows.
5. **Contracts were briefed in prose before being exported as code.** The user caught it on the login feature. The EM later wrote the metric contract up front so two staff could start in parallel, which worked. The user's own phrasing, "decide on API contracts before parallelizing work", is the rule. Suspected artifact: `engineering-manager.md` and `milestone-planning`, foundation-first ordering. Recurrence: twice, once as a miss and once as the fix.
6. **Tests green, app broken.** After the database migration the backend suite passed, the Docker image built, and the frontend showed no data because the running API container had crashed on a missing dependency. The staff engineer's completion claim had to be corrected in a later row. `definition-of-done.md` should say that a change to something that runs locally is done when the running thing is exercised, not when its tests pass. Recurrence: once, high cost.
7. **The tracker was unreachable and nobody knew until a ticket was needed.** "Linear filing blocked by missing access" twice. Rule 9 says work lives in Linear; nothing checks access at the start of a run. Recurrence: twice.
8. **Log hygiene did not survive five harnesses.** The override record holds four formats in one file: a table, bullet entries, timestamped lines, and prose headers. The work log has rows out of date order and the template row left in the middle. Formatting by prose instruction fails across models; the fix is a `brain.js log` command that appends a row so the shape is enforced by code. Recurrence: continuous.
9. **Harness environment leaks.** Hermes inherited a `PYTHONPATH` that broke the project venv, Pi's managed worktree could not be resumed, `quota-axi` was not installed so quota was UNKNOWN on every routing decision. Each is a harness adapter concern, not a persona one.
10. **The seeded project docs were placeholders and stayed that way** until the user ran the PM and a PE in parallel to fill them from twelve service HLDs. `brownfield-adoption` should produce the project PRD and ARCHITECTURE on first injection, or the seed docs should say who fills them and when.
11. **The harness's own guard held when the org's did not.** Claude Code's "Merge Without Review" permission check blocked the squash-merge the user had authorized. Worth knowing when reasoning about what the org guard actually protects.

### Friction tickets

In the format the `self-improvement` skill asks for. Not yet filed; they go through `/brain-pm` and compete on priority with delivery. F-slop-1 and F-slop-8 need a Goal.md update from the user before design, because they move a rule that keeps an invariant.

```markdown
### Brain friction F-slop-1
- Hit by: engineering-manager, backend-staff-engineer, product-manager (slop) while: every piece of work with more than one discipline
- Friction: rules 3 and 4 forbid what the user asks for on every multi-discipline task: fan out to specialists, contract first (a worktree per child is optional, not required)
- What I did instead: user overrode, 11 times, recorded each time
- Cost: one override per task, plus the runs that were blocked or serialized before the override
- Suspected artifact: org/20-how-agents-behave.md rules 3–4; agents/engineering-manager.md; Goal.md update 18
- Recurrence: seen 11 times in two days

### Brain friction F-slop-2
- Hit by: backend-staff-engineer, engineering-manager (slop) while: small fixes, migrations, and features the user hands over directly
- Friction: personas require a ticket id and a PM step that Goal.md says small work may skip
- What I did instead: user waived the ticket (6 overrides, 8 logged rows)
- Cost: an override per task; two EMs filed their own tickets to satisfy the rule
- Suspected artifact: agents/staff-engineer.md inputs; agents/product-manager.md; org rule 1
- Recurrence: 6

### Brain friction F-slop-3
- Hit by: every persona (slop) while: confirming the run
- Friction: rule 1 asks for model and effort; the answer for the invoked agent is always "the session's"; the question only matters for children
- What I did instead: asked and was told "same as selected" 5 times; skipped it 3 times
- Cost: one round trip per run
- Suspected artifact: org/20-how-agents-behave.md rule 1; templates/commands/_persona.md
- Recurrence: 8

### Brain friction F-slop-4
- Hit by: engineering-manager on Pi (slop) while: starting the convention-drift audit
- Friction: Pi subagents need tmux or zellij; nothing in the brain says so
- What I did instead: blocked, four times, until the user relaunched inside a multiplexer
- Cost: four blocked runs, about half an hour on the first evening and again the next morning
- Suspected artifact: the Pi target in the build; the persona command template
- Recurrence: 4

### Brain friction F-slop-5
- Hit by: engineering-manager (slop) while: logging child runs
- Friction: subagent reports have no field for skills loaded, effort, or tokens, so the parent logs UNKNOWN
- What I did instead: logged UNKNOWN with "not enumerated in handoff"
- Cost: the work log cannot answer what a child run used
- Suspected artifact: agents-reports/staff-engineer-report.md and siblings; org rule 11
- Recurrence: 3

### Brain friction F-slop-6
- Hit by: every persona (slop) while: appending to WORK.md
- Friction: rule 11 asks for per-run tokens the control plane cannot attribute; 44 of 45 rows say UNKNOWN
- What I did instead: UNKNOWN, as the rule says
- Cost: the column carries no information; the cost question the log exists to answer is unanswerable
- Suspected artifact: control-plane usage hooks; org rule 11; templates/global-docs/WORK.md
- Recurrence: 44

### Brain friction F-slop-7
- Hit by: backend-code-reviewer on OpenCode (slop) while: reviewing the library refactor
- Friction: reviewer loaded the persona and none of its skills, and approved; "use only the skills it lists" read as an upper bound
- What I did instead: parent requested a re-review with the skills
- Cost: one wasted review on a T3 change
- Suspected artifact: agents/code-reviewer.md and the persona anatomy wording on skills
- Recurrence: 1

### Brain friction F-slop-8
- Hit by: engineering-manager (slop) while: getting a fan-out reviewed
- Friction: agents treat "different model family for review" as a rule; the sources only suggest it; per-child review of a fan-out was slow enough that the user overrode the gate three times
- What I did instead: same-model review, then user-directed merge before final review
- Cost: three guard overrides; one reviewer that never started
- Suspected artifact: references/merge-and-review.md; skills/code-review-and-quality; the review gate (a guard: user decides)
- Recurrence: 3

### Brain friction F-slop-9
- Hit by: backend-staff-engineer (slop) while: closing the PostgreSQL migration
- Friction: definition of done was satisfied by tests and a build while the running app was broken; the backend was never restarted on the new database before "done"
- What I did instead: corrected the completion claim in a later run after the user found the empty frontend
- Cost: a wrong "done", a second run, user trust; owner's note: "Didn't restart the BE"
- Suspected artifact: references/definition-of-done.md; agents/staff-engineer.md verification step
- Recurrence: 2

### Brain friction F-slop-10
- Hit by: engineering-manager, backend-staff-engineer (slop) while: parallelizing staff work, and the login feature
- Friction: no step says "export the contract and generate the typed client before fan-out or before touching the consumer"; it was briefed in prose once, and on login the agent confirmed the contract was unagreed and kept going
- What I did instead: the next EM wrote the contract first, which worked; on login the gap was flagged in a report instead of stopping
- Cost: one drift, two user catches, and on the refactor two full correction rounds across four child runs because BE and FE were fanned out with no shared contract; owner's rule: "api contracts and typed client is mandatory before any parallelization"
- Suspected artifact: agents/engineering-manager.md fan-out step; agents/staff-engineer.md first step for any endpoint change; skills/milestone-planning foundation-first; conventions O-25 (exists, not sequenced)
- Recurrence: 4

### Brain friction F-slop-11
- Hit by: backend-staff-engineer (slop) while: a cross-service database migration
- Friction: a change that spans every service was routed to a single-service role; with no way to hand off or fan out, the agent read other services' HLDs and LLDs and edited 22 service docs
- What I did instead: did it all in one context, then reverted and restored the doc edits on instruction
- Cost: context pollution, two extra runs, doc edits outside the owner's scope; owner's rules: "only update docs in your service", "should have asked subagents"
- Suspected artifact: references/context-scope.md (no rule for a task that crosses the scope); references/documentation-map.md (no owner for a cross-service change's docs); agents/staff-engineer.md (say "stop and name the PE or ask to fan out" when the task crosses services); coupled to F-slop-1
- Recurrence: 1

### Brain friction F-slop-12
- Hit by: engineering-manager (slop) while: filing tickets
- Friction: Linear unreachable, discovered only when a ticket was needed
- What I did instead: recorded the deferral in the log
- Cost: tickets not filed, twice
- Suspected artifact: skills/linear; org rule 9; the run confirmation step
- Recurrence: 2

### Brain friction F-slop-13
- Hit by: every persona on every harness (slop) while: appending to USER-EXPLICIT.md and WORK.md
- Friction: four different formats in one record; rows out of order; template row left in place
- What I did instead: each agent used its own idea of the format
- Cost: the records are hard to read by machine, which is what step 0 of this skill needs
- Suspected artifact: templates/global-docs/*.md; control-plane (a `brain.js log` appender)
- Recurrence: continuous

### Brain friction F-slop-14
- Hit by: engineering-manager (slop) while: returning three audit reports
- Friction: EM synthesized child reports; user wanted the originals persisted, unsynthesized
- What I did instead: rewrote the three reports byte-identical from the retained sessions
- Cost: one extra run
- Suspected artifact: agents/engineering-manager.md output; agents-reports/em-report.md
- Recurrence: 2

### Brain friction F-slop-15
- Hit by: product-manager, backend-principal-engineer (slop) while: first session after injection
- Friction: the seeded PRD and ARCHITECTURE were placeholders; brownfield adoption did not fill them
- What I did instead: user ran PM and PE in parallel to derive them from the service HLDs
- Cost: one orchestrated session
- Suspected artifact: skills/brownfield-adoption; templates/global-docs/PRD.md and ARCHITECTURE.md
- Recurrence: 1

### Brain friction F-slop-16
- Hit by: backend-staff-engineer (slop) while: the login feature
- Friction: one agent played backend and web staff engineer at once because it could not spawn the web engineer and nothing forbade widening itself
- What I did instead: wrote the frontend as a backend engineer until the user asked "why didn't you spawn two agents"; then a web subagent was approved
- Cost: frontend work done without the web skills or browser verification, redone by a web subagent; owner's note: "Problem: Dual role"
- Suspected artifact: agents/staff-engineer.md scope ("one discipline"); org rule 2 (stay in scope) does not name discipline as a boundary; coupled to F-slop-1
- Recurrence: 1

### Brain friction F-slop-17
- Hit by: backend-staff-engineer (slop) while: the login feature under the "build it now" override
- Friction: a T3 change (auth, migration, public contract) went from request to code with no LLD; the ticket waiver was read as waiving the design too
- What I did instead: built, then said "I'll run the suite while you decide on the docs"
- Cost: a T3 feature with no design record; docs written after the fact on instruction
- Suspected artifact: agents/staff-engineer.md (what an override of the ticket step does and does not waive); references/project-flow.md; skills/lld "When to Use"
- Recurrence: 1

### Brain friction F-slop-18
- Hit by: engineering-manager (slop) while: integrating three staff worktrees on the refactor
- Friction: the EM ran the test suites and type checks on each child's work and sent corrections itself; nothing says a child's work goes to the test engineer before integration
- What I did instead: verified in the parent, filling the EM's context with test output and diffs
- Cost: EM context spent on QA work; verification by the same agent that assigned the work; owner's note: "It should have handed it to qa agent"
- Suspected artifact: agents/engineering-manager.md (integration step names no verifier); references/definition-of-done.md; coupled to F-slop-1
- Recurrence: 1

### Brain friction F-slop-19
- Hit by: engineering-manager (slop) while: landing the refactor
- Friction: the plan held every worktree until all children and all corrections were done, then integrated in one go; the session ran long enough that the user had to ask for progressive merging
- What I did instead: batched integration, then merged before final review on the user's instruction
- Cost: the longest session in the log, and a guard override (F-slop-8) provoked by the wait; owner's note: "Ran for too long, unless asked to progressively merge"
- Suspected artifact: agents/engineering-manager.md integration step; org/00-north-star.md (continuous delivery says land each accepted piece alone); skills/incremental-implementation
- Recurrence: 1

### Brain friction F-slop-20
- Hit by: every persona (slop) while: starting a run
- Friction: USER-EXPLICIT.md and WORK.md are read in every context although both are append-only and no source says to read them
- What I did instead: read them anyway, first, before the persona and conventions
- Cost: context spent on two files that grow every session and carry nothing the role decides with; owner's correction: "work.md and explicit.md is always read in every context"
- Suspected artifact: references/context-scope.md (exclude both explicitly, except for self-improvement); control-plane appender (F-slop-13) so appending needs no read; templates/commands/_persona.md wording on "append"
- Recurrence: continuous

### Brain friction F-slop-21
- Hit by: the agent invoked for the audit (slop) while: asked to spawn staff subagents
- Friction: the agent made itself the EM from the task shape, then inherited the EM's reporting duties and synthesized reports nobody asked for
- What I did instead: "I'll act as the engineering manager"; later "I exceeded your request"
- Cost: an unasked-for consolidated report, a rerun to persist the originals (F-slop-14); owner's question: "It automatically assumed the role of EM. how"
- Suspected artifact: org rule 2 (a role comes from the command that invoked it, never from the request); templates/commands/_persona.md
- Recurrence: 1

### Brain friction F-slop-22
- Hit by: engineering-manager (slop) while: launching a fan-out
- Friction: the partition, each child's prompt and persona, and the model were only shown when the user asked; one partition name was misleading
- What I did instead: launched, then explained on request
- Cost: two clarification round trips; the user could not check the scopes before they ran
- Suspected artifact: agents/engineering-manager.md (print the fan-out plan and wait); agents-reports/em-report.md (a field for the plan)
- Recurrence: 1
```

### What worked, and should not be lost while fixing the above

- Every override was recorded, with what it overrode. The record did its job: this section exists because of it.
- `VERIFIED NOW` versus `REPORTED` labelling was used consistently, and it caught a wrong completion claim (F-slop-9) and a reviewer who had not loaded its skills (F-slop-7).
- Contract-first parallelization, once an EM did it, let two staff engineers land an observability stack side by side in about forty minutes each.
- A recorded decision (tokens cannot be hashed, so encrypt with a salted fingerprint) replaced a literal reading of an instruction, and the user accepted it.
- The harness permission gate held when the org gate had been overridden.
- Asked to review its own migration, the staff engineer refused and asked to spawn an independent reviewer instead. Rules 3 and 4 as written, with no complaint from the owner.

### Next

1. The user decides F-slop-1 and F-slop-8 in Goal.md, because both move an invariant.
2. File the rest through `/brain-pm` as friction tickets against `brain-org` or `brain-platform`.
3. Quick, low-risk wins to take first: F-slop-4 (state the Pi prerequisite), F-slop-5 (add the fields to the report templates), F-slop-13 (a `brain.js log` appender), F-slop-12 (check tracker access at run start). Also tightening-only, so no user decision needed: F-slop-10 (contract and typed client before fan-out or consumer work), F-slop-16 (one discipline per staff engineer), F-slop-17 (a ticket waiver never waives the LLD for a T2 or T3 change), F-slop-19 (land each accepted piece as it is ready, never batch a fan-out), F-slop-20 (exclude the two records from every role's reading list), F-slop-21 (a role comes only from the invoking command), F-slop-22 (show the fan-out plan before launch).
5. F-slop-18 depends on F-slop-1: an EM can only hand child work to the test engineer if it is allowed to spawn one.
4. After each change: `npm run all`, `npm run inject:self`, new session, and note here whether the friction stopped.
