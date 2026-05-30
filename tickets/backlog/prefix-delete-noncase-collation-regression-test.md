description: Add a regression test that locks in the `'prefix-delete'` lateral-TVF fan-out maintenance arm's correctness under a NON-binary-collation base primary key. The `delete-by-prefix` MaintenanceOp early-terminates its prefix scan on a BINARY comparison (`scan-layer.ts`), while the backing btree orders the base-PK prefix by the column's declared collation. This was reviewed as reasoned-sound (the backing base-PK column inherits the source PK collation, and source-PK uniqueness collapses each collation class to a single binary value, so a base row's fan-out rows are binary-homogeneous and contiguous) but is currently UNTESTED — the existing harness uses integer/binary PKs only.
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/test/vtab/maintenance-prefix-delete.spec.ts
----

# Regression test: non-binary base-PK collation for the prefix-delete arm

## Why

The lateral-TVF fan-out maintenance arm (`'prefix-delete'`, shipped in
`materialized-view-rowtime-prefix-delete-lateral-tvf`) deletes a changed base row's whole
backing fan-out slice via the `delete-by-prefix` `MaintenanceOp`. That op range-scans the
primary btree using `scanLayer`'s `equalityPrefix` and **early-terminates on a binary prefix
comparison** (`scan-layer.ts`, `compareSqlValues(keyArr[i], plan.equalityPrefix[i])` with no
collation argument), while the btree itself orders the base-PK prefix by the column's declared
collation.

Review concluded this is **sound** for this arm — distinct from `lookupCoveringConflicts`,
which gates OFF non-binary collation for a superficially-similar fast path — because:
1. the backing base-PK column's collation is derived from the source PK column (so the btree
   order matches the value the delete prefix is built from), and
2. under a non-binary base-PK collation, `T`'s PK uniqueness collapses each collation class to
   a single binary value, so a base row's fan-out rows are binary-homogeneous and contiguous;
   under binary collation no collation-equal/binary-different base rows can interleave.

The conclusion is reasoned but **not exercised by any test** (the property-oracle equivalence
suite and the unit/diagnostic specs all use integer PKs). This ticket adds the missing coverage
so a future change to the collation-derivation invariant or the scan early-term can't silently
regress the arm.

## What to add (use cases / expectations)

- A lateral-TVF fan-out MV whose **base PK is `text collate nocase`** (with a separate integer
  column driving `generate_series`), e.g.:
  `create table t (id text collate nocase primary key, n integer); create materialized view mv as select t.id, f.value from t cross join lateral generate_series(1, t.n) f;`
  Then exercise insert / grow / shrink / base-PK-changing update (incl. a case-only rewrite of
  `id`, e.g. `'abc'` → `'ABC'`, which is the *same* PK under nocase) / delete, asserting
  `read(MV) == evaluate(body)` and reads-own-writes + rollback — the same shape the
  `maintenance-equivalence.spec.ts` lateral suite already uses, just with a text-nocase PK.
- A **layer-level** unit case in `maintenance-prefix-delete.spec.ts` with a composite PK whose
  leading column is `text collate nocase`, confirming `delete-by-prefix` removes exactly the
  slice and leaves siblings untouched (this confirms the safe/contiguous case directly).
- Optionally extend `53-materialized-views-rowtime.sqllogic` with a small nocase base-PK section
  mirroring §23.

## Note on scope / limitation
A layer-level test can only confirm the *safe* case (a nocase leading PK collapses
collation-equal values to one, so the interleaving hazard cannot arise there). The only way the
hazard could manifest is a backing-column collation MORE permissive than the source's, which the
MV backing-column type derivation is believed to prevent. If feasible, also add an assertion (or
a comment-documented invariant check) that the backing base-PK column collation equals the
source PK column collation at plan-build time, so the soundness precondition is enforced rather
than merely assumed.
