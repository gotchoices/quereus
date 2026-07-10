description: A developer can use one of the project's research-grade features without ever opening the docs that warn them it may break without notice; consider having the database log a one-time notice the first time such a feature is used.
files:
  - docs/stability.md (the tier definitions this notice would point at)
  - packages/quereus/src/common/logger.ts (existing logging surface)
  - packages/quereus/src/schema/lens.ts, lens-compiler.ts (a candidate first-use site)
  - packages/quereus/src/core/database.ts (where a per-database "already warned" flag would live)
----

## Where this came from

The `docs-stability-tiers` plan asked whether an experimental feature needs a visible
in-product signal beyond the documentation table, and was told to **recommend, not
mandate**. Publishing the tiers was a documentation change with a firm no-behavior-change
boundary; emitting a log line crosses it. So it is filed here as its own decision.

## The gap

Stability tiers are now published (`docs/stability.md`), and every user-facing doc
carries its tier. That works for a developer who reads the docs before adopting a
feature. It does nothing for one who finds `create lens` in an example, in an LLM
completion, or in a colleague's branch, and ships it.

The consequence is asymmetric: Experimental means anything may change or vanish in any
release, including a patch, with no upgrade path for anything already stored. A user
who never learns that pays for it at the next `yarn upgrade`.

## What is proposed

A one-time notice, emitted at most once per `Database` instance, the first time an
Experimental surface is actually exercised. Something to the effect of:

> Lenses are an Experimental feature: the API and any stored artifacts may change or be
> removed in any release, including a patch. See https://…/docs/stability.md

## The shape it should take, and the shape it should not

**Once per database, on first use — not at startup.** A process that never touches an
experimental feature has nothing to be told, and a startup banner is the kind of noise
people learn to filter, taking the real warnings with it.

**On first use, not per statement.** A notice on every statement is a notice nobody
reads.

**Not on the parallel-runtime optimizer rules.** This is the important carve-out. Two
rules from the Experimental parallel track (`rule-fanout-lookup-join`,
`rule-async-gather-zip-by-key`) are registered in the optimizer and fire on ordinary
`select` statements. The user did not opt in and cannot opt out. Warning them about a
feature they cannot avoid using is a warning they cannot act on. The tier there covers
plan-node shapes and internal APIs, never the correctness of returned rows — so there
is nothing for the user to do, and nothing to say. Warn only on surfaces the user
*chose*: `create lens`, `declare logical schema`, lens deployment, sync.

**Silenceable.** A library that logs unbidden is a library people wrap to shut up. Offer
an option (a `pragma`, or a `Database` option alongside the existing
`nondeterministic_schema` and friends) that suppresses it. Whether the default is on or
off is exactly the question this ticket exists to answer.

## Open questions for whoever picks this up

- Default on or default off? Default-on maximizes the chance the message lands and
  minimizes the chance it is wanted; default-off makes the feature nearly pointless.
- Which log level? The project's logger is `debug`-based, and `debug` output is off
  unless the user opts into a namespace — which would make a default-on notice invisible
  in practice, and may make this whole idea moot without a separate always-on channel.
  Settle this before designing anything else; it may be the answer.
- Is a log line even the right channel, versus a doc banner plus a typed export name
  (`createLensExperimental`), or nothing at all?
- Does the same treatment apply to Beta surfaces, or only Experimental? (Probably only
  Experimental — Beta breaks in minors, which release notes already cover.)

## Non-goals

- Any change to what a tier promises. Those are settled in `docs/stability.md`.
- Any decision about freezing the parallel-runtime track. That is a separate product
  call and belongs to a human.
