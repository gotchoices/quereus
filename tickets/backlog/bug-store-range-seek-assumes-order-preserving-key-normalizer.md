---
description: When an application teaches the database its own text-sorting rule, range queries against a persistent-store table can silently skip rows, because the store assumes the rule sorts text the same way the raw stored bytes do.
files:
  - packages/quereus-store/src/common/store-table.ts   # buildPKRangeBounds, analyzeIndexAccess, buildIndexRangeBounds
  - packages/quereus-store/src/common/store-module.ts  # tryIndexAccessPlan → safeToHandle
  - packages/quereus/src/core/database.ts              # registerCollation, getKeyNormalizerResolver
  - docs/store.md                                      # § Collation Support
difficulty: medium
---

# Range seeks over a text key assume an order-preserving key normalizer

## Background in plain terms

A **collation** is a rule for comparing two strings. Quereus lets an application supply
its own with `db.registerCollation(name, comparator, { normalizer })`:

- the **comparator** answers "which of these two strings sorts first?";
- the **normalizer** rewrites a string into a canonical form, so that two strings the
  comparator calls *equal* always rewrite to the *same* form.

The persistent store (`using store`, and the LevelDB / IndexedDB plugins built on it)
lays out its keys by writing each text value's **normalized** form into the key bytes.
Rows are then physically ordered by raw byte comparison of those normalized forms.

## What is wrong

`registerCollation` promises only that the normalizer agrees with the comparator about
**equality**. It says nothing about **order**. But the store's range seeks assume order:
to answer `where k > 'b'` it normalizes `'b'`, and iterates the key-value store from
those bytes forward, trusting that every row the comparator would accept lives at or
after them. When it does not, the seek starts too late and rows are dropped from the
result with no error.

Concretely, this pairing is a legal registration today:

```ts
// Equal iff lowercase-equal — matches the normalizer's partition exactly.
// But orders SHORTER strings first, which byte order does not.
db.registerCollation('NOCASE',
  (a, b) => a.length - b.length || (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0),
  { normalizer: (s) => s.toLowerCase() });
```

Under it the comparator says `'aa' > 'b'` (longer sorts later), while the key bytes say
`'aa' < 'b'`. A `select * from t where k > 'b'` over a store table with a text primary
key seeks from the bytes of `'b'` and never visits `'aa'` — the row is silently lost.

Point (equality) seeks are unaffected: they only need the equality guarantee the
normalizer already provides.

## Why it is reachable now

Column-level `COLLATE` still accepts only the three built-in names, but a built-in
name's *behavior* is replaceable: `db.registerCollation('NOCASE', …)` and
`db.registerCollation('RTRIM', …)` both override the built-ins (only `BINARY` is
protected). So the defect needs no new DDL surface — just a re-registration whose
comparator does not order strings the way byte comparison orders their normalized forms.

Nothing in the engine or the store detects this. The three built-in collations are all
order-preserving, so the default configuration is correct; only an override that trades
away order-preservation is affected.

## Affected sites

- `StoreTable.buildPKRangeBounds` — a `<`/`<=`/`>`/`>=` window over the leading text
  primary-key column.
- `StoreTable.analyzeIndexAccess` / `buildIndexRangeBounds` — the same window over the
  leading secondary-index column, whose bytes use the table key collation `K`.
- `StoreModule.tryIndexAccessPlan` — its `safeToHandle` check admits the range seek and
  marks the predicate *handled*, which drops the residual filter that would otherwise
  have re-checked each row. (For the equality case this is sound; for the range case it
  is what turns an under-fetch into a wrong answer rather than a slow one.)

`matchesFilters` remains the authoritative row filter, so an *over*-fetching window is
always safe. Only under-fetching loses rows.

## Expected behavior

A range seek over a text key must never drop a row the collation's comparator would
have matched. Two directions are open:

1. **Make order-preservation an assertable property of a collation.** Let a caller
   declare it at registration (alongside the existing `replicable` flag), have the store
   admit range seeks only for collations that carry the assertion, and fall back to a
   full scan (with the residual filter retained) otherwise. The built-ins carry it.
2. **Verify rather than trust.** Cross-check normalizer order against comparator order
   on a sample of strings at registration time, and reject or downgrade on mismatch.
   Cheap, but only probabilistic.

Whichever is chosen, `docs/store.md` § Collation Support and the `NOTE:` comment on
`StoreTable.buildPKRangeBounds` currently describe the hazard and point here; both should
be updated to describe the guarantee once it exists.

## Notes

- Predates `bug-store-key-encoder-ignores-database-collations`: before that fix the store
  keyed text with its own built-in encoders while comparing with the database's
  comparator, which had the same (in fact broader) hazard. That fix made key bytes and
  comparisons agree on *equality*; it did not establish agreement on *order*.
- `feat-ddl-accepts-registered-collations` would widen the exposure to arbitrary named
  collations on a column, so landing that ticket without this one increases the blast
  radius.
- The engine's own hash-key sites (`GROUP BY`, `PARTITION BY`, hash-join keys) consume
  normalizers for bucketing only, never for ordering, so they are not affected.
