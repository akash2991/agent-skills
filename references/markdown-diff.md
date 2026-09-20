# Markdown diffs

Git compares lines. A rewritten sentence looks like a deleted paragraph plus an added one. That is the wrong unit for skills, personas, references, and project docs.

## View (`git-workflow-and-versioning` P17)

```bash
git diff --color-words
git -c diff.algorithm=histogram diff --color-words -- '*.md'
```

`--color-words` shows which words moved. Histogram reduces wrong heading matches. GitHub's rendered Markdown preview is a second pane, not a substitute for the word diff.

Never replace `git diff` with a tool that drops "same-intent" sentences. A missed `must` → `should` is a behavior change.

## This repository

`.gitattributes` sets `*.md diff=markdown`. After clone, from the repository root:

```bash
git config --local include.path ../.gitconfig
```

That loads heading-based hunk headers and `diff.algorithm=histogram`. The path is relative to `.git/`.

A project that wants the same hunk headers copies the `*.md diff=markdown` line and the `[diff]` / `[diff "markdown"]` blocks from this repository's `.gitconfig`.

## Review (`code-review-and-quality` check 8)

Judge **obligation**, not sentence shape. A restructured sentence with the same rule is not a finding.

Always substantive, even when the rest of the sentence is a paraphrase:

- Modals: must, should, may, never, only
- Numbers, versions, identifiers
- Rule ids (`P17`, `C13`, `M1`)
- Skill frontmatter `description` and **Use when**
- A sentence moving into or out of a Rules table

Cosmetic (not a finding unless a token above also changed): wrap, emphasis, clause order, a synonym that does not change the obligation.

When the change is harness prose (`skills/`, `agents/`, `references/`, `templates/`), also ask: did a trigger grow or shrink; did a sentence become or stop being a rule; did duplication appear between skill, persona, and reference.
