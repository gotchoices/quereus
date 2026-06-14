description: Memory module under-enforces a UNIQUE constraint when two UNIQUE indexes cover the same column-set with different collations. `findIndexForConstraint` resolves the enforcing index BY COLUMN-SET and returns the FIRST matching index in `schema.indexes`, so both column-set-equal UCs enforce under that first index's collation — a coarser-declared UNIQUE is silently under-enforced. Store/isolation resolve BY NAME (`uc.derivedFromIndex`) and are correct. Pre-existing; surfaced (not introduced) by the unify-unique-enforcement-collation-resolver review.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts          # findIndexForConstraint (by-column-set match) + checkUniqueViaIndex (KNOWN-gap comment)
  - packages/quereus/src/schema/unique-enforcement.ts           # uniqueEnforcementCollations (by-name; the correct resolution)
  - packages/quereus/test/unique-enforcement-collation.spec.ts  # conformance lock; explicitly scoped to single-index-per-column-set
  - packages/quereus-store/src/common/store-table.ts            # store re-validators (by-name; correct reference behavior)
difficulty: medium
----

# Fix: memory under-enforces UNIQUE with multiple same-column-set indexes of differing collation

## Symptom (reproducible)

Two UNIQUE indexes on the **same column-set** with **different per-column
collations**. When the FINER (e.g. `BINARY`) index is created **first**, the
memory module admits a duplicate that the coarser (`NOCASE`) index — and SQLite —
forbid:

```sql
create table t (id integer primary key, b text collate nocase);   -- memory (default)
create unique index ix_binary on t (b collate binary);            -- finer, created FIRST
create unique index ix_nocase on t (b collate nocase);            -- coarser
insert into t values (1, 'Bob');
insert into t values (2, 'bob');   -- memory: ADMITTED (BUG); SQLite/store: REJECTED
```

Reverse the creation order (`ix_nocase` first) and memory rejects correctly, so
the defect is **order-sensitive**. The same schema under the **store** module
rejects in both orders (verified during review).

## Root cause

`MemoryTableManager.findIndexForConstraint` (`manager.ts`) resolves the enforcing
structure **by column-set**:

```ts
for (const idx of schema.indexes) {
  if (idx.columns.length === uc.columns.length &&
      idx.columns.every((col, i) => col.index === uc.columns[i])) {
    const index = targetLayer.getSecondaryIndex?.(idx.name);
    return index ? { kind: 'memory-index', index } : undefined;   // FIRST match wins
  }
}
```

When two UCs share a column-set, **both** resolve to the same first-listed index,
so `checkUniqueViaIndex` enforces both under that index's collation
(`index.specColumns[i]?.collation ?? declared`). If the first index is finer than
a second UC's own (coarser) index, the coarser UNIQUE is enforced under the finer
collation and **misses** duplicates it should reject.

By contrast, the shared `uniqueEnforcementCollations(schema, uc)` helper (which
`quereus-store` and `quereus-isolation` import) resolves **by name** via
`uc.derivedFromIndex`, so each UC enforces under its OWN index's collation —
correct. This is precisely the by-name vs by-column-set divergence the unify
ticket's conformance lock calls out and (deliberately) scopes around; the memory
side is the wrong one.

## Expected behavior

For every UNIQUE constraint `uc`, the memory module must enforce under the
collation of the index `uc` was derived from (`uc.derivedFromIndex`), matching
store/isolation and SQLite. A table-level / column UNIQUE (no `derivedFromIndex`)
enforces under the declared column collation. The result must be
creation-order-independent.

## Likely direction (for the implement stage to confirm)

`findIndexForConstraint` should prefer the index named by `uc.derivedFromIndex`
when present, falling back to the column-set scan only for non-derived UCs (whose
auto-built covering index carries the declared collation, so any same-column-set
match is collation-equivalent). Equivalently, `checkUniqueViaIndex` could derive
the per-column collation from `uniqueEnforcementCollations(schema, uc)` (by-name)
while still scanning candidates via the live BTree — but note the live BTree
selected by column-set may key its entries under a *different* collation than the
UC requires, so candidate generation (not just the final compare) may need the
name-resolved index. The implementer must check that the chosen index's
`getPrimaryKeys(indexKey)` candidate set is sound under the UC's collation, not
just the post-fetch `compareSqlValues`.

## Scope / notes

- Pre-existing; the unify-unique-enforcement-collation-resolver refactor did NOT
  touch `findIndexForConstraint` or `checkUniqueViaIndex`'s resolution. It only
  surfaced the gap and documented it (see the KNOWN-gap comment now in
  `checkUniqueViaIndex`, and the scoped claim in
  `test/unique-enforcement-collation.spec.ts`).
- Exotic shape (two UNIQUE indexes on one column-set with differing collations),
  but a genuine silent-data-corruption-class hole: a duplicate that violates a
  declared UNIQUE is persisted.
- Add a regression test covering BOTH creation orders, and extend
  `unique-enforcement-collation.spec.ts` with a multi-index-same-column-set shape
  once the by-name/by-column-set paths are made to agree (today that shape is
  deliberately excluded because they diverge).
- Cross-check the covering-MV path (`checkUniqueViaMaterializedView`, already
  by-name via the helper) stays correct, and the `coveringMvHonorsIndexCollation`
  eligibility gate, which also resolves the index by name.
