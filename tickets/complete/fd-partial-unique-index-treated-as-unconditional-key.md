---
description: Soundness fix — exclude partial UNIQUE constraints (those carrying a `predicate`) from `RelationType.keys` derived from `TableSchema`, so the FD layer no longer derives `K → all-other-cols` over the whole table for partial-unique columns.
files:
  packages/quereus/src/planner/type-utils.ts
  packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic
  packages/quereus/src/planner/nodes/reference.ts
  packages/quereus/src/schema/table.ts
  docs/optimizer.md
---

## Summary

`relationTypeFromTableSchema` (`packages/quereus/src/planner/type-utils.ts:48-56`)
now skips any `UniqueConstraintSchema` whose `predicate` is defined. A partial
UNIQUE constraint synthesized from `CREATE UNIQUE INDEX ... WHERE ...` only
guarantees uniqueness within the WHERE scope, so promoting it to a
relation-level key let `TableReferenceNode.computePhysical`
(`packages/quereus/src/planner/nodes/reference.ts:81-101`) materialize the
unsound FD `K → all-other-cols`. Every downstream FD consumer (DISTINCT
elimination, GROUP BY simplification, ORDER BY pruning, FK→PK join
elimination, predicate-inference equivalence classes) silently produced
wrong answers for rows outside the partial scope.

The chokepoint is single — no per-rule edits needed.

## Review findings

### Soundness of the discriminator (`uc.predicate === undefined`)
**Verified.** Two paths populate `TableSchema.uniqueConstraints`:
- `extractUniqueConstraints` (`packages/quereus/src/schema/manager.ts:829-873`)
  for table-level / column-level UNIQUE in `CREATE TABLE` — never sets
  `predicate`. Untouched by the new gate.
- `addIndexToTableSchema` (`packages/quereus/src/schema/manager.ts:1250-1267`)
  for `CREATE UNIQUE INDEX [WHERE ...]` — copies `indexSchema.predicate`
  verbatim. `undefined` for full-table indexes; the AST `Expression` for
  partial indexes. The new `=== undefined` check correctly differentiates.

The `predicate` field's docstring at `packages/quereus/src/schema/table.ts:436-440`
explicitly states "Only set when the constraint was synthesized from a
`CREATE UNIQUE INDEX ... WHERE ...`", confirming `predicate === undefined`
is the canonical "unconditional UNIQUE" signal.

### Other planner paths deriving keys from UNIQUE
**Verified clean.** `find_references` on `uniqueConstraints` across
`packages/quereus/src/planner/`: only `type-utils.ts:48-49`. `grep` on
`tableSchema.indexes|table.indexes|schema.indexes` across
`packages/quereus/src/planner/`: zero matches. No other planner site
fabricates keys from secondary indexes. The single chokepoint is the
correct one.

Other (non-planner) consumers of `uniqueConstraints` were spot-checked and
do not affect FD correctness:
- `vtab/memory/layer/manager.ts` — runtime uniqueness enforcement; partial
  predicates already honored (`store-checkuniqueconstraints-honor-partial-predicate`,
  commit `a815417f`).
- `func/builtins/schema.ts:475` — `unique_constraint_info()` info function;
  surfaces `predicate` as the `partial` flag, no FD impact.
- `schema/catalog.ts:150` — info-only iteration.

### Test coverage
- **Section 6 in `10.5.1-partial-indexes.sqllogic`** pins user-visible
  semantics for the three primary FD-consumer surfaces: DISTINCT
  elimination (inner `select distinct`), aggregate distinct
  (`count(distinct c)`), and LEFT-JOIN row-count preservation. All three
  reduce to "is `c` reported as a key on the table reference's
  `RelationType`?", which is exactly what the gate controls.
- **Positive control** `p_fdkey_full` confirms the non-partial UNIQUE path
  still derives the FD and DISTINCT can still legally be eliminated. This
  prevents the gate from being "too defensive."
- **Coverage I considered but did not add:** GROUP BY simplification, ORDER
  BY pruning, FK→PK join-elimination plan-shape assertions. All three share
  the same `relType.keys → fds` chokepoint, so they pass-or-fail together
  with the DISTINCT test. A per-consumer plan-shape assertion would only
  catch a regression that *broke a different layer*, which is out of scope.
  Filed as **not needed** rather than **deferred**.
- **Test files audited for partial-UNIQUE assumptions:** none in
  `test/optimizer/` or `test/planner/` reference partial UNIQUE; the
  pre-existing sections 1-5 of `10.5.1-partial-indexes.sqllogic` only
  exercise enforcement, not FD-derivation. No regression risk.

### Docs
- `docs/optimizer.md:1261` previously stated unconditionally "Unique
  constraints … surfaced as additional `RelationType.keys`". Updated in
  this pass to call out the all-NOT-NULL and not-partial requirements
  with a pointer to `relationTypeFromTableSchema`.
- No other doc reads as if partial UNIQUE were a relation-level key.

### Code quality (SPP, DRY, modular, scalable, maintainable, performant, resource cleanup, error handling, type safety)
- **SPP / DRY / modular**: One-line gate at the only schema→type translator
  is the minimal-surface fix. No abstraction needed.
- **Performance**: O(1) extra check per UNIQUE constraint at schema-load
  time. Negligible.
- **Resource cleanup / error handling**: N/A — pure data transformation.
- **Type safety**: `predicate?: Expression`. The `=== undefined` check
  correctly handles both "property absent" and "property explicitly
  assigned `undefined`" (the `addIndexToTableSchema` path uses the latter).

### Validation performed in the review pass
- `yarn workspace @quereus/quereus run lint 'src/**/*.ts'`: exit 0.
- `yarn workspace @quereus/quereus run test`: **2942 passing, 2 pending,
  0 failing** (~2m).
- `yarn test:store` not run — this is a planner-side schema→type
  translation, identical under both store backends. Out of scope per the
  same reasoning as the implement stage.

## Out of scope (deferred)

`tickets/backlog/fd-conditional-fd-from-partial-unique-index.md` — the
optimization opportunity to derive a *conditional* FD when a query's
effective predicate implies the partial UNIQUE's `WHERE`. Requires
teaching the FD layer about conditional FDs (or rewriting the partial UC
into a "scope view" with its own FDs). Confirmed to exist in `backlog/`.
