description: Keep provably-unaffected materialized views live across structural source ALTERs (ADD/DROP/ALTER COLUMN). A genuine `table_modified` on a source now routes a *live* dependent MV through `tryRecompileMaterializedViewLive`, which keeps it live iff the change is provably disjoint from everything the body reads — gated by shape re-derivation, a name-stability check, and a content-stability (column-disjointness) proof. Reviewed and completed.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts
  - packages/quereus/src/core/database-materialized-views.ts
  - docs/materialized-views.md
  - packages/quereus/test/logic/53.4-materialized-view-structural-alter-restore.sqllogic
  - packages/quereus/test/mv-structural-alter-restore.spec.ts

# Completed: keep provably-unaffected MVs live across structural source ALTERs

A `table_modified` on a source whose columns/PK changed no longer unconditionally
marks every dependent MV stale. The MV-manager listener routes **any genuine**
`table_modified` (`oldObject !== newObject`) of a *live* dependent through
`tryRecompileMaterializedViewLive`, which keeps it live iff the change is provably
unaffecting — generalizing the constraint-only recompile (53.3) to structural ALTERs.

The gate chain: (1) re-derive backing shape against the post-change catalog;
(2) `sameSourceTables`; (3) `describeBackingShapeMismatch` + superkey relaxation;
(4) **name-stability** — re-derived output names must equal the backing's (a `select *`
rename is declined here and handed to the rename-propagation pass); (5) **content-stability**
— `valueSemanticsChangedColumns` (same-name columns whose type/collation differ) ∩
`referencedSourceColumns` (read set from the **un-optimized** built plan, expanded through
`generatedColumnDependencies`) must be empty. Empty changed set ⇒ no-op (preserves today's
behavior for constraint-only / ADD / DROP / NOT NULL / DEFAULT). Keep-live is event-silent.

## Review findings

**Scope reviewed:** the implement-stage diff (`d39c7a9e`) read first with fresh eyes —
both source files in full, the new 53.4 sqllogic (17 sections) and the 4-case
`mv-structural-alter-restore.spec.ts`, the `docs/materialized-views.md` update, and the
rename-propagation interaction in `alter-table.ts` / `propagateColumnRenameToMaterializedViews`.

### Soundness (core argument) — verified sound
- **`oldObject !== newObject` guard.** Genuine ALTERs build a fresh frozen `TableSchema`;
  `emitBackingInvalidation`'s synthetic same-object event is correctly excluded from the
  keep-live recompile, so a genuinely-stale producer still cascade-stales MV-over-MV
  consumers (53.4 §17b, spec case 3). Confirmed.
- **Content gate is over-approximating in the safe direction.** Walking the **un-optimized**
  `db._buildPlan` (not `getPlan`) keeps every `ColumnReferenceNode` explicit, so a predicate
  the optimizer would absorb into a seek key cannot be missed. An extra column in the read
  set only ever causes *more* staleness, never an unsound keep-live. Generated-column closure
  (53.4 §13) and self-join union over occurrences (53.4 §14) both confirmed correct, reading
  `generatedColumnDependencies` from the post-ALTER `tableSchema`.
- **Comparison primitives** (`backingTypeMatches`/`backingCollationMatches`,
  `valueSemanticsChangedColumns`) compare by interned type name / normalized collation, not
  object identity — the discipline the store path needs (see deferral below).
- **NOT NULL / DEFAULT correctly excluded** from `valueSemanticsChangedColumns`: a body reads
  stored values, never constraints/defaults, and those changes affect only future rows (data
  events handled by maintenance). 53.4 §11 confirms keep-live.

### Deviation #1 — name-stability gate (not in original plan) — verified correct
The gate declines (→ stale → rename-propagation pass owns the backing rename) exactly when
the re-derived output names shift, which for a structural change happens only on a column
RENAME projected by the body (or `select *`). Checked it neither over-declines (a non-rename
keep-live has stable output names → passes) nor under-declines (an unprojected rename never
shifts output names and the backing never carried that name). The decline correctly hands off
to `propagateColumnRenameToMaterializedViews`, which `alter-table.ts:1637` runs after the
listener's notify. **Exercised end-to-end by `53.2-materialized-view-rename-propagation.sqllogic`
§12** (passes) — so it is genuinely tested, contrary to the handoff's "least-exercised" caveat;
no extra spec required.

### Deviation #2 — wide test-file fallout — spot-checked, intent preserved
Reviewed the rewritten `mv-structural-alter-restore.spec.ts` (4 catalog-invariant cases:
event-silence, frozen-emits-invalidation, both cascade directions) and the new 53.4 suite.
The trigger swaps in the ~9 existing files invert the same behavior this feature changes, so
the switch to genuinely-staling triggers (projected retype / WHERE-column collation) is
correct, and the full suite green confirms each preserved its original intent.

### Minor — FIXED INLINE
- **Added `53.4 §18`** (correlated-subquery read): the altered column is read *only* inside a
  correlated `EXISTS` subquery — neither projected nor in a top-level WHERE. This validates the
  read-set walk's recursion through `getRelations` into nested relations, a soundness claim the
  ticket makes ("CTEs, set-ops, EXISTS/correlated subqueries reach the walk") that previously had
  **no test**. Had the walk failed to recurse, such an MV would be wrongly kept live (unsound —
  serving the pre-ALTER row set). New section passes; full `test:all` unaffected.

### Major findings — NONE
No new fix/plan/backlog tickets filed: no correctness, resource-cleanup, type-safety, or DRY
issues found beyond the minor test gap fixed above. The implementation is well-decomposed
(single-purpose helpers, shared comparison vocabulary) and the docs reflect the new reality.

### Docs — verified current
`docs/materialized-views.md` § Schema-change staleness gained the "Structural ALTERs keep
provably-unaffected dependents live" paragraph with the full soundness argument. Other doc hits
(`module-authoring.md`, `sql.md`) are unrelated (rename-propagation UNSUPPORTED path, tag drift)
— no stale references left.

### Validation
- `yarn workspace @quereus/quereus run build` → clean (exit 0).
- `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json`) → clean (exit 0).
- `yarn workspace @quereus/quereus run test:all` → **6183 passing, 9 pending, 0 failing**.
- `mocha logic.spec.ts --grep 53.4` after adding §18 → passing.

### Deferral carried forward (legitimate, not agent-runnable)
- **`yarn test:store` not run** (slow; not agent-runnable). The comparison primitives compare by
  interned type name / normalized collation rather than object identity, so the design should
  hold on the store path where `TableSchema` is rebuilt with fresh instances after an ALTER — but
  it is UNVERIFIED. A reviewer with the store harness should run 53.3 / 53.4 / 51.x under
  `QUEREUS_TEST_STORE=1`.
