I am trying to create my own AI workflow, so I am taking reference from existing AI workflows. 
You need to help me morph them into the workflow which suite my style.

For the initial change, I am basing it on this agent skills open source repo, we will morph it, 

To give you some idea of this repo, 
- there is a folder called agent-os. I dumped my own thought process in that folder. Do not edit it. Some of it might be wrong / irrelevant

Goal : to convert it into an injectable format (like a library) which I can inject into any repo, and that repo will follow the rules which are described here: the best practices, the way of working, the way to deliver the project, etc. It will basically be the brain of how agentic coding will work.

Approach:
not to perfect everything on day one. 
take it step by step.
We will keep on iterating, adding more things and practices from other sources / repos
to push out the usable format as soon as possible, which I can start using in my own projects.

i want few things from the outset..the main scaffolding
1. Want a skill dump folder where I will be dumping skills from the internet and from my own experience. There will be a script, where I can put in the name of the skills that I want to use. That script will run, and then it will put the desired skills in the actual skills folder that will be build.
For better management of skills, skills folders need to be divided into subfolders, such as:
- agent persona skill
- tool skills, such as Prometheus and Linear
- coding skills, such as LLD, HLD, strong typing etc.
- domain skills such as security

2. since This will be multi-agent support, and each agent requires files in a different format. but we will not duplicate anything. The source of truth will lie in one place, and the script will run and copy and transform those files into desired folders, formats, etc. acc To the requirement

3. An organizational structure 
- where we have a CEO, PMs, and EMs, principal engineers and staff engineers. 
- In a Project: There will only be one CEO. There cannot be more than one CEO. I will only be talking to the CEO, and the CEO is responsible for everything. EO will help me in defining the spec or the idea, so it will ask questions and anything. 
- In this structure, the CEO will look at the project delivery, and it will have PMs under it. 
- PMs will own the feature end-to-end. That feature might require changes in multiple services, so their EMs will come into the picture. 
- Ems will own services. EM Will then divide the feature into Milestones favoring delivery over perfect feature. EMs will ask the principal engineer to create the designs, HLD, and LLD. EMs Will also act as an LLM router. Depending upon the complexity of the problem, they will route the problem to the appropriate model type, thinking effort, and also by looking at the budget that they have. 
- Once a Design has been approved by another principal engineer. 
- Staff engineers will implement it. Small and low blast radius changes Can be directly merged, but other changes can require approval of Another staff engineer. 
- If anyone in the org has an ambiguity, they have to surface their question to the CEO, and the CEO will ask me. But try to solve it to see if others can solve it. Example: if a staff engineer has any issues, they can ask the EM. If the EM does not have the answer, he can ask the PM. If the PM does not have the answer, he can ask the CEO. If the CEO does not have the answer, he can ask me.
- Everyone in the org will have a clear goal. And they Will submit their report in a specified and uniform format. Example: All staff engineers will submit their report in one format.
We company-wide agent registry where each agent , including ceo. To register themselves, registration needs to be in a common format, such as the type of model used, thinking effort, role, ticketId on which it is working etc., so that anyone in the company can see what each agent is working on.

For project management, 
- use Linear. 
- Project Management tool can be changed later
- Use it to:
    - Create milestones
    - Create sprints
    - Create tasks with defined goals to mark blockers
    - basically to Communicate anything that needs to be done for project management

Start with this basic structure, and then I will add more things.


----- update 1 ---
follow the structure of the root directory.
Skills should follow a defined format, which is given in the skill anatomy.md.

In org structure, every one will habe an agent persona. 
The CEO will be a persona, and the backend principal engineer will be a persona etc. 

Every persona will have 
- roles, 
- responsibilities, 
- goals, 
- how they will communicate, 
- their success criteria etc. 
- access to specific tools, 
- be authorized to do certain things
- structured way of working
- non negotiables on quality
- access to certain skills. 
    Such as staff engineer will have access to the end-to-end testing skill, domain modeling skill
    but principal engineer won't. Principal engineer will have access to the domain modeling skill , HLD skill, LLD skill


Model Routing 
    will be a skill 
    which will be used by EM.


Project flow
- PM will give the detailed PRD 
- the principal engineer will create LLD, HLD and implementation plan (PEs will always use high thinking effort)
- PEs will work across services to create unified HLD. They dont care about the low level details of specific service. They will help in deifining domain models and some interfaces and interactions of important classes. But rest they will leave to the judgement of service owners
- EM will break the implementation into milestones, favoring quick and incremental delivery (this will be driven by a skill)
- will create sprints, stories, tasks etc (in the project management board)
- Based on complexity and the budget available, EM will assign eacjh task a model and thinking effort based on the model routing skill.
- then EM will invoke the staff engineer (bsed on model and thinking effort) and handover the ticket to it with relevant context
- staff engineers will be service specific
- in some cases, it is not possible to break each task to indicidual owners. As some tasks require defining things that will be used by others to build upon. So such tasks (like decining all the class interfaces, folder strucure, api models etc) will be done by a dedicated staff engineer. Once it is done, others can start working on top of it individually

Every EM Maintain the docs around their services, such as (indicative)
	• Conventions.md 
	• CHANGELOG.md
	• HLD.md 
	• LLD.md
	• CURRENT_MILESTONE.md
	• Decisions.md
	• RCA.md
    - bugs.md


some of these docs will be maintained at global level as well. ..such as convetions.md
Global docs will be divided into two part overirdable and non overridable. Service level docs can override overridable properties of global docs.

For escalation, 
- use the project management. Let's say a ticket is assigned to a staff engineer, and the staff engineer is not able to solve it. The staff engineer will assign the ticket to an EM, and the EM will take a look at it. If it's not, the EM will assign this ticket to the PM and then the CEO. and then me. Each persona will keep track of the tickets assigned to them. make escalation a skill so that when agent is stuck, they can refer to this skill and escalate accordingly.

----- update 2 ---
- When the new requirement comes, CEO will assign a PM with the spec skill which with with which I can brainstorm to define the idea.
- divide engineers (PE and staff) into web, backend, React native mobile 
- EMs will owne the whole service end to end..be, fe and mobile. 
- in overlapping cases, where service boundary of the project/feature is not clear (that is leaking into multiple services), CEO will assing one EM as the driver of that project/feature
- keep the skill dump folder flat. Remove nesting. Add a optional category field in the skills..to categorize during generated folder. 
- cleanup
    get rid of agent brain folder 
    and in agent OS folder 
        - at least get rid of duplicate skills, personas, references, storyboards (which not required as of now since we are using linear)
        - just look at the skills and the agent personas. And if you think that anything needs to be added to the agents... to the docs that you have created, then add them
    use the original original folder structure that is move agents and skills and reference to the root folders
    if there is a conflict, between previously files and your files. Your files take precendence. For example, in agents folder tehre are already similar agents. Read them and see if you need to include anything. And then delete. And put your files. 


----- update 3---
Every status update and linear will be followed by a a structured explanation. So such that in case of blockers and if a ticker is assigned to a another person, so the blocker need to be defined, let's say, what is the blocker type, what's the dependency, what the requirement is, etcetera. Right? So

For bugs, we don't need to maintain empty file. The tickets in linear will be tagged as bugs with the exclamation like WhatsApp bug type. How was it discovered, etcetera. So, basically, each ticket will have its own structure in which... so that anyone can query what was the ticket about, and let's say if there is an update on the ticket, it's a status change or things like that. So, again, the the... it should be updated in a structured way.

At high level loop remain the same. That is idea, spec, design, code, test, QA.

remove this concept of waves. It should be sprints. So, basically, there should be a sprint, one sprint, two sprint, three. Right? So a a project can be divided into milestones, and then milestones will be, you know, taken sprints, uh, will be divided to sprints, and then each sprint will have its, you know, task and search. So... and so that we can have the idea of spread, uh, spillover, correct estimation, wrong estimation, etcetera. So that will also be track of, but remove this wave thing. I

----- update 4---
there is already code reviewer agent 
promote the it to back end code reviewer agent and write other two code reviewer agents ..web code reviewer, and mobile code reviewer. 

repo already had agents. So the structure of the agents you created and the original agent should reconcile.  
there is some commonality between the agents. So so that common part should be reconciled, basically. 
basucally every agent should follow persona-anatomoy.md. And this md file should be updated if we discover a more relvant strucutre or sub field

two duplicate agents test engineer and QA engineer...right? see if They need to be merged

There are two agents.md file in folder named deprecated. So see if we can use the the principles described in that in our own agents file 
also try to break the agents.md file into, smaller structured manageable files. 
During construction, we will emit one file. 
but to maintain, we will have to break it down into manageable files.

----- update 5---
process:
staff engineers will raise the PR. 
and code reviewers will review the PR and put PR comments. 
Engineerts will solve it.
Everything will be tracked by linear ticket status

working style:
staff engineers will put metrics and loggging.
they need not to go overboard with logging. 
While being midful of the fact that metrics are required for tech, prodcut and business. 


----- update 6---
Core Philosophy
	- Pay cost at build time rather than at runtime
	- Make illegal states unrepresentable 
	- Stable and agreed Interfaces , so that agents can work parallelly
	- Colocation. Feature first folder structure instead of type first.
	- Validation should always happen in backend. 
	- Frontend shoudnt do any validation. Types clients should makes sure that frontend can only call with valid structures
	- Publish change log and Follow semver for releases

Tech stack
	1. monorepo.
	2. modular monolith (services can be deployed as independet servers or can be packaged as single binray)
	3. Infra via terraform (for aws)
	4. swagger api
	5. fe in react and typescript 
	6. be in golang/python (ask)
	7. docker for local development
	8. postgres for db 
	9. observability using prom + grafana + loki 
	10. mobile in react native / expo (choose easiest option first, unless complexity says otherwise)
	11. Use Github for ci/cd
	12. Use Mermaid to create flow diagrams as code
	13. Use Draw.io to create hlds as code
	14. Use drawdb to create db schema as code
    15. Use linear for all project management flow

Principal Engineer  needs to do following in HLD planning
	1. api interface
	2. domain models and glossary
	3. Interaction between services
	4. Clear Service boundaries (if creating new service or deciding where one feature should sit)
	5. tradeoffs
	6. assumptions
	7. Goals
	8. Non goals
	9. Diagrams 
	10. Constraints
	11. Observability (keep it high level)
		a. Metrics
		b. Logs
		c. Alerts
	12. Aleternatives considered
	13. Dependencies /Infra
	14. SLOs
	15. Constraints
	16. Some LLD
		a. Important classes, its interfaces and interactions among them
		b. DB schema
		c. API contracts

It has some elements of LLD
In HLD, PE will keep these things very high level (if he deems fit to discuss. Can skip them as well)
And can callout things he left for staff engineers to figure out. 


LLD skill
	1. Make illegal states unrepresentable 
	2. Do validations at the edges (when receiving data from api, database, event store etc.)
	3. Business logic should have zero to minimal defense
	4. If defensive programming is absolutely necessary, try to make that illegal state a first class domain object so that errors are explicit and not implicitly
	5. Strong typing according to domain model
	6. OpenAPI and generate well-typed clients
	7. Type json
	8. Use enums
	9. Avoid raw strings at all costs
	10. Don’t favor high cyclometry complexity
	11. Separation of api models, domain/application models and db models…so that each layer can evolve independently
	12. Don’t put comments in the code. Put comments in the ticket and link ticket in the code
	13. Comments should be sparingly used and should describe the "why"..that is product/business reasoning behind the code. What code is doing should be self explanatory
	14. Always write testable code. That is 
		○ don’t inject  concrete dependencies directly
		○ Avoid random(), time() in the code
	15. Favor composition over inheritance
	16. Deliberation on domain models
		a. Use domain models for uuids
        b. Sum types, product types

i am not sure from above, what will go into skill and what will go into agent persona. You can take the call.


----- update 7---
Two things for setup won't it require GitHub MCP to, you know, do PRs and such. A

And second thing is the... this Slop project is a brownfield project. So I need to, 
- first of all, assign EM/PM in each service so that that that service lelvel docs are created 
- document the current state of code..in HLD, LLD and DB diagram at overall level and at service level
- And I need to refactor the code  according to domain typing and, basically per API refactoring. 
- And need to generate strong client type clients if they are not there already. 
- And, you know, basically, refactor the code according to the conventions that we have written here. 

So how do I go about it?

----- update 8---

1. how other agents like codex, kimi will auth to linear and github?
2. each persona should have a default agent and thinking effort along with list of allowed agents and thining effort
3. for now make planning and coding personas to fable 5.1 high and rest make fable 5 high
4. every task in the org needs to be done by a specialised agent. If a task comes and no agent exists to do it, so surface it out to CEO to make new hire. Existing agents should aggresively deny anything outside of their scope.

----- update 9---
allowed models and allowed efforts terminology varies model to model. So I think we need to create a pair/tuple of model and effort. We cannot have them as two separate arrays. Then there will be invalid pairs. 

explan skill categories. While everything can be coding, it can be divided into design (LLD, HLD, etc.)
testing, deployment (build, ci/cd, ) etc...just a thouhgt


model routing will dependent on the underlying model which is being used. So let's say if CEO is running on cloud model so... and it does not allow nested creation of sub agents, in that case, the model routing will be done by the CEO itself. But let's say it's being... if the EMs are, let's say, codex, so they can do the model routing. So  I think that will depend on the model we used.
have you consulted orchestration-patterns.md?

----- update 10---
how do I see that how many agents are there, who who who is working, who is not, and, like, what's the status, etcetera. Is there any observability around it?

----- update 11 ---
--- executed by gpt sol ----
I want complete visibility dashboard in the agent working. So let's say, which agent is referring to which skill, first of all. Right? What is the context input, output? How much of the context is being taken by the skill or the docs? And how many turns they are taking, etcetera. Right? You can choose any open source tool, the GitHub tool that is available for such thing, or you can build it on your own. It's up to you. But, yeah, I mean, how many agents are working, like, as a tree first of all, a cruise at which agent is coming under which agent, uh, I should be, uh, accelerator phase, I should be able to, you know, jump to an agent session and, uh, steer it or stop it or whatever. But, yeah, I mean, the complete observability in terms of cost, uh, context, uh, length, uh, tool call, uh, etcetera.

before commititing ..you need to look at few tools
https://herdr.dev/docs/
see what it does and can it be used in our case.

I'm not sure about the available observability tools, but, yeah, you can check on the Internet. and only then decide... I mean, only build if what if we have to build otherwise US is including.

----- update 12 ---
ceo will have overall budget (input tokens, output tokens, cost)
it will allocate the budget to everyone in the org who directly reports to him (like to all the teams)
EM will take care of allocating budget in his team.
for now say company level budget is 100k input and 100k oouput tokens.
if an agent exhausts its budget, it needs to stop and escalate budget ask to its superior. Finall it will be bubbled up to me. 


----- update 13 ---
remove the default model thinking effort and the allowed model thinking effort from all the agents. Basically, any agent can have any, you know, model and thinking effort based on the needs, like, the task at hand and budget available, etcetera.

and basically create a SQLite DB to record everything instead of creating these MD files. what do you think?
So each... so  instead of having this agent registry or budget, usage or other things which we, uh, like, the observability and such which we recorded runtime, it's it's better to have a, like, a DB where we store everything and spin up a UI on top of it.  it will be update as well. So, like, at runtime, I should be able to change the thinking of part of an agent or model you the budget, etcetera. see if I existing tooling like langfuse or herdr can be used instead of creating things on your own. I want a running setup


Whenever I open a session, instead of typing the prompt that you are the CEO and blah blah blah, I should have a command which will load, you know, everything into the agent's context. So that I'm good to go. currrent agents model and thinking effort should automatically be loaded as the values for the CEO agent. 
If I open another terminal and another session, so it should not be... and if I, you know, start the, you know, entry command again, so it should not allow that session to be registered as CEO because it's already... another session is already registered.

So for the models, uh, I am using claud models and ChatGPT models and opencode which provides a set of models like Kimi, GLM, Groq.
So any model should be able to invoke, uh, you know, another model harness using Atlas commands. So let's say cloud model is an EM and it needs to invoke a a staff engineer with ChatGPT, so it should be able to invoke ChatGPT's Atlas command with the required data

I was testing the the the agent product that you have built, and there was issues in tracking the tokens used, cost, the current agent, etcetera. So for that, I was thinking instead of creating everything from scratch, should you be exploring this
https://github.com/kunchenguid/quota-axi

also exlplore this, if we shoukd use it
https://github.com/kunchenguid/axi


----- update 14 ---
for Mission Control, dont build task board. build agent tracking ..like cost, tokesn used, heirachy, model use, budget remaining etc.
then at overall model level.
again..i am in favor of using any exisitng tool.


----- update 15 ---
no skill or agent can be invoked directly.
everything has to go through CEO
As he is the ultimate guardian of budget, org level priority and parallism
if there are not enough resources, ceo will park the request in a ticket with priority
similary, i should be able to submit feature requests to ceo and he will park them with prioroty

every change should be commitable and deployable via ci/cd
dont hold PR for very large changes


Nothing emits usage events automatically yet, so per-agent tokens and cost stay UNKNOWN until a host hook calls brain.js event. Fix it. Each agent need to emit/store its stats

flatten the templates folder. avoid unnecessary nesting.
like, control plane should be outisde. report folder should be named agents-reports and should be beside agents

since my repo is taking over the original repo now. Delete relics of original repo which are not relevant
and replace it with the details about my repo.