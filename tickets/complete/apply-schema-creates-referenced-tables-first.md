description: When `apply schema` creates several new tables, a table that another new table's foreign key points at is now created first, whatever order the `declare schema` block wrote them in. A storage module that checks or resolves foreign keys at create time therefore sees the parent before the child.
architecture: docs/schema-declarative.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts   # orderTableCreates and helpers, called at the tablesToCreate push in generateMigrationPlan
  - packages/quereus/src/schema/dependency-order.ts   # cycleMembersInInputOrder: cycles keep input order, below preferred dependencies
  - packages/quereus/test/schema-differ.spec.ts   # `generateMigrationPlan: table create order`
  - packages/quereus/test/apply-schema-alter-order.spec.ts   # `dependency ordering` block
  - docs/schema-declarative.md   # Migration Order, item 3 and the stage sort paragraph
----

Filed from the lamina board (lamina ticket `bug-reopen-rename-fails-when-child-declared-before-renamed-parent`). After a reopen every declared table is a create, and lamina performs a declared rename when the renamed table's own create arrives. A child written before its renamed parent therefore arrived while the stored foreign key still named the old parent, and lamina refused it.

## What landed

`generateMigrationPlan` sorts `diff.tablesToCreate` with `orderTableCreates`. `diff.tablesToCreate` keeps its own order, and `diff schema` previews the sorted order because `generateMigrationDDL` wraps the plan.

- A table create runs after the tables its column-level and table-level foreign keys name. Keys are `schema.name`, lowercased, so a parent in another schema gives no edge and name case does not matter.
- A maintained create (`materialized view`, or `table … maintained as`) stays after every create written before it, because it plans its body as it runs. It also follows its own plain foreign key parents.
- A foreign key whose parent is a maintained create gives no edge, so no maintained create is ever in a cycle. A module that needs a maintained parent first gets no help in that one case.
- Tables in a cycle keep declaration order.

`orderDependenciesFirst` now keeps a cycle in input order when a member also waits on something outside the cycle: `['a','b','d']` with `{ a: ['b','d'], b: ['a'] }` returns `['d','a','b']`, where it used to return `['b','d','a']`. A preferred dependency outranks that order (see the first finding below).

Lamina adds its regression test after raising its `@quereus/quereus` range. The lamina failure was not reproduced here, because lamina is not in this repository. The implement stage checked the plan for lamina's declaration on an empty catalog: `rt2` then `c`.

## Review findings

**Fixed in this pass**

- **Regression in `pushTableAlters` stage 2.** The implement stage added cycle-order edges before the preferred dependencies, so those edges could block a preferred dependency that a view needs. Over applied `t0` and `t1`, this declaration failed with `Column not found: b` on `create view v`, and writing `t1` first applied. The prior helper's order for the same graph, run from the previous revision of the file, is the working one (`b, v, a` in the helper test's names).

  ```sql
  table t0 { id integer primary key, a integer default (select count(*) from v), c integer null references t1(id) }
  table t1 { id integer primary key, b integer null references t0(id) }
  view v as select b from t1;
  ```

  Cycle order is now added last, through `addEdgesThatCloseNoCycle`, so it gives way to a preferred dependency. `orderTableCreates` passes no preferred tiers, so its cycles still always keep declaration order. Both written orders of this declaration now apply and re-diff empty. Added the helper test `a preferred dependency outranks a cycle's input order`. The docs' stage sort paragraph and the helper's comment state the exception.
- **A test assertion that could not fail.** In `a maintained child follows its parent; a maintained parent does not affect the order`, the second declaration gave the same order with or without the rule, because a cycle keeps its input order anyway. Replaced it with `s, d, mt, c` giving `s, c, d, mt`. With the plain-parent filter removed, the new assertion fails with `s, d, mt, c`.

**Tripwires parked**

- A plain table can move ahead of a table its CHECK or DEFAULT reads. On the memory module this applies and re-diffs empty, because create does not plan those expressions. Parked as a `NOTE:` on `orderTableCreates`.

**Checked, nothing to change**

- Helper correctness: every member of a multi-item cycle loses an edge in the `acyclic` filter, so the scan finds all members, and the chain edges stay inside a cycle. The ordering loop therefore cannot run out of placeable items.
- Preferred edges inside a cycle: they cannot occur today, because preferred edges run only from a view to a table and a hard cycle holds only tables or only views. The regression above came through an item outside the cycle.
- Keys: `foreignKeyParents` resolves a parent's schema the way `extractForeignKeys` does, with the written schema or else the child's own. `createsAheadOfMaintained` cannot give a create an edge to itself, because it stores the list before adding the create's own key.
- Rollback and seeding: undo runs the landed steps in reverse, and seeding follows the migration loop. No other source file reads `tablesToCreate` for order; only `schema-differ.ts` and specs use the field.
- Performance: `orderDependenciesFirst` timed in one run on a 2000-item ring, 460 ms now against 199 ms before, and on 1000 two-item cycles, 89 ms against 20 ms. These plans are far larger than any seen in the tests, and the existing `NOTE:` comments cover the quadratic walks, so no change.
- Docs: `docs/schema-declarative.md` Migration Order is updated. `docs/sql-ddl.md` line 195 only points to it and stays accurate. A search of `docs/` for other statements about create order found none.
- Source size: `schema-differ.ts` is 4102 lines by `wc -l`, measured before this pass's comment. `debt-oversized-source-files` already tracks this file, so no new ticket.
- Other categories (type safety, resource cleanup, error handling): the new code is synchronous and pure over typed ASTs, and it holds no resources and throws nothing, so no findings.

**Known gap, tracked elsewhere**

- A maintained create written ahead of its source still fails, as it did before this ticket. `bug-apply-schema-creates-materialized-views-before-sources` covers that and already says to replace the "everything written ahead" edges with the tables the body reads.

## Validation

- `yarn workspace @quereus/quereus run lint` reported no errors, and `yarn workspace @quereus/quereus test` gave 11017 passing, 26 pending. Both ran after the fixes above. Only a comment in `schema-differ.ts` changed after those runs.
- `yarn test:store` and the other workspaces' tests were not run. The store module accepts a child ahead of its parent, so it does not exercise this ordering.
