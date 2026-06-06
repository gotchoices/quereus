description: Materialize + enforce an inline column-level UNIQUE on `ALTER TABLE … ADD COLUMN <col> … UNIQUE` (previously silently dropped), routing it through the same module `addConstraint` UNIQUE path as `ALTER TABLE … ADD CONSTRAINT … UNIQUE`. A latent `dropColumn` bug (dangling unique constraint + orphan covering index over a dropped column) was also fixed, since the ADD COLUMN revert path depends on it. Reviewed and completed.
files:
  - packages/quereus/src/schema/constraint-builder.ts            # extractColumnLevelUniqueConstraints (@~168)
  - packages/quereus/src/runtime/emit/alter-table.ts             # runAddColumn inline-UNIQUE block (@~344)
  - packages/quereus/src/vtab/memory/layer/manager.ts            # dropColumn: prune uniqueConstraints + tear down covering index (@~1507)
  - packages/quereus-store/src/common/store-module.ts            # dropColumn arm: prune uniqueConstraints over dropped col (@~758)
  - packages/quereus/test/logic/41.3-alter-add-column-unique.sqllogic   # cross-module logic test (+ scenarios 6-8 added in review)
  - packages/quereus/test/logic/50-metadata-tags.sqllogic        # Phase 24 c5 inline-UNIQUE-tag round-trip
  - docs/sql.md                                                  # ADD COLUMN + DROP COLUMN UNIQUE notes
----

# Completed: materialize + enforce inline UNIQUE on ALTER TABLE ADD COLUMN

## Summary

Inline column-level UNIQUE on `ALTER TABLE … ADD COLUMN` is now materialized, enforced, and
(store) persisted — symmetric with CREATE TABLE — by converting each inline `unique`
ColumnConstraint into an equivalent single-column table-level constraint
(`extractColumnLevelUniqueConstraints`) and feeding it through the module's `addConstraint`
UNIQUE path, the same path `ALTER TABLE … ADD CONSTRAINT … UNIQUE` uses. The block runs after the
column is materialized and before the first engine-catalog `addTable`, so a UNIQUE failure (e.g. a
literal DEFAULT duplicated across existing rows) drops the just-added column from the module and
rethrows with the catalog untouched. The supporting `dropColumn` fix prunes any UNIQUE referencing
the dropped column from both the memory and store modules.

The implementation was sound. The review added one bug fix, three test scenarios, a docs note, and
confirmed a pre-existing (unrelated) store-suite failure.

## Review findings

### Reviewed (what was checked)
- **Implement diff, read first** (`git show 534f08a3`): constraint-builder extractor, runAddColumn
  inline-UNIQUE block + revert, memory & store `dropColumn` pruning, the two `.sqllogic` tests, docs.
- **Cross-path consistency**: confirmed inline UNIQUE now reuses the exact `module.alterTable({addConstraint})`
  path as ADD CONSTRAINT (memory `addUniqueConstraint`, store `addConstraint` UNIQUE arm), and that
  both validate existing rows directly against module storage (not via the engine SQL layer) — so the
  engine catalog being un-updated until the later `schema.addTable` is sound.
- **Revert correctness**: traced literal-DEFAULT-duplicate (scenario 4) and combined CHECK+UNIQUE
  (scenario 5) revert paths; both leave no orphan column/constraint/index. The combined-revert relies
  on `dropColumn` pruning the live UNIQUE — verified.
- **Covering-structure keying**: `implicitIndexNameFor` / `uc.name ?? '_uc_<cols>'` convention matches
  `dropConstraint` / `renameConstraint`; the `implicitCoveringStructures` cleanup keys line up.
- **Type safety / DRY / cleanup**: extractor mirrors the sibling CHECK/FK extractors; no `any`; frozen
  schema arrays; covering-structure records cleared on drop.
- **Build + lint + tests**: engine & store `tsc` (build:engine/build:store) clean; `@quereus/quereus`
  lint clean; full memory suite `yarn test` → **4905 passing**, 9 pending; this ticket's store
  assertions pass isolated (`yarn test:store --grep "41.3-alter-add-column-unique"` → 1 passing).

### Found + fixed inline (minor)
- **Orphan covering index on multi-column DROP COLUMN (memory).** The implement-stage `dropColumn`
  comment claimed the dropped UNIQUE's covering index "is already gone from `updatedIndexes`" — true
  only for a *single*-column UNIQUE (its covering index collapses to empty and is filtered). For a
  **multi-column** UNIQUE that includes the dropped column, the constraint was correctly removed but
  its covering index was merely *narrowed* to the surviving columns and **survived as a non-unique
  orphan** in `index_info` (reproduced empirically: dropping `b` from `unique(a,b)` left index
  `uq_ab` over `a`). Uniqueness was not wrongly enforced (the index carries no `unique` flag — the
  dropped `implicitCoveringStructures` record is what enforced it), so this was an orphan-structure
  leak, not data corruption.
  - **Fix** (`manager.ts` `dropColumn`): compute the dropped constraints' covering-index names first
    and exclude them from `updatedIndexes` outright (then shift/prune the rest), mirroring
    `dropConstraint`'s teardown — by the same `uc.name ?? '_uc_<cols>'` convention, so a user index
    that merely shares columns is left untouched. `dropColumnFromBase`'s secondary-index rebuild then
    physically drops the BTree. Comment corrected. Re-probe: `index_info` clean for both cases.
  - Store module needs no equivalent fix: store-backed inline UNIQUE has no separate index store, so
    no covering index can orphan there.
- **Missing direct coverage for standalone DROP COLUMN of a uniquely-constrained column** (flagged in
  the handoff). Added scenarios 6–8 to `41.3-alter-add-column-unique.sqllogic` (pass under memory and
  store): (6) single-column-UNIQUE drop → constraint + covering index gone, table usable; (7)
  multi-column UNIQUE, drop a participating column → whole constraint + its covering index removed, no
  orphan, surviving column unconstrained; (8) multi-column UNIQUE, drop a *non*-participating column →
  constraint survives with shifted indices and still enforces over the correct columns.
- **Docs** (`docs/sql.md` DROP COLUMN): added the UNIQUE-pruning behavior (single vs multi-column,
  covering-index teardown, the SQLite-divergence note) so the docs reflect the solidified reality.

### Found, NOT changed (deliberate / out of scope)
- **Multi-column UNIQUE drop semantics.** Dropping a column that participates in a multi-column UNIQUE
  drops the whole constraint (SQLite rejects the drop outright). This is a defensible, now-documented
  choice consistent with Quereus's more-permissive DROP COLUMN; left as designed, not a blocker.
- **ON CONFLICT on inline UNIQUE** is threaded (`con.onConflict` → synthetic constraint →
  `defaultConflict`) but still lacks a dedicated forward-conflict test. Low-risk (same field plumbing
  as ADD CONSTRAINT); not worth a new ticket — noted as a residual minor gap.
- **Store ADD-COLUMN-CHECK → ADD-CONSTRAINT persistence asymmetry** (handoff item): a pre-existing,
  orthogonal latent inconsistency in how the store persists CHECK across reconnect. Untouched by this
  change; not filed (no new regression introduced here).
- **Direct test of inline UNIQUE landing while a connection holds staged isolation-overlay rows**:
  covered indirectly by store-mode runs (isolated store module). No dedicated direct test added.

### New tickets filed
- None. All review findings were minor and fixed inline.

### Pre-existing failure flagged (not mine)
- `test/logic/41.3-alter-rename-propagation.sqllogic` fails in **store mode** at DB-open with a
  LevelDB `LOCK: being used by another process` IO error (Windows/LevelDB environmental flake).
  Reproduces in complete isolation and at the committed HEAD with all my changes stashed + engine
  rebuilt — definitively independent of this diff. Documented in `tickets/.pre-existing-error.md` for
  the runner's triage pass (the store suite's `--bail` stops at this file).
