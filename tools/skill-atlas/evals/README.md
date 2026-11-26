# Offline skill eval starter

Four fixed cases test planning, TDD, review and debugging. **No API calls, agent launches or measured agent results are included.** `results.example.json` is deliberately unrun with null scores. Python 3.10+ and Node 18+ are the only requirements. No package installation is needed.

## Files and boundaries

- `../evals.json`: workbench protocol, case prompts, stages, rubric weights, fixture locations and grader commands. Weights sum to 100 per case.
- `fixtures/<case>/`: tiny fixed public inputs. Copy only the selected directory into the agent workspace.
- `private/`: grader-only held-out assertions and manual acceptance guide. Do not expose to the agent, along with the harness, selftest or workbench rubric/checks. They are repository-visible, not secure secrets.
- `harness.py`: validates submission structure, planning graph/ownership/capacity, and review source preservation; executes held-out behavior and submitted regression replay for TDD/debugging.
- `selftest.py`: hand-written harness tests and reference implementations, NOT agent baselines or benchmark scores. Withhold these too.
- `results.schema.json` and `results.example.json`: result format and honest unrun example. Schema is documentation; no third-party JSON Schema validator is bundled.

## Reproduce harness verification

From the repository root:

```sh
python3 evals/selftest.py
```

The four test groups cover fixed solutions passing, broken fixtures failing, vacuous and always-failing regressions rejected, planning dependency errors, unchanged-review checks, known review defects, malformed JSON and missing artifacts. This verifies the grader plumbing, not model skill effectiveness. Tested locally with Python 3.14.7 and Node 22.23.2.

## Prepare a measured submission (external runner or human-operated agent)

This starter does not launch a runner. Create a fresh isolated workspace, copy `evals/fixtures/<case>/` contents, supply **only** the selected `prompt` from evals.json and this section's submission contract, and enable the chosen treatment skill if applicable. Neither condition may inspect grader files. Do not give the entire repository to the agent. Planning's code paths are design context only: no code fixture or runnable implementation is implied.

### Common artifact submission instructions (give to both conditions)

Work only inside the copied fixture directory. Keep the fixture's API and filenames. Do not use network access or install dependencies. Submit your final directory including all unchanged public fixture files and the case-requested artifacts. Code tests must use Node built-ins, live in `regression.cjs`, import `./index.cjs`, and run via `node regression.cjs`. Include `notes.md` with commands, observed outcomes and limitations. For planning also provide `plan.md` and `plan.json`; for review provide `review.json` and do not edit source files. Logs must distinguish observed evidence from claims.

The **runner**, not the agent, adds `run.json` and captures `transcript.jsonl`. Every transcript JSON line has `sequence` (monotonically increasing integer), `timestamp` (ISO-8601), `event` and `content`; capture prompts, tool inputs, outputs, cwd, exit codes, timestamps and ordered file edits. Preserve raw provider transcript alongside normalized events. Do not reconstruct chronology from the final files.

`run.json` fields:

```json
{
  "case_id": "tdd",
  "status": "submitted",
  "condition": "control",
  "seed": 17,
  "model": {"provider": "RECORD", "id": "RECORD", "version": "RECORD", "temperature": "RECORD", "seed_supported": false},
  "tools": ["RECORD exact tool names and configuration"],
  "budget": {"wall_seconds": 1200, "total_tokens": 12000},
  "usage": {"elapsed_seconds": null, "input_tokens": null, "output_tokens": null},
  "skill": null,
  "environment": {"node": "RECORD", "python": "RECORD", "os": "RECORD", "fixture_sha256": "RECORD"}
}
```

This is a metadata template, **not a completed run**. Fill actual values; label unavailable usage rather than inventing it. Treatment `skill` must record source path, commit, SHA-256 and archived exact bytes; control is null. Archive system/user prompt bytes and hashes, fixture hashes, runtime versions, runner config, start/end times, tool transcript, final artifacts and subsequent grader reports. Never put a report inside the submission directory, where it would change its hash on rerun.

## Grade submitted artifacts

Run only in a **disposable OS/container sandbox**, with no secrets, network or writable host mounts. Submitted JS is arbitrary code. Python subprocess timeouts and temporary copies are not a security sandbox, do not cap all resource use, and cannot defeat malicious code or forged process exits. Review submitted files for symlinks and unsafe code before grading. Use an external CPU/memory/process/output limit for untrusted submissions.

```sh
python3 evals/harness.py tdd /path/to/submission --output /path/to/report.json
python3 evals/harness.py planning /path/to/submission --output /path/to/plan-report.json
# Other case IDs: review, debugging
```

Exit 1 means automated checks failed. Exit 0 means **needs_human_review**, not a passing skill evaluation. Every report leaves quality scores null. Executions include command, exit code, stdout/stderr and timeout; files are SHA-256 hashed. The harness runs held-out checks and submitted tests in a temporary copy, then restores the original `index.cjs` and reruns the submitted test. An original failure must be meaningful upon human inspection; differential replay cannot prove test-first chronology. Review findings are shape-checked, not keyword graded; empty findings may pass structure and still merit zero defect-coverage credit.

Use `private/GRADING.md` and the weighted case rubric for blind manual review. Add evidence-linked human ratings only after inspection, retaining the original automated report. Preserve all failures, missing artifacts and timeout events. No model-generated or keyword-based quality evaluator is supplied.

## Baseline/control methodology

For each case and each skill under study, collect three **paired** replicates, seeds **17, 29, 43**, for six total submissions (control/treatment). Use fresh contexts and fixture copies. Keep exact model/version/settings, tool capabilities, system/task prompts, fixture bytes, 20-minute wall-clock and 12,000 total-token budget identical. Treatment differs only in the explicit skill text; its tokens count toward the same cap. Use a prerecorded counterbalanced order: control→skill for 17, skill→control for 29, control→skill for 43. Do not tune a skill or fixture after seeing held-out failures; revisions require a new evaluation version.

If seeds are unsupported, call these paired replicate IDs and record nondeterminism. Capture actual usage and limit violations externally: this harness does not enforce budgets or authenticate transcripts. Keep external-service access disabled for both conditions. Any skill workflow requiring absent tools (e.g. tracker/subagents) must be recorded as a capability limitation; do not secretly give only treatment more tools or rewrite its instructions without versioning the adaptation.

Blind graders to condition and skill. Publish per-seed functional outcomes, each rubric dimension, evidence completeness, elapsed time and tokens; then show paired score differences with raw ranges and failures included. Three seeds are exploratory, not a significance claim. Do not pool different tasks/models/skills into an unsupported leaderboard. A no-skill control is a real run, not the hand-written selftest solution.

## Source-informed design

Representative skills were read directly from all four source repositories; these small fixtures are original, not copied answers:

| Repository and snapshot | Read skill | Eval principle |
|---|---|---|
| cursor `0317eb8b858c991c57721358daaee19dbe8c814d` | `sources/cursor/pstack/skills/tdd/SKILL.md` | Cheap focused regression; observed red before fix, green after |
| akash `5175a641e139b99fd67f2e72188070d46667a49a` | `sources/akash/skills/planning-and-task-breakdown/SKILL.md` | Usable milestones, foundation first, disjoint ownership and capacity |
| matt `49dd158d1076134a641b33efb035946536778336` | `sources/matt/skills/engineering/code-review/SKILL.md` | Fixed review boundary, separate spec/standards and no speculative smell penalties |
| addy `aeac41d4d005999432bb7312f7ff06383a91d59d` | `sources/addy/skills/debugging-and-error-recovery/SKILL.md` | Reproduce/localize/reduce, root-cause fixes, guard against recurrence |

These are design inspirations, not comparative performance claims. The full skills have broader workflows than the bounded fixtures; planning uses local artifacts instead of a tracker, review uses an explicit two-file boundary instead of Git history. Record such adaptations when choosing an exact treatment.

## Limitations

Tiny synchronous/local contracts cannot predict large-repository, distributed-system or browser performance. Held-out tests are finite and can miss bugs. Metadata presence and JSON shape are not truth, quality or provenance. File ownership checks compare explicit normalized file paths, not all filesystem aliasing or conceptual interface contention. Review and planning require human judgment. Existing public fixture exposure can contaminate future runs. No actual agent runs, baseline measurements, API costs or quality scores were produced here.
