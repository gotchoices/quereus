description: Store ALTER COLUMN SET COLLATE re-validates existing rows against non-PK UNIQUE constraints under the new per-column collation (Option A); existing-row UNIQUE scans made collation-aware. Reviewed and completed.
files:
  - packages/quereus/src/index.ts                              # exports: resolveKeyNormalizer, serializeRowKey (~181)
  - packages/quereus-store/src/common/store-module.ts          # buildIndexEntries dup-check (~493); validateUniqueOverExistingRows (~570); setCollation arm (~1082) + re-validation block (~1109)
  - packages/quereus/test/logic/41.7.1-alter-column-collate-unique.sqllogic        # PK-only (memory)
  - packages/quereus/test/logic/41.7.2-alter-column-collate-unique-store.sqllogic  # cross-module UNIQUE + CREATE UNIQUE INDEX (+ composite/partial/NULL/no-op added in review)
  - packages/quereus/test/logic.spec.ts                        # MEMORY_ONLY_FILES (~43)
  - docs/sql.md                                                # §2.7 SET COLLATE store-module note (~1332)
  - docs/schema.md                                             # store UNIQUE existing-row note (~432)
----

# Store `ALTER COLUMN … SET COLLATE` existing-row UNIQUE re-validation (Option A) — COMPLETE

## What was built (implement stage)

Implemented **Option A (validate-only)** scoped to **non-PK UNIQUE** (inline `UNIQUE` and
`CREATE UNIQUE INDEX`-derived). At `SET COLLATE` time the store full-scans existing rows
and rejects with `CONSTRAINT` (schema unchanged) when the new per-column collation
introduces a duplicate in any UNIQUE constraint covering the altered column. PRIMARY KEY
columns remain out of scope (deferred to `blocked/store-set-collate-pk-physical-rekey`,
Option B) — they never appear in `uniqueConstraints`, so filtering to that set naturally
excludes them.

Three code changes in `store-module.ts`, plus two new exports it consumes:

1. **Exports** (`index.ts`): `resolveKeyNormalizer`, `serializeRowKey` from `util/key-serializer.ts`.
2. **`validateUniqueOverExistingRows`**: swapped value-exact `JSON.stringify(values)` for
   `serializeRowKey(row, uc.columns, normalizers)` with one normalizer per constrained
   column from `tableSchema.columns[idx].collation`. NULL-skip via the `null` return;
   partial `predicate` preserved. Used by `ADD CONSTRAINT UNIQUE` (current collation) and
   by `SET COLLATE` (NEW collation via `updatedSchema`).
3. **`buildIndexEntries`** in-pass UNIQUE dup check: same swap, collation from
   `col.collation ?? tableSchema.columns[col.index].collation`.
4. **`setCollation` arm**: no-op guard (`normalized === (oldCol.collation || 'BINARY')` →
   `return oldSchema`); after building `updatedSchema`, if the collation changed, collect
   `uniqueConstraints` covering `colIndex` and validate each — **before** the
   `updateSchema`/`saveTableDDL`/event, so a collision leaves the table unchanged and writable.

This brings non-PK UNIQUE to end-to-end parity with memory; write-time enforcement was
already collation-aware. `ADD CONSTRAINT UNIQUE` / `CREATE UNIQUE INDEX` existing-row checks
are improved as a side effect (previously BINARY-only `JSON.stringify`).

## Review findings

### Scope of the review
Read the full implement diff (`04f3af94`) before the handoff, plus the consumed helper
(`util/key-serializer.ts`), the write-time enforcement it claims parity with
(`store-table.ts` `findUniqueConflict[ViaCoveringMv]`), the memory-module counterpart
(`memory/layer/manager.ts` setCollation arm), `appendIndexToTableSchema`, both doc sections,
and both test fixtures. Lint + full memory + full store suites run.

### Correctness — no defects found
- **Rollback ordering** (major risk if wrong): the `CONSTRAINT` throw sits strictly between
  `updatedSchema` construction and `updateSchema`/`saveTableDDL`/event — verified by source
  and by tests §2/§3/§6b (table unchanged, collation still BINARY, still writable).
- **No-op guard**: `normalized === (oldCol.collation || 'BINARY')` returns `oldSchema` with
  no scan and no re-persist; matches memory's early return. `validateCollationForType`
  returns the canonical name, so the comparison is well-formed. Now covered by §8.
- **PK exclusion is sound**: PK columns never land in `uniqueConstraints`
  (`appendIndexToTableSchema` only derives UNIQUE constraints from unique *indexes*; PK is
  `primaryKeyDefinition`), so the `.filter(uc => uc.columns.includes(colIndex))` cannot
  accidentally re-validate (or skip-and-corrupt) a PK. The genuinely-deferred PK case is
  tracked in `blocked/store-set-collate-pk-physical-rekey`.
- **CREATE UNIQUE INDEX coverage**: confirmed `appendIndexToTableSchema` adds a
  `derivedFromIndex` entry to `uniqueConstraints`, so the re-validation loop covers explicit
  unique indexes — that is *how* §3/§4 pass, not an untested assumption.
- **Type safety**: the `indexNormalizers!` non-null assertion (line ~522) is guarded by
  `if (seen)`, and `indexNormalizers` is built `seen ? … : undefined` — sound.
- **`getStore` handle**: reused exactly as `addConstraint` does (cached managed handle, no
  per-call close); consistent, no leak introduced.
- **bigint robustness**: the new `serializeRowKey` path is strictly *more* robust than the
  old `JSON.stringify` — the latter throws on a bigint constrained value; the former tags it
  `b:`. (Residual theoretical note below.)

### Test coverage — gap found and fixed inline (minor)
The implement fixtures (`41.7.2`) covered the inline-UNIQUE and CREATE-UNIQUE-INDEX happy/
reject paths but left four behaviors the new code explicitly implements untested. Added as
cross-module sections (run in BOTH memory and store) to `41.7.2-…-store.sqllogic`:
- **§5 composite UNIQUE `(a,b)`** where only member `a`'s collation changes — proves each
  member is normalized by its *own* column collation (5a: `a` collision under NOCASE rejects;
  5b: still-BINARY `b` keeps distinguishing, ALTER succeeds, then enforces correctly).
- **§6 partial UNIQUE index** (`… where active = 1`) — both directions: 6a a collision among
  *excluded* rows must NOT block the ALTER; 6b a collision among *included* rows must. Proves
  the `predicate` is honored on the SET COLLATE path.
- **§7 NULL handling** — multiple NULLs survive the re-validation scan (no false collision);
  required a nullable `text null` column (engine defaults columns to NOT NULL).
- **§8 no-op guard** — re-applying NOCASE when already NOCASE is idempotent and still enforces.

### Documentation — verified accurate, no changes needed
`docs/sql.md` §2.7 and `docs/schema.md` named-constraint section already describe the non-PK
scope, the shared `serializeRowKey` signature across SET COLLATE / ADD CONSTRAINT UNIQUE /
CREATE UNIQUE INDEX, the PK deferral, and the custom-collation residual. Both read true
against the final code.

### Known residual limitations (by design, documented, NOT defects)
- **Custom comparator-only collations under-reject at ALTER/ADD time**: `resolveKeyNormalizer`
  knows only built-in `BINARY`/`NOCASE`/`RTRIM`; a custom collation falls back to identity for
  the dedup Set, so the existing-row scan can miss a collision that write-time enforcement (via
  the registered comparator) would catch. Documented in both docs. Optional future enhancement:
  prefer a normalizer registered on the db collation registry before the BINARY fallback.
- **number/bigint cross-type equivalence**: `serializeRowKey` tags `n:` vs `b:`, while
  `compareSqlValues` treats numeric `5` and `5n` as equal — a theoretical under-reject if a
  single column held both JS types across rows. Not reachable in practice (a column
  deserializes to one consistent JS type) and a pre-existing property of `serializeRowKey`
  shared with bloom-join/window code, not introduced here. No action.
- **In-transaction `SET COLLATE`**: the scan reads committed data via `getStore`, exactly like
  `addConstraint` (no coordinator flush). Full store suite (incl. isolation layer) is green; no
  divergence observed, so no bespoke flush logic added (per the plan ticket's guidance).
- **PRIMARY KEY `SET COLLATE` on the store** stays schema-only — Option B
  (`blocked/store-set-collate-pk-physical-rekey`).

## Validation (final, post-review)
- **Lint** (`yarn lint`, packages/quereus): clean (exit 0).
- **Memory** (`node test-runner.mjs --no-bail`): **5190 passing, 9 pending, 0 failing.**
- **Store** (`node test-runner.mjs --store --no-bail`): **5184 passing, 14 pending, 1 failing.**
  The single failure is the **pre-existing, already-triaged** `50-metadata-tags.sqllogic`
  (`Index 'uq_expo_vin' not found` — exposed-implicit-index path), filed at
  `backlog/store-exposed-implicit-index-not-addressable.md` (triage commit `4a9563bf`).
  Outside this diff.
- **Targeted** (`--grep "41.7"`): memory **3 passing**; store **2 passing + 1 pending** (41.7.1
  PK-only correctly skipped under store). All four new sections pass in both modes.
