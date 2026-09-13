# Superseded during development

Working documents from building Agent Brain that a later decision replaced. Kept because they record why the current design is what it is, not because anything still reads them. Nothing here is built, injected, or checked.

| File | What it was | What replaced it |
|---|---|---|
| `SPEC.md` | The first observability spec: a file-backed agent registry, an append-only JSONL event log, and an injected dashboard script | The SQLite control plane in `control-plane/`. The event contract survived as `control-plane/event.schema.json`; the JSONL store, the file registry, and `observability/dashboard.js` did not |
| `usage.md` | A written-out answer to "how do I use this in my repo", pasted into the repository root | `README.md` for the short path and `docs/brain.md` for how the pieces fit. Its `dist/<tool>/` paths are two renames out of date |
