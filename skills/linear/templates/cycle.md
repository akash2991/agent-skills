# Cycle record and cycle review

The record goes in the cycle description; the review is a comment at close. Use `linear` for native cycle and estimate mechanics, and `planning-and-task-breakdown` for the outcome-based plan and review.

```markdown
## Cycle <id/name> — <start> → <end>
- Project/milestone links: <ids; a cycle can span milestones>
- Usable goal: <what a user or consuming service can exercise at the end>
- Verification: <end-to-end flow and command or manual check>
- Product continuity: <existing flows that must keep working>
- Estimate scale: <the team's configured scale>
- Capacity: <effort and units, or size distribution> (basis: Linear forecast / observed delivery / explicit assumption)
- Planned: <effort in the same units> across <n> design-ready issues
- Issue index: <ids in dependency order, including integration and verification>
- Deferred scope: <what remains for later usable increments>

### Cycle review
- Usable outcome: <demonstrated result and evidence; unmet goal explicitly named>
- Delivered: <effort and units> (<n> issues)
- Rolled over: <issue: reason, revised estimate, next-cycle decision>
- Estimation error: <original estimate, observed complexity/effort, cause>
- Unplanned work: <issue: estimate, why>
- Blockers hit: <issue: blocker type, resolution>
- Next cycle capacity: <effort and units> (basis)
```
