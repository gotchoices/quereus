description: Bound getChangesSince's delta extraction at scan time. collectChangesSince early-exits the HLC-ordered change-log scan once batchSize whole transactions accumulate, instead of draining the whole iterator and truncating in buildTransactionChangeSets. Reviewed: scan-time bound is correct for column entries; a delete→reinsert→delete key-reuse edge case where it splits a transaction was found, documented, and filed as a follow-up fix ticket.
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # collectChangesSince (early-exit + invariant doc), resolveLogEntry, getChangesSince
  - packages/quereus-sync/test/sync/sync-manager.spec.ts        # scan-time bound test + skipped reattribution regression
  - packages/quereus-sync/src/sync/change-grouping.ts           # buildTransactionChangeSets — unchanged; bound semantics matched
  - packages/quereus-sync/src/metadata/change-log.ts            # getChangesSince iterator (HLC-ordered) — unchanged
  - docs/sync.md                                                # § Transaction-granularity bounding — scan-time note + edge-case caveat
----

# Complete: bound `getChangesSince` extraction at scan time

## What shipped

`collectChangesSince(peerSiteId, sinceHLC, batchSize)` early-exits the HLC-ordered
change-log scan: it tracks the current transaction identity (`deterministicTxnId`
excluding `opSeq`), folds each completed transaction's data-change count into a running
total, and `break`s once the total reaches `batchSize` — abandoning the iterator before
the next transaction. Fact resolution was extracted into `resolveLogEntry`. The from-zero
full scan and the `sm:` migration scan are intentionally left unbounded (documented).
`getChangesSince` passes `config.batchSize` through.

Result: for the common case the grouped response is unchanged; only the scan footprint
shrinks. Bounding tested by counting `cl:` entries pulled from the store.

## Review findings

### Scope checked
- Read the full implement diff (`4295da1e`) before the handoff summary.
- Verified the HLC-ordering / contiguity claim against the actual change-log key layout
  (`keys.ts`: `cl:` + 30-byte HLC (`wallTime|counter|siteId|opSeq`) + type + suffix) —
  contiguity holds; transaction identity is the key prefix before `opSeq`.
- Cross-checked the early-exit bound against `buildTransactionChangeSets`
  (`change-grouping.ts`) — accumulate-whole-transactions-until-`>= batchSize`-then-break
  matches, and feeding the bounded prefix back is idempotent.
- Traced the DDL-only / DDL-interleaved migration cases (the suggested reviewer check):
  migrations are scanned in full and grouping drops any past the bounded fact watermark
  — correct.
- Inspected both write paths (`recordColumnVersions` local; `commitChangeMetadata`
  apply) and the delete/tombstone paths.
- Type safety / unused locals: `tsc --noEmit` clean; `ChangeLogEntry`,
  `deterministicTxnId`, `IterateOptions`, `KVEntry` all referenced.
- Tests: `yarn workspace @quereus/sync run test` → **254 passing, 1 pending** (the new
  skipped regression). The `batch write failed` / `iterate failed` lines are the
  pre-existing deliberate-sabotage error-handling tests. No `lint` script exists for
  `@quereus/sync` (only `@quereus/quereus` has one); typecheck is the available gate.

### Major — found, filed (not fixed inline)
**The scan-time bound can split a transaction when a stale delete change-log entry
re-attributes to a later tombstone HLC.** Boundary detection keys off `logEntry.hlc`,
but grouping keys off the *resolved* version's HLC. These agree for column entries
(overwrite deletes the prior change-log entry) but **not** for delete entries
(`deleteEntryBatch` is never called with `'delete'`). A `delete → reinsert → delete`
key-reuse sequence (reachable via ordinary local DML under the default
`allowResurrection: false`, since local reinserts don't consult tombstones) leaves a
stale delete entry that resolves to the second delete's tombstone, mis-counts the bound,
and emits a later **multi-fact** transaction missing some facts — confirmed reproducible:
`getChangesSince` returned the delete transaction with the `pk[1]` delete but **without**
the `pk[2]` insert committed in the same transaction. This contradicts the "byte-identical
response" / "never split" claims.

Disposition: filed `tickets/fix/sync-stale-delete-entry-reattribution.md` (preferred fix:
dedup delete entries at write time, mirroring the column path). Added a **skipped**
regression test (`it.skip`, un-skip when the fix lands) encoding the exact repro.

### Minor — fixed inline this pass
- Documented the **load-bearing invariant** in `collectChangesSince`'s doc comment
  (`logEntry.hlc === resolvedVersion.hlc` for non-null resolves), why it holds for
  columns, and the delete-entry exception — the implementer's correctness argument
  relied on this implicitly without stating it.
- Added an honest **"Known edge case (delete key-reuse)"** caveat to `docs/sync.md`
  alongside the scan-time bounding section.

### Carried forward from handoff (still accurate, not regressions)
- From-zero full scan (`collectAllChanges`) unbounded by design (snapshot path).
- `sm:` migration scan fully drained; pathological un-synced DDL volume still
  materializes — accepted by the original ticket.
- Response memory unchanged (scan-side win only).

### Empty categories
- **Performance / resource cleanup**: no concerns. The early-exit strictly reduces work
  and abandons the async iterator via `break` (the `for await` cleans up the underlying
  KV iterator). No leaks introduced.
- **DRY / modularity**: `resolveLogEntry` extraction is a clean dedup of the
  column/tombstone resolution; no further duplication found.
