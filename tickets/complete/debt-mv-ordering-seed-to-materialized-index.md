description: When a materialized view is sorted by a column and that source column later starts allowing blanks, the view used to refuse blank values; its stored copy now accepts them like any other column, and the special-case guards are gone.
architecture: docs/materialized-views.md#refresh-materialized-view
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts      # describeBackingShapeMismatch, classifyBackingReshape recordAttrShift, computeBackingPrimaryKey NOTE, rawReadingIsTheLiveOne doc
  - packages/quereus/src/core/database-materialized-views-apply.ts      # row-time guard removed
  - packages/quereus/src/core/database-materialized-views.ts            # guard call + doc comments
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts  # computeNullGuardColumns removed
  - packages/quereus/src/core/database-materialized-views-plans.ts      # MaintenancePlanCommon.nullGuardColumns removed
  - packages/quereus/src/schema/derivation.ts                           # ordering field comment
  - packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic  # §16f
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts     # old-policy tests removed
  - packages/quereus/test/mv-backing-normalize-shape.spec.ts            # one test updated to the new flow
  - docs/materialized-views.md                                          # physical-vs-logical note, "Loosening a key column" paragraph
----

# Retired the "backing primary-key columns stay NOT NULL" policy

## What landed

A materialized view's backing table used to keep every physical primary-key column NOT NULL, even after its source column was loosened with `alter … drop not null`. That policy lived in two masks (`describeBackingShapeMismatch`, `classifyBackingReshape`'s `recordAttrShift`) and needed two loud guards (`assertNoNullInNotNullSeededPk` on refresh, `assertNoNullInNotNullSeededPkRowTime` + `plan.nullGuardColumns` at row time) to stop a NULL reaching a declared-NOT-NULL column. All of it is removed (`isPhysicalPkColumn`, `computeNullGuardColumns`, `nullInNotNullSeededPkError` too). Physical-key backing columns now follow the body's derived nullability like any other backing column.

The ordering seed (`computeBackingPrimaryKey` leading the physical key with the body's `order by` columns) is kept, now with an accepted-tradeoff `NOTE:`: it is the lens clustered-index model, covering-UNIQUE enforcement's prefix seek depends on it, and the lateral-TVF prefix-delete arm reads it. A separate secondary index was considered and declined at plan stage.

Behaviour: `drop not null` on a column the backing key leads with now marks the view stale (same as any projected column); `refresh` takes the reshape arm, emits a metadata-only `loosenNotNull` on the key column with the primary key unchanged, stores the NULL rows, and row-time maintenance resumes. Trade-off: before, such a view stayed live and rejected only actual NULLs; keeping it live is `backlog/feat-mv-drop-not-null-loosens-backing-in-place`.

## Review findings

Read the `ticket(implement): debt-mv-ordering-seed-to-materialized-index` diff first, then the handoff.

- **Correctness of removal — checked, no issue.** No remaining references to any removed symbol in `packages/*/src`, tests or docs (the only hits are in the git-ignored `dist/`). With the masks gone, `describeBackingShapeMismatch` and `classifyBackingReshape` treat key and non-key columns identically; tightening is unchanged.
- **Replacement invariant (handoff asked for a second look) — confirmed.** Every path that keeps or makes a view live compares nullability exactly via `backingNotNullMatches`: live recompile (`describeBackingShapeMismatch`, and the relaxed superkey fallback still requires `backingColumnsStructurallyMatch`, which checks not-null), rename restore (`describeBackingShapeMismatch` at both the restore loop and `renameBackingColumns`, which throws on mismatch), import adopt (`tryAdoptPreExistingBacking` → `backingShapeMatches`), and `set maintained as` / declared-shape attach (`describeAttachShapeMismatch`, exact both ways). The refresh fast path is gated on `backingShapeMatches`, so a NOT-NULL backing column can no longer receive rows from a body that derives it nullable.
- **Covering-UNIQUE over a now-nullable leading key column — resolved by inspection (handoff listed it as an untested gap).** It does not rely on the prefix seek treating NULL as a key value: both backends skip a UNIQUE check whose new-row values contain a NULL before reaching the covering lookup (`vtab/memory/layer/manager.ts` `uc.columns.some(… === null)` before `checkUniqueViaMaterializedView`; `quereus-store/src/common/store-table-constraints.ts` the same before `findUniqueConflictFor`). Existing NULL rows in the backing never match a non-NULL prefix seek. No test added — the NULL skip is pre-existing behaviour already pinned elsewhere.
- **Declared-shape maintained tables (`create table … maintained as … order by x`) — noted, no action.** A source `drop not null` on a declared key column now reshapes the declared table's column to nullable on refresh, as it already did for declared non-key columns. Consistent with existing behaviour; not a new class.
- **Tests — accepted as changed.** §16f in `53-materialized-views-rowtime.sqllogic` is the reproduction (failed on the old code at the NULL insert) and covers the store `alterTable … setNotNull: false` on a key column. Agreed with deleting the two extra `expressible in place` tests: they pinned the retired policy, and with the special case gone the combined add-column + loosen case goes through the same unconditional `recordAttrShift` branch §16f exercises — a rewritten test would restate the implementation. The updated `mv-backing-normalize-shape.spec.ts` test still pins the property it exists for (collation not re-keyed to the module's NOCASE).
- **Docs — checked.** `docs/materialized-views.md` (physical-vs-logical note, "Loosening a key column" paragraph, coarsened-key paragraph), `docs/mv-schema-change.md` (structural ALTER: a projected not-null change is caught by the shape gate — still accurate), `docs/schema.md` (`logicalKey`/`ordering`), `docs/lens-constraints.md` — all match the new behaviour; no edits needed.
- **Minor, fixed inline:** the `postApplyBackingChanges` front-half doc comment in `core/database-materialized-views.ts` was left as a dangling "— the bulk … scan" fragment with an over-long line after the guard sentence was cut; reworded into one sentence.
- **Tripwires / new tickets:** none. Persisted store backings from before this change that kept a key column NOT NULL against a nullable derived shape will drop + refill on reopen — accepted (no backwards compatibility yet).
- **Validation:** `yarn workspace @quereus/quereus lint` — exit 0. `yarn workspace @quereus/quereus test` — 11182 passing, 23 pending, 0 failing. Store: `QUEREUS_TEST_STORE=true` logic run filtered to the materialized-view / `mv-` sqllogic files (includes `53-materialized-views-rowtime.sqllogic`) — 12 passing. Full `yarn test:store` not run (wall-clock).
