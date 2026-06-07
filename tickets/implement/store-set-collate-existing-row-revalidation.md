description: Store ALTER COLUMN SET COLLATE — re-validate existing rows against UNIQUE constraints under the new per-column collation (Option A, non-PK)
prereq:
files:
  - packages/quereus-store/src/common/store-module.ts        # setCollation arm (~1063); validateUniqueOverExistingRows (~556); buildIndexEntries (~478)
  - packages/quereus/src/index.ts                             # add exports: resolveKeyNormalizer, serializeRowKey
  - packages/quereus/src/util/key-serializer.ts               # resolveKeyNormalizer / serializeRowKey (already implement collation-aware, NULL-skipping signatures)
  - packages/quereus/test/logic/41.7.1-alter-column-collate-unique.sqllogic  # pare down to PK-only sections 3+4 (stay memory-only)
  - packages/quereus/test/logic/41.7.2-alter-column-collate-unique-store.sqllogic  # NEW cross-module file: UNIQUE + CREATE UNIQUE INDEX sections
  - packages/quereus/test/logic.spec.ts                       # MEMORY_ONLY_FILES (~43) — keep 41.7.1; do NOT add 41.7.2
  - docs/sql.md                                               # §2.7 store-module note (~1332)
  - docs/schema.md                                            # store UNIQUE existing-row note (~432)
----

# Store `ALTER COLUMN … SET COLLATE` — existing-row UNIQUE re-validation (Option A)

## Decision (design is resolved — build exactly this)

Implement **Option A (validate-only)** scoped to **non-PK UNIQUE constraints**
(inline `UNIQUE` and `CREATE UNIQUE INDEX`-derived). At `SET COLLATE` time the store
full-scans existing rows and rejects with `CONSTRAINT` (schema unchanged) when the new
per-column collation introduces a duplicate in any UNIQUE constraint covering the
altered column. **PRIMARY KEY** columns are explicitly **out of scope** here and are
parked in the `store-set-collate-pk-physical-rekey` backlog ticket (Option B).

### Why this split is correct (not a punt)

- **Store write-time UNIQUE enforcement is already collation-aware.** Both
  `StoreTable.findUniqueConflict` and `findUniqueConflictViaCoveringMv` compare
  candidates with `compareSqlValues(newRow[c], other[c], schema.columns[c].collation)`.
  So once the *existing-row* re-validation honors the new collation, a UNIQUE column
  reaches **end-to-end** parity with memory: ALTER rejects pre-existing collisions, and
  new inserts are enforced under the new collation — no physical re-key required. The
  store's only gap was the existing-row scan, which uses a value-exact (BINARY)
  `JSON.stringify(values)` signature.

- **The PK case genuinely requires Option B.** The store encodes PK (and physical
  index) key bytes under a single **fixed table-level collation**
  (`StoreTable.encodeOptions = { collation: config.collation || 'NOCASE' }`), *not* the
  per-column collation. PK uniqueness is enforced purely physically (`store.get(key)`),
  so a per-column collation that differs from the table key collation is neither
  enforced on new inserts nor re-validatable by re-encoding without a full physical
  re-key. Under the default `NOCASE` table encoding the BINARY-distinct/NOCASE-colliding
  PK fixtures (`insert into pkc values ('a'),('A')`) cannot even coexist in the store.
  Filtering re-validation to `uniqueConstraints` (which never contains the PK —
  the PK lives in `primaryKeyDefinition`) naturally excludes PK columns; a PK-only
  column's `SET COLLATE` stays schema-only, exactly today's behavior.

## Architecture

### Collation-aware existing-row signature

`packages/quereus/src/util/key-serializer.ts` already provides exactly the primitive
needed and it is **tested core code** — reuse it rather than hand-rolling normalization:

- `resolveKeyNormalizer(collationName)` → a string normalizer for `BINARY`/`NOCASE`/`RTRIM`.
- `serializeRowKey(row, columnIndices, normalizers)` → a type-tagged composite signature
  that **returns `null` if any indexed value is NULL** — which is precisely the SQL
  UNIQUE "multiple NULLs allowed" rule (skip the row), so it drops in for the existing
  `values.some(v => v === null)` guard.

Neither is currently exported from `@quereus/quereus`. **Add both to
`packages/quereus/src/index.ts`** (export alongside the other `util/` re-exports);
`compareSqlValues` is already exported from there for reference.

Build per-column normalizers from the column collations so a **composite** UNIQUE
constraint normalizes each member by its own collation (only the altered column's
changed):

```ts
const normalizers = uc.columns.map(idx => resolveKeyNormalizer(tableSchema.columns[idx].collation));
// per row:
const sig = serializeRowKey(row, uc.columns, normalizers);   // null ⇒ a NULL member ⇒ never a dup
if (sig === null) continue;
if (seen.has(sig)) throw /* CONSTRAINT */;
seen.add(sig);
```

> **Residual limitation (document, don't fix):** `resolveKeyNormalizer` only knows the
> built-in `BINARY`/`NOCASE`/`RTRIM`; a *custom* comparator-only collation falls back to
> identity (BINARY) for the Set-dedup, so ALTER-time re-validation can under-reject for
> custom collations even though write-time enforcement (via the comparator) is exact.
> This matches the existing existing-row scans' behavior and the realistic scope
> (`NOCASE`). An optional later enhancement is to prefer a normalizer registered on the
> db collation registry (`Database.registerCollation` already accepts a `normalizer`)
> before falling back. Note it in the doc updates; do not block on it.

### Make the existing existing-row scans collation-aware

Both store existing-row UNIQUE dedup scans share the BINARY `JSON.stringify` pattern and
the docs explicitly couple them ("matching the store's `CREATE UNIQUE INDEX` path").
Convert **both** to the collation-aware signature so the store's existing-row UNIQUE
checks are uniformly per-column-collation honoring:

- `validateUniqueOverExistingRows(dataStore, tableSchema, uc)` — used by `ADD CONSTRAINT
  UNIQUE` and (new) by `SET COLLATE`. Swap the `seen` signature to `serializeRowKey` with
  per-column normalizers from `tableSchema.columns[idx].collation`. Keep the partial
  `predicate` handling and the NULL-skip (now via the `null` signature) intact.
- `buildIndexEntries(...)` in-pass dup check (the `CREATE UNIQUE INDEX` path) — same swap,
  drawing the collation from `indexSchema.columns[i].collation ?? tableSchema.columns[col.index].collation`.

This is a strict correctness improvement (write-time already honors collation), so
`ADD CONSTRAINT UNIQUE` / `CREATE UNIQUE INDEX` over NOCASE-colliding rows on a NOCASE
column now correctly reject. Run `yarn test:store` to confirm no existing store test
depended on the old BINARY-only behavior.

### New: re-validation in the `setCollation` arm

In `store-module.ts` `alterTable` → `case 'alterColumn'` → `setCollation` branch
(currently schema-only at ~1063): after computing `newCol` and the candidate
`updatedSchema` (with the new collation on `columns[colIndex]`), but **before**
`table.updateSchema(updatedSchema)` / `saveTableDDL(...)`:

1. **No-op guard:** if the normalized new collation equals the old
   (`oldCol.collation || 'BINARY'`), skip the scan entirely (mirror the memory module's
   early return). Preserves the cheap schema-only path.
2. **Scope:** collect `uniqueConstraints` entries whose `columns` include `colIndex`. If
   none, keep today's schema-only behavior (no scan). The PK is intentionally excluded
   (it is not in `uniqueConstraints`).
3. **Validate under the NEW collation:** for each such `uc`, call
   `validateUniqueOverExistingRows(dataStore, updatedSchema, uc)` — passing
   **`updatedSchema`** (not `oldSchema`) so the per-column normalizer reads the new
   collation. The first collision throws `CONSTRAINT` before any mutation, leaving the
   table unchanged and writable (matches the existing `ADD CONSTRAINT` rollback shape).
   Get the data store via `this.getStore(tableKey, table.getConfig())`, as `addConstraint`
   does.

Order: validate → `updateSchema` → `saveTableDDL` → emit event. A throw in step 3 must
precede every mutation/persist call.

## Tests

Restructure so the store gains coverage without losing memory coverage. The PK sections
stay memory-only (Option B territory); the UNIQUE/index sections become cross-module.

- **Create `41.7.2-alter-column-collate-unique-store.sqllogic`** (NOT added to
  `MEMORY_ONLY_FILES`, so it runs in both memory and store modes). Move into it the four
  UNIQUE/index sections currently in `41.7.1`:
  - §1 inline UNIQUE, distinct under both collations → ALTER succeeds; subsequent
    `A@X` insert rejected under NOCASE; distinct value still inserts.
  - §2 inline UNIQUE, distinct under BINARY but colliding under NOCASE → ALTER rejected
    with `UNIQUE constraint failed`; rollback (both rows survive, `table_info` collation
    still `BINARY`, table still writable).
  - §5 `CREATE UNIQUE INDEX`, colliding under NOCASE → ALTER rejected + rollback; index
    keeps enforcing under the original collation.
  - §6 `CREATE UNIQUE INDEX`, distinct under both → ALTER succeeds; index then enforces
    under NOCASE.
  Expected store behavior is identical to memory for all four (the UNIQUE column is row
  *data* keyed by the integer PK, so the fixed-table-collation key encoding is irrelevant
  here).
- **Pare `41.7.1-alter-column-collate-unique.sqllogic`** down to the PK sections §3
  (PK colliding under NOCASE → ALTER rejected) and §4 (PK distinct → ALTER succeeds +
  later NOCASE-colliding PK insert rejected). Keep it in `MEMORY_ONLY_FILES`. Update its
  header to explain the store-PK deferral and point at `store-set-collate-pk-physical-rekey`.
- `logic.spec.ts` `MEMORY_ONLY_FILES`: keep `41.7.1`; **do not** list `41.7.2`. Update the
  inline comment to note 41.7.1 is now PK-only.

Validate with: `yarn test` (memory — both 41.7.x run) and
`yarn workspace @quereus/quereus run test` under store mode
(`QUEREUS_TEST_STORE=1`, i.e. `yarn test:store`) so 41.7.2 exercises the store path.
Stream output (`… 2>&1 | tee /tmp/t.log; tail -n 80 /tmp/t.log`) — never silent-redirect.

## Edge cases & interactions

- **No-op SET COLLATE** (new == current, including `BINARY`→`BINARY`): no scan, no error,
  no persist beyond today's behavior.
- **Column in no UNIQUE constraint** (incl. PK-only column): schema-only, no scan — today's
  behavior preserved.
- **Column in multiple UNIQUE constraints:** validate each; first collision throws.
- **Composite UNIQUE** where the altered column is one of several: signature normalizes
  *each* member by its own column collation (only the altered one changed) — drives the
  per-column-normalizers requirement.
- **Partial UNIQUE (`WHERE`)**: only predicate-TRUE rows count — `validateUniqueOverExistingRows`
  already compiles and honors `uc.predicate`; preserve it.
- **NULLs in the column:** multiple NULLs never collide — `serializeRowKey` returns `null`
  for any NULL member, so those rows are skipped.
- **Empty / single-row table:** no collision possible; ALTER succeeds.
- **Index-derived UNIQUE (`CREATE UNIQUE INDEX`)**: re-validated via its `uniqueConstraints`
  entry (`derivedFromIndex`). The physical index store key bytes are **not** re-encoded
  (Option A) — write-time enforcement is the logical `checkUniqueConstraints` scan, which
  is collation-aware, so this is correct; physical index order remains table-collation
  encoded (pre-existing, covered by 41.7 passing under store).
- **Rollback atomicity:** a `CONSTRAINT` throw must occur before `updateSchema`/`saveTableDDL`
  so the table is unchanged, still writable, and `table_info().collation` still reports the
  old collation (asserted by §2/§5).
- **In-transaction ALTER:** the new scan iterates the data store the same way
  `addConstraint` does (committed data via `getStore`). Confirm `SET COLLATE` inside an
  open transaction behaves consistently with `ADD CONSTRAINT UNIQUE` in the same situation
  (neither flushes the coordinator before scanning); if `addConstraint` is correct under
  the isolation layer, mirroring it is correct. Do not add bespoke flush logic unless a
  test shows divergence.
- **PK + UNIQUE on the same column:** the UNIQUE part is re-validated; the PK part is not
  (deferred). Acceptable — the UNIQUE re-validation already rejects any collision that
  would also be a PK collision on that column.

## TODO

- Export `resolveKeyNormalizer` and `serializeRowKey` from `packages/quereus/src/index.ts`.
- Convert `validateUniqueOverExistingRows` to the collation-aware `serializeRowKey`
  signature (per-column normalizers from `tableSchema.columns[idx].collation`).
- Convert the `buildIndexEntries` in-pass UNIQUE dup check to the same signature
  (collation from `indexSchema.columns[i].collation ?? tableSchema.columns[col.index].collation`).
- Add existing-row UNIQUE re-validation to the `setCollation` arm (no-op guard → collect
  covering `uniqueConstraints` → `validateUniqueOverExistingRows(dataStore, updatedSchema, uc)`
  before any mutation).
- Create `41.7.2-alter-column-collate-unique-store.sqllogic` with the four UNIQUE/index
  sections; pare `41.7.1` to the two PK sections and update its header.
- Update `MEMORY_ONLY_FILES` comment in `logic.spec.ts` (41.7.1 now PK-only; 41.7.2 not listed).
- Update `docs/sql.md` §2.7 store-module note and `docs/schema.md` store UNIQUE
  existing-row note: store now re-validates non-PK UNIQUE under the new per-column
  collation at `SET COLLATE` (and `ADD CONSTRAINT` / `CREATE UNIQUE INDEX` existing-row
  checks honor per-column collation); PK physical re-key remains deferred
  (`store-set-collate-pk-physical-rekey`). Note the custom-collation residual limitation.
- Run `yarn test` and `yarn test:store`; stream output. If a failure is clearly
  pre-existing/unrelated, follow the `.pre-existing-error.md` flow.
