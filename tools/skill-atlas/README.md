# Skill Atlas

A local, interactive comparison of Cursor pstack, Matt Pocock's skills, Addy Osmani's agent-skills, and Akash's agent-skills.

## Open

```sh
# From the agent-skills repository root:
cd tools/skill-atlas
/Applications/Herdr.app/Contents/MacOS/Herdr browser open ./index.html
```

Or serve this directory with `python3 -m http.server 8765 --bind 127.0.0.1` and visit http://127.0.0.1:8765. Opening directly with file:// is unsupported because JSON is fetched.

## Explore

- **Stage workspace (default, opens Build):** all skills assigned to a lifecycle stage, organized by job and repository. No representative skills replace the inventory. Choose an app situation to see a small source-based suggested set; suggestions never auto-select or hide other skills. Compare 2–4 exact skills (including multiple from one repo), mark Keep/Later/Skip, write per-skill and per-stage notes, and review your app's kept stack. App choices persist locally and export as `app-skill-stack.json` with source URLs and snapshot SHAs.
- **Capability tables:** compact, reference-inspired tables. Pick a capability and scenario; suggested columns are spotlighted. Short phrases highlight differences. Each ⓘ opens a small evidence dialog with the original instructions behind a disclosure. Suggestions are qualitative source-based fits, not measured rankings. Twelve core capabilities have curated comparison criteria; others use explicitly labelled representative summary excerpts.
- **Overlap finder:** semantic capabilities or literal names; filter all-four, shared, unique, or select an exact repository intersection. Legacy coverage and fit-report renderers remain in the code, but the primary navigation now prioritizes the stage workspace.
- **Eval lab:** proposed strategy with linked existing frameworks, an interactive run-count planner, then draft tasks, executable local artifact checks, and a manual rubric scorecard. No model calls are made.
- **Method inspector:** method, output, dependencies, quotations and commit-pinned source. Shortlist skills and export JSON.

The stage workspace has its own job, skill-search and decision filters. Changing stage clears the temporary comparison tray, not your choices. App name, contexts, decisions and notes persist in localStorage (per origin); export to share or preserve them across browsers. Keep decisions synchronize with the existing shortlist feature. Capability-table and overlap search remain separate.

## Evidence & limits

`data.json` is a researched snapshot of all SKILL.md files in the requested scopes. Nested automations, principles, and in-progress skills are included and labelled. Counts are **not quality scores**. Skills have one primary stage and capability: secondary coverage is not counted. Semantic overlap is an analyst mapping, not proof of equivalent behavior. Same-name skills can differ.

Source repositories are retained in ignored local `sources/` checkouts at the commits listed in the dataset. After cloning this repository, run `python3 restore_sources.py` to restore those exact snapshots (requires Git and internet access). Existing checkouts are never overwritten. These are historical comparison inputs, deliberately separate from the live `../../skills/` directory. The UI dataset is usable without them; local full-source viewing and inventory validation need them. Content is reference material, not installed or executed skills. The UI uses optional Google Fonts with system fallbacks and no framework dependencies.

## Location and browser state

The complete playground, research, datasets, and draft eval harness live in `tools/skill-atlas/`; they are not installed as agent skills or included in the brain manifest. No source-repository instructions are executed by the UI.

Keep the same URL (`http://127.0.0.1:8765`) to retain this origin's browser storage. Herdr and Chrome have separate browser storage: export choices in the original browser before switching if you need to retain them. Moving files alone cannot migrate browser-local choices.

## Validation & evaluations

```sh
python3 validate.py
node --check app.js
node --check strategy.js
node --check compare.js
node --check workspace.js
python3 validate_comparisons.py
python3 validate_stage_guidance.py
python3 evals/selftest.py
```

DOM-only interaction tests (no Chrome or windows):

```sh
npm install --prefix /tmp/skill-atlas-dom-test linkedom --no-audit --no-fund
node dom-test.mjs
```

The DOM checks cover filters, intersections, comparison dialogs, shortlist persistence, strategy/case navigation and manual scores. Compact comparison checks additionally cover scenario highlighting, short phrases, source drilldown and missing coverage. Workspace checks verify all nine stages' complete inventories, exact multi-skill comparisons, same-repo selections, context/choice separation, notes, decision persistence, stack removal and export provenance. They do not verify visual rendering. `browser-test.js` is an optional real-browser test script; further Chrome testing was stopped at the user's request.

See `evals/README.md` for the evaluation harness, fixtures, controlled run protocol, and limitations. Harness self-tests are software checks, **not skill benchmark runs**. UI rubric scores are manual notes, not harness results, and must not be presented as measured leaderboard scores.
