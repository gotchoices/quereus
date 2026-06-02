description: Review the retirement of the plan→AST→re-plan double-plan in the multi-source `update`/`delete` substrate. Row identification + RETURNING now ride the ALREADY-planned join body (plan nodes — the derived backward walk), not a re-planned cloned-AST body. Behavioral parity is the gate.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md

## What landed

The multi-source two-table-inner-join `update` / `delete` substrate previously planned
the join body once (`analyzeJoinView`) **and** re-planned it again — via
`cloneFromClause(body FROM)` + `buildSelectStmt` — inside every single-side identifying
subquery, the both-sides key capture, and the UPDATE/DELETE RETURNING re-query. This
retires that round-trip: the body is planned **once** and all backward decisions (row
identification + RETURNING) are built as **plan nodes over the planned body** — the
derived backward walk the docs name.

### Mechanism (the shape to review)

- `analyzeJoinView` now plans the body once and returns, alongside lineage/sides:
  - `root` — the planned view body (used by DELETE RETURNING).
  - `joinNode` — the raw `JoinNode` (ON-condition only), found by walking `root`.
  - `joinScope` — the join's combined column scope, retrieved from
    `ctx.outputScopes.get(joinNode)` (the exact scope `buildSelectStmt` resolved the
    body's own predicate against — so base-term resolution is byte-identical).
- **Identification is unified onto one up-front key capture** (`__vmupd_keys`), built as
  `ProjectNode(FilterNode(joinNode))` over `joinScope`:
  `π_{k<side>}( σ_{idPred}( joinNode ) )`, materialized once before any base op.
  - The **single-side** live join-body subquery is **retired** — single-side and
    both-sides alike read the capture. `decomposeUpdate`/`decomposeDelete` always emit
    `<pk> in (select k<side> from __vmupd_keys)`.
  - Capture projects only the **touched** sides' PKs (so a single-side write to a
    simple-PK side with a composite-PK *other* side is NOT rejected — parity), except an
    UPDATE with RETURNING captures both `(k0,k1)` for its EXISTS identity.
- **UPDATE RETURNING** (`post`): `ProjectNode(FilterNode(joinNode, exists-over-capture))`
  — the EXISTS built via `buildExpression` with `__vmupd_keys` injected through
  `cteNodes`; keeps only the structural ON, not the body/user WHERE.
- **DELETE RETURNING** (`pre`): `ProjectNode(FilterNode(root, userWhere))` — the OLD view
  image, resolved against a scope registering `root`'s view-output columns
  (`buildViewOutputScope`) instead of re-expanding `select … from <view>`.
- `buildViewMutation` plans the body once (for multi-source update/delete) and threads
  that single analysis into `decompose*` + `buildIdentityCapture` + `buildMultiSourceReturning`.
  `propagate()`'s multi-source branch is unchanged and still serves the standalone caller
  (`view-info.spec.ts`), planning its own analysis there.

The base **writes** are unchanged: each base op's SET/value clause still lowers to AST and
re-uses `buildUpdateStmt` / `buildDeleteStmt` verbatim. Only the *backward decisions* moved
onto the planned tree.

## Validation done (this is a floor, not a ceiling)

- `yarn workspace @quereus/quereus test` — **4349 passing, 9 pending, 0 failing**,
  including the full `View Round-Trip Laws` block (Tier A + Family B multi-source +
  Family C) and every `93.x-view-mutation*.sqllogic` file.
- `yarn workspace @quereus/quereus run lint` — clean.
- Acceptance grep holds: the only `buildSelectStmt` of the body is `analyzeJoinView`'s
  single plan; `cloneFromClause` is deleted entirely.

Exercised cases (all green): single-side update (child/parent), both-sides update, FK-child
delete, `delete_via=parent`, no-FK multi-side delete fan-out, inverse-column write (single +
both-sides capture path), UPDATE RETURNING (renamed cols, push-out-of-filter, predicate-clash,
`returning *`, empty-match), DELETE RETURNING (single-side, fan-out, `returning *`).

## Where to point adversarial review (known risk surface / gaps)

1. **`joinNode` is shared between two parents** — the pre-materialized capture source and
   the live `post` UPDATE RETURNING re-query both reference the *same* `JoinNode` instance.
   The argument it's safe: the optimizer memoizes by node id (optimize-once), and
   `emitPlanNode` re-emits per occurrence with a fresh per-emit cache state, so the
   materialization-advisory `CacheNode` cannot serve `pre` rows to the `post` consumer. This
   is validated by the UPDATE-RETURNING tests but is a subtle runtime-semantics assumption —
   confirm no optimizer/emit pass folds the two occurrences into one shared runtime iterable.
2. **Single-side identification timing changed (live → captured-`pre`)** — argued equivalent
   for a lone op (nothing mutates before it; an uncorrelated IN-subquery evaluates once). The
   nested-subquery-descent cases the old comments cite (e1/e2/g/h in 93.4) pass, but a
   reviewer should sanity-check any case where a live subquery's evaluation timing could be
   observable (self-referential predicate, FK cascade between sides).
3. **`inverse`-profile `domain` conjunction is no longer threaded** for single-side update
   (it folds into the capture's predicate, which omits per-assignment domains — matching the
   pre-existing both-sides behavior). This is **unreachable today** (no shipped invertibility
   profile produces a `domain`; `x ± k` is unrestricted), so zero test impact — but if a
   domain-bearing profile ever lands, the capture must thread domains. Flagged in code.
4. **`findJoinNode` / `joinScope` coupling** — `findJoinNode` takes the outermost `JoinNode`
   from the logical `root`; `joinScope` relies on `buildSelectStmt` having populated the
   shared `ctx.outputScopes` map. Robust for the accepted two-table-inner-join shape (planned
   logically, so `Project(Filter?(Join))`), but it is an implicit coupling — a future change
   that copies `outputScopes` or restructures the body plan would break the scope retrieval.
5. **DELETE RETURNING off `root`** assumes `root`'s first `outColumns.length` attributes are
   the view's projected columns (body planned with `preserveInputColumns`). Verified by
   `returning *` tests, but worth a glance for column-ordering edge cases.

## Suggested review checks

- Re-run the law harness (`property.spec.ts` § View Round-Trip Laws) and 93.4 under the
  LevelDB store path (`yarn workspace @quereus/quereus test:store`) — NOT run here (planner-only
  change, but the store path exercises a different base-write code path for the lowered ops).
- Adversarial: a multi-source update whose WHERE filters on a column the *same side* reassigns,
  with and without RETURNING (capture must pin pre-mutation rows for both base ops).
- EXPLAIN a multi-source update-with-returning and confirm the shared `JoinNode` emits two
  independent scans (capture-materialize vs post re-query), not one cached scan.
