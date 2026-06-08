---
description: Per-column NULL-safe residual fix in `AssertionEvaluator.tryWrapTableReference`. The row/group residual builder now wraps each *nullable* key column with `(col IS NULL AND :prefix_i IS NULL) OR col = :prefix_i` and keeps the plain `col = :prefix_i` form for NOT NULL columns. This fixes a latent silent-skip bug on NULL-keyed change tuples should `chooseRowKey` ever land on a nullable UNIQUE column, while leaving the dominant PK-bound row path textually identical to before.
files:
  - packages/quereus/src/core/database-assertions.ts
  - packages/quereus/test/logic/95-assertions.sqllogic
  - docs/incremental-maintenance.md
---

## What landed

### `packages/quereus/src/core/database-assertions.ts` — `tryWrapTableReference`
Replaced the binding-kind-scoped `nullSafe = paramPrefix === 'gk'` flag with a per-column `colNullable = attributes[colIdx].type.nullable === true` check. Nullable key columns emit the NULL-safe disjunctive conjunct; NOT NULL columns keep the plain equality conjunct. `paramPrefix` remains, used only for parameter-name construction. The block comment above the loop was rewritten to describe the per-column rule.

### `packages/quereus/test/logic/95-assertions.sqllogic` — new `rnn_balance` block
Appended at line 550. Exercises a row-classified assertion on a table with a nullable UNIQUE column present in the schema:
- Asserts `explain_assertion('rnn_balance').prepared_pk_params = ["pk0"]` — regression guard that `chooseRowKey` still prefers the PK via FD/EC closure even with a nullable UNIQUE column in scope.
- Seeds a row with `ext_id` NULL; verifies the residual catches an UPDATE that violates the assertion and rolls back.

### `docs/incremental-maintenance.md`
"First consumer: AssertionEvaluator" step 4 now describes the unified per-column-nullable rule rather than the previous row-vs-group asymmetry.

## Review findings

### Correctness of the fix (verified)
- **Per-column predicate shape**: For each `keyColumns[i]`, the conjunct is `col = :prefix_i` when `attributes[colIdx].type.nullable === false` and `(col IS NULL AND :prefix_i IS NULL) OR col = :prefix_i` otherwise. ANDed across all key columns. Matches the contractual spec.
- **`nullable` provenance is sound**: `TableReferenceNode.attributesCache` (`packages/quereus/src/planner/nodes/reference.ts:44`) sets `nullable: !column.notNull`, derived directly from the table schema. `tryWrapTableReference` only matches `TableReferenceNode` (`database-assertions.ts:473`), so the nullable annotation reflects the raw schema rather than any outer-join-widened context. Safe.
- **Symmetry win is real**: NOT NULL group-by columns (rare but possible) now collapse to plain `=`, which is semantically equivalent to the OR form when neither side can be NULL and is friendlier to index-driven access.
- **Param-name unchanged**: `:pk_0`/`:gk_0` naming is preserved because `paramPrefix` is still threaded through `makeParamRef`.

### Test coverage
- The new `rnn_balance` block exercises the typical PK-bound path with a nullable UNIQUE column *present in the schema*. The residual on this path is textually unchanged (PK is NOT NULL → plain `=`), so this block does **not** directly cover the new code edge. The handoff is explicit about this. The deeper gap is acknowledged below.
- Existing group-classified blocks (`onn_nonneg`, `omc_nonneg`) implicitly cover the nullable-column-of-group path — group-by columns are typically nullable, so the OR form is still emitted and these tests would have failed if the refactor broke that path. Full suite passes — they did not.
- No unit-level test of `tryWrapTableReference` was added. The codebase has no precedent for direct unit tests in this layer; sqllogic is the established harness. Acceptable.

### Acknowledged gap (no fix in this pass)
- **No SQL shape forces `chooseRowKey` onto a nullable UNIQUE column.** FD/EC closure propagates equality on a UNIQUE column to equality on the PK, making PK covered and chosen. Without an intervening node that breaks closure (Project that drops PK, SetOp branch, derived table whose outer plan can't see PK), the fix is forward-looking. I exhausted the obvious candidate shapes against the planner's covered-keys analysis without finding one that classifies as `'row'` with a non-PK binding in a small time-box. Filing a follow-up is not warranted: the residual builder is now contractually NULL-safe per column type, and `chooseRowKey` itself is out-of-scope per the prereq ticket.

### Files that *should* have been touched but weren't (checked)
- `tickets/complete/delta-null-group-key.md` — the original group-side fix. Unchanged; the comment in `tryWrapTableReference` has been rewritten to obsolete the row-vs-group rationale, but the historical complete ticket is correctly left intact.
- `packages/quereus/src/planner/analysis/binding-extractor.ts` — `chooseRowKey` flagged in the implement ticket as a defensive-bonus refactor candidate (prefer PK-via-FD-closure when nullable UNIQUE is in `coveredKeys`). Explicitly deferred by the implement ticket; no change here.
- Nothing else in `core/`, `planner/`, or `runtime/` references the row/group residual shape directly. Searched for `tryWrapTableReference`, `injectKeyFilter`, and `prefix === 'gk'`-style flags — no callers outside `database-assertions.ts`.
- Docs: `docs/incremental-maintenance.md` was the only doc describing the row-vs-group asymmetry and is correctly updated. `docs/runtime.md`, `docs/optimizer.md`, and `docs/architecture.md` do not describe this residual shape.

### Validation runs
- **Lint** (`yarn workspace @quereus/quereus run lint`): clean, exit 0.
- **Full quereus tests** (`yarn test` against the workspace, spec reporter): 2940 passing, 2 pending. Matches the implement summary. Default-reporter run showed a flaky timeout on `property-planner.spec.ts → join-key-inference disabled` — verified pre-existing (passes in 840 ms in isolation), unrelated to this change.
- **New block** (`yarn test --grep 95-assertions`): 1 passing (243 ms).
- **`yarn test:store`**: not run. The change is in the planner-rewrite layer and doesn't touch store code paths. A release should re-run it; flagged in the implement handoff.

### Code style / DRY / aesthetics
- Comment block above the loop is accurate, appropriately scoped, and matches the surrounding house style of explaining the *why* rather than the *what*.
- `colNullable = attributes[colIdx].type.nullable === true` — strict equality is intentional and safe (the field is a required boolean per `common/datatype.ts:22`); reads as explicit-intent guard, not paranoia. Fine.
- Loop body is unchanged structurally — single-purpose, no nested abstractions introduced. Stays DRY.
- The two-fresh-ColumnRef/ParamRef allocations inside the `if (colNullable)` block (for IS-NULL legs) are intentional — the plan-node tree does not allow shared sub-expressions. Pattern is consistent with how the prior group-side fix was written.

### Performance
- **Hot path (row → PK)**: textually identical to pre-fix predicate. No optimizer regression.
- **Group path**: identical for nullable group-by columns (the typical case). For NOT NULL group-by columns the predicate is now strictly simpler.
- **New path (nullable UNIQUE bound)**: previously incorrect (silent miss); now correct at the cost of a disjunctive predicate on that conjunct. No regression — the alternative is undetected violations.

### Disposition
All findings are informational or already documented in the handoff. No minor fixes applied; no new tickets filed. The fix is a correctness backstop for an edge case that is currently unreachable through normal planning, and it lands without disturbing the dominant hot path.

## Test-plan checklist (from review)
- [x] `yarn workspace @quereus/quereus run lint` — PASS
- [x] `yarn workspace @quereus/quereus run test` — 2940 passing, 2 pending (spec reporter)
- [x] `--grep 95-assertions` — 1 passing
- [x] Verified pre-existing flaky `property-planner` timeout is unrelated to this change
- [ ] `yarn test:store` — deferred, see above
