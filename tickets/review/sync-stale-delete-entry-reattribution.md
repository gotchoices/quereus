description: Review the delete-change-log-entry dedup that restores the scan-time transaction-bound invariant in collectChangesSince (delete→reinsert→delete key reuse no longer splits a later transaction).
prereq:
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # recordDataEvent delete branch dedup (~347-365); rewritten LOAD-BEARING INVARIANT comment in collectChangesSince (~474-490)
  - packages/quereus-sync/src/sync/change-applicator.ts        # Tombstone import; ResolvedChange.oldTombstone; resolveChange applied-delete return; commitChangeMetadata delete-branch dedup
  - packages/quereus-sync/test/sync/sync-manager.spec.ts       # un-skipped regression test + new multi-round delta walk test (~260-360)
  - docs/sync.md                                               # § Transaction-granularity bounding — caveat replaced with a both-kinds-deduped note (~302-309)
difficulty: medium
----

# Review: dedupe stale delete change-log entries (scan-time transaction split fix)

## What changed and why

`collectChangesSince` detects transaction boundaries off the **log entry's** HLC
(`deterministicTxnId(logEntry.hlc)`), while `buildTransactionChangeSets` groups off the
**resolved version's** HLC (a delete log entry resolves to `tombstone.hlc`). The scan-time
bound only equals the grouped bound when, for every non-null-resolving log entry,
`logEntry.hlc === resolvedVersion.hlc`.

That held for **column** entries (an overwrite deletes the prior `cl:` entry on both write
and apply paths) but **not** for **delete** entries — `deleteEntryBatch(...,'delete',...)`
was never called. A `delete → reinsert(key reuse) → delete` on one pk left the first
delete's `@hlc_d1` entry behind; after the second delete the tombstone is `@hlc_d2`, so the
stale `@hlc_d1` entry resolves (non-null) to `RowDeletion(hlc_d2)` and **re-attributes** to
the later transaction. With `batchSize` smaller than the delta, the scan-time loop counted
that resolved change under the *earlier* log transaction, hit the bound one boundary early,
and split a later multi-fact transaction (`{ delete pk[1], insert pk[2] }`) across two
`getChangesSince` rounds — violating the "a transaction is never split" guarantee.

**Fix:** dedupe a pk's stale delete change-log entry whenever a newer tombstone replaces it
(mirroring the column dedup), so at most one delete entry survives per pk with HLC equal to
the current tombstone. Boundary detection and grouping then agree again.

- **Write path** (`recordDataEvent` delete branch): before recording the new tombstone,
  `getTombstone(pk)`; if present, `deleteEntryBatch(existing.hlc, 'delete', …)`.
- **Apply path** (`resolveChange` + `commitChangeMetadata`): plumb the already-fetched prior
  tombstone through a new `ResolvedChange.oldTombstone` field (mirrors `oldColumnVersion`);
  in `commitChangeMetadata`'s delete branch, delete `oldTombstone.hlc`'s stale entry before
  recording the new one. No second `getTombstone` read.
- Rewrote the LOAD-BEARING INVARIANT comment in `collectChangesSince` to state the invariant
  now holds for **both** entry kinds (each deduped on overwrite).
- `docs/sync.md`: replaced the "Known edge case (delete key-reuse)" caveat with a one-line
  "both entry kinds are deduped on overwrite" note.

`deleteEntryBatch` already accepts `entryType: 'delete'` (key built generically) — no
signature change.

## Validation performed

- `yarn workspace @quereus/sync test` → **256 passing** (was ~254; +1 un-skipped regression,
  +1 new multi-round test). The console error/`Oversized transaction` lines in output are
  from tests that intentionally exercise failure/oversized paths, not regressions.
- `yarn workspace @quereus/sync typecheck` (`tsc --noEmit` over src) → clean.
- ts-node type-checks test files on load (no `transpileOnly` in `tsconfig.test.json`), so the
  new/un-skipped tests compile clean as part of the passing run.
- `yarn lint` in `packages/quereus` → clean (note: this lints the `quereus` package, not
  `quereus-sync`; sync type-safety is covered by the typecheck + test run above).

## Use cases to scrutinize

- **Acceptance (write path):** un-skipped `does not split a transaction when a stale delete
  entry re-attributes` (single-round shape: the ChangeSet with the pk[1] delete also carries
  the pk[2] insert).
- **Acceptance (multi-round):** new `walks a multi-round delta over a delete→reinsert→delete
  key reuse with no repeats, gaps, or split` — `batchSize=1`, surviving txns `{column pk[10]}`,
  `{column pk[20]}`, `{delete pk[1], insert pk[2]}`; asserts across watermark-advancing rounds:
  unique transaction ids, strictly ascending `hlc`, the delete surfaces in exactly one
  ChangeSet that also carries pk[2], and exactly the surviving facts once each.
- Sanity to re-confirm: existing column-dedup round-trip / scan-footprint tests still green
  (the change must not perturb the column path).

## Known gaps / reviewer attention (honest handoff)

- **Apply-path dedup has no direct test.** The `commitChangeMetadata` delete-branch dedup is
  implemented for symmetry and to preserve the same scan invariant on a relay/coordinator
  that records via `applyChanges`. It is exercised indirectly (existing apply-path delete
  tests stay green) but there is **no test that applies two increasing-HLC deletes for one pk
  and asserts the older delete `cl:` entry is removed**. A local reinsert between two deletes
  is *not* reachable on the apply path under the default `allowResurrection: false` (the
  reinsert column change is blocked by `isDeletedAndBlocking`), so the apply-path scenario to
  cover is `applyChanges(delete d1)` then `applyChanges(delete d2 > d1)` on the same pk →
  assert one surviving delete entry. Consider adding this; it is the main coverage floor gap.
- **Direct change-log assertion.** Tests assert behavior through `getChangesSince` output
  (no repeats/gaps/split), not by inspecting `cl:` keys directly. That is the user-facing
  contract, but a reviewer wanting belt-and-suspenders could add a `cl:`-range count check
  after the key-reuse sequence to assert exactly one delete entry physically survives.
- **Out of scope (do not expand here; noted per ticket):** a row *delete* removes `cv:` rows
  via `deleteRowVersions` but leaves the row's `cl:` *column* entries behind. They resolve to
  null and are correctly skipped (not a correctness bug), but they inflate the bounded scan
  footprint the extraction work targeted. Cleaning them is a separate optimization — file a
  follow-up if deemed worthwhile, don't fold it in.
