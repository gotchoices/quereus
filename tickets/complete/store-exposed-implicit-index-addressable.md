description: Store-mode fix making an exposed implicit covering index (quereus.expose_implicit_index) addressable + introspectable by deriving a synthetic index from uniqueConstraints in the read paths and routing ALTER INDEX … TAGS onto UniqueConstraintSchema.exposedIndexTags — without materializing a phantom index in the store.
files:
  - packages/quereus/src/schema/table.ts (UniqueConstraintSchema.exposedIndexTags)
  - packages/quereus/src/schema/catalog.ts (implicitIndexName, SyntheticExposedIndex, exposedImplicitIndexes, findExposedImplicitConstraintIndex; collectSchemaCatalog synthetic loop)
  - packages/quereus/src/func/builtins/schema.ts (buildIndexCreateSql; schema() + index_info() synthetic loops)
  - packages/quereus/src/schema/manager.ts (updateIndexTags — exposed-constraint fallback; commitTagUpdate)
  - packages/quereus/test/logic/50-metadata-tags.sqllogic (Phase 38)
  - docs/schema.md (Introspection note)
----

## Summary

Direction A from the implement ticket shipped: backends that do not materialize a
UNIQUE constraint's implicit covering index (the store enforces UNIQUE by
full-scan over `uniqueConstraints`) now derive a *synthetic* exposed index from
each exposed `UniqueConstraintSchema` in the read paths (`collectSchemaCatalog`,
`schema()`, `index_info()`), and route `ALTER INDEX … {SET|ADD|DROP} TAGS` onto a
new `UniqueConstraintSchema.exposedIndexTags` field in the write path
(`updateIndexTags`). Memory mode is untouched (it materializes the index as an
`IndexSchema`). The store's physical model is unchanged — no phantom index KV
store is created. The original repro (`50-metadata-tags.sqllogic` Phase 38) now
passes in both backends.

The implementation is sound and well-documented; the addressability/introspection
parity goal is met. Review surfaced one real, pre-existing correctness bug in the
*declarative apply* path that this change extends to the store backend — filed as
a fix ticket rather than blocking this one (see findings).

## Review findings

### Checked

- **Implement diff, fresh eyes** (`git show d6585fd8`) across all 5 source files
  + docs before reading the handoff.
- **Read-path correctness.** `exposedImplicitIndexes` returns `[]` in memory mode
  (name already materialized in `tableSchema.indexes`) ⇒ the three read-path
  callers append unconditionally with no double-listing. Verified the synthetic
  descriptor (no `unique`, no `col.desc`) flows safely through
  `generateIndexDDL` / `indexToCanonicalDDL` (absent props read as `undefined` ⇒
  falsy ⇒ no `UNIQUE`/`DESC`), so the canonical `definition` matches the memory
  materialized entry across backends. Tags kept out of `definition`.
- **Write-path correctness.** `updateIndexTags` two-phase logic: materialized
  `IndexSchema` first (memory, unchanged), then exposed-constraint fallback via
  `findExposedImplicitConstraintIndex`, else `NOTFOUND`. `compute(...)` runs
  before any array swap (drop-of-absent `NOTFOUND` aborts untouched). Immutability
  preserved (`{ ...uc }` spread + `Object.freeze` on the rebuilt array;
  unmodified `uc` returned by reference). `commitTagUpdate` fires
  `table_modified` correctly. Hidden/materialized implicit indexes both return
  `-1` ⇒ preserve `NOTFOUND` (Phase 22/37).
- **DRY.** `implicitIndexName` and `buildIndexCreateSql` are genuine single
  sources, reused by exposure map / descriptor / both schema() loops.
- **Other introspection surfaces.** Grepped every `.indexes` reader in
  `src/`. Only the three named read paths + `updateIndexTags` are user-facing
  index introspection; the rest (`schema-differ` consumes the catalog,
  `lens-prover`, `planner/mutation`, memory-vtab `layer/*`) are
  planner/physical, correctly out of scope.
- **Positive behavior beyond Phase 38** (Phase 38 only covers ADD/DROP +
  `schema()`): wrote throwaway specs confirming `index_info('ExpoTbl')` surfaces
  the exposed index (`unique=0`, `partial=0`, `collation=BINARY`) and
  `ALTER INDEX … SET TAGS` (not just ADD/DROP) round-trips. Both green; specs
  removed.
- **Lint + tests.** `yarn lint` clean. `50-metadata-tags` passes memory AND
  store. Differ/catalog-relevant specs (covering-structure, schema-differ,
  declarative-equivalence, index-ddl-roundtrip, reserved-tags) — 149 passing.
  Full memory suite — **5197 passing / 9 pending / 0 failing**. (Full store suite
  not re-run this pass — no code changed during review; implement validated it at
  5192/14/0 and targeted store is green.)

### Found — MAJOR (filed, not fixed here)

- **Declarative differ emits a spurious `DROP INDEX` for an exposed implicit
  covering index.** Empirically reproduced during review (memory mode):

  ```
  ACTUAL INDEXES: [ 'uq_expo_vin' ]
  MIGRATION DDL:  [ 'DROP INDEX IF EXISTS uq_expo_vin' ]
  ```

  `collectSchemaCatalog` surfaces the exposed index as a `CatalogIndex` (for
  introspection), but the constraint is declared as a *table constraint*, so it
  has no matching `declaredIndex` — the differ's orphan-drop loop
  (`schema-differ.ts` ~466-468) schedules it for deletion. Result: re-applying a
  converged schema is non-idempotent, and under `renamePolicy=require-hint` it
  hard-errors.

  **Disposition:** This is **pre-existing in memory mode** — at `d6585fd8^`,
  `collectSchemaCatalog` already surfaced exposed implicit indexes
  (`catalog.ts:150`). The exposed-implicit-index feature shipped with this latent
  bug. This ticket's `exposedImplicitIndexes` synthetic loop *extends* the same
  spurious-drop to the store backend. It is orthogonal to the addressability fix
  delivered here (Phase 38 uses `CREATE TABLE`, never `apply schema`, so the
  suites don't catch it), and the correct fix (teach the differ to exclude
  exposed-implicit indexes from the standalone create/drop buckets — likely a
  `CatalogIndex` marker) is substantial enough to warrant its own ticket. Filed
  as `fix/declarative-differ-spurious-drop-exposed-implicit-index` with the
  empirical repro, root cause, both-backend scope, and acceptance criteria.

### Found — MINOR

- **Phase 38 test coverage is a floor, not a ceiling.** It exercises only
  ADD/DROP TAGS + `schema()`. `index_info()` surfacing and `SET TAGS` on the
  exposed index were verified green during review (throwaway specs) but have no
  permanent regression coverage. Not fixed inline (the addressable-tags behavior
  is correct and indirectly covered by the shared code paths); folded into the
  fix ticket's acceptance, whose regression tests should also assert
  `index_info()` + `SET TAGS` on an exposed index in both backends. Low risk.

### Not found (explicitly clear)

- **No type-safety regressions.** The structural-typing reliance the implementer
  flagged (`SyntheticExposedIndex` passed where `IndexSchema` is expected;
  `'unique' in idx` narrowing) is sound: tsc clean, and the absent-prop-reads-as-
  undefined contract holds for every field the DDL/canonical emitters touch. A
  shared explicit type would be marginally cleaner but is a style preference, not
  a correctness issue — left as-is.
- **No resource-cleanup / error-handling gaps** in the write path (see Checked).
- **No NOTFOUND-parity regressions** (Phase 22/37 green both modes).

### Known gap acknowledged (out of scope, already tracked)

- **Tag persistence across store reopen.** Because `exposedIndexTags` is a
  separate field, the table DDL's `WITH TAGS` emits only `uc.tags` (the exposure
  flag), so an exposed index's *user* tags do not survive a store close→reopen.
  Phase 38 does not reopen, so this does not block the fix. Tracked under backlog
  `store-secondary-index-persistence`. Confirmed this ticket neither introduces
  nor is blocked by it.

## Validation performed (review pass)

- `yarn lint` — clean.
- `node test-runner.mjs --grep "50-metadata-tags"` (memory) — 1 passing.
- `node test-runner.mjs --store --grep "50-metadata-tags"` (store) — 1 passing.
- Differ/catalog spec sweep — 149 passing.
- `node test-runner.mjs` (full memory) — 5197 passing / 9 pending / 0 failing.
- Empirical adversarial checks (throwaway specs, since removed): differ
  idempotency repro (FAILED → filed), `index_info()` + `SET TAGS` on exposed
  index (PASSED).
