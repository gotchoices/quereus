description: ADD COLUMN with a non-foldable (per-row) DEFAULT such as `new.<column>` does not enforce a CHECK constraint on the new column against the backfilled existing rows. The post-backfill validation scan reads a pre-backfill snapshot for the evaluator path, so CHECK-violating rows are silently admitted. A plan-build guard now *rejects* the (non-foldable default + CHECK) combination as "not yet supported"; this ticket is to implement proper per-row enforcement and remove the guard.
files: packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/planner/building/alter-table.ts, packages/quereus/src/planner/nodes/alter-table-node.ts, packages/quereus/src/vtab/module.ts, packages/quereus/src/vtab/memory/layer/base.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus/test/logic/03.4-defaults.sqllogic, packages/quereus/test/logic/90.2.1-alter-extra-errors.sqllogic
----

## Problem

`ALTER TABLE … ADD COLUMN … DEFAULT (<non-foldable>) CHECK (<predicate over new col>)`
backfills existing rows by per-row evaluation (the `new.<column>` feature added in the
`add-column-new-ref-backfill` ticket), but the new column's CHECK is **not enforced**
against those backfilled rows. The ALTER succeeds and admits rows that violate the CHECK.

Confirmed repro (was silently succeeding before the guard landed):

```sql
create table t (id integer primary key, base integer null);
insert into t (id, base) values (1, 5), (2, -3);
alter table t add column c integer default (new.base * 2) check (c > 0);
-- c = -6 for row 2 violates `c > 0`; the ALTER should reject but did not.
```

Even a CHECK that **every** row violates (`check (c > 1000000)`) was not caught — the
in-ALTER scan sees no violating rows at all, i.e. it observes a snapshot from *before*
the per-row backfill committed.

### Root cause (as far as diagnosed)

`runAddColumn` (`runtime/emit/alter-table.ts`) validates new CHECK constraints **after**
`module.alterTable` returns, via `validateBackfillAgainstChecks` — a nested
`select 1 from <t> where not (<check>) limit 1` prepared/iterated on the same
`RuntimeContext` (`rctx`). For a **literal** default this scan correctly observes the
bulk-written rows (see `90.2.1 §3`, which still rejects + reverts). For the **evaluator**
(non-foldable) path it does not: running the backfill sub-program (`backfillCb(rctx)`)
per existing row during the module's append loop appears to perturb the snapshot the
subsequent sibling `SELECT` reads. Closing the backfill row slot before the scan did
**not** fix it (the implementer tried). The exact memory-layer / transaction-snapshot
interaction is unconfirmed and needs to be chased.

### Current interim behavior (the guard)

`buildAlterTableStmt` (`planner/building/alter-table.ts`) now throws
`StatusCode.UNSUPPORTED` when an ADD COLUMN carries **both** a non-foldable backfill
default and a CHECK constraint, so CHECK-violating data is rejected rather than silently
admitted. Regression test: `03.4-defaults.sqllogic` (`ac_chk`). **This ticket removes the
guard** once proper enforcement lands. The literal-default + CHECK path is unaffected and
keeps working through `validateBackfillAgainstChecks`.

## Requirements / expected behavior

- ADD COLUMN with a non-foldable default **and** a CHECK on the new column must enforce
  the CHECK against every backfilled existing row.
- A backfilled row that violates the CHECK must abort the ALTER and leave the table
  unchanged (no column added, catalog restored) — the same revert guarantee the
  literal-default path already provides, and the same in-hand rejection the NOT NULL path
  already provides for the per-row evaluator.
- Once enforced, remove the plan-build guard and replace the `ac_chk` rejection test with
  positive/negative cases: a passing CHECK succeeds; a violating CHECK rejects + reverts;
  exercise both memory and store modules.

## Direction (two candidate approaches — pick after spiking)

1. **Engine-side per-row enforcement (preferred, mirrors NOT NULL).** Compile the new
   CHECK predicate(s) against a row scope that includes the *new* column, and evaluate
   them inside the per-row backfill (the emitter already sets a row slot per existing row
   and has the computed new-column value in hand). Throw `StatusCode.CONSTRAINT` on the
   first violation before the tree/batch is swapped in. This avoids the broken post-scan
   entirely and reuses the build-local-then-swap rollback the modules already do for NOT
   NULL. Cost: a second compiled scalar + descriptor (covering existing columns + the new
   column) threaded through `AlterTableNode` → emit → the evaluator, and possibly a
   richer evaluator signature passed to `module.alterTable`.
2. **Fix the post-scan snapshot.** Chase why running the backfill sub-program on `rctx`
   makes the subsequent sibling `SELECT` read a stale snapshot, and make
   `validateBackfillAgainstChecks` observe the backfilled rows. Riskier — the interaction
   is subtle and module-specific — but localized if found.

Approach 1 also generalizes better to FK validation on backfilled rows (currently column-
level FKs added via ADD COLUMN are merged for future INSERT/UPDATE enforcement but are
**not** validated against existing rows for any default kind — out of scope here, but the
same per-row hook would enable it).
