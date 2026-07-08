description: Verify the fix that stops the engine crashing when a row with a very large integer primary key is written inside a transaction, and that such keys survive round-trip.
files:
  - packages/quereus/src/util/key-tuple-codec.ts             # NEW: reversible, type-faithful tuple codec (encode + decode)
  - packages/quereus/src/core/database-transaction.ts        # serializeKeyTuple → encodeKeyTuple; getChangedKeyTuples → decodeKeyTuple; getChangedTuples dedup → encodeKeyTuple
  - packages/quereus/test/incremental/txn-bigint-key.spec.ts # repro + codec round-trip tests (now GREEN)
difficulty: medium
----

## What shipped

A bigint primary key (any integer beyond `Number.MAX_SAFE_INTEGER`, e.g.
`9007199254740993` = 2^53+1) crashed the write path the moment a row was
recorded in the transaction change log:

```
TypeError: Do not know how to serialize a BigInt
  at JSON.stringify → canonicalJsonString → serializeKeyTuple → recordInsert
```

Root cause: the change log keyed each captured row by a serialized PK tuple
computed via canonical JSON (`JSON.stringify` under the hood), which throws on
bigint. Two sibling sites hit the same wall — `getChangedKeyTuples` decoded the
key with bare `JSON.parse` (would need bigints back), and `getChangedTuples`
deduped with bare `JSON.stringify` (same throw once a bigint value is captured).

### Fix

New `util/key-tuple-codec.ts` — a **reversible, type-faithful** tuple codec.
Each element is a tag-prefixed string, the whole tuple is a JSON array of those
strings:

| SqlValue | encoding | decode |
|---|---|---|
| null | `"0"` | `null` |
| string | `"s"+v` | rest |
| number | `"n"+JSON.stringify(v)` | `JSON.parse(rest)` |
| bigint | `"i"+v.toString()` | `BigInt(rest)` |
| boolean | `"b0"`/`"b1"` | `rest==='1'` |
| Uint8Array | `"x"+hex` | hex→bytes |
| object/array | `"j"+canonicalJsonString(v)` | `JSON.parse(rest)` |

Three call sites in `database-transaction.ts` rewired:
`serializeKeyTuple` → `encodeKeyTuple`; `getChangedKeyTuples` decode →
`decodeKeyTuple`; `getChangedTuples` dedup → `encodeKeyTuple` (encode-only).
Removed now-unused `canonicalJsonString`/`JSONValue` imports from that file.

Why not reuse `util/key-serializer.ts` (`serializeKey`): it unifies numerics
(`5`==`5.0`==`5n`), is one-way, and returns `null` on any NULL element — all
three break the change log's needs (decode required; NULL-in-non-PK-column
allowed; type-distinct keys required to agree with `delta-executor` `tupleKey`).

## Use cases to validate

- **INSERT/UPDATE/DELETE of a bigint PK inside an explicit txn** — no throw
  (test 1 & 2). Also exercises the implicit-txn path (bare INSERT).
- **Round-trip fidelity** — `getChangedKeyTuples`/`getChangedTuples` return the
  bigint AS a bigint, exact value (test 3). A `number` cast would round
  2^53+1 down to 2^53 — the assertion catches that.
- **Number-PK unchanged** — a small integer PK decodes back as a JS `number`,
  not a bigint (new test), so `delta-executor` watch matching (which keys
  `bigint` `b:` vs `number` `n:` distinctly) keeps matching literal `5` against
  a change of PK `5`.
- **Codec unit round-trip across every SqlValue class incl. blobs** — the
  tagged scheme also closes a latent blob-PK gap: `JSON.stringify` emitted a
  `Uint8Array` as a `{"0":..}` object that never decoded back to bytes; the
  `"x"+hex` tag now round-trips it.
- **Object-key coalescing preserved** — reorder-equal JSON-object PK components
  (`{a:1,b:2}` ≡ `{b:2,a:1}`) still encode identically (one change-log entry).

Validation run: `yarn workspace @quereus/quereus test` → **6517 passing, 0
failing, 9 pending**. `yarn workspace @quereus/quereus run lint` → **exit 0**
(eslint + `tsc` typecheck of test files).

## Reviewer starting points / known gaps (tests are a floor, not a ceiling)

- **The repro spec itself had a second bug I had to fix.** As delivered it
  consumed `Statement.all()` as if it returned an array (`.length`, `[0]`,
  `await …all()`), but `.all()` is an `AsyncIterableIterator` — you drain it
  with `for await`. The `--bail` runner hid cases 2 & 3 behind case 1's failure.
  I added an `allRows()` helper. Worth a glance that the assertions still test
  what they claim.
- **NaN / ±Infinity number PK is lossy** — `JSON.stringify(NaN)` → `"null"`, so
  a NaN number encodes as `"nnull"` and decodes to `null`, not NaN. This
  *matches the prior canonical-JSON behavior* (NaN→null), so no regression, but
  it is a real lossy edge if a NaN ever reaches a PK (degenerate — a NaN PK is
  nonsensical). Not guarded by a test.
- **`-0` decodes as `0`** — same `JSON.stringify` inheritance; not exercised.
- **Numeric coalescing tripwire (parked as a `NOTE:` in the codec docstring, not
  a ticket):** the codec deliberately keeps `5n` and `5` as DISTINCT change-log
  keys — matching `delta-executor` `tupleKey`, unlike `compareSqlValues` (which
  treats them equal). Not reachable today (a table's PK storage type is stable
  per row). *If* one logical row's PK were ever presented as differently-typed
  numerics across two ops in one transaction, its INSERT/DELETE would not
  coalesce; the fix then is to unify numerics in BOTH the codec and
  `delta-executor` `tupleKey` together. Confirm you agree this is genuinely
  conditional and not a latent defect.
- **Isolation-layer cleanup deferred (out of scope).** The parallel isolation
  bigint defect was already fixed under
  `iso-modified-pk-bigint-collation-tombstone-unique`. The ticket noted its
  repro test *could* now stage its bigint overlay row via a plain SQL insert
  instead of direct injection. I did not touch it — separate package, separate
  fix, no correctness need. A follow-up could simplify it.
- **Perf:** encode builds an intermediate string array + one `JSON.stringify`
  per DML op — same order of work as the prior canonical path. No new hot-path
  concern observed; not benchmarked.
