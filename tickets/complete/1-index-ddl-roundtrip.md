description: Lossless CREATE INDEX DDL round-trip (engine). generateIndexDDL emits UNIQUE + partial WHERE; importIndex reconstructs unique/predicate/per-column collation (incl. the collate-wrapped column form) and synthesizes the derived UNIQUE constraint via the shared appendIndexToTableSchema helper; importCatalog accepts multi-statement (table+indexes) entries. Engine-only; prerequisite for store-secondary-index-persistence.
files:
  - packages/quereus/src/schema/ddl-generator.ts          # generateIndexDDL: UNIQUE prefix + WHERE emission
  - packages/quereus/src/schema/table.ts                  # appendIndexToTableSchema (shared, +derived UNIQUE)
  - packages/quereus/src/schema/manager.ts                # importIndex rewrite, importDDL (multi-stmt), resolveImportedIndexColumn, createIndex via shared helper
  - packages/quereus/src/index.ts                         # export appendIndexToTableSchema
  - packages/quereus-store/src/common/store-module.ts     # createIndex via shared helper
  - packages/quereus/test/index-ddl-roundtrip.spec.ts     # spec (now 14 tests)
  - docs/schema.md                                        # Catalog Import + DDL Generation sections
----

# Complete: Lossless CREATE INDEX DDL round-trip (engine)

## What landed

A secondary index now survives being persisted as canonical DDL and rehydrated
by re-parsing:

1. **`generateIndexDDL`** emits the full shape — `CREATE [UNIQUE] INDEX <name> ON
   <table> (<cols>) [WHERE <predicate>] [WITH TAGS (...)]` — with the `UNIQUE`
   prefix, the partial `WHERE` (via the shared `expressionToString` emitter), and
   clause order matching the parser grammar / `createIndexToString`.
2. **`SchemaManager.importIndex`** reconstructs the full `IndexSchema` from the
   re-parsed AST: per-column collation (including the collate-wrapped column form
   the parser folds `COLLATE` into, via `resolveImportedIndexColumn`), `unique`,
   `predicate`, and the synthesized `derivedFromIndex` UNIQUE constraint. A
   genuine expression index (`lower(email)`) is still rejected.
3. **`importCatalog`/`importDDL`** accept multi-statement entries (a table bundled
   with its indexes), imported in document order; unsupported statement types
   throw (fail-loud); empty string is a no-op.
4. **DRY**: `appendIndexToTableSchema` in `table.ts` is the single source of truth
   for the index→schema mutation (live create, import, store cache refresh).

## Review findings

**Method.** Read the implement diff (dbf0aa9f) with fresh eyes before the
handoff, traced each touched file and the call sites it should have touched
(`buildIndexSchema`, `dropIndex` on both `SchemaManager` and `StoreModule`, the
parser's `indexedColumn`, the differ's index loop, the `index_info` /
`unique_constraint_info` TVFs), then extended the test suite and ran lint + the
full quereus suite.

### Checked and clean

- **Correctness of the round-trip.** Verified the parser preserves `direction`
  even on the collate-wrapped column form (`active COLLATE BINARY DESC` →
  `{expr: collate, direction: 'desc'}`), so DESC survives import. Verified
  collation normalization matches the live path byte-for-byte. Added a **DDL
  fixed-point test** (generate → import → generate = identical) which is stronger
  than the existing `index_info` deep-equal: `index_info()` exposes only the
  partial *flag*, not the predicate text, so the original tests could not catch
  predicate/collation/desc text drift. The fixed-point test closes that.
- **Shared helper / DRY.** `appendIndexToTableSchema` is correctly routed from
  all three sites; the old private `addIndexToTableSchema` is gone; `dropIndex`
  on both sides still filters the derived constraint by `derivedFromIndex`
  (symmetric add/remove). The add-only-grows / drop-collapses-to-undefined
  asymmetry is intentional and correct.
- **No unused imports** introduced in `store-module.ts` (`TableSchema`,
  `UniqueConstraintSchema` both still referenced).
- **Fail-loud / error paths.** `importDDL` throws on unsupported statement types;
  `importCatalog` re-throws (rehydrate relies on this). Empty-string no-op holds.
- **Lint** (`yarn lint`) — clean. **Full suite** (`node test-runner.mjs`) —
  **5166 passing, 9 pending**, no regressions (was 5164 + 2 new tests). The
  `[property-planner] Rule '…' never fired` lines are pre-existing coverage
  warnings, not failures (exit 0). `test:store` deferred to the downstream store
  ticket (slow; store wiring is not in this diff).

### Found — minor (left as-is, documented)

- **`importIndex` does not guard against a duplicate index name** the way
  `createIndex` does (no `IF NOT EXISTS` / existing-index check). Acceptable:
  import is a rehydrate-from-empty path, so a name collision cannot arise in
  practice. Pre-existing behavior (the old `importIndex` also appended blindly).
- **The derived UNIQUE constraint carries only column indices, not per-column
  collation.** A UNIQUE index whose collation differs from the column's own
  collation would have its uniqueness enforced via column indices only. This is
  pre-existing (the old `addIndexToTableSchema` was identical) and not reachable
  through the generated-DDL round-trip (the index inherits the column collation),
  so it is out of scope here — noting for awareness.
- **Mild duplication** between `buildIndexSchema` and `importIndex` in assembling
  the `IndexSchema` literal (`{name, columns, unique, predicate, tags}`). The
  column-resolution divergence (reject-expr vs unwrap-collate) makes a clean
  shared extractor awkward; both are documented to mirror each other. Left as-is.

### Found — major (filed)

- **`tickets/backlog/schema-differ-ignores-index-body-drift.md`** — confirmed the
  implementer's known-gap #2. `computeSchemaDiff` matches indexes by **name
  only** and compares solely their tags; unlike views/MVs (which `bodyHash` and
  drop+recreate), it never compares the index body, so an in-place change to a
  declared index's `UNIQUE`-ness or partial `WHERE` predicate produces **no
  migration**. Pre-existing differ limitation, made more visible by this ticket's
  now-lossless actual-side DDL. Filed to backlog with implementation notes (the
  `declare schema` grammar also needs a `WHERE` clause before partial drift is
  even declarable).

### Tests added this pass

- DDL fixed-point: re-emitting every imported index equals the original generated
  DDL (asserts predicate / collation / DESC / UNIQUE / tags survive textually).
- Composite UNIQUE index synthesizes a derived constraint over all its columns
  (`unique_constraint_info` columns in order).

## Scope confirmed deferred (downstream)

Store-side persistence wiring (bundling a table with its index DDLs into one
catalog entry and writing/loading through `connect()` on fresh storage) lands in
`store-secondary-index-persistence`. The engine-level ordering logic (table stmt
before index stmt; index resolves the preceding table) is covered here; the
genuine fresh-`connect` path is exercised end-to-end by that ticket. Reviewer is
comfortable with this split — forcing it through a throwaway test module would
not exercise the real rehydrate path.
