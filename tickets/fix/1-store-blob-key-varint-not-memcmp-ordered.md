description: In the persistent store, binary (BLOB) primary keys can sort in the wrong order, so a range query over a binary key can silently return the wrong rows.
prereq: json-canonical-key-hashing
files:
  - packages/quereus-store/src/common/encoding.ts        # encodeBlob (271-278), encodeText escaping (229-265) to reuse
  - packages/quereus-store/src/common/store-table.ts      # PK range-seek window uses these encoded bytes
  - packages/quereus-store/test/pushdown.spec.ts           # add blob-PK range test here
difficulty: medium
----

# Store BLOB key encoding: length-prefix breaks memcmp sort order

## Problem

`encodeBlob` prefixes the raw blob bytes with a variable-length integer length:

```ts
function encodeBlob(value: Uint8Array): Uint8Array {
  const lengthBytes = encodeVarInt(value.length);
  const result = new Uint8Array(1 + lengthBytes.length + value.length);
  result[0] = TYPE_BLOB;
  result.set(lengthBytes, 1);
  result.set(value, 1 + lengthBytes.length);
  return result;
}
```

The underlying key-value store compares keys byte-for-byte (memcmp). A
length-first layout does **not** preserve blob content order: the blob
`[0x01, 0x02]` (length 2) encodes to `…02 01 02` and the blob `[0x03]`
(length 1) encodes to `…01 03`. Memcmp compares the length bytes first, so the
length-1 blob sorts *before* the length-2 blob — i.e. `[0x03]` sorts before
`[0x01,0x02]`, the reverse of correct SQL blob ordering (`[0x01,0x02] <
[0x03]`, compared element-by-element).

## Why it is dangerous (silently wrong results)

Same mechanism as the numeric-key sort bug: `getBestAccessPlan` marks PK range
filters as *handled* by the store, and the PK range-seek builds a `gte`/`lt`
byte window and iterates only that window. A blob-PK range predicate therefore
seeks against a mis-ordered key space and silently under-fetches — returning
wrong rows with no post-filter to catch the miss.

```sql
create table t (k blob primary key);
insert into t values (x'0102'), (x'03');
select * from t where k >= x'02';   -- correct answer: x'0102' excluded? no — x'0102' < x'02' so only x'03'
                                     -- but wrong ordering can drop/admit the wrong row
```

## Expected behavior

The persisted byte key for a BLOB must memcmp-order identically to element-wise
blob comparison, so the store's range seek returns exactly the rows the memory
(memory-vtab) path would.

## Direction

Reuse the order-preserving escape scheme already used for TEXT
(`encodeText`, lines 229-265): emit the blob content byte-by-byte with the
`0x00`/`0x01` null-byte escaping and a null terminator, instead of a leading
length prefix. Escape-with-terminator is memcmp-order-preserving for
variable-length byte strings (a proper prefix sorts before any extension),
which the length-prefix layout is not. Keep the `TYPE_BLOB` (`0x04`) tag so
blobs still sort into their type band relative to other types. Verify DESC
bit-inversion in `encodeCompositeKey` still round-trips for the new layout.

Sequenced after `json-canonical-key-hashing` (prereq) because that ticket edits
the same `encoding.ts`; ordering avoids overlapping encoder edits.

## Reproduction / test to add

Add to `packages/quereus-store/test/pushdown.spec.ts` a `BLOB` primary-key
table with keys whose length order and content order disagree (e.g. `x'0102'`
vs `x'03'`), then assert a range predicate over the blob PK returns the same
rows as a full-scan oracle. Red before, green after.

## TODO

- Reproduce blob-PK range under/over-fetch with a length-vs-content mismatch (red).
- Re-implement `encodeBlob` with escape+terminator (reuse TEXT escaping helpers).
- Confirm composite-key DESC inversion and PK range-seek bounds still hold.
- `yarn test` + `yarn test:store` green.
