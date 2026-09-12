now how do i use everthing that i have created in my repo slop?


Here is the end-to-end path from this repo to a working organization inside slop.

1. Build once here


cd /Users/akashagarwal/Desktop/agent-skills
npm run all            # validate + select + build → dist/<tool>/
Edit manifest.json first if you want fewer tools or skills. Nothing in dist/ is hand-edited.

2. Inject into slop


npm run inject -- /path/to/slop --dry-run                 # see what would land
npm run inject -- /path/to/slop                           # all six tools
npm run inject -- /path/to/slop --targets claude-code     # or just the tool you use
Then commit the result inside slop. What lands there:

In slop	What it is
CLAUDE.md / AGENTS.md / GEMINI.md / .cursor/rules/agent-brain.mdc / .github/copilot-instructions.md	The always-on org, as a managed block; your own text outside the markers is kept
.claude/skills/, .agents/skills/, .cursor/skills/, .gemini/skills/, .opencode/skills/, .github/skills/	The 25 selected skills plus one skill per persona
.claude/agents/, .gemini/agents/, .opencode/agent/, .github/agents/	The 14 subagent personas (never the CEO)
.agent-brain/	ORG.md, registry/, docs/ (global conventions, decisions, changelog), services/, templates/, references/
.mcp.json	The Linear MCP server, merged with anything already there
Registry, global docs, and the services folder are seeds: re-injecting never overwrites them.

3. One-time setup inside slop

Open the tool once so Linear's MCP server completes OAuth (Claude Code reads .mcp.json; Codex, Cursor, Gemini, OpenCode, and Copilot need the manual step listed in the linear skill).
Fill .agent-brain/docs/CONVENTIONS.md overridable rows that are already decided for slop (backend language, database if not Postgres, commands).
For each service, copy the service docs: cp -r .agent-brain/templates/service-docs .agent-brain/services/<name> and fill CONVENTIONS.md commands.
4. Run it

Start a session in slop and address the main session as the CEO. A first prompt that exercises the whole flow:


You are the ceo persona. New requirement: <one paragraph>. Register in the registry,
assign a PM to brainstorm the spec with me, then run the flow through PRD, HLD, design
review, milestone and sprint planning in Linear, and start the foundation task.
Report in the CEO format. Ping me when a story is ready to verify.
From there the org runs itself: the CEO spawns the PM, PEs, EMs, staff engineers, code reviewers, test engineer, and specialists as subagents, everything is tracked in Linear, and you only talk to the CEO. In single-session tools (Codex, Cursor), the same session plays each role in turn using the persona skills.

5. Keep it current

When you change a persona, skill, convention, or org part here, run npm run all and npm run inject -- /path/to/slop again. The always-on block and owned files update; your seeds stay. Adding a skill is npm run import -- <path> --category <name> plus a line in manifest.json and an eval case file in evals/cases/.

Two things worth knowing before the first real run: the Claude Code subagents cannot spawn subagents, so the CEO session spawns engineers on the EM's behalf (the delegation note in ORG.md explains this), and the user-verification states in Linear (Approved, Merged, QA) need to exist in your team's workflow or the skill falls back to labels.



-------- brownfield project ------

Start the session in slop with:

You are the ceo persona. This is a brownfield repository. Run the brownfield-adoption
skill: inventory the services, assign an EM per service and a PM per product area,
create the service docs, and get the as-is HLD, LLD, and DB schema written per service
and overall before any refactor. Report in the CEO format with UNKNOWNs marked.


Pass 1 gives you services/<name>/ with CONVENTIONS.md commands that actually run, as-is HLD.md, LLD.md, schema.ddb, hld.drawio, the overall as-is HLD in the global docs, and a recorded baseline verification per service.
Pass 2 gives you a gap table per service (convention, current state, gap, blast radius, tier), plus the OpenAPI and generated-client inventory. Product-affecting gaps reach you as batched CEO questions.
Pass 3 is ordinary delivery: PRDs per service whose outcome is "conforms to conventions X, Y, Z with behavior unchanged", milestones and sprints in Linear, and the refactors in this order: OpenAPI for every API and generated clients as the foundation task, then domain typing one endpoint or feature at a time with a characterization test first, then feature-first folder moves, then metrics and logging, then the rest. Every task is a small PR reviewed by the discipline code reviewer, and the baseline verification must stay green.
Two things to watch on the first run: mark anything the agents cannot determine as UNKNOWN rather than accepting a guessed as-is design, and expect the OpenAPI step to surface the most product questions, since it forces every implicit contract into the open.





---- observability ----
The build now ships a complete local observability bundle in every injected repo:


node .agent-brain/observability/dashboard.js          # hierarchy + usage
node .agent-brain/observability/dashboard.js --json   # machine-readable view
node .agent-brain/observability/dashboard.js --watch  # continuously refreshed
node .agent-brain/registry/status.js --stale 30       # compact registry-only fallback

The observatory combines the CEO → PM → EM → specialist parent tree with reported state, live runtime bindings, loaded skills and documents, their context contribution, turns, tool calls/failures, model tokens, elapsed time, and cost. Unsupported host data displays UNKNOWN instead of zero.

To place the live dashboard inside Herdr, inspect the plugin manifest and scripts, then opt in with `herdr plugin link .agent-brain/observability` and `herdr plugin pane open --plugin agent-brain.observatory --entrypoint dashboard`.

For live controls, run agents inside Herdr, install its host integration separately, and record `runtime=herdr` plus its agent name/pane id in the registry:


node .agent-brain/observability/dashboard.js --focus staff-ENG-42-1
node .agent-brain/observability/dashboard.js --steer staff-ENG-42-1 --text "Check the failing test."
node .agent-brain/observability/dashboard.js --interrupt staff-ENG-42-1 --confirm
node .agent-brain/observability/dashboard.js --stop staff-ENG-42-1 --confirm

Herdr supplies persistent terminals and focus/prompt/interrupt/pane-close control. Interrupt and stop require confirmation; stop closes the agent's pane and terminates its processes. Herdr does not supply token, cost, context, skill, turn, or tool telemetry. The injected metadata-only event emitter supplies that portable contract; Langfuse OSS is the optional trace tree/graph/session/cost backend. Injection installs or contacts neither tool. See `.agent-brain/references/agent-observability.md` before enabling an exporter or content capture.

The reconciled view. The registry shows what agents reported. The delivery-status skill runs the observatory and then reconciles against the agent runtime, product runtime, git, and Linear before labeling anything VERIFIED NOW. Asking the CEO "what is everyone doing right now?" gives you that reconciled report, including context, usage, tools, cost, controls, and model switches.

Two more angles you already have. Linear shows the same work by role:* label and assignee, with every state change explained by a structured status update. Claude Code itself shows live subagents in /tasks and, with Agent Teams, Ctrl+T.




------ usage loop -----

Here is the whole loop, from this repo to a working session in your project.

1. Build here


cd /Users/akashagarwal/Desktop/agent-skills
npm run all                    # validate + select + build → dist/<tool>/
manifest.json decides what gets built: which skills, which personas, which tools. Add a model to scripts/brain/lib/models.json before naming it in a persona.

2. Inject into the project


npm run inject -- /path/to/slop --dry-run
npm run inject -- /path/to/slop                          # every tool in the manifest
npm run inject -- /path/to/slop --targets claude-code    # or just one
Commit the result in slop. Re-running inject updates what the brain owns, merges the always-on file as a managed block, merges MCP configs by server name, and leaves the registry, global docs, and service docs alone.

3. Credentials, once per machine


export GITHUB_PAT=github_pat_...      # fine-grained: contents, pull_requests, metadata, actions:read
gh auth login                          # CLI fallback for GitHub
Linear authenticates by OAuth the first time the tool opens the MCP server. Claude Code, Cursor, Gemini, OpenCode, and Copilot read the injected config files; Codex and Kimi need the global snippet in .agent-brain/references/tool-auth.md.

4. Start a session in slop as the CEO

For a brownfield repo like slop, the first prompt is:


You are the ceo persona. This is a brownfield repository. Run the brownfield-adoption
skill: inventory the services, assign an EM per service and a PM per product area,
create the service docs, get the as-is HLD, LLD, and DB schema written per service and
overall, record the baseline verification, then the gap analysis. Report in the CEO
format with UNKNOWNs marked. Ping me when something needs my decision.
For a new feature later:


You are the ceo persona. New requirement: <paragraph>. Assign a PM to brainstorm the
spec with me, then run the flow through PRD, HLD, design review, milestones and
sprints in Linear, foundation task first. Ping me when a story is ready to verify.
From there you only talk to the CEO. It spawns PM, PEs, EMs, engineers, reviewers, test engineer, and specialists; the EM decides model routing, the CEO session executes it on Claude Code; work, PRs, and state live in Linear and GitHub; you get CEO reports and batched questions.

5. Day to day

Ask the CEO "what works right now?" for a delivery-status refresh at any time.
When a task no persona covers appears, the CEO sends you a hiring request; you add the persona here, rebuild, re-inject.
When you change a rule, skill, or persona here: npm run all, then inject again.
Adding a skill from elsewhere: npm run import -- <path> --category <name>, a line in manifest.json, an eval case in evals/cases/.
Where to look when something is off

Symptom	Look at
A persona did work outside its role	its ## Authorization in agents/, and the out-of-scope block in skills/escalation
Wrong model or effort used	the persona's allowed pairs and skills/model-routing
Ticket state and PR disagree	references/pull-request.md state table, skills/linear
Tool cannot reach Linear or GitHub	references/tool-auth.md
Rules text needs changing	the part under templates/org/, never the emitted ORG.md
