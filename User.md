This doc overrides any other previous instruction if it runs contrary to it.

I will be making a lot of changes in our working style. 

First of all, I would want to revert this repo back to its original shape.
When I say revert back, I mean
anything we have deleted, we have to revert it back. 
Anything we have updated, we will keep the updated file, and I will check that diff to see whether the update is good or not 
delete any duplicates. Ex, In the skills, there are some skills called "original" and "not", so just delete that and combine everything into one.

On top of this repo, I will add 
    my own skills (copied from git or my novel skills)
    edit the existing skills, 
    add my own agents 
    and org brain 
    etc., 
I am using this repo as a base repo to build my own brain.

I will dump all the skills here, and then there should be a JSON where I can just put the names of skills that I want to include in my brain. 
The brain will have agents, skills, agent-skill mapping, My coding conventions, 

as the repo has some structure for skills. If I am copying a skill from somewhere, we will put that skill as something to be refactored into the current structure, which we will do after eval. it will be an exception. 
but If you or I are creating a skill, that skill should follow that structure. 

-------

Org structuring: 

There will be agents (perosnas), like:
-  backend agent, 
-  web agent
-  mobile agent (React native)
-  PM agent
-  scout agent 
-  reviwers agents (testing, security, perf, code) (Highly specialized adversarial agents)
- etc.


agents like Backend agent, web agent, mobile agent 
    will be development agents. 
    They will write the code. Along with that , they can do the planning, create sprint and stories, write docs, do testing, build and deploy. 
    but they cannot do reviews 
Reviewing work will be given to specialized agents with specialized skills. Reviewing work will be very specific work.To get the best out of review

There will be skills (some will be general, some will be speclialized according to the domain), like: 
- code writing skills 
- testing skills 
- debugging skills 
- QA skills 
- review skills 
- etc.
Ex:
    Code writing skills: while it will have some general principles. It is also specific to how the code is written in frontend, backend, Android, etc. 
    Similarly, debugging skills for software and mobile are different from backend...It might include, let's say, starting a mobile emulator, then automating the UI, etc. 

There will be mcp tools
- linear
- grafana
- playright
- github
- etc.

Depending upon the task scope, an agent can have a view of 
    the whole project 
    or can have a local scope.

Depending on the agent persoan and work requirement, the agent will have access to 
    skills 
    tools. 

An agent can work with any model, thinking effort or harness

Let's say
	• While solving a bug in backend the agent will have bug debugging skills and  Grafana MCP tool
	• While writing code the agent will have LLD skills.
	• While doing scouting of a particular service, the agent will be doing read-only work of the specific service. 
    - While doing Planning: agent will have the planning skill, writing doc skill, etc. 
    - APM agent, or let's say a scouting agent, does not need to load the GitHub skill.
    - While discussing an idea, let's say I want a PM agent, so the PM agent will invoke, let's say, the interview me skill or the idea skill. And while discussing a design or tech decision, I can invoke a backend agent, and then the agent will invoke the same interview me skill and idea skill..But it won't invoke the code review skill or GitHub tool until required in that scenario.
    - In case of a big feature, It will create a plan and then create the storyboard, sprint, tasks in linear. For Small features like the respective agent can just directly create the ticket and start working on it.

There will be no staff, principal, EM role.
Merge the agent and remove duplicates.

root agent: 
    the one who will be talking to the user in a session
    a generalist agent
        will have very high-level view of how things work in the repo and how org works. Very very high level idea
    but as soon as it gets a task, it will load that specialized persona, required skills, required tools
        can only have one personality
    user should get the option in the CLI to select the persona of sub agent in that session
    needs to declare what role it is taking up and what skills it will use, what tools it will use, its model, harness and thinking effort (If it adds more skills and tools at runtime during work, those should also be included as well.)
    It will act as a task classifier and will figure out which agents need to be spawned to get the task done.
    it will call the subagents to distribute work
    can assing any persona to subagent (even its own person..in case it needs duplicate hands to parallize)
    will not dicatate the skills and tools of subagents
    to display the personas, skills, tools, model, harness, thinking effor of itself and its subagents . On demand. Create a command for it.
    Root agent's model, thinking effort, and harness will be decided by the user
    if a root agent is spawning sub-agents, it will have to explicitly ask the user to define sub-agents model, harness, and thinking effort.
    Basically, for any long-running work, the root agent will spawn a sub-agent. The idea is that the root agent should be free to take requests from the user, While specialized sub-agents will do the work

subagents: 
    agents called by root agent
    persona will be given by root agent
    depending on persona, it will load required skills, required tools, (If it adds more skills and tools at runtime during work, those should also be included as well.)
    needs to declare to root agent, on demand, what role ,skills , tools,  model, harness and thinking effort
    Sub-agents will be of two types (Defined by root agent):
        - Fire and forget
        - Fire and summarize 
            In fire and forget, the sub-agent will not return its result to the root agent, 
            but in fire and summarize, the sub-agent can summarize its work and send it to the root agent.
            For example, if I am discussing a feature with a PM agent and it fires frontend and backend agents, when they are done, it can just tell me, "Hey, the feature is completed," instead of summarizing their work.


Always keep the role and responsibilities of every agent very narrow and focused.
- So, let's say a feature requires changes across multiple backend services. The entry agent can take the role of a coding agent, but it can spawn subagents. It can take the role of planning and designing. It can create designs and things like that. Once it is approved, it can spawn subagents who are also backend engineers, but their scope is defined to their service only.
- "make a change which spans both frontend and backend." That agent has to choose one personality, let's say a backend personality, to be preferable, and then it will spawn another sub-agent with the frontend personality
- Let's say it has to write code, so it will take the response role of a backend engineer who can write code. It cannot take responsibility for code reviewing as well, so that role needs to be spawned as a sub-agent. 
- The agent will not do the work for which it does not have the skill. It has to deny the work. So a frontend agent cannot be asked to write backend code


Project management
	0. Always create a plan, storyboard, and tasks for a large requirement.
    1. always create a ticket, subticket etc before working. (file it under appropriate head)
	2. Ticket must always contain the user prompt verbatim, If a ticket is created in a direct response to a user request
    3. if a feature request comes, we should make it our top most priority that feature is delivered continuously to the user. The feature requirement should be broken down into stories and sprints in such a way that this remains true. Always. 

product
1. Avoid scope creep
	1. To be solved by phased PRDs and milesotning stories
2. gather Requirements 
3. For any requirement, no matter how big, cut its scope such that a MVP can be shiped at the earliest. After shipping MVP you can continue to work on the original scope. (Overlaps with continuous delivery.)
4. PM' should have success targets  for each feature


working loop:
    1. spec
    2. plan (PRD, then HLD, then LLD)
    3. code + testing
    5. PR
    6. code review 
    7. QA
    8. merged
    9. Build
    10 deploy
this loop is not required to be followed always. 
Given a requirement, an agent, can decide, "I'll just directly write the code, Without writing a design doc" That decision should be captured in the ticket: why the agent is skipping that feature, that step.
A human can also ask us to short-circuit the loop. Ex:  write code and deploy.


----
Conventions
There is already a @CONVENTIONS.md   file, 
but so I am adding more conventions, 
there could be duplicates. 
All the below conventions need to be followed. No convention can be overridden.

PR review guidelines
1. changes not related to the feature / task
2. changes not feature flag gated, wherever applicable
3. if change risks regression. 
4. Observability missinng or redundant. (metrics, logs)
5. Mising or redundant comments. Commmets shouls be very spraingly used
6. domain conventions not followed
7. use of strings
3. always raise the PR, Don't directly merge.  (Review can be made optional)
4. Don't hold PR for security audit. Security audit can be taken up later as a next requirements

Reviwers 
    - So, the existing agent will take the role of these reviewers by importing the relevant skill.
    - they can be code reviwer, QA reviewer, perf reviewer, security reviewer etc
    - They will create an issue on linear
    - will comment on PR (if PR is open)
    - optional

PR merge
1. delete remote and local PR
2. use regular merge commit rather than squash. That also keeps the commit ids quoted in the review threads findable


commit
1. Commit should contain model, thinking effor and harness
3. Keep committing small and working changes 
7. Best effort: Every commit should be a usable feature, Or should not break the app. That is, if your commit is pushed to production, it should not cause any issue. This might not be true in all the cases. In some cases, we would want to push the whole thing, but wherever it is possible, even if we are not pushing every commit to production, at least in spirit, we should follow it.


Continous delivery
- use semver
- progressively Usable product instead of creating everything in one shot (this is not being followed) (localhost stops working) (to check if it is not feasible)
b. for example: 
	1. if you get a very large scope, so instead of making changes all over the place and as a result making the product unusable is not acceptable. Rather, say create 1 api, test it and commit it. 
a. Always make sure that any change you make should work. Basically at every point the app should be working. Break tasks in such a way
While the above could not be possible for some technical things, like, database migration but if a feature request comes, we should make it our top most priority that feature is delivered continuously to the user.
use techniques like
	•  feature flag
	• Submit code without entry point
    - etc.

The above can be overridden when speed is required, so a human can ask you to do the whole dev in one shot, do one pass of testing, and then commit.

development parallism 
1. Api contract first, So that the frontend and backend can work independently
2. While working with APIs, not created yet, frontend can mock api according to the code contract
3. BE can return mock data for integration testing if code not complete
6. After deciding DB model, and api contract, backend services can work concurrently (For service-to-service communication)
7. Development: Each agent must Create their own environments 
	1. Git worktree
        should always be created at project root and not in the harness root (like in herdr root or claude root)
        cleanup after dev
	2. ephemeral environments
		a. Localstack  to mock aws
		b. Can take snapshot of db or seed script
		c. Own observability, metrics and logs (Optional to debug and things like that)
        d. docker container
8. There should be no confusion about what the dependency shape or type is if you are dependent on another service. it needs to be resolved first before doing anything.

testing
1. E2e testing..like how users of product will use the product.
5. Canvas testing automation (For frontend agent. to be figured out)
6. Concurrency and race conditions testing
7. Perf testing (deferred now)

Observability
• • Strucutred logging
• •  be judicious with logging. Don’t create noise. 
• tech metrics (decided by backend agent)
• prodcut and business metrics (to be decided by PM)
• alerts and runbooks (deferred)
• traces (deferred)

Architecture rules
1. Vertical slice architecture
2. The above goes hand in had with service first folder strucutre
3. Every service will be a collection of features
4. Service will represent the domain with well defined bounded context
• Keep the folder structure as flat as possible unless necessary. Avoid nesting.
7. Services as modular monolith (means Should be easy to host them as separate service but for now everything is serverd as a single binary)
5. Hexagonal architecure
6. monorepo
• Backend driven UI fo froentend (web and mobile)
• Mesaure and fix. Don’t fix for hypothetical scenarios
• Do not solve for scale unless it is established that scale is the bottleneck
• security only for securioty sensitive featuers like auth
• Instead of getting stuck or assuming, ask for clarity on ambiguities or some complex technical choices. 
- Be delibereate whle planning for 
    1. db models
    2. LLD like main classes, interfaces, composition and inheritence
    3. programming patterns like functional patterns (compose, ), oops patters (factory,registry )


Coding principals
1. No strings, 
2. no opaque objects. 
3. Everything should be typed 
4. generated backend typed client
5. client sdk should be outside of backend service folder..at the root
6. Client sdk can be required in multiple languages. So a generator might be required (Don't create beforehand, if it is not required.)
7. each service will maintain its client sdk. And any dependent service needs to call the sdk
7. external inputs need to be typed at the edges
8. Models separation in backend(api model, domain model, db model)
9. pay cost at compile time instead of run time
10. Treat errors as first class citizens in the domain. 
15. Typescript for FE
16. Don’t favor high cyclometry complexity
17. use swagger for apis
• Fail loudly. Don’t swallow errors. 
- If touching an existing code be backward compatible
• No silent Creep of tech decisions like automatic retries, queues, or elaborate coordination…unless we have the data and the case is strong that we need these things. Basically, only introduce complexity when it demands
- Avoid unnecessary misdirection. Code should read as flat as possible.
- Avoid defensive coding as possible in the business logic. Defensive coding is fine at edges.
- use Linter for backend and frotned
- Static type checker
- https://json-schema.org/
• Don't modify generated/vendor files
- Use domain-driven design.

Domain-Driven Design
- Don't use raw IDs. Wrap them in domain IDs.
- Define entities, value objects, bounded context, Domain events, Aggregates, etc.
- 



database rules
1. fail-on-conflict approach, not build for hypothetical high concurrency.
2. Connection pooling
3. migration
4. postgres
5. schema should live separately 


Documentation rules
• Be very economical with words.
• They should reflect high level ideas.
- Some documents might require some depth, such as RCA or design docs
- shouldnt copy the code in the code. For that person can always go to the code
• Not Every feature needs an HLD, LLD or doc update. 
• Create document index for Progressive disovery
• Keep doc current
• compact it regularly by extracting it into skills so that it's not bloated. 
- dont create cloud atrifacts. All docs should live in the repo
-  docs will be generated in two types
        as a md file which other agents can read (with diagrams as code)
        and as an interactive HTML which humans will use (as of now i will use lavish skill)
- avoid big docs because 
    You've already significantly reduced the audience (ain't nobody got time to read all that)
    you've increased the likelihood that information in it is outdated the moment implementation starts
- The older and longer the document, the less accurate, useful, and likely to be read and understood.
- In the doc for designs, use design-as-code, draw.io, Mermaid, drawdb.
- Every HLD, LLD, or PRD doc needs to be reviewed by me.
- While creating a doc think about how you can be succinct without losing the information. 
- Not everything needs to be documented. Some things are obvious. 
- linear ticket and commit message will proxy for majority of the docs, so focus on creating good tickets and good commit messages.
- Docs should live at the root of the original project or in the corresponding services. They should not live in the agent brain, which is the current implementation as of now.
- These dogs will live in their folder because, for a particular service, there can be multiple Cheldee dogs. In a service, there should be a Cheldee folder.


Docs
1. Architecture.md: really high level view. Connecting to service level docs 
2 web arch.md
3 backend arch.md
    - infra.md
    - other relevant sections
4 mobile arch.md
2. development.md
3. Deployment.md
4. Debugging.md
5. PRD.md 
    at project level 
        one from user point of view
        one from backend point of view
    at each service level (wherever it makes sense)
6. HLD and LLD (at project level and at each service level)
7. Rca (Whenever required, at service level). Remove the current RCA doc template. I will give you the new template later.
8. Conventions.md 
9. domain design doc. prodcut, business and tech will refer. Always
10. changelog.md (Maintained at global level.) (For web, mobile, and backend)

No other agent report or doc is required.


Artifact anatomy
1. HLD: 
    The current HLD doc looks good with some improvements.
    Remove the block that it is owned by EM. Since we are getting away from the role of these roles, HLD is basically not owned by anyone. Anyone can edit HLD If the agent has the skill
    In API, do API names, interaction with services, Some basic request response that is not expected. Actual contract, we will decide in LLD.
    Remove the light LLD section.
    Remove purpose, responsibility, non-responsibility.
    Remove context and boundaries. I think it will be covered in the API interface only.
    Add scale estimations. (Initially, scale will be low.)
2. LLD: 
    Current LLD doc looks good with some improvements. 
    remove this same EM section.
    create a UML diagram. Instead of sequence diagram
    Remove observability, as it is covered in HLD.
3. PRD: 
    Remove ownership line from PRD.
4. Linear ticket
    Source of truth for everything
    Every agent will work on a task. Tasks can range from as big as creating a PRD, HLD, and LLD, or can be as short as "fix this small bug."
    But every task will have a goal. 
        Goal's anatomy is described below.
         ticket should reflect the goal for the agent, Apart from other ticket-specific things. 
5. Commit message
	1. summary (tight. in pointers)
	2. Deployment order (if applicable)
	3. Testing/Verfiicatio plan (what you did to do testing)
    4. Blast radius/Risk analysis
    5. rollback plan
    Important: Don't duplicate sections or details which are already in the linear ticket.
6. ARCHITECTURE.md 
    Remove the ownership line.
    Do not write contract in the doc. user should be able to use the SDK to get the contract type.
    Remove where change belongs.
    Remove cross-cutting decisions.
    it will have sections
        1. Project structure
        2. Tech stack
        3. Features (some details. But link to PRD)
        4. Api reference (link to swagger docs)
        5. Will link to web, backend, and mobile docs
        6. other relevant sections
2. development.md
	1. Local setup
	2. Dev commands
    3. run commands 
    3. testing
    - other relevant sections


goal anatomy
    • Outcome: what should be true when the work is done.
	• Verification surface: the test, benchmark, report, artifact, command output, or source material that proves it.
	• Constraints: what must not regress while agent works.
	• Boundaries: which files, tools, data, repositories, or resources agent may use.
	• Iteration policy: how agent should decide what to try next after each attempt.
    - Blocked stop condition: when agent should stop and report that no defensible path remains under the current limits.


For all the anatomies above, While these sections are guidelines, 
- feel free to add a new section if a radical demands it. And then we can see if we want to include that section globally or not.
- it is not mandatory to fill everything, use your discretion.
- In cases such as linear ticket, commit messages ... anatomy also depends on the work type, whether it's a bug, feature, or chore. In that case, the anatomy will change.




For large scale deprecation/migration
1.  Create new prallel features
2. Marke old code and flow as deprecate
3. Don’t allow addding anything new in old flow
4. Test new flow
5. Swithc to new flow
6. Delete old flow
7. Migrate old data
8. Don’t edit old flow in place
9. Old flow should be kept working as you make new changes
A human can override the above migration plan

soul
1. Have an opinion.  Disagree, prefer things
2. You are working with an experienced engineer who can take criticism and can understand direct points. 
3. You can't hurt humans' feelings. Be straight to the point. Be critical when you have to. 
4. Be very economical with your words. 

mobile
Few features will be required in every mobile app
So it should be build in such a way that it is easilty extractable and pluggable in other apps..without doing duplicate development
like
    1. Auth (login via otp and oauth)
    2. notifications
    3. force update
    4. Analytics

backend
Few things will be required in every project, so they should be pluggable modules.
like.
1.  payment service
2.  Auth (login via otp and oauth)
3.  profile service



Self improving harness
 So that new knowledge is recorded
1. Every human feedback must be recorded for improving the skill. 
2. auto-updated if any agent encounters any issue or writes some code to achieve something

a human with its explicit direction can override everything written in this doc.
but that needs to be stored to improve the harness.


Exmaple
✍️ Learning notes added:
Learnt from: akash
PR Number: 3382
Filename: datadog/alerts/daytona/export-broken.json
Timestamp: 2026-09-15 21:41:15
Notes: Use only the on_missing_data configuration for Datadog monitors; when it is set to show_and


---
Brownfield repo
None of the above Conventions can be overridden 
but in a brownfield adoption ...Do a preliminary analysis and create a table against each covention, saying whether that covention has been followed or not followed. 
So that we can incrementally move the code to our convention style
Move docs to the correct location.
Do not delete existing docs, but we are moving forward. We will make sure that we are not adding anything to deprecated docs and that the docs are created in the agreed-upon faishon.


