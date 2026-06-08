description: Lift declared CHECK constraints into the optimizer's FD/EC/binding pipeline at the table reference, and add a new `domainConstraints` physical property for range/enum bounds derived from CHECK.
files:
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/src/planner/analysis/check-extraction.ts
  - packages/quereus/src/planner/nodes/reference.ts
  - packages/quereus/src/planner/nodes/filter.ts
  - packages/quereus/src/planner/nodes/project-node.ts
  - packages/quereus/src/planner/nodes/returning-node.ts
  - packages/quereus/src/planner/nodes/aggregate-node.ts
  - packages/quereus/src/planner/nodes/stream-aggregate.ts
  - packages/quereus/src/planner/nodes/hash-aggregate.ts
  - packages/quereus/src/planner/nodes/join-utils.ts
  - packages/quereus/src/planner/nodes/join-node.ts
  - packages/quereus/src/planner/nodes/merge-join-node.ts
  - packages/quereus/src/planner/nodes/bloom-join-node.ts
  - packages/quereus/src/planner/nodes/asof-scan-node.ts
  - packages/quereus/src/planner/nodes/set-operation-node.ts
  - packages/quereus/src/planner/nodes/distinct-node.ts
  - packages/quereus/src/planner/nodes/alias-node.ts
  - packages/quereus/src/planner/nodes/window-node.ts
  - packages/quereus/src/planner/nodes/sort.ts
  - packages/quereus/src/planner/nodes/limit-offset.ts
  - packages/quereus/src/planner/nodes/ordinal-slice-node.ts
  - packages/quereus/src/planner/nodes/table-access-nodes.ts
  - packages/quereus/src/planner/nodes/retrieve-node.ts
  - packages/quereus/test/optimizer/check-derived-fds.spec.ts
  - docs/optimizer.md
  - docs/architecture.md
----

CHECK-derived FDs / ECs / constant bindings / per-column domain constraints are
now lifted into the optimizer's physical-properties pipeline at the table
reference, and propagated alongside the existing FD/EC/binding plumbing through
every relational operator. A new `PhysicalProperties.domainConstraints` carries
per-column `range`/`enum` bounds for downstream consumer rules to consume in
follow-up tickets.

## Review findings

### What was checked

- Implement commit `92bdf952` diff read end-to-end (29 files, +1057/-247).
- `check-extraction.ts` walker (the new code): every recognized AST shape,
  the `containsNonDeterministicCall` filter, the generic AST tree-walker
  fallback inside `collectColumnNames`, the `WeakMap` cache key/lifetime, the
  determinism callback choice (`()=>true`) and the upstream validation that
  makes it safe.
- `fd-utils.ts` helpers (`mergeDomainConstraints`, `projectDomainConstraints`,
  `shiftDomainConstraints`, `enforceDomainCap`, `sqlValueEquals`,
  `domainConstraintEquals`) — caps, dedup semantics, structural equality
  (including `Uint8Array` bytewise comparison).
- `TableReferenceNode.computePhysical` merges CHECK-derived FDs with PK/UNIQUE
  FDs via `addFd`, seeds ECs from `equivPairs`, merges and EC-closes constant
  bindings, surfaces `domainConstraints` directly.
- Per-operator propagation across all 21+ relational nodes touched. Confirmed:
  pass-through where appropriate (Filter, Sort, Distinct, Alias, Limit,
  OrdinalSlice, Window, Retrieve, table-access scans), projection through a
  column mapping (Project, Returning, Aggregate variants), shift+merge for
  joins (inner/cross), left-only/right-only-shifted for outer joins, drop for
  full outer and set operations, left-side inheritance for Asof.
- DML nodes (`UpdateNode`, `InsertNode`, `DeleteNode`) — confirmed they
  deliberately return `{readonly:false}` and don't propagate physical props;
  correct.
- `query_plan` serialization path (`safeJsonStringify(node.physical)`) —
  confirmed `domainConstraints` flows through unchanged via JSON.
- Upstream validation: confirmed `schema/manager.ts:1069-1106` rejects CHECKs
  that call non-deterministic functions at CREATE TABLE time, validating the
  `()=>true` callback used by the production cache.
- Type definitions for `SqlValue` and `LiteralExpr.value` — confirmed the
  `instanceof Promise` guard in `literalValue` is correct (literal values are
  typed `MaybePromise<SqlValue>`), not dead code.
- Documentation: `docs/optimizer.md` § FD Tracking and `docs/architecture.md` §
  FD Tracking both updated to mention CHECK-derived contributions and
  `domainConstraints` propagation.

### What was found and disposition

#### Inline (fixed in this review)

1. **Test coverage gap: column-on-RHS inequality** (`0 < qty`) — exercises
   `flipComparison`, which had no test. Added unit test in
   `check-derived-fds.spec.ts`.
2. **Test coverage gap: `==` operator alias** — recognized in `recognize()` but
   no test. Added unit test.
3. **Test coverage gap: EC-closure on constant bindings at the table reference**
   — `closeConstantBindingsOverEcs` is called for CHECK-derived bindings, and
   the implement-stage notes document that `(status = 'a') AND (status =
   alt_status)` should pin both columns. No e2e test verified this. Added e2e
   test.

Lint clean. All 2964 quereus tests pass (the 19 pre-existing in this file + 3
added in review + 2942 elsewhere). Sample-plugins `key_value_store delete` /
`update` fail on this branch but also fail on `main` — unrelated, confirmed
pre-existing.

#### No new tickets needed — deferred as designed

These were flagged by the implementer as out-of-scope per the original ticket
text and are awaiting follow-up tickets that already exist or are alluded to:

- Predicate × domain intersection at Filter is deferred to
  `optimizer-predicate-contradiction-detection` (ticket #4).
- Intersection of overlapping `range`/`enum` domains on the same column is
  deferred to the same follow-up.
- No consumer rule reads `domainConstraints` yet — this ticket lays the
  surface; the consumer rules (monotonicOn-range tightening, decorrelation
  tightening, predicate-contradiction) come later. Acceptable scope.
- `NOT` is dropped wholesale rather than partially negated — per the spec.
- `UNION ALL` could in principle preserve the *intersection* of source enum/
  range domains; the implementation conservatively drops, matching the
  existing FD/EC/binding treatment for set ops. Acceptable.

#### Latent fragilities — noted, not fixed (not regressions, low impact)

These were observed but did not warrant inline fixes or new tickets — they
match existing patterns in the codebase and have no current trigger:

1. **`collectColumnNames` / `containsNonDeterministicCall` use a generic
   "walk-any-object-with-a-`type`-field" traversal.** If a future AST shape
   adds a non-`Expression` child with a `type` field (e.g. a type-descriptor
   inside a `CastExpr`), the walker would descend into it. Today nothing
   triggers this — `CastExpr.targetType` shapes don't carry a colliding `type`
   tag for `'column'`/`'identifier'`. Flagged for future awareness; specializing
   the walker per AST node type would be safer but is out-of-scope here.
2. **`mergeDomainConstraints(out, [])` does not dedup within `out`.** The
   `projectDomainConstraints` post-process uses this pattern to "finalize" the
   list, but its dedup logic only iterates `b`. In practice the source list is
   already deduped and the 1:1 column mapping preserves that, so no observable
   dup. Could be tightened (e.g., dedup internally during the projection
   loop), but parallel to the existing `mergeConstantBindings` behavior. Not
   fixed.
3. **`enforceDomainCap` is silent past `MAX_FDS_PER_NODE=64`.** Matches the
   existing FD cap behavior; consistent.
4. **Cache invariant**: `WeakMap<TableSchema, CheckExtraction>` lives for the
   process; entries die with the schema instance. ALTER TABLE swaps the
   schema, invalidating the cache. Confirmed correct.

### Empty categories (explicit)

- **Performance regressions**: none observed. The extraction is `O(checks ×
  expression-size)` once per table-schema instance, memoized after first call.
- **Security**: none — extraction is read-only over already-validated AST.
- **Resource cleanup**: nothing to clean up; pure data flow.
- **Type safety**: confirmed via lint + tsc; no `any` introduced; `SqlValue`
  vs `MaybePromise<SqlValue>` properly distinguished.
- **API surface**: `DomainConstraint` type and three helpers (`mergeDomainConstraints`,
  `projectDomainConstraints`, `shiftDomainConstraints`) added to `fd-utils.ts`
  exports; `extractCheckConstraints` and `getCheckExtraction` exported from the
  new analysis module. No breaking changes.
- **Cross-platform**: pure data structures; no Node-only APIs introduced.

## End
