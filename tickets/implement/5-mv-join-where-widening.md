description: Widen the 1:1 `'join-residual'` MV arm to accept a `WHERE`. A predicate over the driving table T only needs a gate relaxation (forward residual already carries it, lookup stays upsert-only); a predicate referencing the lookup P switches the lookup side to a delete-capable reverse residual. Bounded-delta coverage for partial-WHERE inner/cross joins (outer/fanning still floor).
prereq: mv-eligibility-floor-fallthrough
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, docs/incremental-maintenance.md
----

After the eligibility flip, a partial-`WHERE` 1:1 join is *covered* by the full-rebuild floor — correct but unbounded. This ticket gives it a **bounded-delta** arm, the cheap incremental win in the plan. See `docs/materialized-views.md` § `'join-residual'` (the "`WHERE` handling" paragraph) and eligibility shape 4.

`buildJoinResidualPlan` currently rejects any `WHERE`. Replace that blanket reject with a **classification** of the body `WHERE` by which base table(s) its columns reference (reuse the per-base-ref attribute→source-column maps the builder already constructs):

- **Predicate over the driving table `T` only** — relax the gate and do nothing else. The forward residual already injects + applies the body `WHERE` (an out-of-scope `T` row yields zero residual rows ⇒ delete), and a `T`-column predicate cannot move the membership set `{T : T.fk = P.pk}`, so the lookup side stays upsert-only and sound.

- **Predicate referencing the lookup `P`** (or both sides) — keep the forward (`T`) residual; make the lookup (`P`) side **delete-capable**. Add a `lookupMembershipResidualScheduler` to `JoinResidualPlan`: the body with `injectKeyFilter` on `P` but with the body `WHERE` **stripped** (membership only). In `applyLookupResidual`, per affected `P` key: run the membership residual → `delete` each returned `T.pk` backing key; then run the existing in-scope reverse residual (with the `WHERE`) → `upsert` the survivors.

Still inner/cross only; outer joins and fanning joins continue to fall to the floor (no change). An aggregate-over-join continues to the floor.

## Edge cases & interactions
- **T-only predicate, P write**: a `P` payload update must refresh the lookup-projected columns of in-scope joined rows without adding/removing rows (upsert-only path unchanged). Test a `P` update under a `where T.col …` body.
- **P-referencing predicate, P write flips membership**: a `P` update that moves rows into/out of the predicate must add the newly-qualifying and remove the newly-disqualified backing rows (the delete-then-upsert pass). Test both directions.
- **P-referencing predicate, T write**: forward residual must still apply the full `WHERE` (including P columns) — confirm the `T`-keyed residual joins to live `P` and filters correctly (an FK-move that changes which `P` is joined, flipping scope).
- **Membership residual must ignore the WHERE**: the delete pass deletes *all* currently-referencing `T.pk` for the changed `P`, then re-upserts survivors — otherwise a row leaving scope would never be deleted. Pin this (a P update that pushes a row out of scope must remove its backing row).
- **Stale membership candidates**: deletes derived from the membership residual key on `T.pk` from live `T` (a `P` write doesn't change `T.fk`), so they match existing backing keys; confirm no false deletes when multiple `P` rows share nothing.
- **Both-sides predicate**: classify as P-referencing (delete-capable) — the T-portion is handled by the forward path, the P-portion by the reverse delete-capable path.
- **Determinism**: the `WHERE` and its residuals must be deterministic (already required for the arm) — a volatile predicate hard-rejects.
- **Cost gate**: a partial-WHERE 1:1 join now has a bounded-delta sound strategy, so the gate prefers it over the floor; confirm it is selected (not silently floored).

## TODO
- Classify the body `WHERE` by referenced base table(s) in `buildJoinResidualPlan`; remove the blanket `WHERE` reject.
- T-only path: relax the gate (no new residual).
- P-referencing path: add `lookupMembershipResidualScheduler` (WHERE-stripped, P-keyed); make `applyLookupResidual` delete-then-upsert.
- Tests: equivalence harness over `where T.col`, `where P.col`, and both-sides 1:1 join bodies under random T- and P-side insert/update/delete; assert membership-flip add/remove. Add representative cases to §53.
- Update `docs/incremental-maintenance.md` (join-residual WHERE handling + delete-capable reverse residual).
