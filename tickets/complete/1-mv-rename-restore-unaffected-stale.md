----
description: Restoration pass that revives dependent MVs an ALTER … RENAME marked stale but provably did not affect (unreferenced column rename, constraint-only rewrite of another source, `select *` pure name shift), instead of leaving them silently stale with writes no longer propagating. Implemented and reviewed.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # restoreUnaffectedMaterializedViews, restoreMaterializedViewLive (shared restore tail), sameSourceTables guard (review), renameShiftedBackingColumns (+preDerivedShape)
  - packages/quereus/src/runtime/emit/alter-table.ts                 # propagateTableRename / propagateColumnRename call the pass after the per-schema loops
  - packages/quereus/test/logic/53.2-materialized-view-rename-propagation.sqllogic   # §10–§12 (implement), §13 chained mid-pass cascade (review)
  - packages/quereus/test/mv-rename-propagation.spec.ts              # persistent-failure + transient-failure-healed tests
  - docs/materialized-views.md                                       # "Provably-unaffected restoration" bullet in § Rename propagation
----

# Restore provably-unaffected MVs after a source rename — complete

## What was built (implement stage)

`restoreUnaffectedMaterializedViews(db, preStale)` runs once at the end of
`propagateTableRename` / `propagateColumnRename` (after all per-schema rewrite
loops and their cascade events). For every MV across all schemas that is stale
now but was not stale at the pre-statement snapshot, it re-derives the backing
shape from the body against the renamed catalog; a plan failure or structural
mismatch leaves the MV stale (REFRESH owns recovery), otherwise the shared
restore tail `restoreMaterializedViewLive` carries any pure name shift onto the
live backing (`renameShiftedBackingColumns`), re-registers row-time maintenance,
and clears `stale` (register-before-clear). The tail is shared with the
changed-AST rewrite path (`applyMaterializedViewRewrite`) so the restore
discipline cannot drift. No `materialized_view_modified` fires from the pass —
the MV record is unchanged; `stale` is runtime state, not persisted.

Covers the three silently-stale shapes: a column rename the body never
references (§10), a rename whose only effect on another source is an FK
constraint rewrite firing that source's `table_modified` (§11), and a `select *`
body whose output is a pure name shift carried onto the backing (§12).

## Review findings

**Checked** (against the implement diff `64d34607`, read before the handoff):

- **Emit ordering**: verified all statement notifies (base-table rename, FK/CHECK/
  index rewrites on other tables, view rewrites, MV rewrites, backing renames,
  cascade events) fire inside the per-schema loops; the restore pass runs strictly
  last in both `propagateTableRename` and `propagateColumnRename`, so nothing can
  re-mark an MV stale after restoration within the statement. No other rename
  entry point bypasses these two functions (the declarative differ applies ALTERs
  through the same emitters).
- **Staleness discipline**: the `stale && !preStale` filter, register-before-clear,
  and the chained-consumer cascade (backing `table_modified` from a producer's
  restore re-marks consumers, which are examined later in creation order) were
  traced through the listener (`subscribeToSchemaChanges` /
  `emitBackingInvalidation`) and `registerMaterializedView` (rebuilds
  `sourceScope`, re-keys `rowTimeBySource` from the re-planned body). Sound.
- **Heal semantics** (the handoff's flagged behavioral change): the retry of a
  failure-marked MV is safe when the catalog record was swapped before the throw
  (the injected-registration-failure case — record consistent, backing
  statement-locally valid). **Found one hole**: a throw *between* the in-place AST
  mutation and the catalog swap (e.g. in `viewDefinitionToCanonicalString` /
  `generateMaterializedViewDDL` — stringifier gaps have historical precedent, cf.
  the `fix-ast-stringify-*` tickets) leaves the OLD record (un-re-keyed
  `sourceTables`, old `sql`) holding a fully-rewritten AST; the retry would plan
  the body fine, match shape, and restore live with a wrong `sourceScope` (watch
  misprojection) and a wrong read-side-rewrite key. **Fixed inline (minor)**: the
  pass now requires set-equality between the recorded `mv.sourceTables` and the
  re-planned `shape.sourceTables` (already computed — zero extra planning) and
  leaves the MV stale on disagreement. Doc bullet extended accordingly.
- **Chained-MV interaction**: a `select *` producer's restore renames its backing
  column mid-pass, re-marking the consumer stale; the consumer (later in creation
  order) is then itself restored when it references only unshifted columns.
  This claimed-but-untested behavior is now locked in by new sqllogic **§13**
  (sensitivity verified: with the pass disabled, the file fails). §6 (broken
  chain stays stale with the diagnostic) still green.
- **Tests run**: `yarn build` clean, `yarn workspace @quereus/quereus run lint`
  clean, full `yarn test` green across all workspaces (5649 passing in quereus),
  53.2 green in both memory and `QUEREUS_TEST_STORE=true` store mode, the
  3 staleness-discipline unit tests green.
- **Docs**: `docs/materialized-views.md` § Rename propagation read end-to-end and
  matches the implementation; swept the other docs (`schema.md`, `sql.md`,
  `architecture.md`, `view-updateability.md`) for stale rename/MV-staleness
  claims — none found (schema.md's differ section is consistent).
- **Type safety / error handling / cleanup**: no `any`, readonly collections,
  best-effort catches log rather than eat, QuereusError + INTERNAL for impossible
  states. Nothing to fix.

**Accepted as-is (with reasons)**:

- `restoreUnaffectedMaterializedViews` checks backing existence + shape mismatch,
  and `renameShiftedBackingColumns` re-checks both (throwing instead of
  continuing). The redundancy is deliberate: the second check is the invariant
  guard of the shared path, whose other caller does not pre-check.
- Cross-schema MV chains: restoration is creation-order per schema, so a
  cross-schema consumer can be examined before its producer restores. In practice
  it still restores when the stale-but-valid producer's body plans; the worst case
  (producer's restore re-marks it after its turn) leaves it conservatively stale
  with REFRESH recovery. Single pass per ticket spec — no fixpoint.
- Persistence edge: a rewrite that throws before `materialized_view_modified`
  fires leaves the store holding the old DDL even when the heal restores the
  in-session state. Pre-existing with or without this ticket (REFRESH does not
  re-persist either); the new `sourceTables` guard narrows the healed population
  to records that were actually swapped, which is exactly the population where
  the event was the only thing skipped.

**Major findings spawning new tickets**: none. The two adjacent gaps — the
constraint-only `table_modified` listener refinement and generalizing the
shape-rederivation restore to non-rename ALTERs (add/drop/alter column) — are
already covered by backlog `mv-staleness-constraint-only-table-modified`, which
this review re-read and confirmed in scope.
