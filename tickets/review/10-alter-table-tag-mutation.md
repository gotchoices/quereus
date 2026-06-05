description: ALTER TABLE … SET TAGS — whole-set metadata-tag mutation at the table / column / named-constraint sites, plus declarative tag-drift detection that emits SET TAGS. Catalog-only (no module round-trip). Ready for adversarial review.
files:
  - packages/quereus/src/parser/ast.ts                # AlterTableAction: setTags variant
  - packages/quereus/src/parser/parser.ts             # alterTableStatement (SET/CONSTRAINT branches) + alterColumnAction (SET TAGS)
  - packages/quereus/src/planner/nodes/alter-table-node.ts  # action union + toString + getLogicalAttributes
  - packages/quereus/src/planner/building/alter-table.ts    # setTags case + reserved-tag validation
  - packages/quereus/src/runtime/emit/alter-table.ts        # runSetTableTags/runSetColumnTags/runSetConstraintTags + note arm
  - packages/quereus/src/schema/manager.ts            # freezeTags/commitTagUpdate + setColumnTags/setConstraintTags (setTableTags now fires table_modified)
  - packages/quereus/src/schema/schema-differ.ts      # tag-drift fields/compare + SET TAGS migration DDL
  - packages/quereus/src/emit/ast-stringify.ts        # setTags arms + exported tagsBodyToString
  - docs/sql.md                                        # §2.6.3 cross-link, §2.7 SET TAGS subsection, EBNF
  - docs/schema.md                                     # SchemaManager setters, tag-drift section, ALTER reserved-tag note
  - packages/quereus/test/logic/50-metadata-tags.sqllogic       # Phases 11–15
  - packages/quereus/test/schema-manager.spec.ts                # setColumnTags/setConstraintTags + hash-value stability
  - packages/quereus/test/declarative-equivalence.spec.ts       # tag-drift convergence/idempotence + rename-hint no-churn + hash
  - packages/quereus/test/emit-roundtrip.spec.ts                # SET TAGS round-trip cases
  - tickets/backlog/tag-mutation-add-drop-ergonomics.md         # filed (per-key ADD/DROP TAGS)
  - tickets/backlog/tag-mutation-store-persistence.md           # filed (store re-persist of catalog-only swaps)
----

# Review: ALTER TABLE … SET TAGS (table / column / named-constraint tag mutation)

## What landed (implementation)

`ALTER TABLE … SET TAGS` is now the SQL surface for changing metadata tags after creation, at
the three sites that live under `ALTER TABLE`:

```sql
alter table t set tags (display_name = 'Orders', audit = true);   -- replace table tags
alter table t set tags ();                                        -- clear all table tags
alter table t alter column c set tags (searchable = true);        -- replace column c's tags
alter table t alter constraint uq_email set tags (msg = 'dup');   -- replace constraint tags
```

**Whole-set replacement** is the single primitive (empty list = clear). Per-key merge/drop is
explicitly out of scope (filed `backlog/tag-mutation-add-drop-ergonomics`).

- **AST/parser** — new `setTags` variant on `AlterTableAction` carrying `target` (table / column /
  constraint) + `tags`. `alterTableStatement` grew a top-level `SET TAGS` branch and an
  `ALTER CONSTRAINT <name> SET TAGS` branch; `alterColumnAction` grew `SET TAGS`. Reuses
  `parseTags()` for the `(k = v, …)` body.
- **Planner** — `AlterTableNode` action union + `toString` + `getLogicalAttributes`. `building/
  alter-table.ts` validates reserved `quereus.*` tags at the matching site (`physical-table` /
  `physical-column` / `physical-constraint`) via `validateReservedTags` + `raiseReservedTagDiagnostics`
  at **plan-build** time, then builds the node.
- **Runtime** — `runSetTableTags` / `runSetColumnTags` / `runSetConstraintTags` are thin wrappers
  over the SchemaManager setters. **Catalog-only**: no `module.alterTable` — the setter swaps the
  in-memory `TableSchema`, re-registers it, and fires `table_modified`. `computePhysical` stays
  `{ readonly: false }`; `note` arm added.
- **SchemaManager** — `setColumnTags` / `setConstraintTags` added (mirror `setTableTags`), sharing
  private `freezeTags` (empty ⇒ `undefined`) + `commitTagUpdate` (addTable + `table_modified`).
  **`setTableTags` now also fires `table_modified`** (it previously did not). Constraint lookup
  order is CHECK → UNIQUE → FK; `NOTFOUND` for no match, `ERROR` for a name ambiguous across classes.
- **Differ** — `TableAlterDiff.tableTagsChange`, `ColumnAttributeChange.tags`,
  `TableAlterDiff.constraintTagsChanges`. Drift is compared via `stableStringify` (order-independent),
  **excluding** the rename hints `quereus.id` / `quereus.previous_name` (behavioral reserved tags
  *are* compared). The `tablesToAlter` push-guard is widened; `generateMigrationDDL` emits the three
  `SET TAGS` forms in a **tags phase after** rename/add/alter/pk/drop (so a tag set lands on the
  post-rename name). The inner `(k = v, …)` renderer is factored out as exported `tagsBodyToString`,
  shared by `WITH TAGS` and `SET TAGS`.
- **Stringify** — `setTags` arms in `alterTableToString`.

## How to exercise / validate

- **SQL round-trip via introspection** (`test/logic/50-metadata-tags.sqllogic` Phases 11–15):
  set/change/clear at table/column/constraint, read back through `schema()` / `table_info()` /
  `unique_constraint_info()`; clear ⇒ `tags IS NULL`; reserved-tag typo rejection; `NOTFOUND` for
  unknown column/constraint.
- **Declarative drift** (`test/declarative-equivalence.spec.ts`): `apply schema` converges drifted
  table/column/constraint tags and a re-apply is a no-op (`tablesToAlter == []`); a `previous_name`
  hint does not churn a `SET TAGS` after the rename completes; a tag-only declaration change leaves
  the schema hash unchanged.
- **Programmatic** (`test/schema-manager.spec.ts`): `setColumnTags` / `setConstraintTags` incl.
  clear, attribute-preservation, and `NOTFOUND`; tag-VALUE hash stability.
- **AST round-trip** (`test/emit-roundtrip.spec.ts`): the four `SET TAGS` forms incl. empty `()`.

## Validation run

- `yarn workspace @quereus/quereus test` → **4759 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus run typecheck` → clean.
- `eslint` over all changed `src/` + `test/` files → clean.

## Known gaps / what the reviewer should scrutinize (this is a floor, not a finish line)

1. **Store persistence NOT addressed; `yarn test:store` NOT run.** `SET TAGS` is catalog-only, but
   the store module re-persists DDL only from `module.alterTable` — so a tag-only change on a
   **store-backed** table is not re-persisted across reconnect. This is a pre-existing gap for the
   programmatic `setTableTags` too; the new SQL surface makes it reachable. Filed
   `backlog/tag-mutation-store-persistence` (with a recommended `table_modified` subscription fix)
   and documented in `docs/schema.md`. **Decide whether store round-trip must land before complete.**
   I ran only the memory suite (the engine change is module-agnostic; the store path was untouched).
2. **CREATE vs ALTER reserved-tag asymmetry.** The ALTER path now validates `quereus.*` tags
   (per ticket), but the **direct `CREATE TABLE … WITH TAGS`** path still does *not* route table/
   column/constraint tags through `validateReservedTags` (only the declarative differ does). So
   `create table t (...) with tags ("quereus.bogus" = 1)` is accepted while the equivalent `SET TAGS`
   is rejected. Intentional per this ticket's scope, but the reviewer may want a follow-up to make
   direct CREATE consistent. Not filed.
3. **Constraint rename + tag change combined.** Differ emits constraint tag changes only for
   **name-matched** constraints; a renamed constraint that also changes tags won't get its tags
   updated. This is bounded by a pre-existing limitation: `generateMigrationDDL` does not emit
   constraint renames at all (no engine primitive). Acceptable for v1; worth a glance.
4. **Ambiguous-constraint-name rejection is implemented but UNTESTED.** `setConstraintTags` rejects
   a name present in >1 constraint class, but I did not unit-test it — I was unsure whether two
   same-named constraints across classes are even constructible via SQL without create-time rejection.
   Reviewer: confirm constructibility and add a test (or confirm the path is unreachable).
5. **`setTableTags` now fires `table_modified`.** Behavior change (additive). Full suite is green, but
   confirm no schema-change listener misbehaves on a tag-only swap.
6. **Logical/lens tables.** `ALTER TABLE` on a logical table errors via the generic table-not-found
   path in `buildTableReference` (logical tables are registered as views, not tables); not given a
   dedicated test. Confirm the error is clean.
7. **emit-roundtrip property generator** does not produce `setTags` actions, so the comparator's
   empty≡absent-tags equivalence for `setTags` is exercised only by the explicit string round-trips
   I added (the comparator already handles the `tags` key generically; no comparator change needed).
