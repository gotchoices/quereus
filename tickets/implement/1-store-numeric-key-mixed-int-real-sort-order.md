description: In the persistent store, a numeric primary/index key column that mixes whole and fractional numbers sorts wrong, so a range query silently skips rows it should return. Fix the byte-key encoder so all numbers order by value.
prereq:
files:
  - packages/quereus-store/src/common/encoding.ts          # encodeValue routing (104-139), encodeInteger (188), encodeReal (208), decode* (309-476)
  - packages/quereus-store/test/encoding.spec.ts            # unit tests for the encoder (int/real roundtrip + sort order)
  - packages/quereus-store/test/pushdown.spec.ts            # add the mixed int/real range parity test here (~line 389)
  - packages/quereus-store/src/common/store-table.ts        # buildPKRangeBounds / scanPKRange consume these encoded bytes (769-873)
  - packages/quereus/src/util/comparison.ts                 # the authoritative oracle: compareNumbers (173), getStorageClass (130), compareSameType NUMERIC (218)
difficulty: hard
----

# Store numeric key encoding: order all numbers by value (int/real unified)

## The bug (confirmed, by construction)

`encodeValue` in the store's byte-key encoder picks the numeric encoding by the
JavaScript runtime *shape* of the value, not by numeric value:

```ts
// encoding.ts:111-117
if (typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value))) {
  return encodeInteger(...);   // TYPE_INTEGER = 0x01
}
if (typeof value === 'number') {
  return encodeReal(value);    // TYPE_REAL = 0x02
}
```

Composite keys are compared byte-for-byte (memcmp) by the underlying KV store,
and the **type-tag byte comes first**. So `TYPE_INTEGER (0x01) < TYPE_REAL
(0x02)` makes *every* integer-shaped value sort before *every* real-shaped
value, regardless of magnitude: a whole number `3.0` (→ `0x01…`) sorts *below* a
fractional `2.5` (→ `0x02…`), even though `3 > 2.5`.

This is the same class of defect as the completed
`store-blob-key-varint-not-memcmp-ordered` ticket (a mis-ordered key window that
a leading-PK range seek silently under-fetches). Its test scaffolding in
`pushdown.spec.ts` (the "matches the memory-vtab oracle" parity pattern) is the
model to copy here.

### Why it is dangerous (silent under-fetch, not a crash)

`getBestAccessPlan` marks a PK range filter fully *handled* by the store, and
`StoreTable.buildPKRangeBounds` / `scanPKRange` (`store-table.ts:769-873`) derive
an encoded `gte`/`lt` byte window from the same broken encoding and iterate only
that window. `matchesFilters` can only *re-filter rows the seek already
yielded — it cannot recover a row the window skipped.* So:

```sql
create table t (x real primary key) using store;
insert into t values (2.5), (3.0), (3.5);
select * from t where x >= 2.5;   -- must return 2.5, 3.0, 3.5
```

builds a lower bound at the bytes of `2.5` (`0x02…`); `3.0` is stored under
`0x01…`, sorts *below* the bound, is never visited → the query returns
`{2.5, 3.5}` and silently drops `3.0`.

## What "correct" means — the oracle

The authoritative comparator is the in-memory (memory-vtab) path in
`packages/quereus/src/util/comparison.ts`. Findings from reading it:

- `getStorageClass` (line 130): `bigint`, `number`, and `boolean` ALL map to
  `StorageClass.NUMERIC` (line 119, `// INTEGER or REAL`). There is no separate
  INTEGER vs REAL class.
- `compareSameType` for NUMERIC (line 218) calls `compareNumbers` (line 173),
  which is simply `a < b ? -1 : a > b ? 1 : 0`.
- JS relational operators between a `bigint` and a `number` compare by **exact
  mathematical value** (the spec does not coerce the bigint to a double). So the
  memory path interleaves integers and reals by true numeric value AND keeps
  **full int64 precision** even when a large integer is compared against a real
  (e.g. `9007199254740993n > 9007199254740992.0`).

So the store's encoded byte key must memcmp in exactly the order `compareNumbers`
produces: `-Inf < … < 2.5 < 3 < 3.5 < … < +Inf < NaN`, across the int/real
boundary, with no precision loss for any int64.

Corollary (`-0`): `compareNumbers(-0, 0) === 0` — the memory path treats `-0`,
`+0`, and `0n` as **equal**. Today `encodeReal` sorts `-0` *below* `+0`
(`encoding.ts:217`), a small pre-existing divergence. Normalize `-0 → +0` before
encoding so all three collide to the same key.

## Decision: single order-preserving numeric encoding (Option 1)

The ticket offered two directions. **Settle on Option 1 (one order-preserving
numeric encoding, keyed by value not declared type).** Why Option 2
(encode-by-declared-physical-type) is rejected:

- A column with **NUMERIC / no declared type** (e.g. `create table t (x primary
  key)`) legitimately stores both `bigint` and `number` rows; the memory path
  interleaves them by value. There is no single physical encoding to pick for
  such a column, so Option 2 cannot reproduce memory order there — the exact
  parity the ticket demands.
- Option 2 also requires threading the declared type into every encode site
  (`encodeValue`, `encodeCompositeKey`, `buildPkPrefixBounds`, the range-bound
  builder). Option 1 is self-contained in `encoding.ts`.

A naive form of Option 1 — "encode every numeric as an order-preserving 8-byte
double" — is ALSO rejected: `Number(n)` for `|n| ≥ 2^53` is lossy, so two
distinct large int64 PK values would collide to one key (second insert
overwrites the first = **data loss**) and diverge from the exact memory order.
The encoding must stay **exact**.

### Recommended concrete scheme — sortable-double prefix + exact tie-break tail

Single type tag `TYPE_NUMERIC`. Fixed-width body so DESC bit-inversion (which
`encodeCompositeKey` applies per component, `encoding.ts:167-171`) stays trivially
order-correct, exactly as the current fixed-width int/real bodies do.

Layout: `[TYPE_NUMERIC][ 8-byte order-preserving double ][ 8-byte signed tie-break ]`

- **Primary 8 bytes** = the existing `encodeReal` sign-manipulation applied to
  `Number(v)` (the nearest double). This alone orders every value correctly
  *except* ties, and preserves the current `-Inf < … < +Inf < NaN` ordering.
- **Tie-break 8 bytes** = signed offset `v - p`, where `p` is the integer that
  the primary double represents, encoded big-endian sign-flipped (same trick as
  `encodeInteger`). This disambiguates the only possible memcmp collisions:

  Two *distinct finite doubles* always have distinct primary bytes (the bit
  pattern is a bijection). So the only prefix collisions are among **integers
  that share a nearest double** (a contiguous run of int64s near `2^53…2^63`),
  plus at most the one integer-valued real equal to that double. Within such a
  tie-set the true order is integer order, and the offset `v - p` (bounded by
  half the double's ulp, ≤ ~2^11 for int64) reproduces it exactly. Non-integer
  reals never tie with anything, so their offset is `0`.

- **Decode** (`decodeValue`): read primary double `p`, read offset `o`.
  Reconstruct exact value; return **bigint when the result is integer-valued,
  number otherwise** — this matches the *current* decode contract (the existing
  `encoding.spec.ts` already notes "integer-valued floats like `0.0` are encoded
  as integers" and roundtrip to `0n`), so no consumer regresses. `matchesFilters`
  and every other comparator are numeric-class-tolerant (`5n` equals `5.0`), so
  the bigint/number choice never affects correctness — only avoids surprising a
  test.

Tie-break width may shrink to 4 bytes (int32 covers the ≤2^11 offset range) if
you prefer; 8 bytes is the bulletproof default. Keep it **fixed** either way.

**Fallback reference** if the tail scheme proves fiddly: SQLite4's numeric key
encoding (sign + base-256 significand + exponent varint) is the canonical
order-preserving numeric key format and is fully exact; it is variable-length, so
it self-delimits like the existing escaped-blob encoding and bit-inverts fine.
Prefer the tail scheme (simpler for our fixed int64/float64 domain); reach for
SQLite4 only if a concrete decode-fidelity or edge case defeats it.

### Backwards compatibility

`AGENTS.md` says don't worry about on-disk backwards compat yet, so a tag/layout
change is fine. `TYPE_INTEGER (0x01)` / `TYPE_REAL (0x02)` and their `decode*`
paths can be removed or kept only for reading legacy keys — your call; simplest
is to replace them outright with `TYPE_NUMERIC`.

## Reproduction test (add first, watch it go red)

Add to `pushdown.spec.ts` a `describe` mirroring the blob-key parity block
(`pushdown.spec.ts:353-389`): a `REAL` primary-key table mixing whole and
fractional values, asserting the store path equals the memory-vtab oracle. Sketch:

```ts
describe('numeric primary key mixed int/real range seek (store-numeric-key-mixed-int-real-sort-order)', () => {
  async function seedNums(name: string, using: string): Promise<void> {
    await db.exec(`create table ${name} (x real primary key, n integer) ${using}`);
    // whole numbers (2, 3) interleave with fractional (2.5, 3.5) — the whole ones
    // must NOT all sort before the fractional ones.
    await db.exec(`insert into ${name} values (2, 20), (2.5, 25), (3, 30), (3.5, 35)`);
  }

  it("ASC: x >= 2.5 matches the memory-vtab oracle (no under-fetch)", async () => {
    await seedNums('nstore', 'using store');
    await seedNums('nmem', ''); // default in-memory vtab = full-scan oracle
    const q = (t: string) => `select n from ${t} where x >= 2.5 order by x`;
    const storeRows = (await asyncIterableToArray(db.eval(q('nstore')))).map(r => r.n);
    const memRows = (await asyncIterableToArray(db.eval(q('nmem')))).map(r => r.n);
    expect(memRows).to.deep.equal([25, 30, 35]);   // 2.5, 3, 3.5 — includes whole 3
    expect(storeRows).to.deep.equal(memRows);       // FAILS today: store drops n=30
  });

  it('BETWEEN spanning the int/real boundary matches the oracle', async () => {
    await seedNums('nstore2', 'using store');
    const rows = await asyncIterableToArray(
      db.eval(`select n from nstore2 where x between 2.5 and 3 order by x`));
    expect(rows.map(r => r.n)).to.deep.equal([25, 30]);
  });
});
```

Also strengthen `encoding.spec.ts`: add a sort-order test over a *mixed* int/real
value set (e.g. `[-3.5, -3n, -2.5, 0n, 2.5, 3n, 3.5]` plus a large-int case such
as `9007199254740992n`, `9007199254740993n`, `9007199254740992.5`) asserting the
encoded bytes memcmp in the same order `compareNumbers` gives — this is the
unit-level oracle for the exactness requirement and guards the large-int
collision case.

## TODO

- Add the `pushdown.spec.ts` parity test and the mixed/large-int `encoding.spec.ts`
  sort-order test; confirm both go red against current encoding.
- Implement the single `TYPE_NUMERIC` order-preserving encoding in `encoding.ts`
  (recommended: sortable-double prefix + exact signed tie-break tail; SQLite4
  numeric encoding as fallback). Normalize `-0 → +0`. Preserve
  `-Inf < … < +Inf < NaN`.
- Update `decodeValue` to reconstruct exact values, returning bigint for
  integer-valued results and number otherwise (matches current decode contract).
- Update the existing `encoding.spec.ts` int/real roundtrip + sort-order tests to
  the new encoding (they assume the old separate `TYPE_INTEGER`/`TYPE_REAL`
  layout).
- Verify DESC bit-inversion still holds (fixed-width body): add/keep a DESC
  numeric-PK range test. Confirm `buildPKRangeBounds` / `scanPKRange` window is a
  correct superset (over-fetch OK, under-fetch never).
- Validate memory-vtab vs. store parity for numeric range predicates over a fuzz
  set that includes `|int| ≥ 2^53` mixed with reals (the case the naive double
  approach would corrupt).
- `yarn test` and `yarn test:store` green (the store path exercises real keys via
  the LevelDB module).
