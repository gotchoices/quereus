description: Outer-join non-preserved-side UPDATE (matched-update / null-extended-insert per-row materialization), realized over the existing `__vmupd_keys` capture substrate. Reviewed and completed; two silent-correctness boundaries closed with conservative plan-time rejects, follow-up RETURNING support filed to backlog.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/06.3.4-view-info.sqllogic, packages/quereus/test/logic/06.3.5-column-info.sqllogic, packages/quereus/test/logic/93.2-view-mutation-pending.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## What shipped

An UPDATE of a **non-preserved** (outer-join null-extended) column through a LEFT-join view now propagates per row instead of rejecting `unsupported-outer-join-update`:

- **Matched row** → an ordinary per-side base UPDATE on the non-preserved table, reading the captured pre-mutation value back keyed on the non-preserved PK.
- **Null-extended row with a non-null preserved join key** → an INSERT materializing the missing non-preserved row (EC join key + assigned value(s) + base defaults) so the preserved row joins it.
- **Null-extended row with a null join key** → a no-op (documented boundary — no key to seed a joinable row).

Realized entirely over the **existing** up-front `__vmupd_keys` capture (no new `ViewMutationNode`/emitter): `decomposeUpdate` + helpers `buildNullExtendedInsert`, `outerJoinInsertKey`, `assertNullExtendedInsertCovered`, plus the `column_info` static-surface flip in `schema.ts` (a non-preserved column with a preserved anchor now reports `is_updatable='YES'`). The AST-over-existing-substrate realization was confirmed behaviorally equivalent to the ticket's intended semantics.

## Review findings

The implementer's handoff was honest and listed 7 known gaps/risks. I read the full implement diff (`10fb8992`) with fresh eyes, traced every helper, and built standalone reproductions for the untested gaps before relying on the summary. Disposition below.

### Checked — aspect sweep
- **Equivalence (the headline ask):** the matched UPDATE keys on the captured np PK (a captured-NULL never equals a real PK, so null-extended rows are correctly excluded); the null-extended INSERT fires exactly on the captured-NULL partition with a non-null join key. Matched + null-extended + null-key paths verified by reproduction and the dedicated property test. **Equivalent.**
- **Tag routing / FK ordering:** the matched UPDATE is always pushed to `perSide` (so `tag-conflict` for an excluded side fires before the insert loop); the np INSERT creates rows on a side that can only be null-extended when no FK forces the parent to exist, so the append-last ordering is sound. **No issue.**
- **Resource cleanup / type safety / DRY:** the new path reuses `registerCapturedExpr` (the generalized capture carrier), `requireKeyColumns`, `capturedValueSubquery`, `collectCrossSideEqualities` — no duplicated substrate. Lint clean. **No issue.**

### Found — silent-correctness boundaries (fixed inline, minor)
Two of the implementer's "untested" gaps turned out to be **silent wrong results**, not safe limitations. Both fixed in this pass with conservative, data-independent plan-time rejects (consistent with the `null-extended-create-conflict` precedent), plus regression tests:

1. **Composite non-preserved join key → silent corruption (was: "out of scope, verify they stay red").** A LEFT join equating the np side on >1 column (`on p.pp = c.x and p.k2 = c.y`, `k2` nullable) was **accepted** but `outerJoinInsertKey` threaded only the first column, so the materialized row did not join back: `update set pv=5` left the view reading `null` *and* minted a stray unreachable parent `(99, null, 5)`. **Fix:** `outerJoinInsertKey` now rejects a composite key (`unsupported-outer-join-update`), mirroring the inner-join envelope's single-column shared-key restriction. Reproduced before/after; regression added to `property.spec.ts`.

2. **RETURNING through a non-preserved-side update → silent partial set (gap 7, was unverified).** `update npv set pv=6 where cc=2 returning cc,pv` **wrote correctly** (parent materialized) but RETURNING returned `[]`: `buildMultiSourceUpdateReturning` correlates on every side's captured PK, and a null-extended row's captured-NULL np PK can never match the minted key (`NULL = 99`). Matched rows return fine, so the result is a silent partial set. **Fix:** `decomposeUpdate`'s `nullExtended` branch now rejects RETURNING (`returning-through-view`). Reproduced before/after; regression added.

### Found — safe limitations (left as documented; gaps confirmed benign)
- **Multi-row scalar (gap 1)** — two view rows sharing one np PK with different values raises a clean `Scalar subquery returned more than one row` (atomic, no corruption). Reproduced. Same theoretical limit as the pre-existing cross-source path. **Left documented.**
- **Duplicate null-extended inserts (gap 2)** — colliding preserved join keys raise a clean `UNIQUE constraint failed` (atomic rollback). Reproduced. **Left documented.**
- **Null join-key no-op (gap 3), plan-time create-conflict (gap 4), value-capture timing (gap 5)** — intended, tested/documented. **No change.**

### Filed — follow-up (major → backlog)
- **`tickets/backlog/view-write-outer-join-nonpreserved-returning.md`** — proper RETURNING support (re-key the post-mutation re-query off the stable preserved-side identity so materialized rows surface), replacing the conservative reject from finding 2. Includes the fan-out / inner-join-parity questions to resolve.

### Surface↔dynamic note (no change — pre-existing pattern)
`column_info` reports a non-preserved column `is_updatable='YES'` whenever a preserved anchor exists; it does not analyze join-key composition or NOT-NULL coverage, so it over-reports for composite-key joins and `null-extended-create-conflict` shapes alike. This is the **same** intentional surface-imprecision the implementer already accepted for create-conflict (a plan-time, data-independent dynamic reject the static surface doesn't replicate) — not newly introduced. Left as-is.

### Tests / docs
- New regressions in `property.spec.ts` (composite-key reject, RETURNING reject) inside the dedicated non-preserved-update test.
- `docs/view-updateability.md` § Outer Joins + deferred-shapes list updated with both new boundaries and the backlog ticket reference.
- `yarn workspace @quereus/quereus lint` — clean (exit 0).
- `yarn workspace @quereus/quereus test` — **4654 passing, 9 pending, green (exit 0).**

## Out of scope (still rejecting)
- RETURNING through non-preserved update (now `returning-through-view`) → `view-write-outer-join-nonpreserved-returning`.
- Composite non-preserved join key (`unsupported-outer-join-update`).
- Decomposition optional-member / EAV UPDATE → `view-write-decomposition-optional-update`.
- FULL outer non-preserved update, RIGHT joins, non-preserved-only insert (`null-extended-create-conflict`), aggregate/window propagation, multi-source-insert RETURNING.
