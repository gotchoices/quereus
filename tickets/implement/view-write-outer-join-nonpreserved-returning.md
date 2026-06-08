description: Support RETURNING through a non-preserved-side (outer-join null-extended) UPDATE by re-keying the post-mutation RETURNING re-query off the stable preserved-side identity (with a per-non-preserved-side matched-OR-null-extended disjunction), so both matched rows and freshly-materialized null-extended rows surface. Remove the plan-time `returning-through-view` reject in `decomposeUpdate`'s non-preserved-column branch.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, docs/view-updateability.md, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic
----

## Problem (confirmed during planning)

`buildMultiSourceUpdateReturning` (`multi-source.ts:1965`) restricts the post-mutation join body to the captured identities via a correlated EXISTS that conjoins **every side × every PK column** as an exact equality:

```
exists (select 1 from __vmupd_keys k
        where k.k0_0 = s0.pk0 [and k.k0_1 = s0.pk1]
          and k.k1_0 = s1.pk0 …)         -- one equality per side per PK column
```

For a **non-preserved (outer-join null-extended) side** this is wrong in two distinct ways, both because a null-extended row's non-preserved-side PK is **captured NULL** (it had no join partner pre-mutation):

1. **Materialized null-extended row dropped.** The non-preserved-column update materializes a new non-preserved row carrying a real minted PK (`buildNullExtendedInsert`). The capture row still holds NULL for that side, so `NULL = <minted pk>` is never true — the row is silently dropped. This is the reject the ticket removes (`decomposeUpdate` `nullExtended` branch, `multi-source.ts:1444-1451`).

2. **Latent bug — preserved-side update also drops null-extended rows.** Even a *preserved*-side update through a LEFT-join view, with a null-extended row in the affected set and RETURNING present, drops that row today: the capture records `k1_0 = NULL`, the post-mutation join row is still null-extended (`s1.pk0 = NULL`), and `NULL = NULL` evaluates to NULL (not true), so the EXISTS fails. `buildIdentityCapture` captures **all** sides for any RETURNING update (`view-mutation-builder.ts:268`), so this path is reachable but currently has **no test coverage** — it is a real silent partial-set bug the same fix repairs.

## Resolved design — preserved-keyed disjunction

A LEFT/RIGHT join's **preserved** side PK is stable across the mutation and uniquely identifies each view row (the premise that makes the non-preserved column updatable at all). Re-key the RETURNING re-query's identity EXISTS so:

- **Preserved sides** keep the exact per-PK-column equality (today's behavior).
- **Non-preserved sides** use a per-side disjunction:

  ```
  ( <AND_j  k.k<np>_<j> = s<np>.pk<j>>            -- matched: np PK stable, exact match
    OR
    <AND_j  k.k<np>_<j> is null> )                 -- null-extended: identify by preserved PK only
  ```

The full EXISTS predicate is the AND over all sides of (preserved exact-equality | non-preserved disjunction).

### Why this is correct (worked through in planning)

- **Matched row.** Capture np PK is non-null; the matched branch `k.np_pk = s.np_pk` finds exactly the (stable) np row. The null-extended branch is false (np PK non-null). No explicit `is not null` guard is needed — an equality against a null `k` value already evaluates to not-true, so it never leaks into the matched branch.
- **Materialized null-extended row.** Capture np PK is NULL ⇒ matched branch is null/false; null-extended branch (`k.np_pk is null`) is true ⇒ the row is identified by the preserved-side equalities alone. In a LEFT join a preserved row is *either* matched (≥1 partner, never null-extended) *or* null-extended (0 partners); a null-extended preserved row gets **exactly one** materialized partner, so preserved-only matching surfaces exactly that one row — no over-match.
- **Null-key no-op row** (preserved row whose join key is NULL, e.g. `np_child` `pr is null`): still null-extended post-mutation (nothing materialized), null-extended branch true, returns the unchanged image (`pv = null`). This is the correct post-mutation NEW image of an affected row.
- **Fan-out is bounded.** A preserved row P fanning to partners rp1, rp2: a capture row `(P, rp1)` matches only the join row `(P, rp1)` (matched branch `rp1 = rp2` is false for `(P, rp2)`), so a partner *not* in the affected set is never returned, and no row is returned twice. The null-extended branch only ever fires for capture rows whose np PK is NULL — which by construction have zero pre-mutation partners — so it cannot over-match a fanned preserved row.
- **Inner-join parity.** Every side is preserved ⇒ all conditions are exact equalities ⇒ byte-identical to today. No regression.
- **FULL outer join.** A non-preserved-column update on FULL is already rejected upstream by `outerJoinInsertKey` / the no-preserved-anchor materialization logic (`unsupported-outer-join-update` / `null-extended-create-conflict`) before RETURNING is reached, so no special handling is required — removing the `returning-through-view` reject does not open a FULL path.

### Scope boundary — existence-flag RETURNING stays rejected

The **existence-flag** write RETURNING reject (`multi-source.ts:1387-1394`, inside the `out.existenceComponent` branch that `continue`s) is **independent** and stays in place. `set hasB = true` would be recoverable under the disjunction (it materializes, like a column update), but `set hasB = false` deletes the matched partition: the capture holds the OLD non-null np PK while the post-mutation row is null-extended, so neither disjunction branch matches it — genuinely unrecoverable by captured identity. Enabling `hasB = true` RETURNING selectively is out of scope; park it (see Out of scope).

## Edge cases & interactions

- **Matched-only batch** — `update npv set pv = N where <only matched rows>` returning ⇒ exact matched-branch identification (parity with inner-join today).
- **Null-extended-only batch** — `update npv set pv = N where cc = 2` (dangling key) returning ⇒ materialized row surfaced via preserved-keyed null-extended branch.
- **Mixed batch** — a WHERE spanning matched + null-extended (+ null-key no-op) rows returns each row's correct post-mutation image exactly once.
- **`returning *`** — expands to every view output column's base term (`buildReturningProjection` `rc.type === 'all'`), recomputed over the re-keyed filter; the non-preserved column reads back its post-mutation value (materialized) or null (null-key no-op).
- **Fan-out (1:many preserved→non-preserved)** — no duplicate rows, no leakage of unaffected partners (worked through above). Add a fan-out fixture: a preserved row with two matching non-preserved partners, predicate selecting one.
- **Composite preserved PK** — preserved exact-equality must AND all PK columns; reuse `requireKeyColumns`.
- **Multiple non-preserved sides** (chained LEFT joins) — each non-preserved side independently gets its own matched-OR-null disjunction; preserved sides AND exact.
- **Preserved-side update with a null-extended affected row + RETURNING** — the latent bug (#2 above): must now return the null-extended row. This requires NO code beyond the same disjunction (the non-preserved side is captured but unwritten; its disjunction's null-extended branch surfaces the row).
- **Idempotent GetPut** — re-running the update with each row's own returned `pv` leaves the whole view image unchanged (the existing `npv` GetPut assertion, extended with RETURNING).
- **NULL semantics** — the matched branch must rely on SQL null-comparison (`null = x` ⇒ not-true) rather than an added `is not null` guard, so a matched capture row and a null-extended capture row are disjoint without extra predicates. Confirm three-valued logic holds in `combineAnd`/`OR` AST as built.
- **RIGHT-join mirror** — the substrate keys off per-row `nullExtended`/`sideIndex`, not source order, so the RIGHT `rnpv` test must pass the identical RETURNING assertions (mirror of LEFT).

## Implementation

The change is localized to the EXISTS-predicate construction in `buildMultiSourceUpdateReturning` (`multi-source.ts:1980-1990`); the capture itself is unchanged (it already projects every side's PK for a RETURNING update — `view-mutation-builder.ts:268`). Build the per-side AST with the existing idioms: `combineAnd` for AND, `{ type: 'binary', operator: 'OR', left, right }` for OR, and `{ type: 'unary', operator: 'IS NULL', expr }` for the null test (mirror `buildNullExtendedInsert` `multi-source.ts:1678-1680`). `requireKeyColumns(view, side)` is already in-scope.

## Acceptance

- `update <leftjoinview> set <nonpreserved> = … returning …` returns matched + materialized + null-key-no-op rows with their correct post-mutation image.
- The `returning-through-view` reject in `decomposeUpdate`'s non-preserved-column `nullExtended` branch (`multi-source.ts:1444-1451`) is removed.
- The existence-flag RETURNING reject (`multi-source.ts:1387-1394`) and the FULL-join rejects are unchanged.
- Inner-join RETURNING and existing multi-source RETURNING tests stay green (parity).
- `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint` pass.

## TODO

- Rewrite the EXISTS predicate in `buildMultiSourceUpdateReturning` (`packages/quereus/src/planner/mutation/multi-source.ts`): preserved sides → exact per-PK equality (unchanged); non-preserved sides → `(AND_j k.k<np>_<j> = s<np>.pk<j>) OR (AND_j k.k<np>_<j> is null)`. Update the function's doc comment to describe the preserved-keyed disjunction and the null-extended recovery.
- Remove the `returning-through-view` reject in `decomposeUpdate`'s `out.nullExtended` branch (`multi-source.ts:1444-1451`) and the now-stale comment block above it; keep the existence-flag RETURNING reject.
- Property tests (`packages/quereus/test/property.spec.ts`, LEFT `npv` test ~4924 and RIGHT `rnpv` test ~5005): replace each `expectMutationReject(... returning ..., 'returning-through-view')` with positive assertions:
  - matched-only RETURNING (`update npv set pv = 444 where cc = 1 returning cc, pv` ⇒ `[{cc:1, pv:444}]`).
  - null-extended materialization RETURNING (`... where cc = 2 returning cc, cv, pv` ⇒ the materialized image).
  - null-key no-op RETURNING (`... where cc = 3 returning cc, pv` ⇒ `[{cc:3, pv:null}]`).
  - mixed-batch RETURNING (`... where cc in (1,2,3) returning cc, pv`, order-insensitive) and `returning *`.
  - GetPut idempotence using the returned `pv`.
- Add a **fan-out** fixture (a preserved child whose join key matches two non-preserved partners — or, since the supported np shape is child→single-parent, a parent shared by two children selected together) asserting RETURNING returns each affected view row once with no unaffected partner leaked.
- Add a **preserved-side update + null-extended row + RETURNING** regression (the latent bug #2): `update npv set cv = 99 where cc in (1,3) returning cc, cv, pv` must include the null-extended `cc=3` row (`pv = null`).
- Add sqllogic coverage in `packages/quereus/test/logic/93.4-view-mutation.sqllogic` near the existing RETURNING / outer-join sections: a LEFT-join non-preserved `update … returning` over matched + null-extended rows, and `returning *`.
- Update `docs/view-updateability.md` § `returning` Clauses (lines ~587-589): document that the multi-source UPDATE re-query keys preserved sides by exact PK equality and non-preserved sides by a matched-OR-null-extended disjunction, so materialized null-extended rows (and preserved-side updates touching null-extended rows) surface; note that a base-PK / join-key rewrite still drops a matched row, and that existence-flag `set hasB = false` RETURNING remains rejected.
- Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/vrt.log; tail -n 60 /tmp/vrt.log` and the lint script; fix any fallout.

## Out of scope (park in backlog if pursued)

- **Existence-flag `set hasB = true` RETURNING.** Recoverable under the disjunction (materialization), but `hasB = false` is not; selectively enabling only the `true` direction (statically known from the boolean literal) is a separate, smaller follow-up. Leave the uniform existence-flag RETURNING reject in place.
- FULL-outer write-through (and thus its RETURNING) remains deferred.
