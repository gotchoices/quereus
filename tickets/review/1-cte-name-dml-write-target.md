description: Review the CTE-name DML write-target implementation — `update <cte>` / `insert into <cte>` / `delete from <cte>` now route a leading-WITH CTE body through the existing view-mutation substrate via an ephemeral view-like adapter. Pure resolution/routing + an `ephemeral` flag; no grammar change. Adversarial pass needed on the resolution-order / scoping decisions and the v1 boundaries (Halloween, multi-level body), plus test-rigor gaps (no byte-identical plan snapshot; cache-invalidation untested).
prereq:
files:
  - packages/quereus/src/planner/building/dml-target.ts              # NEW — resolveCteTarget + contextForCteTarget
  - packages/quereus/src/planner/building/insert.ts                  # CTE-target check above getView dispatch (~478)
  - packages/quereus/src/planner/building/update.ts                  # buildWithContext threading + CTE-target check + contextWithCTEs replaces contextWithSchemaPath
  - packages/quereus/src/planner/building/delete.ts                  # same as update.ts
  - packages/quereus/src/planner/building/view-mutation-builder.ts   # !view.ephemeral guard on validateMutationTags + recordDependency (~50)
  - packages/quereus/src/planner/mutation/single-source.ts           # MutableViewLike.ephemeral; noun threaded into DISTINCT/LIMIT rejects
  - packages/quereus/src/planner/building/select-context.ts          # buildWithContext signature generalized to { withClause? }
  - packages/quereus/src/planner/building/with.ts                    # isRecursiveCte helper (reused in buildCommonTableExpr)
  - docs/view-updateability.md                                       # § CTEs rewritten; L81 prose updated
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic          # CTE round-trip + reject-parity + edge-case block (appended)
  - packages/quereus/test/logic/13.3-cte-edge-cases.sqllogic         # read-gap section updated (was asserting the now-closed gap)
difficulty: hard
----

# Review: CTE name as a DML write target

## What landed

A leading `with t as (…)` now makes the CTE name a real DML write target. `update t` /
`insert into t` / `delete from t` route the CTE body through the **same** view-mutation
substrate (`buildViewMutation`) a named view uses, via an **ephemeral** `MutableViewLike`
adapter. No grammar change (a CTE name already parses as a bare identifier); this is pure
resolution + routing plus the `ephemeral` flag.

Pipeline (per builder, ahead of the `getView`/`getMaintainedTable`/`buildTableReference`
schema dispatch):

```
resolveCteTarget(ctx, stmt.table, stmt.withClause)   // planner/building/dml-target.ts
  → undefined  (no WITH / schema-qualified / name miss) → unchanged schema dispatch
  → raise recursive-cte                                  (genuinely recursive target)
  → ephemeral MutableViewLike over cte.query            (otherwise)
if matched: buildViewMutation(contextForCteTarget(ctxWithCtes, name), adapter, {op, stmt})
```

`buildViewMutation` skips the two schema-object-coupled steps for an ephemeral target
(`validateMutationTags`, `recordDependency`); every other substrate step already degrades
because the CTE name owns no lens slot / decomposition advertisement / set-op membership.

## Key design decisions to scrutinise

- **CTE shadows a same-named schema table/view/MV as the write target** (silent, matching
  read-side FROM shadowing). `resolveCteTarget` runs first. Schema-qualified (`main.t`)
  never resolves to a CTE.
- **The target CTE's own name is excluded from its own body's scope**
  (`contextForCteTarget` deletes it from `cteNodes`). Rationale: `buildFrom` resolves a
  FROM name against `cteNodes` *before* the schema, so leaving the target in scope would
  make the load-bearing shadow case (`with base as (select … from base) update base …`)
  self-resolve to the CTE instead of the real `base` table. Excluding mirrors SQL's
  non-recursive-CTE scoping (a CTE can't see itself) — which is exactly what
  `buildCommonTableExpr` already does (builds a body against PRIOR siblings only).
  **Sibling CTEs stay in scope** (sibling reads in body/predicate/source resolve).
- **Recursion gate** (`isRecursiveCte`): `with recursive` keyword AND a compound
  self-referential body — NOT merely the keyword. A `with recursive` clause whose *target*
  member is a plain body is still writable (tested).
- **Read-gap side effect**: UPDATE/DELETE previously ignored `stmt.withClause` entirely;
  they now thread it via `buildWithContext`. A CTE read in an UPDATE/DELETE WHERE/SET
  subquery now resolves. This **changed** `13.3-cte-edge-cases.sqllogic` (it asserted the
  old "not found" gap on lines 67-92); I updated that section to the new correct behavior.
  Confirm this behavior change is intended (the implement ticket says it is).

## Verification done (all green)

- `yarn workspace @quereus/quereus test` → 6190 passing, 9 pending.
- `yarn workspace @quereus/quereus lint` → clean (eslint + tsc test).
- `tsc -p tsconfig.json --noEmit` → clean.

## Test coverage added (93.4-view-mutation.sqllogic, appended block)

- **CTE Round-Trip Law**: update / insert / delete through a single-source projection-filter
  CTE target produce byte-identical observable base-table state to the equivalent named view
  (explicit view-parity block from the same starting rows).
- RETURNING through a CTE target.
- **Shadow** self-reference: `with base as (select … from base) update base …` writes the
  real `base`.
- Schema-qualified `main.sbase` does NOT resolve to the CTE.
- Sibling CTE read in a SET value resolves.
- Read-gap closure on an ordinary base-table UPDATE.
- Multi-source (join) CTE body update.
- Non-self-referential member under `with recursive` is writable.
- Reject-parity: recursive (`recursive-cte`), aggregate, DISTINCT — CTE target and the
  equivalent view both reject with the same body-shape diagnostic substring.
- v1 boundaries: multi-level CTE body (rejects), set-op body (rejects), Halloween self-read
  (rejects cleanly, base unchanged).

## Honest gaps — treat tests as a floor

1. **Byte-identical plan is asserted only as observable STATE parity, not plan structure.**
   The acceptance bar names a byte-identical base-op plan vs the equivalent view; I did not
   add a plan-snapshot/structural comparison (no `test/plan/` case). A reviewer wanting true
   byte-identity rigor should add a plan-shape assertion (e.g. compare emitted program /
   plan tree for `with t as (select id,color from base) update t …` vs the view form).
2. **Halloween self-read REJECTS rather than captures.** A user-predicate self-read of the
   target name (`… where id in (select id from t)`) errors with `unsupported-subquery-correlation`
   ("cannot be proven correlated") because the target name is shadowed out of scope — a
   consequence of the shadow-vs-Halloween tradeoff (the two cases want OPPOSITE `cteNodes`
   treatment of the target name; I chose to make the load-bearing shadow case correct). It
   is a clean reject with the base unchanged (never a Halloween-unsafe plan), which the
   implement ticket explicitly permits ("document and test the resulting behavior"). If the
   reviewer judges the self-read should work, that needs a split-context design (exclude the
   target for body planning, include it for the user predicate) — a non-trivial follow-up.
3. **Plan-cache invalidation is reasoned, not tested.** Ephemeral targets record no schema
   dependency, so a CTE-target DML should not be wrongly cached against a later
   `create view t`. I did not add a case to `test/plan/view-dependency-invalidation.spec.ts`.
   Worth a targeted test.
4. **`with context (…)` / `with tags` on a CTE-targeted DML is untested.** Statement-level
   tags validate at the dml-stmt site (before dispatch) and mutation context threads onto
   the lowered base ops in principle, but I added no explicit CTE+context/tags test. The
   `evt_v` view block (93.4 ~line 355) is the analogous view coverage to mirror.
5. **Set-op MEMBERSHIP-bodied CTE (existence columns) untested.** I tested a plain
   `union` body (rejects). A membership-flagged set-op CTE body would route to
   `buildSetOpMutation` with an ephemeral adapter — confirmed no crash is *claimed* but not
   exercised. Worth one probe.
6. **Multi-level CTE body** (`with a …, t as (select * from a) …`) rejects with
   `no-base-lineage` ("not updateable in phase 1") because the sibling reference reaches a
   CTEReference node — pinned as v1 behavior. A transparent multi-level inline is out of
   scope (would belong in backlog if a consumer needs it).
7. **Minor polish**: I threaded `view.noun` into the DISTINCT/LIMIT rejects in
   `single-source.ts` so a CTE target reads "common table expression" where the body-shape
   rejects already did — verify this did not alter any existing view/MV diagnostic
   expectation (full suite passed, so none asserted on it).

## Suggested adversarial probes for the reviewer

- Composite-PK / hidden-PK CTE join body (mirror `ax_jv_comp` / `tj2` view cases) through a
  CTE target.
- A CTE target whose body is a single-source view-over-base (does the nested-view reject
  fire with the CTE noun?).
- Confirm `insert into <cte> select … from <sibling-cte>` (source reads a sibling) — the
  source path threads `cteNodes`; lightly covered.
- Confirm an unqualified CTE-target name that ALSO matches a real table in a non-current
  schema on the schema path still shadows correctly (resolution-order edge).
