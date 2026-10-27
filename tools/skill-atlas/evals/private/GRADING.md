# Grader-only acceptance guide

Do not mount this directory, evals.json, selftest.py or harness.py in a measured agent workspace. These checks are public to repository maintainers, not cryptographically hidden. Grade blind to condition. Rubrics live in evals.json for the workbench, not in the agent prompt.

## Manual rubric procedure

Rate each named case dimension from 0 to 4: **0** absent/incorrect, **1** major gaps with little valid evidence, **2** partly correct with important omissions, **3** correct with minor omissions, **4** complete and supported by directly inspectable artifacts. Supply artifact path + line or transcript sequence for every rating. A polished claim without corroborating execution evidence does not earn process credit. Unknown/missing evidence remains null until reviewed, not a default zero or pass. Once fully reviewed, weighted score = sum(weight * rating / 4), out of 100. Do not combine structural check results into that score automatically.

Use two blinded human graders when available. Preserve their independent ratings and adjudication notes; otherwise label single-rater results. Report behavioral checks alongside ratings: a high prose rating must not obscure failed acceptance. All critical contract checks must pass before claiming a functional success. Do not treat every dimension as independently statistically sampled.

## Planning

Inspect plan.md AND plan.json together. First milestone must yield usable JSON export, not merely scaffolding. Confirm explicit serialization contract and single ownership before consumers, truthful 8-point scope, manageable tasks, command wiring and existing list compatibility. Unknown-format rejection must precede writes. Safe publication must consider a no-clobber primitive, partial files and cleanup; naive exists-then-write is race-prone. Accept reasonable atomic/no-clobber alternatives with platform limitations disclosed, not a prescribed implementation. CSV quoting, Unicode, empty lists and headers must be covered or explicitly deferred with reasons. Proposed verification is allowed; do not require execution of nonexistent future files. Human review must catch fake/minimal acceptance text, misleading effort estimates, directory/path aliases and dishonest independence that the graph validator cannot detect. Capacity alone does not establish feasibility.

## TDD

Independent acceptance probes odd-cent half rounding, ordinary discounts, zero/full discounts and invalid types/ranges. The contract requires RangeError for invalid inputs. Red replay must be an assertion about behavior, not missing imports, syntax errors, hardcoded process exits or reading the filename. Verify transcript shows test creation and its meaningful failure before production edits; differential replay establishes sensitivity, not historical order. Inspect tests for dependence on implementation internals and check original assertions were not weakened. A narrow fix with accurate limitations is preferable to unexplained generalization.

## Review ground truth

1. after.cjs line 3 uses OR instead of AND. With [{tenant:'A',deleted:false,updated:1},{tenant:'B',deleted:false,updated:3},{tenant:'A',deleted:true,updated:2}], list(rows,'A') returns all three, leaking B and including deleted A. High/critical severity for tenant exposure is reasonable. Count these manifestations as one root cause for precision; either grouped or separately explained is acceptable, without duplicate credit.
2. after.cjs line 2 sorts the caller's array in place. The same data changes its order to B, deleted A, A. This violates non-mutation and can corrupt downstream assumptions. Medium severity is reasonable. Sort a copy, filter correctly, then apply limit. These are spec defects; non-mutation may also be described as a standard if explicitly linked to the spec, not invented repository policy.

Do not require artificial standards findings. Stable sort on supported Node preserves ties; default limit and descending comparison are correct. Negative limit/invalid input validation is out of scope given caller guarantees. No architecture rewrite or formatting complaint earns defect credit. Verify reproductions manually or in a disposable sandbox; the harness validates finding structure only, never counts issue keywords.

## Debugging

Two independent causes: delimiter concatenation aliases ('a:b','c') and ('a','b:c'); rejected promises remain cached forever. Fix must distinguish exact pairs (nested maps or unambiguous tuple encoding), evict failed entries, retain successful falsy values, and share one in-flight fetch per identical pair. Verify deterministic test control through promises, no sleep-based race assertions. The notes should explain observations and rejected hypotheses, not just announce a fix. Removal of caching is not a valid remedy. Check both original reproductions and broader cache semantics. Transcript chronology supports diagnosis; a retrospective narrative alone does not.

## Evidence integrity

Keep the harness report, SHA-256 maps, submitted files and raw runner transcript together. Self-reported metadata/transcripts are not authenticated. Prefer host-captured ordered events with command, cwd, input/output, exit code, start/end times and file diffs. Audit time/token limits from host logs; the harness merely checks their manifest fields exist. No seed or budget enforcement is implied by this local grader.
