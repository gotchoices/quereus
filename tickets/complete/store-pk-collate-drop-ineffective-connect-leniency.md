description: COMPLETE — Removed the ineffective store connect-path PK-collation leniency arm and its misleading `[StoreModule] Normalized a divergent…` warning. `StoreModule.connect` now builds its `StoreTable` straight from the resolved `tableSchema`; `reconcilePkCollations` lost its `options.reject` parameter and is now the CREATE-only path (reject explicit divergence / normalize implicit default). CREATE semantics unchanged. Docs reworded to describe the load path honestly (stale-but-loadable, not silently coerced). Genuine reopen-time migration stays deferred in `store-pk-collate-legacy-reopen-divergence` (backlog/).
files:
  - packages/quereus-store/src/common/store-module.ts            # connect (~294-311), reconcilePkCollations (~1990-2050), create call site (~205-206), importCatalog reconcile loop (~1727-1731)
  - packages/quereus-store/test/rehydrate-catalog.spec.ts        # regression test (~593-657)
  - packages/quereus-store/test/create-table-conformance.spec.ts # CREATE-path reconcile pins (unchanged, stayed green)
  - docs/schema.md                                               # CREATE vs Load-path split (~276-296)
----

# Complete — drop the ineffective store connect-path PK-collation leniency + warning

## What shipped

The connect (store **load**) path previously called
`reconcilePkCollations(tableSchema, K, { reject: false })`, coercing a divergent text-PK
collation up to the fixed key collation K and logging `[StoreModule] Normalized a divergent
text PRIMARY KEY collation…`. That arm was **dead**: it mutated only the transient
`StoreTable`'s cached schema, which `importCatalog`'s post-import reconcile loop
(`store-module.ts:1727-1731`, `table.updateSchema(fresh)`) immediately overwrites with the
`SchemaManager`-registered schema — and on reopen that registered schema comes from
`importCatalog` re-parsing the persisted DDL (carrying the divergent collation, not K). Net
pre-fix: the warning fired yet `table_info` still reported the divergent collation after
reopen. Physical key bytes are always K-encoded (`StoreTable.encodeOptions`), so there was
no correctness/data risk — purely a declared-side `table_info` lie plus noise.

This ticket deleted the arm. `connect` now constructs `new StoreTable(..., tableSchema, ...)`
directly; `reconcilePkCollations` dropped its `options: { reject }` parameter and always
rejects an EXPLICIT divergence / normalizes an IMPLICIT default (the CREATE-only contract).
`docs/schema.md` split the old combined "CREATE / connect" bullet into a CREATE bullet
(unchanged) and a new Load-path bullet stating the load path does NOT reconcile — a legacy
DDL stays loadable as-declared, `table_info` reports the stale collation as-is, harmless
because key bytes are K-encoded, with a pointer to the deferred reopen migration.

## Review findings

Adversarial pass over the implement diff (`1901e406`), read first with fresh eyes, then
checked against the live tree and validated by running tests.

### Checked — code correctness (SPP / DRY / dead-code / cleanup)
- **Dead-local check** — confirmed `connect` has no orphaned locals after the removal:
  `config` feeds `new StoreTable`, `schemaName`/`tableName` build `tableKey`. Clean.
- **Dead-code justification verified end-to-end** — traced `importCatalog` → `importTable`
  connects a `StoreTable` holding the parsed schema, then the post-import loop
  (`store-module.ts:1727-1731`) calls `table.updateSchema(fresh)` from the registry,
  overwriting any connect-time reconcile. Confirmed `StoreTable.encodeOptions`
  (`store-table.ts:173`, `{ collation: config.collation || 'NOCASE' }`) keys all data under
  the fixed table-level K, NOT the per-column declared collation — so the divergent
  per-column collation on the cached schema never affected key bytes. The "harmless +
  ineffective" claim holds.
- **No stale callers/refs** — grep across `quereus-store` confirms `reconcilePkCollations`
  has exactly one (CREATE) call site with the new 2-arg signature; no `{ reject: … }`
  argument survives anywhere; the `Normalized a divergent` string exists only in the test.

### Checked — tests (treated as a floor, not the finish)
- **Meaningfulness rigorously confirmed** (the implementer's known gap) — I restored the
  pre-fix `store-module.ts` (`git show 1901e406^:…`) and ran the new test in isolation: it
  goes **RED** precisely at the warning assertion (`-1 / +0` — one `/Normalized a divergent/`
  match, expected zero), and **GREEN** against the shipped code. The test genuinely guards
  the regression. Working tree restored clean afterward (verified `git diff --stat` empty).
- **Assertions cover the contract** — no normalization warning on reopen; `result.errors`
  empty + `main.t` rehydrated; `table_info('t').collation` for `x` reports `BINARY`
  (stale-but-loadable, NOT K — the documented behavior, not a bug); table is queryable and
  an insert round-trips. `console.warn` spy is restored in a `finally`. The warn-filter
  (rather than asserting total silence) correctly avoids a false pass from `recordError`'s
  own `console.warn`.
- **CREATE pins intact** — full `create-table-conformance.spec.ts` ran green inside the
  suite; CREATE reject(explicit)/normalize(implicit) semantics are unchanged.

### Checked — docs
- Read the full changed `docs/schema.md` section. It now honestly describes the load path
  as non-reconciling/stale-but-loadable and points to the deferred
  `store-pk-collate-legacy-reopen-divergence` ticket, which exists in `tickets/backlog/`.
  No other doc referenced the removed warning or the old combined "CREATE / connect"
  behavior.

### Validation run
- `yarn workspace @quereus/store test` → **383 passing** (the three non-failure log lines —
  `events.spec.ts` "boom", and two expected `Failed to rehydrate` recordError lines — are
  intentional from unrelated tests).
- `yarn workspace @quereus/store typecheck` (`tsc --noEmit`) → exit **0**.

### Findings disposition
- **Major:** none.
- **Minor (fixed inline this pass):** none required.
- **Observation (not actioned, by design):** the regression test calls `db.close()` only on
  the success path (not in a `finally`), so a failing assertion leaks the `Database`. This
  matches the existing convention throughout `rehydrate-catalog.spec.ts` (every test creates
  a local `db`/`db2` and closes at the end) and is harmless — each test gets a fresh provider
  via `beforeEach` and `afterEach` runs `provider.closeAll()`, so no cross-test state
  survives. Left as-is to stay consistent with the file; not worth a divergent pattern.
- **Deferred (correctly, not a new bug):** `table_info` reporting BINARY rather than K after
  reopen is the committed stale-but-loadable contract; the genuine engine-import-path
  migration remains `tickets/backlog/store-pk-collate-legacy-reopen-divergence.md`.

### Not run (justified)
- **LevelDB lane (`yarn test:store`)** — not run. This is a pure dead-code removal touching
  no persistence bytes; the in-memory provider exercised the full load/reopen path. No
  store-specific uncertainty remained.
- **Lint** — `packages/quereus`'s eslint scope covers only `packages/quereus/{src,test}`;
  there is no eslint config for `quereus-store`, so this diff has no lint scope. `typecheck`
  is the gate and passed.
- **`.pre-existing-error.md`** — not written; every test passed, nothing to triage.

## Outcome

Complete. Dead code + misleading warning removed, CREATE behavior preserved, docs made
honest, regression locked in with a test proven to fail pre-fix. No follow-up tickets.
