description: In the persistent store, binary (BLOB) primary keys can sort in the wrong order, so a range query over a binary key can silently return the wrong rows. Re-encode blobs so their stored bytes sort the same way SQL compares blobs.
files:
  - packages/quereus-store/src/common/encoding.ts          # encodeBlob/decodeBlob rewrite; drop encode/decodeVarInt; header comment
  - packages/quereus-store/src/common/store-table.ts        # PK range-seek path (buildPKRangeBounds/scanPKRange) — no edit, context
  - packages/quereus-store/src/common/key-builder.ts        # buildPkPrefixBounds relies on prefix-preservation — no edit, context
  - packages/quereus-store/test/pushdown.spec.ts            # add blob-PK range under-fetch test(s)
difficulty: medium
----

# Store BLOB key encoding: length-prefix breaks memcmp sort order

## Root cause (confirmed)

`encodeBlob` (encoding.ts:274-281) prefixes raw blob bytes with a varint length:

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

The KV store compares keys byte-for-byte (memcmp). Length-first layout does NOT
preserve blob-content order: memcmp hits the length bytes before the content, so
a shorter blob always sorts before a longer one regardless of content. SQL blob
comparison is element-by-element (`x'0102' < x'03'` because `0x01 < 0x03`), so
the byte order and the logical order disagree.

## Why silently wrong (the exploited seam)

`StoreModule.getBestAccessPlan` advertises leading-PK range filters as handled
(`honorsCollatedRangeBounds: true`, store-module.ts:1787-1792). At runtime
`scanPKRange` (store-table.ts:849) seeks a `gte`/`lt` byte window from
`buildPKRangeBounds` (806) → `encodePkPrefixBounds` (1572) →
`buildPkPrefixBounds` (key-builder.ts:326) → `encodeCompositeKey` → `encodeBlob`.
The seek visits only that window; `matchesFilters` (864) is authoritative but
only re-filters rows the seek already yielded — it CANNOT recover a qualifying
row the mis-ordered window skipped. The documented "window is a SUPERSET, only
over-fetches" invariant (store-table.ts:842-847) breaks for blobs.

### Concrete under-fetch (this is the red test)

Keys `x'0102'` and `x'03'`, predicate `b >= x'0102'`.
Correct answer: BOTH rows (`[0x03] > [0x01,0x02]` element-wise, so both qualify).

Under the length-prefix encoding:
- bound `x'0102'` → `04 02 01 02` (type, varint len=2, content)
- key `x'03'`     → `04 01 03`    (type, varint len=1, content)
- key `x'0102'`   → `04 02 01 02`

Store byte order: `x'03'` (`04 01 03`) sorts BELOW the gte bound `04 02 01 02`,
so the seek starts at `x'0102'` and never yields `x'03'`. Result: `{x'0102'}`
— `x'03'` silently dropped. Wrong.

## Fix

Re-encode blobs with the same order-preserving escape+terminator scheme TEXT
already uses (`encodeText`, encoding.ts:232-268), minus the collation/UTF-8 step
(a blob is already raw bytes):

- Keep the `TYPE_BLOB` (`0x04`) tag so blobs stay in their type band.
- Emit each content byte, escaping `0x00`→`0x01 0x01` and `0x01`→`0x01 0x02`
  (same `ESCAPE_BYTE`/`NULL_BYTE` constants as TEXT).
- Append a `0x00` terminator.

This is memcmp-order-preserving for variable-length byte strings: the terminator
(`0x00`) sorts below any escaped content continuation (which starts at `0x01` or
a raw byte `>= 0x02`), so a proper prefix sorts before any extension, and the
escape map is monotonic in the source byte — matching element-wise blob order.

Under the new scheme the repro above encodes `x'0102'`→`04 01 02 02 00` and
`x'03'`→`04 03 00`, so `x'0102' < x'03'` and the `>= x'0102'` window yields both.

`decodeBlob` must mirror `decodeText` (encoding.ts:444-486): walk from the type
byte, un-escape, stop at the terminator, return a `Uint8Array` (no `TextDecoder`).

### DESC interplay — verify, don't re-derive

`encodeCompositeKey` bit-inverts (`^0xff`) each DESC component's bytes
(encoding.ts:167-171). TEXT already rides this same variable-length+terminator
path through DESC inversion and its DESC tests pass, so blob inherits the same
correctness — but add a DESC blob-PK case to lock it in. (Reasoning: ASC, a
prefix `A` sorts before extension `B` because `A` has `0x00` where `B` has a
content byte `>= 0x01`; inverting both flips `0x00`→`0xff` vs content→`<= 0xfe`,
so `A` sorts after `B` — correct DESC.)

### Dead code

`encodeVarInt` (encoding.ts:322) and `decodeVarInt` (525) are used ONLY by
blob encode/decode (confirmed: no other references in quereus-store). Remove both
after the rewrite; drop the varint underflow branch in the old `decodeBlob`.

### Doc touch-up

Update the header comment (encoding.ts:12) `0x04 - BLOB (length-prefixed)` →
escaped/null-terminated, and the `encodeBlob`/`decodeBlob` doc comments.

### DRY note

`encodeText`, `encodeObject`, and the new `encodeBlob` will share the
escape-loop + terminator body (differing only in the type tag and whether input
is UTF-8-from-string or raw bytes). Optional but preferred: factor a private
`writeEscapedWithTerminator(typeTag, bytes)` helper and have all three call it;
same for a `readEscapedUntilTerminator` on the decode side. Keep it if it stays
readable — do not force it.

## Prereq note

Original ticket named `prereq: json-canonical-key-hashing` to avoid overlapping
`encoding.ts` edits. That work has already landed (`encodeObject` +
`canonicalJsonString` are present in encoding.ts today), so no prereq remains.

## TODO

- Add red test(s) to `packages/quereus-store/test/pushdown.spec.ts`: a `blob primary key`
  table with `x'0102'` and `x'03'`; assert `where b >= x'0102' order by ...`
  returns BOTH rows (oracle = full scan / memory-vtab path). Confirm it FAILS first.
- Add a DESC blob-PK range case (`b blob primary key desc`) asserting correct rows.
- Rewrite `encodeBlob` with escape + `0x00` terminator (mirror `encodeText`, no collation/UTF-8).
- Rewrite `decodeBlob` to mirror `decodeText`, returning a `Uint8Array`.
- Remove now-dead `encodeVarInt` / `decodeVarInt`.
- Update header comment (line 12) and `encodeBlob`/`decodeBlob` doc comments.
- (Optional) Factor shared escape/terminator helper for TEXT/OBJECT/BLOB.
- `yarn test` green (memory path) + `yarn test:store` green (exercises the store seek path). Stream with `tee`.
- `yarn lint` (only `packages/quereus` has a real lint; run from root).
