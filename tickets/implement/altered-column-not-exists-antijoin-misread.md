description: Fix ADD COLUMN registering a new column-level FK into the live schema BEFORE validating existing rows against it. The FK-IND optimizer (`ruleAntiJoinFkEmpty` + seeded INDs) then trusts the unvalidated FK and folds the validator's own `NOT EXISTS` anti-join (and every later anti-join on the table) to `EmptyRelation`, so the orphan is never found and a violating row is admitted. Fix: register the new column WITHOUT the new FK for the validation pass (mirrors the ADD CONSTRAINT path), register the full schema only after validation passes; then the validator can revert to `NOT EXISTS`.
files: packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/schema/constraint-builder.ts, packages/quereus/src/planner/rules/subquery/rule-anti-join-fk-empty.ts, packages/quereus/src/planner/util/ind-utils.ts, packages/quereus/test/logic/41.4-alter-add-column-constraints.sqllogic, docs/runtime.md
----

## Root cause (confirmed empirically + against the docs)

This is **not** a row-layout / attribute-id / hash-join bug (the parent ticket's
"suspected root cause" was a red herring — the "unusually low attribute ids" were
just the `EmptyRelationNode` the fold produces). The real mechanism:

1. `ALTER TABLE c ADD COLUMN parent integer default 99 references p(pid)` runs in
   `emitAlterTable`'s `run()` (`runtime/emit/alter-table.ts`). After the module
   materializes the column, the code builds `enhancedTableSchema` (which **includes
   the new column-level FK** in `foreignKeys`) and registers it into the live
   `SchemaManager` via `schema.addTable(enhancedTableSchema)` **before** running the
   existing-row FK validation. (Comment there: *"Register the enhanced schema BEFORE
   backfill validation so that SQL bound during validation can resolve the new
   column."* — correct for the *column*, wrong for the *FK*.)

2. `validateForeignKeyOverExistingRows` issues a correlated `NOT EXISTS` subquery to
   find orphans. The planner decorrelates it to an **ANTI join**.

3. `ruleAntiJoinFkEmpty` (`planner/rules/subquery/rule-anti-join-fk-empty.ts`) sees
   the now-declared FK `c.parent → p.pid`, confirms it is non-nullable (Quereus
   columns **default to NOT NULL** per Third Manifesto — see
   `createDefaultColumnSchema` in `schema/column.ts`, so `parent` is NOT NULL even
   without an explicit `not null`) and that the parent side is row-preserving, and
   folds the anti-join to `EmptyRelationNode` under the inclusion dependency
   `L.fk ⊆ R.pk`. The same trust is also seeded as an IND at `TableReferenceNode`
   (`seedTableForeignKeyInds`, `planner/util/ind-utils.ts`).

4. That IND is **false here**: the freshly-backfilled rows have *not yet* been
   validated — that is precisely what the validator is running. So the validator's
   anti-join folds to empty → **no orphan found → the ALTER succeeds, admitting the
   violation.**

5. The "persistent corruption" is the *same* rule firing on every subsequent
   anti-join, because the FK stays declared in the schema while the data violates it.
   It is **not** data/layout corruption — it is the optimizer correctly trusting a
   declared-but-actually-violated FK invariant. `docs/optimizer.md` § Inclusion-
   dependency reasoning states the load-bearing assumption explicitly: *"declared FKs
   treated as hard inclusion dependencies; `pragma foreign_keys` defaults on."*

Why every other shape reads correctly: `select *`, `EXISTS`/semi-join, scalar
`count(*)`, `IN`, `NOT IN`, inner `JOIN`, and `LEFT JOIN … WHERE parent IS NULL` do
**not** match `ruleAntiJoinFkEmpty`'s `AntiJoin + covering-FK` pattern, so none of
them are folded — they read the materialized column directly. The current shipped
workaround in `validateForeignKeyOverExistingRows` (LEFT-anti-join) works for exactly
this reason.

Why ADD CONSTRAINT FK (test `41.8`) was already correct: the memory
(`vtab/memory/layer/manager.ts` → `addForeignKeyConstraint`) and store
(`quereus-store/.../store-module.ts`) ADD CONSTRAINT paths **validate BEFORE swapping
the FK into the cached/live schema**, so no declared FK exists during validation and
nothing folds. The fix below makes ADD COLUMN follow the same ordering.

## The fix (verified)

Mirror the ADD CONSTRAINT ordering inside `emitAlterTable`'s ADD COLUMN arm: during
the existing-row validation pass, the **live** schema for the child table must
contain the new **column** but **not** the new **FK(s)**. Register an intermediate
"validation schema" before validating; register the full `enhancedTableSchema` (with
the FK) only after validation passes. On a violation, revert exactly as today.

Verified empirically: with this reordering and the validator switched back to
`NOT EXISTS`, the reproduction throws `FOREIGN KEY constraint failed` (orphan
correctly detected), and the post-ALTER standalone anti-join is no longer mis-folded.

Concrete shape (the prototype that was tested — adapt naming/comments to house style):

```ts
const enhancedTableSchema = withGeneratedColumnGraph(enhancedBase);

// FK-IND folding (ruleAntiJoinFkEmpty + seeded INDs) treats a DECLARED FK as a
// proven invariant. ADD COLUMN's existing-row validation runs a NOT EXISTS
// anti-join to find orphans; if the new FK were already in the live schema the
// optimizer would fold that anti-join to EmptyRelation (trusting the very
// invariant we are checking) and silently admit a violating row — and every
// later anti-join on the table would stay folded. So register the new column
// WITHOUT the new FK(s) for the validation pass (mirrors the ADD CONSTRAINT
// path, which validates before swapping the FK in), then register the full
// schema only once validation passes.
const hasNewForeignKeys = resolvedForeignKeys.length > 0;
const validationSchema = hasNewForeignKeys
  ? withGeneratedColumnGraph({ ...enhancedBase, foreignKeys: updatedTableSchema.foreignKeys })
  : enhancedTableSchema;
schema.addTable(validationSchema);

const runCheckScan = !backfill && newCheckConstraints.length > 0;
if (runCheckScan || hasNewForeignKeys) {
  try {
    if (runCheckScan) await validateBackfillAgainstChecks(rctx, validationSchema, newCheckConstraints);
    for (const fk of resolvedForeignKeys) {
      // enhancedTableSchema only supplies column-name resolution here; the LIVE
      // schema the planner reads (validationSchema) lacks the FK, so no fold.
      await validateForeignKeyOverExistingRows(rctx.db, enhancedTableSchema, fk);
    }
  } catch (err) {
    // revert: drop the column + restore the original catalog entry (unchanged)
    ...
    schema.addTable(tableSchema);
    throw err;
  }
}

if (hasNewForeignKeys) schema.addTable(enhancedTableSchema); // commit the FK after validation
```

Notes / gotchas for the implementer:
- `validateForeignKeyOverExistingRows`'s `childSchema` arg is used only to build the
  SQL (table + child column names) and to resolve the parent via `schemaManager`; it
  does **not** require the FK to be in the live schema. What matters is that the
  **live registered** schema for the child table (`validationSchema`) omits the FK.
- When there are no new FKs, `validationSchema === enhancedTableSchema`, so behavior
  for existing non-FK ADD COLUMN paths is byte-identical to today.
- Keep the existing revert path (drop column + `schema.addTable(tableSchema)`).
- `notifyChange` / the function's return must still carry `enhancedTableSchema`.

## Validator form decision

Acceptance requires the engine fix at the source (the `NOT EXISTS` form must work).
**Revert `validateForeignKeyOverExistingRows` to the `NOT EXISTS` formulation** (it is
the simpler, self-documenting form and proves the engine bug is fixed, not merely
worked around). Drop the LEFT-anti-join SQL and its long explanatory comment, and
update the `docs/runtime.md` note (~line 1150-1159) that currently says the validator
uses LEFT JOIN to avoid this engine bug. (Both forms are correct post-fix; we pick
`NOT EXISTS` deliberately to keep the two engine FK validators — ADD COLUMN and ADD
CONSTRAINT — textually aligned and to exercise the fixed anti-join path.)

## Out-of-scope observation (do NOT fix here; file backlog only if deemed worth it)

The IND/FK-folding rests on *"declared FKs are hard inclusion dependencies; FK
enforcement is on."* If a user does `pragma foreign_keys = off`, inserts orphans, then
re-enables enforcement (or queries while off), a `NOT EXISTS` over that FK still folds
to empty and hides the orphans (reproducible: create-time nullable→NOT NULL FK column,
FK off, insert orphan, anti-join returns `[]`). This is "garbage in" under the stated
soundness model and is **not** part of this ticket. Mention it in the review handoff;
file a `backlog/` ticket only if the team wants the optimizer to distrust FKs while
`pragma foreign_keys = off`.

## Reproduction (minimal)

```js
const db = new Database();
await db.exec('pragma foreign_keys = true');
await db.exec('create table p (pid integer primary key)');
await db.exec('insert into p values (1), (2)');
await db.exec('create table c (id integer primary key, name text)');
await db.exec("insert into c values (1, 'x')");
// 99 ∉ {1,2}; with the validator on NOT EXISTS this MUST throw FOREIGN KEY constraint failed
await db.exec('alter table c add column parent integer default 99 references p(pid)');
```

## TODO

- In `runtime/emit/alter-table.ts` ADD COLUMN arm: register a `validationSchema`
  (new column, **no new FK(s)**) before the validation block; register
  `enhancedTableSchema` (with FK) only after validation passes. Preserve the existing
  revert path. Pass `validationSchema` to `validateBackfillAgainstChecks`.
- In `schema/constraint-builder.ts`: revert `validateForeignKeyOverExistingRows` from
  the LEFT-anti-join SQL back to the `NOT EXISTS` form; remove the workaround comment
  block that references this ticket slug.
- Update `docs/runtime.md` (~1150-1159) note to describe the `NOT EXISTS` validator
  and the ADD-COLUMN-registers-FK-after-validation ordering (drop the LEFT-JOIN
  rationale).
- Regression — `test/logic/41.4-alter-add-column-constraints.sqllogic` already covers
  the throw-on-orphan cases for **both** literal-default and per-row (evaluator)
  default and self-ref paths; with the validator reverted to `NOT EXISTS` these now
  exercise the fixed engine path. Re-run and confirm they still pass. **Add** explicit
  assertions guarding the engine bug directly:
  - after a *valid* ADD COLUMN FK (all rows reference an existing parent), a
    standalone `select id from c where not exists (select 1 from p where p.pid =
    c.parent)` returns the correct set (empty — the FK genuinely holds) and
    `select *` shows the backfilled column; and
  - the orphan ADD COLUMN FK aborts and leaves the table unchanged (column dropped),
    so a subsequent standalone anti-join on the (reverted) table is correct.
- Run `yarn workspace @quereus/quereus test` (memory). The fix is module-agnostic
  (it lives in the engine emit path that both memory and store ADD COLUMN go through),
  so also run `yarn test:store` to satisfy the "memory AND store" acceptance, or note
  the store run as a deferral if wall-clock is prohibitive.
- `yarn workspace @quereus/quereus lint` (single-quote globs on Windows) and
  `yarn workspace @quereus/quereus typecheck`.
