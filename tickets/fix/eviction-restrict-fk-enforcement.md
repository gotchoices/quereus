description: A secondary-UNIQUE REPLACE eviction silently bypasses FK `ON DELETE RESTRICT` / `NO ACTION` enforcement — the evicted parent row is deleted and its `RESTRICT`/`NO ACTION` children are left orphaned, where SQLite fails the statement. The eviction pipeline (`processEvictions`) fires the FK *actions* (CASCADE / SET NULL / SET DEFAULT) but never runs the RESTRICT pre-check that ordinary deletes use.
prereq:
files: packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus-isolation/src/isolated-table.ts, packages/quereus/test/logic/55-internal-eviction-reporting.sqllogic
----

## Problem

`internal-eviction-reporting` (landed) made secondary-UNIQUE REPLACE evictions run the
full delete pipeline via `processEvictions` in `dml-executor.ts`:

```
_recordDelete + maintainRowTimeStructures({op:'delete'}) + executeForeignKeyActions('delete') + delete auto-event
```

`executeForeignKeyActions` handles the FK **actions** — `CASCADE`, `SET NULL`,
`SET DEFAULT` — but **explicitly skips `RESTRICT`** (`foreign-key-actions.ts:59`,
`if (action === 'restrict') continue;`). `RESTRICT` / `NO ACTION` enforcement lives in
the separate `assertNoRestrictedChildrenForParentMutation` /
`assertTransitiveRestrictsForParentMutation` **pre-checks**, which `processDeleteRow`
and `processUpdateRow` call *before* `vtab.update()`. `processEvictions` calls neither.

Because the substrate physically deletes the evicted row **inside** `vtab.update()` and
only *then* reports it via `evictedRows`, by the time the executor sees the eviction the
row is already gone from storage — there is no pre-mutation point at which the current
pre-check could run.

The FK default `onDelete` is `'restrict'` (`schema/table.ts:411`), so this affects
**every** FK without an explicit `ON DELETE CASCADE`/`SET NULL`/`SET DEFAULT` clause.

### Reproduction (confirmed during review of internal-eviction-reporting)

```sql
pragma foreign_keys = true;
create table p (id integer primary key, email text not null, unique (email));
create table c (cid integer primary key, pid integer not null,
                foreign key (pid) references p(id) on delete restrict);
insert into p values (1, 'a@x');
insert into c values (10, 1);

-- evicts p(id=1) via the UNIQUE(email) conflict at a different PK:
insert or replace into p values (2, 'a@x');
-- ACTUAL:   no error; p = [{id:2,email:'a@x'}], c = [{cid:10, pid:1}]  ← orphaned child
-- EXPECTED: FOREIGN KEY constraint failed (RESTRICT), statement rolled back
```

Same gap applies to the UPDATE-with-REPLACE-default move path and to a child with no
explicit `ON DELETE` clause (default `RESTRICT`).

## Expected behavior

A REPLACE eviction of a row referenced by a `RESTRICT` (or default `NO ACTION`) FK must
fail the statement with a `FOREIGN KEY constraint failed` error and leave the data
unchanged — matching SQLite and matching how an explicit `delete from p where id=1`
already behaves through `processDeleteRow`.

## Design considerations / open question

The substrate deletes-then-reports, so a post-hoc executor check would need to either
(a) detect the would-be-evicted rows *before* the substrate acts, or (b) roll the
statement back on a RESTRICT violation discovered after the fact. Candidate approaches:

- **Pre-check inside each substrate's `checkUniqueConstraints`** — before `recordDelete`
  / `deleteRowAt` / `insertTombstoneForPK` of the conflicting row, the substrate (or a
  shared callback into the engine) runs the RESTRICT scan and returns a `constraint`
  result instead of evicting. Spreads the check across all three substrates (memory,
  store, isolation) but keeps it pre-mutation. Mirrors how the plan-time parent-side
  FK check is absent for the internal eviction.
- **Statement-savepoint rollback** — `runWithStatementSavepoints` already wraps the row
  loop; on a RESTRICT violation surfaced from `processEvictions`, throw a
  `ConstraintError` and let the savepoint roll back the substrate's eviction + write.
  Requires `processEvictions` to run the RESTRICT scan against the *post-eviction* state
  (the parent row is gone, but the children remain), which `assertNoRestricted...`'s
  `select 1 from child` still answers correctly — it keys off the child rows, not the
  parent. This may be the lower-touch option; verify the savepoint actually unwinds the
  in-`update()` eviction on all substrates.

Decide between these (or another) — the savepoint-rollback path looks single-site and
worth prototyping first.

## TODO

- Reproduce the bug with a failing test (FK `RESTRICT` + default-`NO ACTION` child;
  INSERT-OR-REPLACE eviction and UPDATE-REPLACE-default move).
- Implement RESTRICT/NO ACTION enforcement for the eviction path (prefer the
  single-site savepoint-rollback approach if it cleanly unwinds the substrate eviction;
  otherwise the per-substrate pre-check).
- Cover memory, direct store, and isolation-wrapped store (`yarn test` + `yarn test:store`).
- Update the known-limitation notes in `docs/module-authoring.md` and `docs/runtime.md`
  (and `docs/materialized-views.md` if relevant) once enforced.
- Add positive cases (eviction of a row with CASCADE/SET NULL children still succeeds)
  to guard against over-blocking.
