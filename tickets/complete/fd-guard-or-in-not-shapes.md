---
description: Extended guard-clause vocabulary to accept OR-form, IN-list, and `NOT col` predicates on both producer (partial UNIQUE) and consumer (`predicateImpliesGuard`) sides. Added `or-of` GuardClause variant; pre-normalized `IN` and `NOT col` at recognition time. Also extended the memory-vtab partial-index predicate compiler with literal-only IN.
files:
  packages/quereus/src/planner/nodes/plan-node.ts
  packages/quereus/src/planner/util/fd-utils.ts
  packages/quereus/src/planner/analysis/partial-unique-extraction.ts
  packages/quereus/src/planner/analysis/predicate-shape.ts
  packages/quereus/src/planner/analysis/check-extraction.ts
  packages/quereus/src/vtab/memory/utils/predicate.ts
  packages/quereus/test/optimizer/conditional-fds.spec.ts
  packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic
  docs/optimizer.md
---

## Summary

Implemented Option 1 from the plan ticket: extended `GuardClause` with one new
variant (`or-of`) and pre-normalized `IN (lit, …)` and `NOT col` at recognition
time into clauses the existing vocabulary already covers. Producer and consumer
apply the same normalization so they remain in lockstep. End-to-end tests in
`10.5.1-partial-indexes.sqllogic` (sections 7i / 7j / 7k) and unit tests in
`conditional-fds.spec.ts` cover the happy paths plus key edge cases.

## Validation

- Lint: `yarn workspace @quereus/quereus run lint` — passes (exit 0).
- Targeted tests: 139 passing on `conditional-fds|fd-utils|Partial UNIQUE|extractPartialUniqueGuardedFds|extractCheckConstraints`.
- Sqllogic: 1 passing on `10.5.1`.
- Full quereus suite: 3060 passing, 2 pending, 0 failing.
- `yarn test:store` and `yarn test:full` — not run (deferred per ticket scope).

## Review findings

### Adversarial diff read

Read the implement diff in full before consulting the handoff summary:

- `plan-node.ts`: new `or-of` variant, well-documented invariant that sub-clauses are never themselves `or-of` (flattened at construction).
- `fd-utils.ts`: `guardClauseEquals`, `projectClause`, `shiftClause` recurse cleanly through `or-of`; the order-insensitive matching uses the same `used[]` technique as `guardsEqual`. `clauseEntailed` adds `or-of` with two-stage dispatch (per-sub-clause discharge, then pure-IN specialization). `inListEntailed` correctly enforces "all sub-clauses eq-literal on same column" before applying subset checks.
- `partial-unique-extraction.ts`: `recognizeIn`, `recognizeOr`, and the `NOT col` branch in `recognizeClause` follow the documented vocabulary; `recognizeOr` correctly inlines nested `or-of` and collapses singletons.
- `predicate-shape.ts`: `flattenDisjunction` extracted from `check-extraction.ts` — exported once, consumed by both partial-UC and CHECK paths.
- `vtab/memory/utils/predicate.ts`: `compileIn` applies SQLite three-valued semantics (no match + NULL ⇒ NULL).

### Soundness

**MAJOR — filed `fix/fd-not-col-text-divergence.md`.** The consumer's `NOT col → literalEqs(col, 0)` rewrite at `fd-utils.ts:846-848` is unsound for non-numeric columns. Verified end-to-end via `query_plan(...)` against `CREATE UNIQUE INDEX ix ON t(c) WHERE val = 0` on a TEXT NOT NULL column with two `(c=1, val='')` rows: the FILTER node for `WHERE NOT val` carries an unconditional `c → {id, val}` FD, but the actual data has two rows sharing c=1 in filter scope, so the FD is observably false. No current optimizer rule visibly mis-fires on this shape (DISTINCT removal didn't trigger; JOIN didn't elide), so it's latent — but corrupt FD state is a soundness bug. The implementer flagged this exact concern as Soundness Probe #1; the reviewer pinned it down to a concrete reproducer. Fix recommendation in the ticket: gate consumer-side `literalEqs(col, 0)` and producer-side `NOT col` recognition on the column's type being numeric.

**Re-examined producer NOT col on declared NOT NULL but non-numeric col.** Symmetric to above on the producer side. Filed under the same fix ticket since the resolution requires gating both producer and consumer.

**`isNotNullCols.add(col)` for `NOT col` filter** — sound (the filter excludes NULL by SQL semantics regardless of column type) and should be retained even after the literalEqs fix above.

**IN-list intersection across multiple conjuncts** — uses `sqlValueEquals` for set-equality. Correctly handles primitives and Uint8Array; doesn't dedup by deep equality at insertion (`Set<SqlValue>` uses identity), so `WHERE col IN (X) AND col IN (X)` with two different Uint8Array instances of the same bytes would have two-element prev/intersected interim sets, but `sqlValueEquals` rescues correctness in the intersection step. Acceptable.

**`col IN (NULL, lit)` recognition** — producer admits NULL via `literalValue` (any non-Promise literal is fine). Consumer accepts NULL via `literalSqlValueOf` likewise. Discharge is sound: `eq-literal{col, null}` only fires when `literalEqs(col) === null`, which only happens via `col IS NULL` (handled separately, doesn't pin literal=null) — so the NULL sub-clause effectively never discharges, but the other sub-clauses can. Consistent with the implementer's note in Soundness Probe #3.

**`or-of` with mixed-shape sub-clauses** — `inListEntailed` correctly returns false for non-pure-IN shapes; cross-shape discharge happens only via per-sub-clause `clauseEntailed` recursion. This is the documented design.

### DRY / modularity

- `flattenDisjunction` extraction to `predicate-shape.ts` is the right move; both call sites converge.
- `projectClause` and `shiftClause` extracted from inline switch-cases — reduces duplication and makes the recursive `or-of` handling natural.
- `candidateColumns` helper for EC + binding expansion — reused by `inListEntailed`. Mirrors the inline EC walk in `clauseEntailed`'s `eq-literal` case; could plausibly be reused there too, but the shapes differ enough (eq-literal needs only literalEqs lookup per peer; inListEntailed needs all three of literalEqs/inListEqs/binding per peer) that extracting common code further would be premature.

### Resource cleanup / error handling / type safety

- No new resources acquired.
- `recognizeIn`/`recognizeOr`/`recognizeClause` all return `undefined` on any unrecognized shape; callers correctly drop the FD entirely (sound).
- No `any` introduced. `set.values().next().value as SqlValue` cast in the singleton-IN branch is safe (size===1 guarantees defined value).
- `compileIn` correctly throws `QuereusError` for IN subqueries (matching the existing pattern for unsupported expression forms).

### Performance

- `buildPredicateFacts` is O(predicate-size) once per Filter; the new InNode branch is bounded by IN-list size. Intersection across multiple IN conjuncts on the same column is O(n²) in set size, acceptable for typical IN-list sizes.
- `inListEntailed` is O(candidates × OR-set-size); no asymptotic regressions.
- `guardClauseEquals` recursion through `or-of` is O(n²) in sub-clause count due to the `used[]`/order-insensitive match — acceptable for the small clause counts seen in practice.

### Tests

Implementer added 26 new test cases (unit + end-to-end + sqllogic) covering:
- `or-of` discharge (IN, OR, mixed-shape, EC peer).
- `NOT col` discharge / non-discharge.
- Producer recognizer (IN, IN-singleton-collapse, IN-with-parameter rejection, OR, 3-way OR flattening, NOT col gate, OR-with-unrecognized-disjunct).
- `addFd`/`projectFds`/`shiftFds` for `or-of` clauses.
- End-to-end: filter activates / doesn't activate the FD for §7i (IN), §7j (NOT), §7k (OR).
- Top-level OR predicate as a conservative-no-discharge pin.

Coverage gaps the reviewer noted (and the implementer's "Test floor" already mentioned):
- `col IN (NULL, lit)` end-to-end (recognized but discharge behavior subtle).
- IN-list inside top-level OR (recognized; end-to-end discharge unverified).
- Mixed-shape `or-of` with `eq-column` and `is-null` sub-clauses end-to-end.
- The new fix ticket (`fd-not-col-text-divergence`) will add the regression case for the soundness issue.

These are out-of-scope-for-review tweaks (adding more tests doesn't fix the actual finding) — left for follow-up.

### Docs

`docs/optimizer.md` updated:
- `GuardClause` type signature shows `or-of`.
- Partial UNIQUE conjunct table extended with `NOT col`, `IN`, OR rows.
- `predicateImpliesGuard` summary updated with new discharge paths.
- The `NOT col` rewrite paragraph correctly documents the soundness rationale (pairs with NOT-NULL gate); however, the type-divergence concern (the new fix ticket) is NOT yet documented as a known limitation. After the fix lands, that paragraph should be updated again — flagged in the fix ticket's scope.

### Things checked but found OK

- `InNode` shape: `condition` is `ScalarPlanNode`, `values?` is optional, `source?` is undefined for value-list IN — consumer correctly bails when `source !== undefined`.
- `compareSqlValues` cross-storage-class behavior: NUMERIC vs TEXT differ → not equal, used correctly by `compileIn`.
- `flattenDisjunction` termination: stack-based on a finite tree, can't loop.
- Empty IN handled at recognizer (returns undefined → drops FD) and at compiler (returns false → row excluded). Asymmetric but both sound.
- `addFd` / `mergeFds` for `or-of`: equality with reordered sub-clauses subsumes correctly; differing sub-clauses coexist.
- `projectFds` and `shiftFds` for `or-of`: tested and verified.
- The `WHERE c IS NULL OR status = 'archived'` partial UC on a nullable `c` — correctly rejected by the NOT-NULL gate (gate doesn't introspect into `or-of`). Conservative-safe.

## Disposition

- **Minor findings**: none (the documentation gap is bundled with the fix ticket).
- **Major finding**: `fix/fd-not-col-text-divergence.md` filed (corrupt FD state for `NOT col` filter on non-numeric columns paired with `eq-literal{col, 0}` partial UC guard).
- All tests pass (3060 passing, 0 failing). Lint passes.
