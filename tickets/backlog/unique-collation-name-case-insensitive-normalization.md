description: A column constraint `collate nocase` (or `rtrim`/`binary`) written in lowercase is rejected at DDL with a misleading "not supported" error, purely because the collation-name check is case-sensitive. Collation names should be matched/normalized case-insensitively so `nocase` ≡ `NOCASE`.
files: packages/quereus/src/schema/table.ts, packages/quereus/src/types/builtin-types.ts, packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic
----

## Problem

`create table t (id integer primary key, email text collate nocase unique)` is **rejected**
at DDL, while the otherwise-identical uppercase `collate NOCASE` is accepted. The rejection
message contains "not supported", which misled a prior reader into believing UNIQUE doesn't
support collation at all (it does — see the now-landed
`unique-constraint-honors-column-collation`).

## Root cause

`validateColumnSchema` (`packages/quereus/src/schema/table.ts`, ~line 191) does:

```ts
!logicalType.supportedCollations.includes(constraint.collation)
```

against `TEXT_TYPE.supportedCollations = ['BINARY','NOCASE','RTRIM']`
(`packages/quereus/src/types/builtin-types.ts`). The `includes` is **case-sensitive**, so a
lowercase `nocase` fails the membership test and is rejected with a "collation not
supported" message. SQLite treats collation names case-insensitively; Quereus should too.

## Wanted

- A collation name supplied in any case (`nocase`, `NoCase`, `NOCASE`) is accepted for a
  TEXT column and **normalized** to its canonical form on the `ColumnSchema.collation`
  (so downstream comparisons via `compareSqlValues` / `resolveCollation` resolve it).
- Consistent behavior in column-level `collate`, table/inline `unique`, and
  `create [unique] index … collate …` contexts.
- The error message for a genuinely-unknown collation (e.g. `collate frobnicate`) should
  say the collation is unknown, not conflate it with the case quirk.

## Regression coverage

- In `packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic` §1, the two
  `-- error: not supported` blocks assert the *current* lowercase-rejection behavior; once
  this lands, flip them to assert the lowercase spelling is accepted and enforces
  identically to uppercase (a lowercase-`nocase` UNIQUE rejecting `'abc'`/`'ABC'`). The
  surrounding prose was already corrected to explain this is a case-sensitivity quirk.

## Notes

- Latent gap surfaced while landing `unique-constraint-honors-column-collation`; that
  ticket deliberately left this alone (it only used the canonical uppercase spelling).
- Check whether `resolveCollation` / `getCollation` are already case-insensitive (the lookup
  side may need the same treatment as the validation side).
