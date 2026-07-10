---
description: When you create a partial index, the engine ignores any table name you write in front of a column in its WHERE clause — so a clause that names some other table is quietly treated as if it named the indexed table, instead of being rejected as nonsense.
prereq:
files:
  - packages/quereus/src/vtab/memory/utils/predicate.ts        # compilePredicate — binds by bare name, ignores `table`
  - packages/quereus/src/vtab/memory/index.ts                  # MemoryIndex constructor calls compilePredicate
  - packages/quereus/src/vtab/memory/layer/manager.ts          # UNIQUE-constraint predicate compile sites
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts  # MV WHERE compile site
  - packages/quereus-store/src/common/store-module.ts          # store index/UNIQUE predicate compile sites
  - packages/quereus-store/src/common/store-table.ts           # store index/UNIQUE predicate compile sites
  - packages/quereus/src/runtime/emit/alter-table.ts           # predicateReferencesColumn works around this today
  - docs/schema.md                                             # § index body diffing, "cross-table reference" paragraph
difficulty: medium
---

# `CREATE INDEX ... WHERE <other-table>.<col>` is silently accepted

## What happens

```sql
create table t (id integer primary key, name text, active integer);
create index ix on t (name) where zzz.active = 1;   -- accepted!
insert into t values (1, 'a', 1);
```

There is no table named `zzz`. The index is created anyway, and it behaves exactly as
if the predicate read `where active = 1` — the qualifier is dropped on the floor.

The predicate compiler (`compilePredicate` in
`packages/quereus/src/vtab/memory/utils/predicate.ts`) resolves a column reference by
looking its bare name up in the indexed table's column list. It explicitly rejects a
*schema*-qualified reference (`main.active`) and rejects subqueries, but it never looks
at the `table` field of a column reference at all. So any table qualifier — the right
one, the wrong one, one naming a table that does not exist — compiles to the same thing.

## Why it matters

Two ways this bites, beyond the obvious "the engine accepted a statement it should have
rejected":

**The stored predicate is a lie the rest of the system reads.** Other passes *do* honour
the qualifier, so they disagree with the compiler about what the predicate means:

- `ALTER TABLE t RENAME COLUMN active TO is_active` leaves `zzz.active` untouched (the
  rename rewriter correctly declines to rewrite a reference qualified by a different
  table), and then the memory module's index rebuild compiles the stale predicate against
  the new column list and fails with `Partial-index predicate references unknown column
  'active'`. The `ALTER` aborts and rolls back cleanly, but a rename that should have
  worked now cannot be performed at all without dropping the index first.
- `docs/schema.md`'s declarative-differ section reasons about which table names may appear
  in an index body. It previously asserted such a reference was unreachable; that claim has
  been corrected to describe the actual behaviour, and should be tightened again once this
  is fixed.

**Guards downstream have to over-approximate.** `runDropColumn`'s check for "is this column
named by a partial index's WHERE clause" (`predicateReferencesColumn` in
`packages/quereus/src/runtime/emit/alter-table.ts`) deliberately ignores the qualifier so
that it matches the compiler's own binding rule. That is correct today, but it is a
workaround: it would wrongly reject a legal `DROP COLUMN` the day predicates gain real
multi-table scope. Fixing the compiler lets that guard become qualifier-aware.

## Expected behaviour

Creating a partial index (or a partial UNIQUE constraint, or a materialized view whose
`WHERE` is compiled by the same function) whose predicate carries a table qualifier should:

- succeed when the qualifier names the indexed table itself, case-insensitively
  (`where t.active = 1` on table `t`) — this already works and must keep working; and
- fail at create time with a clear message when the qualifier names anything else, in the
  same spirit as the existing schema-qualified rejection.

Two SQL statements that read differently should never compile to the same index.

## Scope notes for whoever picks this up

`compilePredicate` currently takes only `(expr, columns)` — it has no idea what table it is
compiling for. Making it qualifier-aware means threading the owning table's name through,
and it is a **public export** (`packages/quereus/src/index.ts`) with call sites in three
places in `packages/quereus` and three in `packages/quereus-store`. The materialized-view
call site compiles a view body's `WHERE` against a *source* table's columns, so the name it
should validate against is not obviously the view's own name — worth confirming what a
qualified reference means there before picking a signature.

Existing coverage to extend: `packages/quereus/test/partial-index-column-rename.spec.ts`
has a test named `rejects DROP COLUMN when the predicate names the column through a foreign
qualifier`, which constructs exactly this index. Once creation is rejected, that test's
setup becomes invalid and should be reshaped into a create-time rejection assertion.
