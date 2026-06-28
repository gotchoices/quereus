---
description: Re-opening a previously-seeded database and re-applying its schema with seed data crashes with a duplicate-key error; make seed application idempotent so a reopen reseeds cleanly instead of inserting the rows a second time.
prereq:
files:
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # emitApplySchema withSeed branch L222-290 — the fix lives here
  - packages/quereus-store/test/rehydrate-catalog.spec.ts      # model for the reopen-with-shared-provider regression test
  - packages/quereus-store/src/common/store-table.ts           # INSERT-arm / OR REPLACE point-key probe (L993-1032) — evidence the conflict probe is a point lookup, not a scan
  - packages/quereus-isolation/src/isolated-table.ts           # isolation-layer OR REPLACE point-probe (L705-745) — same evidence
difficulty: medium
---

## Summary

`apply schema X with seed`, when X's tables were already created+seeded in a prior
`Database` (rows persisted in a host-backed vtab) and the in-memory catalog was **not**
rehydrated on reopen, throws `UNIQUE constraint failed: <table> PK`. The seed step
misclassifies the already-populated table as freshly-created, skips the wipe, and runs bare
`INSERT`s against rows that already exist.

The fix: make seed application **idempotent** via `INSERT OR REPLACE`, removing the brittle
"is this table freshly created?" heuristic and the `DELETE`-wipe entirely.

## Root cause (reproduced)

In `emitApplySchema`'s `withSeed` branch (`schema-declarative.ts:222-290`):

- `freshlyCreatedTables` (L240-249) is derived by diffing the declared tables against
  `actualCatalog = collectSchemaCatalog(rctx.db, schemaName)` (L189) — the **in-memory**
  Quereus catalog, which is ephemeral.
- For hosts that rebuild the catalog purely from `apply schema` on each open (Lamina; the
  row data lives in a separate persistent fact log, not the catalog), the catalog is empty
  on reopen → **every** declared table is misclassified as `freshlyCreated` → the
  `DELETE FROM <tbl>` wipe is skipped (L258-262) → bare `INSERT`s collide with the persisted
  rows → PK collision. The failing SQL has no `DELETE` prefix, confirming the misclassification.

### Verified in-repo (no Lamina required)

The `quereus-store` module reproduces this exactly when the catalog is not rehydrated. A
throwaway test (since removed) using a shared `InMemoryKVStore` provider across two `Database`
instances:

- **db1**: register `store`, `declare schema main … { table tablemetadata { id INTEGER PRIMARY
  KEY, name TEXT NOT NULL } seed tablemetadata ((1,'AllSite'),(2,'Other')) }`, then
  `apply schema main with seed` → table created + seeded. ✔
- **db2** (same provider, **no** `rehydrateCatalog`): same `declare` + `apply schema main with
  seed` → **throws** `Failed to apply seed data for table tablemetadata … UNIQUE constraint
  failed: tablemetadata PK.` ✗  (this is the bug)
- **db2'** (same provider, **with** `mod2.rehydrateCatalog(db2)` before apply): the catalog is
  populated → `freshlyCreatedTables` empty → `DELETE`-then-reseed runs → passes. ✔ (proves the
  defect is the ephemeral-catalog signal, exactly as the fix ticket diagnosed)

The store path has no `asOf` fault, so it both reproduces the crash and serves as the
regression harness for the fix.

## Recommended fix — option 2 (INSERT OR REPLACE)

Replace the `DELETE`-then-`INSERT` construction with `INSERT OR REPLACE INTO <tbl> VALUES (…)`
per seed row, and **delete the `freshlyCreatedTables` computation and the `DELETE` entirely**.
After the change the seed loop is just: for each table, emit one `INSERT OR REPLACE` per row.

This works in all three cases:
- genuinely fresh table → no conflict, plain inserts;
- pre-existing table (correctly detected today) → upserts seed rows;
- pre-existing-but-misclassified-on-reopen (the bug) → upserts instead of colliding.

### Why this is safe under the `asOf(ep.startedAt)` snapshot constraint

The original `DELETE`-skip exists because a `DELETE FROM <fresh-table>` is a **query-plan full
scan** routed through the host snapshot resolver at `asOf(ep.startedAt)` — an HLC sampled
*before* the schema-batch fact-group commit, when the table does not yet exist in the fact log
→ fault. `INSERT OR REPLACE` does **not** scan. Its conflict resolution is a **point-key
probe** against the live overlay / effective image (see `store-table.ts:993-1032`
`getOverlayRow`/`checkUniqueConstraints`, and `isolated-table.ts:705-745`
`getOverlayRow`), which reads **pending writes from the current transaction** — including the
`CREATE TABLE` just applied in the same schema batch. So the fresh-table probe sees the table
and finds no conflicting row, rather than resolving a historical snapshot that predates the
table. This is the standard vtab `update()` write-path contract, not a store-specific quirk.

Residual risk is confined to the host implementation: the Lamina vtab's `update()` conflict
probe must likewise read the live/pending image rather than the `asOf` read-snapshot. This is
the expected vtab contract, but it is the one thing that cannot be exercised in-repo — see the
validation TODO.

### Conflict clause choice and semantics

- Use `INSERT OR REPLACE` (seed is authoritative — matches today's wipe-then-reseed intent for
  the pre-existing path: the seed row's values win).
- **Behavior change to call out in the review handoff:** today's `DELETE`-then-`INSERT` on a
  correctly-detected pre-existing table performs a *full reset* — any non-seed rows are removed.
  `INSERT OR REPLACE` upserts the seed PKs and **leaves non-seed rows in place**. For the
  reopen scenario this is strictly better (a reopen must not destroy user data), and it matches
  the documented contract that "seed fires on creation; later opens use no seed." But if any
  caller relied on `with seed` to fully reset a table to exactly the seed rows, that is now a
  no-longer-supported behavior. There are currently **no** `apply schema … with seed` spec
  tests (confirmed), so nothing in the suite pins the old full-reset semantics.
- `OR REPLACE` fires delete+insert semantics on a conflicting row, which can trip
  `ON DELETE CASCADE` on children of a reseeded parent. Seed tables are typically referenced
  parents (e.g. `tablemetadata`); on an unchanged reopen the replaced values are identical, but
  a cascade still fires on the displaced parent. If this is a concern for a referenced seed
  table, `INSERT OR IGNORE` (keep existing rows, skip the seed row) is the no-cascade
  alternative — equivalent outcome when seed values are unchanged. Default to `OR REPLACE`;
  note the tradeoff and let the dev confirm.

## Fallback — option 1 (host create-vs-existed signal)

If host validation shows `OR REPLACE`'s probe is *not* asOf-safe on a fresh Lamina table, fall
back to keying `freshlyCreatedTables` off a real host signal instead of the ephemeral catalog.
The module layer already distinguishes creation (`module.create` / `createBacking`) from
reconnect (`module.connect`, which `store-module.ts` flags `isConnected = true // DDL already
exists in storage`). Surfacing a per-table "backing pre-existed this open" bit from module
registration and keying the wipe/skip off it (rather than `collectSchemaCatalog`) is the
robust-but-heavier path. Documented here so the implementer has a route if option 2's host
validation fails; do not build it unless option 2 is shown unsafe.

## TODO

- [ ] In `schema-declarative.ts:222-290`, remove the `freshlyCreatedTables` block (L240-249)
      and the `actualCatalog`-derived `preApplyTableNames`. Replace the per-table
      `deleteAndInsertSql` construction (L258-274) with one `INSERT OR REPLACE INTO
      <qualifiedTableName> VALUES (…)` per seed row (keep the existing value-literal escaping).
      Update the stale `asOf`/DELETE-skip comment block (L226-239) to explain the new
      idempotent upsert and the point-probe asOf-safety reasoning.
- [ ] Add a regression test for reopen idempotency. Model it on
      `packages/quereus-store/test/rehydrate-catalog.spec.ts` (shared `InMemoryKVStore`
      provider across two `Database` instances). Cover:
      (a) reopen + `apply schema main with seed` **without** `rehydrateCatalog` → no throw,
          table holds exactly the seed rows;
      (b) reopen **with** `rehydrateCatalog` → still passes;
      (c) genuinely-fresh first apply still seeds correctly (no regression).
      Seed syntax is `seed <table> ((row), (row))` (parser: `declareSeedItem`); table body uses
      brace form `table T { id INTEGER PRIMARY KEY, … }`.
- [ ] (Optional, stronger) Add an in-engine memory-vtab test that asserts a re-`apply … with
      seed` on a table that already has BOTH seed rows and an extra user-added row leaves the
      user row intact (pins the new upsert semantics).
- [ ] Validate against the host `asOf` path: confirm (with the dev / a SiteCAD reload, or a
      Lamina unit test) that `INSERT OR REPLACE` on a freshly-created host-backed table in the
      same schema batch does **not** hit the `asOf(ep.startedAt)` pre-commit fault. If it does,
      switch to fallback option 1. Record the outcome in the review handoff.
- [ ] `yarn workspace @quereus/quereus run build` (the seed emitter is in quereus), then run
      the store regression: `node --import ./packages/quereus-store/register.mjs
      node_modules/mocha/bin/mocha.js "packages/quereus-store/test/<new-test>.spec.ts"`.
      Run `yarn lint` in `packages/quereus` and `yarn test` for the touched packages.

## Related / triage

- Primary owner: Quereus (this fix; covers all hosts).
- SiteCAD has a latent contract violation that turned this fatal — it passes `withSeed: true`
  on every open. Filed separately against site-cad as defense-in-depth; this quereus fix is the
  root-cause fix.
