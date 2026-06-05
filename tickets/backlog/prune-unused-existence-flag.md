description: Prune an UNUSED outer-join `exists … as` existence flag so the flag-bearing JoinNode no longer suppresses join-elimination / physical-join selection. Today a live flag forces the join to stay a nested-loop JoinNode (correct but unoptimized); when nothing references the flag, it should be dropped and the ordinary join optimizations re-enabled.
prereq: outer-join-existence-column
files: packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/rules/join/rule-join-elimination.ts, packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus/src/planner/rules/projection/, packages/quereus/test/property.spec.ts
----

## Problem

The read half of the outer-join existence column (`outer-join-existence-read`,
now complete) appends a `{true,false}` match flag to the `JoinNode` output and
guards five join rules with `if (node.hasExistenceColumns) return null`
(`rule-join-elimination`, `rule-join-physical-selection`,
`rule-monotonic-merge-join`, `rule-fanout-lookup-join`, `rule-lateral-top1-asof`).

Those guards are load-bearing for correctness *while the flag is live* — in
particular `rule-join-elimination` cannot see the flag's dependency on the
non-preserved side (the flag's attr id is not a column of that side, so the
`usesRight`/`usesLeft` demand scan misses it), so eliminating the join would be
unsound.

But when **nothing downstream references the flag**, the entire mechanism is dead
weight: the join is pinned to a nested-loop shape and cannot be eliminated, purely
to compute a column no one reads.

## Desired behavior

A projection-pruning / dead-column pass that detects an existence flag whose
output attribute id is not demanded by any ancestor and rewrites the `JoinNode`
to drop that `ExistenceColumnSpec`. Once the last flag is pruned,
`hasExistenceColumns` becomes false and the standard join optimizations
(elimination, hash/merge/fanout physical selection) re-enable automatically.

If a flag *is* still referenced but only as a pure existence probe (e.g. the
classic semijoin shape), a follow-on rewrite to a semijoin/anti-semijoin could
recover the access-path choice — note as a stretch goal, not required.

## Acceptance

- A query selecting an outer join with an unused `exists … as` flag plans
  *without* a residual existence flag, and (where otherwise applicable) the join
  is eliminated / gets a physical join variant.
- A query that *uses* the flag is unchanged (flag retained, guards still fire,
  read-agreement + FD/key invariants from the read-half property tests still hold).
- No correctness regression in `property.spec.ts` "Outer-join existence column
  (read half)" or the Key Soundness corpus.

## Notes

Pure optimization — there is **no correctness defect** today (an unused flag is
computed and discarded). Deferred from the read-half implementation, which
explicitly scoped pruning out. Sequenced after `outer-join-existence-column`
(the write half) so the flag's demand-analysis surface is settled before the
pruning pass reasons about it.
