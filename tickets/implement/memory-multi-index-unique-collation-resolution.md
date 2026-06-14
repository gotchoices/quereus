description: Memory module under-enforces a UNIQUE constraint when two UNIQUE indexes cover the same column-set with different collations. `findIndexForConstraint` resolves the enforcing index BY COLUMN-SET (first match in `schema.indexes`), so both same-column-set UCs enforce under the first index's collation — a coarser-declared UNIQUE is silently under-enforced and order-sensitive. Fix: resolve an index-derived UC BY NAME via `uc.derivedFromIndex` (matching store/isolation), falling back to the column-set scan only for non-derived UCs. Reproduced and the fix verified during the fix stage.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts                  # findIndexForConstraint (the fix) + checkUniqueViaIndex KNOWN-gap comment to retire
  - packages/quereus/src/schema/unique-enforcement.ts                  # helper doc-comment describing the (now-closed) divergence
  - packages/quereus/test/unique-enforcement-collation.spec.ts         # conformance lock — update header, resolveLiveIndex mirror, add multi-index shape
  - packages/quereus/test/logic/102.2-unique-collation.sqllogic        # behavioral regression home (runs under BOTH memory + store)
difficulty: medium
----

# Fix: memory under-enforces UNIQUE with multiple same-column-set indexes of differing collation

## Status from the fix stage

The defect is **reproduced and the fix is verified**. A throwaway spec drove:

```sql
create table t (id integer primary key, b text collate nocase);
create unique index ix_binary on t (b collate binary);   -- finer, created FIRST
create unique index ix_nocase on t (b collate nocase);   -- coarser
insert into t values (1, 'Bob');
insert into t values (2, 'bob');   -- must be REJECTED (NOCASE UC)
```

On `main`: the `ix_binary`-first order **admits** `'bob'` (BUG); the reverse
order rejects — confirming the order-sensitivity. SQLite and the store module
reject in both orders.

A one-line probe in `findIndexForConstraint` (resolve `uc.derivedFromIndex` by
name before the column-set scan) made **both** creation orders reject. The probe
was reverted; this ticket lands it properly with comments and tests.

## Root cause (confirmed)

`MemoryTableManager.findIndexForConstraint` (`manager.ts`, ~line 1008) resolves
the enforcing structure **by column-set**, returning the FIRST index in
`schema.indexes` whose columns match `uc.columns`:

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
(`index.specColumns[i]?.collation ?? declared`) AND generates candidates from
that index's BTree (keyed under the wrong collation). A coarser UNIQUE behind a
finer first index misses the duplicates it should catch.

The shared `uniqueEnforcementCollations(schema, uc)` helper (imported by
`quereus-store` and `quereus-isolation`) resolves **by name** via
`uc.derivedFromIndex` — each UC enforces under its OWN index. That is the correct
side; memory must match it.

## The fix

In `findIndexForConstraint`, when `uc.derivedFromIndex` is set, resolve the
secondary index **by that name** first; only fall through to the column-set scan
when the name does not resolve (defensive) or the UC is non-derived:

```ts
const schema = targetLayer.getSchema();
if (!schema.indexes) return undefined;

// An index-derived UNIQUE (CREATE UNIQUE INDEX) must enforce under ITS OWN index's
// collation. Resolve BY NAME via uc.derivedFromIndex — not the column-set scan
// below, which returns the FIRST same-column-set index and would enforce a
// coarser-declared UC under a finer first-listed index's collation. This matches
// the by-name resolution store/isolation use via uniqueEnforcementCollations.
if (uc.derivedFromIndex) {
  const index = targetLayer.getSecondaryIndex?.(uc.derivedFromIndex);
  if (index) return { kind: 'memory-index', index };
}

for (const idx of schema.indexes) { /* unchanged column-set fallback */ }
```

### Why by-name is sound for BOTH compare AND candidate generation

The ticket flagged that candidate generation (`index.getPrimaryKeys(indexKey)`),
not just the post-fetch `compareSqlValues`, must be sound. Resolving by name
returns the UC's OWN `MemoryIndex`, whose BTree is keyed under that index's own
collation (`MemoryIndex.createSingleColumnKeyFunctions` builds the comparator from
`specCol.collation`). So:

- a coarser NOCASE index buckets `'Bob'`/`'bob'` together → `getPrimaryKeys`
  returns both candidates → conflict found;
- a finer BINARY index keys them apart → candidates are exact byte-matches.

Both candidate set and final compare now use the UC's index — sound. Confirmed by
the probe run (both orders reject).

### Non-derived UCs keep the column-set fallback

Table-level / column UNIQUE has `derivedFromIndex` unset, so it falls through to
the column-set scan, which finds the auto-built `_uc_*` covering index carrying
the declared collation (built by `ensureUniqueConstraintIndexes`). That index is
collation-equivalent to the declared UC, so any same-column-set match is correct.
Do NOT change this branch.

## Comments & conformance lock to update (the gap is being closed, not documented)

The unify ticket documented this as a KNOWN gap in three places. Once the fix
lands the by-name/by-column-set paths AGREE for the multi-index shape, so the
"they diverge / pre-existing bug" prose must be retired:

- `manager.ts` `checkUniqueViaIndex` — the long comment block (~lines 1066–1078)
  ending "a pre-existing memory bug tracked by fix ticket
  memory-multi-index-unique-collation-resolution." Update it: `findIndexForConstraint`
  now resolves index-derived UCs by name, so the live `index` handle IS the UC's
  own index and `index.specColumns[i]?.collation` is the correct per-column
  collation even when multiple same-column-set indexes exist. Note that the
  `(schema, uc)` helper signature still can't hand back a live `MemoryIndex`, so
  this site keeps the live-handle read — but the two resolutions now agree on the
  multi-index shape too.
- `src/schema/unique-enforcement.ts` — the doc-comment (~lines 22–30) stating
  memory "can under-enforce a coarser-declared one … a pre-existing
  memory-enforcement bug." Reword to: memory now resolves the enforcing index by
  name (via `findIndexForConstraint`), so the two paths agree on this shape; the
  conformance lock covers it.
- `test/unique-enforcement-collation.spec.ts` — the file header (~lines 14–27)
  saying the paths "do NOT agree when two UNIQUE indexes cover the SAME
  column-set." This must flip. Critically, the test's `resolveLiveIndex` helper
  (~lines 59–70) mirrors the OLD by-column-set resolution — update it to mirror
  the NEW `findIndexForConstraint`: prefer `uc.derivedFromIndex` by name, then
  fall back to the column-set scan. Then add a multi-index-same-column-set shape
  to `SHAPES` (e.g. NOCASE column + `ix_binary (b collate binary)` +
  `ix_nocase (b collate nocase)`), asserting BOTH UCs resolve to their OWN index's
  collation in BOTH creation orders. (Two UCs share the column-set, so the shape
  needs `schema.uniqueConstraints` indexed beyond `[0]` — pick each UC by
  `derivedFromIndex` name rather than position.)

## Already-correct paths — cross-check only, do NOT change

- `checkUniqueViaMaterializedView` resolves collations via the by-name helper
  (`uniqueEnforcementCollations`) — already correct.
- The covering-MV eligibility gate `coveringMvHonorsIndexCollation` resolves the
  index by name — already correct.
- `findIndexForConstraint`'s `allowMvCovering` MV preference and the
  `enforceSecondaryUniqueOnMaintenance` (`allowMvCovering = false`) path are
  orthogonal to the index-name resolution — the fix sits AFTER the MV check, so
  both keep working. Verify the maintenance path still picks the auto-index for
  non-derived UCs (it will: those have no `derivedFromIndex`).

## Behavioral regression (runs under memory AND store)

Add a `§11` section to `test/logic/102.2-unique-collation.sqllogic` (it already
runs under both `yarn test` and `yarn test:store`, and §9 already exercises the
single index-derived shapes). Cover BOTH creation orders of two same-column-set
UNIQUE indexes with differing collation, asserting the coarser (NOCASE) UNIQUE
rejects a case-variant duplicate regardless of order, while the finer (BINARY)
UNIQUE keeps genuine byte-distinct variants apart. Store already passes both
orders, so this also pins memory↔store agreement.

## TODO

- [ ] Edit `findIndexForConstraint` in `manager.ts` to resolve `uc.derivedFromIndex`
      by name before the column-set scan (keep the column-set fallback for
      non-derived UCs and as a defensive path when the name does not resolve).
- [ ] Retire the KNOWN-gap prose in `checkUniqueViaIndex` (manager.ts) — the two
      resolution paths now agree on the multi-index shape.
- [ ] Update the doc-comment in `src/schema/unique-enforcement.ts` accordingly.
- [ ] Update `test/unique-enforcement-collation.spec.ts`: header prose +
      `resolveLiveIndex` helper (mirror by-name resolution) + add a
      multi-index-same-column-set shape asserting per-UC, per-order agreement.
- [ ] Add `§11` to `test/logic/102.2-unique-collation.sqllogic` covering both
      creation orders (coarser UC rejects; finer UC keeps byte-distinct apart).
- [ ] Run `yarn workspace @quereus/quereus test` (memory) and, since this touches
      a shared UNIQUE-enforcement path, `yarn workspace @quereus/quereus test:store`
      for the store path on `102.2-unique-collation.sqllogic`. Stream with
      `2>&1 | tee /tmp/t.log; tail -n 80 /tmp/t.log`.
- [ ] `yarn workspace @quereus/quereus lint` (also type-checks the spec call sites).
