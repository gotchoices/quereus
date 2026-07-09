description: Fixed a bug where renaming a database row's primary key to a value the application's custom sorting rule treats as unchanged could make that row appear twice in a query run inside the same transaction.
files:
  - packages/quereus-isolation/src/isolated-table.ts        # keyNormalizerResolver field (~87, bound ~142); use site ~481 in mergedSecondaryIndexQuery
  - packages/quereus/src/util/key-serializer.ts              # resolveKeyNormalizer doc comment trimmed to name only the remaining (store) caller
  - packages/quereus-isolation/test/collation-resolver.spec.ts  # new describe block "secondary-index scan under a custom PK collation"
difficulty: easy
----

# Isolation overlay's modified-PK set now uses the connection's own collations

## What changed

`IsolatedTable.mergedSecondaryIndexQuery` (the read path used when a transaction has
uncommitted writes and the query goes through a secondary index) built its "which PKs were
touched this transaction" `Set` using `resolveKeyNormalizer`, a built-ins-only helper that
recognizes exactly `BINARY`/`NOCASE`/`RTRIM` and silently falls back to identity for anything
else. If an application registered its own collation (`db.registerCollation`) — even
re-registering a built-in name like `NOCASE` with different semantics — and a transaction
rewrote a primary key to a value that collation considers equal to the old one, the staged
row failed to shadow the base row: a scan through a secondary index returned both the old and
new row.

Fix: `IsolatedTable` now binds `this.keyNormalizerResolver = db.getKeyNormalizerResolver()`
in its constructor (next to the pre-existing `this.collationResolver = db.getCollationResolver()`,
same rationale — the two must agree) and uses it in `mergedSecondaryIndexQuery` instead of the
static helper. `resolveKeyNormalizer` is no longer imported by this file; its doc comment
in `key-serializer.ts` now names only the remaining caller (`quereus-store`'s key encoder,
tracked by the sibling ticket `bug-store-key-encoder-ignores-database-collations`, still in
`tickets/fix/` — do not delete `resolveKeyNormalizer` until that one lands too).

## Behavior change to be aware of

`db.getKeyNormalizerResolver()` **throws** for a collation that has a comparator but no
registered normalizer (`db.registerCollation(name, comparator)` with no third arg):

```
collation NOCASE has no key normalizer; grouping and hash-join keys require one —
pass { normalizer } to registerCollation
```

This is intentional and matches the engine's other hash-keyed sites (bloom-join, window
partitioning, hash-aggregate, AS OF) — see the sibling fix
`bug-key-normalizer-ignores-database-collations` this ticket built on. Silently falling back
to identity would just be a narrower version of the bug being fixed. The error surfaces only
when: a connection registers a comparator-only custom collation, names it on a primary-key
column, and a query hits the secondary-index merge path inside a transaction with pending
writes on that table. Primary-key scans (comparator-only is sufficient there) are unaffected.

## Testing

Two new tests in `packages/quereus-isolation/test/collation-resolver.spec.ts`, describe block
`"secondary-index scan under a custom PK collation"`:

1. **Repro-turned-regression-test**: overrides built-in `NOCASE` with a space-stripping
   collation (`db.registerCollation('NOCASE', noSpace, stripSpaces)`), creates a table with a
   `NOCASE` text PK and a secondary index on a non-key column, updates the PK to a
   collation-equal value inside a transaction, and asserts a scan through the secondary index
   returns the row exactly once. Confirmed this fails (returns 2 rows) against the pre-fix
   code.
2. **Comparator-only-raises**: same setup but registers `NOCASE` with a comparator and no
   normalizer, and asserts the scan throws `has no key normalizer` rather than silently
   returning a duplicate row.

Gotcha for whoever extends this suite: `attempt(db, sql)` (the existing helper, built on
`db.exec`) does **not** fully drain a bare `SELECT`'s row stream — `db.exec` runs the
statement's plan but a `SELECT`'s output isn't pulled through unless something iterates it.
An error raised while producing rows (as here) will NOT surface through `attempt`/`db.exec`;
it only surfaces via `collect(db, sql)` (built on `db.eval`, which does iterate). The second
new test learned this the hard way — first version used `attempt()` on a `SELECT` and always
got `err === null` even though the throw was real (verified via a temporary debug print
showing the QuereusError). Use `collect()` wrapped in try/catch (as the final test does) when
asserting a SELECT throws.

Full validation run this stage:
- `yarn workspace @quereus/isolation run typecheck` — clean
- `yarn workspace @quereus/isolation run test` — 182 passing (was 180; +2 new)
- `yarn test` at repo root — 6697 + 182 + 86 + 30 + 17 + 28 + 777 + 443 + 65 + 31 + 74 + 34 +
  128 passing across every workspace, 9 pending, 0 failing

## Known gaps / not covered

- No test exercises the primary-key-scan path (`mergedQuery`'s non-secondary branch) under a
  comparator-only collation — that path only needs a comparator (via `collationResolver`),
  never the normalizer, so it was out of scope for this bug, but there's no regression test
  proving it *doesn't* regress if someone later routes it through the normalizer resolver too.
- The doc comment on `resolveKeyNormalizer` in `key-serializer.ts` still says "Delete this
  function once that one is converted" (singular, the store ticket) — correct as of this
  landing, but will go stale if a third caller ever gets added without updating it.
- No performance testing — `db.getKeyNormalizerResolver()` closure is memoized identically
  to `getCollationResolver()` (same lazy-bind-once pattern already in production use), so no
  new perf surface expected, but not explicitly measured here.
