description: Fixed the engine crash when a row with a very large integer primary key is written inside a transaction; such keys now round-trip exactly. Reviewed and confirmed.
files:
  - packages/quereus/src/util/key-tuple-codec.ts             # NEW: reversible, type-faithful tuple codec
  - packages/quereus/src/core/database-transaction.ts        # 3 key-serialize sites rewired to the codec
  - packages/quereus/test/incremental/txn-bigint-key.spec.ts # repro + codec round-trip tests
  - packages/quereus-store/test/pushdown.spec.ts             # stale-comment fix (crash now resolved)
----

## What shipped

A big integer primary key (any integer beyond `Number.MAX_SAFE_INTEGER`, e.g.
`9007199254740993` = 2^53+1, which JavaScript represents as a `bigint`) crashed
the write path the moment a row was recorded in the transaction change log:

```
TypeError: Do not know how to serialize a BigInt
  at JSON.stringify → canonicalJsonString → serializeKeyTuple → recordInsert
```

Root cause: the change log keyed each captured row by a serialized primary-key
tuple computed via canonical JSON (`JSON.stringify` under the hood), which
throws on a bigint. Two sibling sites hit the same wall.

### Fix

New `util/key-tuple-codec.ts` — a reversible, type-faithful tuple codec. Each
element becomes a tag-prefixed string; the whole tuple is a JSON array of those
strings. Tags: `0`=null, `s`=string, `n`=number, `i`=bigint, `b0/b1`=boolean,
`x`=blob(hex), `j`=JSON object/array (canonical, recursively key-sorted).

Three sites in `database-transaction.ts` rewired: `serializeKeyTuple` →
`encodeKeyTuple`; `getChangedKeyTuples` decode → `decodeKeyTuple`;
`getChangedTuples` dedup → `encodeKeyTuple` (encode-only).

The codec deliberately keeps numeric type identity (`5n` ≠ `5` as keys) so its
decoded tuples agree with `delta-executor`'s `tupleKey` (which keys bigint `b:`
and number `n:` distinctly) when watch literals are intersected against changes.

## Review findings

Adversarial pass over the implement diff (commit `f0b529a9`), read before the
handoff summary. Verdict: **implementation is correct and complete. No major
defects. Two minor inline fixes applied, one debt ticket filed, tripwires
confirmed.**

### Checked — correctness

- **All key-serialize sites covered.** Grepped `database-transaction.ts` for
  every tuple-serialize/deserialize call. Exactly three: `serializeKeyTuple`
  (used by `recordInsert`/`recordDelete`/`recordUpdate`, incl. the PK-change
  delete-then-insert branch), `getChangedKeyTuples` decode, `getChangedTuples`
  dedup. All three rewired. No stray `JSON.stringify`/`JSON.parse` on tuples
  remains. ✓
- **Codec is genuinely reversible and collision-free.** Encoding is a
  `JSON.stringify`d array of tag-prefixed strings — the leading tag makes
  encodings type-disjoint, and JSON string escaping prevents cross-element
  collisions. Round-trip preserves value AND JS type for every `SqlValue` class
  (verified by the unit test: number stays number, bigint stays bigint, blob
  stays `Uint8Array`). ✓
- **delta-executor interaction holds.** The codec is a *separate* keying scheme
  from `delta-executor` `tupleKey`; correctness only requires the codec to
  preserve type identity so `tupleKey` emits the right `b:`/`n:` prefix on
  decoded tuples. The new "small number PK decodes as number" test guards this. ✓
- **Blob-PK gap closed.** Prior canonical JSON emitted a `Uint8Array` as
  `{"0":..}` that never decoded back to bytes; the `x`+hex tag round-trips it.
  Confirmed the fix is real, not just claimed. ✓
- **Object-key coalescing preserved.** Reorder-equal JSON-object PK components
  still encode identically (canonical form retained) → one change-log entry. ✓

### Checked — tests

Repro + round-trip spec covers: bigint PK INSERT/UPDATE/DELETE in an explicit
txn (no crash), exact bigint round-trip via `getChangedKeyTuples`/
`getChangedTuples`, small-number-PK type fidelity, and a codec unit round-trip
across every `SqlValue` class including blobs and reorder-equal objects. The
implementer's `allRows()` fix (draining `Statement.all()` as the async iterable
it is, not an array) is correct — the assertions test what they claim.

### Found & fixed inline (minor)

- **Stale comment in `quereus-store/test/pushdown.spec.ts`** claimed a bigint PK
  "crashes the engine upstream in the transaction change log" and that a
  combined store-path test "cannot live here yet." That crash is now fixed;
  rewrote the comment to say so and to point at the new debt ticket.
- **Recorded a `NOTE:` tripwire at the codec's number-encode site** for the
  `NaN`/`±Infinity` → `null` and `-0` → `0` lossiness (inherited from
  `JSON.stringify`). Matches prior behavior (no regression), degenerate/
  unreachable via real DML — parked as a code NOTE, not a ticket.

### Filed as backlog (test-coverage debt, not a defect)

- **`backlog/debt-bigint-pk-store-range-seek-test`** — the store suite's own
  NOTE anticipated an end-to-end SQL range-seek test over a large-integer PK
  through the persistent (LevelDB) store path, deferred *until this fix landed*.
  It's now unblocked but was not written by this ticket. No correctness risk
  (codec round-trip and store byte-encoding are each proven at the unit level);
  filed to close the integration gap between those two halves. Runs under
  `yarn test:store`.

### Tripwires confirmed (conditional, not defects — no ticket)

- **Numeric coalescing** (already a `NOTE:` in the codec): the codec keeps `5n`
  and `5` as distinct change-log keys, matching `delta-executor` `tupleKey`.
  Confirmed genuinely conditional — a table's PK storage type is stable per row,
  so one logical row is never presented as differently-typed numerics across two
  ops in one txn. Only trips if that invariant changes; the fix then is to unify
  numerics in BOTH the codec and `tupleKey` together. Correctly parked as a NOTE.
- **Nested bigint inside a JSON-object PK component** would still throw via
  `canonicalJsonString`. Unreachable: JSON parsing yields JS numbers, never
  bigints, so a `bigint` cannot appear inside a `j`-tagged component. Noted here
  for the record; no code change.

### Checked — not done, with reason (empty categories)

- **Isolation-layer cleanup** — out of scope; the parallel isolation bigint
  defect was already fixed under
  `iso-modified-pk-bigint-collation-tombstone-unique`. No correctness need to
  touch it here.
- **Perf** — encode builds a small string array + one `JSON.stringify` per DML
  op; same order of work as the prior canonical path. No new hot-path concern;
  not benchmarked (not warranted for this change).

## Validation

- `yarn workspace @quereus/quereus run lint` → **exit 0** (eslint + `tsc`
  typecheck of test files).
- `yarn workspace @quereus/quereus test` → **6517 passing, 0 failing, 9 pending**.

## End
