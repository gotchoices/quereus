description: DELETE with a non-front-anchored range predicate (e.g. `id > 100`, `id between 51 and 150`, `id % 2 = 0`) silently under-deletes on the memory vtab — rows matching the WHERE survive. A delete-during-range-scan cursor/rebalance invalidation: the scan that feeds the delete skips or repeats nodes once the b-tree mutates mid-iteration. Reproduces on a plain table with `foreign_keys` off — no FKs, no maintained views.
files:
  - packages/quereus/src/vtab/memory/        # memory vtab cursor + delete/mutation path (b-tree)
  - packages/quereus/src/runtime/emit/        # DML executor delete loop (scan-then-delete)
  - packages/quereus/test/logic/              # add a .sqllogic range-delete regression once fixed
----

# DELETE with a leading-gap range predicate silently under-deletes (memory vtab)

## Summary

A `DELETE ... WHERE <range>` removes only a subset of the rows the same predicate
*selects*, whenever the deletion set does **not** start at the minimum key. The read
path is correct; only the delete path under-removes. Discovered while writing the
maintained-table throughput test in `reverse-fk-index-engine-consumers` — it is
**unrelated** to foreign keys (reproduces with `pragma foreign_keys` off and no FK
declared anywhere) and unrelated to maintained views.

## Reproduction (standalone, no FK / no MV)

```sql
create table src (id integer primary key, v integer);
-- insert 200 rows: (1,1) .. (200,200)
select count(*) from src where id > 100;   -- => 100  (read path correct)
delete from src where id > 100;
select count(*) from src;                  -- => 168  (EXPECTED 100; 68 matching rows survived)
```

Observed: after the delete, `select id from src where id > 100 order by id` returns 68
rows that all read back as the **same** id (e.g. `161` repeated) — a strong tell that
the cursor feeding the delete is dereferencing freed/relocated b-tree nodes as the tree
rebalances mid-scan.

## Characterization (matrix run during discovery, n=200)

| predicate                | rows matched | rows actually deleted | result |
|--------------------------|-------------:|----------------------:|--------|
| `id <= 100`              | 100          | 100                   | OK     |
| `id <= 50`               | 50           | 50                    | OK     |
| `id > 100`               | 100          | 32                    | BUG    |
| `id >= 101`              | 100          | 32                    | BUG    |
| `id between 51 and 150`  | 100          | 96                    | BUG    |
| `id % 2 = 0`             | 100          | 96                    | BUG    |
| `v > 100000` (0 rows)    | 0            | 0                     | OK     |
| `id > 5` (n=10, small)   | 5            | 5                     | OK     |

Pattern: **front-anchored** deletions (the matched set begins at the smallest live key)
are correct; deletions that leave a leading run of survivors, or interleave survivors
with deleted rows, under-delete. The bug only manifests at enough scale to force a
b-tree structural change during the scan (the `n=10` case happens to dodge it).

`foreign_keys = true` vs `false` makes no difference — the under-delete is identical.

## Why it matters

This is a **silent data-correctness** failure: a routine `delete from t where <range>`
leaves matching rows behind with no error. Any code that assumes a range delete is
complete (cascade fan-out, GC sweeps, test fixtures) is exposed.

## Suspected area

The DML delete executor iterates a scan cursor and issues per-row deletes against the
same memory-vtab b-tree it is scanning. Deleting the *current* node triggers a
rebalance/merge that relocates sibling nodes, and the cursor's saved position is not
re-seeked, so it advances past (or repeats) rows. Front-anchored deletes avoid it
because removing the leftmost leaf repeatedly keeps the cursor's next position valid.

Likely fixes to evaluate (pick per the engine's cursor model):
- Materialize the matching keys first (snapshot), then delete by key outside the scan;
  or
- Make the memory-vtab cursor delete-stable (re-seek to the saved key after a structural
  mutation), matching how SQLite's b-tree cursors restore position after a `balance()`.

## Acceptance

- The matrix above all reports OK (matched == deleted) for any predicate / size.
- A `.sqllogic` regression under `test/logic/` covering a tail predicate (`id > k`), an
  interleaved predicate (`id % 2 = 0`), and a `between` over a large-enough table.
- `delete from src where id > 100` over 200 rows leaves exactly 100 rows, none with
  `id > 100`.

## Notes for the next agent

- The `reverse-fk-index-engine-consumers` throughput test deliberately uses a
  front-anchored `delete ... where id <= 100` to avoid this bug; once fixed, that test
  can exercise a tail predicate too, and the inline caveat comment there can be dropped.
