description: Pattern-matching operators like LIKE and GLOB rebuild their matcher from scratch for every single row scanned, which wastes time on large scans where the pattern never changes.
files:
  - packages/quereus/src/util/patterns.ts (pattern-to-RegExp compilation — around lines 16–30)
  - packages/quereus/src/runtime/emit/binary.ts (emitLikeOp and related callers)
  - packages/quereus/src/func/builtins/string.ts (like/glob builtins)
difficulty: medium
----

## Problem

`util/patterns.ts` (~16–30) converts a LIKE/GLOB pattern into a `RegExp` by
running two `.replace` passes over the pattern string and then constructing a new
`RegExp`. The callers in `runtime/emit/binary.ts` (`emitLikeOp`) and
`func/builtins/string.ts` invoke this per row. For a scan of N rows against a
constant pattern, the engine compiles the same regular expression N times —
pure wasted work in a hot path.

## Expected behavior

A compiled pattern should be reused across rows instead of rebuilt each time. Two
complementary improvements:

1. **Memoize** compiled patterns behind a small bounded (LRU) cache keyed by the
   pattern string (plus any escape char / case-fold flag that affects
   compilation). Repeated compilation of the same pattern becomes a cache hit.
2. **Pre-compile at emit time** in `emitLikeOp` when the pattern operand is a
   literal constant — the regex is built once during planning/emit and captured
   in the closure, so no per-row lookup or compilation happens at all.

Results must be byte-for-byte identical to today's matching semantics; this is a
performance change only.

## Use case

```sql
select * from big_table where name like 'A%';   -- pattern constant across all rows
```

Today: one RegExp compiled per row. Expected: compiled once (literal → emit-time),
or a cache hit per row (dynamic pattern).

## Edge cases & interactions

- ESCAPE clause: the escape character participates in compilation and must be part
  of the memoization key. Different escape chars must not collide.
- Case-insensitive variants (GLOB vs LIKE case-folding rules) must key separately.
- Non-literal / correlated patterns (pattern differs per row) must still work —
  they fall through to the memoized path, not the emit-time path.
- Bounded cache: pick a small cap and an eviction policy so a workload with many
  distinct patterns cannot grow the cache unboundedly.
- NULL pattern / NULL subject handling must be unchanged.

## TODO

- Add a bounded (small LRU) memoization cache in `util/patterns.ts` keyed on pattern string + escape char + case-fold flag.
- Detect literal-constant pattern operands in `emitLikeOp` (`runtime/emit/binary.ts`) and pre-compile once, capturing the matcher in the emitted closure.
- Route the `func/builtins/string.ts` like/glob builtins through the memoized compile path.
- Confirm ESCAPE and case-folding variants key distinctly.
- Add a test asserting matching semantics are unchanged (including ESCAPE and NULL cases); optionally a micro-benchmark or a compile-count assertion proving compilation no longer happens per row.
