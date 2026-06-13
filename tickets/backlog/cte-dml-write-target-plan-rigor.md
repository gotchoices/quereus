description: Add structural plan-rigor tests for the CTE-name DML write target that the implement + review passes left as state-only parity. Two gaps — (1) a byte-identical/plan-shape assertion that a single-source CTE-target lowers to the same base-op plan tree as the equivalent named view (today only observable base-table STATE parity is asserted, in 93.4-view-mutation.sqllogic); (2) a plan-cache-invalidation spec case confirming an ephemeral CTE-target DML records no `view` schema dependency and is not wrongly invalidated/reused on a later `create view <cteName>`.
prereq:
files:
  - packages/quereus/test/plan/                                          # add a plan-shape comparison case
  - packages/quereus/test/plan/view-dependency-invalidation.spec.ts      # add the ephemeral no-dependency case
  - packages/quereus/src/planner/building/view-mutation-builder.ts       # the !view.ephemeral recordDependency skip under test
difficulty: medium
----

# CTE-name DML write target: structural plan rigor

## Background

The acceptance bar for the cte-name-dml-write-target work is that a single-source
projection-and-filter CTE body lowers to a **byte-identical base-op plan** to the equivalent
`create view t as (…)` + same DML. The implement + review passes verified this as observable
**base-table STATE parity** (`93.4-view-mutation.sqllogic`, the CTE Round-Trip Law block) but
did not add a structural plan-tree assertion.

The review also confirmed by code path that an ephemeral target skips
`recordDependency` (the `!view.ephemeral` guard in `buildViewMutation`), so a CTE-target DML
records no `view` schema dependency — but this is reasoned, not pinned by a test.

## Scope

1. **Plan-shape parity.** Add a `test/plan/` case comparing the emitted base-op plan tree (or
   program) for `with t as (select id, color from base) update t set color='x' where id=1`
   against the named-view form `create view t as select id, color from base; update t …`.
   Assert structural equivalence of the base-table mutation subtree (modulo the synthesized
   SELF_ALIAS / attribute ids that the substrate mints either way).

2. **Plan-cache invalidation.** Add a case to `view-dependency-invalidation.spec.ts` (or a
   sibling) asserting that a cached CTE-target DML records NO `view` dependency on
   `<schema>.<cteName>`, so a subsequent `create view <cteName> …` does not invalidate or
   re-route the cached CTE-target plan — and that the CTE-target plan DOES depend on the real
   base table it writes (so an `alter`/`drop` of the base table invalidates it correctly).

3. **Inline-subquery target parity (same substrate).** The `inline-subquery-dml-write-target`
   work (shipped, state-verified in the `93.4-view-mutation.sqllogic` Inline-subquery block)
   routes `update (select …) as v set …` / `delete from (select …) as v where …` through the
   **same** ephemeral view-like substrate as the CTE-name target, so it inherits the identical
   state-only-parity gap. While adding (1), also assert the inline-subquery single-source form
   lowers to a base-op plan tree byte-identical to both the equivalent named-view and CTE-name
   forms (and, like the CTE target, records no `view` schema dependency for (2)). One extra
   comparison arm — no separate substrate to exercise.

## Why backlog

These are test-rigor additions for an already-shipped, state-verified feature, not a bug fix.
Promote to plan/implement when hardening the view-mutation test corpus.
