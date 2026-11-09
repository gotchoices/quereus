description: A schema declaration that adds a new materialized view reading a column added or renamed in the same apply, a new plain view, or another new object written after it, could never be applied, because the migration created the materialized view too early. New materialized views are now created where plain view creates already run, after the column renames and additions they may read.
architecture: docs/schema-declarative.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts   # generateMigrationPlan (create block split), orderTableCreates, createStageTwoItems, plannedBodyOf, freshTableCreate, bodyReach
  - packages/quereus/src/schema/dependency-order.ts   # NOTE wording
  - packages/quereus/test/apply-schema-alter-order.spec.ts
  - packages/quereus/test/schema-differ.spec.ts
  - packages/quereus/test/schema/differ-undo-plan.spec.ts
  - docs/schema-declarative.md
  - docs/schema-rename-detection.md
  - docs/materialized-views.md
----

# New maintained creates run in stage 2 of the table alters

## What landed

`ticket(implement): bug-apply-schema-creates-materialized-views-before-sources`.

`generateMigrationPlan` splits `diff.tablesToCreate`. Plain table creates stay in the create block, ordered by `orderTableCreates` on foreign key parents only. A new maintained table (`create materialized view …`, `create table … maintained as …`, or the recreate of a backing-module move) now goes into stage 2 of `pushTableAlters`, beside the new views. `createStageTwoItems` gives each create a hard edge to the new views and maintained tables its body reaches (`MigrationCreate.viewReach`, now also set on maintained creates) and soft preferences for the tables its body names and then every altered table. So a maintained create now runs after `RENAME COLUMN`, after the `ADD COLUMN` / `ALTER COLUMN` steps (unless an added column reads it), after the new views it reads, and a plain view reading a new maintained table follows it.

## Review findings

**Diff read first, then the handoff.** Checked every changed line in `schema-differ.ts`, `dependency-order.ts`, the three spec files and the three docs.

**Correctness — checked, nothing wrong found.**
- Keys: stage-2 keys (`createdObjectTarget(...).name`, `alterKey`, `objectsNamedIn`) are all lowercased unqualified names in one schema, so the sort's edges line up. `orderTableCreates` keeps `objectRefKey` keys for both sides; a foreign key parent outside its input yields no edge because `orderDependenciesFirst` ignores unknown keys.
- Undo: a maintained create still undoes as `DROP TABLE IF EXISTS` (`kind: 'table'`); a view over it is created after it, so the journal drops the view first.
- Reach through maintained tables: `bodyReach` follows view bodies only. Planning a read of a maintained table does not plan its body, so this is correct; the direct edge to a new maintained table still comes from its name in the body.
- `set maintained as` attaches still run after stage 2, so an attach whose body reads a new maintained table sees it.
- `maintainedModuleMigrations` is only read as a destructive-apply gate (`runtime/emit/schema-declarative.ts`), so moving the recreate does not affect it.

**Interactions checked ad hoc (scratch specs, deleted afterwards; not added as tests):**
- On the **store** module (isolated LevelDB, as `test:store` sets it up) — the implementer had checked memory only: a new materialized view reading a column added with a DEFAULT (`[{"id":1,"d":7}]`), reading a renamed column, reading a new view, a backwards chain `m2 → m1 → t` with a plain view over `m2`, and a plain table with a foreign key to a new materialized view (applied, then an insert with `foreign_keys = true` succeeded). All applied and re-diffed empty. This confirms the Migration Order item 3 claim about the store.
- A **backing-module move** (`materialized view m using memory(x = 1)`) combined with an added column on its source and a new view over it: plan is `DROP TABLE m`, `ADD COLUMN d`, `create materialized view m …`, `create view w …`; applies, re-diff empty. Before this change the recreate ran ahead of `ADD COLUMN` and would have failed.

**Minor — fixed inline.** The comment above the `set maintained as` loop in `generateMigrationPlan` said attaches run "where MV creates ran", which is no longer true; it now says they run after every create, alter, and new view or maintained create.

**Major — none.** No finding needed a ticket.

**Tripwires — none new.** The existing `NOTE:` in `createStageTwoItems` (a table reached only through an existing view sits in the weaker preference tier) now covers maintained creates too, and the implementer updated its wording; the `NOTE:` on `addEdgesThatCloseNoCycle` carries the measured planning cost.

**Known limits, unchanged and documented:** a table that gains a column and also a DEFAULT reading a new materialized view over that column still fails (Known limits bullet); a maintained create failing after a `SET DATA TYPE` reports partial migration (documented in schema-declarative.md).

**Tests.** The six new apply cases are each a reproduction of a listed failure (five failed at HEAD) or pin the widened `runsAfter` that the move would otherwise break; kept. The two removed differ tests pinned the deleted ordering rule; removal is right. The `BROAD_DDL_*` lists move `mv1` to its new position. No tests added or cut in review.

**Docs.** Read all three changed docs; they match the code. Grepped docs and the differ for other stale claims about maintained-create order; only the comment above was stale.

**Validation.**
- `yarn workspace @quereus/quereus run lint`: exit 0.
- `yarn workspace @quereus/quereus run test`: 11135 passing, 26 pending.
- `test:store` not re-run in review: the only review edit is a comment; the implementer's store run passed (11128 passing), and the store orderings above were checked directly.
