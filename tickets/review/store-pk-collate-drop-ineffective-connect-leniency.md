description: Review the removal of the ineffective store connect-path PK-collation leniency arm + its misleading `[StoreModule] Normalized a divergent…` warning. The dead `{ reject: false }` reconcile in `StoreModule.connect` and the `options.reject` parameter of `reconcilePkCollations` are gone; `connect` now constructs its `StoreTable` straight from the resolved `tableSchema`; CREATE behavior is unchanged. Docs reworded to describe the load path honestly (stale-but-loadable, not silently coerced). Genuine reopen-time migration stays deferred in `store-pk-collate-legacy-reopen-divergence` (backlog/).
prereq:
files:
  - packages/quereus-store/src/common/store-module.ts            # connect (~294-311), reconcilePkCollations (~2017-2052), create call site (~205-206)
  - packages/quereus-store/test/rehydrate-catalog.spec.ts        # new regression test (~595-660) + buildCatalogKey/RehydrationResult imports (~1-9)
  - packages/quereus-store/test/create-table-conformance.spec.ts # CREATE-path reconcile pins — must stay green (unchanged)
  - docs/schema.md                                               # CREATE vs load-path split (~279-300)
----

# Review — drop the ineffective store connect-path PK-collation leniency + warning

## What changed (and why it is safe)

The shipped `store-pk-collate-create-time-divergence` added a lenient reconcile arm on the store
**load** path: `StoreModule.connect` called `reconcilePkCollations(tableSchema, K, { reject: false })`
to coerce a divergent text-PK collation up to the fixed key collation K, logging
`[StoreModule] Normalized a divergent text PRIMARY KEY collation…`.

That arm was **dead**: it mutated only the transient `StoreTable` instance's cached schema, which
`importCatalog`'s post-import reconcile loop (`rehydrateCatalog` → `table.updateSchema(fresh)`,
`store-module.ts` ~1727-1731) immediately overwrites with the `SchemaManager`-registered schema. On
reopen that registered schema comes from `importCatalog` **re-parsing the persisted DDL** (a path
that skips module hooks), so it carries the divergent collation, not K. Net pre-fix: the warning
fired yet `table_info` still reported the divergent collation after reopen — a misleading signal of a
normalization that never survived. Physical key bytes were always K-encoded
(`StoreTable.encodeOptions`), so there was **no** correctness/data risk — purely a declared-side
`table_info` lie + noisy warning.

This ticket removed the arm. `AGENTS.md` puts backwards-compatibility out of scope, so the honest
move was deletion, not a pretend-migration.

### Edits

- **`StoreModule.connect`** — removed the `reconcilePkCollations(..., { reject: false })` call, the
  `if (reconciledSchema !== tableSchema) { console.warn(…) }` block, and the now-unused `keyCollation`
  local. `new StoreTable(...)` now takes the resolved `tableSchema` directly. (`config`, `schemaName`,
  `tableName` all still used elsewhere in `connect` — no other dead locals.)
- **`reconcilePkCollations`** — dropped the `options: { reject: boolean }` parameter; it now *always*
  rejects an EXPLICIT divergence (`col.collationExplicit`) and normalizes an IMPLICIT default. JSDoc +
  inline comment reworded; this is now documented as the CREATE-only path.
- **`create` call site** — dropped the `{ reject: true }` argument (behavior identical: explicit
  divergence still rejects, implicit still normalizes).
- **`docs/schema.md`** — split the old "CREATE / connect" bullet into two: a CREATE bullet (unchanged
  semantics) and a new **Load path** bullet stating the load path does NOT reconcile — a legacy DDL
  stays loadable as-declared, `table_info` reports the stale collation as-is, harmless because key
  bytes are K-encoded, with a pointer to the deferred reopen migration.

## Validation performed

- `yarn workspace @quereus/store test` → **383 passing** (includes the new regression test and the
  full `create-table-conformance.spec.ts` suite, which stayed green — CREATE reject/normalize behavior
  is unchanged). The log shows three intentional non-failure lines from *other* tests: the
  `events.spec.ts` "boom" listener throw and two expected `Failed to rehydrate` recordError lines
  (corrupt-DDL + missing-MV-source cases).
- `yarn workspace @quereus/store typecheck` (`tsc --noEmit`) → clean (exit 0). The mocha run uses Node
  type-stripping (no type check), so this is the authoritative type pass.

### New regression test

`rehydrate-catalog.spec.ts` → *"legacy divergent text-PK collation loads without a Normalized warning
and reports the declared collation"*:
1. Hand-seeds a raw catalog entry (`buildCatalogKey('main','t')` → `create table t (x text collate
   binary primary key) using store`) — a normal CREATE can no longer produce this (it rejects).
2. Spies on `console.warn` (restored in `finally`), reopens via a fresh `Database` + `rehydrateCatalog`.
3. Asserts: `result.errors` empty + `main.t` rehydrated; **no** warning matching `/Normalized a
   divergent/`; `table_info('t').collation` for `x` reports `BINARY` (stale-but-loadable); the table
   is queryable (`select x from t` → `[]`, then insert `'a'` round-trips).

## Reviewer focus / known gaps (treat tests as a floor)

- **Is the test meaningful (would it have failed pre-fix)?** I traced the code path — pre-fix,
  `importCatalog` → `connect` ran the `{ reject:false }` reconcile and fired the warning during
  reopen, so the `/Normalized a divergent/` assertion would have failed before this change. I did
  **not** literally check out the pre-fix code and observe a red test. Worth a skeptical pass: confirm
  `connect` is actually invoked during `importCatalog`'s table import (it instantiates the StoreTable),
  and that pre-fix it would have warned for this seeded DDL.
- **`table_info` reports BINARY, not K — intentional.** This is the documented stale-but-loadable
  behavior, NOT a fix. Making reopen report K requires reconciling on the engine import path; that is
  deliberately deferred in `tickets/backlog/store-pk-collate-legacy-reopen-divergence.md`. Don't file a
  new bug for the BINARY report — it's the contract this ticket commits to.
- **LevelDB lane not run.** Only the in-memory provider was exercised (`yarn workspace @quereus/store
  test`). `yarn test:store` (LevelDB) was not run — the in-memory path left nothing uncertain (this is
  a pure dead-code removal; persistence bytes are untouched). Flagged per ticket guidance.
- **quereus lint not run.** `packages/quereus`'s lint script globs only `packages/quereus/{src,test}`;
  it does not cover `quereus-store`, and I touched no quereus-core/test files. There is no eslint
  config for `quereus-store`, so there is no lint scope for this diff. The store `typecheck` covers
  type validity instead.
- **No `.pre-existing-error.md` written** — every test passed; nothing to triage.
