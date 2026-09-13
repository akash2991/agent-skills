# Removed integrations

Kept because they record a decision that was made and then reversed, not because anything reads them. Nothing here is built, injected, or checked.

## Herdr (removed on 2026-09-13, owner's decision)

`control.js` mapped an agent's `runtime`/`runtime_ref` binding onto [Herdr](https://herdr.dev) CLI operations: focus, steer, interrupt, and stop a live agent terminal. `herdr-plugin.toml` put the status view and the quota dashboard in Herdr tabs.

It was removed because it could not answer the question it was adopted for. Herdr manages terminal panes and the agent processes inside them; a subagent runs inside its parent's process and has no pane, so the hierarchy the organization actually cares about was invisible in it. That is structural, not a configuration mistake.

What replaced it: nothing for terminal control, which is now out of scope. The agent tree, model, effort, tokens, cost, and budget live in the control plane, and trace timelines, agent graphs, and cost dashboards live in Langfuse.

If terminal control is wanted again, the binding columns `agents.runtime` and `agents.runtime_ref` still exist and this file still shows the CLI mapping.

## observability-test.js (removed on 2026-09-13)

The test suite from the file-backed era: it exercised a JSONL event file, a `summarize` function, and the Herdr control mapping. It was never wired into `npm test` or CI and stopped running when the store moved to SQLite. Its live coverage is in `scripts/brain/control-plane-test.js`.
