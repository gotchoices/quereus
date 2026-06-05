description: ALTER TABLE SET TAGS for table/column/constraint metadata + declarative tag-diff
prereq:
files:
  - packages/quereus/src/parser/parser.ts            # alterTableStatement, parseTags
  - packages/quereus/src/parser/ast.ts               # AlterTableAction union
  - packages/quereus/src/planner/building/alter-table.ts
  - packages/quereus/src/planner/nodes/alter-table-node.ts
  - packages/quereus/src/runtime/emit/alter-table.ts
  - packages/quereus/src/schema/manager.ts           # setTableTags + new column/constraint setters
  - packages/quereus/src/schema/schema-differ.ts      # computeTableAlterDiff / generateMigrationDDL
  - packages/quereus/src/schema/catalog.ts            # already carries table/column/constraint tags
  - packages/quereus/src/schema/reserved-tags.ts      # validateReservedTags (reuse on alter path)
  - packages/quereus/src/schema/reserved-tags-policy.ts
  - packages/quereus/src/emit/ast-stringify.ts        # alterTableToString + tagsClauseToString
  - docs/sql.md                                       # §2.6 tags, §2.7 ALTER TABLE
  - docs/schema.md                                    # SchemaManager tag API + declarative section
  - packages/quereus/test/logic/50-metadata-tags.sqllogic
  - packages/quereus/test/declarative-equivalence.spec.ts
  - packages/quereus/test/schema-manager.spec.ts
----

# ALTER TABLE … SET TAGS — table, column, and constraint metadata mutation

## Why

Metadata tags (`WITH TAGS (...)`) can be attached to schema objects at **create** time and
read back through introspection TVFs (`schema()`, `table_info()`, `check_constraint_info()`, …,
see the completed `expose-tags-through-introspection` ticket), but there is **no way to change a
tag after creation from SQL**, and the declarative-schema differ does **not detect tag drift**.
The only mutation surface today is the programmatic `SchemaManager.setTableTags()` (table-level
only). Tags are part of the schema catalog (`CatalogTable.tags`, `CatalogTable.columns[].tags`,
`CatalogTable.namedConstraints[].tags`) yet have no corresponding ALTER — so a `declare schema`
that changes a tag value silently no-ops at `apply schema`.

This ticket closes the gap for the three tag sites that live under the existing **`ALTER TABLE`**
statement: the table itself, its columns, and its named table-level constraints. Views,
materialized views, and indexes are handled in the sibling ticket
`alter-view-index-mv-tag-mutation` (they need new top-level `ALTER` statements).

## Design

### Semantics: `SET TAGS` is whole-set replacement

There is exactly one tag primitive per site — **replace the entire tag set** with the listed
tags. This maps 1:1 onto the existing `setTableTags(name, tags)` (which already replaces, and
clears when passed `{}`), keeps the surface minimal, and gives the declarative differ a trivial
"emit the full desired set" target. An empty list clears all tags.

```sql
alter table t set tags (display_name = 'Orders', audit = true);   -- replace table tags
alter table t set tags ();                                        -- clear all table tags
alter table t alter column c set tags (searchable = true);        -- replace column c's tags
alter table t alter constraint uq_email set tags (msg = 'dup');   -- replace constraint tags
```

Per-key merge / per-key drop (`add tags` / `drop tags (k)`) is intentionally **out of scope** —
parked as an ergonomic follow-up in `backlog/` (see TODO). Tag values keep the `WITH TAGS` value
domain (string / number / boolean / null); `null` is a legal stored value, which is precisely why
delete-a-key cannot be modelled by setting `k = null` and a whole-set replace is the right v1
primitive.

### Tags are catalog-only — no module round-trip

Tags are pure informational metadata; they touch no stored row and no physical layout. So the
emitter mutates the in-memory `TableSchema` and re-registers it (exactly as `setTableTags` does
today) and fires a `table_modified` change event — it does **not** call `module.alterTable`. This
makes `SET TAGS` succeed even on modules that don't implement `alterTable`, and keeps it cheap.
(Store-backed modules persist DDL via their own schema-change listener on `table_modified`; verify
the LevelDB store re-serializes the tag change — if it keys persistence off `alterTable` it must
also pick up tag-only schema swaps. Document the outcome.)

### AST + node

Extend `AST.AlterTableAction` (parser/ast.ts) with a single new variant carrying the target site:

```ts
| { type: 'setTags',
    target: { kind: 'table' } | { kind: 'column'; columnName: string } | { kind: 'constraint'; constraintName: string },
    tags: Record<string, SqlValue> }   // empty record = clear
```

Mirror it onto `AlterTableNode`'s action union (planner/nodes/alter-table-node.ts) and handle it
in `building/alter-table.ts`. In `runtime/emit/alter-table.ts` add a `case 'setTags'` dispatching
to `runSetTableTags` / `runSetColumnTags` / `runSetConstraintTags`. `computePhysical` stays
`{ readonly: false }`; add a `note` arm.

### SchemaManager helpers

`setTableTags` already exists. Add sibling catalog-only setters so the emitter stays thin and the
JS API is symmetric: `setColumnTags(tableName, columnName, tags, schemaName?)` and
`setConstraintTags(tableName, constraintName, tags, schemaName?)`. Each rebuilds the relevant
`columns[]` / `checkConstraints[] | uniqueConstraints[] | foreignKeys[]` entry with a frozen
`tags` (or `undefined` when the record is empty), re-`addTable`s, and emits `table_modified`. A
constraint name that matches none of the three named-constraint arrays errors with `NOTFOUND`.

### Reserved-tag validation on the ALTER path

The create and declarative paths route tags through `validateReservedTags(tags, site)` (typed
registry, hard-error on unknown/mis-sited `quereus.*` keys). The ALTER path must do the **same**,
at the matching site, so `alter table t set tags ("quereus.update.taget" = 1)` fails loudly rather
than storing a typo. Sites: table → `physical-table`, column → `physical-column`, constraint →
`physical-constraint`. Run validation at build or emit time and raise via
`raiseReservedTagDiagnostics`.

### Declarative differ — detect tag drift, emit `SET TAGS`

`computeTableAlterDiff` (schema-differ.ts) currently compares column nullability / type / default
and constraint **renames** only; it ignores tags entirely (and the schema **hash deliberately
excludes tags**, so a tag-only change must be detected structurally, not via hash). Add:

- `TableAlterDiff.tableTagsChange?: Record<string, SqlValue> | undefined` — set when the declared
  table tag set differs from actual.
- `ColumnAttributeChange.tags?: Record<string, SqlValue>` — set when a surviving column's declared
  tags differ from actual (computed in `computeColumnAttributeChange`).
- `TableAlterDiff.constraintTagsChanges?: Array<{ constraintName: string; tags: Record<string, SqlValue> }>`
  — per named constraint whose tags drifted.

Tag equality uses the differ's existing `stableStringify` over the tag record (order-independent).
**Exclude the rename-hint keys `quereus.id` and `quereus.previous_name` from the drift comparison**
— they drive rename detection, not data state, and must not generate churn-y `SET TAGS` after a
rename completes. Behavioral reserved tags (`quereus.update.*`, `quereus.lens.*`,
`quereus.expose_implicit_index`, …) **are** real schema state and **are** compared.

Gate the alter-diff push so a table whose only change is tags still lands in `tablesToAlter`
(extend the `if (...)` guard in `computeSchemaDiff`).

`generateMigrationDDL`: emit `ALTER TABLE <t> SET TAGS (...)`, `ALTER TABLE <t> ALTER COLUMN <c>
SET TAGS (...)`, `ALTER TABLE <t> ALTER CONSTRAINT <name> SET TAGS (...)`. Reuse
`tagsClauseToString` shape for the `(k = v, …)` body (it currently emits a leading ` with tags `
prefix — factor out the inner `(k = v, …)` renderer so both `WITH TAGS` and `SET TAGS` share it).
Order within a table's alter block: tags after the existing structural phases (rename/add/alter/
pk/drop) so a tag set lands on the post-structural column/constraint set.

### Stringify / round-trip

Add `setTags` arms to `alterTableToString` (ast-stringify.ts) so emit-roundtrip and
`create...ToString`-style callers reproduce `alter table … set tags (…)`. The
`emit-roundtrip-property` AST comparator must treat an empty tags record and absent tags as
equivalent (matches the `undefined`-when-empty storage rule).

## Edge cases & interactions

- **Clear-all** (`set tags ()`): stored `tags` becomes `undefined`, not an empty frozen object —
  so introspection `tags IS NULL` and the differ's "no tags" both hold. Round-trips with no
  `with tags` clause.
- **Schema hash unaffected.** Tags are excluded from `computeSchemaHash`; `explain schema` hash
  must NOT change on a tag-only ALTER. Add an assertion.
- **Reserved hint tags** (`quereus.previous_name` / `quereus.id`) set via `SET TAGS` are stored
  verbatim but excluded from tag-drift comparison (above). A `set tags` carrying only a rename hint
  is a legal no-op-for-drift mutation.
- **Unknown column / constraint name** → `NOTFOUND` (column) / `NOTFOUND` (constraint), not a
  silent no-op.
- **Unnamed constraints** carry tags too (the parser attaches a trailing `WITH TAGS` to an unnamed
  *table-level* constraint), but they have no addressable name — `ALTER CONSTRAINT` can only target
  **named** constraints. Document that unnamed-constraint tags are immutable post-create (rename it
  by giving it a name via the declarative path, or recreate).
- **Constraint-name collision across classes**: a CHECK and a UNIQUE constraint could in principle
  share a name. Define lookup order (checks → unique → fk, first match) and reject ambiguity if the
  same name exists in two arrays.
- **PK / column-attribute interaction**: `SET TAGS` on a column must not disturb nullability,
  type, default, generated-ness, or PK membership — only the `tags` field changes.
- **Declarative apply ordering**: a `SET TAGS` emitted alongside a `RENAME COLUMN` in the same
  table must target the **post-rename** column name (tags phase runs last — verify).
- **Logical schema**: tags on a logical table survive into the compiled lens (per docs/schema.md).
  `SET TAGS` against a logical/lens-only table is not applicable through this path — confirm it
  errors cleanly (logical tables aren't module-backed and aren't reached by `ALTER TABLE`).
- **Store module persistence**: confirm the LevelDB store path re-persists a tag-only schema swap
  (it may currently only re-serialize DDL on `module.alterTable`). If it misses tag-only swaps,
  either route a lightweight notify or document the limitation and file a fix ticket.

## TODO

**Parser + AST**
- Add the `setTags` variant to `AST.AlterTableAction`.
- In `alterTableStatement`: handle `SET TAGS (...)` on the table (after `set` not followed by a
  column/PK target), and `ALTER COLUMN <c> SET TAGS (...)` / `ALTER CONSTRAINT <name> SET TAGS
  (...)` in the ALTER branch. Reuse `parseTags()` for the `(k = v, …)` body. Add `CONSTRAINT` to
  the ALTER sub-dispatch (currently only `COLUMN` / `PRIMARY KEY`).

**Planner + runtime**
- Extend `AlterTableNode` action union + `toString` + `getLogicalAttributes`.
- Handle `setTags` in `building/alter-table.ts` (validate reserved tags here or in emit).
- Add `runSetTableTags` / `runSetColumnTags` / `runSetConstraintTags` in `runtime/emit/alter-table.ts`;
  catalog-only swap + `table_modified` event; add the `note` arm.

**SchemaManager**
- Add `setColumnTags` and `setConstraintTags` (mirror `setTableTags`); export through docs/schema.md.

**Differ + migration DDL**
- Extend `TableAlterDiff` / `ColumnAttributeChange` with the tag-change fields.
- Compare tags (via `stableStringify`, excluding `quereus.id` / `quereus.previous_name`) in
  `computeTableAlterDiff` / `computeColumnAttributeChange` and for named constraints.
- Widen the `tablesToAlter` push guard to include tag-only changes.
- Emit the three `SET TAGS` forms in `generateMigrationDDL`; factor the inner `(k = v, …)` renderer
  out of `tagsClauseToString`.

**Stringify**
- Add `setTags` arms to `alterTableToString`; confirm the emit-roundtrip comparator treats
  empty/absent tags as equal.

**Docs**
- docs/sql.md §2.7: add a `SET TAGS` subsection (table / `ALTER COLUMN … SET TAGS` / `ALTER
  CONSTRAINT … SET TAGS`); note whole-set-replace semantics, clear-via-empty, reserved-tag
  validation, and that the schema hash is unaffected. Cross-link from §2.6 (tags).
- docs/schema.md: add `setColumnTags` / `setConstraintTags` to the SchemaManager table; note the
  differ now detects tag drift and emits `SET TAGS`.

**Tests**
- `test/logic/50-metadata-tags.sqllogic`: add a Phase that sets, changes, and clears table /
  column / constraint tags via ALTER and round-trips through the introspection TVFs; assert
  reserved-tag typo rejection; assert clear → `tags IS NULL`.
- `test/declarative-equivalence.spec.ts` (+ the property block): a corpus shape where the declared
  tags differ from an already-applied table, asserting `apply schema` converges the tags (and that
  a re-apply is a no-op / idempotent).
- `test/schema-manager.spec.ts`: unit-cover `setColumnTags` / `setConstraintTags` incl. clear and
  NOTFOUND.
- Add a schema-hash-stability assertion for a tag-only ALTER.

**Backlog (do not implement here — file a `backlog/` ticket)**
- Per-key merge / drop ergonomics: `ALTER … ADD TAGS (k = v)` / `ALTER … DROP TAGS (k)`.
