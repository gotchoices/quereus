description: Enforce FK `ON DELETE RESTRICT` / `NO ACTION` for secondary-UNIQUE REPLACE evictions. `processEvictions` fires the FK *actions* but never the RESTRICT pre-check, so an eviction silently orphans RESTRICT/NO-ACTION children where SQLite fails the statement. Fix verified during the fix stage: a single-site savepoint-rollback in `processEvictions` cleanly unwinds the in-`update()` eviction on memory AND isolation-wrapped store.
prereq:
files: packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/test/logic/55.1-eviction-restrict-fk.sqllogic (new), packages/quereus/test/logic/55-internal-eviction-reporting.sqllogic, docs/runtime.md, docs/module-authoring.md
----

## Summary

A secondary-UNIQUE REPLACE eviction (a new/updated row collides on a *non-PK* UNIQUE
with an existing row at a *different* PK) deletes the evicted parent row but never runs
the FK `RESTRICT` / `NO ACTION` pre-check. The evicted row's RESTRICT children are left
orphaned; SQLite fails the statement instead. The FK default `onDelete` is `'restrict'`
(`schema/table.ts`), so this affects **every** FK without an explicit
`ON DELETE CASCADE`/`SET NULL`/`SET DEFAULT`.

`executeForeignKeyActions` handles only the *actions* (`CASCADE`/`SET NULL`/`SET DEFAULT`)
and explicitly skips `restrict` (`foreign-key-actions.ts:59`). RESTRICT/NO-ACTION lives in
the separate pre-checks (`assertNoRestrictedChildrenForParentMutation` /
`assertTransitiveRestrictsForParentMutation`) that `processDeleteRow` /
`processUpdateRow` call *before* `vtab.update()`. `processEvictions`
(`dml-executor.ts:578`) calls neither.

## Reproduction (confirmed failing on `main` at this branch)

```sql
pragma foreign_keys = true;
create table p (id integer primary key, email text not null, unique (email));
create table c (cid integer primary key, pid integer not null,
                foreign key (pid) references p(id) on delete restrict);
insert into p values (1, 'a@x');
insert into c values (10, 1);
insert or replace into p values (2, 'a@x');   -- evicts p(id=1)
-- ACTUAL:   no error; p=[{id:2}], c=[{cid:10,pid:1}]  ← orphaned child
-- EXPECTED: constraint failed; data unchanged
```

## Fix — verified approach (savepoint-rollback, single site)

The ticket's open question — *does the statement savepoint actually unwind the
in-`update()` eviction on all substrates?* — was answered **yes** during the fix stage by
prototyping and running the test below under both `yarn test` (memory) and
`yarn test:store` (isolation-wrapped LevelDB). Both passed, including the positive
CASCADE guard.

The substrate deletes-then-reports, so there is no pre-mutation hook. Instead, run the
RESTRICT scan **post-eviction** inside `processEvictions`: the parent row is already gone
but the child rows the scan keys off remain, so `select 1 from child where fk = ?` still
answers correctly. On a violation it throws a `QuereusError`/`ConstraintError`;
`runWithStatementSavepoints` rolls back the statement-scope savepoint
(`__stmt_atomic_N`, created before the row loop) which unwinds **both** the substrate's
eviction and the writing row. (Evictions only occur under REPLACE resolution, which is
never `OR FAIL`, so the non-FAIL statement-savepoint branch always applies — confirmed.)

Use the **transitive** walk (`assertTransitiveRestrictsForParentMutation`), matching what
`processDeleteRow` already calls for a plain delete, so transitive RESTRICTs through
cascading children are covered too.

### Exact change (already prototyped & verified)

In `dml-executor.ts`, `processEvictions`, at the top of the `for (const evicted of evictedRows)`
loop, **before** `ctx.db._recordDelete(...)`:

```typescript
// RESTRICT / NO ACTION enforcement for the eviction's would-be delete.
// The substrate already physically removed the evicted row inside
// vtab.update(), so there is no pre-mutation point. Run the RESTRICT scan
// post-eviction (the child rows it keys off remain) and, on a violation,
// throw — runWithStatementSavepoints rolls back the statement savepoint,
// unwinding both the eviction and the writing row.
await assertTransitiveRestrictsForParentMutation(ctx.db, tableSchema, 'delete', evicted);
```

`assertTransitiveRestrictsForParentMutation` is already imported at
`dml-executor.ts:17`. No other import changes needed.

The error surfaced is `FOREIGN KEY constraint failed: DELETE on '<parent>' violates
RESTRICT from '<child>'` (from `assertNoRestrictedChildrenForParentMutation`) — **not**
the plan-time `CHECK constraint failed: _fk_...` form, because the plan-time parent-side
FK check is absent for internal evictions. Tests should match the substring
`constraint failed`.

## Scope / caveat

Memory, direct store, and isolation-wrapped store are all key-based and verified working.
Rowid-chained backends (lamina) are **out of scope** here: the transitive recursion reads
children at call time and, post-eviction, the parent value is gone — for a rowid-chained
backend the deeper cascade recursion may not resolve. This mirrors the existing documented
SET-DEFAULT recursion gap (`foreign-key-actions.ts:201-208`) and is no regression beyond
status quo. Note it in the docs rather than trying to solve it here.

## TODO

- Apply the one-line `assertTransitiveRestrictsForParentMutation('delete', evicted)` call
  in `processEvictions` (see exact change above).
- Add the regression test `packages/quereus/test/logic/55.1-eviction-restrict-fk.sqllogic`
  with the content below (INSERT-OR-REPLACE RESTRICT, default NO-ACTION, UPDATE-REPLACE-
  default move, plus a positive CASCADE guard). It is written to run under both memory and
  store harnesses.
- Run `yarn test` (memory) and `yarn test:store` (isolation-wrapped store) — both must be
  green. Run `yarn lint` in `packages/quereus`.
- Update the two known-limitation notes to state RESTRICT/NO-ACTION is now enforced for
  evictions (note it via post-eviction scan + statement-savepoint rollback, key-based
  substrates; mention the rowid-chained caveat):
  - `docs/runtime.md:911-917`
  - `docs/module-authoring.md:581`
  - (`docs/materialized-views.md` reviewed — no RESTRICT/eviction note there; skip unless
    a relevant note is added later.)
- Optionally fold a RESTRICT positive/negative case into the covered-MV section of
  `55-internal-eviction-reporting.sqllogic`, or leave that file as-is (it covers actions).

### Test file content (`test/logic/55.1-eviction-restrict-fk.sqllogic`)

```
-- 55.1-eviction-restrict-fk.sqllogic — a secondary-UNIQUE REPLACE eviction must enforce
-- FK ON DELETE RESTRICT / NO ACTION, matching how a plain DELETE of the same parent row
-- fails. Companion to 55-internal-eviction-reporting (which covers the CASCADE/SET NULL
-- ACTIONS); this file covers the RESTRICT/NO ACTION PRE-CHECK that processEvictions
-- previously skipped.

PRAGMA foreign_keys = true;

-- ===================================
-- 1. INSERT-OR-REPLACE eviction of a RESTRICT parent must fail and leave data unchanged.
-- ===================================

create table p (id integer primary key, email text not null, unique (email));
create table c (cid integer primary key, pid integer not null,
                foreign key (pid) references p(id) on delete restrict);
insert into p values (1, 'a@x');
insert into c values (10, 1);

-- evicts p(id=1) via the UNIQUE(email) conflict at a different PK -> RESTRICT child blocks it
insert or replace into p values (2, 'a@x');
-- error: constraint failed

-- data unchanged: parent still id=1, child still references it
select id, email from p order by id;
→ [{"id":1,"email":"a@x"}]
select cid, pid from c order by cid;
→ [{"cid":10,"pid":1}]

-- ===================================
-- 2. Default ON DELETE (NO ACTION -> RESTRICT) child blocks the eviction too.
-- ===================================

create table p2 (id integer primary key, email text not null, unique (email));
create table c2 (cid integer primary key, pid integer not null,
                 foreign key (pid) references p2(id));
insert into p2 values (1, 'b@x');
insert into c2 values (10, 1);

insert or replace into p2 values (2, 'b@x');
-- error: constraint failed

select id, email from p2 order by id;
→ [{"id":1,"email":"b@x"}]
select cid, pid from c2 order by cid;
→ [{"cid":10,"pid":1}]

-- ===================================
-- 3. UPDATE-with-REPLACE-default move onto an occupied secondary-UNIQUE evicts a RESTRICT
--    parent — must also fail.
-- ===================================

create table p3 (id integer primary key, email text not null, unique (email) on conflict replace);
create table c3 (cid integer primary key, pid integer not null,
                 foreign key (pid) references p3(id) on delete restrict);
insert into p3 values (1, 'm@x'), (2, 'n@x');
insert into c3 values (20, 2);

-- moving id=1 onto email='n@x' would evict id=2, whose RESTRICT child blocks it
update p3 set email = 'n@x' where id = 1;
-- error: constraint failed

select id, email from p3 order by id;
→ [{"id":1,"email":"m@x"},{"id":2,"email":"n@x"}]
select cid, pid from c3 order by cid;
→ [{"cid":20,"pid":2}]

-- ===================================
-- 4. POSITIVE: eviction of a row whose children CASCADE still succeeds (guard vs over-blocking).
-- ===================================

create table p4 (id integer primary key, email text not null, unique (email));
create table c4 (cid integer primary key, pid integer not null,
                 foreign key (pid) references p4(id) on delete cascade);
insert into p4 values (1, 'q@x');
insert into c4 values (30, 1);

insert or replace into p4 values (2, 'q@x');
select id, email from p4 order by id;
→ [{"id":2,"email":"q@x"}]
select cid, pid from c4 order by cid;
→ []
```
