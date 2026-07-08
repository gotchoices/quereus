description: Add the end-to-end test that writes a very large integer primary key and reads it back through a range query against the persistent (LevelDB) storage path — the test was deferred until large-integer keys could be written at all, which is now fixed.
files:
  - packages/quereus-store/test/pushdown.spec.ts        # has the deferred-test NOTE (numeric pushdown suite)
  - packages/quereus-store/test/encoding.spec.ts         # unit-level proof of large-int byte order + roundtrip
  - packages/quereus/src/util/key-tuple-codec.ts         # the change-log codec that unblocked bigint PKs
difficulty: easy
----

## Background

Integer primary keys larger than `Number.MAX_SAFE_INTEGER` (2^53) flow through
the engine as JavaScript `bigint`. Until recently, writing such a key crashed
the transaction change log (`serializeKeyTuple` → canonical JSON →
`JSON.stringify` throws on a bigint). That crash was fixed under
`txn-changelog-bigint-key` — the change log now keys through a reversible,
type-faithful codec (`util/key-tuple-codec.ts`).

The store package's numeric-pushdown test suite
(`packages/quereus-store/test/pushdown.spec.ts`) has long carried a `NOTE`
explaining that a combined test — an end-to-end SQL range seek over a
large-integer PK **through the persistent store path** — could not be written
because the write crashed upstream. The store's *byte-level* encoding of large
integers is already proven in `encoding.spec.ts` (sort order + exact
round-trip across the safe-integer boundary), but nothing exercises the full
`INSERT` → range-`SELECT` path against the store module for a bigint PK.

That write path is now unblocked. This ticket is to write the deferred test.

## What to build

A test in the store suite that:

- creates a table with an integer primary key backed by the persistent store
  (`using store`),
- inserts rows whose PK straddles the 2^53 boundary (at least one value
  `>= 2^53 + 1` that only a bigint can represent exactly, plus a couple of
  ordinary small values),
- runs a range query (e.g. `where id >= <big> order by id`) and asserts the
  returned rows and their order match an oracle, with the large key round-tripping
  to its exact value (a lossy `number` cast would collapse `2^53+1` to `2^53`).

Runs under `yarn test:store` (the store-backed suite), not the default
memory-backed `yarn test`.

## Why backlog / low urgency

Pure test-coverage debt, no correctness risk: the codec round-trip is proven at
the unit level (`test/incremental/txn-bigint-key.spec.ts`) and the store byte
encoding at the unit level (`encoding.spec.ts`). This ticket only closes the gap
between those two proven halves with an integration test.
