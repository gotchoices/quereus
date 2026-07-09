----
description: When an application teaches the database its own text-sorting rule and then changes a row's primary key to a value that rule considers identical to the old one, a scan inside that transaction can return the row twice — once with the old value and once with the new. The fix is to make the transaction layer use the connection's own sorting rules instead of a hard-coded list of three.
files:
  - packages/quereus-isolation/src/isolated-table.ts        # ~481: pkNormalizers built from resolveKeyNormalizer; db is already on `this.db`
  - packages/quereus/src/util/key-serializer.ts             # resolveKeyNormalizer doc comment lists this caller; update it
  - packages/quereus-isolation/test/collation-resolver.spec.ts  # sibling suite, same override-NOCASE probe technique; new tests belong here
  - packages/quereus/src/core/database.ts                   # ~1497: getKeyNormalizerResolver() — the resolver to use
difficulty: easy
----

# Use the connection's key normalizers for the isolation overlay's modified-PK set

## What was reproduced

The bug is real and the fix is one line. Both were verified during the fix stage with a
throwaway spec (deleted; recreate as a permanent test — see TODO).

Reproduction, against `MemoryTableModule` under `IsolationModule`:

```ts
db.registerCollation('NOCASE', noSpace, stripSpaces);  // 'a b' == 'ab' on this connection
await db.exec(`create table t (k text collate NOCASE primary key, v integer) using isolated`);
await db.exec(`create index ix_v on t (v)`);
await db.exec(`insert into t values ('a b', 1)`);
await db.exec(`begin`);
await db.exec(`update t set k = 'ab' where k = 'a b'`);
// select k, v from t where v = 1   -- secondary-index scan
```

Observed: `[{k:'ab',v:1}, {k:'a b',v:1}]` — the staged row does not shadow the base row.
Expected: `[{k:'ab',v:1}]`.

A custom collation cannot yet be *named on a column* (`validateCollationForType` checks a
static per-type list), so the probe overrides the built-in `NOCASE` on the connection. That
override is what makes the test discriminating: a lookup that reaches the built-ins-only
table still gets case-folding, not space-stripping.

## Cause

`mergedSecondaryIndexQuery` in `isolated-table.ts` (~481) keys its modified-PK set with
`resolveKeyNormalizer(column.collation)` — the built-ins-only lookup in
`packages/quereus/src/util/key-serializer.ts`, which knows only `BINARY`/`NOCASE`/`RTRIM`
with their *original* meanings and silently returns the identity normalizer otherwise.
So the overlay row keys as `s:ab` while the underlying row keys as `s:a b`; the underlying
row is not filtered out of the merge, and both rows are yielded.

`Database.getKeyNormalizerResolver()` (`core/database.ts` ~1497) reads the live collation
registry. The engine's own hash-keyed operators were converted onto it by
`bug-key-normalizer-ignores-database-collations`. This site was left behind on the belief
that no `Database` was reachable — **that belief is wrong**: `VirtualTable` carries `this.db`,
and the ctor already does `this.collationResolver = db.getCollationResolver()` at line 133.

## The fix (verified)

Replace the `resolveKeyNormalizer` call with the connection's resolver. Bind it in the ctor
next to `collationResolver`, for the same reason: the two must agree, and one binding site
makes that legible.

```ts
private readonly keyNormalizerResolver: KeyNormalizerResolver;   // ctor: db.getKeyNormalizerResolver()
...
const pkNormalizers = pkIndices.map(i =>
    this.keyNormalizerResolver(this.tableSchema!.columns[i].collation));
```

With that patch applied the repro yields one row, and the full isolation suite
(`yarn workspace @quereus/isolation run test`, 180 specs) passes with no other change.
`resolveKeyNormalizer` then has no remaining import in `isolated-table.ts`.

## Behavior change: comparator-only collations now raise

`getKeyNormalizerResolver()` throws for a registered collation carrying no normalizer:

```
collation NOCASE has no key normalizer; grouping and hash-join keys require one —
pass { normalizer } to registerCollation
```

Verified: with `db.registerCollation('NOCASE', noSpace)` (no normalizer) and a text PK
declared `collate NOCASE`, a secondary-index scan inside a transaction throws that error
after the patch, where today it silently under-shadows and returns a duplicate row.

**Take the raise.** It matches the engine's hash sites, and the alternative — keeping the
silent identity fallback — is exactly the defect being fixed, just narrowed. The error is
surfaced at query time (wrapped as `Error during query on table 't': …`), only on the
secondary-index merge path, and only for a connection that registered a comparator-only
collation *and* named it on a PK column. Primary-key scans, which need only comparators,
keep working. Note the message's wording ("grouping and hash-join keys") is engine-centric
but not wrong for a hash-keyed set; leave it alone rather than fork the message.

## Do not delete `resolveKeyNormalizer` yet

Its doc comment says to delete it once this ticket and
`bug-store-key-encoder-ignores-database-collations` both land. That sibling is still in
`tickets/fix/` and still imports it. Update the comment to drop this caller from the list;
leave the export in place for the store ticket to retire.

## TODO

- Add a permanent test to `packages/quereus-isolation/test/collation-resolver.spec.ts`
  (new `describe`, e.g. "secondary-index scan under a custom PK collation") that fails on
  the current code: override `NOCASE` with `noSpace`/`stripSpaces`, text PK, secondary index
  on a non-key column, `update` the PK to a collation-equal value inside a transaction, scan
  through the secondary index, assert exactly one row. Confirm it fails before the fix.
- Add a companion test asserting the comparator-only case raises `has no key normalizer`
  rather than returning a duplicate row.
- Bind `this.keyNormalizerResolver = db.getKeyNormalizerResolver()` in the `IsolatedTable`
  ctor beside `collationResolver`; import `KeyNormalizerResolver` as a type from
  `@quereus/quereus`.
- Use it in `mergedSecondaryIndexQuery` in place of `resolveKeyNormalizer`; drop that import
  and rewrite the stale `NOTE:` block above the call (it currently describes the divergence
  and points at this ticket).
- Trim `resolveKeyNormalizer`'s doc comment in `packages/quereus/src/util/key-serializer.ts`
  to name only the store caller.
- Run `yarn workspace @quereus/isolation run typecheck` and `... run test`, plus `yarn test`
  at the root.
