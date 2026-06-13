description: Snapshot bootstrap defers MV maintenance + watch capture per flush and converges once at snapshot end via Database.refreshAllMaterializedViews(), replacing O(flushes × body) full-rebuilds with a single dependency-ordered refresh. Implemented; ready for adversarial review.
files:
  - packages/quereus-sync/src/sync/protocol.ts                 # ApplyToStoreOptions: bootstrap / bootstrapFinalize / bootstrapTables
  - packages/quereus-sync/src/sync/store-adapter.ts            # skip seam on bootstrap; finalizeBootstrap() converges + coarse-notifies
  - packages/quereus-sync/src/sync/snapshot-stream.ts          # flushes carry bootstrap; footer issues finalize from completedTables
  - packages/quereus-sync/src/sync/snapshot.ts                 # one-shot apply carries bootstrap; finalize from snapshot.tables
  - packages/quereus-sync/test/sync/snapshot-bootstrap.spec.ts # NEW — 6 cases
  - docs/materialized-views.md                                 # § External row-change ingestion — bootstrap-deferral note
----

# Snapshot bootstrap: defer MV maintenance to one end-of-snapshot convergence

## What landed

A snapshot bootstrap is a known-complete wholesale apply, so MV maintenance and
`Database.watch` capture are now deferred for the whole load and converged once
at the end via the prereq primitive `Database.refreshAllMaterializedViews()`
(landed in `engine-converge-materialized-views`).

**Protocol (`protocol.ts`).** `ApplyToStoreOptions` gained three optional fields:
`bootstrap` (this flush is one chunk of a wholesale load), `bootstrapFinalize`
(converge + coarse-notify; no data/schema carried), and `bootstrapTables`
(`ReadonlyArray<{ schema; table }>` for the finalize notification).

**Adapter (`store-adapter.ts`).**
- A `bootstrap` flush applies schema + storage rows + emits remote module events
  exactly as before, but **skips the `db.ingestExternalRowChanges` seam call** —
  the seam batch is not even built (guarded push). Removes the per-flush
  transaction/savepoint and the per-flush full-rebuild.
- A `bootstrapFinalize` call routes to a new `finalizeBootstrap(db, options)`
  helper (early-returns before the normal apply body): calls
  `db.refreshAllMaterializedViews()`, then `db.notifyExternalChange(table, schema)`
  per `bootstrapTables` entry **and** per refreshed MV identifier returned by the
  refresh. Note the argument order: `notifyExternalChange(tableName, schemaName?)`.
- Non-bootstrap (incremental) calls are unchanged — the seam still runs with
  capture + per-row MV maintenance. Bootstrap is **per-call, not sticky**.

**Streamed path (`snapshot-stream.ts`).** `flushDataToStore` passes
`{ remote: true, bootstrap: true }`. The `footer` case issues the finalize AFTER
the final data flush + metadata `batch.write()` + HLC update, but BEFORE
`clearSnapshotCheckpoint` and the `status: 'synced'` emit — so a finalize failure
leaves the checkpoint in place and the transfer retries. `bootstrapTables` is
built by `parseBootstrapTables(completedTables)` (`schema.table` → `{ schema, table }`),
which is the full set even on resume (seeded from the checkpoint in the `header` case).

**Non-streamed path (`snapshot.ts`).** PHASE 2 single apply carries
`bootstrap: true`; the finalize is issued after PHASE 3 metadata write + HLC
update and before the `synced` emit, with `bootstrapTables` from `snapshot.tables`.

Both paths keep `throwIfApplyErrors` on the data flush so a per-change storage
failure still aborts before finalize/synced.

## Use cases / validation surface (test floor — treat as a floor, not a ceiling)

`packages/quereus-sync/test/sync/snapshot-bootstrap.spec.ts` (6 cases, all green).
Spies wrap the live `db` instance's `ingestExternalRowChanges` /
`refreshAllMaterializedViews` / `notifyExternalChange` to count calls.

- **Streamed bootstrap > DATA_FLUSH_SIZE (150 rows) over a full-rebuild MV**
  (`select distinct v from t`, arm asserted `'full-rebuild'`): seam called **0×**
  across the (multiple) flushes, `refreshAllMaterializedViews` called **exactly
  1×**, base table has all 150 rows, MV contents correct.
- **Non-streamed `applySnapshot`**: same — seam 0×, refresh 1×, MV correct.
- **Watch capture**: a `full` `Database.watch` on the bootstrapped base table
  receives **exactly one** coarse invalidation (empty `hits`), seam 0× — i.e. one
  whole-table notify, not per-row capture.
- **Resumed snapshot**: checkpoint marks `tableA` completed (skipped), `tableB`
  re-streamed; finalize converges once and coarse-notifies **both** completed
  tables + the refreshed MV; re-streamed MV correct.
- **Mid-bootstrap flush failure** (table absent → store throw): refresh **0×**, no
  `synced` state; after creating the table+MV the SAME snapshot re-applies and
  converges cleanly (seam still 0×, refresh 1×).
- **Post-bootstrap incremental write**: after a bootstrap, a non-bootstrap
  `applyToStore` runs the seam (seam count +1) and maintains the MV; the row-time
  plan is present (re-registered by finalize, not stale).

### Reviewer: things to scrutinize / known gaps

- **Finalize-failure observability.** A throw from `refreshAllMaterializedViews`
  propagates out of `applyToStore` → out of the snapshot apply, leaving the
  checkpoint in place (retry-correct). But unlike a *data-flush* failure (which
  goes through `throwIfApplyErrors` and emits a `status: 'error'` sync-state
  event), a finalize-specific failure emits **no** error sync-state event — the
  callers (`applySnapshot` / `applySnapshotStream`) don't wrap finalize in an
  error-emitting try/catch. The mid-bootstrap-failure test only exercises a
  *flush* failure, not a *finalize* failure. Decide whether finalize failures
  should also emit an error sync-state for observability (would need a wrapper at
  the snapshot-path level). Not done because it matches the existing no-wrapper
  pattern, but it's a real asymmetry worth a verdict.
- **`bootstrapTables` parsing assumes no `.` in schema/table names** (`split('.')`).
  Consistent with the rest of `snapshot-stream.ts`/`store-adapter.ts`
  (`tableKey.split('.')` everywhere), but it is a shared latent assumption.
- **MV-over-MV is delegated to the engine primitive** (prereq) — not separately
  re-tested at the sync layer. Engine `mv-converge-all.spec.ts` (38 passing here,
  incl. a diamond DAG) pins the ordering. A sync-level MV-over-MV bootstrap test
  would be additive but not load-bearing.
- **`create materialized view` mid-bootstrap** (a `schema-migration` chunk):
  reasoned correct (create-time materialize against a possibly-partial source,
  corrected by finalize) but not explicitly tested.
- **Watch-capture "before" not pinned.** The test asserts exactly-one coarse fire
  + seam 0×; it does not run the pre-change (per-flush capture) behavior to show
  the contrast. The seam-0 assertion makes the single fire unambiguously the
  coarse notify, so this is sufficient but not a literal before/after.

## Validation run

- `yarn workspace @quereus/sync test` → **190 passing**, 0 failing. (The
  `[Sync] Error handling …: batch write failed` / `iterate failed` console lines
  are pre-existing negative-path tests in `sync-manager.spec.ts:1211/1243`, not
  failures.) Note the workspace name is `@quereus/sync` — the original ticket's
  `@quereus/quereus-sync` does not exist.
- New spec in isolation → **6 passing**.
- `@quereus/sync` src typecheck (`tsc --noEmit`) → clean; test typecheck
  (`tsc -p tsconfig.test.json --noEmit`) → clean.
- `yarn workspace @quereus/quereus run lint` (eslint + test-file tsc) → clean, exit 0.
- Engine convergence interaction: `node test-runner.mjs --grep converge` → **38
  passing** (the engine-side `refreshAllMaterializedViews` ordering tests).

Did **not** run the full cross-workspace `yarn test` (engine sqllogic suite is
large and my diff is isolated to `quereus-sync` + a gitignored engine `dist`
rebuild). The engine method interaction is exercised end-to-end by the new sync
tests (real `Database`, real store-backed tables, real MVs). No pre-existing
failures encountered; `.pre-existing-error.md` not written.

Note: the engine `dist/` had to be rebuilt (`yarn workspace @quereus/quereus run
build`) because the prereq's committed source post-dated the built `.d.ts`, so
`@quereus/quereus`'s published types lacked `refreshAllMaterializedViews`. `dist`
is gitignored, so it does not appear in the diff.

## End
