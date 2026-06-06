description: `ALTER TABLE … ADD COLUMN <col> … UNIQUE` (an inline column-level UNIQUE on the new column) is silently dropped — the constraint is neither enforced nor rejected, so duplicate values insert with no error. Discovered while reviewing alter-table-add-tag-validation (the reserved-tag validation fires correctly; this is an orthogonal, pre-existing persistence gap on the same ADD COLUMN arm).
files:
  - packages/quereus/src/runtime/emit/alter-table.ts            # ADD COLUMN runtime: extracts column-level CHECK + FK, NOT UNIQUE (see ~line 286)
  - packages/quereus/src/schema/manager.ts                      # extractUniqueConstraints (CREATE-path only; ~line 1203) — not reached by ADD COLUMN
  - packages/quereus/src/planner/building/alter-table.ts        # plan-build addColumn arm (builds backfill/checks; no unique handling)
  - packages/quereus/src/vtab/memory/layer/manager.ts           # addConstraint(UNIQUE) builds/reuses the implicit covering index (the materialization the ADD CONSTRAINT path already uses)
----

# Bug: inline UNIQUE on ALTER TABLE ADD COLUMN is silently dropped

## Symptom

```sql
create table T (id integer primary key);
alter table T add column u int unique;   -- accepted, NO error
insert into T values (1, 5);             -- ok
insert into T values (2, 5);             -- ok (!!) — duplicate u=5 accepted
select * from unique_constraint_info('T'); -- [] — the UNIQUE constraint does not exist
```

The inline `unique` on the added column is **silently discarded**: it is not
materialized (no implicit covering structure, not surfaced by
`unique_constraint_info`), not enforced (duplicates insert cleanly), and not
rejected (no "unsupported" error to tell the author it was ignored). The author
reasonably believes they declared a uniqueness invariant; the engine carries
none. This is a silent data-integrity loss.

## Root cause

The runtime ADD COLUMN path (`runtime/emit/alter-table.ts`, ~line 286) extracts
only the new column's **CHECK** (`extractColumnLevelCheckConstraints`) and
**FOREIGN KEY** (`extractColumnLevelForeignKeys`) constraints to thread into the
enhanced schema. It does **not** extract column-level UNIQUE. The adjacent
comment —

```
// Extract column-level CHECK / FK constraints. Column-level UNIQUE is not enforced via
// table-level constraints; the existing rejection path in the manager handles it.
```

— is **stale/incorrect for this path**: `manager.extractUniqueConstraints`
(~line 1203) is the CREATE-time *schema-build* path (`buildTableSchemaFromAST`),
which is never reached by the imperative ADD COLUMN runtime. No rejection fires,
and no enforcement is wired, so the constraint vanishes.

Note the asymmetry: CREATE TABLE with an inline column UNIQUE *does* materialize
+ enforce it (via `extractUniqueConstraints`), and `ALTER TABLE … ADD CONSTRAINT
… UNIQUE` *does* materialize + enforce it (the memory module's `addConstraint`
builds/reuses the implicit covering index — see complete ticket
`10.25-module-add-constraint-unique-fk`). Only the **ADD COLUMN inline UNIQUE**
sub-path falls through.

## Expected behavior (design question for the fix/implement stage)

Two defensible resolutions — pick one (or split CHECK-style "reject now,
materialize later"):

1. **Materialize + enforce** (preferred, symmetric with every other authoring
   surface): on ADD COLUMN with an inline UNIQUE, build the column then apply the
   equivalent of `ADD CONSTRAINT … UNIQUE (newcol)` — re-validating the
   just-backfilled rows and failing atomically (`CONSTRAINT`) on a duplicate,
   reusing the memory module's `addConstraint` UNIQUE path. Must also persist for
   the store module (mirror `quereus-store` ADD CONSTRAINT UNIQUE).
2. **Reject loudly** (minimum viable, no silent loss): if materialization is out
   of scope for a module, throw `UNSUPPORTED`/`CONSTRAINT` at plan-build or
   runtime so the author knows the constraint was not applied — never silently
   drop it.

Whichever is chosen, fix or remove the stale comment at
`runtime/emit/alter-table.ts:286-287`.

## Verification gap to close

`test/logic/50-metadata-tags.sqllogic` Phase 24 currently asserts that an ADD
COLUMN inline UNIQUE's *tag* validation is accepted (no over-rejection) but
deliberately does **not** assert the constraint round-trips, precisely because of
this drop. Once fixed, add a logic test that an ADD COLUMN inline UNIQUE (a)
rejects a duplicate insert and (b) surfaces via `unique_constraint_info`
(memory), and the store-mode equivalent.

## Scope note

Out of scope for the tag-validation ticket that surfaced this — that change is
pure plan-build validation and is correct as-is. This ticket is about ADD COLUMN
constraint *persistence/enforcement*, a separate subsystem.
