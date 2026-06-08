description: The store connect-path PK-collation normalization never reaches `table_info` — for a legacy persisted DDL carrying an explicit divergent text-PK collation, a full close→reopen still reports the divergent collation (and logs a misleading "Normalized…" warning that doesn't stick). A complete fix needs engine-side import-path reconciliation, not a `StoreTable`-instance-only coercion.
files: packages/quereus-store/src/common/store-module.ts, packages/quereus/src/schema/manager.ts
prereq:
----

## Background

The shipped `store-pk-collate-create-time-divergence` work closed the CREATE-time
declared≠enforced split for store text PK columns: an implicit-default divergent
text-PK collation is normalized up to the fixed table key collation K, and an
explicit divergent one is rejected with a sited `UNSUPPORTED`. That fix is complete
for all **post-fix** data — a normalized create persists `collate <K>` in its DDL,
so reopen re-parses to K and finds no divergence.

The same change also added a **lenient** reconciliation arm on the load path
(`StoreModule.connect`, `reconcilePkCollations(..., { reject: false })`): normalize a
divergent text-PK collation up to K rather than throw, "so a persisted/hand-authored
DDL stays loadable", and log a warning when it coerces.

## The gap

That connect-path arm is **ineffective for what `table_info` reports**, so it does not
actually close the legacy-reopen divergence it appears to:

- `connect` mutates only the **`StoreTable` instance's** cached schema. It does not
  touch the `SchemaManager` registration.
- `table_info()` reads the `SchemaManager`-registered `TableSchema`, which on reopen is
  produced by `rehydrateCatalog` → `importCatalog` parsing the persisted DDL. That path
  **deliberately skips module hooks** for registration, so `connect`'s reconciled return
  value never reaches it.
- Worse, the post-import reconciliation loop at the end of `rehydrateCatalog`
  (`for (const table of this.tables.values()) { … table.updateSchema(fresh) }`) pushes the
  `SchemaManager` schema **back into** the `StoreTable` instance, overwriting even the
  instance-level coercion `connect` performed.

Net effect for a **legacy** persisted DDL with an explicit divergent text-PK collation
(only producible by pre-fix data): after a full close→reopen, `table_info()` still reports
the divergent collation, and the `[StoreModule] Normalized a divergent text PRIMARY KEY
collation…` warning fires while the normalization does not survive — a misleading signal of
a fix that didn't happen. (Physical key bytes were always K-encoded via `encodeOptions`, so
there is no data-corruption risk — this is purely the declared-side `table_info` lie that the
parent ticket set out to eliminate, persisting for legacy rows.)

## Why it's backlog, not a blocker

The only way to obtain such a persisted DDL is pre-fix data; `AGENTS.md` states backwards
compatibility is explicitly out of scope for now, and the parent ticket's CREATE-path fix is
the complete one for all data created after it landed. This is tracked so the connect-path
leniency is not mistaken for a working legacy-migration path.

## What a real fix looks like (for the planner)

Pick one; the first is the most faithful:

- **Engine import-path reconciliation.** Give the import path a module-consulted normalization
  hook so the schema *registered* in `SchemaManager` (not just the `StoreTable` instance) is
  reconciled — e.g. have `importCatalog`/`rehydrateCatalog` route table DDL through a module
  callback that returns the reconciled schema, or have the store's `connect` reconciliation
  feed back into the registered schema rather than the instance only. Then `table_info` reports K
  after reopen and the warning becomes truthful.
- **Honest scoping alternative.** If legacy migration stays out of scope, drop the ineffective
  connect-path `{ reject: false }` arm and its warning entirely (it does nothing observable today),
  and document that reopening pre-fix divergent DDL reports the stale collation until rewritten.
  This removes the misleading warning without pretending to migrate.

## Acceptance

- A LevelDB (or in-memory KV with a hand-seeded catalog entry) round-trip test: persist a catalog
  DDL with an explicit divergent text-PK collation (e.g. `create table t (x text collate binary
  primary key)` under K=NOCASE), reopen via `rehydrateCatalog`, and assert `table_info('t').collation`
  for `x` == `NOCASE` (the chosen-fix behavior) — or, under the scoping alternative, assert the
  documented stale-but-loadable behavior with no misleading warning.
