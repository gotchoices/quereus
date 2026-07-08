description: In the persistent store, numeric primary keys can sort in the wrong order when a column mixes whole and fractional numbers, so a range query can silently skip rows that should match.
prereq: json-canonical-key-hashing
files:
  - packages/quereus-store/src/common/encoding.ts        # encodeValue routing (110-115), encodeInteger (185), encodeReal (205)
  - packages/quereus-store/src/common/store-table.ts      # PK range-seek window uses these encoded bytes
  - packages/quereus-store/src/common/store-module.ts      # getBestAccessPlan marks range filters "handled"
  - packages/quereus-store/test/pushdown.spec.ts           # add mixed int/real range test here
difficulty: medium
----

# Store numeric key encoding: whole vs fractional numbers sort inconsistently

## Problem

`encodeValue` in the store's byte-key encoder picks the numeric encoding by the
JavaScript runtime shape of the value, not by the column's declared type:

```ts
if (typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value))) {
  return encodeInteger(...);   // TYPE_INTEGER = 0x01
}
if (typeof value === 'number') {
  return encodeReal(value);    // TYPE_REAL = 0x02
}
```

A whole-number value like `3.0` is `Number.isInteger` → encoded with the
`0x01` integer prefix; a fractional value like `2.5` is encoded with the `0x02`
real prefix. The composite key is compared byte-for-byte (memcmp) by the
underlying key-value store. Because the type-tag byte comes first, **every**
integer-shaped value sorts before **every** real-shaped value, regardless of
numeric magnitude. So in a `REAL` primary-key column, `3` sorts before `2.5`
even though `3 > 2.5`.

## Why it is dangerous (silently wrong results, not a crash)

`getBestAccessPlan` reports range filters on the PK as fully *handled* by the
store, and `StoreTable`'s PK range-seek derives an encoded `gte`/`lt` byte
window and iterates only that window (see the completed `store-pk-range-seek`
work). The seek window is built from the same broken encoding. A query like:

```sql
create table t (x real primary key);
insert into t values (2.5), (3.0), (3.5);
select * from t where x >= 2.5;   -- must return 2.5, 3.0, 3.5
```

builds a lower bound at the encoded bytes of `2.5` (real, `0x02…`). The row
`3.0`, stored under the integer prefix (`0x01…`), sorts *below* that bound and
is never visited — the query silently under-fetches and returns the wrong
rows. Under-fetch is the dangerous class here: the planner trusts the store, so
there is no post-filter safety net that would re-admit the missing row.

## Expected behavior

For any numeric primary-key/index column, the persisted byte key must order
values by numeric value: `-inf < … < 2.5 < 3.0 < 3.5 < …`, independent of
whether a given value happens to be whole or fractional. The store must return
the same rows a range predicate would over the in-memory (memory-vtab) path, so
the same schema + data behaves identically across storage backends.

## Direction

Two candidate approaches (settle during fix):

- **Single order-preserving numeric encoding** — encode all numeric values
  (integer and real) into one mutually-order-preserving byte form (SQLite4's
  varint/numeric key encoding is the reference design): one type tag for the
  numeric domain, bytes that memcmp in numeric order across the int/real
  boundary. This is the robust general fix and keys the value by what it *is*,
  not its declared column type.
- **Encode by declared physical type** — if the column is declared `REAL`,
  always use the real encoding (never route a whole-number value to the integer
  encoding), and vice versa. Simpler, but relies on the column type being known
  at every encode site and on integer/real never coexisting in one column.

Note the interaction with `json-canonical-key-hashing` (the prereq): that ticket
reworks the JSON-object key path in this same `encoding.ts`. Sequencing after it
avoids overlapping edits to the encoder. NaN/Infinity ordering already handled
by `encodeReal` (`-Inf < … < +Inf < NaN`) — preserve that.

## Reproduction / test to add

Add to `packages/quereus-store/test/pushdown.spec.ts` a `REAL` primary-key
table containing a mix of whole and fractional values, then assert a
`where x >= <fractional>` (and a `between`) range returns every in-range row
including the whole-number ones — i.e. the store path matches a full-scan
oracle. Must fail against current encoding and pass after the fix.

## TODO

- Reproduce the under-fetch with a mixed int/real `REAL` PK range test (red).
- Decide encoding approach (single order-preserving numeric encoding vs.
  encode-by-declared-type) and document the tradeoff.
- Implement the chosen encoding in `encoding.ts`; ensure `encodeCompositeKey`
  DESC bit-inversion and the PK range-seek bound builder still hold.
- Verify the memory-vtab vs. store parity for numeric range predicates.
- Confirm `yarn test` and `yarn test:store` green (store path exercises real keys).
