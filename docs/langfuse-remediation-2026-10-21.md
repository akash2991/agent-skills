# First-party Langfuse remediation — synthetic verification

Status: **draft implementation, not a completed rollout or review gate**. Historical official-plugin failures remain recorded in [the original audit](langfuse-audit-2026-10-20.md). The metadata-only boundary and supported protocol are in [the runtime README](../runtime/langfuse/README.md).

## Method

Real native harness requests read only private temporary **synthetic** fixtures. No real credential was placed in a prompt, fixture, argv, generated script or committed evidence. Runtime authentication used the existing private shared loader. Observations were fetched from Langfuse after indexing delay, not inferred from registration, stdout, local state or an empty outbox. Counts below are unique observation IDs; raw APIs can expose multiple revisions.

Five deliberately invalid canaries covered a Langfuse-shaped key (also after a newline), provider-shaped key, password marker, email and SSN. Retrieved records had no input/output content, none of those canaries, and no configured secret literal. This is evidence for these executions and the metadata-only projection, not a guarantee about arbitrary operator labels or other exporters.

Slop's main project settings/brain assets were not changed for these probes. Main-checkout runs used explicit per-process resources, synthetic ticket `TEST-17`, and no application edits. The stock-worktree cases installed/committed generated brain/runtime assets only in an isolated trusted QA parent branch and its children, not Slop main. One owned temporary daemon QA tab was closed after its result and server-side observations were inspected.

## Verified paths

| Native path | Unique nodes | Evidence |
|---|---:|---|
| Pi direct | 6 | One AGENT, three actual-model generations, two tools; backend-engineer/ticket attribution and usage; trace `3717ee63de37dc53b9565ff1d752763d` |
| Pi → Pi subprocess | 12 | Two AGENTs in one trace/session, each with generations/tools; child parent ID points at main AGENT; trace `6d76c19d2c50c590cdb375b4507f2b5d` |
| Pi → Herdr daemon Pi pane | 12 | Exact prebound native session/pane; returned adapter acknowledgement followed by actual server retrieval; trace `9ae0aa1524de20f457c68fa859335e6d` |
| Claude direct, after lock fix | 4 | Completed AGENT, two actual Opus 5.5 generations and Read; actual model also retained on root metadata; trace `36d0d89005d084a58c846acb402bab70` |
| Stock Herdr worktree, after lock fix | 12 | Native project registration in both worktrees, automatic child-result delivery, two completed AGENTs with common project/trace/session and distinct worktree IDs; trace `79cd6d30c5398060cbb175f97669160a` |
| Pi skill/error/abort | 11 | Actual slash expansion and definition read yielded exactly one invoked/loaded skill, not a permission inventory; real missing-file error, RPC abort and AGENT aborted state; trace `80efb3883c40f96d7e11a3c27a1b4deb` |
| Claude native Agent | 7 | Main/child AGENTs, four generations and child Read under the correct child; actual `claude-opus-5-5`; trace `c8ad8838e362a825fb042f9e798d45f8` |
| Pi → Claude subprocess | 11 | Shared trace/session across native GPT-6.1 Sol and Opus 5.5, separate actor roots and tools; persona/ticket fields; trace `0a658bb0095de3f5a9ff7928bd9088b4` |
| Claude → Pi subprocess | 12 | Shared trace/session across the reverse harness direction, correct child AGENT parentage, model and usage fields; trace `1d9560d968588773c1dab46baed4d45d` |

Source/native wiring additionally tested isolated principal/old-worktree discovery, known legacy factory suppression, repeated setup, ordinary pulls, no startup SDK installation into managed runtime files, and preservation of unrelated settings and trust stores. That wiring suite makes no model or Langfuse calls.

## Bugs exposed by integration/live tests

These were not caught by component stubs alone:

- Incompatible native child identifiers, ticket-source enums, typed project identities, timestamps and mutable context fields.
- A bootstrap tool-registration collision and unwanted SDK installation caused by registering a package directory instead of a native extension file.
- Uppercase OTel observation-type values becoming generic SPANs instead of AGENT/TOOL.
- A successful Langfuse ingestion receipt being rejected because it was wrapped in a nonempty JSON object.
- Too-short Claude flush budgets, rejected canonical numeric usage checkpoints, duplicated cache TTL buckets, stale replay revisions and competing unfinished-root metadata.
- Context editing being unnecessarily blocked while a native child's exact parent was still deferred.
- A killed probe leaving a shared directory flush lock and preventing subsequent normal delivery. The process-identity claim protocol now covers enqueue, flush and context transactions; SIGKILL recovery, live-owner exclusion, PID reuse and concurrent critical sections have offline tests. A later ordinary native session automatically drained the previously blocked stock-worktree trace (`bf812a475b16194f9fc47a398c401d8e`, twelve nodes); the fresh corrected run above then verified both actors without manual replay.
- Native Herdr dispatch returning an error envelope without its outer `isError` flag; the known error flag is captured without exporting the message.

The focused runtime/adapter/context/privacy/installer/pull/audit/native-wiring suite passes **145 tests** after the review corrections below. An additional **120 repository tests**, validators, routing evals and build pass locally; no hosted CI checks were reported on the PR. Native wiring remains a no-model/no-Langfuse suite, unlike the positive server-retrieved paths above.

Known-pattern/literal defenses supplement the strict projection; regex masking is not the privacy boundary. Ingestion, session/trace identity, actor types, unique positive coverage and privacy were checked independently.

## Review corrections (repeat gate pending)

The [independent Soul review of `c4998f4`](https://github.com/akash2991/agent-skills/pull/11#issuecomment-6314503062) requested changes. All five findings now have implementation and offline regressions in the parent checkout:

- **P1 opt-out:** absent declarations differ from disabled/invalid ones; current and nested refusals terminate both filesystem/Git discovery before principal fallback. Real bootstrap consumers and native wiring passed.
- **P1 late attribution:** ticket ID/provenance are inherited as one validated pair. Continuing children capture after binding; changed historical rebases preserve the active native turn atomically.
- **P2 deferred progress:** durable unqueued suffixes advance across count/byte capacity, rejection, restart and an enqueue/checkpoint crash boundary. Transfers reserve egress time; historical model/effort/skill evidence is preserved.
- **P2 checkpoint lifecycle:** aggregate file/byte admission and seven-day conservative reclamation protect live, unresolved and replay dependencies; tests inspect actual directory usage.
- **P2 model grammar:** recognized Claude `[1m]` context-window suffixes normalize to the canonical model through SessionStart, switches and transcript reconciliation; unsupported labels omit safely.

Fresh post-correction native cross-harness runs were retrieved again: Pi→Claude `fa3fd282b69e2eb2534b3ac7d2ca20bd` (**11 unique nodes**) and Claude→Pi `da6189fdfce2fe0aabe7ad87b5ca3efc` (**12**). Both have two correctly parented completed AGENTs, backend-engineer/TEST-17 attribution, actual model/usage and no input/output/canaries/configured secret literal. These are targeted reruns, not a claim that every earlier live scenario was repeated.

The prior exact Opus 5.5 native attempt timed out before a final report: actual model confirmed, seventeen successful tool calls, zero tool/permission errors. It is **not** a completed independent pass. Fresh independent passes and Astra synthesis on the corrected revision remain required.

## Remaining acceptance and review

This is not completed final-revision certification. The selected stock-worktree, automatic replay, error/abort and invoked/loaded-skill checks above now have positive server-retrieved evidence. Rerun affected paths if review changes their implementation. Native old-base discovery is a wiring test, not proof that every old branch or standalone third-party exporter is safe. Resume/persistent variants and unsupported native schemas must not be silently included in coverage claims.

Final independent GPT-6.1 Soul and Opus 5.5 passes, separate GPT-6 Astra synthesis, PR dispositions and final-revision coverage remain mandatory before merge. Slop's actual project registration follows that gate, not these per-process probes. Historical content traces are not retroactively scrubbed; if real credentials were captured by old content exporters, review access/retention and rotate affected credentials.

Private manifests, fetched observations, stdout and summaries remain under the per-run temporary audit directories referenced by the local `/tmp/lffix-*-latest.json` pointers. They are deliberately not committed.
