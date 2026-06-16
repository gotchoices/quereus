description: |
  When you create a durable "using lamina" materialized view through SQL, its rows are not actually
  stored — the database engine builds the view's backing the ordinary way and never asks Lamina for its
  durable storage path, so the view comes up empty / errors. Closing this needs a small change in the
  Quereus engine (this repo), not in Lamina.
prereq:
files:
  - packages/quereus/src/schema/manager.ts — SchemaManager.createBackingTable (calls module.create directly)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts — materializeView → createBackingTable → resolveBackingHost
  - packages/quereus/src/vtab/module.ts — VirtualTableModule.createBacking? / getBackingHost? capability surface
  - ../lamina/packages/lamina-quereus/src/module.ts — LaminaModule.createBacking (the durable router that is never reached from SQL)
  - ../lamina/packages/lamina-quereus-test/src/mv-backing-installer-enablement-e2e.test.ts — the it.skip gated on this gap
difficulty: medium
----

# Quereus `createBackingTable` must prefer `module.createBacking?()` so durable MV backings route to Lamina

> **Routed from the lamina board 2026-06-15.** A lamina review agent discovered this gap while running
> in the lamina repo and filed the ticket there; it is a quereus-side fix, so it has been moved into this
> repo's backlog. The slug is kept identical because two lamina-side tickets gate on it by name
> (`mig-adopt-real-engine-e2e`, `lamina-mv-backing-general-body-golden`).

## What's wrong

The full SQL path `create materialized view <mv> using lamina as <body>` does NOT route the backing
create into Lamina's durable basis row storage. Even on an install that has fully opted into durable MV
backing (`createLaminaInstallation(…, { durableMvBacking: true })`, so the module's
`basisRowStoreCreate` + `backingHostWriteBracket` seams ARE wired), the SQL path fails:

```
create table t(id integer primary key, v text);        -- OK
insert into t values (1,'a'),(2,'b');                  -- OK
select id, v from t;                                   -- OK → [{1,a},{2,b}]
create materialized view mv using lamina as select id, v from t;
  → QuereusError: backing host not found for 'main.mv'
```

(Empirically reproduced 2026-06-15 from the lamina `lenses` branch with this repo linked via the
`portal:` junction, using a production `createLaminaInstallation` install + `durableMvBacking: true` + a
real Quereus `Database`.)

## Root cause (quereus-side)

`SchemaManager.createBackingTable` (`packages/quereus/src/schema/manager.ts`) creates the MV's backing
table by calling the module's ORDINARY create:

```ts
tableInstance = await moduleInfo.module.create(this.db, tableSchema);
```

`createBacking` is **not referenced anywhere** in this repo's source (verified by grep:
`\.createBacking\b|createBacking\?|createBacking\(` → no matches). So:

1. `materializeView` → `sm.createBackingTable(backingSchema)` → `module.create(...)` builds an ORDINARY
   relational Lamina table named `main.mv` (the non-durable `create` path), NOT a durable `LocalRowStore`.
2. `materializeView` → `resolveBackingHost(db, completeBacking)` → `module.getBackingHost(db,'main','mv')`.
   With the seams wired, `getBackingHost` passes its capability guard but then resolves no store
   (`lookup('main.mv') ?? lookup('mv')` → `undefined`, because step 1 created a relational table, not a
   durable store) → returns `undefined`.
3. `resolveBackingHost` throws `backing host not found for 'main.mv'`.

Lamina already ships the durable router: `LaminaModule.createBacking`
(`../lamina/packages/lamina-quereus/src/module.ts`) routes a backing create into the basis-store
catalog's `LocalRowStore` and is idempotent on a present store. It is proven end-to-end through the
MODULE seam by `../lamina/packages/lamina-quereus-test/src/mv-backing-create-routing-e2e.test.ts`
(which calls `module.createBacking(...)` directly). The lamina-side opt-in that wires the seams onto a
production install landed in `lamina-mv-backing-production-enablement`. The ONLY missing piece is that
quereus must PREFER `createBacking` over `create` when creating a backing table.

## Expected behavior

`SchemaManager.createBackingTable` should prefer the module's durable-backing create when the module
advertises it, i.e. the `createBacking?() ?? create()` seam the lamina create-routing design assumed:

```ts
const create = moduleInfo.module.createBacking?.bind(moduleInfo.module) ?? moduleInfo.module.create.bind(moduleInfo.module);
tableInstance = await create(this.db, tableSchema);
```

(plus the corresponding optional-method declaration on `VirtualTableModule`). Modules that do not
implement `createBacking` (e.g. the memory module) keep their exact current behaviour — `create` is the
fallback — so this is non-breaking for existing backings. With this in place, the SQL path reaches
`LaminaModule.createBacking`, the durable store is created, `resolveBackingHost` finds the host, the MV
fills + reads back, and survives reopen (exactly what the module-seam e2e already proves, but now from
SQL).

## Scope / non-goals

- This is a **quereus-side** change (this repo), not a Lamina change. Lamina's durable router and the
  production opt-in already exist and are tested. Do NOT re-home the fix into Lamina.
- This is distinct from cluster B of the lamina `sqllogic-conformance-untracked-failures` ticket (the
  maintained-table corpus failing at "backing host not found" because the sqllogic harness keeps the
  durable seams OFF by design). That cluster is about the harness not opting in; THIS gap is that even
  WITH the seams on, the SQL path can't reach `createBacking`. They share an error string but differ in
  cause.

## What unblocks when this lands (lamina-side follow-ups)

- The skipped full-SQL-path round-trip in
  `../lamina/packages/lamina-quereus-test/src/mv-backing-installer-enablement-e2e.test.ts` (currently
  `it.skip`, tracked by this slug) — un-skip it and assert create → fill → read → reopen through real SQL.
- `lamina-mv-backing-general-body-golden` (the golden fixture follow-up), whose design explicitly routes
  itself to `blocked/` until this gap closes — it drives the FULL SQL path and cannot generate its
  fixture against a broken path.
