description: Route the `quereus.*` reserved tags on `ALTER TABLE … ADD CONSTRAINT … WITH TAGS` and `ALTER TABLE … ADD COLUMN … WITH TAGS` (column tags AND inline named column-constraint tags) through `validateReservedTags`, so a typo'd / mis-sited reserved key hard-errors at plan-build time exactly as the CREATE, declarative-differ, and SET TAGS paths already do. Pure additive validation; extract the shared column+constraint tag-accumulation helper to keep DRY.
files:
  - packages/quereus/src/planner/building/alter-table.ts              # addConstraint arm (~27) + addColumn arm (~56) — add validation; setTags arm (~122) is the in-file model
  - packages/quereus/src/planner/building/ddl.ts                      # raiseCreateTableTagDiagnostics (~47) + raiseStmtTagDiagnostics (~62) — the CREATE precedent to share from
  - packages/quereus/src/schema/reserved-tags.ts                      # validateReservedTags + TagSite (reuse as-is; do NOT add a site or a 2nd registry)
  - packages/quereus/src/schema/reserved-tags-policy.ts               # raiseReservedTagDiagnostics (first-error-wins; warnings no-op)
  - packages/quereus/src/parser/ast.ts                                # ColumnDef.tags / ColumnConstraint.tags / TableConstraint.tags (~517/538/555), AlterTableAction (~588)
  - packages/quereus/test/logic/50-metadata-tags.sqllogic            # add a new ALTER-ADD phase mirroring Phase 23's inline-named-constraint block
----

# ALTER TABLE ADD CONSTRAINT / ADD COLUMN reserved-tag validation

## Problem (confirmed)

Reserved-tag (`quereus.*`) shape/site validation fires on every CREATE-time authoring
surface and on `ALTER … SET TAGS`, but **not** on the two imperative `ALTER … ADD`
arms of `buildAlterTableStmt` (`alter-table.ts`):

- **`addConstraint`** (`alter-table.ts:27`) builds `AddConstraintNode` directly from
  `stmt.action.constraint` and never validates `stmt.action.constraint.tags`.
- **`addColumn`** (`alter-table.ts:56`) validates the DEFAULT expression only — never
  `column.tags` nor `column.constraints[].tags`.

The parser *does* populate those tag bags: `parser.ts:2945` routes ADD CONSTRAINT
through `tableConstraint()` (`WITH TAGS` → `TableConstraint.tags`) and `parser.ts:2950`
routes ADD COLUMN through `columnDefinition()` (column `WITH TAGS` → `ColumnDef.tags`;
inline **named** constraint `WITH TAGS` → `ColumnConstraint.tags`). So a typo'd or
mis-sited reserved key is silently stored when introduced via ALTER … ADD, even though
the same column/constraint hard-errors at CREATE / `apply schema` / SET TAGS. This is
the same class of hole the CREATE / differ / inline-named-constraint tickets already
closed everywhere else — left as the last asymmetric gap on the authoring surface.

## Expected behavior

`ALTER TABLE … ADD CONSTRAINT … WITH TAGS` and `ALTER TABLE … ADD COLUMN … WITH TAGS`
reject a typo'd or mis-sited `quereus.*` key at plan-build time, loudly, with the
statement's source location — identical to the existing CREATE / differ / SET TAGS
posture. Well-formed reserved tags and all free-form (non-`quereus.*`) tags pass
untouched and round-trip into the catalog.

Sites to validate (mirror existing precedents exactly — **no new `TagSite`**):

- **ADD CONSTRAINT**: `constraint.tags` → `physical-constraint`.
- **ADD COLUMN**: `column.tags` → `physical-column`, **and** each
  `column.constraints[].tags` → `physical-constraint`.
  - Iterate **every** constraint with no `cc.name` guard, exactly as
    `raiseCreateTableTagDiagnostics` does. The parser lifts a trailing `WITH TAGS`
    onto an inline constraint only when it is *named*; an unnamed inline constraint's
    trailing `WITH TAGS` defers to the column (`cc.tags` is `undefined` there →
    `validateReservedTags` is a no-op → the tag lands and validates on `column.tags`
    at `physical-column`). So no double-validation and no special-casing.

Raise via the shared `raiseReservedTagDiagnostics` policy (first error wins; warnings
no-op), threading `stmt.loc` for a sited error — the same `raiseStmtTagDiagnostics`
shape already in `ddl.ts`.

## Design — share the accumulation, don't triplicate the flatMap

`raiseCreateTableTagDiagnostics` (`ddl.ts:47`) already accumulates a column's tags +
its inline constraints' tags inline:

```ts
...stmt.columns.flatMap(c => validateReservedTags(c.tags, 'physical-column')),
...stmt.columns.flatMap(c => (c.constraints ?? []).flatMap(cc => validateReservedTags(cc.tags, 'physical-constraint'))),
```

ADD COLUMN needs the *same* per-column accumulation. Rather than copy the chain a
third time, extract one small pure helper and have **both** CREATE and ADD COLUMN call
it. Suggested home: a new tiny module `planner/building/tag-diagnostics.ts` (keeps
`reserved-tags.ts` AST-free — it currently imports only `SqlValue`, do **not** add an
AST import there), exporting:

```ts
// Validate one column's own tags (physical-column) + each of its inline
// constraints' tags (physical-constraint). Unnamed inline constraints carry no
// tags (the parser defers them to the column), so the constraint flatMap is a
// no-op for them — same reasoning as raiseCreateTableTagDiagnostics.
export function columnTagDiagnostics(column: AST.ColumnDef): TagDiagnostic[] {
  return [
    ...validateReservedTags(column.tags, 'physical-column'),
    ...(column.constraints ?? []).flatMap(cc => validateReservedTags(cc.tags, 'physical-constraint')),
  ];
}

// First-error-wins raise with the statement's source location; warnings no-op.
// (Lifted verbatim from ddl.ts so all build-path callers share one policy site.)
export function raiseStmtTagDiagnostics(diagnostics: TagDiagnostic[], stmt: AST.AstNode): void { … }
```

Then:
- `ddl.ts:raiseCreateTableTagDiagnostics` reuses `columnTagDiagnostics` for its column
  legs and imports `raiseStmtTagDiagnostics` from the shared module (delete the local
  copy).
- `alter-table.ts` `addColumn` arm builds
  `[...columnTagDiagnostics(column)]` and calls `raiseStmtTagDiagnostics(diags, stmt)`
  **before** building the backfill/checks (so a bad tag fails before any heavier work).
- `alter-table.ts` `addConstraint` arm calls
  `raiseStmtTagDiagnostics(validateReservedTags(stmt.action.constraint.tags, 'physical-constraint'), stmt)`
  before constructing `AddConstraintNode`.

Keep the extraction minimal — a single shared helper module, no behavior change to the
existing CREATE diagnostics (table-level + table-constraint legs stay inline in
`raiseCreateTableTagDiagnostics`; only the per-column leg moves into the shared helper).

The `setTags` arm (`alter-table.ts:122`) currently raises via `raiseReservedTagDiagnostics`
inline without threading `loc`; leave it as-is (out of scope), or optionally route it
through the shared `raiseStmtTagDiagnostics` for consistency — author's call, note it
if you do.

## Tests — add an ALTER-ADD phase to `50-metadata-tags.sqllogic`

Mirror the Phase 23 inline-named-constraint block. Cover (the ticket's enumerated
cases):

- Typo'd reserved key on `ALTER … ADD CONSTRAINT c CHECK(...) WITH TAGS ("quereus.bogus"=1)`
  → `-- error: reserved tag`.
- Mis-sited otherwise-valid key on `ALTER … ADD CONSTRAINT` — e.g. a view-only
  `quereus.update.default_for.<col>` → `-- error: not allowed` (`tag-not-allowed-here`).
- Valid functional tag accepted + round-trips:
  `ALTER … ADD CONSTRAINT uq UNIQUE (col) WITH TAGS ("quereus.expose_implicit_index"=true)`
  → verify via `unique_constraint_info`.
- Typo'd reserved key on `ALTER … ADD COLUMN y INT WITH TAGS ("quereus.bogus"=1)` (column
  tag) → `-- error: reserved tag`.
- Typo'd reserved key on `ALTER … ADD COLUMN z INT CONSTRAINT cz CHECK(z>0) WITH TAGS ("quereus.bogus"=1)`
  (inline named column-constraint tag) → `-- error: reserved tag`.
- Valid `quereus.id` on ADD COLUMN (column) **and** on its inline named constraint →
  accepted + round-trip (column via `table_info`, constraint via `unique_constraint_info`).
- Unnamed inline constraint on ADD COLUMN with trailing `WITH TAGS ("quereus.id"=...)`
  → tag lands on the **column** (`physical-column`), validated/stored there, round-trips
  via `table_info`, not double-validated.
- (Guard) a free-form non-`quereus.*` tag on both ADD arms still applies cleanly.

Note the existing sqllogic error-marker convention: `-- error: reserved tag`,
`-- error: not allowed` — match the substring the harness greps (see Phase 14/23).

## Risk

Pure additive validation: no behavior change for well-formed schemas, only a new hard
error for a previously-silent typo/mis-site. Same low-risk profile as the predecessor
tickets. The store path (`test:store`) is unaffected by construction (this is a
plan-build-time check, before any module write).

## TODO

- Add `planner/building/tag-diagnostics.ts` exporting `columnTagDiagnostics(column)` and
  `raiseStmtTagDiagnostics(diagnostics, stmt)` (move the latter verbatim from `ddl.ts`).
- Refactor `ddl.ts:raiseCreateTableTagDiagnostics` to reuse `columnTagDiagnostics` for
  its per-column leg and import `raiseStmtTagDiagnostics` from the shared module; delete
  the now-duplicated local `raiseStmtTagDiagnostics`.
- `alter-table.ts` `addConstraint` arm: validate `stmt.action.constraint.tags` at
  `physical-constraint` via `raiseStmtTagDiagnostics(...)` before building `AddConstraintNode`.
- `alter-table.ts` `addColumn` arm: validate `columnTagDiagnostics(column)` via
  `raiseStmtTagDiagnostics(diags, stmt)` before building backfill/checks.
- Add the ALTER-ADD test phase to `test/logic/50-metadata-tags.sqllogic` (cases above).
- `yarn workspace @quereus/quereus build` (or `yarn build`) — typecheck the new module +
  refactor.
- `yarn test` (memory vtab) — confirm the new phase passes and no regression; stream with
  `2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`.
- `yarn workspace @quereus/quereus lint` (single-quote globs on Windows) on the touched files.
- Hand off to review with an honest note on whether `setTags` was routed through the shared
  helper or left inline.
