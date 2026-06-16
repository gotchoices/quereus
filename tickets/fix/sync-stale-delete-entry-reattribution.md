description: Scan-time bound in collectChangesSince can split a transaction when a stale delete change-log entry re-attributes to a later tombstone HLC (delete→reinsert→delete key reuse). Delete change-log entries are never deduped, so the first delete's entry survives and resolves to the second delete's tombstone; the scan-time bound counts it under the wrong (earlier) transaction, breaks early, and emits a later multi-fact transaction missing some of its facts (the rest arrive next round). Confirmed reproducible via local DML under the default config.
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # collectChangesSince (scan-time bound), recordDataEvent (local delete branch ~347-360)
  - packages/quereus-sync/src/sync/change-applicator.ts        # commitChangeMetadata delete branch (~303-305) — apply-path delete
  - packages/quereus-sync/src/metadata/change-log.ts           # deleteEntryBatch (only ever called with 'column')
  - packages/quereus-sync/src/metadata/tombstones.ts           # getTombstone / setTombstoneBatch
  - packages/quereus-sync/test/sync/sync-manager.spec.ts       # skipped regression "does not split a transaction when a stale delete entry re-attributes" — un-skip
  - docs/sync.md                                               # § Transaction-granularity bounding — "Known edge case (delete key-reuse)" note
difficulty: medium
----

# Fix: stale delete change-log entry splits a transaction under the scan-time bound

## Symptom (confirmed)

With `batchSize = 1`, the following sequence of **local** commits (default config,
`allowResurrection: false`):

1. `insert pk[1] = ['a']`
2. `delete pk[1]`
3. `insert pk[1] = ['b']`   (key reuse)
4. one transaction: `{ delete pk[1], insert pk[2] = ['z'] }`

`getChangesSince(peer, sinceHLC=0)` returns a **single ChangeSet for transaction (4)
containing only the pk[1] delete — the pk[2] insert is missing**. The insert arrives on
the *next* `getChangesSince` round (after the watermark advances), so transaction (4)
is split across two rounds. This violates the documented "a transaction is **never**
split" guarantee and the bounded-extraction ticket's "byte-identical response" claim,
and leaves a window where the peer has transaction (4) partially applied.

A skipped regression test encodes this exact case:
`test/sync/sync-manager.spec.ts` → "does not split a transaction when a stale delete
entry re-attributes" (currently `it.skip`). Un-skip it as the acceptance test.

## Root cause

`collectChangesSince` (post `sync-getchangessince-bounded-extraction`) detects
transaction boundaries using **`logEntry.hlc`**, but `buildTransactionChangeSets`
groups using the **resolved version's HLC** (`resolveLogEntry` returns `cv.hlc` for
columns, `tombstone.hlc` for deletes). The scan-time bound is only equivalent to the
grouped bound when, for every non-null-resolving log entry,
`logEntry.hlc === resolvedVersion.hlc`.

That invariant holds for **column** entries: an overwrite deletes the prior change-log
entry (`recordColumnVersions` in sync-manager-impl.ts and `commitChangeMetadata` in
change-applicator.ts both call `changeLog.deleteEntryBatch(..., 'column', ...)`), so at
most one entry survives per `(pk, column)` and its HLC is the current `cv.hlc`.

It does **not** hold for **delete** entries: `deleteEntryBatch` is never called with
`'delete'`. When a primary key is deleted, reinserted, and deleted again, the first
delete's change-log entry (`@hlc_d1`) is left behind. After the second delete the
tombstone is `@hlc_d2`, so the stale `@hlc_d1` entry resolves (non-null) to
`RowDeletion(hlc_d2)` — it **re-attributes** to the later transaction. The scan-time
loop counts that resolved change under the *earlier* log transaction, reaches
`batchSize` one boundary too early, and `break`s before scanning the later
transaction's remaining facts. (Local reinsert does not consult tombstones, so this is
reachable with `allowResurrection: false`.)

Note: the pre-bounding code also produced a (harmless) *duplicate* delete in the
grouped output for this sequence; the new scan-time bound converts that latent quirk
into a transaction split.

## Suggested fix (preferred)

Restore the invariant by deduping delete entries the same way columns are deduped:
when recording a deletion, first look up any existing tombstone for the pk and, if
present, delete its stale change-log entry before recording the new one.

- `recordDataEvent` (delete branch, sync-manager-impl.ts ~347): before
  `recordDeletionBatch`, `getTombstone(schema, table, pk)`; if present,
  `changeLog.deleteEntryBatch(batch, existing.hlc, 'delete', schema, table, pk)`.
- `commitChangeMetadata` (delete branch, change-applicator.ts ~303): same — the apply
  path already threads conflict/old-version state, so plumb the prior tombstone HLC (or
  look it up) and delete its stale entry.

This makes at most one delete entry survive per pk with HLC equal to the current
tombstone, so scan-time boundary detection and grouping agree again. It also removes
the pre-existing duplicate-delete emission.

Consider whether stale **column** change-log entries left behind by a row *delete*
(`deleteRowVersions` removes the `cv:` rows but not their `cl:` column entries — those
resolve to null and are correctly skipped) deserve cleanup too; not required for
correctness (they add 0 to the bound and emit no Change), but they inflate the scan
footprint the bounding work aimed to shrink.

## Alternative considered (rejected)

Keying boundary detection off the *resolved* change's HLC instead of `logEntry.hlc`
re-breaks contiguity: a re-attributed entry appears at its log position (before the
later transaction's own entries), so `currentTxnId` would jump out of order and the
boundary counter would mis-fire. Dedup at write time is the clean fix.

## Acceptance

- Un-skip the regression test; it passes.
- Existing 254 sync tests stay green.
- Add a delete→reinsert→delete coverage case to the round-trip / multi-round delta
  tests (mixed with a multi-fact transaction and a `batchSize` smaller than the delta)
  asserting no repeats/gaps and no split across rounds.
- Update `docs/sync.md` to remove the "Known edge case (delete key-reuse)" caveat once
  closed.
