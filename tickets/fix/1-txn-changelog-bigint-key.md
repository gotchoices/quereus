description: Inserting, updating, or deleting a row whose primary key is a very large integer inside a transaction crashes the engine with "Do not know how to serialize a BigInt".
files:
  - packages/quereus/src/core/database-transaction.ts   # serializeKeyTuple (~447); recordInsert/Delete/Update (~557-602); getChangedKeyTuples JSON.parse (~628); getChangedTuples dedup JSON.stringify (~676)
  - packages/quereus/src/util/key-serializer.ts          # serializeKey/serializeKeyNullGrouping — candidate bigint-safe encoder (reuse; do not weaken)
  - packages/quereus/src/runtime/delta-executor.ts       # primary consumer of getChangedTuples (reactive queries / incremental views)
difficulty: medium
----

## Problem

Any table with a big-integer primary key crashes the moment a row is written
inside a transaction — including the implicit transaction around a bare
statement. This is **not** isolation-specific; it reproduces on a plain table:

```sql
create table t (id integer primary key, v text);
begin;
insert into t values (9007199254740993, 'x');   -- 2^53 + 1, a JS bigint
-- CRASH: TypeError: Do not know how to serialize a BigInt
```

Confirmed by running the above against `packages/quereus/dist` directly.

## Root cause

The transaction change log keys rows by a serialized PK tuple, and the serializer
is plain `JSON.stringify`:

```ts
// database-transaction.ts ~447
private serializeKeyTuple(values: readonly SqlValue[]): string {
    return JSON.stringify(values);   // throws on a bigint element
}
```

`JSON.stringify` throws on a `bigint`. Every DML op inside a transaction records a
change (`recordInsert`/`recordDelete`/`recordUpdate` → `serializeKeyTuple`), so a
bigint PK value hard-crashes the write. There is a second bare `JSON.stringify`
at `getChangedTuples` (~676) used only for de-dup, which would throw the same way
once a bigint value reaches a captured column.

## The round-trip constraint (why this isn't a one-liner)

`serializeKeyTuple`'s output is not only a `Map` key — it is **decoded back** into
`SqlValue[]` by `getChangedKeyTuples` (~628, `JSON.parse(pkKey)`). So the encoder
must be reversible: a bigint must survive encode→decode as a bigint, not silently
become a string or a lossy number. A naive replacer that stringifies bigints
would fix the crash but corrupt the PK tuples handed to change-log consumers.

The change log feeds the reactive-query / incremental-view subsystem
(`delta-executor.ts` via `getChangedTuples`, `database-assertions.ts`,
`database-watchers.ts`). A fix must keep those consumers seeing correct,
type-faithful PK values.

## Expected behavior

- A bigint PK (or any bigint value in a captured column) can be inserted,
  updated, and deleted inside a transaction without throwing.
- Two PK tuples are the same change-log key iff they are the same logical key
  (bigint `5n` and its round-trip must match themselves; do not conflate a bigint
  with a differently-typed value unless the engine's comparators already do —
  align with `compareSqlValues`, don't invent new equality).
- `getChangedKeyTuples` returns PK tuples whose bigint elements are still
  bigints (round-trip fidelity), so reactive queries / incremental views over a
  bigint-PK table dispatch on the correct keys.

## Direction (not prescriptive)

- Replace the `JSON.stringify`/`JSON.parse` pair with a bigint-safe, reversible
  encoding for the change-log key. Options: a tagged encode/decode pair (bigint →
  a tagged token, decoded back via a reviver), or route through the existing
  `key-serializer.ts` helpers — but note `serializeKey` returns `null` on any NULL
  element and is one-way (no decoder), so a captured non-PK column that is NULL
  needs handling, and a separate decode path is still required for
  `getChangedKeyTuples`. Whichever is chosen, keep encode and decode in lockstep.
- Fix the dedup-only `JSON.stringify` at `getChangedTuples` (~676) too — it only
  needs to not throw (no decode), so the same encoder suffices.
- Watch Uint8Array / blob PKs while you are here: `JSON.stringify` does not throw
  on them but encodes them as `{"0":..}` objects that do **not** round-trip to a
  `Uint8Array` via `JSON.parse` — the current code already has this latent
  round-trip gap; a type-tagged encoder can close it.

## Reproducing test

Add a logic or unit test under `packages/quereus/test` (a `.sqllogic` case or a
transaction-manager unit test) that:

- creates a plain `id integer primary key` table, opens a transaction, inserts a
  value beyond `Number.MAX_SAFE_INTEGER` (so it surfaces as a JS bigint), and
  commits — asserting no throw and the row is readable afterward;
- ideally also asserts a reactive query / incremental view over that table sees
  the change (exercises `getChangedTuples` round-trip), so the fix is validated
  end-to-end and not just at the crash site.

## Note for the isolation layer

The isolation layer had its own parallel bigint defect in the secondary-index
merge path (`packages/quereus-isolation/src/isolated-table.ts`,
`mergedSecondaryIndexQuery`), fixed under
`iso-modified-pk-bigint-collation-tombstone-unique`. That fix uses the canonical
`serializeRowKey` encoder and is independent of this one; but a SQL-driven
bigint-PK insert still crashes here first, so the isolation layer's bigint use
case is only fully usable end-to-end once this ticket lands. The isolation repro
test stages its bigint overlay row via direct injection to sidestep this crash —
once this lands, that test could be simplified to a plain SQL path.
