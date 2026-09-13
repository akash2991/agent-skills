# brain-org Low-Level Design

Owned by the brain-org EM. Describes the artifact set as it is, not as it might be. This service has no HLD by decision D-4; this file is the whole design record.

Keep it in sync. A change to ownership, an anatomy contract, or a placeholder updates this file in the same PR.

## What this service is

The organization itself as editable sources: the rules, the personas, the skills, the shared references, the report templates, and what gets stamped into a target project. Runtime behaviour belongs to `brain-platform`.

Two properties are the point. One coherent organization an agent can act on without a second reading, and artifacts that survive being rendered into six different harness layouts. This organization is opinionated on purpose and is not a general-purpose agent framework.

## Module boundaries

| Module | Responsibility | Not its job |
|---|---|---|
| `org/NN-*.md` | the always-on rules, in numbered parts, emitted as one `ORG.md` | anything a skill should own; per-task workflow |
| `agents/*.md` | who each role is, what it may do, which skills it may use | how a workflow is performed |
| `skills/<name>/` | how one kind of work is performed, with its own verification | who performs it |
| `references/*.md` | contracts and checklists shared by more than one skill or persona | anything with exactly one user, which belongs in that skill |
| `agents-reports/*.md` | the uniform report each role submits | the content of any particular report |
| `templates/` | what is stamped into a target project: global docs, service docs, the entry command | the injected copy, which is generated |

One artifact owns a topic; the others point at it. Duplication across a skill, a persona, and a reference is the failure mode this table exists to prevent.

## Glossary

| Term | Definition |
|---|---|
| Persona | A role: who acts, with authorization and a skill list. Carries no model or effort. |
| Skill | A workflow: how work of one kind is done, with triggers and verification. |
| Org part | One numbered topic of the always-on rules. |
| Friction | A cost paid by an agent doing real work because an artifact was missing, wrong, or unclear. |
| Guard | A rule protecting budget, concurrency, review, verification, scope, or privacy. Only the user may weaken one. |

## Contracts other things depend on

| Contract | Consumed by | Where it is defined |
|---|---|---|
| Skill frontmatter and sections | the build and the routing evals | `docs/skill-anatomy.md` |
| Persona frontmatter and sections, including `extends` and `abstract` | the build and the persona linter | `docs/persona-anatomy.md` |
| Placeholders (`{{ORG_DIR}}`, `{{SKILLS_DIR}}`, `{{PM_TOOL}}`, `{{TOOL}}`, the routing and delegation notes) | `scripts/brain/build.js`, which owns resolution | shared with `brain-platform` |
| Report templates | every persona | `agents-reports/` |
| `self.add` and `self.omit` | the product and self builds | `manifest.json` |

Anything a product artifact says must be true without the self-only artifacts present. The leak check enforces it, and caught rule 19b naming a brain-only skill.

## Decisions taken, and what was rejected

| Decision | Options | Choice | Why | Reversible |
|---|---|---|---|---|
| Rule storage | one large `ORG.md`; numbered parts | numbered parts | A part has one subject and can be reviewed alone; the single file is a build output | yes |
| Discipline variants | many full personas; a base plus `extends` | base plus `extends` | Shared duties live once; a variant states only its discipline | yes |
| Model on a persona | fixed; an allowlist; none | none | Model suits the task, not the role; the control plane records what actually ran | yes, and was reversed once already |
| Direct invocation | a command per persona; CEO only | CEO only | Budget, priority, and parallelism cannot be judged from inside a single task | yes |
| Self-only artifacts | ship everything; a separate repository; one source with a self build | one source with a self build | Brain-development artifacts must not reach product repositories, and two repositories would drift | yes |

## What must keep holding

| Path | Target |
|---|---|
| Routing: a request reaches the right skill | trigger rank-1 at or above 80%, currently 89% |
| Anatomy: every skill and persona conforms | 100%, enforced by the linters |
| Coverage: every skill is routable | every skill has an eval case, enforced by the eval run |
| Product build | contains no self-only artifact and no reference to one |

## Testing

The checks are the instrumentation: the skill linter, the persona linter, the trigger and routing evals, the reference-link check, the artifact-path check, and the render check over `build/`. Friction tickets are the qualitative signal, and recurring friction is the one that matters.

## Left to the implementer

Wording, section ordering within an artifact, and which existing artifact absorbs a small rule. This file only fixes ownership and the contracts above.

## Open questions

- Whether `references/` should collapse into the skills that use each file, now that skills are self-contained enough to travel alone.
- Whether the org parts need an explicit precedence order between themselves, or whether the numbering is enough.
