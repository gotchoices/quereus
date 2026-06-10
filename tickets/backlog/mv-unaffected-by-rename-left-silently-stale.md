description: A source rename that does not change a dependent MV's AST leaves the MV silently stale — writes stop propagating and reads serve the behind backing with no diagnostic — even when the MV is provably unaffected (body doesn't reference the renamed column; or only a constraint on another source table was rewritten).
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # propagate{Table,Column}RenameToMaterializedViews, applyMaterializedViewRewrite, renameShiftedBackingColumns, deriveBackingShape, describeBackingShapeMismatch
  - packages/quereus/src/runtime/emit/alter-table.ts                 # preStaleMvs snapshot; table loop fires table_modified for CHECK/FK/index-predicate rewrites BEFORE the MV loop
  - packages/quereus/src/core/database-materialized-views.ts         # subscribeToSchemaChanges — marks every MV with the table in sourceTables stale on any table_modified
----

# Rename leaves provably-unaffected dependent MVs silently stale

`mv-body-not-rewritten-on-source-rename` (complete) made a source rename rewrite a
dependent MV in place when the rename **changed its AST** (or, for table rename, when
`sourceTables` carries the old base). MVs whose AST did *not* change stay on the
pre-existing stale→REFRESH path — settled there because `sourceTables` is table-keyed
and a `select *` body genuinely changes exposure without an AST change.

But that bucket also contains MVs the rename **provably does not affect**, and for
those the outcome is the worst of the staleness semantics: the MV is stale-but-valid,
so a read serves the (now unmaintained) backing **silently** — no diagnostic, and
subsequent source writes simply never appear in the MV until a manual REFRESH.

## Reproductions (verified on the live engine, 2026-06-10)

Unreferenced column rename:

```sql
create table t (id integer primary key, v integer not null, u integer not null);
insert into t values (1, 10, 100);
create materialized view mv as select id, u from t;   -- never references v
alter table t rename column v to w;
insert into t values (2, 20, 200);
select id, u from mv;   -- [{id:1,u:100}] — row 2 silently missing; mv.stale = true
```

Constraint-only rewrite of another source (table rename two hops away):

```sql
create table t (id integer primary key);
create table u (id integer primary key, tid integer references t (id));
create materialized view mvu as select id, tid from u;
alter table t rename to t2;     -- u's FK referencedTable rewritten → table_modified(u)
insert into u values (2, 1);    -- mvu marked stale by the notify; write not maintained
select id from mvu;             -- silently behind
```

Both behaviors predate the rename-propagation work (the staleness listener marks every
MV whose `sourceTables` contains the modified table), but the propagation machinery now
in place makes them fixable.

## Expected behavior

After a rename statement completes, a dependent MV whose body's planned output is
unchanged (same backing shape, same names) should be live: row-time maintenance
re-registered, statement-local staleness restored — exactly as the changed-AST path
already does. Sketch: for an unchanged-AST MV marked statement-locally stale (present
in the rename's pre-statement snapshot machinery), re-derive the backing shape from the
(unchanged) body against the renamed catalog; if it matches the live backing
(`backingShapeMatches`), restore via the existing `applyMaterializedViewRewrite` tail.
A pure name shift (the `select *` case — exposure follows the rename) could even take
the existing `renameShiftedBackingColumns` path; a structural mismatch stays stale.

The constraint-only case may be better fixed one layer down: the staleness listener
could distinguish a `table_modified` that changes only constraint metadata
(CHECK/FK/index-predicate rewrite) from one that changes columns/PK — the former cannot
invalidate an MV body. That would also stop these events detaching row-time plans
needlessly outside renames (e.g. declarative migrations that only retarget FKs).

## Notes

- A pre-existing (pre-statement) stale flag must still never be cleared — same
  discipline as the rename propagation (backing may be behind; only REFRESH clears).
- Re-deriving shapes for every unchanged dependent MV adds planning cost to ALTER …
  RENAME proportional to dependent-MV count; acceptable for DDL, but worth gating on
  "was marked stale by this statement" so unaffected statements pay nothing.
