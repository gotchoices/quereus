description: MemoryIndexEntry.primaryKeys moved from a PK-comparator-sorted BTreeKeyForPrimary[] (binary-search add/remove, O(M²) to build one low-cardinality bucket) to a Map<string, BTreeKeyForPrimary> keyed by a lossless, type-aware PK encoding. Owned add/remove/dedup are O(1); PK-sorted scan output is reconstructed by sort-on-read, memoized per entry in a WeakMap. The Map is structured-clone-safe so inheritree node COW stays correct. New encoder (utils/primary-key-encode.ts) mirrors compareSqlValuesFast's NUMERIC equality and is arity-aware (single source of truth = createPrimaryKeyFunctions). Reviewed and accepted as-is.
files:
  - packages/quereus/src/vtab/memory/utils/primary-key-encode.ts
  - packages/quereus/src/vtab/memory/utils/primary-key.ts
  - packages/quereus/src/vtab/memory/types.ts
  - packages/quereus/src/vtab/memory/index.ts
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts
  - packages/quereus/src/vtab/memory/layer/base.ts
  - packages/quereus/src/vtab/memory/layer/transaction.ts
  - packages/quereus/test/vtab/memory-index-pk-value-identity.spec.ts
  - packages/quereus/test/performance-sentinels.spec.ts
----

# Complete: MemoryIndex per-entry PK container — lossless-encoding Map

## Summary

Each `MemoryIndexEntry` maps a secondary-index key to the set of PKs carrying that
value. The container moved from a PK-comparator-sorted array (binary-search +
`splice`, O(M²) to build one low-cardinality bucket) to a
`Map<string, BTreeKeyForPrimary>` keyed by a lossless, type-aware PK encoding:
O(1) owned add/remove/dedup, value-identity preserved, structured-clone-safe for
inheritree node COW, scan order reconstructed by sort-on-read (memoized per entry in
a `WeakMap`). The 250k descending-add container sentinel drops from ~4.4 s to ~100 ms.

The work was implemented in commit `e1708ca3`; this review pass adds no code changes.

## Review findings

Adversarial pass over the implement diff (read first, before the handoff summary).
Scrutinized every aspect angle; ran lint + the full memory-backed test matrix.

### Encoder correctness — the new trust boundary (verified against `compareSqlValuesFast`)

The encoder must (1) never collide two comparator-distinct PKs and (2) collapse
exactly the NUMERIC representation variants the comparator treats as equal. I read
`compareSqlValuesFast`/`compareSameType` (`util/comparison.ts`) and confirmed the
encoder mirrors it **per storage class**:

- **NUMERIC.** Comparator compares `number`/`bigint`/`boolean` by mathematical
  `<`/`>` (booleans coerced to 0/1). Encoder normalizes finite-integer numbers via
  `BigInt(v).toString()` (exact for any representable double, so `5` ≡ `5.0` ≡ `5n`,
  `-0` ≡ `0`, and large integers near/beyond 2^53 stay consistent with bigint of the
  same mathematical value), booleans → `1`/`0`, and non-integer reals via an
  `'if'`-tagged `String(v)` that is provably disjoint from the integer set
  (`'i'+digits` vs `'if'+…`). NaN/Infinity guarded (no `BigInt()` throw). Matches the
  comparator exactly. ✓
- **TEXT.** Comparator is collation-aware; encoder is byte-exact (`'t'+string`),
  i.e. *finer* than NOCASE. Safe by the PK-uniqueness invariant (two
  collation-equal/byte-distinct texts can never both be live PKs in one entry) and
  round-trips because removes carry the actual stored bytes. Walked the NOCASE
  `'A'`→`'a'` PK-update case: remove(old bytes)/add(new bytes) leaves exactly one
  member. ✓
- **BLOB.** Zero-padded lowercase hex — injective, matches byte equality, `[10]` ≠
  `[1,0]`. ✓
- **OBJECT/JSON.** *Both* encoder and comparator use `JSON.stringify`, so
  key-order-different objects are treated as distinct by both — consistent, no
  mismatch. ✓
- **Cross-class.** Class tags `n/i/t/b/j` prevent any cross-class collision; the
  comparator orders by storage class. ✓
- **Composite injectivity** via `'C'+arity` prefix + length-prefixed components
  (`c.length+':'+c`); arity-1 JSON-array values encoded whole (not recursed). ✓
- The `never` exhaustive default in `encodeScalar` is genuinely unreachable —
  `SqlValue` excludes `undefined` (confirmed by the passing `tsc -p
  tsconfig.test.json`, which would reject the `never` assignment otherwise). ✓

### COW / structured-clone safety

The new `multi-entry-leaf copy-on-write` spec exercises a shared inheritree leaf
(≥2 entries) and asserts a sibling entry survives intact on both child and base
after COW of another entry — the regression guard against re-introducing a
non-cloneable container. Passes. All five `new MemoryIndex(...)` call sites (base.ts
×3, transaction.ts, plus 2 test helpers + 1 sentinel) updated to pass `encode`.

### sortedCache

Owned in-place mutation invalidates via `delete(entry)` (identity preserved); COW
mints a fresh entry with no cache slot; emptied-entry removal drops the now-dead
WeakMap slot. Verified the only direct `getSortedPrimaryKeys` consumers are
scan-layer (iterate-only) and `getPrimaryKeys` (`.slice()`), so the by-reference
return is never mutated. Considered the cross-layer stale-cache scenario (a parent
MemoryIndex mutating an entry in-place after a child cached it): not triggerable
under the MVCC invariant that a parent layer is frozen while a child overlay is open,
and the entry-sharing model is identical to the pre-change code (which iterated the
shared array directly). Low risk, no action.

### No stray array assumptions / docs

Grepped `primaryKeys`/`MemoryIndexEntry` across all `*.ts`: every reference lives in
the memory vtab files touched by the change. `quereus-isolation` merges at the
emitted-`Row` level, not the entry level, so no `MemoryIndexEntry` crosses the
workspace boundary. `docs/` contains no description of the per-entry container
(grep-confirmed) — nothing to update.

### Implementer-flagged gaps — dispositioned

1. *structuredClone assumption empirical* — the passing multi-entry-leaf COW test is
   sufficient empirical proof; reading inheritree internals was unnecessary.
2. *getSortedPrimaryKeys by-reference* — confirmed no caller mutates (above). Cleared.
3. *Singleton PK end-to-end* — covered by encoder unit test; full-table integration
   of an empty-PK table + secondary index is exotic and at most one row. Acceptable.
4. *Dead inline fallback in scan-layer* — `getSecondaryIndex?` is an optional Layer
   method; both concrete layers implement it, but the defensive fallback is correct,
   DRY-neutral, and harmless. **Left as-is** (removing it to assert presence would be
   strictly less robust).
5. *test:store not run* — verified the store path never serializes
   `MemoryIndexEntry` (no `.primaryKeys` reference outside the memory vtab; indexes
   are rebuilt, not persisted). Low risk confirmed without running the slow suite.
6. *manager.ts checkUniqueViaIndex unchanged* — uses `getPrimaryKeys`, order-agnostic,
   UNIQUE buckets ≤1 member. Correct, no change needed.

### Disposition

- **Minor findings:** none requiring an inline fix.
- **Major findings:** none → no new fix/plan tickets filed.

The implementation is correct, well-decomposed, and well-tested. Accepted as-is.

## Validation

- `yarn workspace @quereus/quereus lint` (eslint + `tsc -p tsconfig.test.json
  --noEmit`) → clean, exit 0.
- Targeted specs (`memory-index-pk-value-identity` + `performance-sentinels`) → 37
  passing; 250k descending-add container sentinel 98 ms (threshold 2 s).
- `yarn workspace @quereus/isolation test` → 126 passing (the hard dependency on
  PK-within-key scan order).
- `yarn workspace @quereus/quereus test` (full memory-backed suite) → **6210 passing,
  9 pending**, exit 0.
- No pre-existing failures surfaced; no `.pre-existing-error.md` written.
- `yarn test:store` not run (agent default is the memory suite; store rebuilds
  indexes rather than serializing entries — see gap #5).
