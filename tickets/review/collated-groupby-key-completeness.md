description: Final-aggregate-projection builder now references the aggregate's group output column for whole-expression group-key matches (collated / arithmetic / any computed GROUP BY key), so the unique group-key FD survives the SELECT projection and keysOf(root) recovers the key — published under exactly the grouping collation. Review the soundness of the direct-reference branch, the three anticipated test flips, and the flagged completeness gaps.
files:
  - packages/quereus/src/planner/building/select-aggregates.ts          # THE FIX: buildFinalAggregateProjections + buildGroupKeyColumnRef helper
  - packages/quereus/test/planner/groupby-key-completeness.spec.ts       # NEW: keysOf/runtime regression net (11 cases)
  - packages/quereus/test/coarsened-backing-key.spec.ts                  # bag2 flipped reject → real-key; bag1 rejection kept
  - packages/quereus/test/materialized-view-diagnostics.spec.ts          # computed GROUP BY key moved rejectCases → acceptCases
  - packages/quereus/test/logic/51.5-materialized-views-coarsened-key.sqllogic  # grp_bag flipped reject → registers (line ~131)
  - docs/optimizer.md                                                    # FD-tracking note on AggregateNode row
  - packages/quereus/src/planner/nodes/project-node.ts                   # reference: deriveProjectionColumnMap / projectFds (unchanged)
  - packages/quereus/src/planner/util/key-utils.ts                       # reference: deriveProjectionColumnMap maps by attr id (unchanged)
difficulty: medium
----

# Review: Collated / computed GROUP BY claims its group key

## What was implemented

`buildFinalAggregateProjections` (`select-aggregates.ts`) now fingerprints each
GROUP BY expression (`expressionToString(groupByExpressions[i].expression)` →
group-output index). For each SELECT-list item that is **non-bare**
(`column.expr.type !== 'column'`) whose **whole** expression fingerprint-matches
a GROUP BY expression, it emits the projection as a bare `ColumnReferenceNode` to
the aggregate's group output column (`aggregateAttributes[gbIdx]` — its `id`,
`type`, and column index `gbIdx`) via the new `buildGroupKeyColumnRef` helper,
instead of structurally recomputing the expression. The synthesized
`AST.ColumnExpr.name` is `expressionToString(column.expr)` so an **unaliased**
output column keeps the same name `ProjectNode.buildOutputType` produced before.
Everything else falls through to the existing recompute.

Because the emitted node references the aggregate's own key column,
`deriveProjectionColumnMap` maps it by attribute id, `projectFds` carries the
`unique` group-key FD, and `keysOf` / `isSet` recover automatically — **no change
to `key-utils.ts`, `fd-utils.ts`, `project-node.ts`, or `aggregate-node.ts`.**

The root-cause analysis in the implement ticket was confirmed exactly: the
recompute resolved the inner column to a base-table attribute id (the aggregate
group symbol is registered under `group_N`, not the inner column name, for
non-bare group exprs), which is absent from the aggregate output, so the unique
group-key FD was dropped at the projection (`keysOf(root) = []`).

## Scope decision worth a reviewer's eye

The fix only fires for `column.expr.type !== 'column'`. **Bare columns flow
through the existing recompute** — they already resolve against the aggregate
group symbol (registered under the column name) so their key already survives,
and synthesizing a `ColumnExpr.name` from `expressionToString` would mangle a
table-qualified bare column (`t.c` → a single name string). This restriction is
deliberate; confirm bare-column GROUP BYs still keep their key (they do — covered
by the broader suite, unchanged).

## Validation performed

- **Full package suite**: `yarn workspace @quereus/quereus test` → **5936 passing,
  0 failing, 9 pending** (memory vtab). Includes all aggregate / group-by /
  collation sqllogic files (`07*`, `06.4*`, `25*`, `92-hash-aggregate-edge-cases`,
  `109-aggregate-physical-selection`).
- **Lint**: `yarn workspace @quereus/quereus lint` → clean (exit 0).
- `yarn test:store` (LevelDB store path) was **NOT** run — default agent suite is
  memory-backed. The DML/grouping paths touched here are vtab-agnostic, but a
  store run is a reasonable reviewer spot-check if cheap.

### New regression net — `test/planner/groupby-key-completeness.spec.ts` (11 cases, all green)

Use cases the reviewer should treat as the *floor*, not the ceiling:
- collated single group key → `keysOf` contains `[0]`, output col 0 publishes NOCASE;
- arithmetic group key (`a+1`) → `keysOf` contains `[0]`;
- composite `group by a, b collate nocase` → `keysOf` contains `[0,1]`;
- **partial projection** (project one of two group cols) → does NOT claim `[0]` (sound under-claim);
- ordinal `group by 1` → `keysOf` contains `[0]`;
- unaliased collated col → output name is `"b collate nocase"` AND key claimed;
- **HAVING between aggregate and projection** → key still survives (added beyond ticket);
- nested expr over the key (`(b collate nocase) || 'x'`) → correctly NO key;
- same group expr aliased twice → plans + runs, no crash (see gap below);
- runtime parity: `a+1 → 6` (not 7); collated group reads representative value, n=[2,1].

## Three anticipated test flips (all in this diff)

1. `coarsened-backing-key.spec.ts` — `bag2` was `expectExecError('no provable
   unique key')`, now asserts: registers; `logicalKey = [{index:0,desc:false}]`;
   `coarsenedKey === undefined` (genuine key, not coarsened); backing PK col 0 at
   NOCASE; NOCASE dedup (`'a'`,`'A'` → one row `n=2`). `bag1` rejection kept.
2. `51.5-materialized-views-coarsened-key.sqllogic` (~line 131) — `grp_bag` flipped
   from `-- error: no provable unique key` to a registering MV returning 3 grouped
   rows (the file's data leaves contact_v1 = {Bob,Carol,DAVE}, no NOCASE collisions
   at that point). `still_bag` (key-dropping projection) rejection kept.
3. `materialized-view-diagnostics.spec.ts` — the computed GROUP BY key body
   `select k+1 as kk, count(*) as c from g group by k+1` moved from `rejectCases`
   ('no provable unique key') to `acceptCases`. **Note**: the file's own top
   comment (line ~108) *already* listed "computed group keys" among shapes that
   "all now CREATE" — this diff resolves a pre-existing self-inconsistency.

**Reviewer: confirm each flip is semantically correct** — i.e. the group columns
genuinely uniquely key the aggregate output (they do: one row per distinct group),
so registering with a real key is sound, not an over-claim.

## Known gaps / honest caveats (please scrutinize)

- **Duplicate projection of the same group expr does NOT recover the key.** The
  implement ticket optimistically claimed "`keysOf` still finds the key" for
  `select b collate nocase as g1, b collate nocase as g2, count(*) ...`. It does
  **not**: both projections reference the same aggregate attribute id, so
  `deriveProjectionColumnMap`'s first-occurrence-wins leaves the second output
  column unmapped, and the two output attributes share an id. This is the **same
  pre-existing completeness gap and duplicate-id behavior as `select id, id`** —
  not a new hazard and out of scope ("no change to key-utils.ts"). The test was
  written to the *real* behavior (no-crash + runtime correctness), not the
  ticket's claim. If the reviewer deems recovering this key worthwhile, it is a
  separate `deriveProjectionColumnMap`-level change affecting all duplicate-column
  projections — file a new ticket, don't shoehorn here.
- **Reused output attribute id.** A matched group column's output attribute id is
  the aggregate's group attribute id (preset via `Projection.attributeId`), same
  as the bare-column path. Harmless and consistent, but worth confirming no
  downstream consumer assumed the recompute's *fresh* id for these columns.
- **ORDER BY / HAVING rebuild paths** (separate from the final projection) were
  not modified; their recompute remains functionally correct and does not affect
  `keysOf(root)`. The HAVING test confirms the key survives *through* a HAVING
  filter; it does not exercise an ORDER-BY-over-grouped-expression keysOf claim.
- **Soundness anchor**: `CollateNode.isInjectiveIn` stays conservatively `false`;
  the rejected `deriveProjectionColumnMap`-special-casing alternative was NOT
  taken. The collation-soundness pins ("CollateNode is not injective", "a collated
  projection drops the source key", `select distinct b collate nocase from t12`)
  remain green — verify they were not weakened.

## Suggested adversarial checks for the reviewer

- A GROUP BY expression that fingerprint-collides with a SELECT item that is NOT
  actually the group key (e.g. shadowing / alias trickery) — confirm
  `expressionToString` equality cannot mis-map an unrelated expression onto a
  group column (it is the same fingerprint mechanism `validateAggregateProjections`
  and HAVING already rely on).
- Confirm no double-application of the group expression at runtime for the
  collated case beyond the pinned `a+1 → 6` (e.g. a CAST or function group key).
- Store-path (`yarn test:store`) spot-check of one collated-group-by MV if cheap.
