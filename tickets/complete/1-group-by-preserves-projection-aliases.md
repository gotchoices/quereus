description: GROUP BY no longer drops SELECT-list aliases on grouped column refs; ORDER BY can resolve the alias in the aggregate path
prereq:
files:
  packages/quereus/src/planner/building/select-aggregates.ts
  packages/quereus/src/planner/building/select-modifiers.ts
  packages/quereus/src/planner/building/select.ts
  packages/quereus/test/logic/07.3-group-by-extras.sqllogic
  packages/quereus/test/logic/25.1-nested-aggregates.sqllogic
  packages/quereus/test/logic/26.2-left-join-on-vs-where.sqllogic
----
## What was built

When a SELECT with GROUP BY projected a grouped column under a different
SELECT-list alias (e.g. `select grp as g, count(*) as cnt from t group by grp`),
the alias was silently dropped — output rows came back keyed on the underlying
column name (`grp`) instead of the SELECT alias (`g`). The same shape was
visible in the LEFT-JOIN-with-HAVING test in 26.2 (`group by ow_l.id` aliased
as `lid`). The bug was originally framed as HAVING-specific but reproduces
whenever GROUP BY is present and the alias renames a grouped column reference.

### Code changes

1. **`src/planner/building/select-aggregates.ts`** — `checkNeedsFinalProjection`
   was widened. It used to trigger a final projection only for non-trivial
   expressions; an alias-only rename on a simple ColumnReferenceNode was a no-op,
   so the AggregateNode's column-naming (which uses `colRef.expression.name`)
   leaked through. Now any projection whose alias differs (case-insensitively)
   from the underlying column name forces the final ProjectNode.

2. **`src/planner/building/select.ts`** — after the aggregate path's final
   ProjectNode is built, an `aggregateProjectionScope` is captured via
   `createProjectionOutputScope` and passed to the post-aggregate `applyOrderBy`
   and `applyLimitOffset`. This mirrors the non-aggregate path, which already
   threaded `finalResult.projectionScope` through the same calls. Without it,
   ORDER BY could not resolve a SELECT-list alias like `order by g` once the
   alias started reaching the output.

3. **`src/planner/building/select-modifiers.ts`** — `createProjectionOutputScope`
   was promoted from private to exported so the aggregate path can reuse it.

The `preserveForAggregate` flag (HAVING-only / ORDER-BY-only aggregate stripping)
was reviewed and left unchanged — `hasHavingOnlyAggregates` /
`hasOrderByOnlyAggregates` are computed from `dedupeNewAggregates` and don't
fire merely because a SELECT alias renamed a grouped column.

## Key files

- `packages/quereus/src/planner/building/select-aggregates.ts` — alias-aware `checkNeedsFinalProjection`
- `packages/quereus/src/planner/building/select.ts` — captures `aggregateProjectionScope`, threads it into ORDER BY / LIMIT
- `packages/quereus/src/planner/building/select-modifiers.ts` — exports `createProjectionOutputScope`

## Tests

- `test/logic/07.3-group-by-extras.sqllogic` — three new positive tests under `gx`:
  - alias survives + ORDER BY by alias (`select grp as g, count(*) as cnt from gx group by grp order by g`)
  - same with HAVING
  - minimal repro: alias-only on grouped column, no aggregates (`select grp as g from gx group by grp order by g`)
- `test/logic/25.1-nested-aggregates.sqllogic` — replaced a commented-out
  HAVING-in-derived-table block (its threshold of 25 was non-discriminating —
  every group qualified, so the expected total of 120 was just wrong) with a
  positive test using threshold > 35 (eliminates group `a`=30, keeps b=70 and
  c=50, outer sum = 120). Provides regression coverage that HAVING propagates
  through derived tables.
- `test/logic/26.2-left-join-on-vs-where.sqllogic` — line 40 expectation
  updated from the buggy `{"id":1,"cnt":1}` to `{"lid":1,"cnt":1}`. The
  `-- TODO bug:` notes above it were removed.

## Validation

- `yarn build` passes.
- `yarn lint` (in `packages/quereus`) passes.
- Targeted `yarn test --grep "07.3|25.1|26.2"` passes.
- Full `yarn test` suite: 918 passing. The single failing test
  (`extended-constraint-pushdown` / OR-with-range-residual) is a pre-existing
  regression introduced by a later commit, unrelated to this ticket — verified
  by running it at this ticket's implement commit (`ed445e8e`), where it passed.

Manual sanity checks:
- `select grp as g, count(*) as cnt from gx group by grp;` → `{"g":…,"cnt":…}`
- `select grp as g from gx group by grp order by g;` → ordered output, alias visible to ORDER BY.
- 07.3 line 22 (`select grp, count(*) as cnt from gx group by grp order by grp`) — underlying column name fallback path still works.
- 07.3 line 41 (`order by 2 desc`, ordinal) and line 95 (`order by max(val)`, ORDER-BY-only aggregate) — unchanged code paths, regression-checked.

## Notes for future work

- Scope layering: `aggregateProjectionScope` is layered ABOVE `selectContext.scope`
  via `ShadowScope`, so projection-output names win over aggregate-output names
  when both exist. For grouped column aliases this is the desired behavior.
- `applyLimitOffset` now also receives `aggregateProjectionScope`. LIMIT/OFFSET
  expressions referencing aliases are unusual but the symmetry with the
  non-aggregate path is the reason for the change.
- The case-insensitive comparison in `checkNeedsFinalProjection` matches
  existing case-insensitive handling in the planner (e.g., `isIdentityProjection`).
