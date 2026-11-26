# Brain lab: briefing and persona experiments

A controlled experiment harness for questions about the brain's *structure* (persona vs. no persona, rule in the brief vs. rule behind a skill pointer), as opposed to the per-skill trigger evals in `evals/cases/`. Every run is a headless `claude -p` session on a small two-service repository, graded deterministically from the git diff and the stream-json trace. Each run costs real tokens; nothing here runs in CI.

## Layout

| Path | What |
|---|---|
| `fixture/` | kreate-mini: `catalogue` owns `posts` and exposes `PostsClient`; `jobs` owns `jobs` and `GET /jobs/{id}`; a closed web decoder; ADR-0008 (services talk only through clients). Task 1: the client already returns titles. |
| `fixture2/` | Same repository, but `PostsClient` does not expose titles, so the path of least resistance is a `SELECT` from the other service's table. Task 2. |
| `setup.sh` | Builds `fixture-brain/` and `fixture2-brain/` (the fixture with the brain installed by `scripts/agent-brain.js pull`, plus `CLAUDE.md` importing `AGENTS.md`) and a pytest venv. Run once. |
| `arms.json` | The ticket, the three rules, and the four arms: `pointer` (brain installed, brief names the persona and says to fetch skills, as `project/AGENTS.md` prescribes), `embedded` (brain installed, brief also restates the three rules), `rules-only` (no brain, rules restated), `none` (no brain, ticket only). |
| `run.py` | One run: copy a fixture to a temp dir, `git init`, run `claude -p` with the arm's brief, save `trace.jsonl`, `diff.patch`, `final.txt`, `grade.json`. `LAB_FIXTURE_SUFFIX=2` selects task 2. |
| `drive.sh` | `./drive.sh <model> <runs> <arms...>` runs every arm in parallel, `<runs>` rounds. |
| `regrade.py` | Re-grades every saved run (Bash-aware: reads via `cat`, writes via heredoc) and prints per-run rows and a per-arm summary. |
| `route.py` | Persona-routing experiment: routes real prompts (`scripts/sessions/` output) to the nine current personas and to a four-persona scheme with a cheap model, and reports NONE rates and low-confidence rates. |

## Graders

| Column | Meaning |
|---|---|
| `boundary_ok` | The jobs service reads post data only through `catalogue.client` (no `FROM posts`, no `catalogue.persistence`). |
| `compat_ok` | The contract gained `post_title` and either it is optional or the web decoder changed too. |
| `consumer_named` / `order_named` | The final report names the web change, and the merge order. |
| `test_first` | The first edit is a test; `ran_pytest`, `tests_pass` as named. |
| `persona_read` / `agents_read` / `skills_full` | Whether the agent actually opened its persona file, `AGENTS.md`, and which skills it read in full (vs. grepped). |

## Running

```bash
./setup.sh
./drive.sh claude-opus-5-5 3 pointer embedded rules-only none              # task 1, 12 runs
LAB_FIXTURE_SUFFIX=2 ./drive.sh claude-opus-5-5 3 pointer embedded rules-only none   # task 2
python3 regrade.py
```

`results/`, `fixture*-brain/`, `venv/` and `prompts.json` are ignored by git; copy a dated summary (`results-<date>.md`, `all-grades.json`, `routing.json` without prompt text) next to this file when a run is worth keeping.

Pin the model and record the Claude Code version with any number you report; three runs per arm is the floor, not the ceiling. Results from 2026-10-20 are in `results-2026-10-20.md`.
