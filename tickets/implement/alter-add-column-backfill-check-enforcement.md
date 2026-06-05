description: Enforce a CHECK on the new column against backfilled rows for ADD COLUMN with a non-foldable (per-row) DEFAULT (e.g. `new.<col>`), and remove the plan-build guard that currently rejects the combination. Implements per-row CHECK evaluation inside the backfill hook (mirrors the working NOT NULL per-row path), so a violating backfilled row aborts the ALTER and leaves the table unchanged on both the memory and store modules.
effort: high
files: packages/quereus/src/planner/building/alter-table.ts, packages/quereus/src/planner/nodes/alter-table-node.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/runtime/emit/constraint-check.ts, packages/quereus/src/runtime/context-helpers.ts, packages/quereus/src/vtab/memory/layer/base.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus/test/logic/03.4-defaults.sqllogic, packages/quereus/test/logic/90.2.1-alter-extra-errors.sqllogic
----

## Goal

`ALTER TABLE … ADD COLUMN … DEFAULT (<non-foldable>) CHECK (<predicate over new col>)`
must enforce the new column's CHECK against every backfilled existing row. A violating
row aborts the ALTER and leaves the table unchanged (no column added, catalog restored).
Remove the interim plan-build guard that rejects this combination as "not yet supported".

The literal-default + CHECK path (validated by the post-backfill scan
`validateBackfillAgainstChecks`, regression `90.2.1 §3`) is **unaffected** and stays as-is.

## Background / why this works (Approach 1, confirmed during fix triage)

The bug: for the **non-foldable (evaluator) default** path, the post-backfill scan
`select 1 from <t> where not (<check>) limit 1` in `runAddColumn`
(`runtime/emit/alter-table.ts`) reads a pre-backfill snapshot, so CHECK-violating
backfilled rows are silently admitted. (The interim guard in `buildAlterTableStmt`
rejects the combination rather than admit bad data.)

The fix reuses the mechanism that **already works** for NOT NULL on the per-row
evaluator path. NOT NULL is enforced *inside* the per-row backfill, before any tree/batch
swap:

- Memory: `base.ts` `recreatePrimaryTreeWithNewColumn` builds into a **local** `newTree`
  and only assigns `this.primaryTree = newTree` after the loop; a throw discards the local
  tree, and `manager.addColumn`'s catch restores the schema (`base.ts:225-260`,
  `manager.ts:1441-1484`). Regression: `03.4 ac_nn`.
- Store: `store-table.ts` `migrateRows` accumulates into `store.batch()` and calls
  `await batch.write()` only **after** the loop (`store-table.ts:303-331`); a throw mid-loop
  leaves the store untouched, and `store-module.alterTable` throws before
  `table.updateSchema` / `saveTableDDL`.

In both cases the throw propagates out of `module.alterTable` **before**
`runAddColumn` reaches `schema.addTable(enhancedTableSchema)`, so the catalog is never
mutated — zero extra rollback code. CHECK enforcement just needs to throw from the **same
per-row hook** the evaluator already runs.

CHECK truthiness must match write-time semantics in
`constraint-check.ts:checkCheckConstraints`: a CHECK **fails** iff the evaluated result is
`false` or `0`; NULL and any other truthy value **pass**.

## Design

### Plan-build (`planner/building/alter-table.ts`)

- Delete the `StatusCode.UNSUPPORTED` guard (currently ~lines 76-81) that rejects
  `backfill && column has a CHECK`.
- When (and only when) a `backfill` is produced (non-foldable default) **and** the column
  carries column-level CHECK constraints, compile each CHECK predicate against a row scope
  covering the **existing columns plus the new column**, and attach the compiled predicates
  to the `addColumn` action.
  - Build fresh `Attribute[]` for existing columns + one for the new column (mirror the
    `rowAttrs` construction in `buildAddColumnBackfill`; the new column's logical type comes
    from `columnDef` — resolve via the same path the schema builder uses, or reuse the
    column's declared `dataType`/nullability). Use `buildRowDefaultScope(ctx.scope,
    [...existingColumns, newColumn], rowAttrs)` so the CHECK's bare `<col>` ref to the new
    column resolves (it registers both `new.<col>` and bare `<col>`), as do refs to existing
    columns.
  - `buildExpression({ ...ctx, scope }, checkExpr)` for each CHECK → `ScalarPlanNode`.
  - Produce a `rowDescriptor` mapping those attribute ids → positions (existing cols at
    their index, new col at `existingColumns.length`).
- Only compile checks for the evaluator path. For a literal/folded default the existing
  post-scan still handles CHECK, so do not compile per-row checks there.

### Node (`planner/nodes/alter-table-node.ts`)

- Add and export an interface, e.g.:
  ```ts
  export interface AddColumnCheck {
    readonly predicates: ReadonlyArray<{ node: ScalarPlanNode; name?: string; exprText: string }>;
    readonly rowDescriptor: RowDescriptor; // existing columns + new column
  }
  ```
  `exprText` (`expressionToString(con.expr)`) and `name` are for the error message.
- Extend the `addColumn` action variant: `{ type: 'addColumn'; column; backfill?; checks?: AddColumnCheck }`.

### Emit (`runtime/emit/alter-table.ts`)

- `emitAlterTable`: emit the check predicate nodes as additional params alongside the
  backfill node. Keep a stable order so `run` can recover them, e.g.
  `params = [...(backfill ? [emitCallFromPlan(backfill.node, ctx)] : []), ...(checks?.predicates ?? []).map(p => emitCallFromPlan(p.node, ctx))]`.
  Note the backfill param is conditional, so index bookkeeping must account for its
  presence (prefer: always reserve slot 0 for backfill when present, then checks; or pass
  counts explicitly). Thread the resolved check callbacks into `runAddColumn`.
- `runAddColumn`:
  - Build a second row slot over `checks.rowDescriptor` (`createRowSlot`), in addition to
    the existing backfill `rowSlot`.
  - Wrap `backfillEvaluator`: after computing `value`, set the check slot to
    `[...row, value]`, evaluate each check callback, and throw on violation:
    ```ts
    const result = await resolve(checkCb(rctx));
    if (result === false || result === 0) {
      throw new QuereusError(`CHECK constraint failed: ${name ?? ''}${exprText ? ` (${exprText})` : ''}`, StatusCode.CONSTRAINT);
    }
    ```
    (Mirror the message shape used by `constraint-check.ts` for consistency; tests only
    assert `-- error:` so exact text is flexible.)
  - Close the check slot in the same `finally` that closes the backfill `rowSlot`.
  - Gate the post-scan: skip `validateBackfillAgainstChecks` when `backfill` is present
    (per-row enforcement already covered it; relying on the stale-snapshot scan there is
    exactly the bug). Keep the post-scan for the literal-default path (`!backfill`).

### Tests

- `03.4-defaults.sqllogic`: replace the `ac_chk` rejection block (currently asserts
  `-- error: not yet supported` and that the table is unchanged) with:
  - **passing** CHECK succeeds and backfills (e.g. `base` all positive,
    `default (new.base * 2) check (c > 0)` → column added, values correct);
  - **violating** CHECK rejects + reverts (e.g. a negative `base` row →
    `-- error:`, then `select *` shows the table unchanged: no `c` column);
  - an **all-rows-violate** case (`check (c > 1000000)`) to cover the original
    silent-admission scenario.
- Mirror the same positive/negative cases for the store module. `03.4-defaults.sqllogic`
  is part of the suite re-run by `yarn test:store`; confirm the new cases pass there too
  (the store rollback path is `migrateRows` + `store-module.alterTable`).
- `90.2.1-alter-extra-errors.sqllogic §3` (literal default + CHECK) stays unchanged — it
  guards the unaffected post-scan path.

## Out of scope (note for future)

Column-level FK validation against existing backfilled rows is still not performed for any
default kind (FKs added via ADD COLUMN are merged for future INSERT/UPDATE enforcement
only). The same per-row hook introduced here would enable it later — leave a brief
follow-up note but do not implement.

## TODO

- [ ] Remove the UNSUPPORTED guard in `buildAlterTableStmt` (`planner/building/alter-table.ts`).
- [ ] Compile per-row CHECK predicates (existing cols + new col scope) when `backfill` is
      present and the column has CHECK constraints; attach as `AddColumnCheck` to the action.
- [ ] Add/export `AddColumnCheck` and extend the `addColumn` action in `alter-table-node.ts`.
- [ ] Emit check predicate nodes as params and thread callbacks into `runAddColumn`.
- [ ] Wrap the backfill evaluator to set the `[...row, value]` check slot and throw
      `StatusCode.CONSTRAINT` on `result === false || result === 0`; close the slot in `finally`.
- [ ] Skip `validateBackfillAgainstChecks` when `backfill` is present; keep it for the
      literal-default path.
- [ ] Rewrite `03.4 ac_chk` into passing / violating / all-violate cases (memory + store).
- [ ] Confirm `90.2.1 §3` still passes; run `yarn workspace @quereus/quereus test` and lint.
- [ ] Run `yarn test:store` for `03.4-defaults.sqllogic` to confirm the store rollback path.
- [ ] Add a one-line follow-up note (FK backfill validation reuse) in the relevant doc/comment.
