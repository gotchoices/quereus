description: The shipped "Singleton equivalence" property law is green-by-construction and cannot catch producer drift — its three channels (empty key in `keysOf`, the `∅→all_cols` FD, `isAtMostOneRow`) are all derived from one another (`keysOf` consults `hasSingletonFd`; `isAtMostOneRow` consults `keysOf`). Add a law that pins the *independent* ≤1-row encoding channels — the declared empty key in `RelationType.keys` vs. the singleton FD in `physical.fds` — and reconcile the producers that diverge today.
files: packages/quereus/test/property.spec.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/src/planner/nodes/pragma.ts, packages/quereus/src/planner/nodes/single-row.ts, packages/quereus/src/planner/nodes/analyze-node.ts, packages/quereus/src/planner/nodes/declarative-schema.ts, docs/optimizer.md
----

## Problem

The `singleton-fd-producer-dry-and-law` ticket shipped a "Singleton equivalence" property law asserting:

- `isAtMostOneRow(node)` ⇒ `keysOf(node)` contains the empty key `[]`
- `hasSingletonFd(node.physical?.fds, colCount)` ⇒ `isAtMostOneRow(node)`

Both implications are **green by construction**: `keysOf` already pushes `[]` whenever `hasSingletonFd` is true, and `isAtMostOneRow` (= `isUnique([])`) reads its truth back out of `keysOf`. Algebraically, with `D` = "declared empty key in `RelationType.keys`" and `F` = `hasSingletonFd`:

```
keysOf has []   ⟺  D ∨ F
isAtMostOneRow  ⟺  (keysOf has []) ∨ isSuperkey(∅)  ⟺  D ∨ F
```

So `isAtMostOneRow ⟺ keysOf-has-empty ⟺ (D ∨ F)`, and both shipped implications reduce to tautologies. The law **cannot be falsified by any plan or producer** — only by a future edit to `keysOf` / `isUnique` / `hasSingletonFd` that breaks their mutual wiring. It is a read-surface regression guard, not the producer-drift guard the ticket aimed for.

### Concrete evidence the producer case is uncaught

Four nodes today encode ≤1-row via the *declared* empty key channel (`keys: [[]]`) with **no** singleton FD:

- `single-row.ts` — zero columns, so the FD is genuinely unrepresentable (no dependents); relies on `keys: [[]]` + `isSet` + `estimatedRows: 1`.
- `pragma.ts` — **two** columns (`name`, `value`), declares `keys: [[]]`, emits no FD.
- `analyze-node.ts`, `declarative-schema.ts` — likewise declare `keys: [[]]` with no FD.

`PragmaNode` is the smoking gun: a multi-column ≤1-row relation that *could* carry the singleton FD but doesn't. It is exactly the "empty key without the matching FD" case the original law comment claimed to catch — and it passes silently, because `keysOf` surfaces its declared `[]` and `isAtMostOneRow` then agrees.

(The review pass corrected the misleading comments in `test/property.spec.ts` and `docs/optimizer.md` to state the law's true scope; this ticket is the follow-up to give it real teeth.)

## Desired behavior

A property law over independent channels that *can* fail when a producer encodes ≤1-row inconsistently, e.g.:

- `(RelationType.keys contains the empty key)` ⟺ `(hasSingletonFd(physical.fds, colCount) || colCount === 0)`

i.e. a node that declares the empty key should also carry the singleton FD whenever it has ≥1 column, and vice-versa. (Zero-column nodes are the documented carve-out — the FD has no dependents — so the law must special-case `colCount === 0`, matching the `isAtMostOneRow` JSDoc.)

## Open design question (needs a decision before implementing)

The four nodes above currently **violate** the proposed independent-channel invariant (`pragma` especially). So the law cannot just be added — it forces a choice:

1. **Reconcile the producers**: have `PragmaNode` / `analyze-node` / `declarative-schema` emit the singleton FD via `addSingletonFd` (the helper this exists for) so the declared-key and FD channels agree, then add the strict law. Cleanest, but touches DDL/pragma nodes the DRY ticket deliberately left out of scope. Verify no consumer that reads `hasSingletonFd` *directly* (not via `keysOf`) is currently missing these nodes' ≤1-row-ness — that would be a latent correctness gap this fixes.
2. **Weaken the invariant** to tolerate the declared-key-only encoding (declared `[]` is an *independent* sufficient witness, FD is *optional*). Then the law degenerates back toward the current tautology — likely not worth shipping.

Recommend option 1, pending confirmation that emitting the FD on those nodes is harmless. Decide, document the rationale, then implement + extend the property law and the `docs/optimizer.md` Singleton-equivalence paragraph.

## Non-goals

No change to `keysOf` / `isUnique` / `hasSingletonFd` *semantics*; this is about producer consistency and a stronger backstop, not the read surface.
