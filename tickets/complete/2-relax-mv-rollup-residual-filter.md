description: |
  Relaxed the `rollup-residual` forgo in the materialized-view query-rewrite matcher.
  A rollup that needs a residual WHERE over the MV backing now matches: the residual
  references only MV group-key columns (so it partitions whole backing groups), and the
  rule builds the residual Filter on the backing scan before the re-aggregate, commuting
  with it. The forgo had existed only to dodge the now-fixed streaming-aggregate
  filter-drop bug (prereq `streaming-aggregate-stale-group-context-shadows-child-filter`).
  Reviewed, verified sound, build + full suite + lint + typecheck all green.
prereq: streaming-aggregate-stale-group-context-shadows-child-filter
files:
  - packages/quereus/src/planner/analysis/query-rewrite-matcher.ts          # removed fail('rollup-residual') guard + union member
  - packages/quereus/src/planner/rules/cache/rule-materialized-view-rewrite.ts # unchanged — buildRollupReplacement already wires the residual Filter
  - packages/quereus/src/planner/building/select-aggregates.ts               # validateAggregateProjections — the load-bearing SQL-92 create-time gate
  - packages/quereus/test/query-rewrite-aggregate.spec.ts                    # flipped the rollup-residual unit test to a positive match
  - packages/quereus/test/query-rewrite-equivalence.spec.ts                  # added 3 rollup+residual shapes to AGG_QUERIES + 1 to AGG_MUST_REWRITE
  - packages/quereus/test/plan/materialized-view-rewrite-plan.spec.ts        # flipped the rollup-residual golden-plan test
  - docs/optimizer.md, docs/materialized-views.md                            # forgo-guard count + harness description updated

# Relax the MV rollup-residual forgo

## Summary

The single load-bearing source edit deletes the
`if (!exact && residualConjuncts.length > 0) return fail('rollup-residual');` guard
(and its `'rollup-residual'` `RewriteFailureReason` union member) in
`query-rewrite-matcher.ts`. A rollup that needs a residual now flows to the normal
`RewriteMatch`/`AggregateRollup` assembly; the rule's `buildRollupReplacement` already
wired the residual `Filter` on the backing scan (via the shared `buildBackingSource`)
before the re-aggregate, so no rule change was needed. Docs and the three test layers
(unit matcher, golden plan, equivalence property) were updated to match.

The forgo had existed only to dodge a base streaming-aggregate filter-drop bug, fixed
by the prereq `streaming-aggregate-stale-group-context-shadows-child-filter`.

## Review findings

### Verdict: APPROVED — no major findings, no inline fixes required.

The change is small, sound, and well-tested. The implementation handoff was accurate in
every checkable claim. Details below.

### Soundness — the load-bearing invariant is airtight (confirmed independently)

The implementer correctly identified that the entire correctness argument now rests on
one invariant: **a residual conjunct can reference only MV group-key columns.** I traced
this to ground and it holds even more strongly than claimed:

- `analyzeMvStoredColumns` (`query-rewrite-matcher.ts:1247-1280`) maps *every* bare base
  column projected by the MV body into `groupBackingOfBaseCol` — not just group keys. So
  the invariant cannot rely on that map being group-key-only by construction; it relies
  on the MV body *never being able to project a bare non-group column in the first place*.
- That is enforced at create time by `validateAggregateProjections`
  (`select-aggregates.ts:216-289`). Its `findUngroupedColumnRef` walk rejects any bare
  `ColumnReferenceNode` whose attribute id is not in GROUP BY (or whose subtree
  fingerprint doesn't match a GROUP BY expression). The doc comment is explicit: it is
  *"intentionally stricter than full functional-dependency coverage — it matches SQL-92
  ... without importing SQLite's permissive 'bare columns' rule."*
- Therefore every key in `groupBackingOfBaseCol` is a GROUP BY column. The residual
  coverage check (`query-rewrite-matcher.ts:659-663`) seeds `backingColOfBaseCol` only
  from that map, so any residual on a non-group column fails `missing-column`. Residuals
  are confined to group-key columns, which take a single constant value across each whole
  backing group ⇒ the residual `Filter` keeps/drops whole groups ⇒ it commutes with the
  rollup re-aggregate. **The implementer's note worried about an FD-stored bare column;
  in fact Quereus rejects even FD bare columns unless explicitly grouped, so the concern
  is moot — the invariant is strictly tighter than feared.**

This also means the `group-key-pinned` guard (which runs *before* the deleted location,
`:674`) still correctly handles the only column-reorder hazard: it only fires for ≥2
query group keys pinning a *query* group column; a residual on a *dropped* MV key never
triggers it, which is correct (the dropped key is filtered, not reordered).

### Rule wiring — confirmed unchanged and correct

`buildRollupReplacement` (`rule-materialized-view-rewrite.ts:583-630`) calls the shared
`buildBackingSource` (`:475-503`), which constructs the residual `FilterNode` over the
backing `Retrieve` (`:493-501`) *before* the re-aggregate `AggregateNode` is built over
that filtered source (`:610`). The recombine projection preserves the fragment's output
attribute ids. The rollup path was already residual-capable; only the matcher gate
blocked it. Reading verified.

### Recombine correctness under a residual (eyeballed + empirically covered)

- `sum → sum`, `count(*)/count(col) → coalesce(sum(cnt), 0)`, `min/max → min/max`,
  `avg → sum(sum)/sum(count)`. Because the residual drops whole groups, every surviving
  partial is a complete group's partial, so each recombine composes exactly as in the
  no-residual rollup. `count` partials being summed remain whole-group counts; `avg`'s
  sum/count pair stays per-whole-group, so `sum(sx)/sum(cx)` equals the true mean over
  surviving rows, and the zero-survivor / all-NULL case yields NULL (division by 0 ⇒
  NULL) — matching the base.

### Tests — checked for happy/edge/error/regression/interaction coverage

What was checked and found:

- **Unit matcher** (`query-rewrite-aggregate.spec.ts`): the `rollup-residual` negative was
  correctly flipped to a positive (`exact === false`, 1 residual conjunct, `sum` recipe).
  Neighbouring negatives — `missing-column` (WHERE on a non-group column), `group-key-mismatch`,
  `group-key-pinned`, `aggregate-not-decomposable`, `source-mismatch`, `no-candidate` — all
  remain green, confirming the relaxation didn't widen the gate beyond group-key residuals.
- **Golden plan** (`materialized-view-rewrite-plan.spec.ts`): flipped test asserts the plan
  now contains `_mv_byregion`, drops `"main.regsales"`, and carries a
  `StreamAggregate|HashAggregate` re-aggregate. Passes.
- **Equivalence property** (`query-rewrite-equivalence.spec.ts`): three rollup+residual
  shapes added to `AGG_QUERIES` (equality residual `j = 1`; range residual `j >= 0` with
  count recombine; `min/max/avg` under `j = 0`), asserting `rewrite-on == rewrite-off` as
  multisets over random data starting from 0 rows with nullable `x`. `where j = 1` added to
  `AGG_MUST_REWRITE` so the path is proven non-vacuous (actually rewrites, end-to-end —
  this is the real regression guard for the now-fixed filter-drop bug). Passes.
- **No dangling references**: `'rollup-residual'` survives only as test-name strings and doc
  prose; the union member and code path are fully removed (verified by search + typecheck).

Minor coverage observations (documented, not fixed — neither is a correctness gap):
- The residual column `j` in the equivalence harness is `NOT NULL`, so the
  NULL-in-residual-column case isn't exercised. This is the trivially-sound case (a
  group-key filter on a non-null column cannot diverge pre/post-rollup), and the
  load-bearing NULL semantics live in `x`, which *is* exercised. No action.
- Only the equality residual is in `AGG_MUST_REWRITE`; the range and min/max/avg shapes
  rely on the property test alone for "does it rewrite." Since the property compares
  on-vs-off either way, a cost-gate decline can only cause a missed optimization, never a
  false pass. Acceptable as-is.

### Build / lint / typecheck

- `yarn workspace @quereus/quereus run lint` → clean (exit 0)
- `yarn workspace @quereus/quereus run typecheck` → clean (exit 0)
- Full suite (`node packages/quereus/test-runner.mjs`) → **4926 passing, 9 pending, 0
  failing** — matches the handoff exactly. The 9 pending are pre-existing skips unrelated
  to this change.

### Docs

`docs/optimizer.md` and `docs/materialized-views.md` both correctly went from "two forgo
guards" to one (`group-key-pinned`), with prose explaining the rollup-with-residual is now
admitted and why it commutes; the equivalence-harness description lists the new shapes.
Verified the surrounding text (soundness witnesses, recombine table, avg-NULL/count-zero
semantics) still reads true after the edit.

### No new tickets filed

No major findings ⇒ no fix/plan/backlog tickets spawned.
