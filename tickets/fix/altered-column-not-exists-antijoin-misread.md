description: A `not exists` (hash-anti-join) subquery that references a CHILD column added earlier in the SAME ALTER TABLE ADD COLUMN statement (a literal- or per-row-default backfill) misreads that column and reports NO orphans — and persistently corrupts subsequent anti-joins on the table. Logically-equivalent shapes (`LEFT JOIN … WHERE parent IS NULL`, per-row PK lookups) read the column correctly. Discovered while implementing `alter-add-column-backfill-fk-enforcement`, which had to route its FK existing-row scan around this bug.
files: packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/schema/constraint-builder.ts, packages/quereus/src/planner/rules/subquery/, packages/quereus/src/runtime/emit/join.ts, packages/quereus/src/vtab/memory/layer/base.ts, packages/quereus/src/vtab/memory/layer/manager.ts
----

## Summary

When `ALTER TABLE … ADD COLUMN` backfills a new column (literal or per-row default)
and code then runs a nested `db.prepare(...)._iterateRowsRaw()` query *within the
same in-flight ALTER statement* (i.e. inside the emitter's `run()`), a `not exists`
correlated subquery that references the freshly-added column returns the **wrong**
result: it finds **no orphan rows** even when orphans exist. Worse, running that
nested anti-join **persistently corrupts** the table's anti-join readability — a
*separate* `not exists` query issued after the ALTER completes also returns wrong
results, while plain scans (`select *`) keep returning correct data.

This is an **engine correctness bug** (planner decorrelation / hash-anti-join +
same-statement schema-change visibility), independent of foreign keys. FK
enforcement just happened to be the first caller to hit it.

## Why this matters / current workaround

`alter-add-column-backfill-fk-enforcement` validates existing backfilled rows
against a newly-added column-level FK by calling the shared
`validateForeignKeyOverExistingRows` post-scan. That validator originally used a
`not exists` subquery; against an ALTER-added child column it silently found no
orphans, so violations were admitted. **Workaround shipped:** the validator now uses
a `LEFT JOIN … WHERE <parent col> IS NULL` left-anti-join (logically equivalent under
MATCH SIMPLE) which reads the freshly-added column correctly. See the comment in
`schema/constraint-builder.ts` (`validateForeignKeyOverExistingRows`) and
`docs/runtime.md` (ALTER-TABLE validation section). **Once this engine bug is fixed,
that validator can revert to the simpler `not exists` form** (or keep LEFT JOIN — it
is equivalent and now load-bearing for ADD COLUMN; either way the choice should be
deliberate, not accidental).

## Reproduction (minimal, memory module)

```js
const db = new Database();
await db.exec('pragma foreign_keys = true');
await db.exec('create table p (pid integer primary key)');
await db.exec('insert into p values (1), (2)');
await db.exec('create table c (id integer primary key, name text)');
await db.exec("insert into c values (1, 'x')");
// 99 is an orphan (∉ {1,2}); column added in THIS statement
await db.exec('alter table c add column parent integer default 99 references p(pid)');
// BUG: the ADD COLUMN FK validator's `not exists` scan found no orphan, so the ALTER
//      succeeded (should have thrown FOREIGN KEY constraint failed).

// Even a fresh, separate query is now wrong:
//   select id from c as _c where not exists
//     (select 1 from p as _p where _p.pid = _c.parent)
//   → (no rows)   -- WRONG: row (parent=99) is an orphan and should be returned
// while `select * from c` correctly shows { id:1, name:'x', parent:99 }.
```

## Empirically established facts (from probes during the parent ticket)

- The new column is **physically materialized** (`recreatePrimaryTreeWithNewColumn`
  inserts `[...oldRow, value]`); `select *`, `select c.parent`, `is not null`,
  correlated `EXISTS`, correlated scalar `count(*)`, `IN`, `NOT IN`, and inner `JOIN`
  all read it **correctly**. Only `NOT EXISTS` (anti-join) misreads it.
- The corruption is triggered specifically by running the nested **anti-join** during
  the ALTER. A nested **simple** scan during the ALTER (the literal-default CHECK
  post-scan, `validateBackfillAgainstChecks`) does **not** corrupt later anti-joins.
- It is specific to a column added in the **same statement**: `ADD CONSTRAINT FOREIGN
  KEY` over a pre-existing column (test `41.8`) validates correctly with `not exists`;
  a CREATE-time column (with or without a DEFAULT) is fine; an ALTER-added column
  filled by a later UPDATE (rather than backfill) is fine.
- Both the **literal-default** and **per-row (evaluator) default** backfill paths are
  affected equally (the parent ticket's earlier "verified empirically" note only
  exercised the per-row path with the validator *not* running, so it missed this).
- Query plan for the broken case: `ANTI HASH JOIN on [<childAttr>=<parentAttr>]` with
  unusually low attribute ids — suspicious of an attribute-id / row-layout mismatch in
  the hash-anti-join build/probe when the child's schema changed mid-statement.

## Suspected root cause (to confirm)

The `not exists` → hash-anti-join decorrelation reads the child's freshly-added column
via a cached/stale row layout or attribute mapping captured before the ALTER's schema
change settled, so the probe key extraction pulls the wrong column (the symptom — a
spurious match that drops the orphan — is consistent with the probe reading, e.g.,
`c.id` instead of `c.parent`). Candidate areas: the subquery decorrelation rules
(`planner/rules/subquery/`), the hash-join key/row handling (`runtime/emit/join.ts`),
and the memory base layer's schema-change/`rebuildAllSecondaryIndexes` interaction
with an in-flight statement's emission context (`vtab/memory/layer/`).

## Expected behavior

A `not exists` correlated subquery referencing a column added earlier in the same
ALTER statement (and every subsequent anti-join on that table) must read the column's
actual stored value, matching `select *`, `EXISTS`, and the `LEFT JOIN … IS NULL`
formulation.

## Acceptance

- The reproduction above throws `FOREIGN KEY constraint failed` with the validator on
  `not exists` (i.e. the engine bug is fixed at the source, not only worked around).
- A direct regression test: ADD COLUMN (literal and per-row default) then a standalone
  `not exists`/anti-join over the new column returns the correct orphan set, on memory
  **and** store.
- Decide whether `validateForeignKeyOverExistingRows` reverts to `not exists` or keeps
  the LEFT JOIN; update the comment/docs reference accordingly.
