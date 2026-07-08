description: Writing a row with a very large integer primary key inside a transaction crashes the engine; make the transaction change log encode such keys safely and reversibly.
files:
  - packages/quereus/src/core/database-transaction.ts        # serializeKeyTuple (~457); recordInsert/Delete/Update (~567-612); getChangedKeyTuples JSON.parse (~638); getChangedTuples dedup JSON.stringify (~686)
  - packages/quereus/src/util/json-canonical.ts              # canonicalJsonString — where the bigint throw originates today
  - packages/quereus/src/runtime/delta-executor.ts           # tupleKey (~311): bigint (b:) vs number (n:) are DISTINCT keys — encoder must stay type-faithful
  - packages/quereus/test/incremental/txn-bigint-key.spec.ts # reproducing test (already added, currently RED)
difficulty: medium
----

## Summary (reproduced)

A row whose primary key is a JS bigint (any integer literal beyond
`Number.MAX_SAFE_INTEGER`, e.g. `9007199254740993` = 2^53+1) crashes the engine
the moment it is written inside a transaction — including the implicit
transaction around a bare statement:

```
TypeError: Do not know how to serialize a BigInt
  at JSON.stringify
  at canonicalJsonString (src/util/json-canonical.ts)
  at TransactionManager.serializeKeyTuple (src/core/database-transaction.ts)
  at TransactionManager.recordInsert
```

Reproduced end-to-end by `test/incremental/txn-bigint-key.spec.ts` (3 cases,
all RED at HEAD). INSERT, UPDATE, and DELETE all crash; the round-trip case
would additionally fail on decode fidelity once the crash is cleared.

## Root cause

The change log keys each captured row by a serialized PK tuple. The serializer
is **canonical JSON**, not the bare `JSON.stringify` the original ticket cited —
the code drifted, but the defect is the same:

```ts
// database-transaction.ts ~457
private serializeKeyTuple(values: readonly SqlValue[]): string {
    return canonicalJsonString(values as unknown as JSONValue);
}
```

`canonicalJsonString` (`util/json-canonical.ts`) is `JSON.stringify(canonicalize(v))`.
`canonicalize` passes scalars through untouched, so a bigint reaches
`JSON.stringify`, which throws. Every DML op inside a transaction records a
change (`recordInsert`/`recordDelete`/`recordUpdate` → `serializeKeyTuple`), so a
bigint PK hard-crashes the write.

Two more `JSON`-based sites on the same key string:
- **`getChangedKeyTuples` (~638)** decodes the key back with `JSON.parse(pkKey)` —
  so the encoder must be **reversible**; a bigint must decode back to a bigint,
  not a string or a lossy number (2^53+1 as a JS number rounds to 2^53).
- **`getChangedTuples` (~686)** does a dedup-only `JSON.stringify(tuple)` that
  throws the same way once a bigint value reaches a captured column. This one
  needs only to not-throw (no decode).

## The type-fidelity constraint (why NOT the unifying key-serializer)

`util/key-serializer.ts` (`serializeKey` / `canonicalNumeric`) is bigint-safe but
**unifies numerics**: `5`, `5.0`, and `5n` all collapse to `"n:5"`, and it is
one-way (no decoder) and returns `null` on any NULL element. Do **not** route the
change log through it, for two reasons:

1. **No decoder + NULL→null** breaks `getChangedKeyTuples` (needs decode) and a
   captured non-PK column that is NULL.
2. **Numeric unification would break watch matching.** `delta-executor.ts`
   `tupleKey` (~311) already keys bigint (`b:`) and number (`n:`) as **distinct**
   strings, and intersects `getChangedTuples` output against watch literal values
   through it. Today small-int PKs flow as `number` end-to-end and match. If the
   change log started emitting `5n` where a watch registered literal `5`, the
   `tupleKey` mismatch would silently drop the match.

So the fix must be a **type-faithful, reversible** tuple codec: bigint stays
bigint, number stays number, string stays string, blob stays blob, null stays
null — and JSON-object PK components keep the canonical (recursively key-sorted)
form so reorder-equal objects still coalesce to one change-log entry (the current
`canonicalJsonString` property must be preserved).

This is consistent with — not a new equality relative to — the existing pipeline
(`delta-executor` `tupleKey` is already type-distinct). It deliberately does not
adopt `compareSqlValues`'s `5n == 5` numeric coalescing; see the tripwire below.

## Direction (not prescriptive)

Add a reversible key codec used by `serializeKeyTuple` and its decode partner.
One workable shape — a JSON array of type-tagged element strings:

- `null`      → `"0"`
- `number`    → `"n" + JSON.stringify(v)`      (round-trips via `JSON.parse`)
- `bigint`    → `"i" + v.toString()`           (decode: `BigInt(rest)`)
- `string`    → `"s" + v`
- `boolean`   → `"b0"` / `"b1"`
- `Uint8Array`→ `"x" + hex`                     (decode: hex → `Uint8Array`; this
                                                 also closes the latent blob-PK
                                                 round-trip gap — `JSON.stringify`
                                                 emits blobs as `{"0":..}` objects
                                                 that never decode back to a
                                                 `Uint8Array`)
- object/array (JSON value) → `"j" + canonicalJsonString(v)`  (keeps object-key
                                                 coalescing; decode: `JSON.parse`)

Then `serializeKeyTuple` = `JSON.stringify(parts)` and the decoder = map each
tagged element back. The tag prefix makes it collision-free across types and the
whole string reversible. Keep encode and decode in **lockstep** (colocate them,
ideally a small `key-tuple-codec.ts` util or a private pair on the manager).

- Point `getChangedKeyTuples` (~638) at the new decoder instead of `JSON.parse`.
- Point the `getChangedTuples` dedup (~686) at the new encoder (encode-only there
  is fine; it never decodes).
- The tagged-object edge (`"j"…`) could in principle collide with a user JSON
  object literally shaped like a tag — the array-of-tagged-strings scheme above
  avoids this because every element is a string whose first char is the tag, so a
  user object always lands under `"j"` and is never confused with a scalar tag.

## TODO

- Add a reversible, type-faithful key-tuple codec (encode + decode) preserving
  the canonical object-key-sorting property of today's `canonicalJsonString`.
- Wire `serializeKeyTuple` to the encoder; wire `getChangedKeyTuples` decode and
  the `getChangedTuples` dedup to the codec (no bare `JSON.parse`/`JSON.stringify`
  on tuples left in these paths).
- Make `test/incremental/txn-bigint-key.spec.ts` green (INSERT/UPDATE/DELETE no
  throw; `getChangedKeyTuples`/`getChangedTuples` return the bigint AS a bigint).
- Add/keep a case proving existing number-PK behavior is unchanged (numbers
  decode back as numbers, not bigints) so `transaction-merge.spec.ts` and
  `delta-executor` watch matching keep passing. Consider a small blob-PK
  round-trip assertion too, since the codec now closes that gap.
- Run `yarn workspace @quereus/quereus test` and `yarn lint`.
- Tripwire (record as a `NOTE:` comment at the codec site, not a ticket): the
  codec intentionally keeps `5n` and `5` as distinct change-log keys, matching
  `delta-executor` `tupleKey` and unlike `compareSqlValues` (which treats them
  equal). If a single logical row's PK is ever presented as differently-typed
  numerics across two ops in one transaction, its INSERT/DELETE would not
  coalesce. Not reachable today (a table's PK storage type is stable per row);
  if it ever becomes reachable, unify numerics in BOTH the codec and
  `delta-executor` `tupleKey` together.

## Note for the isolation layer

The isolation layer's parallel bigint defect in the secondary-index merge path
(`packages/quereus-isolation/src/isolated-table.ts`, `mergedSecondaryIndexQuery`)
was already fixed under `iso-modified-pk-bigint-collation-tombstone-unique` using
the canonical `serializeRowKey` encoder — independent of this fix. Once this
lands, the isolation repro test that stages its bigint overlay row via direct
injection (to sidestep this crash) could be simplified to a plain SQL insert.
