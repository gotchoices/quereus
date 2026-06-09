description: Remove the ineffective store connect-path PK-collation leniency arm (`reconcilePkCollations(..., { reject: false })`) and its misleading `[StoreModule] Normalized a divergent text PRIMARY KEY collation…` warning. The arm coerces only the transient `StoreTable` instance, which `importCatalog`'s post-import reconcile loop (`table.updateSchema(fresh)`) immediately overwrites with the `SchemaManager`-registered schema — so it changes nothing observable while logging a warning that implies a normalization which does not survive reopen. Drop the dead arm + warning, simplify `reconcilePkCollations` to its only remaining (CREATE) caller, and reword docs/schema.md so the load path is described honestly (stale-but-loadable, not silently coerced). The real engine import-path reconciliation stays deferred in `store-pk-collate-legacy-reopen-divergence` (backlog/).
prereq:
files:
  - packages/quereus-store/src/common/store-module.ts            # connect (lines ~294-325), reconcilePkCollations (~2026-2062), create call site (~206)
  - packages/quereus-store/test/create-table-conformance.spec.ts # existing CREATE-path reconcile tests (must stay green)
  - packages/quereus-store/test/rehydrate-catalog.spec.ts        # reopen/round-trip patterns; add the no-warning + stale-loadable test here
  - packages/quereus-store/src/common/key-builder.ts             # buildCatalogKey — for hand-seeding a divergent legacy catalog entry in the test
  - docs/schema.md                                               # lines ~279-290 frame the connect/rehydrate leniency as a working normalization path
----

# Drop the ineffective store connect-path PK-collation leniency + warning

## Background (confirmed during fix)

`store-pk-collate-create-time-divergence` (shipped) added a lenient reconciliation arm on the store
load path. `StoreModule.connect` calls `reconcilePkCollations(tableSchema, K, { reject: false })` to
normalize a divergent text-PK collation up to the fixed table key collation K rather than throw "so
a persisted / hand-authored DDL stays loadable", and logs `[StoreModule] Normalized a divergent text
PRIMARY KEY collation…` when it coerces.

## Why the arm is dead code today (verified by reading the code path)

- `connect` (`packages/quereus-store/src/common/store-module.ts`, ~lines 296-321) builds
  `reconciledSchema` and hands it to the new `StoreTable` — mutating only the **`StoreTable`
  instance's** cached schema. It never touches the `SchemaManager` registration, and `table_info()`
  reads the `SchemaManager`-registered `TableSchema`.
- The post-import reconcile loop at the end of `importCatalog`
  (`store-module.ts` ~lines 1736-1740: `for (const table of this.tables.values()) { … const fresh =
  db.schemaManager.getTable(...); if (fresh) table.updateSchema(fresh); }`, reached via
  `rehydrateCatalog` → phase-1 table import) pushes the `SchemaManager` schema **back into** the
  `StoreTable` instance, overwriting even the instance-level coercion `connect` performed.
- On reopen, that `SchemaManager` schema is produced by `importCatalog` **re-parsing the persisted
  DDL** — a path that deliberately skips module hooks — so it carries the divergent (e.g. BINARY)
  collation, not K.

Net: after a full close→reopen, `table_info()` still reports the divergent collation while the
`Normalized…` warning fires — a misleading signal of a fix that didn't happen. Physical key bytes
were always K-encoded via `StoreTable.encodeOptions`, so there is **no** correctness / data risk;
this is purely a declared-side `table_info` lie plus a noisy warning. (Note: the ticket's original
"manager.ts post-import loop" pointer is slightly off — the overwrite loop lives in `importCatalog`
inside `store-module.ts`. The `files:` header above corrects this.)

`AGENTS.md` puts backwards-compatibility explicitly out of scope, so the honest move is to remove the
warning + dead arm now rather than pretend to migrate. The real engine import-path reconciliation (so
`table_info` reports K after reopen) stays deferred in `store-pk-collate-legacy-reopen-divergence`.

## Callers of `reconcilePkCollations` (so the simplification is safe)

After this change, `create` (CREATE path, `{ reject: true }`) is the **only** caller — `connect` is
removed. The function's `options: { reject: boolean }` parameter therefore becomes vestigial: it can
be dropped, leaving the function to *always* reject an explicit divergence and normalize an implicit
default. Do NOT change that CREATE behavior — the `create-table-conformance.spec.ts` suite pins it.

## Expected behavior

- The `{ reject: false }` lenient arm in `StoreModule.connect` and the associated `Normalized…`
  `console.warn` are removed. `connect` constructs its `StoreTable` from the resolved `tableSchema`
  directly (no reconcile on the load path).
- Reopening a legacy persisted DDL with an explicit divergent text-PK collation loads **without** the
  misleading warning; `table_info` reports the stale-but-loadable declared collation (documented, not
  silently coerced).
- All post-fix data is unaffected: a normalized CREATE persists `collate <K>`, so reopen re-parses to
  K and there is no divergence to reconcile. The strict-reject and consistent-normalize CREATE paths
  from `store-pk-collate-create-time-divergence` are unchanged (verified by the existing
  conformance suites).

## Reproduction (for the new test)

A normal `create` cannot produce a divergent persisted DDL anymore (it rejects), so hand-seed the
catalog entry directly, then reopen:

1. Build an in-memory provider (`createInMemoryProvider()`, as in the existing spec files).
2. Write a raw catalog entry: `const catalogStore = await provider.getCatalogStore();` then
   `catalogStore.put(buildCatalogKey('main', 't'), new TextEncoder().encode('create table t (x text collate binary primary key) using store'))`.
   (`buildCatalogKey` is importable from `../src/common/key-builder.js`; the test lives in the same
   package. Confirm the seeded DDL string matches what `rehydrateCatalog` expects — include `using
   store` so the module routes it; cross-check against an entry produced by `saveTableDDL` if needed.)
3. Open a fresh `Database`, register a `StoreModule(provider)`, and call `mod.rehydrateCatalog(db)`.

Today: the `Normalized…` warning fires yet `table_info('t').collation` for `x` still reports `BINARY`
after reopen. Desired: no warning; `BINARY` reported (stale-but-loadable, documented).

## TODO

- [ ] In `StoreModule.connect` (`store-module.ts`), remove the `reconcilePkCollations(tableSchema,
      keyCollation, { reject: false })` call, the `if (reconciledSchema !== tableSchema) { … }` block,
      and its `console.warn`. Pass the resolved `tableSchema` straight into the `new StoreTable(...)`.
      Drop the now-unused `keyCollation` local if nothing else in `connect` uses it.
- [ ] Simplify `reconcilePkCollations`: drop the `options: { reject: boolean }` parameter, make it
      always reject an explicit divergence (`col.collationExplicit`) and normalize an implicit one.
      Update its JSDoc (remove the `reject: false (connect / rehydrate)` bullet, ~lines 2018-2020) and
      the inline "(or lenient connect path)" comment (~line 2053). Update the `create` call site
      (~line 206) to drop the `{ reject: true }` argument.
- [ ] Reword docs/schema.md (~lines 286-288): replace "The load path (`connect` / rehydrate) applies
      the same normalization but never rejects — a persisted / hand-authored DDL must stay loadable…"
      with an honest description — the load path does **not** reconcile; a legacy persisted DDL with a
      divergent text-PK collation stays loadable and `table_info` reports the declared (stale)
      collation as-is. Note the genuine reopen-migration is tracked in
      `store-pk-collate-legacy-reopen-divergence`. Keep the CREATE-path description intact.
- [ ] Add a regression test (in `rehydrate-catalog.spec.ts` or a sibling) following the reproduction
      above: assert (a) no `console.warn` matching `/Normalized a divergent/` fires during reopen
      (stub/spy on `console.warn`), and (b) `table_info('t').collation` for `x` reports `BINARY`
      (stale-but-loadable) and the table is queryable after reopen.
- [ ] Run `yarn workspace @quereus/store test` (or the package's test script) and
      `yarn workspace @quereus/quereus run lint` for the store package's lint scope. Confirm
      `create-table-conformance.spec.ts` and `rehydrate-catalog.spec.ts` stay green. The store path is
      also exercised by `yarn test:store`, but that is the slower LevelDB run — only invoke it if the
      in-memory run leaves the store-specific path uncertain.
