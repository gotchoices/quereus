description: When `apply schema` creates several new tables, it creates them in the order they were written in the `declare schema` block. Create a table that another new table's foreign key points at before the table that points at it, so a storage module that checks or resolves foreign keys when a table is created sees the parent before the child.
architecture: docs/schema.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts   # generateMigrationPlan: `pushCreates(diff.tablesToCreate, 'table')` (~line 3234) — emits table creates in bucket (= declaration) order
  - packages/quereus/src/parser/ast.ts             # ForeignKeyClause { table, schema? } — on column constraints and table constraints of type 'foreignKey'
  - packages/quereus/test/schema-differ.spec.ts    # generateMigrationPlan / generateMigrationDDL coverage
  - docs/schema.md                                 # § Migration Order, item 3 "Creates third"
----

Filed from the lamina board (lamina ticket `bug-reopen-rename-fails-when-child-declared-before-renamed-parent`).

## Problem

`generateMigrationPlan` emits `diff.tablesToCreate` in declaration order. Nothing in the engine needs a different order: forward FK references between new tables already work, because declarations are order-independent and the memory and store modules accept a child whose parent does not exist yet.

A module that keeps its own durable catalogue does care. After a reopen the engine's catalog is empty, so `apply schema` emits a `create table` for every declared table, and the module has to reconcile each create against what it has stored. Lamina does a declared table rename (a `create table rt2 … with tags ("quereus.previous_name" = 'rt')`) when that table's own create arrives, and the rename rewrites every stored FK that pointed at `rt`. If a child `c references rt2` is declared before `rt2`, its create arrives while the stored FK still points at `rt`, and lamina refuses it as a conflicting re-declaration:

```sql
-- session 1, then close and reopen on the same store
declare schema main {
  table rt { id integer primary key }
  table c { id integer primary key, r integer references rt(id) }
} apply schema main;

-- session 2
declare schema main {
  table c { id integer primary key, r integer references rt2(id) }
  table rt2 { id integer primary key } with tags ("quereus.previous_name" = 'rt')
} apply schema main;
-- lamina: CREATE TABLE 'c': table already declared with a conflicting shape — foreign key '_fk_c_r' refTable differs (declared rt2, persisted rt)
```

With `rt2` declared first, the same apply succeeds. The order of the block should not decide whether an apply succeeds.

## Expected behavior

Within the creates phase (item 3 of § Migration Order), table creates are ordered so that a new table is created before any new table whose foreign key references it:

- **Edges.** A create of `child` depends on a create of `parent` when `child` declares a foreign key (column-level `references`, or a table-level `foreign key … references`) whose target names `parent`. Names compare the way the differ already compares table names (case-insensitive). The target's schema is the FK's explicit `schema` qualifier if written, otherwise the schema being applied; an FK into another schema creates no edge.
- **Ignored references.** A self-reference creates no edge. A reference to a table that is not in `tablesToCreate` (an existing table, a renamed table, another schema) creates no edge.
- **Stable.** Among tables whose dependencies are all satisfied, the earliest declared comes first. A declaration that is already parent-first, or has no FKs between new tables, produces exactly today's order, so existing `diff schema` output does not change for it.
- **Cycles.** Tables in a cycle (`a → b → a`) keep their relative declaration order, and the rest of the order is still respected around them. Forward references inside a cycle keep working as they do today.
- **Maintained tables.** A maintained-table create in the bucket (`create materialized view` sugar) has no FK edges and keeps its position relative to its neighbors. Ordering MV creates after their body's sources is not part of this ticket.

`generateMigrationPlan` is the ordering authority and `generateMigrationDDL` wraps it, so `diff schema` previews the same order `apply schema` runs. Each create step's undo is the `drop … if exists` of what it made, so the undo journal needs no change: the unwind still runs the steps in reverse.

## Tests

One case in `schema-differ.spec.ts`: a child declared before its parent comes out parent-first, and a two-table cycle comes out in declaration order.

## Docs

`docs/schema.md` § Migration Order, item 3: state that table creates are ordered referenced-before-referencing, stable on declaration order, with cycles kept in declaration order.

## Downstream

Lamina will raise its `@quereus/quereus` range to the release containing this change and add the reopen repro above as a regression test.
