description: Property-based tests for relational algebraic identities
files:
  packages/quereus/test/fuzz.spec.ts
  tickets/fix/4-distinct-deduplication-bug.md
----
## What was built

Added an `Algebraic Identities` describe block in `fuzz.spec.ts` with 6 property-based tests
verifying relational algebra laws across randomly generated schemas and data using fast-check.

## Properties

1. **COUNT(*) matches iteration** — 100 runs
2. **SELECT DISTINCT results are unique** — skipped pending fix of DISTINCT deduplication bug
3. **UNION deduplicates, UNION ALL does not** — 75 runs
4. **EXCEPT + INTERSECT = original (as sets)** — 75 runs, uses dedicated multi-table schema generator
5. **A EXCEPT A returns zero rows** — 100 runs
6. **SUM consistency** — 100 runs, integer/real columns, 1e-6 tolerance

## Testing

- All 5 active tests pass (1 pending/skipped)
- Full suite: 1722 passing, 3 pending — no regressions
- Build clean

## Bug found

DISTINCT deduplication bug filed as `tickets/fix/4-distinct-deduplication-bug.md`.
Test is `.skip`ped until the underlying issue is resolved.

## Review findings

- **DRY fix applied**: Hoisted duplicate `setupSchema` from Grammar-Based and Algebraic
  describe blocks to module-level with explicit `db` parameter, eliminating closure dependency.
- Resource cleanup: every Database closed in `finally` — correct
- Test isolation: each property creates/closes its own Database — correct
- numRuns 75-100 per property, ~2s total for the block — suitable for CI
- Error messages include table/column names and expected vs actual values
- Cast-to-text pattern for cross-table type compatibility is sound
- Dedicated `arbMultiTableSchema` generator avoids precondition skip waste
