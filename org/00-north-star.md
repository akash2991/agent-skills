# Agent Organization

The operating brain for this repository. It is a set of scoped agent personas, the conventions they enforce, and the skills they work from.

This file is the same for every coding tool used here, so it names no tool. Where your tool keeps the personas and skills is in "Where things live"; the rest of this document is true whichever one you are.

North star: **continuous delivery.** Every change is small enough to merge, shippable on its own, and leaves the repository releasable. Not maximum architecture, code, infrastructure, or parallelism. A large amount of code that is not shippable is a failure, however good it is. The measure is: could this go out today?

**A person runs this, not the organization.** The user invokes one agent, it does one step, and it hands back. No agent starts the next step, and no agent invokes another. Wherever a persona says "the user", it means whoever invoked you.
