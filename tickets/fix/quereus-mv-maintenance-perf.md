# Quereus feedback: incremental materialized-view maintenance is ~50–120× slower than a one-shot rebuild

**Stack:** `@quereus/quereus` 4.3.2 + `@quereus/plugin-indexeddb` (store vtab), browser (headless Chromium).
Single standalone `Database`, `pragma default_vtab_module='store'`.

**TL;DR:** `CREATE MATERIALIZED VIEW … USING store AS SELECT … GROUP BY …` is excellent — correct,
incrementally maintained, and reads are milliseconds. But **maintaining the MV as source rows are inserted
costs ~2.9 ms per row per MV**, whereas **building the identical MV in one shot over an already-populated
table costs ~0.05 ms per row** — a ~50–120× gap. This makes bulk loads (imports) with live MVs
impractical, and strongly suggests per-row maintenance issues **one store round-trip per source row even
inside a single `BEGIN…COMMIT`**, rather than batching the maintenance for the transaction.

---

## Setup

```sql
CREATE TABLE spike_entry (id text primary key, account_id text, period text, amount integer);
CREATE MATERIALIZED VIEW spike_bal (account_id, balance, n) USING store AS
  SELECT account_id, SUM(amount) AS balance, COUNT(*) AS n FROM spike_entry GROUP BY account_id;
CREATE MATERIALIZED VIEW spike_bucket (account_id, period, amount, n) USING store AS
  SELECT account_id, period, SUM(amount) AS amount, COUNT(*) AS n FROM spike_entry GROUP BY account_id, period;
```

Data: N=1000 rows across 40 accounts / 72 (account,period) buckets. Inserts are batched into multi-row
`INSERT … VALUES (…),(…)` (~100 rows/statement) inside one `BEGIN…COMMIT`.

## Measurements (N=1000, headless Chromium, warm)

| Operation | Time | Per row |
|---|---|---|
| Insert 1000 into a plain table (no MV), one txn | **425–444 ms** | ~0.44 ms |
| Insert 1000 into a table with the **2 MVs** above, one txn | **6,193–6,214 ms** | ~6.2 ms (~2.9 ms/row/MV) |
| **One-shot `CREATE MATERIALIZED VIEW` over the pre-loaded 1000-row table** (single MV) | **51 ms** | **~0.05 ms** |
| Read all 40 balances from the MV | 5 ms | — |
| Read the same via full scan + JS group-by | 57 ms | — |
| As-of balance (`WHERE account_id=? AND period <= ?` on bucket MV) | 8 ms | — |
| Range sum (`WHERE account_id=? AND period BETWEEN ? AND ?` on bucket MV) | 7 ms | — |

Correctness: MV totals matched the full-scan totals exactly; a single post correctly updated the
affected account's MV balance in place.

## The gap

- **Incremental maintenance:** ~2.9 ms/row/MV. Subtracting the ~0.44 ms/row base insert, the two MVs add
  ~5.8 ms/row of maintenance.
- **One-shot rebuild of the same aggregate:** ~0.05 ms/row.

So producing the *same* MV contents costs ~50–120× more when done row-by-row during insert than when
done as a single pass over the finished table — even though all the inserts are in **one transaction**.
That pattern is what you'd see if maintenance performs an isolated keyed read-modify-write against the
store **per source row** (each an awaited IndexedDB op) instead of accumulating per-group deltas and
applying them once per group at commit.

## Impact

A realistic import (≈35k ledger entries) with two live MVs would spend minutes in maintenance
(≈35k × ~5.8 ms ≈ 200 s) versus ≈15 s for the plain inserts, or ≈1.8 s to rebuild both MVs in one shot
afterward. Today's workable pattern is therefore "drop MV → bulk load → recreate MV," but that defeats
the point of *maintained* views for bulk paths.

## Ask

Batch MV maintenance within a transaction: accumulate per-group deltas across all statements in the
`BEGIN…COMMIT` and apply them once per affected group at commit (coalescing multiple hits to the same
group), rather than one keyed store round-trip per source row. That would bring bulk-write-with-MV close
to the one-shot-build cost and make maintained views usable on import paths.

## Repro

The full harness is a ~120-line SvelteKit route that creates the tables/MVs, inserts, and times each
step; available on request. Reads and single-row incremental maintenance are already excellent — this is
specifically about bulk write amplification.

## Verified clean / not the issue

- MV **reads** are fast and use the MV's own GROUP-BY key for seeks (5–8 ms).
- MV **correctness** and single-row **incremental** updates are correct.
- One-shot MV **build** over a populated table is fast (~0.05 ms/row) — the aggregate itself is cheap; the
  cost is specifically in per-row maintenance during DML.
