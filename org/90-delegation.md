## Delegation and routing execution on this harness

{{DELEGATION_NOTE}}

{{ROUTING_NOTE}}

These follow the endorsed patterns in `{{ORG_DIR}}/references/orchestration-patterns.md`: the CEO session is the orchestrator (delegated captaincy), personas never invoke personas, orchestration depth stays at one, and independent reviews fan out in parallel with a merge in the CEO session. The EM's routing is a decision with domain value (tier, budget, review path), not a routing persona: it produces an assignment packet, and the spawner executes it without paraphrasing.
