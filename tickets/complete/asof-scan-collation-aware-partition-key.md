---
description: AsofScan partition keys honor collation (NOCASE / RTRIM)
files:
  - packages/quereus/src/runtime/emit/asof-scan.ts
  - packages/quereus/test/logic/84-asof-scan.sqllogic
---

## What was built

`emitAsofScan` previously built right/left partition bucket keys with a
local BINARY-equivalent encoding (`${typeof v}:${String(v)}` joined by
spaces), so `'a'` and `'A'` hashed to different buckets even when the
partition column was COLLATE NOCASE — yielding wrong asof matches under
non-BINARY collations.

Both bucket-build and bucket-probe now use the shared collation-aware
`serializeRowKey` helper from `packages/quereus/src/util/key-serializer.ts`
— the same one bloom join, hash-aggregate, and window already use. The
serializer's invariant (key equality matches comparator equality classes
for BINARY / NOCASE / RTRIM, verified by
`test/collation-normalizer.spec.ts`) is exactly what AsofScan needs.

## Key files

- **`packages/quereus/src/runtime/emit/asof-scan.ts`**
  - Imports `resolveKeyNormalizer`, `serializeRowKey`.
  - Builds a parallel `keyNormalizers: ((s: string) => string)[]` while
    walking `plan.partitionAttrs`, picking
    `leftAttrs[leftIdx].type.collationName ?? rightAttrs[rightIdx].type.collationName`
    per pair — mirroring `bloom-join.ts:41-42`.
  - Build-side (right) and probe-side (left) both call
    `serializeRowKey(row, indices, keyNormalizers)`.
  - Local `buildPartitionKey` and its "BINARY-only" caveat removed.

- **`packages/quereus/test/logic/84-asof-scan.sqllogic`** — new sections:
  1. **NOCASE partition** — `asof_trades_ci`/`asof_quotes_ci` with
     `symbol TEXT COLLATE NOCASE`. Verifies `'A'` and `'a'` bucket
     together; includes one mixed-case match, one same-case match, and
     one bucket where the temporal filter still rules out a match.
  2. **RTRIM partition** — verifies `'B '` and `'B  '` collapse to the
     same bucket as `'B'` under `COLLATE RTRIM`.

## Validation

- `yarn build` — passes.
- `yarn workspace @quereus/quereus run test` — 2647 passing, 2 pending.
- `yarn workspace @quereus/quereus run lint` — clean.
- 84-asof-scan logic file run in isolation — passes.

## Usage notes

The fix is transparent to callers. AsofScan plans whose partition equi-pair
is COLLATE NOCASE / RTRIM (or any future collation registered with a
matching normalizer) now bucket consistently with the comparator semantics
the planner already uses. NULL partition values still drop on the right
side and NULL-pad / drop on the left, exactly as before.

A future Unicode-aware collation would need both a comparator and a
matching normalizer registered via `BUILTIN_NORMALIZERS` /
`Database.registerCollation`; the AsofScan path will then pick it up
automatically through `resolveKeyNormalizer`.

A multi-column partition mixing BINARY + NOCASE was not added as a test —
the per-pair normalizer plumbing is identical to bloom-join's, which
already has multi-column coverage.
