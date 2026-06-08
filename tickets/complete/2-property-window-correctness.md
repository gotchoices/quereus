description: Property-based tests for window function correctness invariants
status: complete
files:
  packages/quereus/test/property.spec.ts
----
## What was built

Five property-based tests (section 13 "Window Function Invariants" in property.spec.ts)
that verify mathematical invariants of window function outputs using fast-check:

1. **row_number() contiguous 1..N** — unpartitioned, ordered by id
2. **Partitioned row_number() 1..K** — restarts per partition, contiguous within each
3. **Running sum = cumulative sum** — windowed SUM with ROWS UNBOUNDED PRECEDING matches manual prefix sums
4. **Total window sum = aggregate sum** — SUM() OVER () on every row equals SELECT SUM()
5. **rank()/dense_rank() tie consistency** — same key → same rank; dense_rank gap-free; rank = 1-based first-occurrence position

## Testing notes

- All 5 tests pass (50 runs each), full property suite passes (68 tests)
- Type check clean
- Integer-only data avoids floating-point drift
- Uses parameterized queries with prepared statements; statements finalized in `finally` blocks
- Follows existing file conventions (table creation outside `fc.assert`, DELETE + re-insert inside property)

## Review notes

- No DRY, correctness, or resource cleanup issues found
- Table names (`wf_rn`, `wf_prn`, `wf_rsum`, `wf_tsum`, `wf_rank`) are unique and scoped to their tests
- Edge cases covered: single-row (minLength: 1 for most), small key ranges (1-10) to ensure tie coverage in rank tests
