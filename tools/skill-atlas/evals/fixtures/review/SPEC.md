# Proposed change
Add an optional limit (default 20, caller guarantees integer 1..100) and sort visible records by updated descending. Ties keep input order. Visibility remains: exact tenant match AND not deleted. Inputs and record objects must not be mutated. No new dependencies.

# Repository standards
Prefer ordinary array operations for this small dataset; no repository class or architecture rewrite is wanted. Findings should prioritize observable defects, not formatting. The fixed review boundary is before.cjs versus after.cjs, not this enclosing repository's Git HEAD.
