---
description: Optimizer-side hoist of canonical `not exists (select 1 from T [where P])` assertions into per-row CHECK-style FD / EC / constant-binding / domain contributions on `T`. Negated inner predicate flows through the existing CHECK-extraction pipeline at `TableReferenceNode.computePhysical`, contradicting queries fold to `EmptyRelation`. Commit-time enforcement remains the source of truth via a re-entrancy guard that suppresses the hoist while compiling an assertion's own violation query.
files:
  - packages/quereus/src/schema/assertion.ts
  - packages/quereus/src/schema/manager.ts
  - packages/quereus/src/schema/change-events.ts
  - packages/quereus/src/runtime/emit/create-assertion.ts
  - packages/quereus/src/runtime/emit/drop-assertion.ts
  - packages/quereus/src/core/database-assertions.ts
  - packages/quereus/src/planner/analysis/assertion-classifier.ts
  - packages/quereus/src/planner/analysis/assertion-hoist-cache.ts
  - packages/quereus/src/planner/analysis/check-extraction.ts
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/nodes/reference.ts
  - packages/quereus/src/planner/scopes/global.ts
  - packages/quereus/src/planner/building/table.ts
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/test/optimizer/assertion-as-premise.spec.ts
  - docs/optimizer.md
  - docs/architecture.md
  - docs/schema.md
---

## What landed

Canonical `not exists (select 1 from T [where P])` assertions are now hoisted
through `extractCheckConstraints` at the target table reference. `negateAst`
pushes `NOT` to the leaves (De Morgan, comparison flip, IS NULL flip,
BETWEEN-not flip; everything else falls back to a wrap-in-NOT that the
extractor silently ignores). The classifier rejects out-of-shape inputs —
existential, aggregate, multi-table joins, subqueries inside the inner
predicate, view targets, schema-qualified column refs, and the
unconditional-empty case.

### Provenance

`FunctionalDependency`, `ConstantBinding`, and `DomainConstraint` now carry
an optional `source: ConstraintProvenance = { kind: 'declared-check' | 'assertion', name? }`.
The dedup helpers in `fd-utils.ts` (`addFd`, `mergeConstantBindings`,
`mergeDomainConstraints`) compare structural fields only and ignore
`source`. Identical contributions from a declared CHECK and an assertion
collapse to one — and because the table reference merges declared-check
first, the declared-check entry wins.

### Cache invalidation

`assertion-hoist-cache.ts` keys results by `(SchemaManager, TableSchema)`
via a `WeakMap`-backed registry. A generation counter bumps on
`assertion_added` / `assertion_removed` / `assertion_modified` events. New
events were added to `schema/change-events.ts`; both `CREATE ASSERTION` and
`DROP ASSERTION` go through `SchemaManager.addAssertion` /
`removeAssertion` wrappers that fire those events.

### Soundness — re-entrancy guard

`SchemaManager.withSuppressedAssertionHoist(fn)` increments a depth
counter for the duration of `fn`; `getAssertionHoistedConstraints`
returns `EMPTY` (bypassing the cache) while suppressed. `AssertionEvaluator`
wraps both its plan-compilation path (`getOrCompilePlan` →
`compileUnderSuppression`) and its global-violation execution path
(`executeViolationOnce`, which force-compiles the prepared statement under
suppression before iteration). Without this guard, the hoist would let the
optimizer fold the assertion's own violation query to empty (the assertion
would prove its own non-violation) and commit-time enforcement would never
fire. The regression is caught by `test/logic/102-schema-catalog-edge-cases.sqllogic`.

## Review findings

### Run summary
- `yarn workspace @quereus/quereus run build` — passes
- `yarn workspace @quereus/quereus run lint` — passes (no output)
- `yarn workspace @quereus/quereus run test` — 3151 passing, 2 pending

### Soundness / correctness
- **Re-entrancy guard scope.** Verified all paths into the optimizer for
  assertion-owned plans are wrapped: `getOrCompilePlan` covers
  `_buildPlan` + `optimizeForAnalysis` + per-residual `optimize`;
  `executeViolationOnce` covers `stmt.compile()`. `TableReferenceNode.physical`
  is memoized per-instance, so a node built under suppression sticks at
  `EMPTY` even if accessed later — no leak. Dependency-discovery in
  `emitCreateAssertion` runs *before* the assertion is in the schema, so
  no hoist can pre-fold it.
- **Cache identity tracking.** ALTER TABLE swaps the `TableSchema`
  instance (verified in `runtime/emit/alter-table.ts`), so the
  WeakMap-keyed cache invalidates by identity. The generation counter only
  bumps on assertion changes, which is correct — assertions are evaluated
  in isolation per table-schema instance.
- **`committed.t` references.** `committed.t` resolves to the same
  `TableSchema` instance as `main.t`, so the hoist applies. Sound: the
  committed snapshot satisfied prior assertions at its commit point.
- **Assertion-targets-committed.** The classifier calls
  `findTable(name, 'committed')` which returns undefined (no such schema),
  so transition-style assertions referencing `committed.t` correctly fall
  through to commit-time enforcement only.
- **Conflicting declared CHECK + assertion.** A CHECK `qty < 0` plus an
  assertion `not exists (... where qty < 0)` produces two domain entries
  (different bounds). The optimizer's predicate-contradiction detection
  (prior ticket) folds queries on `t` to empty — semantically correct, the
  table is unpopulatable.
- **Minor gap — column qualifier validation.** `predicateReferencesForeignColumns`
  validates `col.schema` (rejects) but does not validate `col.table`
  against the target table's name/alias. An assertion like
  `not exists (select 1 from t where wrong_table.qty < 0)` would resolve
  `qty` against T's columnIndexMap and be accepted, with the hoist
  treating it as `qty < 0` on T. Practical impact is bounded: such an
  assertion fails planning, but `emitCreateAssertion` silently swallows
  dependency-discovery planning errors, so the malformed assertion can
  enter the schema and the bogus hoist applies until `DROP ASSERTION`.
  The same convention (`columnIndexFromExpr` ignoring `col.table`) is used
  for declared CHECKs, where the parser context prevents the issue.
  **Left as-is** — fixing requires threading the table's allowed
  qualifiers (real name + alias) into the walker; user-error-only trigger;
  noted for follow-up if it surfaces in the wild.
- **Minor gap — non-deterministic functions in inner predicate.** The
  classifier uses `allDeterministic` (returns `true` for every function),
  paralleling `getCheckExtraction`. The CHECK case relies on schema
  validation rejecting non-det functions via `validateDeterministicConstraint`,
  but `CREATE ASSERTION` (via `CreateAssertionNode` / `emitCreateAssertion`)
  performs no equivalent check. In principle a `not exists (... where
  qty < random())` assertion could be created. In practice the extraction
  is shape-conservative — `columnIndexFromExpr` only resolves direct
  column refs, `literalValue` only accepts literals, so `f(qty)` and
  `qty < f(...)` produce no extracted facts. **Left as-is**, no
  exploitable hoist; the doc claim "no non-deterministic calls" overstates
  the means but matches the effect.
- **Minor gap — aggregate name allowlist.** `containsAggregateCall` uses
  a hardcoded set (`count, sum, avg, min, max, total, group_concat,
  json_group_array, json_group_object`). User-registered aggregates and
  any future built-ins (`stddev`, `corr`, etc.) would slip through. The
  cleaner fix is to ask the function registry — `isAggregateFunctionSchema`
  already exists. **Left as-is** for the pilot; noted by the implementer.
- **Latent pre-existing concern — case-sensitive `operator === 'NOT'`.**
  `partial-unique-extraction.ts:215`, `predicate-normalizer.ts:31/83`,
  and `rule-subquery-decorrelation.ts:59` all compare the unary operator
  to the uppercase string while the parser preserves source case for
  prefix unary operators (verified at `parser.ts:1468`). The new code in
  this branch is case-insensitive; the pre-existing call sites are not.
  **Out of scope** for this review; worth a separate ticket.

### DRY / modular / scalable
- Synthetic-check construction in `assertion-hoist-cache.ts` cleanly
  reuses `extractCheckConstraints`, no duplicated AST-walking logic.
- `addFd` / `mergeConstantBindings` / `mergeDomainConstraints` got the
  source-aware dedup comment but no behavior change — clean.
- `containsNonDeterministicCall` was promoted to an export to be reused
  by the classifier — appropriate; the function was already a generic
  walker.
- The hoist re-walks every assertion on every cache-miss and (re-)applies
  the classifier. For a database with many assertions this is O(assertions
  × tables) on every assertion change. Acceptable for a pilot; the obvious
  follow-up is a per-`IntegrityAssertionSchema` classification cache
  (the AST is immutable). Noted for later.

### Resource cleanup
- `PerManagerRegistry.unsubscribe` is stored but never invoked. This is
  intentional — the registry, listener closure, and `SchemaManager` share
  a lifetime (the registry is held in a `WeakMap<SchemaManager, …>` and
  the listener is held by the notifier which lives on the SchemaManager).
  When the SchemaManager is GC'd, the listener and registry are GC'd
  together. No leak.
- `withSuppressedAssertionHoist` increments/decrements via try/finally —
  exception-safe.

### Type safety
- No `any` in the new code. The walker stack uses
  `(node as unknown as Record<string, unknown>)` which is the standard
  pattern in this codebase's AST walkers.
- `ConstraintProvenance` discriminates `kind: 'declared-check' | 'assertion'`
  — type-narrow downstream consumers, no string-only flags.
- `RowOpMask` cast to `0` is fine; `extractCheckConstraints` doesn't read
  it.

### Test coverage
- Classifier: 9 unit tests cover all rejection paths (multi-table,
  unknown table, existential, aggregate, subquery-in-predicate,
  foreign-column, unconditional-empty) and the happy path.
- `negateAst`: 8 unit tests cover each rule and the fallback. The
  comparison-flip cases test `=` and `<` only; `<=`, `>`, `>=`, `!=`,
  `==` are not asserted but follow the same switch arm. Acceptable.
- End-to-end: 7 tests — single-conjunct fold, derived contradiction
  fold, non-contradicting left intact, DROP ASSERTION invalidates the
  cache, cross-table isolation, provenance tag carries through, dedup
  precedence keeps declared-check.
- Re-entrancy regression: covered by
  `test/logic/102-schema-catalog-edge-cases.sqllogic` (line 222) which
  creates an assertion, inserts a violating row, and expects the
  commit-time error. The fix in this branch makes that test pass.
- Gaps that the implementer flagged and I confirmed: no test for the
  multi-conjunct disjunctive shape (`qty < 0 or status = 'bad'`) —
  acceptable, the partial extraction behavior is documented.

### Docs
- `docs/architecture.md` — assertion-as-premise bullet added under
  Constraints. Accurate.
- `docs/optimizer.md` — new `#### Assertion-derived premises` section.
  Accurate; the "no non-deterministic calls" claim is generous (see
  Soundness above), but the effective behavior matches.
- `docs/schema.md` — **was stale**: the new `assertion_added` /
  `assertion_removed` / `assertion_modified` event types were not listed
  in the event-type table. Fixed in this review.

### Out of scope (carried forward from plan)
- Existential assertions (`check (exists (...))`).
- Multi-table assertions.
- Aggregate-form assertions.
- Unconditional-empty assertions.
- Cost-based decision to skip unprofitable hoists.
- Round-trip: hoisted facts making the assertion's COMMIT-time check
  redundant. Moot for now thanks to the re-entrancy guard.
- Rewriting `not in` / correlated-subquery shapes that are semantically
  equivalent.
- Pre-existing `operator === 'NOT'` case-sensitivity in
  `predicate-normalizer.ts`, `partial-unique-extraction.ts`, and
  `rule-subquery-decorrelation.ts` — worth a separate ticket.

## End
