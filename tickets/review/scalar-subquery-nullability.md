description: A subquery used as a single value — `(select val from t where …)` — yields null when it finds no row, but the engine told callers it could never be null whenever the selected column was declared not null. It now announces "possibly null" unless the subquery is guaranteed to produce a row.
architecture: docs/types.md#enforcement-quereus_repr_strict
files:
  - packages/quereus/src/planner/analysis/always-yields-row.ts       # new: alwaysYieldsARow(relation)
  - packages/quereus/src/planner/nodes/subquery.ts                   # ScalarSubqueryNode.getType uses it
  - packages/quereus/test/announced-result-types.spec.ts             # three-case pin
  - packages/quereus/test/logic/07.6.1-subquery-extras.sqllogic      # LIMIT/OFFSET from a subquery now needs coalesce
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic      # `limit (insert … returning n)` now needs coalesce
  - packages/quereus/test/lens-advertisement.spec.ts                 # EAV logical columns declared `null`
  - packages/quereus/test/lens-put-fanout.spec.ts                    # EAV logical column declared `null`
  - docs/sql-select.md                                               # §3.6 rejected-shapes list
  - docs/lens-default-mapper.md                                      # EAV columns must be declared nullable
----

# Scalar subqueries announce nullable unless they always produce a row

## What changed

`ScalarSubqueryNode.getType()` now returns the subquery's first-column type with `nullable: true` unless that column is already nullable or `alwaysYieldsARow(subquery)` holds.

`alwaysYieldsARow` (`planner/analysis/always-yields-row.ts`) is a structural switch on `nodeType`, conservative (`false` when unsure). It accepts:

- an aggregate with no grouping keys — `Aggregate`, `StreamAggregate`, `HashAggregate`;
- `SingleRow`, and `Values` with ≥ 1 row;
- a row-preserving wrapper over an accepted relation: `Project`, `Alias`, `Sort`, `Distinct`, `Cache`, and `LimitOffset` whose limit is absent or a constant ≥ 1 and whose offset is absent or the constant 0.

Everything else (a `Filter` above an aggregate — i.e. HAVING —, a grouped aggregate, table access, joins, set operations, DML-with-RETURNING) is rejected.

It uses type-only node imports plus `nodeType` checks, so it adds no runtime import cycle through `subquery.ts` beyond `limit-offset.ts` (for `constantNumber`).

## Deviations from the implement ticket — check these

- **`Cache` added to the accepted list.** The ticket said "keep it to that list", but the optimizer's `rule-scalar-subquery-cache` wraps every uncorrelated, functional scalar subquery's body in a `CacheNode`. Without it, `select (select count(*) from t)` announces non-null before optimization and nullable after (`Statement.getColumnDefs()` reads the optimized plan), and the ticket's own pin fails. Verified the optimized shape with `query_plan`: `SCALARSUBQUERY → CACHE → STREAMAGGREGATE → INDEXSCAN` (the inner `Project` was also collapsed away). `Cache` replays its source rows, so it is row-preserving.
- **`LimitOffset` with no limit** (offset absent or 0) is accepted as row-preserving; the ticket only named "constant limit ≥ 1".
- **One more fallout the ticket did not predict:** `test/logic/08.4-key-set-semi-join.sqllogic` line 518 used `limit (insert into lim_log values (1) returning n)`. An `insert … returning` can produce zero rows (`on conflict do nothing`, `insert or ignore`), so it is now rejected as a nullable LIMIT. Wrapped it in `coalesce(…, 0)`; the test's point (a writing LIMIT runs once — the following `count(*) from lim_log` = 1) still holds and passes. Reviewer: confirm the coalesce'd form still exercises the "LIMIT that writes must stay off the key-set semi-join node" path, not just the write-count assertion.
- **Second lens fallout:** `lens-put-fanout.spec.ts` "an EAV write stores the declared (mixed) case attribute…" declared `City integer` (NOT NULL under the default nullability) over an EAV pivot; now `City integer null`, same treatment as `lens-advertisement.spec.ts`.

## Tests

- Added: `announced-result-types.spec.ts` › "announced nullability of a scalar subquery" — one `it` with three assertions: `(select count(*) from t)` non-null (ungrouped aggregate, survives the optimizer's `Cache` wrap); `(select count(*) from t group by i)` nullable; `(select id from t where i = 1)` nullable over a NOT NULL `id`.
- Changed: `07.6.1-subquery-extras.sqllogic` now asserts `limit (select lim from sqx_limits where lim = 2)` errors with "LIMIT expression may be NULL", then runs the LIMIT and LIMIT+OFFSET cases through `coalesce(…, 0)`.
- Nothing else new; the other shapes the 2026-11-16 measurement found are already exercised by the suite and become regressions once `announced-nullability-egress-check` installs the strict egress check.

## Validation run

- `node … mocha "packages/quereus/test/**/*.spec.ts"` (full suite without `--bail`): 11191 passing, 23 pending, 0 failing.
- `yarn workspace @quereus/quereus lint`: clean.
- `quereus-isolation` (460), `quereus-store` (2019), `quereus-sync` (879) test suites: all passing — they deploy lenses and could have hit the EAV nullability change.
- Not run: `yarn test:store` (LevelDB-backed logic tests). The two edited `.sqllogic` files change only SQL text, not store behaviour.

## Known gaps / things a reviewer might push on

- Rewrites that replace a `ScalarSubqueryNode` (decorrelation, `substituteSubqueries`) were not audited one by one; the ticket said to rely on the suite, which passes.
- An optimizer rule that replaces an ungrouped aggregate with a node not on the list (none observed) would flip the announcement from non-null to nullable after optimization — the sound direction, but it would turn a previously accepted `limit (select count(*) …)` into a prepare-time rejection only if the LIMIT check ran post-optimization; it runs at build time, so it does not.
- `TableLiteralNode` (const-folded rows) is not accepted even when it holds a non-empty literal array — its rows can be a single-shot stream. If a const-folded scalar subquery ever shows up announcing nullable where it should not, that is the place to look.
- EXISTS / IN subqueries are untouched (separate node types, boolean typing).
