description: Close the remaining reserved-tag validation holes on the imperative ALTER TABLE authoring surface — `ALTER TABLE … ADD CONSTRAINT … WITH TAGS` and `ALTER TABLE … ADD COLUMN … WITH TAGS` (column tags AND inline column-constraint tags) are built without ever routing their `quereus.*` tags through `validateReservedTags`, so a typo'd or mis-sited reserved key is silently stored. Same class of hole the CREATE / differ / inline-named-constraint tickets already closed on every other surface.
files:
  - packages/quereus/src/planner/building/alter-table.ts              # addConstraint case (~27) + addColumn case (~56) — neither validates tags; setTags case (~122) is the model to mirror
  - packages/quereus/src/schema/reserved-tags.ts                      # validateReservedTags + the 'physical-constraint' / 'physical-column' sites (reuse as-is)
  - packages/quereus/src/planner/building/ddl.ts                      # raiseCreateTableTagDiagnostics — the CREATE-path precedent for column + column-constraint tag accumulation
  - packages/quereus/test/logic/                                      # add ALTER-path sqllogic cases (mirror 50-metadata-tags inline-named-constraint block)
----

# ALTER TABLE ADD CONSTRAINT / ADD COLUMN reserved-tag validation

## The hole

Reserved-tag (`quereus.*`) shape/site validation now fires on every CREATE-time
authoring surface — table tags, column tags, table-level constraint tags, and
(as of the `inline-named-constraint-reserved-tag-validation` ticket) inline
*named* column-constraint tags — on **both** the direct `CREATE TABLE` path
(`ddl.ts:raiseCreateTableTagDiagnostics`) and the declarative differ
(`schema-differ.ts`). The imperative `ALTER TABLE … SET TAGS` path also validates,
via the `setTags` arm of `buildAlterTableStmt` (`alter-table.ts:122`), which routes
`stmt.action.tags` through `validateReservedTags` at the matching
`physical-table` / `physical-column` / `physical-constraint` site.

Two sibling ALTER arms in the **same** `buildAlterTableStmt` switch do **not**:

- **`addConstraint`** (`alter-table.ts:27`) builds `AddConstraintNode` directly
  from `stmt.action.constraint` and never calls `validateReservedTags` on
  `stmt.action.constraint.tags`. So
  `alter table t add constraint c check (...) with tags ("quereus.bogus" = 1)`
  silently stores the bogus tag. (Disclosed as an out-of-scope adjacent gap by the
  inline-named-constraint ticket.)

- **`addColumn`** (`alter-table.ts:56`) validates the column's DEFAULT expression
  but never its tags — neither `column.tags` nor `column.constraints[].tags`. So
  both `alter table t add column x int with tags ("quereus.bogus" = 1)` and
  `alter table t add column x int constraint c check (x>0) with tags (...)` silently
  store a bad tag. (Found during review of the inline-named-constraint ticket; same
  class, not previously disclosed.)

The result is asymmetric: a typo that hard-errors at CREATE / `apply schema` / SET
TAGS slides through silently when the same column or constraint is introduced via
ALTER … ADD. A silently-stored mis-sited functional key (e.g.
`quereus.expose_implicit_index` on a non-unique constraint, or a `view-ddl`-only
`quereus.update.*` key) is exactly the failure mode the unified hard-error posture
exists to prevent.

## Expected behavior

`ALTER TABLE … ADD CONSTRAINT … WITH TAGS` and `ALTER TABLE … ADD COLUMN … WITH
TAGS` reject a typo'd or mis-sited `quereus.*` reserved key at plan-build time —
loudly, with the statement's source location — exactly as the CREATE, declarative
differ, and `SET TAGS` paths already do. Well-formed reserved tags and all free-form
(non-`quereus.*`) tags continue to pass untouched and round-trip into the catalog.

Sites to validate (mirror the existing precedents):

- ADD CONSTRAINT: `constraint.tags` → `physical-constraint`.
- ADD COLUMN: `column.tags` → `physical-column`, **and** each
  `column.constraints[].tags` → `physical-constraint` (the parser populates an
  inline constraint's `tags` only when it is *named* — an unnamed inline
  constraint's trailing `WITH TAGS` defers to the column, landing on `column.tags`;
  so iterate every constraint with no `cc.name` guard, exactly as
  `raiseCreateTableTagDiagnostics` does).

Raise via the shared `raiseReservedTagDiagnostics` policy (first error wins, warnings
no-op), reusing the `raiseStmtTagDiagnostics`-style helper already in `ddl.ts` /
the `setTags` arm — do not introduce a new TagSite or a second validation registry.

## Use cases to cover (tests)

- Typo'd reserved key on `ALTER … ADD CONSTRAINT … WITH TAGS` → hard error.
- Mis-sited otherwise-valid key on `ALTER … ADD CONSTRAINT` (e.g. a `view-ddl`-only
  `quereus.update.default_for.<col>`) → `tag-not-allowed-here`.
- Valid functional tag on `ALTER … ADD CONSTRAINT … UNIQUE … WITH TAGS
  ("quereus.expose_implicit_index" = true)` → accepted + round-trips.
- Typo'd reserved key on `ALTER … ADD COLUMN … WITH TAGS` (column tag) → hard error.
- Typo'd reserved key on `ALTER … ADD COLUMN … CONSTRAINT c CHECK(...) WITH TAGS`
  (inline named column-constraint tag) → hard error.
- Valid `quereus.id` on both ADD COLUMN and its inline named constraint → accepted +
  round-trips (column via `table_info`, constraint via `unique_constraint_info`).
- Unnamed inline constraint on ADD COLUMN with trailing `WITH TAGS` → tag lands on
  the column (`physical-column`), validated/stored there, not double-validated.

## Notes

- The fix is a near-verbatim mirror of `raiseCreateTableTagDiagnostics` (`ddl.ts`)
  applied to the two ALTER arms; consider extracting the column +
  column-constraint accumulation into a small shared helper rather than duplicating
  the `flatMap` chain a third time (CREATE, ADD COLUMN), to stay DRY.
- Pure additive validation: no behavior change for well-formed schemas, only a new
  hard error for a previously-silent typo/mis-site. Same low-risk profile as the
  predecessor tickets; store path (`test:store`) unaffected by construction.
