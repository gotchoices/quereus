description: When `apply schema` creates several new tables, it creates them in the order they were written in the `declare schema` block. Create a table that another new table's foreign key points at before the table that points at it, so a storage module that checks or resolves foreign keys when a table is created sees the parent before the child.
architecture: docs/schema-declarative.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts   # generateMigrationPlan: `pushCreates(diff.tablesToCreate, 'table')` emits table creates in list order; createdObjectName names a create
  - packages/quereus/src/schema/dependency-order.ts   # orderDependenciesFirst: the stable sort to reuse, and the cycle-order fix
  - packages/quereus/src/parser/ast.ts   # ForeignKeyClause { table, schema? }; CreateTableStmt.maintained; CreateMaterializedViewStmt
  - packages/quereus/test/schema-differ.spec.ts   # new ordering cases
  - packages/quereus/test/apply-schema-alter-order.spec.ts   # `dependency ordering` block: the cycle assertion
  - docs/schema-declarative.md   # Migration Order, item 3 "Creates third"
----

Filed from the lamina board (lamina ticket `bug-reopen-rename-fails-when-child-declared-before-renamed-parent`).

## Problem

`generateMigrationPlan` emits `diff.tablesToCreate` in list order. Nothing in the engine needs a different order: the memory and store modules accept a child whose parent does not exist yet.

A module that keeps its own durable catalogue does care. After a reopen the engine's catalog is empty, so `apply schema` emits a `create table` for every declared table, and the module reconciles each create against what it has stored. Lamina does a declared table rename (a `create table rt2 … with tags ("quereus.previous_name" = 'rt')`) when that table's own create arrives, and the rename rewrites every stored foreign key that pointed at `rt`. If a child `c references rt2` is declared before `rt2`, its create arrives while the stored foreign key still points at `rt`, and lamina refuses it:

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

## Design

Sort the list inside `generateMigrationPlan`, at the `pushCreates(diff.tablesToCreate, 'table')` call. `diff.tablesToCreate` itself keeps its order. `generateMigrationDDL` wraps the plan, so `diff schema` previews the order `apply schema` runs. A create's undo is the `drop … if exists` of what it made and the unwind runs steps in reverse, so the undo journal needs no change.

Add one small function in `schema-differ.ts`, for example `orderTableCreates(creates, schemaName)`, that calls `orderDependenciesFirst` with:

- **Key:** `objectRefKey(<the create's own schema, else schemaName ?? 'main'>, <created name>)`. `createdObjectName(ast, 'table')` gives the name for both create forms. `objectRefKey` lowercases, which gives the case-insensitive comparison the differ uses for names. A create the helper cannot name (only a hand-built diff can have one) keys on its `sql`, as `viewKey` does.
- **A plain table create depends on** the keys of the foreign key parents it names, from column constraints (`columns[].constraints[].foreignKey`) and table constraints (`constraints[].foreignKey`). A parent's key uses the foreign key's `schema` if written, otherwise the child's own schema, which is how `extractForeignKeys` in `schema/manager.ts` resolves it. Only foreign keys count: a CHECK or DEFAULT that names a table makes no edge, so do not reuse `collectColumnDefReads`.
- **A maintained create depends on** the key of every create ahead of it in the list. A maintained create is `createMaterializedView`, or `createTable` with `maintained` set.
- **A foreign key whose parent is a maintained create makes no edge.** Keep only the parents that are plain table creates.

The helper already ignores a dependency on the item itself or on a key no item has, which handles self-references and parents that are existing, renamed or in another schema.

### Why maintained creates have those edges

Without them this ticket breaks a declaration that applies today. The body of a maintained table is planned when its create runs, so its source table has to exist by then. A `table … maintained as` create stays at its written position in the list. The `materialized view` form is always at the end of the list, because `computeSchemaDiff` adds those after every declared table. Given this declaration, which applies today:

```sql
table c { id integer primary key, p integer null references p(id) }
table mt { id integer primary key } maintained as select id from c;
table p { id integer primary key }
```

a sort with no maintained edges gives `mt, p, c`, and `create table mt` then fails with `Table 'c' not found`. That error was observed on the current build by writing `mt` before `c`. With the edges the order is `p, c, mt`. A table written after `mt` may now run before it, which is harmless, because an extra table cannot break a body that already resolves.

Dropping foreign keys that point at a maintained create keeps maintained creates out of every cycle, so "a maintained create runs after everything written before it" always holds. The cost is that a child can be created before a maintained parent, so a module that needs the parent first gets no help in that one case. Ordering materialized view creates by their sources stays with `bug-apply-schema-creates-materialized-views-before-sources`.

### Cycle order: fix the helper

The comment on `orderDependenciesFirst` says items in a cycle keep their relative order, and `docs/schema-declarative.md` says the same. That is not true when a cycle member also waits on something outside the cycle. Run against the current build, `orderDependenciesFirst(['a','b','d'], …)` with dependencies `{ a: ['b','d'], b: ['a'] }` returns `['b','d','a']`.

This ticket requires cycles to keep declaration order, so make the helper do what it says. After computing `acyclic` and before the preferred tiers are added, give each cycle member an edge to the nearest earlier member of its own cycle:

- A member of a cycle is an item that lost an edge in the `acyclic` filter, so only those items need scanning.
- Two members share a cycle when `reaches(edges, i, j) && reaches(edges, j, i)`, checked on the original `edges`.
- These edges cannot close a new cycle. Each one stays inside a group of items that has lost all its internal edges and is now a single chain, and the groups themselves form no cycle.

The same example then returns `['d','a','b']`. This also changes the order of cycles in `pushTableAlters` stage 2 and in `orderDependentsFirst`, only where a cycle member waits on something outside the cycle. No test or doc is known to rely on the old order, but none was run against the change. If an existing alter-order test expects the old order, read it before changing it, because a real dependency may be involved.

## Edge cases & interactions

Verified by the tests below:

- Child written before parent, with a column-level foreign key and with a table-level foreign key: parent first.
- Two-table cycle: declaration order.
- Cycle member that also needs a table outside the cycle: the outside table first, then the cycle in declaration order (the helper assertion).
- `table … maintained as` written between a child and its parent: stays after everything written before it (`p, c, mt` above).
- `references other.p` beside a new `main.p`: no edge, because the keys differ.

Verified by inspection or by the existing suite:

- Already parent-first, or no foreign keys between new tables: the helper returns the list unchanged, so `diff schema` output does not change.
- Self-reference: no edge.
- Parent is an existing table, or the new name of a renamed table: not in the list, so no edge. Renames run before creates.
- Name case differs between the foreign key and the parent's declaration (`references P(id)`, `table p`): same key.
- Applying to a non-main schema: `applyTableDefaults` qualifies the create, and a foreign key with no schema resolves to the same schema. A foreign key that writes the applied schema explicitly gets the same key.
- Hand-built partial diffs with `schemaName` undefined: treated as `main`, as the call to `pushTableAlters` does.
- Backing-module move recreate: its drop runs earlier and its create rides this list as a maintained create.
- Failed apply: the unwind runs the steps that landed in reverse, so children are dropped before parents.
- Seeding runs after the migration loop, so create order does not affect it.
- Lamina's reopen case: the catalog is empty, so every table is a create and there are no rename operations. `rt2` sorts before `c`, and its create performs the rename before `c` arrives. Lamina adds the regression test on its side.

## Tests

Add a small `describe` beside `generateMigrationPlan / generateMigrationDDL parity` in `schema-differ.spec.ts`, using `computeSchemaDiff` with `makeCatalog()` and comparing the created table names from `generateMigrationPlan`:

- Foreign key ordering: `c → p` written child first gives `p, c`, using a table-level foreign key in one of the tables; a two-table cycle `a ↔ b` gives `a, b`; `c references other.p` beside a new `p`, written `c, p`, stays `c, p`.
- Maintained create: the declaration above gives `p, c, mt`. This guards a declaration that applies today.

Extend the existing `keeps a cycle in input order` case in `apply-schema-alter-order.spec.ts` with the helper assertion: `['a','b','d']` with `{ a: ['b','d'], b: ['a'] }` gives `['d','a','b']`.

## Docs

`docs/schema-declarative.md` § Migration Order, item 3: state that table creates are ordered referenced-before-referencing, stable on declaration order, with cycles kept in declaration order; that a maintained create stays after every create written before it; and that a foreign key whose parent is a maintained create does not affect the order.

## Downstream

Lamina will raise its `@quereus/quereus` range to the release containing this change and add the reopen repro above as a regression test.

## TODO

- Add the cycle-member chaining to `orderDependenciesFirst`, and extend the helper test
- Add `orderTableCreates` to `schema-differ.ts` and call it at the `tablesToCreate` push in `generateMigrationPlan`, with a comment saying why maintained creates carry their edges
- Add the two ordering test cases to `schema-differ.spec.ts`
- Update `docs/schema-declarative.md` § Migration Order, item 3
- Run `yarn workspace @quereus/quereus run lint` and `yarn workspace @quereus/quereus test`
