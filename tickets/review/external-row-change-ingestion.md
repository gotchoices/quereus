description: Review the batch ingestion seam (`Database.ingestExternalRowChanges`) — externally-applied row changes drive change capture, batch-amortized row-time MV maintenance, and opt-in FK actions inside the coordinated transaction.
files:
  - packages/quereus/src/core/database-external-changes.ts        # NEW — the batch driver (savepoint lifecycle, facet dispatch, flush, implicit-txn finalization)
  - packages/quereus/src/core/database-internal.ts                # ExternalRowChange + IngestExternalChangesOptions types; ingestExternalRowChanges declaration; two-arg seam jsdoc cross-ref
  - packages/quereus/src/core/database.ts                         # public ingestExternalRowChanges method (thin delegate); _maintainRowTimeCoveringStructures jsdoc updated
  - packages/quereus/src/index.ts                                 # exports ExternalRowChange, IngestExternalChangesOptions, BackingRowChange
  - packages/quereus/test/external-row-change-ingestion.spec.ts   # NEW — 20 tests
  - docs/materialized-views.md                                    # new § External row-change ingestion (+ seam-routing paragraph at end of § Synchronous…)
  - docs/incremental-maintenance.md                               # external-writes blockquote + cross-reference entry
----

# External row-change ingestion (review)

## What was built

`Database.ingestExternalRowChanges(changes, options?)` — a batch seam for writes a
host applied directly to module storage (bypassing the DML executor). Per ordered
change it runs, in DML-executor order: (a) change capture (`_record*` → watch
post-commit dispatch + commit-time global assertions, default ON), (b) row-time MV
maintenance (default ON, batch-amortized: one `BackingConnectionCache`, one deferred
full-rebuild set, one flush per batch), (c) parent-side FK actions (default OFF —
POST-application transitive RESTRICT walk, then CASCADE/SET NULL/SET DEFAULT, both
with `lensRouted = false`). No new maintenance machinery — the driver only
orchestrates existing pieces.

Batch algorithm (mirrors `runWithStatementSavepoints` — the batch is the external
analogue of one statement): empty-batch early return → exec mutex for the whole
batch → `_ensureTransaction` → `__external_batch_<n>` savepoint broadcast
(module-scope counter, like `stmtSavepointCounter`) → per-change facet loop
(TableSchema memoized per batch; unknown table/schema → NOTFOUND before any effect;
row-arity mismatch → MISUSE) → `_flushDeferredRebuilds` BEFORE savepoint release →
on throw: rollback-and-release savepoint, roll back the implicit txn if seam-started,
rethrow → on success: commit the implicit txn (watch dispatch fires there). Holding
the mutex makes the `_isImplicitTransaction()` gate exact (no statement can be
mid-flight, so an implicit txn observed at finalization was started by this call).

`tableKey` is built from the RESOLVED schema (`schemaName.tableName`) — byte-identical
to the DML executor's key, so capture/watch matching has executor parity.
`schemaName` defaults to `schemaManager.getCurrentSchemaName()`.

Decisions implemented as specified in the plan (recorded in
docs/materialized-views.md § External row-change ingestion — do not re-open):
facet defaults (capture ON / MV ON / FK OFF, per-call only, no policy registry);
trust boundary (re-validates NOTHING; covering-UNIQUE backings maintained blindly,
last-writer-wins); module data events are NOT a facet (external writer owns emission
+ `remote` flag); `notifyExternalChange` stays as the coarse alternative
(cross-referenced both ways); two-arg `_maintainRowTimeCoveringStructures` unchanged
(jsdoc on both sides now routes between the two seams); DML-replay decision matrix
landed in the docs.

## How to validate / use

```ts
// Host applied rows directly to storage (e.g. sync-inbound), now reports them:
await db.ingestExternalRowChanges([
  { tableName: 'users', change: { op: 'insert', newRow: [1, 'alice'] } },
  { tableName: 'users', change: { op: 'update', oldRow: [1, 'alice'], newRow: [1, 'al'] } },
], { applyForeignKeyActions: false }); // defaults: capture+MV on, FK off
```

Run: `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js
"packages/quereus/test/external-row-change-ingestion.spec.ts"` (from repo root).

Validation done: `yarn build` (all packages), `yarn lint` (quereus, clean),
`yarn test` (all workspaces green; 5610 passing in quereus incl. the 20 new tests).
`yarn test:store` NOT run — the seam touches no store code path (judgment call per
ticket: "only if a store-path concern emerges").

## Test coverage (the floor — verify and extend adversarially)

- Inverse-projection MV: insert / PK-move update / delete / multi-row batch incl.
  same-row-twice (ordered before-image contract) / `maintainMaterializedViews: false`.
- Full-rebuild MV (`select distinct …`, plan kind asserted via manager internals):
  3 direct `vtab.update()` storage writes + one seam batch → MV reflects all
  (single flush asserted via final state only — no rebuild counter).
- Watch: row-granular hits post-commit with capture on; silent with
  `captureChanges: false`.
- FK facet: cascade reaches children AND grandchildren; cascaded child writes get
  their own capture (watch on child fires) and MV maintenance (MV over child
  converges); facet off by default; insert = per-change no-op; `pragma
  foreign_keys = off` + facet on = no action, no error.
- RESTRICT mid-batch: throws, earlier change's backing delta unwound, no watch,
  no transaction left open (implicit case).
- Transactions: implicit commits at batch end; explicit — in-txn visibility, watch
  waits for caller commit, rollback discards backing + capture in lockstep.
- Validation: unknown table/schema → NOTFOUND zero-effect; arity → MISUSE with batch
  unwound; empty batch begins no transaction.

## Known gaps / flags for the reviewer

- **Global assertions**: capture feeding commit-time assertion evaluation is
  documented but has no direct test (no `create assertion` driven via the seam).
  Indirect coverage only, via the shared `_record*` path.
- **Explicit-txn mid-batch error**: the contract "caller transaction left open with
  the savepoint unwound" is documented but only the implicit-txn error path is
  tested directly (the explicit rollback test covers lockstep discard, not the
  error-inside-explicit-txn shape).
- **Maintenance arms**: only inverse-projection and full-rebuild are driven through
  the seam; residual-recompute / prefix-delete / join-residual share
  `maintainRowTime` with the executor (indirect coverage). The full-rebuild "exactly
  one rebuild per batch" is asserted by final state, not an instrumented counter
  (cf. `maintenance-equivalence.spec.ts`'s counter technique if stronger assertion
  is wanted).
- **Non-default schema**: only the NOTFOUND negative is tested; no positive
  `schemaName: '<attached>'` batch.
- **Memory module only**: external writes are simulated with the memory vtab
  (matches the ticket's test plan); no store-module run.
- The FK facet's POST-application RESTRICT walk reads child tables via
  `db.prepare(...)._iterateRowsRaw()` (no mutex re-entry — same as the executor
  path); worth a second pair of eyes on the do-not-call-from-within-a-statement
  deadlock contract being documentation-only (no runtime re-entrancy guard).
