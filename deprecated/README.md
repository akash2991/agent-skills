# Deprecated

Retired material, kept rather than deleted. Nothing here is loaded, validated, built, or injected: the validators scan `skills/`, `agents/`, `org/`, and `templates/`, so this directory is inert. It exists so a decision can be re-examined and so nothing is lost just because it stopped being used.

## upstream/

Exact copies from the fork point, recovered from git. Every file here can be verified with `git show <commit>:<original path>`.

| Directory | What it held | Why it was retired |
|---|---|---|
| `plugin-manifests/` | `.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/`, `plugin.json` | The brain is injected into a repository rather than installed from a marketplace, and these pointed at the upstream repository |
| `commands/claude/`, `commands/gemini/`, `commands/antigravity/` | the nine lifecycle slash commands (`/spec`, `/plan`, `/build`, `/test`, `/review`, `/code-simplify`, `/constraints`, `/webperf`, `/ship`) | Nothing is invoked directly any more: every request routes through the CEO, which owns budget, priority, and parallelism. `/brain` is the only command |
| `docs/` | nine per-tool install guides plus the adoption, comparison, getting-started, agent-files, per-agent-configuration, developer-onboarding, and persona-table docs | They document installing the upstream skills pack into a tool; `docs/brain.md` and the injection pipeline replace them |
| `hooks/` | the spec-cache, simplify-ignore, and session-start hooks | Replaced by `control-plane/hook.js`, which captures real token, cost, turn, and tool usage |
| `ci/` | the plugin-install workflow and the skill-gap issue template | Replaced by `.github/workflows/checks.yml`, which runs this repository's own checks |
| `scripts/` | `validate-commands.js` and `validate-versions.js` with their tests | They policed the deleted command directories and the deleted plugin manifests |

## restored-from-transcript/

Files that were untracked when deleted, rebuilt from complete copies captured in the session that removed them. See that directory's README for what is faithful and what could not be recovered at all.

## Removing something from here

Nothing in this directory affects a build, so there is no pressure to clean it. If you do delete something, commit the deletion on its own so the history keeps the content reachable.
