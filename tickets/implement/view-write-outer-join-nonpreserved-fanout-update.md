description: Fix the "Scalar subquery returned more than one row" failure (and the mirrored materialization PK-conflict) when updating a NON-preserved (outer-join null-extended) column across multiple preserved rows that share one non-preserved partner ("fan-out"). Both the matched-update captured-value read-back and the null-extended materialization INSERT must de-dup per non-preserved partner so the write applies once. Root-caused and prototype-validated in the fix stage.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## Summary

For an outer-join write-through view whose **non-preserved** side is shared by several
**preserved** rows (a parent shared by multiple children), an UPDATE of a **non-preserved
column** that touches more than one of those preserved rows fails at runtime in two
mirrored ways, both confirmed reproducing in the fix stage:

- **Matched fan-out** (shared *existing* partner): `update npv set pv = 5 where cc in (1,4)`
  where children 1 and 4 both join parent `pp=10` → **`Scalar subquery returned more than
  one row`** (code 1).
- **Materialization fan-out** (shared *dangling* key, both null-extended): two children with
  the same non-existent `pr` → **`UNIQUE constraint failed: np_parent PK`** (code 19), the
  double-insert the fix ticket warned to verify.

A **preserved**-column update over the same fan-out (`set cv = …`) already works — only the
**non-preserved**-column path is affected. The failure is independent of RETURNING.

## Root cause

In `decomposeUpdate` (`multi-source.ts`), the non-preserved-column matched-update branch
(~line 1426) lowers the assigned value to a captured `__vmupd_keys` column (`valAlias`) and
reads it back **per target row** via a **scalar** subquery correlated by the non-preserved
side's PK:

```ts
perSide[out.sideIndex].push({ column: out.baseColumn,
  value: capturedValueSubquery(valAlias, out.sideIndex, requireKeyColumns(view, npSide)) });
```

`capturedValueSubquery` (~line 2394) builds `(select <valAlias> from __vmupd_keys k where
k.k<np>_0 = <pk>)`. The capture carries **one row per affected view row** (one per preserved
row), so when N preserved rows share one non-preserved partner, that partner's PK matches N
capture rows → the scalar read returns N values → the runtime error.

The mirror: `buildNullExtendedInsert` (~line 1638) materializes the missing partner with
`insert into <np> (<joinKey>, <cols…>) select k.<jk>, k.<val…> from __vmupd_keys k where
<np PK all null> and k.<jk> is not null`. N preserved rows sharing one dangling key project N
rows with the **same** join key → N inserts of the same partner PK → the UNIQUE conflict.

In both cases the captured value is identical across the N rows for a **constant / np-only**
SET value (a logical no-op de-dup), but the scalar-subquery / per-row-insert shapes do not
express that.

## Fix (prototype-validated)

De-dup per non-preserved partner so each read/insert is single-valued by construction —
the fix ticket's first suggested direction. Validated end-to-end against both reproductions
in the fix stage; the exact diff below made both pass (`pv=5` applied once to the shared
parent; one `pp=99,pv=7` partner materialized, no PK conflict):

1. **Matched read-back** — wrap the captured-value read in a `min` aggregate so the
   correlated scalar is single-valued. Thread an optional `dedupAggregate` param through
   `capturedValueSubquery` (the **shared** helper — the cross-source `set` callers must keep
   the bare-column form, so the param defaults off; only the np matched-update site passes
   `'min'`):

   ```ts
   // capturedValueSubquery(srcAlias, owningSideIndex, owningPk, dedupAggregate?)
   //   dedupAggregate ? min(k.<srcAlias>) : k.<srcAlias>
   perSide[out.sideIndex].push({ column: out.baseColumn,
     value: capturedValueSubquery(valAlias, out.sideIndex, requireKeyColumns(view, npSide), 'min') });
   ```

2. **Materialization INSERT** — `group by k.<jkAlias>` and wrap each value projection in
   `min`, so exactly **one** partner row materializes per distinct dangling join key:

   ```ts
   // projection per assigned col: min(k.<valAlias>) as <baseColumn>
   // select … from __vmupd_keys k where <np PK all null> and k.<jk> is not null
   //   group by k.<jkAlias>
   ```

   (The join-key projection `k.<jkAlias>` is the GROUP BY key; the value columns are `min`.)

**Why `min` is correct and uniform.** For a constant / np-only-valued SET, the captured value
is identical across the shared-partner group, so `min` is an exact no-op de-dup (the ticket's
"logically a no-op"). For a value that genuinely **differs** per preserved row (`set pv = cv`,
a *preserved*-column read over a shared partner — inherently ambiguous which child wins, the
mirror of the inner-join cross-source 1:many case), `min` resolves it deterministically rather
than erroring at runtime; using the **same** `min` de-dup on both the matched read-back and
the materialization GROUP BY keeps the two branches consistent (the materialization can no
longer PK-conflict on a divergent value either). This is the documented semantics, not a
silent corner — see § Docs below. (A stricter alternative — *rejecting* a preserved-column
read over a shared partner at plan time, mirroring `cross-source-ambiguous-cardinality` — is
**not** recommended here: "np side joins ≥2 preserved rows" is the *normal* parent→child
cardinality, so the gate would over-reject the common 1:1 case; `min` de-dup is the honest,
non-over-rejecting choice. Note this scope decision in the review handoff.)

## Validation seen in the fix stage

Reproduced both failures, applied the diff above, both passed:

```
CASE1 (matched fan-out)        before: FAIL "Scalar subquery returned more than one row"
CASE1                          after:  OK  [{cc:1,cv:1000,pv:5},{cc:4,cv:4000,pv:5}]
CASE2 (materialization fan-out) before: FAIL "UNIQUE constraint failed: np_parent PK."
CASE2                          after:  OK  parents=[{pp:99,pv:7}], both children read pv=7
```

## Acceptance

- `update <view> set <non-preserved-col> = <v> where <preserved> in (…)` across a **shared
  existing** non-preserved partner applies once and succeeds (no scalar-subquery multi-row
  error), with and without `returning`.
- The same UPDATE across a **shared dangling** key (multiple null-extended preserved rows,
  one missing partner) materializes the partner **once** (no double-insert / PK conflict).
- LEFT (`npv`) and RIGHT (`rnpv`) mirrors both covered (the substrate keys off
  `JoinSide.preserved`, not source order, so the mirror must hold identically).
- No regression in the existing non-preserved-update / RETURNING / existence-flag suites.

## TODO

- In `multi-source.ts`: add the optional `dedupAggregate?: string` param to
  `capturedValueSubquery` (wrap the projected `k.<srcAlias>` in `{ type:'function',
  name: dedupAggregate, args:[colRef] }` when set; default off so cross-source callers are
  byte-identical). Pass `'min'` at the np matched-update push (~line 1453).
- In `buildNullExtendedInsert` (~line 1638): wrap each assigned-value projection in a `min`
  function call and add `groupBy: [{ type:'column', name: jkAlias, table:'k' }]` to the
  materialization select. Leave the join-key projection as the bare grouped column.
- `property.spec.ts`: add a matched-fan-out assertion (`set pv = …` across `cc in (1,4)`
  sharing parent `pp=10`) and a materialization-fan-out assertion (two null-extended children
  sharing one dangling `pr`, partner materialized once) to the LEFT `npv` block, and the
  mirror to the RIGHT `rnpv` block. Remove / update the "pre-existing limitation … out of
  scope" comment near the existing `set cv = 7` fan-out test (~line 5778-5780) now that the
  non-preserved fan-out works. Cover both with and without `returning`.
- `test/logic/93.4-view-mutation.sqllogic`: add a sqllogic section exercising the matched +
  materialization non-preserved fan-out (LEFT and, if the file already mirrors RIGHT, RIGHT).
- `docs/view-updateability.md` § Outer Joins: in the non-preserved-side UPDATE description
  (the "How the non-preserved-side UPDATE is realized" note), state that the matched read-back
  and the materialization INSERT **de-dup per non-preserved partner** (`min` read-back / GROUP
  BY join key), so a shared-partner fan-out applies once; note the divergent-value (preserved-
  column read over a shared partner) `min`-resolves deterministically. Drop any now-stale
  limitation phrasing.
- Run `yarn workspace @quereus/quereus test` (or the property + 93.4 logic subsets) and
  `yarn workspace @quereus/quereus lint` before handing to review.
