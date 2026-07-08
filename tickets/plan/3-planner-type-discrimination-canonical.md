description: The optimizer identifies node types three different, inconsistent ways scattered across dozens of files; choose one reliable convention so these checks stop drifting and misfiring.
files: packages/quereus/src/planner/framework/characteristics.ts
difficulty: hard
----

## Problem

Across ~40 planner files, "what kind of node / what can this node do?" is answered three incompatible ways:

- `instanceof` class checks (~179 occurrences)
- `nodeType` string comparisons
- duck-typed `as any` property detectors (e.g. the ones in `framework/characteristics.ts:323-443`)

Three idioms means three failure modes and no single place to reason about node classification. The duck-typed detectors in particular are fragile (see the concrete defects tracked in `planner-type-discriminator-defects`): they misfire on incidental property presence and on `typeof` mistakes.

## Expected behavior

One canonical, type-safe mechanism for node discrimination and capability detection, used consistently. Adding a node or capability should have exactly one obvious way to be detected, and the type system should catch mistakes.

## Direction (design decision — resolve before implementing)

Evaluate and choose among (not exhaustive):

- **Discriminated union on `nodeType`** with exhaustive `switch` and compiler-checked completeness — cheap to check, but capabilities that cut across node classes don't map cleanly to a single tag.
- **`instanceof` on canonical base/marker classes / interfaces** — natural for capability mixins, but couples to class identity and can be awkward across module/bundle boundaries (a cross-platform concern for this project).
- **Explicit capability flags / typed marker interfaces with real type guards** — each node declares the capabilities it supports via a typed field or guard function; detectors become total and lint-checkable.

Decide the primary mechanism for *class* identity vs. the mechanism for *capability* detection (they may legitimately differ), document the rule for rule-authors, and lay out a migration path that converts the existing idioms incrementally without a single giant unreviewable change. Consider a lint rule forbidding new `as any` node detectors once the canonical mechanism exists.

This is a cross-cutting refactor; scope it so it can land in reviewable increments (per-capability or per-directory), each keeping the build green.

## Relationship

`planner-type-discriminator-defects` fixes the specific broken detectors now. This ticket picks the standard so those fixes and all future ones share one mechanism.
