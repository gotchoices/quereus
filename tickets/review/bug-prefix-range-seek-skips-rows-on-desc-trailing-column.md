description: On the in-memory backend, a query that filters on the first column of a compound index and asks for values greater than some number on a following column declared descending used to lose rows. It now returns every matching row; this ticket is the code review of that fix.
architecture: docs/memory-table.md
files:
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts
  - packages/quereus/test/logic/05.1.1-secondary-index-range-scan.sqllogic
  - packages/quereus/test/logic/05.1-composite-pk-range-scan.sqllogic
  - packages/quereus/test/vtab/scan-layer-descending.spec.ts
  - docs/memory-table.md
repro: verified
----

A prefix-range scan is a query with equality on the leading columns of a compound key and a range on the next column, such as `k = 'a' and r > 1` over `(k, r desc)`. On the memory backend, when that next column was `desc`, the scan started at the lower bound. Larger values sort first in a `desc` column, so every matching row above the bound sat before the start point and was skipped. The store backend already handled this and was not affected.

## What changed

All code changes are in `scan-layer.ts`, and both the primary key and secondary index branches get them.

- **Direction:** `seekFromUpper` now reads the direction of the column the bound applies to, at position `plan.equalityPrefix?.length ?? 0`, instead of column 0. `isDescFirstColumn` is now `isDescBoundColumn`.
- **Start key:** the prefix start key appends the bound chosen by `seekFromUpper`, instead of always the lower bound.
- **Stopping:** a prefix walk now also stops when the bound column passes the bound the walk ends at, instead of reading to the end of the group. It compares only that bound, because the bound the walk starts from can reject its first row with matches still ahead.
- **Helpers:** `pastTerminatingBound` is the helper the ticket prescribed. I also added `walkIsExhausted`, which the ticket did not ask for. It moves the duplicated prefix-mismatch loop out of both branches, so each branch's handling of a rejected row is now one call.

Comments that named the old flag were updated, in `05.1.1-secondary-index-range-scan.sqllogic` and `scan-layer-descending.spec.ts`. `docs/memory-table.md` gains a sentence on the prefix-range bullet.

## Tests added

All are sqllogic cases, so they also run against the store. "Failed before" means the query returned wrong rows on the unfixed code. "Guard" means it passed before and protects against a mistake this fix could introduce.

In `05.1.1-secondary-index-range-scan.sqllogic` (secondary index):

| Query | Verifies | Before the fix |
| --- | --- | --- |
| `prd`: `k = 'a' and r > 1` | Exclusive lower bound over `(k, r desc)`, the reported bug | Failed before |
| `prd`: `r >= 2` | Inclusive lower bound keeps the row at the bound | Failed before |
| `prd`: `r > 1 and r < 3` | A start bound that rejects the first row does not end the walk | Failed before |
| `prd`: `r between 2 and 3` | Seek landing exactly on an inclusive upper bound | Failed before |
| `prd`: `r < 3` | Upper bound only, walking to the end of the group | Guard |
| `prd`: `k = ? and r > ?` | Bounds supplied at runtime | Failed before |
| `prd` in a transaction: `r >= 2 and r <= 4` | Reads a transaction's own insert and delete, seeking mid-group | Not run on unfixed code |
| `prdm`: `r >= 2` over `(k, r desc, s)` | Walk does not stop among rows sharing the bound value | Failed before |
| `prdm`: `r <= 2` | Seek lands before all rows sharing the bound value | Guard |
| `prdq`: `a = 1 and b = 1 and r > 1` over `(a desc, b, r desc)` | Bound column at position 2 | Failed before |
| `sfxd`: `k = 'd' and r > 1` over `(k desc, r)` | Direction comes from the bound column, not column 0 | Guard |
| `prdn`: `r > 1` over `(k, r desc)` with NULLs | NULLs at the end of a `desc` group never match | Failed before |
| `prdn`: `r < 3` | The same NULLs, with only an upper bound | Guard |
| `prn`: `r < 3` over `(k, r)` with NULLs | NULLs at the start of an ascending group do not stop the walk | Guard |
| `prdc`: `r > 'a'` over a NOCASE column | Stopping follows the collation's order; `'A'` equals `'a'` | Failed before |

In `05.1-composite-pk-range-scan.sqllogic` (primary key):

| Query | Verifies | Before the fix |
| --- | --- | --- |
| `pfxr`: `k = 'a' and r > 1` over `primary key (k, r desc)` | The reported bug, on the primary key branch | Failed before |
| `pfxr`: `r >= 2 and r < 3` | A start bound that rejects the first row, on this branch | Guard |
| `pfxr`: `r < 3` | Upper bound only, on this branch | Guard |
| `pfxd`: `k = 'd' and r > 1` over `(k desc, r)` | Direction comes from the bound column, on this branch | Guard |

Compared with the ticket's list, I removed assertions that repeated the same behaviour. I added the two `(k desc, r)` guards and the ascending NULL case, because the ticket's `(a desc, b, r desc)` table cannot tell column 0 from the bound column, and its NULL table covered only `desc`.

## Validation

- `yarn workspace @quereus/quereus test`: 10985 passing, 26 pending.
- `yarn workspace @quereus/quereus test:store`: 10978 passing, 33 pending.
- `yarn workspace @quereus/quereus lint`: clean.
- Test suites of every other workspace package: passing, including isolation, store and sync.
- A throwaway randomized check, not committed: 35,400 queries over 12 key shapes, inside and outside an open transaction, compared against the same queries on an unindexed copy of the table. None differed. As a check on the check, reading the direction from column 0 instead made 4,330 of those queries wrong; the fix was then restored and confirmed byte-identical.

## Known gaps

- **Early stopping has no test.** The new stop only saves work, and every test checks results, so removing it would not fail anything. How many rows it saves was not measured.
- **Seek use was not confirmed per shape.** The randomized check's test for whether a plan used an index is a loose text match on the plan, so it does not show that each of the 12 shapes used the prefix-range seek. Its output, cut off after the first 15 differences, showed `(k, r desc)` going wrong under the deliberate break.
- **The transaction case was never run on unfixed code.** It was added with the others, but my per-query run on the unfixed code left it out. From the code, it should have failed there.
- **Reverse walks stay broken, as the ticket expected.** A reverse walk (`plan.descending`) over a prefix plan with no bound on its start side still leaves the group at once. No engine path requests this today, and `feat-reverse-index-walk-for-desc-ordering` records it.

## For the reviewer

- `pastTerminatingBound` now returns false for an `undefined` value in the leading-column path too, where the old code passed it to the comparator. That path can only see `undefined` on a zero-column key, which has no column for a bound to constrain.
- `order by r desc` over a nullable `desc` index returns NULLs first. This looks wrong next to the index's order but is documented in `docs/invariants.md`, which says `ORDER BY` places NULLs first in both directions, and this fix does not change it.
