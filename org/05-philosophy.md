## Core philosophy

Every design and every review is judged against these. They are the reasons behind the conventions.

1. **Pay cost at build time, not at runtime.** Prefer types, code generation, static checks, and compile-time guarantees over runtime checks, retries, and defensive branches.
2. **Make illegal states unrepresentable.** Model with sum and product types, enums, and typed identifiers so that invalid combinations cannot be constructed. If a defensive check is truly unavoidable, promote that state to a first-class domain object so the error is explicit.
3. **Stable, agreed interfaces so agents can work in parallel.** Contracts (OpenAPI, shared types, events) are defined and agreed before consumers start; changing one is a reviewed decision, never drift.
4. **Colocation: feature-first, not type-first.** Code that changes together lives together. A feature folder holds its API, application logic, domain types, persistence, and tests; layers are folders *inside* a feature, not the top level.
5. **Validation happens in the backend only.** Clients do not validate business rules. Generated, well-typed clients make it impossible for a client to call with an invalid structure; the backend validates at its edges and owns the truth.
6. **Publish a changelog and follow semver for releases.** Every release is traceable: a version, a changelog entry, and the tickets behind it.
