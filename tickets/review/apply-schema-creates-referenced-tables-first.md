description: When `apply schema` creates several new tables, a table that another new table's foreign key points at is now created first, whatever order the `declare schema` block wrote them in. A storage module that checks or resolves foreign keys at create time therefore sees the parent before the child.
architecture: docs/schema-declarative.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts   # orderTableCreates and helpers, called at the tablesToCreate push in generateMigrationPlan
  - packages/quereus/src/schema/dependency-order.ts   # chainCycleMembersInInputOrder: cycles now really keep input order
  - packages/quereus/test/schema-differ.spec.ts   # `generateMigrationPlan: table create order`
  - packages/quereus/test/apply-schema-alter-order.spec.ts   # `keeps a cycle in input order`, one added assertion
  - docs/schema-declarative.md   # Migration Order, item 3
----

Filed from the lamina board (lamina ticket `bug-reopen-rename-fails-when-child-declared-before-renamed-parent`). After a reopen every declared table is a create, and lamina performs a declared rename when the renamed table's own create arrives. A child written before its renamed parent therefore arrived while the stored foreign key still named the old parent, and lamina refused it.

## What changed

`generateMigrationPlan` now sorts `diff.tablesToCreate` with `orderTableCreates`. `diff.tablesToCreate` itself keeps its order, and `diff schema` previews the sorted order because `generateMigrationDDL` wraps the plan.

- A table create runs after the tables its foreign keys name, column-level and table-level. Keys are `schema.name`, lowercased, so a parent in another schema gives no edge and name case does not matter.
- A maintained create (`materialized view`, or `table … maintained as`) stays after every create written before it, because it plans its body as it runs.
- A foreign key whose parent is a maintained create gives no edge, so no maintained create is ever in a cycle.
- Tables in a cycle keep declaration order.

`orderDependenciesFirst` did not actually keep a cycle in input order when a member also waited on something outside the cycle: `['a','b','d']` with `{ a: ['b','d'], b: ['a'] }` returned `['b','d','a']`. It now gives each cycle member an edge to the previous member of its own cycle, and returns `['d','a','b']`. This also affects `pushTableAlters` stage 2 and `orderDependentsFirst`, only in that same situation. No existing test relied on the old order.

## Differences from the plan

- **A maintained create also follows its own plain foreign key parents.** The ticket gave maintained creates only the "everything written ahead" edges, which would leave `table mt { … references p(id) } maintained as …` written before `p` running ahead of `p`. That is the same problem this ticket fixes. Adding the edges cannot close a cycle, because nothing plain depends on a maintained create.
- **A maintained create names only the creates back to and including the previous maintained create,** not every create ahead. The resulting order is the same, because each maintained create follows the previous one. Naming every create took 41 s to plan 500 creates that were all maintained (0.46 s for 200), measured with `generateMigrationPlan` on a hand-built diff. With this form the same 500 took 12 ms.
- **`createdTableTarget` is used instead of `createdObjectName`,** because the key needs the create's schema as well as its name.

## Tests added

In `schema-differ.spec.ts`, `generateMigrationPlan: table create order`:

- `a foreign key parent goes first; a cycle and another schema's parent keep declaration order`: column-level and table-level foreign keys written child first give `p, c`; a two-table cycle gives `a, b`; `references other.p` beside a new `p` stays `c, p`.
- `a maintained create stays after every create written before it`: `c, mt, p` gives `p, c, mt`. This guards a declaration that applies today.
- `a maintained child follows its parent; a maintained parent does not affect the order`: pins the first difference above and the no-edge rule.

In `apply-schema-alter-order.spec.ts`, `keeps a cycle in input order` gains the `['d','a','b']` assertion above.

## Validation

- `yarn workspace @quereus/quereus run lint` passes on the final code.
- `yarn workspace @quereus/quereus test` passes: 11015 passing, 26 pending. That run came before the third ordering test was added, and only that test changed afterwards. The two touched spec files were then rerun on their own: 113 passing.
- `yarn test:store` was not run. The store module does not reject a child ahead of its parent, so it would not exercise the fix.
- With a throwaway spec, since deleted, these applied on the memory module and re-diffed empty: the `c, mt, p` declaration, `c, p` plus a `materialized view` over `c`, a maintained child with a foreign key, and a plain child of a maintained parent.

## Known gaps

- **The lamina failure itself was not reproduced here.** Lamina is not in this repository. What was checked is the plan for its declaration on an empty catalog: `create table rt2 …` then `create table c …`. Lamina adds the regression test on its side after raising its `@quereus/quereus` range.
- A child can still be created before a maintained parent, so a module that needs the parent first gets no help in that one case. This is stated in the `orderTableCreates` comment and the docs.
- A maintained create written ahead of its source still fails, as it does today. `bug-apply-schema-creates-materialized-views-before-sources` covers that and should replace the "everything written ahead" edges with the tables the body reads.
