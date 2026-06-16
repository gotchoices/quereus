description: Dedup stale delete change-log entries so collectChangesSince's scan-time transaction-bound invariant holds for delete entries (delete→reinsert→delete key reuse no longer splits a later transaction). Reviewed and completed.
prereq:
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # recordDataEvent delete-branch dedup (~347-361); collectChangesSince LOAD-BEARING INVARIANT (~485-502)
  - packages/quereus-sync/src/sync/change-applicator.ts        # ResolvedChange.oldTombstone; resolveChange delete return; commitChangeMetadata delete-branch dedup
  - packages/quereus-sync/test/sync/sync-manager.spec.ts       # un-skipped regression test + multi-round delta walk test (~260-360); new apply-path dedup test (~671)
  - docs/sync.md                                               # § Transaction-granularity bounding note (~302-308)
difficulty: medium
----

# Dedup stale delete change-log entries (scan-time transaction split fix) — COMPLETE

## Summary

`collectChangesSince` detects transaction boundaries off the **log entry's** HLC while
`buildTransactionChangeSets` groups off the **resolved version's** HLC. They agree only when
every non-null-resolving log entry has `logEntry.hlc === resolvedVersion.hlc`. That held for
column entries (deduped on overwrite) but not for delete entries, so a
`delete → reinsert(key reuse) → delete` left the first delete's `@hlc_d1` entry behind; it
resolved to the later tombstone `@hlc_d2` and re-attributed to the later transaction, letting
the scan-time bound (under a small `batchSize`) split a later multi-fact transaction across
two `getChangesSince` rounds.

The implementation dedupes a pk's stale delete change-log entry whenever a newer tombstone
replaces it — on the **write path** (`recordDataEvent`: `getTombstone` then
`deleteEntryBatch(existing.hlc, 'delete', …)`) and on the **apply path** (new
`ResolvedChange.oldTombstone` plumbed from `resolveChange` into `commitChangeMetadata`). The
`collectChangesSince` LOAD-BEARING INVARIANT comment and `docs/sync.md` were updated to state
the invariant now holds for both entry kinds.

## Review findings

### Scope reviewed
- The full implement diff (`f32bf08e`) read first, before the handoff summary: both dedup
  sites, the `ResolvedChange.oldTombstone` plumbing, the rewritten invariant comment, the
  doc edit, and both tests.
- Correctness of the write-path dedup against the delete→reinsert→delete sequence (verified
  the local reinsert does **not** clear the d1 tombstone — `recordColumnVersions` never
  touches tombstones — so `getTombstone` at the second delete returns d1 and the dedup fires).
- Apply-path resolve→commit batching semantics (`applyChanges` 3-phase pipeline) and the
  conditions under which `oldTombstone` is populated (only when a strictly-newer tombstone is
  applied; older-or-equal deletes are skipped upstream — correct).
- Type safety (`Tombstone` import, `oldTombstone?: Tombstone` mirrors `oldColumnVersion?`),
  `deleteEntryBatch` signature reuse (`'delete'` entry type, no `column` arg — correct).
- Resource cleanup / DRY: dedup mirrors the column path exactly; no extra store reads on the
  apply path (reuses the already-fetched `existingTombstone`).
- Docs: re-read `docs/sync.md` § transaction-granularity bounding — the caveat was correctly
  replaced with a "both entry kinds deduped on overwrite" note that matches the code.

### Found & fixed in this pass (minor)
- **Apply-path dedup had no direct test** (flagged by the implementer as the main coverage
  floor gap). Added `dedupes the stale delete change-log entry when a newer tombstone is
  applied` to the `applyChanges` describe block: two increasing-HLC deletes for one pk applied
  in **separate** `applyChanges` calls (so the first tombstone is committed before the second
  resolves and sees it as `oldTombstone`), asserting `getChangesSince` surfaces the pk delete
  exactly once at the newer HLC. Verified it is a genuine regression guard — temporarily
  disabling the `commitChangeMetadata` delete-branch dedup makes the surviving-stale-entry
  resolve twice (assertion fails). Suite: **257 passing** (was 256).

### Filed as follow-up (major)
- **Apply-path within-batch dedup gap** → `tickets/fix/sync-apply-path-within-batch-dedup.md`.
  The apply-path dedup keys off the prior version read in Phase 1 (`resolveChange`) against
  **pre-batch** state, so two versions of the same key arriving in **one** `applyChanges`
  batch (e.g. concurrent deletes of one pk from two origin sites, relayed together) both
  survive in the change log and re-attribute the older entry to the later version's HLC —
  re-introducing the exact split/duplicate-fact hazard on a relay node. Confirmed the
  **column** path has the identical latent gap and that it **pre-dates** this ticket (the
  implement commit does not touch `oldColumnVersion`); the delete path now reaches parity
  with it. Reachable only with ≥3 nodes, so out of scope for the single-node fix this ticket
  delivered, but a real correctness edge worth its own fix.

### Observed, not actioned (pre-existing, unrelated)
- `packages/quereus-sync/test/sync/conflict-resolvers.spec.ts:14-15` imports
  `DataChangeToApply` and `SchemaChangeToApply` but never uses them. The normal ts-node test
  run does not enforce `noUnusedLocals` (the errors only surface transiently on a forced
  recompile), and the file is unrelated to this ticket's diff, so the suite is green. Left for
  the runner's pre-existing-error triage / a future cleanup — not a failure in the committed
  state.
- **Row-delete leaves `cl:` column entries behind** (`deleteRowVersions` clears `cv:` rows but
  not the row's `cl:` column entries). They resolve to null and are correctly skipped (not a
  correctness bug); they only inflate the bounded-scan footprint. Already noted as out of
  scope by the implementer; not folded in.

### Validation
- `yarn workspace @quereus/sync test` → **257 passing** (the implementer's +1 un-skipped
  regression and +1 multi-round walk, plus this pass's +1 apply-path dedup test). The
  `console.error` / `Oversized transaction` lines in output are from tests that intentionally
  exercise failure / oversized paths, not regressions.
- `yarn workspace @quereus/sync typecheck` (`tsc --noEmit`) → clean.
- `yarn lint` (quereus package) not re-run: it lints `@quereus/quereus`, which this diff does
  not touch; the meaningful gate for these changes is the sync typecheck + test run above
  (both green). `@quereus/sync` has no lint script.

## Outcome

The scan-time transaction-bound invariant holds for delete entries on the local write path,
verified by the un-skipped single-round regression test and the `batchSize=1` multi-round
delta walk. The apply-path dedup is in place with direct coverage for the across-calls case;
the within-batch case is carved out into a follow-up fix ticket.
