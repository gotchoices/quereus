description: A `RETURNING <wrong>.*` qualifier through an updatable view silently expands to all view columns instead of erroring, unlike the base-table path which validates the qualifier names the target.
files:
  - packages/quereus/src/planner/mutation/single-source.ts   # rewriteViewReturning: `rc.type === 'all'` branch ignores rc.table (TODO marker present)
  - packages/quereus/src/planner/mutation/multi-source.ts     # buildReturningProjection: same gap (TODO marker present)
  - packages/quereus/src/planner/building/returning-star.ts   # base-table path that DOES validate (reference shape for the error)
difficulty: medium
----

# View `RETURNING <table>.*` qualifier is not validated

## Problem

Base-table `INSERT/UPDATE/DELETE ... RETURNING <name>.*` validates that `<name>`
matches the target table (or its alias), raising
`Table '<name>' not found in FROM clause for qualified RETURNING *` otherwise
(see `building/returning-star.ts`). The **view** mutation paths do not: the
`rc.type === 'all'` branch in both `rewriteViewReturning` (single-source) and
`buildReturningProjection` (multi-source) iterates **all** view columns
regardless of `rc.table`, so a mutation through an updatable view with a wrong
qualifier — e.g. `update <view> set ... returning bogus.*` — silently expands to
the full view projection instead of erroring.

This is a pre-existing over-permissiveness (the view path supported bare `*`
before base-table `*` existed; it never validated qualifiers). The
`dml-returning-star` ticket closed the base-table gap and left a one-line `TODO`
at each view branch noting the inconsistency.

## Expected behavior

`returning <q>.*` through a view should accept `<q>` only when it names the
view (or the view's correlation alias, if one is threaded through the mutation
rewrite) — matching the base-table diagnostic shape — and otherwise raise the
same `not found in FROM clause for qualified RETURNING *` error.

## Notes

- Tightening needs the **view name** (and any alias) threaded into both
  `rewriteViewReturning` and `buildReturningProjection`; today neither receives a
  spelled qualifier to compare against. `rewriteViewReturning` already has
  `view.name` in scope (`guardTopLevelScope(rc.expr, analysis, view)` is called
  on the named branch), so the single-source side is close; the multi-source
  `buildReturningProjection` needs the view identity passed in.
- Add coverage: a wrong-qualifier `returning bogus.*` through both a single-source
  and a multi-source updatable view should error; a correct `<view>.*` should
  still expand. Good homes: `93.4-view-mutation.sqllogic`.
- Low user impact (a typo'd qualifier currently returns columns rather than
  erroring — no data corruption), which is why it is backlog rather than fix.
