---
description: FD-closure-aware row/group/global classification for assertion delta execution (completed)
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts
  - packages/quereus/src/core/database-assertions.ts
  - packages/quereus/src/func/builtins/explain.ts
  - packages/quereus/test/optimizer/row-specific-fd.spec.ts
  - docs/architecture.md
  - docs/optimizer.md
---

## What landed

`analyzeRowSpecific` upgraded from a two-way `'row' | 'global'` map to a three-way
`RowSpecificResult { classifications: Map<relKey, 'row' | 'group' | 'global'>, groupKeys: Map<relKey, number[]> }`:

- **Equality coverage now closes under FDs/ECs.** `computeCoveredKeysForConstraints` takes optional
  `fds` + `equivClasses`. They flow from the TableReference node's physical properties via
  `createTableInfoFromNode`. Result: equality on a UNIQUE column covers the PK via the table's local
  `unique → other-columns` FD; equality plus an EC covers anything in the class.
- **Aggregates can promote `'global' → 'group'`.** For each table reference beneath an
  Aggregate/StreamAggregate/HashAggregate, the closure of bare-column GROUP BY entries at the
  aggregate's *source* physical context (so Filter-induced ECs flow in) is mapped through
  attribute IDs back to the table reference. If any unique key is covered, the reference is
  `'group'` with the greedy-minimized subset as `groupKeys[relKey]`.
- **`'row'` survives an aggregate above it.** Equality coverage at a Filter beneath the aggregate
  is strictly stronger than group coverage.
- **Aggregate without GROUP BY no longer demotes.** Single-group aggregate produces one row;
  existing classifications survive (recurse without adjustment). Prior code demoted these to
  `'global'`.
- **Window no longer demotes.** Windowing preserves input row count, so the classification
  beneath survives upward. SetOperation still demotes conservatively.

Consumers updated:

- `database-assertions.ts` destructures `{ classifications }`; treats `'group'` like `'global'`
  (full violation query) with `TODO(fd-view-maintenance-binding-keys)` marking the deferred
  runtime work. Follow-up ticket exists at `tickets/plan/4-fd-view-maintenance-binding-keys.md`.
- `explain.ts` emits the classification verbatim; for `'group'`, `prepared_pk_params` lists the
  minimal group-key column **names** on the underlying table.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn workspace @quereus/quereus run test` — 2877 passing, 2 pending. Includes the 13 new
  spec cases in `test/optimizer/row-specific-fd.spec.ts` and the pre-existing
  `explain_assertion` checks in `test/logic/95-assertions.sqllogic` (rows for `a_row` and
  `a_global` still produce `pk0`/`global` as before).

## Review findings

### Diff read first — what was actually changed

Inspected `2ba76e47` end-to-end before reading the implementer's handoff:
`constraint-extractor.ts` (≈300 LOC of net change), `database-assertions.ts` (signature
destructure + branch update), `explain.ts` (prepared-params branch by classification),
`docs/architecture.md` + `docs/optimizer.md` (definitions, algorithm, API).

### Correctness

- **FD-closure equivalence on empty inputs.** `computeCoveredKeysForConstraints` guards with
  `(fds && fds.length > 0) || (equivClasses && equivClasses.length > 0)`; otherwise `closure = eqCols`
  by reference, and the per-key check is identical to the prior pure-equality path. Callers that
  don't pass FDs/ECs (no existing internal callers were missed) see no behavior change.
- **Aggregate-without-GROUP-BY preservation.** Trace through `select count(*) from t where id = 1`:
  initial pass equality-covers PK → `'row'`. Adjustment pass: `groupBy.length === 0` → just
  recurse, no overwrite. Test asserts `'row'`; previously this would have demoted to `'global'`.
  Semantically correct: the input filter narrows to ≤1 row, and the aggregate over a singleton
  still binds to that row.
- **Window non-demotion.** Window preserves input row count; the table reference's PK still
  constrains the input to ≤1 row. Test in spec confirms `'row'` through a `row_number()` window.
- **Equality-covered-stronger-than-group.** `current === 'row' { continue }` branch in
  `classifyForAggregate` preserves `'row'` even when GROUP BY would otherwise classify as `'group'`
  or `'global'`. Test `WHERE id = 1 GROUP BY v` confirms.
- **Attribute-ID-driven source↔table mapping.** Each table-column index resolves to an attribute
  ID, then `sourceAttrs.findIndex(a => a.id === attrId)` locates the source-column index. Columns
  dropped by an intervening Project (or sibling-join columns) are silently absent, which is the
  documented behavior. Unique keys that lose any column under this mapping fail the cover check
  and fall to `'global'` — conservative and correct.
- **Greedy minimization correctness.** Drops a column iff the remaining set's closure still covers
  some unique key. The result has minimum cardinality up to iteration order (acknowledged gap;
  tests assert length only where ambiguous).
- **TODO present and correctly attributed.** `TODO(fd-view-maintenance-binding-keys)` in
  `database-assertions.ts:226-227` names the live follow-up ticket
  (`tickets/plan/4-fd-view-maintenance-binding-keys.md`), so the deferred runtime work isn't
  lost.

### Quality / DRY / cleanup

- `keyCoveredInSourceSpace` closure is defined inline at lines 1148–1154 and then duplicated
  inline inside the greedy-minimization `tInfo.uniqueKeys.some(...)` at lines 1172–1178. Minor
  duplication — the trial-closure version intentionally uses a different `closure` arg, so a
  shared helper would have needed a closure parameter. Not material; left as-is.
- `sourceColsByGroupEntry` array is created and immediately consumed for the `Set` constructor;
  could have been `new Set(groupByEntries.map(e => e.sourceColIdx))`. Micro-nit, no change.
- `attrIdByTableCol` is a Map that's only ever iterated (`for (const [tcol, attrId] of ...)`) —
  could be a simpler array indexed by `tcol`. Not worth changing.

### Edge cases

- **Aggregate over a join.** Each table reference under the join carries its own attribute IDs.
  The `tableColToSourceCol` mapping is per-reference. A unique key only on one side of the join
  whose columns survive to the aggregate's source is classifiable independently; the other side
  may legitimately land at `'global'` if its key columns aren't in the GROUP BY closure. Not
  covered by spec tests but the algorithmic structure handles it.
- **GROUP BY expressions that aren't bare ColumnReferences** (e.g. `GROUP BY id + 0`) are skipped
  by the `expr.nodeType !== PlanNodeType.ColumnReference` guard. The reference falls to
  `'global'` in that case. Acceptable, documented behavior.
- **Nested aggregates.** The top-down walk processes the outer aggregate first, then recurses
  into its source which may contain another aggregate. The outer pass may set a reference to
  `'group'`; the inner pass enters the `current !== 'row'` branch and can overwrite that
  classification (with its own `'group'` or `'global'`). For a violation query consumed by the
  outer aggregate, the *outer* classification is the right answer for runtime binding. In
  practice the inner aggregate's source columns are unlikely to expose the table reference's
  full key (the inner aggregate's projection drops most non-grouped columns), so the inner
  pass usually lands at `'global'` and overwrites the outer's `'group'` with `'global'` —
  pessimistic but safe. Worth flagging if anyone hits it in the runtime ticket; for now,
  conservative degradation is acceptable. **Not filed as a fix ticket** (deferred runtime
  doesn't exercise `'group'` yet).
- **`'row'` for ungrouped aggregates may run the parameterized variant N times** for N changed
  keys instead of one global execution. Correctness-preserving; could be slower for large
  change sets. Runtime threshold is a future tuning concern, not in scope here.

### Docs

- `docs/architecture.md:131` adds a paragraph defining the three-way classification and points
  to the optimizer.md section — accurate.
- `docs/optimizer.md` § *Core Definitions*, *Classification API*, *Diagnostics & Tooling*,
  *Binding-aware Delta Planning* — all updated to reflect three modes + `groupKeys` +
  deferred-runtime caveat. Minor residual: § *Unique key propagation rules* (line 1301) still
  says "Set operations/window functions: Conservatively clear `uniqueKeys` unless proven
  otherwise." That rule concerns *physical-property propagation*, not the row/group/global
  classification pass — it's a separate axis (uniqueKeys above a Window are cleared; the table
  reference *below* the Window keeps its own uniqueKeys, which is what the classifier reads).
  Not contradictory, but a reader could conflate them. Filed inline here rather than as a
  ticket since the existing text isn't wrong.

### Test coverage

- 13 new cases in `row-specific-fd.spec.ts` exercise: equality on PK, UNIQUE col (via local
  FDs), non-key (global); GROUP BY PK, UNIQUE, non-key, multi-column minimization, EC-derived
  minimization via inner Filter, row-dominates-group, ungrouped aggregate with/without
  equality, Window non-demotion, end-to-end `explain_assertion` `'group'` surface.
- Pre-existing `test/logic/95-assertions.sqllogic` checks for `'row'` (`pk0` prepared params)
  and `'global'` classification still pass — no regression.
- **Gap not covered by spec:** aggregate over a join with a unique key on only one side.
  Algorithmic structure handles it (per-reference), but no test asserts the partition
  behavior. Acceptable per the implementer's note; the runtime-binding ticket can add coverage
  as it exercises real-world plans.

### Lint + tests

- `yarn workspace @quereus/quereus run lint` → exit 0.
- `yarn workspace @quereus/quereus run test` → 2877 passing, 2 pending.

### Disposition

- All findings are minor and either accepted as documented gaps (greedy ordering, nested
  aggregate overwrite, ungrouped-aggregate perf, cross-join-aggregate test gap) or
  inline-resolved (no code changes needed in this pass).
- **No new fix/plan tickets filed.** The runtime-binding follow-up
  (`fd-view-maintenance-binding-keys`) was already in `plan/` before this ticket landed and
  carries the deferred work.
