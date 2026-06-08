description: Fixed FNV-1a carry loss in 64-bit multiplication
prereq: none
files:
  packages/quereus/src/util/hash.ts
  packages/quereus/test/util/hash.spec.ts
----

## What was fixed

The `fnv1aHash` function in `hash.ts` had a carry propagation bug in its 64-bit multiplication
emulation. Applying `>>> 0` to truncate the low word *before* extracting the carry meant
`Math.floor(hashLow / 0x100000000)` always yielded 0. The fix saves the full (untruncated)
product in a temp variable (`fullLow`), truncates separately, and extracts carry from the
full product. Both multiplication blocks (ASCII byte path and multi-byte character path)
were corrected identically.

## Key files

- `packages/quereus/src/util/hash.ts` — FNV-1a implementation (lines 31-33, 40-42)
- `packages/quereus/test/util/hash.spec.ts` — 33 tests including explicit carry propagation verification
- `packages/quereus/src/schema/schema-hasher.ts` — sole consumer (runtime-only `EXPLAIN SCHEMA` output)

## Testing

- 33 hash-specific tests pass, including carry propagation test that manually computes reference hash
- Distribution, Unicode, edge-case, and integration tests all pass
- Full suite: 1013 passing, 0 failures
- Build and type-check clean
- No persistence impact — hash values are only used at runtime for `EXPLAIN SCHEMA`
