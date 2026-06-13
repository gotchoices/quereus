description: Snapshot bootstrap defers MV maintenance + watch capture per flush and converges once at snapshot end via Database.refreshAllMaterializedViews(), replacing O(flushes × body) full-rebuilds with a single dependency-ordered refresh. Implemented and reviewed.
files:
  - packages/quereus-sync/src/sync/protocol.ts                 # ApplyToStoreOptions: bootstrap / bootstrapFinalize / bootstrapTables
  - packages/quereus-sync/src/sync/store-adapter.ts            # skip seam on bootstrap; finalizeBootstrap() converges + coarse-notifies
  - packages/quereus-sync/src/sync/snapshot-stream.ts          # flushes carry bootstrap; footer issues finalize from completedTables
  - packages/quereus-sync/src/sync/snapshot.ts                 # one-shot apply carries bootstrap; finalize from snapshot.tables
  - packages/quereus-sync/test/sync/snapshot-bootstrap.spec.ts # 6 cases
  - docs/materialized-views.md                                 # § External row-change ingestion — bootstrap-deferral note
----

# Snapshot bootstrap: defer MV maintenance to one end-of-snapshot convergence

## What landed

A snapshot bootstrap is a known-complete wholesale apply, so MV maintenance and
`Database.watch` capture are deferred for the whole load and converged once at
the end via the prereq primitive `Database.refreshAllMaterializedViews()`
(landed in `engine-converge-materialized-views`).

- **Protocol** — `ApplyToStoreOptions` gained `bootstrap` (this flush is one
  chunk of a wholesale load → adapter skips the seam), `bootstrapFinalize`
  (converge + coarse-notify; no data/schema carried), `bootstrapTables`
  (`{ schema; table }[]` for the finalize notification).
- **Adapter** — a `bootstrap` flush applies schema + storage rows + remote module
  events but does not build or call the seam batch; `bootstrapFinalize` routes to
  `finalizeBootstrap`, which calls `refreshAllMaterializedViews()` then
  `notifyExternalChange(table, schema)` per bootstrapped table and per refreshed
  MV. Bootstrap is per-call, not sticky — the next incremental apply runs the
  seam normally.
- **Streamed path** — flushes pass `{ remote, bootstrap }`; the footer issues the
  finalize after the final data flush + metadata write + HLC update, but before
  `clearSnapshotCheckpoint` / `synced`, so a finalize failure is retriable.
  `bootstrapTables` is built from `completedTables` (full set even on resume).
- **Non-streamed path** — PHASE 2 single apply carries `bootstrap`; finalize after
  PHASE 3 metadata + HLC, before `synced`, with `bootstrapTables` from
  `snapshot.tables`.

## Review findings

**What was checked.** Read the implement diff (e6d608a6) fresh before the
handoff: `protocol.ts`, `store-adapter.ts`, `snapshot-stream.ts`, `snapshot.ts`,
`docs/materialized-views.md`, and the new spec. Verified against the engine:
`Database.notifyExternalChange(tableName, schemaName?)` argument order (correct in
the adapter), `Database.refreshAllMaterializedViews()` contract (returns
`{schemaName,name}[]`, `[]` with no MVs/no transaction, dependency-ordered —
ordering pinned by engine `mv-converge-all.spec.ts`). Enumerated every
`applyToStore` caller: only the two snapshot paths set `bootstrap`; the
incremental `change-applicator.ts` path is correctly unchanged (still seams +
emits `status:'error'` on throw). Checked retry semantics (finalize-before-
checkpoint-clear in both paths), the resume path's `completedTables`
seed-then-notify, type safety, and DRY (`parseBootstrapTables` mirrors the
module-wide `split('.')` convention).

**Validation run (all green).**
- `yarn workspace @quereus/sync test` → **190 passing**, 0 failing. (The
  `[Sync] Error handling …: batch write failed` / `iterate failed` console lines
  are the pre-existing negative-path tests in `sync-manager.spec.ts:1211/1243`.)
- `yarn workspace @quereus/quereus run lint` (eslint + test-file tsc) → exit 0.
- `@quereus/sync` `typecheck` (src) → exit 0; `tsc -p tsconfig.test.json --noEmit`
  (tests) → exit 0.

**MAJOR — filed as a new ticket.**
- *Global assertions are no longer enforced over bootstrapped data.* The seam
  bundles four facets — capture, MV maintenance, FK actions, **and commit-time
  global-assertion evaluation** (pinned by `store-adapter-seam.spec.ts` ›
  "assertion failure propagates"). The bootstrap skips the seam *entirely* and
  the finalize only refreshes MVs + notifies, so a snapshot installs data without
  ever checking `create assertion` invariants. The implement docs/comments framed
  the skip as dropping only "MV maintenance + capture" and called the skipped
  seam "a pure no-op" — inaccurate when assertions exist. The change is defensible
  under trust-the-origin (and per-flush evaluation over partial snapshot data was
  itself spurious-failure-prone), but it is an undocumented semantic change with
  no end-of-snapshot validation. The trust-vs-revalidate decision needs human
  sign-off and, for the revalidate option, a new engine "evaluate all assertions"
  primitive. → `tickets/backlog/sync-bootstrap-assertion-enforcement.md`.

**MINOR — fixed in this pass.**
- Corrected the "pure no-op" inaccuracy: the `store-adapter.ts` bootstrap doc
  comment and the `docs/materialized-views.md` deferral note now state that
  skipping the seam also skips commit-time global-assertion evaluation (with the
  trust-the-origin rationale and a pointer to the backlog ticket).

**MINOR — documented, intentionally not fixed.**
- *Finalize over-refreshes ALL MVs.* `refreshAllMaterializedViews()` rebuilds
  every maintained table in the database — including MVs over local tables that
  were not part of the snapshot — and coarse-notifies each. This is by design of
  the engine primitive the ticket chose. Correctness-safe (a full rebuild is
  always correct; over-notification only costs a watcher an extra re-query); it is
  a performance/over-notification cost, not a bug. Acceptable for the wholesale-
  load use case.
- *Finalize failure emits no `status:'error'` sync-state event.* The snapshot
  paths (`applySnapshot` / `applySnapshotStream`) have never wrapped their
  `applyToStore` calls in an error-emitting try/catch — only collected per-change
  errors surface an error state, via `throwIfApplyErrors`. A finalize throw (like
  any hard throw from the data flush) propagates without an error event. This is a
  pre-existing snapshot-path characteristic, not a regression introduced here; the
  retry path is correct (checkpoint survives). Wrapping both snapshot paths for
  observability is a reasonable follow-up but out of this ticket's scope.
- *`split('.')` on `schema.table` keys assumes no `.` in identifiers.* A latent
  module-wide assumption (`tableKey.split('.')` everywhere in `store-adapter.ts` /
  `snapshot-stream.ts`), not introduced by this ticket.

**Test gap — noted, not closed.**
- *`create materialized view` arriving mid-bootstrap (a `schema-migration` chunk)*
  is reasoned-correct (created against a possibly-partial source, corrected by the
  finalize) but untested at the sync layer. The `SchemaMigrationType` enum has no
  MV-specific variant and the path routes through `applySchemaChange`'s table-
  event expectation, so a meaningful test would be probing an under-specified
  path rather than pinning this ticket's core; engine `mv-converge-all.spec.ts`
  already pins the convergence ordering (incl. MV-over-MV and a diamond DAG). Left
  as a documented residual; could be added when the MV-via-migration path is
  firmed up.

**Disposition summary.** 1 major → backlog ticket filed; 2 minor doc/comment
inaccuracies fixed inline; 3 minor items + 1 test gap documented as acceptable or
out-of-scope. The implemented behavior (seam skipped per flush, single converge +
coarse-notify at finalize, retriable on failure, per-call not sticky) is correct
and covered by the 6 new cases plus the engine convergence suite.
