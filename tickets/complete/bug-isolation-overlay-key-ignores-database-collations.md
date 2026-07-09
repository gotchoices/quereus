----
description: Fixed a bug where renaming a database row's primary key to a value the application's custom sorting rule treats as unchanged could make that row appear twice in a query run inside the same transaction.
files:
  - packages/quereus-isolation/src/isolated-table.ts        # keyNormalizerResolver field (~87, bound ~142); use site ~481 in mergedSecondaryIndexQuery
  - packages/quereus/src/planner/analysis/comparison-collation.ts  # logicalTypeCanHoldText extracted + exported
  - packages/quereus/src/index.ts                            # re-exports logicalTypeCanHoldText
  - packages/quereus/src/util/key-serializer.ts              # resolveKeyNormalizer doc comment names only the remaining (store) caller
  - packages/quereus-isolation/test/collation-resolver.spec.ts  # describe block "secondary-index scan under a custom PK collation" (3 tests)
  - docs/design-isolation-layer.md, docs/sql.md, docs/plugins.md  # normalizer resolution + where a normalizer is required
difficulty: easy
----

# Isolation overlay's modified-PK set uses the connection's own collations

## What changed

`IsolatedTable.mergedSecondaryIndexQuery` — the read path used when a transaction has
uncommitted writes and the query goes through a secondary index — builds a `Set` of the
primary keys touched by the transaction, in order to filter the shadowed rows out of the
underlying stream. It keyed that set with `resolveKeyNormalizer`, a built-ins-only helper
that recognizes exactly `BINARY`/`NOCASE`/`RTRIM` and silently falls back to identity for
anything else. If an application registered its own collation with `db.registerCollation` —
including re-registering a built-in name like `NOCASE` with different semantics — and a
transaction rewrote a primary key to a value that collation considers equal to the old one,
the staged row failed to shadow the base row and the scan returned both.

`IsolatedTable` now binds `this.keyNormalizerResolver = db.getKeyNormalizerResolver()` in its
constructor, beside the pre-existing `this.collationResolver = db.getCollationResolver()` —
same rationale: the key encoding and the merge comparators must agree on which rows are
equal. `mergedSecondaryIndexQuery` resolves through that instead of the static helper.

The review pass added a type gate to that resolution (see *Review findings* below): a primary
key column whose declared type can never hold text takes the identity normalizer regardless
of its declared collation, matching how the engine's own hash-key emitters gate through
`hashKeyCollationName`.

`resolveKeyNormalizer` is no longer imported by `isolated-table.ts`. Its doc comment in
`key-serializer.ts` now names only the remaining caller — `quereus-store`'s key encoder,
tracked by the sibling ticket `bug-store-key-encoder-ignores-database-collations`, still in
`tickets/fix/`. Do not delete `resolveKeyNormalizer` until that one lands.

## Behavior change to be aware of

`db.getKeyNormalizerResolver()` throws for a collation that has a comparator but no
registered normalizer (`db.registerCollation(name, comparator)` with no third argument):

```
collation NOCASE has no key normalizer; grouping and hash-join keys require one —
pass { normalizer } to registerCollation
```

Intentional, and consistent with the engine's other hash-keyed sites (bloom-join, window
partitioning, hash-aggregate, `AS OF`) — see the sibling fix
`bug-key-normalizer-ignores-database-collations` this built on. Silently falling back to
identity would just be a narrower version of the bug being fixed.

The error surfaces only when a connection registers a comparator-only custom collation, names
it on a **text** primary-key column, and a query hits the secondary-index merge path inside a
transaction with pending writes on that table. Primary-key scans (which need only a
comparator) are unaffected, and so is a non-text primary-key column carrying such a collation.

## Testing

Three tests in `packages/quereus-isolation/test/collation-resolver.spec.ts`, describe block
`"secondary-index scan under a custom PK collation"`:

1. **Regression test**: overrides built-in `NOCASE` with a space-stripping collation, text PK
   plus a secondary index on a non-key column, updates the PK to a collation-equal value
   inside a transaction, asserts the secondary-index scan returns the row exactly once.
2. **Comparator-only raises**: same setup but `NOCASE` registered with a comparator and no
   normalizer; asserts the scan throws `has no key normalizer` rather than silently returning
   a duplicate row.
3. **Non-text PK needs no normalizer** (added this stage): `n integer collate MYCOLL primary
   key` under a comparator-only `MYCOLL`; asserts the same scan succeeds and returns one row.

Both pre-existing tests were confirmed genuinely discriminating: with the use-site temporarily
reverted to `resolveKeyNormalizer`, test 1 fails with two rows and test 2 fails with no error
raised. Test 3 fails on the implement-stage code with `collation MYCOLL has no key
normalizer`.

Gotcha for whoever extends this suite: `attempt(db, sql)` (built on `db.exec`) does not fully
drain a bare `SELECT`'s row stream, so an error raised while producing rows never surfaces
through it — `err` comes back `null` even though the throw is real. Use `collect(db, sql)`
(built on `db.eval`, which iterates) wrapped in try/catch when asserting that a `SELECT`
throws.

Validation this stage:
- `yarn build` — clean
- `yarn lint` — clean (only `packages/quereus` has a real lint; the rest are intentional no-ops)
- `yarn workspace @quereus/isolation run typecheck` — clean
- `yarn test` at repo root — exit 0, 0 failing, 9 pending. Isolation suite 183 passing
  (was 182; +1 new). All 13 workspaces reported.

## Review findings

**Checked:** the implement-stage diff read before the handoff summary; every other row-key
hash site in `quereus-isolation` (grep for `JSON.stringify`, `Set<string>`, `serializeRowKey`
— `mergedSecondaryIndexQuery` is the only one, so the fix is complete for this package);
constructor-binding liveness and eager-throw risk; collation-name case handling; whether the
two new tests actually exercise the secondary-index path or pass vacuously; every doc file
that describes this code path or the "when is a normalizer required" contract; `yarn build`,
`yarn lint`, `yarn test`.

**Major (fixed inline rather than deferred — a regression introduced by the diff under
review, and the fix is ~15 lines):** the new resolution passed the PK column's declared
collation to `getKeyNormalizerResolver()` unconditionally, ignoring the column's type. The
engine's own hash sites never do this — they gate through `hashKeyCollationName`, which drops
the collation for a key no operand of which can hold text, precisely because
`serializeRowKey` normalizes only string values. So `create table t (n integer collate mycoll
primary key, …) using isolated` under a comparator-only `mycoll` began throwing `collation
MYCOLL has no key normalizer` on a secondary-index scan inside a transaction, where before the
change it worked. That contradicts the documented rule in `docs/sql.md` and `docs/plugins.md`
("a key whose type can never hold text … needs no normalizer and does not raise"), and it is
reachable today: `INTEGER` declares no supported-collation list, so DDL accepts the name.
Reproduced with a throwaway spec, then fixed: the private `typeCanHoldText` in
`comparison-collation.ts` was split into an exported `logicalTypeCanHoldText(LogicalType)`
(taking a `LogicalType`, which is what a `ColumnSchema` carries), re-exported from the package
index, and `isolated-table.ts` now passes `undefined` in place of the collation for a non-text
PK column. Covered by test 3 above. Note the unregistered-name case is *not* reachable — the
memory module rejects it at `create table` with `no such collation sequence`.

**Minor (fixed inline):** the change touched no documentation, and three docs were stale or
incomplete against it. `docs/design-isolation-layer.md` § *Index Scan Merge* described the
modified-PK set's encoder without saying the normalizers now resolve against the connection,
and its § *Collation Considerations* listed only `getCollationResolver()` — both updated,
including the new comparator-only raise and the non-text-PK exemption. `docs/plugins.md`'s
list of places a normalizer is required, and the parallel paragraph in `docs/sql.md`, both
enumerate the engine's hash sites; the isolation overlay's staged-PK set is now one of them
and is listed. The doc comment above `NEVER_TEXT_PHYSICAL_TYPES` said "the three collapse into
one predicate" (counting the now-extracted `typeCanHoldText`); corrected to "the two".

**Tripwires (recorded, not filed as tickets):**
- The three secondary-index tests only reach `mergedSecondaryIndexQuery` because the planner
  picks `ix_v` for `where v = …`. If index selection ever changes, the scan falls back to the
  primary-key merge — which shadows correctly for unrelated reasons — and all three would pass
  vacuously instead of failing. Parked as a `NOTE:` comment above the describe block in
  `collation-resolver.spec.ts`, with the recipe for re-verifying they still fail.
- `logicalTypeCanHoldText` and `columnCanHoldText` in `quereus-store/src/common/store-table.ts`
  are now the two surviving copies of the same predicate. The existing ticket
  `bug-json-columns-classified-as-non-textual` already owns collapsing them; the doc comment
  above `NEVER_TEXT_PHYSICAL_TYPES` points at it. No new ticket.

**New tickets filed:** none. The one significant finding was a regression in the diff under
review, small enough to fix in this pass; nothing else rose above cosmetic.

**Not covered, deliberately:**
- The primary-key-scan path (`mergedQuery`'s non-secondary branch) has no regression test
  under a comparator-only collation. That path resolves only comparators, never normalizers,
  so there is nothing for this bug to break there; a test would only guard against a future
  refactor routing it through the normalizer resolver. Judged not worth a ticket.
- No performance measurement. `getKeyNormalizerResolver()` memoizes its closure exactly as
  `getCollationResolver()` does (the same lazy-bind-once pattern already in production), and
  the added `logicalTypeCanHoldText` call is one set lookup per PK column per query, so there
  is no new per-row cost. Not measured.
- `quereus-store`'s key encoder still uses the built-ins-only `resolveKeyNormalizer` and still
  has the same class of bug. Out of scope: it is the sibling ticket
  `bug-store-key-encoder-ignores-database-collations`, still in `tickets/fix/`.
