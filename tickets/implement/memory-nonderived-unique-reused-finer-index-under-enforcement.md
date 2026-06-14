description: Memory under-enforces a NON-derived (table-level / column) UNIQUE when a FINER same-column-set `CREATE UNIQUE INDEX` already exists when the constraint is realized — the constraint is reused-onto that finer index, so DML enforces under the index's collation instead of the column's declared collation. Fix is in the memory module only (store is already correct): stop reusing a collation-mismatched same-column-set index, and resolve a non-derived UC to its OWN realizing `_uc_*` structure instead of the first column-set match.
prereq:
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts                  # addUniqueConstraint reuse (~2385), ensureUniqueConstraintIndexes reuse (~162), findIndexForConstraint non-derived scan (~1037)
  - packages/quereus/src/schema/unique-enforcement.ts                  # uniqueEnforcementCollations: non-derived ⇒ declared collation (reference; do NOT change)
  - packages/quereus/src/util/comparison.ts                            # normalizeCollationName (for the collation-equivalence guard)
  - packages/quereus-store/src/common/store-module.ts                  # addConstraint UNIQUE arm (~1185) — already correct (no reuse); reference only
  - packages/quereus/test/logic/102.2-unique-collation.sqllogic        # add §12 (both creation orders; runs under memory AND store)
  - packages/quereus/test/unique-enforcement-collation.spec.ts         # add non-derived + finer-same-column-set-index shape; update resolveLiveIndex helper to mirror the new resolution
difficulty: medium
----

# Fix: non-derived UNIQUE under-enforces when realized by a pre-existing finer same-column-set index

## Reproduced (confirmed)

```sql
create table t (id integer primary key, b text collate nocase);
create unique index ix_binary on t (b collate binary);   -- FINER than declared, created first
alter table t add constraint uq unique (b);              -- non-derived NOCASE UNIQUE
insert into t values (1, 'Bob');
insert into t values (2, 'bob');   -- ADMITTED (count=2) under memory — must be REJECTED (NOCASE UNIQUE)
```

A prior-run throwaway spec confirmed `count = 2`, second insert admitted, under the **memory**
module. The mirror DDL order (`create table … unique (b)` first, THEN
`create unique index ix_binary`) already enforces correctly. So the bug is **order-sensitive**
and survives the sibling fix `memory-multi-index-unique-collation-resolution` (that fix only
rerouted *derived* UCs by `uc.derivedFromIndex`; this is a **non-derived** UC). SQLite and the
store module reject the second insert.

## Root cause (memory module; three reinforcing spots)

The repro's `ALTER TABLE … ADD CONSTRAINT … UNIQUE (b)` flows through **`addUniqueConstraint`**
(manager.ts ~2385), NOT `ensureUniqueConstraintIndexes`. Both share the same collation-blind
reuse, and `findIndexForConstraint` then mis-resolves even after a correct index exists:

1. **`addUniqueConstraint` (~2385)** — reuses any matching *unique* same-column-set index as the
   constraint's realizing structure **regardless of collation**:

   ```ts
   const matchingUniqueIndex = existingIndexes.find(idx =>
       idx.unique &&
       idx.columns.length === uc.columns.length &&
       idx.columns.every((col, i) => col.index === uc.columns[i]));
   if (matchingUniqueIndex) { /* register ix_binary as the covering structure; no _uc_b built */ }
   ```

   Reusing `ix_binary` (BINARY) means no `_uc_b` carrying the declared NOCASE collation is built,
   and `implicitCoveringStructures` points the constraint at `ix_binary`.

2. **`ensureUniqueConstraintIndexes` (~162)** — the constructor/rebuild path — reuses **any**
   matching same-column-set index (unique or not) with the same collation-blindness. Reached when
   a manager is reconstructed from a schema that already carries both the index and the constraint
   (e.g. `rebuildMemoryTable`), so the same under-enforcement is reachable without the ALTER path.

3. **`findIndexForConstraint` (~1037)** — for a non-derived UC (`derivedFromIndex` unset) the
   column-set scan returns the **first** same-column-set index. Even after a realization fix builds
   `_uc_b` alongside `ix_binary`, `ix_binary` is earlier in `schema.indexes` (created first), so the
   scan still returns it. `checkUniqueViaIndex` then compares under `index.specColumns[i].collation`
   (BINARY) and generates candidates from the BINARY-keyed BTree — the NOCASE duplicate is neither
   found nor bucketed.

Meanwhile `uniqueEnforcementCollations(schema, uc)` (unique-enforcement.ts) returns the **declared**
collation (NOCASE) for a non-derived UC. So memory's live-index path diverges from the shared
helper for this shape — exactly the divergence the `unique-enforcement-collation.spec.ts`
conformance lock is meant to catch, but no current shape exercises a non-derived UC sharing a
column-set with a differently-collated index.

## Store is already correct (no code change)

`store-module.ts` `addConstraint` UNIQUE arm (~1185) does **not** reuse any index — it calls
`validateUniqueOverExistingRows` and appends the UC; enforcement is a full-scan through
`uniqueEnforcementCollations` (declared collation for a non-derived UC). It rejects the second
insert. The fix is memory-only; store needs only the new test shape (added via 102.2 §12, which
runs under both modules).

## Fix approach (realization + resolution; both required)

**Realization** — in BOTH `addUniqueConstraint` and `ensureUniqueConstraintIndexes`, only reuse a
same-column-set index when its per-column collations are **collation-equivalent to the
constraint's declared collations**; otherwise build the distinct `_uc_*` (declared-collation)
covering index, letting the user index coexist as an independent constraint (matches SQLite, where
both indexes enforce). The equivalence test per column `i` (positions aligned because the
column-set matches):

```ts
normalizeCollationName(idx.columns[i].collation ?? columns[uc.columns[i]]?.collation)
  === normalizeCollationName(columns[uc.columns[i]]?.collation)
```

(A plain index with no explicit COLLATE has `idx.columns[i].collation === undefined`, so it falls
back to the declared collation and remains reuse-safe — the common case is unaffected.)
`normalizeCollationName` is in `util/comparison.ts`; it is not yet imported into manager.ts.

**Resolution** — in `findIndexForConstraint`, for a non-derived UC, resolve to the constraint's
**own** realizing structure by name via `implicitCoveringStructures`
(`getImplicitCoveringStructure(uc)` / `this.implicitCoveringStructures.get(uc.name ?? implicitIndexNameFor(uc))?.indexName`),
fetch that index by name, and fall back to the column-set scan only when the name does not resolve
(defensive). This makes resolution robust to `schema.indexes` ordering once the realization fix has
built `_uc_b`.

Both are needed: realization alone leaves `findIndexForConstraint` returning the earlier-listed
`ix_binary`; resolution alone has no NOCASE structure to find if reuse already collapsed onto the
finer index.

## Expected behavior

A non-derived (table-level / column) UNIQUE always enforces under its **declared column collation**,
independent of any user index over the same column-set and independent of DDL order. After the fix,
`'Bob'` then `'bob'` on a NOCASE-column `unique (b)` rejects the second insert; the user's
BINARY `ix_binary` continues to enforce its own (stricter) uniqueness; memory and store agree;
SQLite parity.

## Notes / edge cases for the implementer

- **DROP/RENAME CONSTRAINT lifecycle:** with reuse removed, a named constraint builds its own
  index (named after the constraint), so `dropConstraint` / `renameConstraint` (which match by
  `uc.name ?? implicitIndexNameFor(uc)`) tear down only the constraint's own index and leave the
  user index untouched — the prior "reused index name doubles as the realizing name" ambiguity goes
  away. Verify a `drop constraint uq` after the fix leaves `ix_binary` intact.
- **Conformance lock:** `unique-enforcement-collation.spec.ts`'s `resolveLiveIndex` helper currently
  mirrors `findIndexForConstraint` (column-set scan for non-derived). Update it to mirror the new
  realizing-structure-name resolution so the lock keeps matching the source path, then add the
  non-derived + finer-same-column-set-index shape (both creation orders) and assert per-column
  output equals `uniqueEnforcementCollations` (declared NOCASE).
- **Named-constraint name collision** (a pre-existing user index already named like the constraint)
  is an out-of-scope edge; don't expand scope, but don't regress it either.
- Confirm the covering-MV path is unaffected: this shape has no MV, and the MV eligibility gate
  (`coveringMvHonorsIndexCollation`) is keyed off the declared collation already.

## TODO

- [ ] Add a collation-equivalence guard to the `matchingUniqueIndex` reuse in
      `addUniqueConstraint` (manager.ts ~2385): reuse only when every reused-index per-column
      collation normalizes equal to the declared column collation; else fall through to build the
      `_uc_*` covering index (existing build-and-validate branch).
- [ ] Add the same guard to the `matchingIndex` reuse in `ensureUniqueConstraintIndexes`
      (manager.ts ~162); factor the per-column equivalence test into a small shared private helper
      (e.g. `indexCollationsMatchDeclared(idx, uc)`), import `normalizeCollationName` from
      `util/comparison.js`.
- [ ] In `findIndexForConstraint` (manager.ts ~1037), for a non-derived UC resolve the realizing
      structure by name via `implicitCoveringStructures` before the column-set scan; keep the scan
      as the defensive fallback.
- [ ] Update `resolveLiveIndex` in `unique-enforcement-collation.spec.ts` to mirror the new
      non-derived resolution, and add a non-derived-UC + finer-same-column-set-index shape (both
      creation orders) to the conformance suite.
- [ ] Add §12 to `102.2-unique-collation.sqllogic` covering both DDL orders (index-first /
      constraint-first), the BINARY index still enforcing its own uniqueness, and a non-NOCASE-equal
      value still inserting (guard against over-matching). It runs under memory (`yarn test`) AND
      store (`yarn test:store`).
- [ ] Verify `drop constraint uq` after the fix leaves the user's `ix_binary` intact (lifecycle
      regression check — sqllogic assertion or spec).
- [ ] Run `yarn test` (memory) and `yarn workspace @quereus/quereus run lint`; spot-check the new
      §12 under `yarn test:store` if time permits (store is expected green unchanged).
