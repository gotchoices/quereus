description: Expanded property-based testing with SQL fuzzing and parser robustness
prereq: fast-check (devDependency)
files:
  - packages/quereus/test/property.spec.ts
  - packages/quereus/README.md
----

## What was built

Extended `property.spec.ts` from 4 property-based test suites to 9, adding:

1. **Parser Robustness** — Random strings, SQL-like fragment mixtures, and random identifiers fed to `Parser.parseAll()`. Asserts: either valid AST or `QuereusError`, never unhandled exceptions.
2. **Expression Evaluation Consistency** — Random arithmetic expression trees and boolean comparisons evaluated in SQL vs JS.
3. **Comparison Properties** — Validates `compareSqlValues` maintains antisymmetry, reflexivity, and transitivity across mixed types.
4. **Insert/Select Roundtrip** — Tests value preservation through insert+select for INTEGER, REAL, TEXT, BLOB, and ANY column types.
5. **ORDER BY Determinism** — Verifies repeated ORDER BY queries with duplicate sort keys produce identical results.

## Testing

- All 20 property-based tests pass (~1s)
- Full test suite: 277 passing, 1 pre-existing failure (08.1-semi-anti-join.sqllogic — unrelated)
- `numRuns` kept at 100-200 per test for CI-friendly execution

## Review notes

- Code is well-structured with clear section organization
- Appropriate use of `fc.pre()` for preconditions (safe integer range, SQL execution failures)
- Float arbitraries correctly use `noNaN: true, noDefaultInfinity: true`
- Negative literals wrapped in parens to avoid parser ambiguity
- Division excluded from arithmetic to avoid division-by-zero edge cases
- Minor indentation fix applied (extra tab on section 2 comment)
- README updated to document all 9 property-based test categories
