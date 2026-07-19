description: Make aggregate materialized views maintainable by pure arithmetic on the stored group row (add/subtract the changed value) instead of re-reading the group's source rows, so maintenance cost stops growing with group size.
prereq: mv-maintenance-statement-batching
files: packages/quereus/src/core/database-materialized-views-plans.ts, packages/quereus/src/core/database-materialized-views-plan-builders.ts, packages/quereus/src/core/database-materialized-views-apply.ts, packages/quereus/src/planner/cost/index.ts, docs/mv-maintenance.md
----
## Motivation

Today a single-source aggregate MV (`select g…, sum(x), count(*) … group by g…`) is maintained
by the `'residual-recompute'` arm: every change to a group re-runs a key-filtered re-execution
of the body — a scheduler invocation plus a rescan of the group's source rows. Correct, but
cost per change is O(group size) plus ~1 ms fixed scheduler overhead per invocation (measured
on the memory vtab; the driver of the bulk-load slowdown fixed at statement granularity by
`mv-maintenance-statement-batching`). For decomposable aggregates none of that is necessary:
an insert of `(g, x)` can update the stored group row arithmetically — `sum += x`, `n += 1` —
with **zero source reads**. This is the standard incremental-view-maintenance delta algebra,
and `docs/todo.md` § "Bounded-delta arms for floor-covered shapes" already names it
("Delta-arithmetic aggregate arm (`sum`/`count`), with a rescan-on-retraction fallback for
`min`/`max`") — verified absent from code: the five wired plan kinds are `inverse-projection`,
`residual-recompute`, `prefix-delete`, `join-residual`, `full-rebuild`.

The recombination algebra already exists once in the engine: the read-side aggregate-rollup
matcher (docs/materialized-views.md § Aggregate rollup) carries the per-aggregate
decomposability allowlist (`sum` recombines by sum, `count` by summed counts with the
zero-rows coalesce, `avg` from stored sum+count, `min`/`max` by min/max of partials; anything
`distinct` is not decomposable). The delta arm is the write-side dual of the same table and
should share its vocabulary.

## Specification

A new bounded-delta strategy (or a fast path inside the residual arm) for single-source
aggregate bodies whose aggregate list is entirely delta-maintainable:

- **insert** of source row in group K: if K's backing row exists, apply per-aggregate delta
  (`sum(x) += x` with SQL NULL semantics — a NULL x contributes nothing; `count(*) += 1`;
  `count(x) += (x is not null)`); else insert a fresh group row seeded from the single row.
- **delete**: inverse deltas; when the maintained `count(*)` reaches 0, delete the group's
  backing row (matches the residual arm's emptied-group point delete).
- **update**: delta out of the OLD group, delta into the NEW group (same row when the group
  key is unchanged).
- **`avg`**: maintain from sum + count partials. Requires both to be available — either the
  body already stores them, or the plan maintains hidden partial columns; design decision at
  plan time (the read-side rollup solved the same question by requiring stored partials).
- **`min`/`max`**: an inserted value only tightens (compare-and-store, no rescan). A
  retraction (delete/update removing the current extremum) cannot be answered from the stored
  scalar — fall back to the existing key-filtered residual recompute *for that group only*.
- **Not delta-maintainable** (any `distinct` aggregate, `group_concat`, UDAFs without an
  inverse): the body keeps the residual-recompute arm as today. Mixed bodies where only some
  aggregates are delta-able may still delta the able ones and rescan only on the fallback
  triggers, or simply disqualify — cost gate decides.

Interaction with `mv-maintenance-statement-batching` (prereq): deltas accumulate per (MV,
group key) in the per-statement batch and apply as one read-modify-write per affected group at
the statement flush — the accumulation is a fold over the statement's changes, so bulk-load
maintenance cost becomes O(affected groups) per statement with no source rescans at all.
The statement-batching ticket's degrade-to-rebuild gate stays as the escape for
statements touching nearly all groups, though with deltas this arm should usually win.

Correctness constraints:

- Reads-own-writes and lockstep commit/rollback semantics identical to the other bounded-delta
  arms (same backing connection, same savepoint behavior).
- Numeric fidelity: repeated float add/subtract drifts where a rescan would not — decide
  policy (e.g. integer/bigint sums are exact; float sums may need a periodic or threshold-based
  recompute, or accept drift consistent with SQL sum semantics). Must be settled at plan
  stage, not left to the implementer.
- The maintenance-equivalence property harness (`test/incremental/maintenance-equivalence.spec.ts`)
  is the oracle; the delta arm must pass it unchanged, including rollback and NULL zoos.
- Value-identical no-op suppression contract (MV-016) still applies: a delta that lands on the
  same stored value must report nothing.

Cost gate: extend `maintenanceCost` with the delta strategy (per-change O(1), fallback-rescan
probability for min/max) so the backward gate picks delta > residual > rebuild per body shape.
