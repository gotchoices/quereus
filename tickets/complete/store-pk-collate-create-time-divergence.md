description: Closed the CREATE-time store PK-collation silent-divergence gap (the analogue of the shipped ALTER SET COLLATE guard) — implicit-default text-PK collation normalized up to the fixed table key collation K; explicit divergent text-PK collation rejected with a sited UNSUPPORTED. Reviewed, validated, and completed.
files: packages/quereus/src/schema/column.ts, packages/quereus/src/schema/table.ts, packages/quereus-store/src/common/store-module.ts, packages/quereus-store/test/create-table-conformance.spec.ts, packages/quereus-store/test/alter-table-conformance.spec.ts, docs/module-authoring.md, docs/schema.md
prereq:
----

## What shipped

The store enforces PRIMARY KEY uniqueness *physically* under a single fixed
table-level key collation K (`config.collation || 'NOCASE'`, via `StoreTable.encodeOptions`),
not the per-column declared collation. Before this change, `create table t (x text
primary key) using store` declared the `BINARY` default while the key bytes ran under
K (NOCASE) — `table_info` reported `BINARY`, uniqueness/point-lookup/ordering ran NOCASE:
a declared≠enforced split. This work reconciled it at the CREATE entry point, mirroring
the previously-shipped ALTER `SET COLLATE` guard.

- **Engine signal (additive):** new optional `ColumnSchema.collationExplicit?: boolean`
  (`column.ts`), set `true` by `columnDefToSchema` only in the `collate` case (`table.ts`).
  Absent ⇒ implicit default. Every non-store consumer ignores it.
- **Store reconciliation (`store-module.ts`):** module-level `reconcilePkCollations(schema,
  keyCollation, { reject })` walks `primaryKeyDefinition`; for each **text** PK member
  (`logicalType.isTextual`) whose declared collation diverges from K:
  - `reject: true` (CREATE) + `collationExplicit` → sited `QuereusError(UNSUPPORTED)`
    mirroring the ALTER guard message; else normalize the column to K (rebuild `columns`
    + `columnIndexMap`).
  - `reject: false` (connect) → always normalize, never throw.
  `create` calls it with `{ reject: true }` **before** any storage side-effect (clean
  reject leaves no dangling store), threads the reconciled schema into `new StoreTable`
  and the DDL event. `finalizeCreatedTableSchema` reads `tableInstance.tableSchema`, so the
  reconciled schema is what registers → `table_info` reports K.
- **Docs:** `docs/schema.md` § "Fixed physical key collation…" and `docs/module-authoring.md`
  PK-column `setCollation` note rewritten to cover CREATE/connect alongside ALTER.

## Review findings

Reviewed the implement diff (`75477dbf`) with fresh eyes against the full aspect set
(SPP, DRY, modularity, error handling, resource cleanup, type safety, scalability,
maintainability), traced the create→register→DDL→reopen data flow end-to-end, and ran
the full validation gate.

### Verified correct (checked, nothing to change)
- **Registration path:** `finalizeCreatedTableSchema` reads `tableInstance.tableSchema`;
  `StoreTable` holds the reconciled schema → `table_info` reports K. Confirmed empirically
  (conformance spec) and by source trace (`manager.ts`).
- **No dangling store on reject:** `reconcilePkCollations({ reject: true })` runs *before*
  `provider.getStore`, so an explicit-divergent reject creates no storage; the connection
  stays usable (tested).
- **DDL round-trip:** `generateTableDDL` emits `COLLATE NOCASE PRIMARY KEY` for a non-default
  collation (verified via `ddl-generator-roundtrip-positions.spec.ts`), so a normalized create
  persists `collate <K>` and reopen re-parses to K with no divergence — the "post-fix reopen is
  a no-op" claim holds.
- **Negative guards:** non-text PK (integer), non-PK text columns, and temporal/JSON PKs
  (`isTextual === false`) are passed through untouched. Confirmed in tests and by the
  `isTextual` gate.
- **ALTER symmetry / no regression:** message and code mirror the `alterColumn` PK guard; the
  memory module ignores `collationExplicit` (no cross-module behavior change). Full ALTER
  conformance matrix still green.
- **Error handling & type safety:** throw-before-side-effect ordering is correct; composite-PK
  reject aborts cleanly with no partial state; optional field, no `any`, frozen `columns`.

### Found and fixed inline (minor)
- **K-parameterization coverage gap.** Every implementer test exercised only the default
  K=NOCASE. The reconciler is parameterized on `config.collation`, but the K=BINARY leg — where
  the roles invert (implicit BINARY is consistent; an explicit `collate nocase` PK is the
  divergent-reject case) — was untested, so a future regression pinning the reconciler to a
  hardcoded NOCASE would pass silently. Added 3 cases to `create-table-conformance.spec.ts`
  (`using store (collation = 'binary')`): implicit BINARY stays BINARY (no spurious normalize),
  explicit `collate nocase` → sited `UNSUPPORTED`, explicit `collate binary` (== K) honored.
  All pass; the symmetry is now locked.

### Found and filed as a new ticket (major, but legacy-only / out of current scope)
- **connect-path normalization never reaches `table_info`** →
  `tickets/backlog/store-pk-collate-legacy-reopen-divergence.md`. The lenient connect arm
  mutates only the `StoreTable` *instance* schema; `table_info` reads the `SchemaManager`
  registration, which `rehydrateCatalog`→`importCatalog` builds by parsing DDL (module hooks
  skipped), and the post-import loop then overwrites the instance from `SchemaManager`. So for a
  legacy persisted DDL with an explicit divergent text-PK collation, a full reopen still reports
  the divergent collation while the `[StoreModule] Normalized…` warning fires misleadingly. Only
  producible by pre-fix data (backwards-compat explicitly out of scope per `AGENTS.md`); the
  CREATE-path fix is complete for all post-fix data. The implementer flagged this honestly as
  gap #1; the review confirmed the mechanism and routed the real fix (engine import-path
  reconciliation, or honest removal of the no-op arm) to backlog.

### Honest gaps from the handoff — dispositions
- **#1 connect/rehydrate (legacy reopen):** confirmed and ticketed (above).
- **#2 no LevelDB reopen assertion for normalized DDL:** the DDL round-trip is unit-proven
  (`COLLATE NOCASE` is emitted and re-parses to K) and the full LevelDB store leg passed during
  implement; a dedicated reopen-assertion is folded into the backlog ticket's acceptance criteria.
- **#3 `collationExplicit` provenance:** verified the real `create table … collate …` path threads
  it via `columnDefToSchema` (the explicit-reject tests pass), and programmatic schemas correctly
  default to implicit-normalize. No path that should reject is downgraded.
- **#4 temporal/JSON PKs not normalized & #5 intended query-layer convergence:** both confirmed
  correct-by-design and benign; no action.

## Validation (all green)
- `yarn workspace @quereus/store run typecheck` — clean.
- `yarn workspace @quereus/store run test` — **382 passing** (379 baseline + 3 added K=BINARY cases).
- `create-table-conformance.spec.ts` — **12 passing** (9 baseline + 3 added).
- `yarn workspace @quereus/quereus run test` (memory leg) — **5367 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus run lint` — clean.

## End
