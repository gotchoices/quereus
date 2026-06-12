description: Rebuild a maintained table's derived-row constraint validator when a CONSTRAINT-only dependency (FK parent / subquery-CHECK target — not a derivation source) is renamed/dropped/re-created. Before the fix the validator was compiled once at registration and went stale: maintenance writes then failed with an internal "Module 'memory' connect failed … not found" error instead of succeeding (rename) or raising the ordinary FK/planning error class (drop).
files:
  - packages/quereus/src/core/derived-row-validator.ts
  - packages/quereus/src/core/database-materialized-views.ts
  - packages/quereus/test/maintained-table-declared-constraints.spec.ts
  - packages/quereus/test/logic/51.8-maintained-table-declared-constraints.sqllogic
  - docs/materialized-views.md
----

# Complete: rebuild derived-row validator on constraint-dependency DDL

## What shipped

The derived-row constraint validator (`derived-row-validator.ts`), compiled once at
`registerMaterializedView`, bakes in `TableReferenceNode`s resolved to the live
incarnations of the tables its checks reference (FK parent + any subquery-CHECK
target). These **constraint-only** dependencies are not derivation sources, so the
existing source-change path never rebuilt them; a rename/drop left the scheduler
pointing at a dead/renamed incarnation and the next maintenance write threw the
internal `Module 'memory' connect failed … not found`.

- `DerivedRowConstraintValidator.dependencyTables` records the constraint-only deps
  (`computeDependencyTables`: union of build-time `type:'table'` tracker deps + each
  FK parent named explicitly, minus the derivation sources and the MV's own name).
- `makePoisonedDerivedRowValidator(prior, error)` — a single inline check that
  re-throws on the next write; installed when a rebuild can't recompile (dropped
  subquery-CHECK target). Retains `dependencyTables` so a re-create self-heals.
- `MaterializedViewManager.subscribeToSchemaChanges` calls
  `rebuildConstraintValidatorsFor(changed, matchOwnName=true)` on
  `table_removed`/`table_modified`, and `(…, false)` on `table_added` (self-heal).
  `rebuildConstraintValidatorsFor` rebuilds the validator only (no `releaseRowTime`,
  no staleness); a throwing rebuild installs the poisoned validator so the listener
  never fails the triggering DDL.

The `matchOwnName` branch is load-bearing for the rename case: an FK-parent /
CHECK-target rename rewrites the maintained table's own FK `referencedTable` / CHECK
AST in place (`rewriteTableForTableRename`, `alter-table.ts`) and fires
`table_modified` on the maintained table itself — the old dependency name is already
gone from the catalog, so the dependency-set match alone would miss it.

## Behaviors (all covered by tests)

- Rename FK parent / subquery-CHECK target → validator re-resolves against the new
  name; valid writes flow, violations attribute to the maintained table.
- Drop FK parent → absent-parent null-guards fallback (non-NULL ref fails the
  maintained-table FK constraint; NULL admitted under MATCH SIMPLE).
- Drop subquery-CHECK target → poisoned validator surfaces a clear sited
  `Table '…' not found`, not a module-connect failure.
- Re-create a dropped dependency → `table_added` rebuild self-heals.

## Review findings

### Checked
- **Read the full implement diff fresh** before the handoff: `derived-row-validator.ts`,
  `database-materialized-views.ts`, the spec, the 51.8 sqllogic, the doc paragraph.
- **Verified every "key ordering fact" the handoff claimed** against the actual code:
  - FK-parent/CHECK-target rename: `runRenameTable` adds the renamed parent to the
    catalog (`alter-table.ts:198`) before `propagateTableRenameInSchema` →
    `rewriteTableForTableRename` rewrites the child maintained table's FK/CHECK and
    fires `table_modified` on the maintained table (`alter-table.ts:1451`). The
    own-name rebuild then reads the rewritten record via `getMaintainedTable`
    (`manager.ts:662`, which reads the live schema store after `schema.addTable`). ✔
  - Drop: `SchemaManager.dropTable` removes from the catalog (`manager.ts:1336`)
    before firing `table_removed` (`manager.ts:1347`) → rebuild sees the parent
    absent → null-guards fallback. ✔
  - `emitBackingInvalidation` fires `table_modified` on the maintained table's OWN
    name AFTER `releaseRowTime`, so the own-name rebuild is a correct no-op there
    (plan already gone from `rowTime`). ✔
- **Imports** (`QuereusError`, `StatusCode`) present; `this.ctx as unknown as
  Database` cast mirrors the pre-existing registration call (line 611), not a new
  smell.
- **Ran** lint (0 errors / 0 warnings), the targeted spec, the 51.8 sqllogic, and
  the full suite — see below.

### Found / done
- **No correctness bugs.** The implementation matches its documented ordering
  claims; the logic is sound and well-decomposed.
- **Minor (fixed inline): test floor.** The per-plan rebuild loop in
  `rebuildConstraintValidatorsFor` was only ever exercised with a *single* matching
  plan. Added two cases to `maintained-table-declared-constraints.spec.ts`:
  - *shared dependency across plans* — one FK parent shared by two maintained
    tables; a single rename must rebuild BOTH validators.
  - *rebuild preserves existing maintained rows* — an FK-parent rename leaves
    pre-existing backing rows intact and still validates subsequent writes.
  Spec now 18 passing (was 16).
- **Minor (resolved): store-mode gap.** The handoff flagged that `test:store` was
  not run. Ran the 51.8 sqllogic under the LevelDB store module
  (`QUEREUS_TEST_STORE=true`, grep-scoped to that file) — **passes**. The fix is
  engine-core / module-agnostic (schema-change events fire identically regardless of
  backing), and this confirms ALTER RENAME / DROP exercise the same path under store.

### Considered, left as-is (acceptable, documented)
- **Poisoned check is inline (statement-immediate)** vs the original deferred CHECK
  (at-commit) — intentional per the ticket; a violation surfaces fail-fast, which is
  acceptable for an unvalidatable constraint.
- **A dropped subquery-CHECK target poisons the WHOLE validator** (a co-resident
  healthy FK check is dropped too). Harmless: every write is rejected while poisoned
  anyway, and the full FK+CHECK validator is rebuilt on re-create.
- **`buildDerivedRowValidator` could in theory return `undefined` on rebuild**
  (silently disabling validation), but only if the MV's own constraints vanished —
  which a dependency-only DDL never does. Not reachable in practice.
- **`plan.mv` not refreshed on rebuild** — confirmed no maintenance arm reads
  `plan.mv`'s FK/CHECK metadata, so the validator-only rebuild is sufficient.
- **Per-event O(plans) scan** — consistent with the existing source loop; small-N.
- **Untested edge cases** (low risk): cross-schema / attached-schema dependency
  naming, and a determinism-pragma-gated CHECK re-running its gate at rebuild time.

### Disposition
No major findings → no new fix/plan tickets filed. Minor findings fixed inline.

## Validation performed
- `yarn workspace @quereus/quereus lint`: 0 errors, 0 warnings.
- `maintained-table-declared-constraints.spec.ts`: **18 passing** (16 original + 2
  new edge cases).
- `51.8-maintained-table-declared-constraints.sqllogic`: passing in **memory** AND
  **store (LevelDB)** mode.
- Full `yarn workspace @quereus/quereus test`: **5998 passing, 9 pending, 0
  failing**.
