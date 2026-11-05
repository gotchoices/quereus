description: A query that filters with "in (select ...)", sorts by an indexed column and has a placeholder limit used to read far more rows than the same query with the limit written out. The choice between seeking the keys and walking the index is now made when the query runs, using the actual limit value, so both forms read the same rows.
architecture: docs/optimizer-rules.md
files:
  - packages/quereus/src/planner/rules/access/rule-key-set-seek-row-bound.ts # attaches the bound; declines expressions unsafe to evaluate twice
  - packages/quereus/src/planner/nodes/key-set-semi-join-node.ts # KeySetRowBound, rowBound parameter, children, withChildren, logical attributes
  - packages/quereus/src/runtime/emit/key-set-semi-join.ts # evaluates the bound and makes the seek-or-walk comparison
  - packages/quereus/src/runtime/emit/limit-offset.ts # exports resolveWindow
  - packages/quereus/src/planner/optimizer.ts # registration comment
  - packages/quereus/test/vtab/key-set-semi-join-runtime.spec.ts # two new tests, plus the drainCounted and useThousandOddKeys helpers
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic # correlated limit case at the end of the file
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

Memory backend, `rowsScanned` from `stmt.getWorkCounters()`, with 2000 rows in `big` and 1000 keys, using the ticket's reproduction schema. Every row now matches the ticket's "read after the fix" column.

| Suffix | Rows out | Rows read |
|---|---|---|
| `limit 1`, `limit ?` = 1, `limit :n` = 1, `limit ? offset 0` = 1, `limit 1 offset ?` = 0, `limit ? + 0` = 1 | 1 | 2 |
| `limit 10`, `limit ?` = 10 | 10 | 20 |
| `limit 100`, `limit ?` = 100 | 100 | 200 |
| `limit 5000`, `limit ?` = 5000 | 1000 | 1000 |
| `limit 1 offset 998`, `limit ? offset ?` = 1, 998 | 1 | 1000 |

Other forms, measured with a throwaway script on the memory backend. None of these is pinned by a repository test:

| Form | Rows out | Rows read | Bound attached |
|---|---|---|---|
| `limit (select n from cfg where id = 1)` | 1 | 1000 | no |
| `limit 1 offset (select n - 1 from cfg where id = 1)` | 1 | 1000 | no |
| `limit abs(random()) % 1 + 1` | 1 | 1000 | no |
| `limit (select 1)`, `limit 1 offset (select 0)` | 1 | 2 | yes, see below |
| `limit 0`, `limit ?` = 0, -1 or null | 0 | target not read | yes |
| `limit ?` = `'1'` or `1n` | 1 | 2 | yes |
| `limit ? offset ?` = 1, -5 or 1, null | 1 | 2 | yes |

Correlated limit: `select o.n, (select id from (... limit o.n) x order by id limit 1) as r from o` returns `[{n:1,r:1999},{n:2,r:1997}]`, with a key-set node showing `rowBoundLimit = o.n`.

Store backend, which the ticket asked to record: an in-memory key-value store through `StoreModule`, with no isolation layer, built from `dist`. Literal and `limit ?` forms gave identical counts at every limit tried. "Key-value entries" counts `iterate()` entries on the `big` stores.

| Key set on | Limit | Rows out | `rowsScanned` | Key-value entries | `get()` calls |
|---|---|---|---|---|---|
| secondary index | 1, 10, 100 | 1, 10, 100 | 2, 20, 200 | 256 | 256 |
| secondary index | 5000 | 1000 | 1000 | 1000 | 1000 |
| secondary index | `limit ?, offset ?` = 1, 998 | 1 | 1000 | 1000 | 1000 |
| primary key | 1, 10, 100 | 1, 10, 100 | 2, 20, 200 | 256 | 256 |
| primary key | 5000 | 1000 | 1000 | 0 | 1000 |

So on the store a walk costs at least 256 entries, whatever the limit. That figure is the same at limits 1, 10 and 100, and looks like the store's row resolution batch size (`ROW_RESOLUTION_BATCH`), though I did not confirm that. The comparison does not model this floor. It still chose the cheaper read at every limit measured here, but a limit where a seek reads fewer than 256 rows was not tried.

## Tests added

In `key-set-semi-join-runtime.spec.ts`, under `under a LIMIT`:

- `chooses per execution from the bound limit: one statement, limit ? = 1 then 5000` verifies that one prepared statement walks with `[1]` (reads 2) and seeks with `[5000]` (reads 1000). It failed before the fix with 1000 reads in place of 2.
- `counts a bound OFFSET in the bound: limit ? offset ? = 1, 998` verifies that the offset expression reaches the comparison. **It passed before the fix too**, because it reads 1000 both ways, as the ticket's table says. It guards against a regression and does not demonstrate the fix: an implementation that ignored the offset would walk and read about 1997.

In `08.4-key-set-semi-join.sqllogic`:

- The correlated limit query verifies that the node's own evaluation reads the same outer row as the `LimitOffset`, and that the rows are unchanged.

The existing literal tests pass unchanged and now cover the run-time path.

## Validation

- `yarn workspace @quereus/quereus run lint`: clean.
- `yarn workspace @quereus/quereus run test`: 11049 passing, 26 pending, no failures.
- `yarn test:store`: 11042 passing, 33 pending, no failures.
- `quereus-store` specs `key-set-seek-store.spec.ts` and `runtime-key-set-plan.spec.ts`, after `tsc -b tsconfig.build.json` because they load the engine from `dist`: 78 passing.

## Known gaps and things to check

- **Departure from the ticket text.** The ticket says `limit (select ...)` keeps today's behaviour. That holds for a subquery that reads a table. A constant subquery such as `limit (select 1)` is folded before this rule runs, into a literal holding a promise, so no relational descendant remains and the bound attaches. It reads 2 rows where it read 1000 before. Awaiting the same promise twice gives the same value without re-reading anything, so I left it. The plan text for that literal prints as `'{}'` in `rowBoundLimit`. That comes from `formatExpression`, which `LimitOffset` also uses on the same instance, so I expect it to print the same there, though I did not look at that output.
- **Not pinned by a test:** the declines for a subquery and for a non-deterministic expression, the already-has-a-bound decline, and the resolved `limit <= 0` branch. I left them out because the ticket listed specific tests and the declines fail safe (they cost reads, not rows). A reviewer may want one test for the declines, since a wrong admission would evaluate a table-reading expression twice per execution.
- **The `limit <= 0` branch was only run once, by hand.** `select id, (insert into log values (id) returning x) as y from big b where b.id in (select bid from small) order by b.v limit 0` plans a key-set node with a bound and returned 0 rows without error.
- **A falling cost line is not exercised under a limit.** The ticket notes that the run-time check can differ from the old solved threshold when `slope` is negative. The `flat` test arm has slope 0 and no limit.
- **Shared scalar instances.** The bound expressions are now children of two nodes. `MaterializationAdvisory` only caches relational nodes, and `validateCostAdditivity` already tolerates shared children. The node's total cost now includes the bound's small cost. I read of no later rule that decides on this number, per the existing `NOTE:` in the node's constructor, but did not audit further.
- **The `NOTE:` on literal limits is removed** from the rule header, and the even-spread `NOTE:` is reworded for the run-time comparison.

## Noticed, out of scope

A write inside a projection appears to run once, not once per row, with no key-set node involved. Over a 50-row table `t`, `select id, (insert into log values (id + 1000) returning x) as y from t` added one row to `log`, and the same query with `limit 0` also added one. I did not investigate the cause, confirm whether this is intended, or compare against older code. A search of the open ticket folders for a few likely terms found nothing, so this is unfiled. It does not come from this ticket's diff, because the query has no key-set node.
