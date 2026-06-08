description: Review the preserved-keyed RETURNING re-query for outer-join non-preserved UPDATEs — `buildMultiSourceUpdateReturning` now keys preserved sides by exact PK equality and non-preserved sides by a matched-OR-null disjunction, so materialized null-extended rows (and preserved-side updates touching null-extended rows) surface; the plan-time `returning-through-view` reject in `decomposeUpdate`'s non-preserved-column branch was removed.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, docs/view-updateability.md, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic
----

## What landed

Implemented per the plan ticket. The change is localized to the EXISTS-predicate construction in `buildMultiSourceUpdateReturning` plus removing one plan-time reject; the capture itself was already all-sides for a RETURNING update (`view-mutation-builder.ts:268`), so it is unchanged.

**`multi-source.ts` — `buildMultiSourceUpdateReturning` (~`multi-source.ts:1990`).** The post-mutation re-query's identity EXISTS is now built per-side and AND'd:
- **preserved** side → exact per-PK-column equality `AND_j k.k<p>_<j> = s<p>.pk<j>` (unchanged — for an all-preserved/inner join every side is exact, so the predicate is byte-identical to before).
- **non-preserved** side → `(AND_j k.k<np>_<j> = s<np>.pk<j>) OR (AND_j k.k<np>_<j> is null)`.

The null branch recovers a row whose non-preserved PK was captured NULL — a freshly-materialized null-extended row (identified by its preserved-side equalities alone) and a preserved-side update touching a still-null-extended row (latent bug #2). SQL three-valued comparison keeps the two branches disjoint, so no `is not null` guard is added. Built with the existing idioms (`combineAnd`, `{type:'binary',operator:'OR'}`, `{type:'unary',operator:'IS NULL'}`); the function/`§ returning` docs were updated.

**`multi-source.ts` — `decomposeUpdate` `out.nullExtended` branch (~`multi-source.ts:1435`).** Removed the `returning-through-view` reject (and its stale comment). The **existence-flag** RETURNING reject (`multi-source.ts:1387-1394`) and the FULL-join rejects are deliberately untouched.

**Docs.** `docs/view-updateability.md` § `returning` Clauses: the update bullet now describes the preserved-keyed disjunction + null-extended recovery; the limitation paragraph notes a base-PK/join-key rewrite still drops a *matched* row and that existence-flag `set hasB = …` RETURNING stays rejected.

## Validation done

- `yarn workspace @quereus/quereus test` → **5287 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus lint` → clean. `yarn workspace @quereus/quereus typecheck` → clean.
- New positive coverage in `property.spec.ts` LEFT `npv` (~4988) and RIGHT `rnpv` (~5142) tests, and a sqllogic section in `93.4-view-mutation.sqllogic` (new `ojrv` view, after the `ojv` section ~line 2200).

## Use cases / behaviors to re-check (reviewer's floor, not ceiling)

Covered by the new tests (LEFT `npv` + RIGHT `rnpv` mirror, both green):
- **Matched-only** `update npv set pv = 444 where cc = 1 returning cc, pv` ⇒ `[{cc:1,pv:444}]`.
- **Null-extended materialization** `... where cc = 2 returning cc, cv, pv` ⇒ `[{cc:2,cv:2000,pv:555}]` (parent PK captured NULL → recovered by the null branch).
- **Null-key no-op** `... where cc = 3 returning cc, pv` ⇒ `[{cc:3,pv:null}]` (affected row still returned, unchanged image).
- **Mixed batch** `... where cc in (1,2,3) returning cc, pv` and **`returning *`** (order-insensitive in property.spec via `assertRowsEqual`; cc-ascending deterministic in sqllogic).
- **GetPut idempotence** writing each returned `pv` back leaves the image unchanged.
- **Preserved-side update + null-extended row** `update npv set cv = 99 where cc in (1,3) returning cc, cv, pv` includes `cc=3` (`pv=null`) — the latent partial-set bug #2 (verified it was previously silently dropped by the all-exact predicate).
- **Inner-join parity** — existing inner-join RETURNING (`rjoin`/`rjoin2` sqllogic, multi-source spec) stay green.

## Known gaps / honest flags (treat as starting points)

1. **Non-preserved-column update fan-out is NOT covered and is a pre-existing, separate limitation.** Updating the **non-preserved** column across rows that share one non-preserved partner — e.g. two children sharing one parent, `update npv set pv = X where cc in (1,4)` — fails at the base op with `Scalar subquery returned more than one row`: the matched-update's captured-value scalar read (`capturedValueSubquery`, correlated by the non-preserved PK) becomes multi-valued. This is independent of RETURNING (it fails without RETURNING too) and was discovered during implementation. The **fan-out RETURNING test therefore uses a PRESERVED-column update** (`set cv = 7 where cc in (1,4) returning cc, cv, pv`) to isolate the re-query identity — it still proves the re-query returns each affected row once and does **not** leak the unselected sibling `cc=5` (which shares the captured parent PK but whose child PK is absent from the capture). If non-preserved fan-out updates are wanted, that's a separate fix/backlog ticket (per-row value de-dup or a different value-read shape), out of scope here. Reviewer: confirm you agree this is genuinely orthogonal and worth a backlog ticket rather than blocking.
2. **sqllogic mixed batch is progressive** (by the time the `returning *` batch runs, `cc=2` already materialized its parent from the prior single-row update), so the sqllogic mixed batch is matched+matched+null-key, not a fresh materialization. The **property.spec mixed batch resets first**, so the true matched+materialization+null-key-in-one-statement path *is* covered there. Minor; flagged for completeness.
3. **Fan-out over-match reasoning** (a capture row `(P, rp)` matching only join row `(P, rp)`; the null branch only firing for captured-null np PK) is argued in the plan ticket and exercised only via the preserved-column fan-out test (gap #1). Worth an adversarial read of the `combineAnd`/`OR` AST as built to confirm the three-valued-logic disjointness holds in practice (the matched branch `null = x` must be not-true, never leaking into the OR).

## Out of scope (unchanged from plan)

- Existence-flag `set hasB = true` RETURNING (recoverable in principle, but `hasB = false` is not, so the uniform existence-flag reject stays).
- FULL-outer write-through and its RETURNING.
- Non-preserved-column update **fan-out** (shared non-preserved partner) — see gap #1; candidate backlog ticket if pursued.
