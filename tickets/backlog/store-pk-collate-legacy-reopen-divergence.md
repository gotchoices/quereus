description: [Deferred legacy-migration half] Real engine-side import-path reconciliation so a legacy persisted DDL carrying an explicit divergent text-PK collation reports the normalized collation K from `table_info` after a full close→reopen — not just on the transient `StoreTable` instance. The cheap honest-scoping half (remove the ineffective connect-path leniency + misleading warning) was split out to `store-pk-collate-drop-ineffective-connect-leniency` (fix/). This ticket is the genuine-migration half, deferred because `AGENTS.md` puts backwards-compatibility out of scope.
files: packages/quereus-store/src/common/store-module.ts, packages/quereus/src/schema/manager.ts
prereq:
----

> **Triage (2026-06-08): split.** The do-now cleanup (drop the ineffective `{ reject: false }`
> connect arm + its misleading warning) moved to `store-pk-collate-drop-ineffective-connect-leniency`
> (fix/). What remains here is the genuine engine import-path reconciliation, deferred — and a
> **candidate to close** rather than carry if legacy migration is never brought into scope.

## Background

The shipped `store-pk-collate-create-time-divergence` work closed the CREATE-time declared≠enforced
split for store text-PK columns: an implicit-default divergent text-PK collation is normalized up to
the fixed table key collation K, and an explicit divergent one is rejected with a sited
`UNSUPPORTED`. That fix is complete for all **post-fix** data — a normalized create persists
`collate <K>`, so reopen re-parses to K and finds no divergence.

## The gap (legacy data only)

For a **legacy** persisted DDL with an explicit divergent text-PK collation (only producible by
pre-fix data), a full close→reopen still reports the divergent collation from `table_info()`:

- `connect`'s instance-level coercion never reaches the `SchemaManager` registration, which is what
  `table_info` reads; and on reopen that registration is produced by `rehydrateCatalog` →
  `importCatalog` parsing the persisted DDL, a path that **deliberately skips module hooks**.
- The post-import reconcile loop in `rehydrateCatalog` then pushes the `SchemaManager` schema back
  into the `StoreTable` instance, overwriting even the instance coercion.

Physical key bytes were always K-encoded via `encodeOptions`, so there is **no** data-corruption
risk — this is purely the declared-side `table_info` lie persisting for legacy rows.

## Scope split

- **Do-now cleanup** (separate ticket, `store-pk-collate-drop-ineffective-connect-leniency`):
  remove the ineffective `{ reject: false }` connect arm and its misleading `Normalized…` warning
  so we stop pretending to migrate.
- **This ticket (deferred):** make the schema *registered* in `SchemaManager` — not just the
  transient `StoreTable` instance — reconcile a legacy divergent text-PK collation to K on reopen.

## What a real fix looks like

Engine import-path reconciliation: give the import path a module-consulted normalization hook so the
registered schema is reconciled — e.g. route table DDL through a module callback in
`importCatalog`/`rehydrateCatalog` that returns the reconciled schema, or feed the store's `connect`
reconciliation back into the registered schema rather than the instance only. Then `table_info`
reports K after reopen.

## Why deferred

The only way to obtain such a persisted DDL is pre-fix data; `AGENTS.md` states backwards
compatibility is explicitly out of scope for now, and the parent ticket's CREATE-path fix is the
complete one for all data created after it landed. Tracked so the connect-path leniency is not
mistaken for a working legacy-migration path — and a candidate to **close** if backcompat stays
out of scope.

## Acceptance (if/when worked)

A LevelDB (or in-memory KV with a hand-seeded catalog entry) round-trip: persist a catalog DDL with
an explicit divergent text-PK collation (`create table t (x text collate binary primary key)` under
K=NOCASE), reopen via `rehydrateCatalog`, and assert `table_info('t').collation` for `x` == `NOCASE`.
