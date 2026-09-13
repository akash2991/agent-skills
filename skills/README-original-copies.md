# `-original` skill copies

Each `skills/<name>-original/` directory is that skill exactly as it stood at commit `469d00f`, the last upstream commit before this repository started diverging. They exist so the current version and the upstream version can be read side by side and the better one kept.

Only the six that genuinely differ are here. Nineteen others were restored and then deleted, because their only difference from the current version was an added `category:` line that the build uses for grouping. There was nothing to compare.

They are **not skills this organization ships**. The suffix is reserved: the build, the skill linter, the reference-link check, and the eval runner all skip `-original`, so a copy can never be selected into a build, never needs an eval case, and is never linted against our anatomy.

## What changed in each

| Skill | Diff | What changed |
|---|---|---|
| `observability-and-instrumentation` | 18 added, 1 removed | Agent-work telemetry added: the event contract, the privacy boundary, and what the control plane records |
| `using-agent-skills` | 11 added, 7 removed | Rewritten for this organization: skills are loaded by a persona that lists them, not discovered freely |
| `doubt-driven-development` | 8 added, 7 removed | Loading constraints rewritten: a persona never spawns another persona here, so the main session owns the doubt step |
| `constraint-driven-development` | 5 added, 4 removed | Aligned with the conventions: constraints come from `CONVENTIONS.md` rather than being invented per task |
| `spec-driven-development` | 2 added, 1 removed | Points at the PRD and the tracker instead of a standalone spec file |
| `security-and-hardening` | 2 added, 1 removed | Description widened so OWASP, login, and session questions route to it; a routing defect the evals caught |

## Deleting them

When the comparison is done: `rm -rf skills/*-original skills/README-original-copies.md`. Nothing references them, so nothing breaks.
