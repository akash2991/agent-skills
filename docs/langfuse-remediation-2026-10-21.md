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

The focused runtime/adapter/context/privacy/installer/pull/audit/native-wiring suite passed **145 tests** after the first review corrections below; the post-Astra follow-up now passes **215**. An additional **120 repository tests**, validators, routing evals and build pass locally; no hosted CI checks were reported on the PR. Native wiring remains a no-model/no-Langfuse suite, unlike the positive server-retrieved paths above.

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

## Astra follow-up (not final approval)

The [Astra synthesis of `be7c650`](https://github.com/akash2991/agent-skills/pull/11#issuecomment-6315483739) confirmed six required fixes. The parent has integrated and tested all six: cwd-sensitive direct Pi refusal with explicit `--brain-tracing` for marker-absent runs; durable capture-order tickets/pre-send floors; actual initial/late single-use owner claims; unsupported-model invalidation; required own process birth identity; and identity-named temporary-lock recovery. Tests cover equal-timestamp/post-ACK restart replay, competing processes and unresolved descendants, current-vs-historical model state, and crash/paused-publisher boundaries. The 16,384-identity/4 MiB non-expiring revision ledger refuses new identities at capacity. Unticketed legacy records remain blocked/intact; ambiguous legacy lock state requires offline operator inspection. These limits must not be described as automatic migration or indefinite healthy operation.

A separate intermittent defect found during parent verification is also fixed: native UUIDs are validated as typed identifiers rather than decoded like free-form labels. A deterministic fixture and 1,000 synthetic native IDs verify acceptance while generic encoded-label and configured-literal defenses remain enforced.

The combined parent suite passes **215 tests**. Fresh server-retrieved reruns again show Pi→Claude `1979f8c7575950cf06c879670c677a58` (**11 unique nodes**) and Claude→Pi `845f2aad5ed00cda54a6203ac89eca77` (**12**), with correctly nested completed actors, actual model/usage, persona/ticket and no input/output/canaries/configured-secret literal. Marker-absent Pi runs used the new explicit flag. These fixtures explicitly allowed Bash for their controlled commands; they do **not** establish narrow-rule compatibility.

**New confirmed rollout blocker:** On native Claude Code **2.1.306**, with ordinary settings sources disabled and only `Bash(printf *)` allowed, the control executed exactly one `printf BRAIN_PERMISSION_PROBE` successfully with zero denials. The metadata hook's automatic nonce prefix caused the same original command to be denied (one permission denial). Inline assignment, `env` and shell-wrapped alternatives were also denied in separate controlled checks. No blanket permission override or global permission rule was applied. Switching to an explicit traced-launch/context-helper protocol instead of automatic arbitrary-Bash rewriting needs an accepted design decision; current permission incompatibility is not a passed acceptance case.

No broad rollout or Slop main registration occurred. The new fixes and any protocol change still need applicable final-revision reviews and synthesis; the earlier approvals/findings cover their pinned revision only.

## Explicit-helper completion (final gate pending)

The accepted replacement removes all Claude Bash `updatedInput` mutation and permission decisions. Supported hook context supplies a stable per-actor capability; context/pane/subprocess helpers accept it explicitly. `brain-trace.cjs exec` prebinds the exact fresh native session, spawns without a shell, preserves argv/stdio/exit signals and refuses conflicting resource/session/permission options. Ordinary Bash-launched processes outside that protocol are not promised unified lineage. Marker-absent per-run targets remain supported without writing project settings; refusals and kill switches still win.

On native Claude Code **2.1.310**, the control/traced `Bash(printf *)` test now succeeds unchanged in both cases with zero permission denials. Native explicit-helper checks also revealed duplicate project/per-run hooks publishing multiple actor values; atomic native-session reuse and stable per-actor capability publication now have real four-process regressions. The follow-up native run uses one child actor and one capability, not a guessed choice among them.

Fresh server retrieval confirms explicit Claude→Pi trace `0f94ab8b1a27453c6bfecf7fef46b549` (**12 unique nodes**) and Pi→Claude `eff60e545c4e5ed2a3cc2257a3bf7549` (**11**): two correctly parented actors, generations/tools, no input/output/canaries/configured credential literal. These replace the earlier automatic-rewrite acceptance path, not its permission semantics. The combined focused suite passes **228 tests**.

Current main was merged into the isolated PR checkout, resolving the build/pull conflicts while retaining both runtime bundling and source-only infrastructure exclusions. Local repository tests/validators/build pass. GitHub Actions is an external blocker: permissions report `enabled:true` and active workflows, but dispatching either workflow returns HTTP422 “Actions has been disabled for this repository.” No account policy, billing setting or permission bypass was changed, and local tests are not described as hosted CI.

The paused WIP has been completed; final-revision independent reviews and Astra synthesis are still required before merge. Slop main remains unconfigured by this task.

## R1–R4 correction cycle after the `46c7452` reviews

The [Soul review](https://github.com/akash2991/agent-skills/pull/11#issuecomment-6405063589), [scoped Opus review](https://github.com/akash2991/agent-skills/pull/11#issuecomment-6405056534), and [Astra synthesis](https://github.com/akash2991/agent-skills/pull/11#issuecomment-6405093377) did **not** approve that candidate for merge. All four required corrections are now implemented, pending new final-revision reviews:

- **R1:** native session selection, ownership publication and empty unresolved holds commit atomically. Readers recover missing/stale adapter checkpoints from authoritative context rather than exporting provisional roots. Barrier-controlled competing hooks and actual SIGKILL/restart tests cover create/before-checkpoint/after-checkpoint/rebase boundaries, recovery descendants, late exact binding, stable observation IDs and duplicate-hook capabilities. Ownerless incomplete legacy publications remain deferred, not guessed.
- **R2:** skill lists retain bounded evidence with replay-stable `filtered`/`truncated`/`refused` status enums. Actual capture/store/queue/pending replay regressions cover both lists at 32/33/128 and overflow, privacy literals, repeated projection and the 16 KiB record budget.
- **R3/R4:** exec now accepts an explicit bounded Pi/Claude grammar, refuses ambiguous selector clusters and permission/resource controls before spawn, consumes known option values by arity, and preserves literal arguments after native `--`. Administrative-command guarding and the stale hook stdout comment are also corrected. No ordinary Bash mutation, hidden native grant or global permission setting is introduced.

The combined parent suite passes **243/243**. Repository **120/120**, validators, routing evals and build pass. Soul's earlier aggregate GC-test failure is retained as a real failed run: its single-flush full-reclamation expectation depended on a bounded deadline. The revised test deterministically exhausts that budget and proves real capacity-triggered expired-file/byte reclamation, rather than merely increasing a timeout. The grammar worker additionally ran fixture installer tests that were not forced offline; that run is not represented as proven network-free.

Fresh native Claude 2.1.310 control/traced narrow-printf parity again passes with **zero permission denials**. Final-code explicit Claude→Pi trace `b0a7cc088e51320db521e98f8c95f048` has **12 unique nodes**, correct parentage and no content/canaries/configured credential literal, retrieved with `basic,io,usage,model,metadata` fields (the API's default basic fields alone would not prove privacy).

**Historical native fixture failure, now corrected:** the first marker-absent Pi→Claude fixture used repository-supplied permission grants without proving native repository trust. Sending a trust-dialog keystroke was not evidence of completed/persisted trust. Claude denied its context command, so exit 0 and correct lineage were correctly rejected as full persona acceptance. The exact old decision cannot be reconstructed from the retired temporary artifacts; no runtime authorization defect was established.

On resume, first-party [workspace-trust documentation](https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust) established the scope distinction: headless runs ignore untrusted repository grants, whereas an operator-owned, untracked, nonsymlink `settings.local.json` is local-user policy. The fresh synthetic fixture uses that documented scope with the **same narrow context-command prefix**, not a broader allow rule or an exec permission override. Read-only native `doctor`, untracked-file/symlink checks and a pre-trace native control precede the traced run. The control and traced context command both execute with **zero native denials**; no trust-store editing, automated trust dialog or global permission changes are used in the corrected test.

Fresh server-fetched explicit Pi→Claude trace `1beab33988421677a09cbf74f44b6020` (**11 unique nodes**) and Claude→Pi `d159b0a7cb7573e2fc24757fd9413cf4` (**12**) verify two correctly parented completed actors, persona `backend-engineer`, ticket `TEST-17`, native `gpt-6.1-sol` / `claude-opus-5-5`, and no content/canaries/configured credential literal. Retrieval explicitly requests `basic,io,usage,model,metadata`. Child native denials are zero. The resumed combined suite again passes **243/243**. New fixture artifacts and checks are retained outside the repository in the durable private checkpoint directory rather than relying on `/tmp`.

Hosted CI still reports no checks and rejects dispatch with the previously recorded HTTP422. These implementation changes require fresh independent Soul/Opus reports and separate Astra synthesis. **Do not merge or deploy while hosted CI or the final-revision review gate remains unresolved.**

## Snapshot-retention correction after the `7b91aaf` reviews

The [fresh Soul report](https://github.com/akash2991/agent-skills/pull/11#issuecomment-6414912023), [scoped Opus report](https://github.com/akash2991/agent-skills/pull/11#issuecomment-6414874812) and [Astra synthesis](https://github.com/akash2991/agent-skills/pull/11#issuecomment-6415018967) verified R1–R4 but required one further P2: interrupted ContextStore transactions could indefinitely retain random full-snapshot temporaries. That candidate was not approved for merge.

The correction uses a single bounded temporary slot and validated recovery under the same exclusive context lock, covering safe legacy random-name orphans as well as future interrupted writes. Canonical state is never replaced by an abandoned snapshot. Unsafe/ambiguous files are preserved with explicit refusal; live/paused publishers remain protected. Legacy cleanup is bounded and may require retry or offline inspection, as documented in the runtime reliability limits. Real subprocess tests cover creation, partial write, fsync, before/after rename, repeated near-capacity crashes, canonical preservation, legacy recovery, paused owners, unsafe file/link/ownership cases and TTL pruning. Foreign-UID cases use injected stat results, not privileged ownership changes; power-loss durability is not experimentally claimed.

The parent inspected the implementation and full new regression file, then ran the combined suite: **278/278 pass**. Fresh final-code native explicit Pi→Claude trace `6854e3b7d18b92e82890b5c0e60a3d18` (**11 nodes**) and Claude→Pi `52d1e6c9bc2a25e8c4f9d6f701e70fb3` (**12**) were server-fetched with explicit observation fields and pass the same lineage/privacy checks. The narrow native control remains separate from process success; both children successfully adopt the declared persona/ticket. These changes still require fresh applicable independent reviews and separate synthesis. Hosted CI remains an external merge blocker; no rollout is authorized by local verification.

## Outbox-publication correction after the `cf3fb26` reviews

[Opus's expanded outbox inspection](https://github.com/akash2991/agent-skills/pull/11#issuecomment-6415445903) found interrupted final-file writes; [Soul approved the inspected first-party scope](https://github.com/akash2991/agent-skills/pull/11#issuecomment-6415484870), but the [required Astra synthesis](https://github.com/akash2991/agent-skills/pull/11#issuecomment-6416230198) independently reproduced actual SIGKILL artifacts blocking checkpoint GC and requested changes. Its interrupted/stalled turn was explicitly recovered; duplicate completion notifications referenced the same posted synthesis, not additional independent passes.

The isolated prototype introduced fixed-slot outbox/revision/checkpoint publication, validated recovery and queue ownership through checkpoint reference closure/deletion. Parent inspection rejected its initial rule that every JSON syntax error was disposable. The integrated refinement instead requires supported serializer/filename identities, validated projected canonical-prefix evidence and an allocated capture revision. Hypothetical completion is validation-only, never publication. Ambiguous historical empty/early-cut files and unsupported/noncanonical/unticketed or unsafe state remain preserved with explicit offline disposition. Valid unACKed versions, exact ACK deletion and pre-send floors remain protected. Recovery scans/deadlines and the adapter publication reserve are documented in the runtime reliability limits.

Actual subprocess tests cover outbox/revision/checkpoint creation, partial write, fsync, before/after rename, repeated/near-capacity crashes, paused owners, legacy partial versus ambiguous preservation, checkpoint-GC progress, unsafe file/link/ownership/replacement cases and ACK replacement protection. Parent added preservation tests for arbitrary malformed data, mismatched identities, unsupported types/fields, invalid metadata, missing ticket authority and configured literal defenses. The integrated combined suite passes **353/353**; repository **120/120**, validators/evals and build also pass. Fresh final-code server retrieval verifies Pi→Claude `5afc16794a8fd8a8af0aa8579171d4a1` (**11 nodes**) and Claude→Pi `134fca840b28df73eacf3ba98bf78925` (**12**), with correct completed parentage, persona/ticket, both native models, positive usage, null content and no canaries/configured literal; child native denials are zero. One earlier control stopped before tracing because the model added a punctuation argument despite zero permission denials; its failure was preserved and the instruction corrected to an explicit code block, not a broader rule. These changes remain subject to fresh applicable Soul/Opus review and separate Astra synthesis; hosted CI still independently blocks merge.

## Remaining acceptance and review

This is not completed final-revision certification. The selected stock-worktree, automatic replay, error/abort and invoked/loaded-skill checks above now have positive server-retrieved evidence. Rerun affected paths if review changes their implementation. Native old-base discovery is a wiring test, not proof that every old branch or standalone third-party exporter is safe. Resume/persistent variants and unsupported native schemas must not be silently included in coverage claims.

Final independent GPT-6.1 Soul and Opus 5.5 passes, separate GPT-6 Astra synthesis, PR dispositions and final-revision coverage remain mandatory before merge. Slop's actual project registration follows that gate, not these per-process probes. Historical content traces are not retroactively scrubbed; if real credentials were captured by old content exporters, review access/retention and rotate affected credentials.

Private manifests, fetched observations, stdout and summaries remain under the per-run temporary audit directories referenced by the local `/tmp/lffix-*-latest.json` pointers. They are deliberately not committed.
