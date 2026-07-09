----
description: The query planner assumes a JSON column can never contain a text string, but it can — a JSON value like "Bob" is stored as the plain string Bob — so optimizations that are only safe for non-text columns may be applied to JSON columns and produce wrong answers.
files:
  - packages/quereus/src/planner/analysis/comparison-collation.ts  # isNonTextualLogicalType (~296)
  - packages/quereus/src/types/json-type.ts                        # JSON_TYPE.parse passes strings through
  - packages/quereus-store/src/common/store-table.ts               # columnCanHoldText — the corrected, store-local version
difficulty: medium
----

# `isNonTextualLogicalType` mis-classifies JSON (and possibly other types)

## The mis-classification

`isNonTextualLogicalType(lt)` answers "can a value of this type never be a text
string?". It answers **yes** for the `JSON` type, because JSON's physical
representation is tagged `OBJECT`.

That is wrong. `JSON_TYPE.parse` passes a JSON *scalar* string straight through, so a
column declared `JSON` holding the value `'"Bob"'` stores the ordinary string `Bob`.
Comparisons on it go through the text comparison path, and a collation applies.

## Why it matters

The function guards optimizations that are only sound for values a collation cannot
affect. Its main caller decides whether an equality such as `a = b` is
"value-discriminating" — whether the planner may mint value-level facts (constant
pins, equivalence classes, join equi-pairs) from rows that passed it. Under a
case-insensitive collation, `'Bob' = 'BOB'` passes without the two values being equal,
so minting a fact from it is unsound. A JSON column exempted from that check can
therefore feed the planner a false fact.

I have not constructed a wrong query result from the planner path — that is the first
job here. What *is* proven is the exact analogue one layer down: the persistent store
had its own copy of this predicate, and a `JSON` column under a
`CREATE UNIQUE INDEX … COLLATE NOCASE` silently accepted a duplicate because the
column was exempted as "non-text". The store's copy has been corrected to test the
physical representation against an allow-list (`INTEGER`, `REAL`, `BLOB`, `BOOLEAN`
are provably never strings; everything else — `TEXT`, `ANY`'s `NULL`, `JSON`'s
`OBJECT` — may be). See `columnCanHoldText` in `store-table.ts` and its regression
tests in `packages/quereus-store/test/unique-constraints.spec.ts`.

## Scope

- Establish whether the planner's use of the predicate can produce a wrong answer for
  a JSON column, and if so pin it with a test.
- Correct the engine's predicate the same way the store's was corrected: an allow-list
  over physical representation, so a future string-capable logical type is
  conservatively included rather than silently exempted.
- Then the two copies can be de-duplicated: export the engine's predicate from
  `@quereus/quereus` and delete `columnCanHoldText` from the store. Deliberately *not*
  done while the two disagree — the store's version is currently the stricter of the
  two, and sharing the looser one would reintroduce the bug it fixes.
