description: Incoming sync batches on one device are now applied one at a time, so two batches changing the same cell can no longer leave the row with one value and sync's records with another.
architecture: docs/sync-transactions.md#transactional-integrity-during-sync
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # applyQueue field (~285), enqueueApply (~911), applyChanges / drainHeldChanges (~1970), recordLensDeployment's drains (~794), appliesDrained (~2015)
  - packages/quereus-sync/src/sync/sync-context.ts # whenAppliesSettled doc
  - packages/quereus-sync/src/sync/change-applicator.ts # fileAtNextTick doc comment only
  - packages/quereus-sync/test/sync/concurrent-apply.spec.ts # reproduction test + receiver helper shared with bug-sync-local-edit-during-apply-diverges
  - packages/quereus-sync/test/sync/late-arrival-delta.spec.ts # removed 'applies that overlap on one replica'
  - docs/sync-transactions.md # § Filing position: "Applies run one at a time", rewritten "Commit order equals position order"
----

## What was built

An apply decides each incoming cell against the cell's stored record, writes the row, and files its records last. Before this ticket a second apply could do all three steps in between, which left the row with the newer value and the record with the older one, plus a stale change-log entry.

`SyncManagerImpl` now runs remote applies through a FIFO queue (`applyQueue`, appended to by `enqueueApply`). Each entry starts once the previous one has settled. A failed entry passes its failure to its caller and does not block the queue. These entry points go through it:

- `applyChanges`
- `drainHeldChanges` (used by maintenance and the quoomb-web local-create drain)
- both branches of `recordLensDeployment`'s reactive drain

`whenAppliesSettled()` returns the queue tail, and adoption (`appliesDrained`) still waits for the queue to empty before it joins the commit chain. An apply's own follow-up drain (`drainReappearedTables`) calls the change applicator directly and stays off the queue. Filing stays on the commit chain, which orders an apply's positions against local capture's.

Snapshot applies are not queued. The sync client already drops incoming deltas while it bootstraps from a snapshot (`handleChanges`, `isBootstrapping`). A `NOTE:` at the queue records the choice.

## Review findings

**Diff read first** (`ticket(implement): sync-serialize-applies`): `enqueueApply`, the four call sites, `whenAppliesSettled` / `appliesDrained`, the doc and comment rewrites, the new spec, and the removed late-arrival test.

**Correctness of the queue: no defects.**
- `enqueueApply`: a synchronous throw inside `apply` becomes a rejected `running` (it runs inside `then`). `applyQueue` is always reset to a promise that never rejects, so one failure cannot block the queue. The identity loop in `appliesDrained` is still correct, because each enqueue replaces the tail.
- Re-entrancy: checked each claim in the handoff against the code.
  - `whenAppliesSettled` is awaited only in `unrecorded-rows.ts` `writesSettled`. That is reached from `findTablesWithUnrecordedRows`, which runs outside any apply and off the commit chain.
  - `recordLensDeployment` is reached only from the engine's `apply schema` statement (`notifyLensDeploymentAll` in `schema-declarative.ts`, then the store and isolation modules). There `_isExecuting()` is true, so the deferred `void` branch is taken.
  - The `void`-ed drain cannot reject unhandled: `drainReappearedTables` catches and logs every per-table failure.
- Host callers: the sync client (`handleChanges`), the coordinator (`coordinator-service.ts` push and S3 replay), maintenance passes, and quoomb-web's `createLocalCreateDrainListener` (fire-and-forget). None of them waits on an apply from inside an apply or a statement, so none can deadlock.
- Adoption ordering: `applyChanges` waits on the commit chain before its first read of records or rows (`change-applicator.ts` ~326), and so does `drainTableGroup` (~908). The adoption comment's "an apply waits on the chain first thing once it starts" is accurate. `drainHeldChanges` reads the quarantine list before that wait, but it touches neither rows nor records.

**Tests:**
- Confirmed the reproduction catches the defect. With `applyChanges` temporarily calling `applyChangesImpl` directly (file restored afterwards, `git status` clean), the test fails on the in-flight assertion (row reads 7 while the older apply is held). With the queue it passes.
- The unused `before` hook in the spec's receiver is kept: `bug-sync-local-edit-during-apply-diverges` (in `implement/`, prereq on this ticket) uses it for its window-A cases. Removing the old overlapping-apply test was correct, because that interleaving can no longer happen. No tests added or cut in review.

**Docs:**
- Read `docs/sync-transactions.md` § Filing position and § Transactional Integrity During Sync, and searched `docs/` and `packages/quereus-sync/src` for "not serialized", overlap and `trackApply` / `appliesInFlight` wording. Nothing stale remains.
- `docs/sync-unknown-tables.md`'s "two concurrent applies … cannot both see it absent" is still true, as the handoff says.

**Ticket edit:**
- Added a line to `bug-sync-local-edit-during-apply-diverges` noting that the landed helper is `makeReceiver()` returning `{ db, manager, hook }`, not the `makeReceiver(hook)` sketch it quotes.

**Tripwires (already parked by the implementer as `NOTE:`s at `applyQueue`; reviewed, no change):**
- Throughput: one manager now applies one batch at a time. If coordinator latency shows up, serialize per table.
- A delta apply can still overlap a snapshot apply. The client-side bootstrap guard covers the common path. A delta apply already in flight when a bootstrap starts can still overlap, as before this ticket.
- The `appliesDrained` starvation `NOTE:` was reworded for the queue. Its meaning is unchanged.

**Major findings / new tickets:** none, because no defect was found that needs work beyond this ticket.

**Validation:**
- `yarn workspace @quereus/sync typecheck`: clean
- `yarn workspace @quereus/sync test`: 869 passing
- `yarn workspace @quereus/sync-client test`: 118 passing
- `yarn workspace @quereus/sync-coordinator test`: 141 passing
- Lint is a no-op in these packages.
- `yarn build` was not re-run, because review changed no source.
