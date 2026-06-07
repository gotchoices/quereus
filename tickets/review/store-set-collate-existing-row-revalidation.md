description: Review — Store ALTER COLUMN SET COLLATE re-validates existing rows against non-PK UNIQUE constraints under the new per-column collation (Option A); existing-row UNIQUE scans made collation-aware
prereq:
files:
  - packages/quereus/src/index.ts                              # NEW exports: resolveKeyNormalizer, serializeRowKey (~179)
  - packages/quereus-store/src/common/store-module.ts          # buildIndexEntries dup-check (~488); validateUniqueOverExistingRows (~556); setCollation arm (~1082) + re-validation block (~1109)
  - packages/quereus/test/logic/41.7.1-alter-column-collate-unique.sqllogic        # pared to PK-only (memory)
  - packages/quereus/test/logic/41.7.2-alter-column-collate-unique-store.sqllogic  # NEW cross-module UNIQUE + CREATE UNIQUE INDEX
  - packages/quereus/test/logic.spec.ts                        # MEMORY_ONLY_FILES comment (~43)
  - docs/sql.md                                                # §2.7 SET COLLATE store-module note (~1332)
  - docs/schema.md                                             # store UNIQUE existing-row note (~432)
  - tickets/.pre-existing-error.md                             # flags a pre-existing store-mode failure (unrelated)
----

# Review: Store `ALTER COLUMN … SET COLLATE` existing-row UNIQUE re-validation (Option A)

## What was built

Implemented **Option A (validate-only)** scoped to **non-PK UNIQUE** (inline `UNIQUE`
and `CREATE UNIQUE INDEX`-derived). At `SET COLLATE` time the store now full-scans
existing rows and rejects with `CONSTRAINT` (schema unchanged) when the new per-column
collation introduces a duplicate in any UNIQUE constraint covering the altered column.
PRIMARY KEY columns remain out of scope (deferred to backlog
`store-set-collate-pk-physical-rekey`, Option B) — they never appear in
`uniqueConstraints`, so filtering to that set naturally excludes them.

Three code changes in `store-module.ts`, plus two new exports it consumes:

1. **Exports** (`packages/quereus/src/index.ts`): `resolveKeyNormalizer` and
   `serializeRowKey` from `util/key-serializer.ts` (already tested core helpers).
2. **`validateUniqueOverExistingRows`**: swapped the value-exact `JSON.stringify(values)`
   signature for `serializeRowKey(row, uc.columns, normalizers)` with one normalizer per
   constrained column from `tableSchema.columns[idx].collation`. NULL-skip now via the
   `null` return; partial `predicate` preserved. Used by `ADD CONSTRAINT UNIQUE` (validate
   under current collation) and by the new `SET COLLATE` path (validate under the NEW
   collation by passing `updatedSchema`).
3. **`buildIndexEntries`** in-pass UNIQUE dup check (`CREATE UNIQUE INDEX` /
   `alterPrimaryKey` rebuild / `createIndex`): same swap, collation from
   `col.collation ?? tableSchema.columns[col.index].collation`.
4. **`setCollation` arm**: no-op guard (`normalized === (oldCol.collation || 'BINARY')` →
   `return oldSchema`, no scan/persist); after building `updatedSchema`, if the collation
   changed, collect `uniqueConstraints` covering `colIndex` and run
   `validateUniqueOverExistingRows(dataStore, updatedSchema, uc)` for each — **before**
   `updateSchema`/`saveTableDDL`/event, so a collision leaves the table unchanged and
   writable. Data store obtained via `this.getStore(tableKey, table.getConfig())` (same as
   `addConstraint`).

This brings non-PK UNIQUE to **end-to-end parity** with memory: write-time enforcement
(`findUniqueConflict[ViaCoveringMv]` via `compareSqlValues(..., columns[c].collation)`)
was already collation-aware; the only gap was the existing-row scan, now closed. The
`ADD CONSTRAINT UNIQUE` and `CREATE UNIQUE INDEX` existing-row checks are improved as a
side effect (they previously used BINARY-only `JSON.stringify`).

## Validation performed

- **Build:** `yarn workspace @quereus/quereus run build` and
  `yarn workspace @quereus/store run build` — both clean (tsc, exit 0).
- **Lint:** `yarn lint` in `packages/quereus` — clean (exit 0). (store package has no lint script.)
- **Memory (`node test-runner.mjs --no-bail`):** 5190 passing, 9 pending, **0 failing**.
- **Store (`node test-runner.mjs --store --no-bail`):** 5184 passing, 14 pending,
  **1 failing** — the failure is the **pre-existing** `50-metadata-tags.sqllogic`
  (`Index 'uq_expo_vin' not found`, an exposed-implicit-index tag path in
  `SchemaManager.updateIndexTags`), proven to reproduce on a clean `git stash` baseline.
  See `tickets/.pre-existing-error.md`. The pending delta (store 14 − memory 9 = 5) equals
  the 5 active `MEMORY_ONLY_FILES`, confirming `41.7.1` is skipped and `41.7.2` runs under
  the store.
- **Targeted (`--grep "41.7"`):** memory 3 passing; store 2 passing + 1 pending (41.7.1).

### Use cases the tests cover (the floor — extend, don't trust as ceiling)

`41.7.2-…-store.sqllogic` (runs in BOTH memory and store):
- §1 inline UNIQUE distinct under both collations → ALTER succeeds; later `A@X` rejected
  under NOCASE; a distinct value still inserts.
- §2 inline UNIQUE distinct under BINARY / colliding under NOCASE → ALTER rejected,
  rollback (both rows survive, `table_info` collation still BINARY, table still writable).
- §3 `CREATE UNIQUE INDEX` colliding under NOCASE → ALTER rejected + rollback; index keeps
  enforcing under the original collation.
- §4 `CREATE UNIQUE INDEX` distinct under both → ALTER succeeds; index then enforces NOCASE.

`41.7.1-…-unique.sqllogic` (memory-only): PK colliding → rejected; PK distinct → succeeds
then NOCASE-colliding PK insert rejected.

## Known gaps / where to look hardest

- **Custom comparator-only collations under-reject at ALTER time (by design, Option A
  scope).** `resolveKeyNormalizer` only knows built-in `BINARY`/`NOCASE`/`RTRIM`; a custom
  collation falls back to identity (BINARY) for the Set dedup, so ALTER/ADD-time
  re-validation can miss collisions that write-time enforcement (via the registered
  comparator) would catch. Documented in both docs. **Not tested** (no custom-collation
  fixture). The ticket noted an optional later enhancement: prefer a normalizer registered
  on the db collation registry (`Database.registerCollation` accepts a `normalizer`) before
  the BINARY fallback — left for a follow-up.
- **In-transaction `SET COLLATE`.** The new scan reads committed data via `getStore`,
  exactly like `addConstraint` (no coordinator flush). I did **not** add a dedicated test
  for `SET COLLATE` inside an open transaction; the ticket said not to add bespoke flush
  logic unless a test shows divergence, and the full store suite (which includes the
  isolation layer) is green. A reviewer wanting belt-and-suspenders could add a
  store-mode test that opens a transaction, inserts a NOCASE-colliding row, and SET COLLATEs
  — to confirm behavior matches `ADD CONSTRAINT UNIQUE` in the same situation.
- **`buildIndexEntries` collation source vs write-time.** The physical index dedup uses
  `col.collation ?? table-column collation` (per the ticket), while write-time UNIQUE
  enforcement for a *derived* constraint uses the table-column collation. These differ
  only for a `CREATE UNIQUE INDEX (col COLLATE X)` whose explicit X differs from the table
  column — an untested edge (no fixture). Strictly more correct than the prior BINARY-only
  behavior either way.
- **PK case is genuinely deferred, not punted** — Option B (`store-set-collate-pk-physical-rekey`).
  A PK-only column's `SET COLLATE` on the store stays schema-only (correct for Option A).
  A column that is *both* PK and UNIQUE has its UNIQUE part re-validated, PK part not.

## Suggested reviewer spot-checks

- Confirm the no-op guard (`BINARY`→`BINARY`, or new == current) truly skips scan AND
  persist (`return oldSchema`), matching memory's early return.
- Confirm rollback atomicity: the `CONSTRAINT` throw precedes `updateSchema`/`saveTableDDL`
  (it does — the validation block sits between `updatedSchema` construction and the
  mutation calls).
- Composite UNIQUE where only one member's collation changes: each member normalized by its
  own column collation (no fixture today — candidate for an added case).
- Whether the pre-existing `50-metadata-tags` store failure warrants its own fix/backlog
  ticket (the runner's triage pass should pick up `.pre-existing-error.md`).
