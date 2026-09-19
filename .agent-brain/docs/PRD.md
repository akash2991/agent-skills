# Product requirements

The whole product in one page. Owned by the **product manager**, who is scoped project-wide.

Its job is to say what this product is, who it is for, and what it must do, at a level that stays true for months. It is the source of truth every other requirement hangs off. If a feature contradicts this page, either the feature is wrong or this page is out of date; both are worth stopping for.

**Keep it high level.** Feature detail lives in the ticket for that feature. When a section here starts describing how something behaves screen by screen, that belongs in a feature PRD in the tracker, and this page keeps only the sentence that explains why the capability exists.

Updated when the product's purpose, users, or shape changes, and reviewed at every milestone close.

## What this product is

<Two or three sentences. What a user can do with it, and what changes for them because it exists. No technology.>

## Who it is for

| User | What they are trying to do | What they use instead today |
|---|---|---|
| <role> | <their goal, in their words> | <the status quo this replaces> |

## Capabilities

One row per thing the product must be able to do. A capability is stable; the features that deliver it are not.

| Capability | Why it exists | Where it stands |
|---|---|---|
| <name> | <the user outcome that is impossible without it> | shipped · in progress · planned · deferred |

## What this product is deliberately not

The boundary is as load-bearing as the scope. Each line here has saved an argument.

- <thing people reasonably expect that is out of scope, and why>

## Product decisions that constrain everything

Only decisions a feature cannot quietly reverse. The full list lives in `DECISIONS.md`.

| Decision | What it rules out | Where it is recorded |
|---|---|---|
| <e.g. one account per person, no organizations> | <every feature that assumed shared ownership> | `DECISIONS.md#D-n` |

## Open questions

Questions whose answers would change the shape of the product, with who can answer them.
