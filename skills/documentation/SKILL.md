---
name: documentation
description: How to write a good document, rules W1–W12 — whether to write it at all (the ticket and commit message carry most of it), the templates document set with only the sections the work demands, user review of an HLD, LLD, or PRD only when asked, economical high-level writing with never code copied into a doc, docs compacted into skills, two renderings (Markdown with diagrams as code for agents, interactive HTML for humans, committed beside its Markdown), design as code (Mermaid, .drawio, drawdb), a document index, every document in the repository, never in a cloud tool or the agent brain, and artifacts mapped in models.json so an agent-finish hook keeps them current in their own PR. Use when you write, update, or decide whether to write any document, README, design doc, RCA, PRD, or index — even if the user only says "document this" — or when you decide where a document lives, how it is rendered, or which artifacts the sync keeps current.
category: design
---

# Documentation

## Overview

How a document is written well: whether at all, how short, in what form, and where. The rules are W1–W12. What goes into a PRD, HLD, LLD, or ADR is its own skill; the anatomy of each is in `templates/` and which document holds what is `../../references/documentation-map.md`.

## When to Use

- Writing, updating, or deciding whether to write any document, README, design doc, RCA, PRD, or index.
- Deciding where a document lives or how it is rendered.
- Mapping an artifact to the code it describes, so the sync keeps it current (W12).
- Compacting a document that has grown.
- NOT for the contents of a PRD, HLD, LLD, or ADR: `prd-writing`, `hld`, `lld`, `adrs`.
- NOT for comments in code (`coding-standards`) or the changelog (`continuous-delivery`).

## Whether to write at all

| ID | Rule |
| --- | --- |
| W1 | **Not every feature needs an HLD, LLD, or doc update; the ticket and the commit message carry most of it.** Some things are obvious. Focus on good tickets and good commit messages; write a document when they cannot carry it. |
| W2 | **The document set and anatomies are in `templates/`.** Add a section when the work demands it; not every section must be filled. |
| W3 | **An HLD, LLD, or PRD counts once it is merged, linked on its ticket, and has no open question; the user reviews it first only when they or the ticket ask.** |

## How to write

| ID | Rule |
| --- | --- |
| W4 | **Economical with words; high-level ideas; depth only where it is needed (RCA, design docs). Never copy code into a doc**; a reader can always go to the code. An API reference lives with the code (OpenAPI, docblocks) and `ARCHITECTURE.md` links to it. |
| W5 | **Docs stay current and are compacted regularly by extracting stable content into skills.** Old, long docs are less accurate and less read: a big doc shrinks its audience and is outdated the moment implementation starts. |
| W6 | **Two renderings:** Markdown with diagrams as code, which agents read; an interactive HTML which humans use, currently produced with the lavish skill. **Every rendered asset is committed beside the Markdown it renders** and linked from the PR that changed it, or from the PRD or document it belongs to. A hosted preview or a generated link is never the only copy (W9). |
| W7 | **Design as code:** Mermaid for flows and sequences inside the Markdown, `.drawio` for HLD architecture next to `HLD.md`, drawdb for the DB schema next to `LLD.md`; all committed and reviewed like code. |
| W8 | **A document index for progressive discovery** (`templates/README.md`): every document is in it, with what it answers and at which level. |

## Where docs live

| ID | Rule |
| --- | --- |
| W9 | **No cloud artifacts. Every document lives in the repository**, at the project root or in the service it belongs to, **never in the agent brain**. |
| W10 | **Each service has its own `docs/` folder**, because a service can have several documents (PRD, HLD, LLD, ADRs, RCAs). |
| W11 | **The monorepo default layout has a top-level `docs/`** for the project-level documents. |

## Keeping artifacts current

An artifact is a file built from code or describing it: Markdown, HTML, `.drawio`, a schema, a map.

| ID | Rule |
| --- | --- |
| W12 | **Every artifact that describes code is mapped in `models.json` (`artifacts`: `path`, the `sources` globs it describes, an optional `then` command that renders it and the `outputs` that command writes), and code keeps it current, not memory.** When an agent finishes (Claude Code `Stop`/`SubagentStop`, Pi `agent_end`), `scripts/artifact-sync.js hook` compares the commits pushed to the code branch since the last sync with the map (local commits that are not pushed are never synced). When a source changed, it starts the `artifact-sync` model from `models.json` in the background, in a fresh worktree at the pushed tip; that agent edits only the due artifacts, then the script runs `then`, makes one commit on that tip, checks the commit itself, pushes it to `<branch>-artifacts`, and opens a PR into the code branch. Updating artifacts is asynchronous to the code: the coding agent never waits for it, and merges the artifact PR into its branch through the project's usual review and merge path (in the brain repository, an artifact PR skips the double-pass review only when it is merged with `artifact-sync.js merge --pr`, which accepts only validated data artifacts with a renderer; a page artifact never does). The sync refuses to publish a change outside the map or to overwrite a branch tip it did not publish; a failed sync is recorded and shown by `due`, and the next push retries it. |

## Recipe

1. Ask: does the ticket plus the commit message already carry this? If yes, stop (W1).
2. Pick the template from `templates/`; fill only the sections the work demands (W2).
3. Write high level and short; diagrams as code; no code snippets (W4, W7).
4. Save as Markdown in the repo, `docs/` at the root or `<service>/docs/` for a service; generate the HTML rendering for humans, commit it beside the Markdown, and link it from the PR or the PRD (W9, W10, W6).
5. Add it to the document index (W8).
6. HLD, LLD, or PRD: merged and linked on the ticket, open questions resolved; user review only when asked (W3).
7. When a doc stabilises, extract the stable part into a skill and shrink the doc (W5).
8. A new artifact that describes code: add it to `artifacts` in `models.json` with the sources it describes; check with `node <skill>/scripts/artifact-sync.js due` (W12).

## Interaction with other skills

- `prd-writing`, `hld`, `lld`, and `adrs` decide what goes into their documents; this skill decides whether, how short, in what form, and where.
- `coding-standards` owns comments in code; `continuous-delivery` and `git-workflow-and-versioning` own the changelog.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Every feature gets an HLD/LLD update." | Not every feature needs one; the ticket and the commit message carry most of it (W1). |
| "I'll paste the code into the doc so it is complete." | Never copy code into a doc; a reader can always go to the code (W4). |
| "A longer doc is a more thorough doc." | Old, long docs are less accurate and less read; write short and high level (W4, W5). |
| "The doc has grown, that's normal." | Docs are compacted regularly by extracting stable content into skills (W5). |
| "I'll put it in Notion / a Google Doc for now." | No cloud artifacts; every document lives in the repository (W9). |
| "The HTML rendering is just a preview; the link is enough." | The rendered asset is committed beside its Markdown and linked from the PR or the PRD (W6). |
| "A screenshot of the diagram is fine." | Diagrams are code: Mermaid, `.drawio`, drawdb, committed and reviewed (W7). |
| "The HLD is done, the open questions can wait." | A design with an open question does not count; resolve it, or ask the user when it is theirs to decide (W3). |
| "Nobody will look for it in the index." | Every document is in the index for progressive discovery (W8). |
| "I'll remember to update the doc when the code changes." | Memory drifts; map the artifact in `models.json` and the sync updates it (W12). |
| "The artifact PR is waiting, I'll wait for it before pushing more code." | The sync is asynchronous; keep working and merge its PR when it lands (W12). |

## Red Flags

- A doc update for a feature the ticket and commit message already explain (W1).
- Code copied into a document (W4).
- A document that keeps growing and is never compacted into a skill (W5).
- A document in a cloud tool, or in the agent brain, instead of the repository (W9).
- An HTML rendering left as a hosted link or a throwaway artifact instead of committed beside its Markdown (W6).
- A diagram committed as an image instead of Mermaid, `.drawio`, or drawdb (W7).
- An HLD, LLD, or PRD treated as final with an open question, or held waiting on a user review nobody asked for (W3).
- A document missing from the index (W8).
- An artifact that describes code but is missing from `artifacts` in `models.json` (W12).

## Verification

After documenting:

- [ ] The ticket and the commit message did not already carry it (W1).
- [ ] The document uses its `templates/` anatomy with only the sections the work demands (W2).
- [ ] It is short and high level, with no code snippets and diagrams as code (W4, W7).
- [ ] It lives in the repository at `docs/` or `<service>/docs/`, with the HTML rendering committed beside it and linked from the PR or the PRD (W9, W10, W6).
- [ ] It is in the document index (W8).
- [ ] An artifact that describes code is mapped in `models.json`, and `artifact-sync.js due` names it when its sources change (W12).
- [ ] An HLD, LLD, or PRD is merged, linked on its ticket, and has no open question; reviewed by the user when they asked (W3).
