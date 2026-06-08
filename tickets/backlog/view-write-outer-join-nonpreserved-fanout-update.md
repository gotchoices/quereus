description: Updating a NON-preserved (outer-join null-extended) view column across multiple preserved rows that share one non-preserved partner ("fan-out") fails at the base op with "Scalar subquery returned more than one row". The matched-update path reads its captured SET value via a scalar subquery correlated by the NON-preserved side's PK; a shared partner makes that read multi-valued. Pre-existing limitation, independent of RETURNING — surfaced while reviewing `view-write-outer-join-nonpreserved-returning`.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## Symptom

For an outer-join write-through view whose **non-preserved** side is shared by several
**preserved** rows (e.g. a parent shared by multiple children), an update of a
**non-preserved column** that touches more than one of those preserved rows fails at
runtime:

```sql
-- npv: select c.cc, c.cv, p.pv from np_child c left join np_parent p on p.pp = c.pr
-- np_parent (10, 100); np_child (1,10,…),(4,10,…)  -- both children share parent pp=10
update npv set pv = 5 where cc in (1, 4);
-- → error: "Scalar subquery returned more than one row"
```

A **preserved**-column update over the same fan-out (`set cv = …`) works fine — only the
**non-preserved**-column path is affected. The failure occurs with or without `returning`,
so it is independent of the RETURNING re-query (which the
`view-write-outer-join-nonpreserved-returning` ticket fixed); that ticket's fan-out
RETURNING coverage deliberately updates a *preserved* column to sidestep this.

## Root cause

The non-preserved-column matched-update branch in `decomposeUpdate`
(`multi-source.ts` ~line 1437) lowers the assigned value to a captured expression and reads
it back per target row via `capturedValueSubquery(valAlias, npSideIndex, requireKeyColumns(npSide))`
— a **scalar** subquery `(select <valAlias> from __vmupd_keys k where k.k<npSide>_<j> = <pk>)`
correlated by the **non-preserved** side's PK. The shared identity capture carries one row
per affected *view* row (one per preserved row), so when N preserved rows share one
non-preserved partner, that partner's PK matches N capture rows and the scalar read returns
N values → "Scalar subquery returned more than one row".

The same captured value is identical across those N rows (it is the single SET value), so
the read is logically a no-op de-dup, but the scalar-subquery shape does not express that.

## Possible directions (for the planner of this ticket — not prescriptive)

- De-duplicate the captured value per non-preserved PK before the read (e.g. `min`/`max`/
  `distinct` aggregate, or capture keyed by the non-preserved PK rather than per view row),
  so the correlated read is single-valued by construction.
- Or restructure the matched non-preserved-column update to drive off the non-preserved
  side's own identity (one update per distinct partner) instead of per preserved row.
- Verify interaction with the null-extended **materialization** insert over the same
  fan-out (`buildNullExtendedInsert`): two preserved rows with the *same dangling join key*
  would both try to materialize the same partner row — confirm the de-dup/insert path does
  not double-insert or PK-conflict.

## Acceptance

- `update <view> set <non-preserved-col> = <v> where <preserved> in (…)` across a shared
  non-preserved partner applies once per affected view row and succeeds (no scalar-subquery
  multi-row error), with and without `returning`.
- The shared-partner materialization fan-out (distinct preserved rows, same dangling key)
  behaves correctly (no double-insert / PK conflict).
- Coverage in `property.spec.ts` (LEFT `npv` + RIGHT `rnpv` mirror) and a sqllogic section;
  update `docs/view-updateability.md` § Outer Joins to drop the limitation note once fixed.
