description: Make non-equi (theta) INNER-join leg handling consistent across the two set-op write-through paths. Today a non-equi inner-join leg composes on the membership path (consistent with the standalone join-view path) but is conservatively deferred (all-`NO`) on the flag-less path. Pick one behavior and apply it uniformly.
files: packages/quereus/src/planner/mutation/multi-source.ts (isInnerJoinBody), packages/quereus/src/planner/mutation/set-op.ts (isOperandWritable, isWritableLeafLeg, buildBranch), packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic, docs/view-updateability.md
----

## Problem

`isInnerJoinBody` (multi-source.ts) gates the set-op join-leg compose on `joinType === 'inner'`
only — it does **not** check that the join is an equi-join. So a non-equi (theta) inner join such as
`from a join b on a.x > b.lo and a.x < b.hi` is admitted as a composable leg.

This produces an **inconsistency between the two set-op write paths**:

- **Membership path** (`union exists … as <flag>`): `isOperandWritable` returns `true` for a
  non-equi inner-join branch, so it **composes** — `view_info` reports `is_updatable`/`is_deletable`
  = `YES` and an UPDATE/DELETE actually runs. This matches the **standalone** join-view path
  (`create view V as select … from a join b on a.x > b.lo`), which already reports `YES/YES/YES` for
  a non-equi inner join.

- **Flag-less path** (`union all` with a literal discriminator): the recognizer
  (`isSetOpFlaglessWritableBody`/`flaglessShape`) conservatively **defers** a non-equi inner-join
  leg — `view_info` reports all-`NO` and the dynamic write rejects cleanly with `cannot write
  through view`.

Both behaviors are **safe** (the membership/standalone composition does not corrupt base data; a
non-equi join's cartesian duplicates dedupe harmlessly through the PK-keyed base op, and the
flag-less path's all-`NO` is an honest under-claim). This is therefore **not a correctness bug** —
it is a behavioral inconsistency + a question of intended scope. Confirmed by probe during review of
`set-op-write-multisource-leg-compose` (regression test for the flag-less deferral lives in
`93.6-set-op-flagless-write.sqllogic` § "Non-equi (theta) INNER join leg deferral").

## Decision needed

Pick the intended semantics for a **non-equi inner-join leg** and make both set-op paths (and the
docs) agree:

- **Option A — accept** (align flag-less with membership + standalone): teach the flag-less
  recognizer to admit a non-equi inner-join leg, so all three paths compose it. Widest support;
  inherits whatever the standalone join-view path's non-equi semantics already are (including the
  cartesian-duplicate / full-data-tuple v1 caveats).
- **Option B — reject** (align membership with flag-less): tighten `isInnerJoinBody` (or the set-op
  recognizers) to require an equi-join, so a non-equi inner-join leg is deferred on **all** paths —
  including the standalone join-view path, if uniformity there is also wanted. Most conservative.

Whichever is chosen, update `docs/view-updateability.md` § Set Operations (the membership and
flag-less subsections both currently note this split) and add coverage for the non-equi inner-join
leg on the path that changes.
