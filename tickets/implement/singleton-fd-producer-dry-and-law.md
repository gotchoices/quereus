----
description: Consolidate the ≤1-row (singleton/unit) concept's PRODUCER side and pin its three-way equivalence with a property law. The READ surface (keysOf / isUnique / hasSingletonFd) and the construct surface (singletonFd / superkeyToFd) already exist and are universally consumed; this ticket removes the repeated producer boilerplate at 5 computePhysical sites, gives the at-most-one-row predicate one named spelling, and adds a Key-Soundness property law asserting the empty-key / ∅→all_cols-FD / isUnique([]) channels never disagree. Pure DRY + invariant-pinning; no behavior change.
prereq:
files: planner/util/fd-utils.ts, planner/nodes/aggregate-node.ts, planner/nodes/filter.ts, planner/nodes/limit-offset.ts, planner/nodes/table-access-nodes.ts, planner/nodes/values-node.ts, planner/util/key-utils.ts, planner/nodes/join-utils.ts, planner/rules/sort/rule-orderby-fd-pruning.ts, test/property.spec.ts, docs/optimizer.md
----

## Why this exists

The ≤1-row fact lives on three representations — the declared empty key `[]` in `RelationType.keys` (`datatype.ts`: "An empty key means the relation can have exactly 0 or 1 rows"), the `∅ → all_cols` functional dependency, and `RelationType.isSet`. The unified read surface `keysOf` / `isUnique` / `hasSingletonFd` (`fd-utils.ts`) already reconciles all three, and `singletonFd` / `superkeyToFd` already construct them; every consumer (DISTINCT elimination, whole-Sort elimination, GROUP BY simplification, join key propagation) is on the unified surface. So the concept is NOT missing an abstraction — what remains is residual scatter that lets a future producer drift out of agreement, which prior reviews (`complete/limit-one-singleton-fd`, `complete/values-singleton-fd`, `complete/sort-elimination-over-singleton`) had to hand-verify per ticket.

Two residual scatters and one missing guard:

1. **Producer boilerplate.** The pattern `const s = singletonFd(n); if (s) fds = addFd(fds, s)` is repeated at five `computePhysical` sites: `aggregate-node.ts` (scalar/no-group), `filter.ts` (covered-key), `limit-offset.ts` (LIMIT ≤1), `table-access-nodes.ts` (full-PK seek), `values-node.ts` (rows ≤1).
2. **Predicate spelling drift.** "At-most-one-row" is spelled `isUnique([], rel)` in `key-utils.ts` and `rule-orderby-fd-pruning`, `hasSingletonFd(...)` internally, and the inline `leftIsSingleton && rightIsSingleton` idiom in `join-utils.ts` (three sites).
3. **No property law** pins the equivalence. The Tier-1/Tier-2 Key Soundness harness guards "`keysOf` never over-claims" but does not assert that the singleton channels agree with each other.

## What lands

- **`addSingletonFd(fds, columnCount)`** in `fd-utils.ts`: folds `singletonFd(columnCount)` via `addFd`; a no-op when `columnCount === 0` (since `singletonFd(0)` is `undefined`). Replaces the five repeated blocks with one named call. FD output is byte-identical.
- **`isAtMostOneRow(rel: KeyRel): boolean`** in `fd-utils.ts`, defined as `isUnique([], rel)`: the single named spelling of the ≤1-row predicate. `join-utils.ts` singleton checks and `rule-orderby-fd-pruning`'s guard migrate to it. (Internal `hasSingletonFd` stays — it is the FD-only test that `keysOf` itself calls; `isAtMostOneRow` is the node-level surface.)
- **"Singleton equivalence" property law** added to the existing Key-Soundness harness in `property.spec.ts`. Walking every emittable relational node in the optimized plan, assert: if `isUnique([], node)` (canonical truth) then `keysOf(node)` contains the empty key `[]`; and if `hasSingletonFd(node.physical?.fds, colCount)` then `isUnique([], node)`. Best-effort over emittable nodes (same envelope as Tier-2). This catches a future producer that emits `isSet` or an empty key without the FD, or the converse.
- **`docs/optimizer.md`**: a short note in the FD-propagation section pointing producers at `addSingletonFd` and `isAtMostOneRow` as the canonical singleton helpers, and documenting the new law beside the Key-Soundness harness catalog.

## Non-goals

- No new `Singleton` type and no change to `keysOf` / `isUnique` semantics — those are shipped and reviewed.
- The lens `primary key ()` case is already a non-special path (`lens-compiler.ts`) and is untouched.
- No `TableLiteralNode` singleton work (that was scoped out by `complete/values-singleton-fd` and stays out).

## TODO

Phase A — producer DRY

- Add `addSingletonFd(fds, columnCount)` to `fd-utils.ts` with the no-op-on-zero contract documented.
- Migrate the five call sites (`aggregate-node.ts`, `filter.ts`, `limit-offset.ts`, `table-access-nodes.ts`, `values-node.ts`) to it. Confirm FD output unchanged.

Phase B — predicate alias

- Add `isAtMostOneRow(rel)` = `isUnique([], rel)` to `fd-utils.ts`.
- Migrate the `join-utils.ts` `leftIsSingleton` / `rightIsSingleton` checks and `rule-orderby-fd-pruning`'s top-of-rule guard to `isAtMostOneRow`.

Phase C — property law

- Add the "Singleton equivalence" law to the Key-Soundness section of `property.spec.ts`.
- Run the full quereus suite; it must stay green (behavior-neutral refactor).

Phase D — docs

- Add the canonical-helper note and law entry to `docs/optimizer.md`.
