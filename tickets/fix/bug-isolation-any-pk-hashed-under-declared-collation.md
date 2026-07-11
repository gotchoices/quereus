---
description: When a table's primary key uses the flexible `any` type and is declared case-insensitive, the transaction layer treats two rows that differ only in letter case as the same row, so one of them can disappear from the results of a query run inside that transaction.
files:
  - packages/quereus-isolation/src/isolated-table.ts          # ~line 491 — pkNormalizers built from column.collation
  - packages/quereus/src/types/builtin-types.ts               # ANY_TYPE.compare — always BINARY
  - packages/quereus/src/types/validation.ts                  # validateCollationForType — accepts any collation on ANY
  - packages/quereus-store/src/common/store-table.ts          # resolvePkKeyCollations — the same decision, made correctly
difficulty: easy
---

# The isolation overlay keys an `any` primary key under a collation nothing compares under

## What is wrong

`create table t (k any collate nocase primary key)` is accepted. The `collate nocase` is inert:
`ANY_TYPE` declares no `supportedCollations`, so validation waves the clause through, and
`ANY_TYPE.compare` ignores whatever collation it is handed and compares under `BINARY`. So the
engine treats `'A'` and `'a'` as two distinct primary keys, and a memory table and a store table
both hold two rows.

`IsolatedTable` disagrees. It builds the key normalizers for its modified-primary-key set with:

```ts
this.keyNormalizerResolver(logicalTypeCanHoldText(column.logicalType) ? column.collation : undefined)
```

For that column `column.collation` is `NOCASE`, so `'A'` and `'a'` normalize to the same
signature. The overlay believes a write to one is a write to the other.

## Expected behavior

The isolation overlay must partition primary-key values exactly as the engine compares them. For
a column whose logical type can hold text but is not `isTextual` — `any`, `json`, and the
temporal types — that collation is always `BINARY`, never the declared one. The store module
makes this decision correctly in `resolvePkKeyCollations`; the isolation layer should reach the
same answer, ideally through a shared engine-level helper rather than a second copy of the rule.

## Reproduction sketch

Inside a transaction, against an isolated table:

```sql
create table t (k any collate nocase primary key, v text);
insert into t values ('A', 'upper'), ('a', 'lower');   -- two rows; both modules agree

begin;
  update t set v = 'changed' where k = 'A';
  select k, v from t;    -- the overlay's modified-PK set collapses 'A' and 'a'
commit;
```

The read-your-own-writes merge is expected to surface both rows, one changed and one not.

## Why it was left alone

Found while reviewing `bug-store-any-json-pk-keyed-under-table-collation`, which fixed the same
class of divergence in `packages/quereus-store`. The isolation site is not reachable through the
store path that ticket touched, and only an *explicit* `collate nocase` on an `any` / `json` /
temporal primary key trips it — a declaration nobody has a reason to write today. It is a latent
defect rather than an observed one, which is why it is filed here rather than in `fix/`.
