<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-07-21T07:30:52.894Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\3-feat-mv-agg-delta-tighten.implement.2026-07-21T07-30-52-894Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: Extend arithmetic maintenance of aggregate materialized views to min and max — grow the stored value cheaply on insert, and only fall back to a full re-scan of the affected group when a delete could lower it.
prereq: feat-mv-agg-delta-arm
files: packages/quereus/src/core/database-materialized-views-plans.ts, packages/quereus/src/core/database-materialized-views-plan-builders.ts, packages/quereus/src/core/database-materialized-views-apply.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, docs/mv-maintenance.md
----
## Goal

Add the **tighten-only** delta class to the aggregate delta arm from `feat-mv-agg-delta-arm`:
aggregates that declare `merge` but **no `negate`** — `min`, `max` (and any UDAF like
`bool_or`/`bit_or` that is a semilattice, not a group). Inserts `merge` in cheaply; a retraction
that could *relax* the stored value cannot be done arithmetically, so it falls back to the
key-filtered residual recompute **for that group only**.

min/max are not special cases — this is the general "merge without inverse" rule. Detection is
structural: `algebra.merge` present, `algebra.negate` absent.

## Design

Reuse the `DeltaAggregateDescriptor` machinery. Two changes:

**Eligibility gate relaxation (`plan-builders.ts`).** Today's gate (ticket
`feat-mv-agg-delta-arm`, point 1) requires `negate` on every aggregate column. Relax to admit a
**mixed** body: some columns are abelian-group (count/sum — full delta), others are tighten-only
(min/max — `merge`, no `negate`). Mark each `DeltaAggregateColumn` with its class
(`'group' | 'tighten'`). The `count(*)` multiplicity requirement still holds (emptiness witness).

**Apply path (`apply.ts`).** Per affected group at flush, decide the maintenance per statement:

- **Insert-only touch** (the group saw only inserts this statement): every column — group and
  tighten — `merge`s in arithmetically. No residual. `min`/`max` tighten toward the new extreme.
- **Any delete/update touching a tighten column** in the group: the deleted value *might* have
  been the stored extreme, and `merge` cannot recover the next-best — so recompute **that
  group** via the residual (`runResidual` on the group key, the fallback already compiled on the
  plan). The group's group-columns still delta where possible, but the simplest correct rule is:
  a group whose statement-delta includes any retraction against a tighten column recomputes the
  whole group's row from live state (residual), exactly as the pure residual arm does today.
  Group columns (count/sum) in that same recomputed row come from the residual too — no
  double-maintenance.

So the per-group flush routes: **all-insert group → arithmetic delta; group with a
tighten-relevant retraction → residual recompute.** A body with no tighten column never takes
the residual branch (that is `feat-mv-agg-delta-arm`'s pure-group case, unchanged).

## Cost

Extend the `'delta-aggregate'` cost model (`cost/index.ts`) to weight in the expected residual
fallback probability for tighten columns — the plan directive's "expected rescan probability for
merge-only aggregates". Use `stats.fallbackRatio` (already present) or a tighten-specific factor:
a body with a tighten column costs more than a pure-group body but still typically less than the
always-residual arm (inserts dominate many workloads). If a body is tighten-heavy and mostly
deletes, the gate may legitimately prefer plain residual — let it.

## TODO

- [ ] `plan-builders.ts`: relax the eligibility gate to admit tighten-only columns (merge, no
      negate) alongside group columns; tag each `DeltaAggregateColumn` with its class; keep the
      count(*) requirement.
- [ ] `apply.ts`: per-group flush routing — all-insert → arithmetic merge (incl. min/max
      tighten); tighten-relevant retraction in the group → residual recompute for that group.
      Track per-group whether any tighten-relevant retraction occurred during accumulation.
- [ ] `cost/index.ts`: fold the tighten fallback probability into the `'delta-aggregate'` cost.
- [ ] `maintenance-equivalence.spec.ts`: add a merge-only shape
      `select k, count(*), min(b), max(b) from src group by k` to AGGREGATE_SHAPES (or a new
      suite). The shared `mutationArb` already deletes/updates `b` — exercising the extreme-
      relaxing retraction fallback and the insert-only tighten. Add a UDAF semilattice
      (`merge`, no `negate`) case.
- [ ] `docs/mv-maintenance.md`: document the tighten-only class + the per-group residual fallback.
- [ ] `yarn build && yarn test && yarn lint` green.

## Edge cases & interactions

- **Insert that does NOT beat the extreme.** `merge(storedMax, smaller)` = storedMax → the
  finalized value is unchanged → host suppresses (MV-016). Correct, no-op.
- **Delete of a non-extreme value.** Still takes the residual fallback (the arm cannot cheaply
  prove the deleted value was not the extreme) — correct but conservative. Note as a tripwire:
  a future secondary-index-backed "is this the current extreme?" probe could avoid the rescan;
  do not build it now.
- **Mixed group + tighten in one row.** When a group recomputes via residual due to a tighten
  retraction, the count/sum columns in that recomputed row come from the residual, NOT the
  accumulated delta — do not apply both. Ensure the group is routed wholesale to one path.
- **Update that changes a tighten arg to a new extreme upward.** `old→new` where new > storedMax:
  the retraction of old still forces the fallback (old might have been the max), even though new
  would tighten. Conservative fallback is correct.
- **Multiplicity still governs emptiness** on the residual-fallback branch too (residual returns
  zero rows → delete), consistent with the pure-group path.
- **Collation for min/max.** `merge` must use the same `BINARY_COLLATION` compare as `step`
  (asserted in `feat-mv-agg-algebra-schema`); the backing/oracle compare byte-exactly.
