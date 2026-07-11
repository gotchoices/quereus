---
description: An in-memory table sorts rows by its primary key using a different rule than the rest of the engine uses, so `order by <primary key>` on a duration column can hand back rows in an order that plain sorting would never produce — and a persistent table answers the same query differently.
files:
  - packages/quereus/src/vtab/memory/utils/primary-key.ts    # createSingleColumn/CompositeColumnPrimaryKeyFunctions — the typed comparator
  - packages/quereus/src/vtab/memory/table.ts                 # getPrimaryKeyComparator, providesOrdering advertisement
  - packages/quereus/src/util/comparison.ts                   # createTypedComparator vs compareSqlValuesFast
  - packages/quereus/src/types/temporal-types.ts              # TIMESPAN.compare — Temporal.Duration totals
  - packages/quereus/src/types/json-type.ts                   # JSON_TYPE.compare — structural deep-compare
difficulty: medium
---

# The memory table's primary-key order is not the engine's order

## What is wrong

Every scalar comparison the engine performs at runtime — `order by`, `where a > b`, a `Sort`
node's comparator — routes through `compareSqlValuesFast`, which orders by storage class and
then by the operand's **collation**. A column's `logicalType.compare` is never consulted on
those paths.

The memory module's primary-key BTree is the exception. `createPrimaryKeyFunctions` builds its
comparator with `createTypedComparator(columnSchema.logicalType, collationFunc)`, which prefers
`logicalType.compare` when the type declares one. For most types that makes no difference —
`TEXT`, `ANY`, `DATE`, `TIME` and `DATETIME` all end up comparing exactly as
`compareSqlValuesFast` would. For two types it does:

- `TIMESPAN.compare` resolves both operands to `Temporal.Duration` totals, so it calls
  `PT90M` (5400 s) less than `PT2H` (7200 s). Byte-wise, `'PT2H' < 'PT90M'`.
- `JSON_TYPE.compare` is a structural deep-compare that ranks by JSON type and compares numbers
  numerically, so it calls `{"a":2}` less than `{"a":10}`. Serialized, the bytes say otherwise.

A memory table then *advertises* that BTree order through `providesOrdering`, and the planner
elides the `Sort` it would otherwise have run. The rows come back in the type's order, which is
not the order the elided `Sort` would have produced.

## How it shows up

```sql
create table m (d timespan primary key);
insert into m values ('PT2H'), ('PT90M');

select d from m order by d;               -- 'PT90M', 'PT2H'   (Sort elided; BTree order)

create table s (id integer primary key, d timespan);
insert into s values (1, 'PT2H'), (2, 'PT90M');
select d from s order by d;               -- 'PT2H', 'PT90M'   (a real Sort runs)
```

Same values, same `order by`, two different answers — decided by whether the column happens to
be the primary key. The persistent store module answers `'PT2H', 'PT90M'` in both shapes,
because it orders by physical key bytes, which match `compareSqlValuesFast`. So this also reads
as a memory-vs-store divergence, and it is why
`packages/quereus-store/test/any-json-pk-binary-key.spec.ts` deliberately does **not** use a
memory table as its oracle for `timespan` PK ordering.

The seek path has the same split: `select d from m where d > 'PT90M'` returns no rows on the
memory table (its PK seek narrows the BTree under the typed comparator, and the predicate's own
collation-based residual then agrees) while a full scan of the same rows admits `'PT2H'`.

## What to decide

The two orders need to be reconciled, and which one wins is a real design question:

- **Make the memory BTree use the collation comparator** (`compareSqlValuesFast`) so the
  advertisement matches what `Sort` would do. Cheapest, and makes memory and store agree. Costs
  `timespan` and `json` their semantic ordering entirely — `order by` on a duration column would
  become lexicographic everywhere, which is arguably a worse SQL surface.
- **Make the whole engine's comparison path type-aware**, so `Sort` and `where` also consult
  `logicalType.compare`. That is the semantically desirable answer (`PT90M < PT2H` is what a
  user means), but it is a broad change: the store module would then have to stop advertising
  byte order for these columns, and index seeks over them would have to be declined.

Note also that neither order is currently reachable for *uniqueness*: the store admits both
`'PT60M'` and `'PT1H'` as distinct `timespan` primary keys, while the memory table rejects the
second as a duplicate. That divergence follows directly from the same split and should be
resolved together with it.
