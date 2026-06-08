---
description: Producer-only addition to the conditional-FD pipeline. Partial UNIQUE indexes (`CREATE UNIQUE INDEX (K) WHERE P`) now emit a guarded FD `K → others | P` on the table reference, mirroring the implication-form CHECK pathway. Filter activation discharges the guard when a surrounding predicate entails every conjunct of `P`, making `K` an unconditional key downstream.
files:
  packages/quereus/src/planner/analysis/predicate-shape.ts                 # shared AST shape helpers
  packages/quereus/src/planner/analysis/partial-unique-extraction.ts       # producer
  packages/quereus/src/planner/analysis/check-extraction.ts                # imports from predicate-shape
  packages/quereus/src/planner/nodes/reference.ts                          # wires producer into TableReferenceNode.computePhysical
  packages/quereus/src/planner/type-utils.ts                               # comment updated to point at new producer
  packages/quereus/test/optimizer/conditional-fds.spec.ts                  # unit + e2e tests
  packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic              # correctness section 7
  docs/optimizer.md                                                        # documents new producer
---

## Summary

Added `planner/analysis/partial-unique-extraction.ts`, which walks `TableSchema.uniqueConstraints` and emits a guarded FD `K → (all_cols \ K) | P` for every UC carrying a partial-index predicate. Recognized conjuncts: `col = literal`, `literal = col`, `col1 = col2`, `col IS NULL`, `col IS NOT NULL`. Any unrecognized conjunct drops the whole FD (soundness). NOT-NULL gate suppresses the FD when any UC column is nullable.

`columnIndexFromExpr`, `literalValue`, and `collectColumnNames` were factored out of `check-extraction.ts` into a new `predicate-shape.ts` module; both producers now share them.

`TableReferenceNode.computePhysical` calls `getPartialUniqueGuardedFds(schema)` after the CHECK-extraction merge. Per-schema `WeakMap` cache; invalidates correctly when `addIndexToTableSchema` / `dropIndex` rebuild the `TableSchema` reference. Downstream activation (Filter, projection, outer-join guard-drop) is unchanged — the producer is plug-in.

## Review findings

### Code review

- **Soundness of the recognizer's drop-on-unrecognized rule** (`partial-unique-extraction.ts:88-112`): verified. `recognizeGuardClauses` returns `undefined` (vs. `[]`) when any conjunct fails to map; caller bails out via `if (!clauses) continue`. Unit test `'rejects the whole predicate if one conjunct is unrecognized (soundness)'` pins the behaviour.
- **NOT-NULL gate** (`partial-unique-extraction.ts:60`): `uc.columns.every(idx => tableSchema.columns[idx]?.notNull)` correctly enforces "every UC column must be declared NOT NULL". The `?.` is type-defensive; in well-formed schemas indices are always in range. Suppresses composite UCs whose any column is nullable — same semantics as the unconditional-UC path in `relationTypeFromTableSchema`.
- **Cache invalidation** (`partial-unique-extraction.ts:34`): `WeakMap<TableSchema, ...>`. Verified via `manager.ts:1249` (CREATE INDEX → new TableSchema via spread) and `manager.ts:1313` (DROP INDEX → new TableSchema via spread). Memory vtab path at `vtab/memory/layer/manager.ts:1345` also rebuilds the schema reference on DROP INDEX. Cache invalidates correctly.
- **AND-flattening** (`recognizeGuardClauses`): iterative stack with right-push-before-left preserves textual left-to-right order across nested ANDs. Traced `(a AND b) AND c` and `a AND (b AND c)` — both produce `[a, b, c]` in order. Correct.
- **Operand-flipped equalities** (`recognizeClause:150-158`): handled. Unit test confirms `literal = col` produces the same clause as `col = literal`. The discharge path normalizes via `buildPredicateFacts`, so filter-side operand order doesn't matter either.
- **Schema-qualified identifiers**: `columnIndexFromExpr` rejects `expr.schema !== undefined` — partial-index predicates that somehow contain `other.foo` shapes drop their FD. Correct.
- **Subqueries / parameters in partial predicate body**: rejected. `literalValue` only accepts `type === 'literal'`; `recognizeClause` only accepts binary `=`/`==` and unary `IS NULL`/`IS NOT NULL`. Anything else returns undefined → FD dropped.
- **Determinism**: the recognized clause set (=, ==, IS NULL, IS NOT NULL, AND) is closed over deterministic operators, so no separate `isDeterministic` walk needed (unlike `check-extraction.ts`).
- **Soundness pin in `type-utils.ts:38-49`**: unchanged behaviour (`if (uc.predicate !== undefined) continue`); only the comment was updated to point at the new producer. Verified no other code reads partial UCs as relation-level keys.
- **Interaction with unconditional UC on same columns**: `addFd` is guard-aware (`fd-utils.ts:193-238`) — guarded and unconditional twins coexist. Once a Filter activates the guarded FD, it dedupes against the existing unconditional one via `fdsEqual`. Correct.
- **Projection through guard columns** (`projectFds:312-322`): if any guard column is dropped by the projection, the guarded FD is discarded. Already covered for the CHECK pathway and applies uniformly here.
- **Producer-side correctness of `eq-column { left === right }`**: `recognizeClause:147` rejects same-column equality and drops the whole FD. Defensive — `c = c` is degenerate. Not a bug, just a missed micro-optimization (could skip the trivial clause instead). Filed mentally; not worth a ticket.

### DRY / modularity

- The `predicate-shape.ts` extraction is clean: `check-extraction.ts` no longer carries private copies of these helpers, and `partial-unique-extraction.ts` reuses them. Both producers stay independent; no shared mutable state.
- `partial-unique-extraction.ts` mirrors `check-extraction.ts`'s `get*` / `extract*` naming and cache pattern. Tests import the uncached `extract*` to avoid `WeakMap` reuse across cases.

### Tests

- **Unit tests in `conditional-fds.spec.ts`** (11 cases, lines 405-580): cover every recognized clause shape (eq-literal both operand orders, eq-column, IS NULL, IS NOT NULL), multi-conjunct AND, rejection of `>`, `!=`, `IN`, top-level `OR`, the NOT-NULL gate, the soundness-drop rule, non-partial UCs, and empty UC lists.
- **End-to-end tests `'Partial UNIQUE → guarded FD'`** (7 cases, lines 676-836): cover producer presence on the table reference, discharge via `status='active'` and operand-flipped `'active'=status`, non-discharge on wrong literal, superset filter discharge (`status='active' AND amt > 5`), multi-conjunct partial predicate (full match + partial entailment), and NOT-NULL gate suppression at the producer.
- **sqllogic section 7 in `10.5.1-partial-indexes.sqllogic`**: pins runtime correctness for direct match, DISTINCT correctness with and without the optimizer eliminating it, GROUP BY, wrong-filter case, multi-conjunct predicate, and the nullable-UC case.
- **Coverage gaps (intentional)**: no end-to-end discharge test for `IS NULL`/`IS NOT NULL` guard clauses. The producer's emission of these shapes is unit-tested; the activation path is exercised by the CHECK pathway. Acceptable since both producers funnel into the same `predicateImpliesGuard` machinery. Filed nothing — adding a test is mechanical if the gap ever bites.
- **Coverage gap (intentional)**: no end-to-end test for a composite UC `(a, b) WHERE P`. The unit tests exercise the composite det/dep computation directly; nothing in the producer behaves differently on composite vs. single-column UCs.

### Docs

- `docs/optimizer.md` updated: a new subsection under "Guarded (conditional) FDs" documents the producer with a shape table, the AND-flatten + drop-on-unrecognized rule, the NOT-NULL gate, and the caching policy. The "Unique constraints" bullet under FK-derived-FDs now points to the new producer. Cross-references read consistently with the implementation.
- `type-utils.ts:46-49` comment correctly explains why partial UCs are routed through the new module rather than promoted to `RelationType.keys`.

### Known limitations (carried forward from the handoff)

- **DISTINCT-elimination over single-column projection**: `select distinct c from t where status='active'` projects down to just `{c}`; `projectFds` drops the FD because no dependents survive, so DISTINCT-elimination never sees a key proof. Pre-existing limitation also affecting unconditional UCs whose uniqueness is FD-derived rather than schema-declared via `RelationType.keys`. A follow-up that has `ProjectNode` re-emit projected keys derived from FDs (via `deriveKeysFromFds`) would unlock this, but it's out of scope. Sqllogic tests in section 7 reflect this — they pin correctness, not plan shape.
- `eq-literal { value: null }` is admitted when a partial predicate writes `col = NULL` literally. This matches no rows in SQL three-valued logic, so the FD is over zero rows = vacuously true and harmless. Not worth a recognizer-side short-circuit.

### Out of scope (filed as backlog)

- `tickets/backlog/fd-guard-range-subsumption.md` — range variant (`age >= 21` discharges `age >= 18`).
- `tickets/backlog/fd-guard-isnotnull-relaxes-notnull-gate.md` — lift the NOT-NULL gate when the partial predicate's `IS NOT NULL` conjuncts cover the UC columns.
- `tickets/backlog/fd-guard-or-in-not-shapes.md` — OR / IN-list / NOT shapes in the partial predicate.

### Validation

- `yarn workspace @quereus/quereus run lint` — exit 0, clean.
- `yarn workspace @quereus/quereus run test` — **3021 passing, 2 pending, 0 failing**. Matches the implement-stage handoff.
- `yarn test:store` — not run; nothing in this change touches the store layer (planner analysis on `TableSchema` only, exercised by the same memory-vtab schema reference path).

No findings rose to "major"; review-stage edits in this pass: none required.
