# Brain review, 2026-10-20

What the brain's own usage says about its philosophy (one main agent adopts one persona, fetches skills on demand, spawns persona subagents, and conventions are rules with ids), what should change, and the experiments the recommendations rest on. Every number below is reproducible with `scripts/sessions/` and `evals/lab/`.

## Sources

| Source | Size |
|---|---|
| Claude Code main-session transcripts, slop and freedo (`~/.claude/projects/`) | 32 sessions, 416 human turns, 4.6 B input tokens incl. cache |
| Claude Code subagent transcripts, same projects | 326 subagents, 16.6 B input tokens incl. cache |
| Pi sessions, slop and freedo incl. worktrees and Herdr tabs (`~/.pi/agent/sessions/`) | 59 sessions, 669 human turns, 1.1 B input tokens, $874 reported cost |
| `docs/LEARNINGS.md` in slop and freedo | 134 notes (slop 104, freedo 18, plus unfenced ones) |
| Lab experiment (`evals/lab/`), Claude Code 2.1.304, `claude-opus-5-5` pinned | 2 tasks x 4 arms x 3 runs |
| Routing experiment (`evals/lab/route.py`), `claude-haiku-5-5` | 370 real prompts (55 session openers, 315 subagent briefs) x 2 persona schemes |
| Literature survey | see "External evidence" |

Langfuse holds 21 traces, all from today's instrumentation test, so it contributed nothing yet.

## Findings

### 1. The persona layer is thin on the main agent, and it is a prompt on subagents

- Claude Code main sessions declared a persona in 3 of 32 sessions and read a persona file in 0. The `/brain` command was used once.
- Pi sessions (the harness used for most subagent work in September) declared or were injected a persona in 31 of 59 sessions and read at least one skill in 46 of 59.
- Of 326 Claude Code subagents, 286 were told a persona in their opening brief ("You are the backend staff engineer…"), 30 opened the persona file, 0 read `AGENTS.md`, and 307 read no skill at all. The persona reaches a subagent as a sentence in the brief, not as a file it adopts.
- `AGENTS.md` says "Give it a persona and a scope; it loads its own skills and tools." The transcripts say it does not: 94% of subagents loaded none.

### 2. Skills are cheap to load and rarely loaded

- Across 59 Pi sessions, skill reads cost 1.3 M tokens of 1,111 M input tokens (0.1%). Across 326 Claude subagents, 0.2 M of 16,573 M. Context cost of skills is not the problem; the brain's SKILL.md files total 60 k words and the largest is 3.9 k.
- Skills read in Pi, by count: git-workflow 46, test-driven-development 38, development-setup 33, coding-standards 33, continuous-delivery 31, linear 30. Never or almost never read: hld 2, lld 5, prd-writing 1, adrs 1, spec-driven-development 1, performance-optimization 0, herdr-fanout 0, ci-cd-and-automation 4.
- The learnings record the consequence: "The main agent had declared coding-standards and domain-modeling but only grepped them, and its subagent prompts never stated the rule, so it was enforced by nobody" (slop, 2026-09-28).

### 3. The failure mass is coordination and mechanics, not persona routing

134 learning notes classified by theme (`scripts/sessions/classify-learnings.py`, Sonnet, one theme each):

| Theme | Notes | Share |
|---|---|---|
| C. A skill silent or wrong on a specific mechanical procedure (gh merge from a worktree, stacked PRs, contract/consumer/generated-client ordering, additive fields vs closed decoders, migration renumbering, mocks, ports, simulators, missing PR template) | 60 | 45% |
| A. The main agent coordinating parallel subagents (briefs, shared files, merge conflicts, test-suite gating, worktrees, locks, stuck agents, destructive cleanup, approvals not reaching subagents, Linear hygiene when cutting a breakdown) | 27 | 20% |
| B. The owner set a process gate aside for speed (per-PR review, full suite per PR, PR size, approval, verification before Done, security work) | 20 | 15% |
| G. A product or engineering rule the owner stated that no skill had (concurrency policy, data-migration policy, product changelog, terminology) | 13 | 10% |
| D. Design discipline skipped (HLD/LLD skipped, contract called "the design", redesign dropped features, UI inconsistent across boards, cross-service table reads) | 7 | 5% |
| F. Declaration ceremony (model, effort, persona, status comments) | 4 | 3% |
| E. A persona's skill or tool list did not match its work (PM lacking git skills, scout without tools, mobile emulator) | 3 | 2% |

Persona-boundary problems (E) are 2% of what went wrong. The 39 user corrections found in transcripts tell the same story: the most frequent one is "what are you waiting for?" (8 of 39), then Linear state hygiene ("why are tickets in merged, not done?"), invented vocabulary ("wave"), and the declaration ceremony. None is "wrong persona".

By skill named in the notes: development-setup 44, git-workflow-and-versioning 28, test-driven-development 22, continuous-delivery 13, AGENTS.md itself 24 (12 unqualified, 5 "Your agents", 3 "How you work", 2 "You", 2 "How you work 6"), linear 11, database 11, coding-standards 10.

### 4. The same gates are overridden again and again

Overrides (27 explicit, 20 by theme) cluster on four rules: per-slice review (overridden 2026-09-14 twice, 2026-09-28, 2026-10-04, 2026-10-05), the full suite before every merge (2026-09-14, 2026-10-18, 2026-10-19), PR approval by a reviewer (freedo 2026-09-21 twice, slop 2026-09-28 "assume all PRs are approved", 2026-10-05), and "deployed/verified means production" (2026-09-23 freedo, 2026-09-27 slop). The LEARNINGS template says "the same override twice means the rule is wrong"; these rules are still unchanged in `git-workflow-and-versioning` P10 and `test-driven-development`.

### 5. The learnings loop is open

Since 2026-09-21 the brain received 18 commits touching skills, personas or `project/AGENTS.md`, mostly development-setup cloud rules. Searching the brain for the recurring notes: stacked PRs / retarget (3 notes) 0 hits; consumer issue for a contract change (3 notes) 0 hits; additive field vs closed decoders (4 notes) 0 hits; PR template (2 notes) still missing from `templates/`; standing approval reaching subagents 0 hits; file ownership per agent 5 hits but no rule; product changelog 0 hits. One slop note says explicitly: "The same finding was recorded on 2026-09-28 15:45 … and was not acted on."

### 6. Cost sits in the main agent's context, not in the brain

The 32 Claude main sessions consumed 4.6 B input tokens (one session alone 2.0 B over 53 turns and 86 subagent spawns); the 326 subagents 16.6 B. The brain files account for well under 1% of either. The levers on cost are session length, the number of subagents, and the summaries that come back, which is where the coordination notes (theme A) point too.

### 7. Lab experiment: what a brief does and what a persona does

Two tasks on a 12-file two-service repository (`evals/lab/`), four briefs: `pointer` (brain installed; the brief names the persona and says to fetch skills, as `project/AGENTS.md` prescribes), `embedded` (brain installed plus the three applicable rules restated in the brief), `rules-only` (no brain, rules restated), `none` (ticket only). Deterministic graders on the diff and trace. Full tables in `evals/lab/results-2026-10-20.md`.

| task, model | arm | input kTok | boundary_ok | compat_ok | test_first | persona file read |
|---|---|---|---|---|---|---|
| 1, opus | pointer / embedded / rules-only / none | 1285 / 1067 / 394 / 256 | 3/3 all | 2/3, 2/3, 3/3, 2/3 | 3/3, 3/3, 3/3, 1/3 | 3/3, 3/3, –, – |
| 2, opus | pointer / embedded / rules-only / none | 1304 / 990 / 492 / 279 | 3/3 all | 3/3, 3/3, 3/3, 1/3 | 3/3, 3/3, 3/3, 0/3 | 3/3, 3/3, –, – |
| 2, sonnet | pointer / rules-only / none | 586 / 240 / 305 | 2/3, 3/3, 3/3 | 0/3, 3/3, 2/3 | 0/3, 1/3, 0/3 | 3/3, –, – |

- The rule in the brief is what changes behaviour. `rules-only` matched or beat the installed brain on every grader, on both models and both tasks, at a third of the tokens. `embedded` (brain plus rules) was never worse than `pointer` and cost less.
- The brain's gain over the bare ticket on Opus is test-first and the contract/consumer handling; a three-line brief delivers both.
- On Sonnet the brain arm was the worst arm (one boundary violation, 0/3 compat), and the only arm where the agent, having read a persona that forbids web edits, shipped a required field that breaks the web and left the fix to someone else. Small n, but the direction matches the published persona and instruction-overhead results.
- When the brief says "read your persona and fetch your skills", Opus does (3/3, 4 to 7 skills read in full). The 326 real briefs did not say it, and 307 of those subagents read nothing. The mechanism works when the brief carries it, and the brief is written by the main agent, which has no rule telling it to.

### 8. Routing experiment: nine personas vs four

370 real prompts (23 Claude Code session openers, 32 Pi session openers, 315 Claude Code subagent briefs) were routed by `claude-haiku-5-5` to exactly one persona or NONE, under the current nine personas and under a four-persona scheme (product-manager, engineer, reviewer, scout).

| Scheme | NONE | Low confidence (<0.7) | Routed to |
|---|---|---|---|
| nine (current) | 57/367 (16%) | 148/367 (40%) | backend-engineer 109, web-engineer 74, scout 41, code-reviewer 29, product-manager 27, security-auditor 13, test-engineer 10, mobile-engineer 7 |
| four | 42/370 (11%) | 142/370 (38%) | engineer 199, scout 52, reviewer 47, product-manager 30 |

The two schemes agree on 312 of 370 prompts (84%) once backend/web/mobile are mapped to engineer and the four reviewers to reviewer; the disagreements are ticket-titled briefs the nine-scheme sent to product-manager and the four-scheme to engineer. The important number is by source: what the owner types at the main agent fits no persona 12 of 23 times on Claude Code and 22 of 32 times on Pi ("add langfuse to this project", "do it in a worktree, add metrics, spawn subagents, ask PM…", "create a local dev env on railway"). Subagent briefs route cleanly (NONE 23 of 315). The persona table describes the subagents well and the main agent's job not at all. Collapsing to four personas loses nothing measurable here and removes 5 files; it does not fix the main-agent gap, which needs a persona of its own.

### External evidence (survey, 2026-10-20)

- Persona prompting on frontier models is neutral to slightly positive at best, and irrelevant persona detail costs up to ~30 points (Zheng et al. 2024, arXiv 2311.10054; "Principled Personas", arXiv 2508.19764; arXiv 2605.29420). Anthropic's subagent guidance puts the value in the checklist, tool allowlist, output format and task boundaries after a one-line role, and states that a subagent sees only its system prompt, the task message and CLAUDE.md: "if a rule must reach the subagent, restate it in the delegation prompt" (code.claude.com/docs/en/sub-agents).
- MAST (arXiv 2503.13657, 1,642 traces): role disobedience is 1.5% of multi-agent failures; task-spec disobedience, step repetition, termination and verification failures are over 55%. Adding a verification step was the single largest intervention (+15.6 points).
- Orchestration prompts are a weak, distinct capability: 33 models writing delegation prompts reached a 17.2% average combined pass rate (PerspectiveGap, arXiv 2606.08878). 27.67% of 142 k agent PRs hit merge conflicts (AgenticFlict, arXiv 2604.03551). Cognition: share full traces, not summaries; parallel subagents make conflicting implicit decisions.
- Always-on context files do not raise correctness and cost >20% in one study (Gloaguen et al., arXiv 2602.11988; also arXiv 2607.27250); a 1,650-session factorial study found file size, rule position and contradictions had no detectable effect on compliance, only within-session decay (arXiv 2605.10039). Anthropic: a bloated CLAUDE.md makes rules get ignored; convert must-always rules into hooks.
- Evals: `claude plugin eval` runs 3x per case per arm with a baseline arm and reports the delta; skill-creator's trigger recipe is 20 queries x 3 runs with a held-out split; SkillOpt (arXiv 2605.23904) accepts a skill edit only when a held-out eval strictly improves and keeps a rejected-edit buffer.

## Recommendations

Each is tied to a finding and comes with the eval that accepts or rejects it.

1. **Make the brief the unit of delivery, not the persona file (findings 1, 2, 7).** Replace "Give it a persona and a scope; it loads its own skills and tools" with a brief template every spawn must fill: role line, ticket verbatim, the rule ids that apply with their text pasted, owned files, the test command, the stop condition, the report shape. The persona file becomes the source the template is filled from. Eval: `evals/lab` arm `pointer` vs `embedded` on both tasks; accept when the embedded brief wins on `boundary_ok`, `order_named` and `test_first` at 3 runs per arm.
2. **Add the persona that does most of the work and has none: the lead (findings 3, 6).** The main agent on Claude Code is a coordinator (343 spawns in 32 sessions) and 20% of all learnings are about that job. Give it a persona with the coordination rules the notes already wrote: one owner per shared file, registries change in their own tiny PR first, one full suite per merge wave in its own worktree, long waits in the background, cleanup only by an exact list, check each subagent's evidence on every notification, retarget stacked PRs before deleting a base. Eval: a second lab task where the agent must brief two subagents on overlapping files; graders on the briefs (file ownership named, rules pasted, stop condition present).
3. **Collapse backend-, web- and mobile-engineer into one `engineer` persona with a discipline parameter (findings 3, 8).** The three files share 17 of 28 lines; the differences are 3 to 6 guideline bullets and a few skill rows. Keep the discipline-specific bullets as a table inside the one file. Do not add personas: the four reviewer personas (code-reviewer, test-engineer, security-auditor, web-performance-auditor) were spawned 3, 2, 3 and 0 times on Claude Code and 5, 5, 0, 0 on Pi, and they still carry the upstream 95- to 184-line inline-process shape that `persona-anatomy.md` forbids. Fold the three reviewers into one `reviewer` persona whose checklists are skills. Eval: the routing experiment (NONE rate and low-confidence rate must not rise under the four-persona scheme), and `validate-agents.js` with the 40-line limit enforced.
4. **Change the four rules the owner keeps overriding (finding 4).** P10 becomes "review is per merge wave unless the ticket says per PR"; the full-suite rule becomes "targeted tests per PR, one full suite per wave on main in its own worktree, fixes in follow-up PRs"; "deployed" is defined per project in `docs/DEVELOPMENT.md` with local Docker as the default; approval is a project setting the owner records once. Eval: count of `override` notes on these rules in the next two sprints; target zero.
5. **Close the loop with a ledger, not a hope (finding 5).** Add `evals/learnings-ledger.md`: one row per LEARNINGS note that recurs (note ids, skill, change PR or "open"). A note that recurs twice becomes a ticket on the brain. Start with the 8 recurring ones named in finding 5. Eval: the ledger's open count, reviewed each sprint.
6. **Spend eval effort where the mass is: mechanics (finding 3, theme C).** The Tier-2 trigger evals check that a skill fires; nothing checks that `github`'s merge mapping works from a worktree or that a contract change carries its consumer. Add execution evals with fixtures for the top-5 mechanics gaps (stacked PR merge, contract + consumer, additive field with closed decoders, migration renumbering, PR template) to `evals/cases/`. Eval: these cases exist and pass on the pinned model.
7. **Leave `AGENTS.md` short and move situational rules out (external evidence, finding 2).** `project/AGENTS.md` is 2.5 k words plus a 19-row stack table and a 20-row architecture table that every agent loads every turn; three studies find no correctness gain from always-on context and one finds >20% cost. Keep the organization, the ten "how you work" rules and the persona table; move the S and A tables into `coding-standards`/`hld` (they already cite them) and the project section into `docs/`. Eval: trigger evals unchanged, lab arms unchanged, input tokens per turn down.
8. **Instrument before the next structural change (Goal.md's own requirement).** Today's `--langfuse` install gives per-turn traces; add the three fields the analysis had to reconstruct from transcripts: persona declared, skills opened, brief length. `scripts/sessions/` is the fallback until Langfuse carries them.

## How to re-run

```bash
python3 scripts/sessions/mine-claude-sessions.py ~/.claude/projects/-Users-akashagarwal-Desktop-slop ~/.claude/projects/-Users-akashagarwal-Desktop-freedo
python3 scripts/sessions/mine-pi-sessions.py '~/.pi/agent/sessions/*slop*/*.jsonl' '~/.pi/agent/sessions/*freedo*/*.jsonl'
cd evals/lab && ./setup.sh && ./drive.sh claude-opus-5-5 3 pointer embedded rules-only none && python3 regrade.py
PROMPTS=prompts.json python3 evals/lab/route.py            # prompts.json: [{"src", "text"}] from the miners' OUT files
python3 scripts/sessions/classify-learnings.py notes.json  # notes.json: [{"project", "text"}] split from docs/LEARNINGS.md
```

Raw prompt text and the raw learning notes are not checked in; `evals/lab/results-2026-10-20/routing.json` keeps the source, length and routes of each prompt, and the theme counts above are the record of the classification.
