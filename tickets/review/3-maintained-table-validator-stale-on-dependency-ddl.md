description: Review the fix that rebuilds a maintained table's derived-row constraint validator when a CONSTRAINT-only dependency (FK parent / subquery-CHECK target — not a derivation source) is renamed/dropped/re-created. Before the fix the validator was compiled once at registration and went stale: maintenance writes then failed with an internal "Module 'memory' connect failed … not found" error instead of succeeding (rename) or raising the ordinary FK/planning error class (drop).
prereq: maintained-table-derivation-secondary-unique
files:
  - packages/quereus/src/core/derived-row-validator.ts                  # dependencyTables on the validator; computeDependencyTables; makePoisonedDerivedRowValidator
  - packages/quereus/src/core/database-materialized-views.ts            # subscribeToSchemaChanges + new rebuildConstraintValidatorsFor
  - packages/quereus/test/maintained-table-declared-constraints.spec.ts # new "constraint-dependency DDL invalidation" describe (9 cases)
  - packages/quereus/test/logic/51.8-maintained-table-declared-constraints.sqllogic  # new section 12
  - docs/materialized-views.md                                          # § Derived-row constraint validation — new "Constraint-dependency invalidation" paragraph
difficulty: medium
----

# Review: rebuild derived-row validator on constraint-dependency DDL

## What was implemented

The derived-row constraint validator (`derived-row-validator.ts`) is compiled
ONCE at `registerMaterializedView`, baking in `TableReferenceNode`s resolved to
the live incarnations of the tables its checks reference — the FK parent and any
subquery-CHECK target. These are **constraint-only** dependencies (not derivation
sources), so the existing source-change path never rebuilt them. A rename/drop of
such a dependency left the compiled scheduler pointing at a dead/renamed
incarnation; the next maintenance write threw the internal `Module 'memory'
connect failed … not found`.

### 1. `derived-row-validator.ts`
- Added `readonly dependencyTables: ReadonlySet<string>` to
  `DerivedRowConstraintValidator`.
- `computeDependencyTables(ctx, mv, fks)`: union of the build-time tracker's
  `type:'table'` deps (`ctx.schemaDependencies.getDependencies()` — captures the
  FK-parent EXISTS subquery and the subquery-CHECK target) **and** each FK parent
  named explicitly (belt-and-suspenders: the absent-parent fallback resolves no
  parent through the tracker), MINUS the derivation sources and the MV's own
  qualified name. All lowercased.
- `makePoisonedDerivedRowValidator(prior, error)`: a validator with a single
  inline (non-deferred) check whose evaluator returns `Promise.reject(error)`,
  retaining the prior `dependencyTables` so a later re-create self-heals.

### 2. `database-materialized-views.ts`
- `subscribeToSchemaChanges` now, after the existing source loop, calls
  `rebuildConstraintValidatorsFor(changed, matchOwnName=true)` on
  `table_removed`/`table_modified`, and `(…, matchOwnName=false)` on `table_added`
  (self-heal on dependency re-create).
- `rebuildConstraintValidatorsFor`: for each registered plan whose validator names
  `changed` in `dependencyTables` (or, when `matchOwnName`, `changed` IS the
  maintained table itself — the rename signal), rebuild
  `plan.derivedRowValidator = buildDerivedRowValidator(db, getMaintainedTable(...))`.
  No `releaseRowTime`, no staleness. The rebuild is wrapped in try/catch; on throw
  (dropped subquery-CHECK target → "table not found") it installs a poisoned
  validator so the listener never fails the DDL and the next write surfaces the
  sited planning error.

### Key ordering facts (verified)
- **FK-parent / CHECK-target rename**: `runRenameTable` adds the new parent to the
  catalog (alter-table.ts:198) BEFORE `propagateTableRenameInSchema` rewrites the
  maintained table's own FK `referencedTable` / CHECK AST and fires `table_modified`
  on the maintained table itself — so the own-name rebuild resolves against the new
  name. The old dependency name is gone from the catalog (renamed, not dropped), so
  the dependency-set match alone would miss it; the own-name branch covers it.
- **Drop**: `SchemaManager.dropTable` removes the table from the catalog (line 1336)
  BEFORE firing `table_removed` (line 1347), so the rebuild sees the parent absent →
  `buildChildSideFKChecks` emits the null-guards-only fallback.
- **Re-create**: `createTable` fires `table_added` AFTER `schema.addTable`, so the
  self-heal rebuild resolves against the live re-created table.
- The synthetic `emitBackingInvalidation` event fires AFTER `releaseRowTime`, so the
  own-name branch is a no-op there (the plan is already gone from `rowTime`).

## Expected behavior / use cases (all covered by tests)

- **Rename FK parent** (`parent`→`parent2`): a valid source write referencing the
  renamed parent succeeds; an orphan write fails with the maintained-table FK
  attribution against `main.parent2`.
- **Drop FK parent** (maintained table empty at drop): a non-NULL-ref write fails
  with the maintained-table FK CONSTRAINT error (NOT INTERNAL, NOT a module-connect
  error); a NULL ref is admitted (MATCH SIMPLE).
- **Drop subquery-CHECK target**: the next source write surfaces a clear
  `Table 'quota' not found` planning error (poisoned validator), not a module
  connect failure.
- **Rename subquery-CHECK target**: the CHECK is rewritten in place and re-resolves
  — a conforming write flows; a violating write fails the CHECK with maintained-table
  attribution.
- **Self-heal**: re-creating a dropped FK parent / subquery-CHECK target restores
  healthy validation (via the `table_added` rebuild).

## Validation performed

- `packages/quereus/test/maintained-table-declared-constraints.spec.ts`: 16
  passing (9 new under "constraint-dependency DDL invalidation").
- `51.8-maintained-table-declared-constraints.sqllogic` section 12: passing.
- Full `yarn workspace @quereus/quereus test`: **5996 passing, 9 pending, 0
  failing**.
- `yarn workspace @quereus/quereus lint`: 0 errors, 0 warnings.

## Honest gaps / things to scrutinize (treat tests as a floor)

- **Store-mode NOT run.** I ran the default memory-backed suite only. The 51.8
  sqllogic also runs under `yarn test:store` (LevelDB), where ALTER RENAME / DROP /
  constraint semantics exercise a different code path. Recommend a reviewer or CI
  run `test:store` (slower; not the agent default per AGENTS.md). I did not run it.
- **`table_added` handling is broader than the ticket's explicit TODO** (which
  named only `table_removed`/`table_modified`). Added to make the nice-to-have
  self-heal work cleanly. It only matches when a re-created table is already in an
  existing validator's `dependencyTables` (i.e. re-create-after-drop), so it should
  not cause spurious rebuilds — but confirm there's no topology where a benign
  re-create triggers an unwanted rebuild.
- **`plan.mv` is NOT refreshed on rebuild.** After an FK-parent rename, the cached
  `plan.mv` still holds the old FK `referencedTable`; only the validator is rebuilt
  from the current catalog record. This is harmless because no maintenance arm reads
  `plan.mv`'s FK/CHECK metadata (they read the body/projectors) — but verify no path
  depends on `plan.mv` constraint fields.
- **Poisoned check throws INLINE (immediately), not deferred**, even though the
  original subquery-CHECK was deferred. This matches the ticket's recommendation
  ("a single inline (non-deferred) check"), but is a slight semantic shift
  (statement-immediate vs at-commit). Confirm acceptable.
- **Per-event O(plans) scan.** `rebuildConstraintValidatorsFor` iterates all
  registered row-time plans per schema-change event (consistent with the existing
  source loop's `getAllMaintainedTables()` scan; small-N). Not indexed by dependency.
- **MV-over-MV via a CHECK subquery (not a source).** If a consumer C declares a
  CHECK referencing producer P where P is NOT in C's `sourceTables`, P lands in C's
  `dependencyTables`; a DDL marking P stale (`emitBackingInvalidation` on P) then
  triggers a redundant (benign — P is structurally intact) rebuild of C's validator.
  Unusual topology, correctness-safe, only on DDL (not row writes).
- **Determinism-pragma interaction not re-tested on rebuild.** A CHECK that only
  compiles under `pragma nondeterministic_schema` would re-run that gate at rebuild
  time; not exercised by the new tests.
