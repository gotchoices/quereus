description: A query that filters with "in (select ...)", sorts by an indexed column and has a placeholder limit used to read far more rows than the same query with the limit written out. The choice between seeking the keys and walking the index is now made when the query runs, using the actual limit value, so both forms read the same rows.
architecture: docs/optimizer-rules.md
files:
  - packages/quereus/src/planner/rules/access/rule-key-set-seek-row-bound.ts # attaches the bound; declines expressions unsafe to evaluate twice
  - packages/quereus/src/planner/nodes/key-set-semi-join-node.ts # KeySetRowBound, rowBound parameter, children, withChildren, logical attributes
  - packages/quereus/src/runtime/emit/key-set-semi-join.ts # evaluates the bound and makes the seek-or-walk comparison
  - packages/quereus/src/runtime/emit/limit-offset.ts # exports resolveWindow
  - packages/quereus/src/planner/optimizer.ts # registration comment
  - packages/quereus/test/vtab/key-set-semi-join-runtime.spec.ts # per-execution test, plus the drainCounted and useThousandOddKeys helpers
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic # correlated limit and writing limit cases at the end of the file
  - docs/optimizer-rules.md # line 41
  - docs/optimizer.md # line 119
repro: verified
----
## What changed

`KeySetSemiJoinNode` (a semi join that reads its key set first, then either seeks those keys on the target table or walks the table) now carries the expressions of the limit above it, as `rowBound: { limit, offset? }`. These are extra plan children, shared with the `LimitOffset` above.

`ruleKeySetSeekRowBound` no longer solves a lower `breakEvenKeys` at plan time. It attaches the bound, for literal and non-literal limits alike. `emitKeySetSemiJoin` then decides at run time. If the key count is within the existing threshold and the resolved limit is above zero, it seeks only when:

```
(seekAt2 + slope * (keys - 2)) * keys <= baselineCost * (limit + offset)
```

The limit value comes from `resolveWindow`, the helper `emitLimitOffset` uses, so null, negative, non-finite and string values mean the same in both places.

The rule declines when there is no limit, when the node already has a bound, or when either expression is non-deterministic, has side effects or has a relational descendant.

## Measured results

Memory backend, `rowsScanned` from `stmt.getWorkCounters()`, with 2000 rows in `big` and 1000 keys.

| Suffix | Rows out | Rows read |
|---|---|---|
| `limit 1`, `limit ?` = 1, `limit :n` = 1, `limit ? offset 0` = 1, `limit 1 offset ?` = 0, `limit ? + 0` = 1 | 1 | 2 |
| `limit 10`, `limit ?` = 10 | 10 | 20 |
| `limit 100`, `limit ?` = 100 | 100 | 200 |
| `limit 5000`, `limit ?` = 5000 | 1000 | 1000 |
| `limit 1 offset 998`, `limit ? offset ?` = 1, 998 | 1 | 1000 |

A limit holding a subquery that reads a table, or a non-deterministic expression, keeps the unbounded threshold and reads 1000 rows. A constant subquery such as `limit (select 1)` is folded to a literal before this rule runs, so it attaches a bound and reads 2.

## Review findings

Checked by reading the implement diff first (`ticket(implement): bug-parameterized-limit-reads-every-key`), then every use of the node type and the rules that build or remove a `LimitOffset`, then running the built engine against edge cases.

**Fixed in this pass**

- **The handoff's claim that the declines "fail safe" is wrong for a write.** With `safeToEvaluateTwice` forced to true in the built output, `limit (insert into log values (1, 1) returning n)` ran the insert twice and failed with a unique constraint error. Each emit site has its own run-once memo, so that memo does not protect against two emissions. The guard itself was correct. Added one case to `08.4-key-set-semi-join.sqllogic` that pins one write and the correct row. The subquery and non-deterministic declines only cost reads, so they stay untested.
- **Cut the test `counts a bound OFFSET in the bound`.** A literal limit now takes the same run-time path, so the existing `limit 1 offset 998` test goes through the same lines. The handoff also recorded that the cut test passed before the fix. Dropping the offset from the comparison in the built output made the bound form read 1998 rows instead of 1000, so the offset does matter.

**Tripwire recorded**

- A walk on the store reads a whole row-resolution batch, and the comparison does not model that. Parked as a `NOTE:` on `seekBeatsStoppingWalk`. This answers the handoff's open question: `ROW_RESOLUTION_BATCH` is 256 in `store-table-scan.ts`, and a seek can beat the walk below that floor. With a secondary-index key set over 2000 rows and limit 1, 10 keys seek and read 10 entries, while 40 keys walk and read 256 entries and 256 rows where a seek reads 40. From reading the old code, `limit ?` used to seek in that case, so this ticket makes the placeholder form more expensive there on the store, and equal to the literal form. The old count was not run. It costs reads, never a row, and the batch size bounds it. The handoff's statement that the comparison chose the cheaper read at every limit measured held only because no such key count had been tried.

**Open questions from the handoff, resolved**

- **A write inside a projection runs once: intended, no ticket.** `select id, (insert into w2 values (id + 1000) returning x) as y from t` writes one row and gives every row `y = 1001`. `emitScalarSubquery` memoizes a writing subquery per execution, and section 4 of `01.9-query-expr-dml.sqllogic` pins the run-once rule. `limit 0` also writes once, because `emitLimitOffset` drains a writing source on purpose. The neighbouring `IN` defect is already tracked by `bug-in-over-dml-subquery-reuses-first-rows-answer`.
- **Plan text for a folded constant subquery.** `rowBoundLimit` and the `LimitOffset`'s `limit` both print `'{}'`, confirmed by running it. Cosmetic, from `formatExpression`.
- **Shared scalar instances.** `withChildren` handles them correctly, including an absent offset. `validateCostAdditivity` skips a node it has already seen. `computePhysical` reads children 0 and 1 only. The other node-type sites (`propagate.ts`, `database-materialized-views-analysis.ts`) only compare the type.

**Checked, nothing found**

- **Correlated limit across values.** One statement with outer limits 1, 5000, 1 and 2, and with a correlated offset, returned the correct rows and read 2018 rows in total. The plan shows `rowBoundLimit = o.n` and `rowBoundOffset = o.n - 1`.
- **Limit value conversions.** `1.5` gives 2 rows, `0.5` gives 1, `true` gives 1, `'abc'` and null give 0. The helper is shared with `emitLimitOffset`, so the two agree.
- **Error order.** `LimitOffset` evaluates its expressions before opening the source, so a throwing limit fails there first. An empty key set never evaluates the bound.
- **Stale bound after a later rewrite.** A rule that removes a `LimitOffset` or changes the leaf could leave a bound behind. That costs reads and never a row, the same as the old lowered threshold. Not audited rule by rule.
- **Tie order.** Rows with equal sort values can come back in a different order from a seek on a secondary index than from a walk, so `limit ?` values on either side of the choice could split ties differently. SQL leaves tie order unspecified and literal limits already behaved this way, so no action.
- **Docs.** `docs/optimizer-rules.md` line 41 and `docs/optimizer.md` line 119 match the code, and a search of `docs/` found no other description of this mechanism. The rule header, node comments and registration comment are accurate.
- **Types and hygiene.** `withChildren` casts its scalar children the same way `LimitOffsetNode` does. No new `any`, and no references remain to the removed helpers.

**Not exercised**

- A falling cost line (negative `slope`) under a limit. An error there costs reads only.

**Tickets filed:** none. No defect was found in the shipped behaviour: the write guard already worked and now has a test, and the other items are a tripwire or intended behaviour.

## Validation

- `yarn workspace @quereus/quereus run lint`: clean.
- `yarn workspace @quereus/quereus run test`: 11048 passing, 26 pending, no failures.
- `yarn test:store`: 11041 passing, 33 pending, no failures.
- `quereus-store` specs `key-set-seek-store.spec.ts` and `runtime-key-set-plan.spec.ts`: 78 passing.
