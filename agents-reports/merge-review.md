## Report
- From: <agent_id> (<backend|web|mobile>-code-reviewer)
- To: <author agent_id>, <em agent_id>
- Ticket: <tracker id>
- Status: DONE
- Model / effort: <model> / <effort>

### Change under review
- PR: <url> · commit/branch: <ref>
- Author: <agent_id>
- Claimed blast radius: small | reviewed
- Tier / review path: <T1..T3> / <peer | peer + PE | peer + PE + security>

### Verdict
APPROVE | REQUEST CHANGES | BLOCK

<one or two sentences summarizing the change and the overall assessment>

### Checked
- Tests read first; each acceptance criterion maps to a test: yes | no
- Matches the approved LLD section: yes | no | n/a
- Stays inside owned paths: yes | no
- Verification commands re-run by reviewer: `<command>` → <result>
- Blast radius classification is correct: yes | no (reclassified to: <x>)
- Contract, schema, auth, payment, or data change present: yes | no → security pass recommended: yes | no
- Instrumentation: metrics for tech / product / business where warranted: yes | no; logging restrained, no PII or secrets: yes | no
- Inline PR comments posted: <n>; earlier comments resolved: yes | no | n/a

### Findings by severity
- [Critical] `<path:line>` — <issue> — fix: <specific recommendation>
- [Required] `<path:line>` — <issue> — fix: <specific recommendation>
- [Optional] `<path:line>` — <issue>
- [Nit] `<path:line>` — <issue>

### By axis
- Correctness: <ok | see findings>
- Readability: <ok | see findings>
- Architecture: <ok | see findings>
- Security: <ok | see findings>
- Performance: <ok | see findings>

### Done well
- <at least one specific positive observation>

### Escalations
- <Escalation block, or "none">
