description: When a deleted table comes back, the sync edits that were being held for it are now automatically replayed into it instead of sitting unused until they expire.
prereq:
files:
  - packages/quereus-sync/src/metadata/quarantine.ts          # QuarantineStore.delete(batch, change) — symmetric with put
  - packages/quereus-sync/src/sync/change-applicator.ts       # drainHeldChanges + drainTableGroup + extracted emitRemoteChanges
  - packages/quereus-sync/src/sync/sync-context.ts            # SyncContext.getTableColumnNames
  - packages/quereus-sync/src/sync/sync-manager-impl.ts       # getTableColumnNames impl + drainHeldChanges delegate
  - packages/quereus-sync/src/sync/manager.ts                 # SyncManager.drainHeldChanges
  - packages/quereus-sync/src/sync/events.ts                  # HeldChangesDrainedEvent + on/emitHeldChangesDrained
  - packages/quereus-sync/src/index.ts                        # export HeldChangesDrainedEvent
  - packages/quereus-sync/test/sync/unknown-table-disposition.spec.ts   # drain describe block + harness upgrade
  - packages/quereus-sync-client/test/sync-client.spec.ts     # MockSyncManager.drainHeldChanges (+ 3 pre-existing stubs)
  - docs/migration.md                                         # § 4 Contract — Revival / drain paragraph + gaps note
difficulty: medium
----

# Review: drain held out-of-basis changes when their table reappears

## What was built

A held change (`quarantine` or forwardable `store-and-forward`, in the `qt:` store)
for a table the peer has retired no longer waits on horizon GC once that table
**reappears** in the local basis. A new host-driven sweep replays the held changes
into the now-present table through the normal resolution path, then clears them.

Public surface: `SyncManager.drainHeldChanges(schema?, table?): Promise<number>` —
a sibling of `pruneTombstones` / `pruneQuarantine` / `evictExpiredBasisTables`. The
host calls it from its periodic maintenance path (or right after re-creating a
table). The library adds **no timer** and never drains inline during `applyChanges`.

Implementation = `drainHeldChanges(ctx, schema?, table?)` in `change-applicator.ts`
(exported, delegated to from `SyncManagerImpl`):
1. `quarantine.list(schema?, table?)` → group by `(schema, table)`.
2. Per group, gate on `ctx.getTableColumnNames(schema, table)` (new accessor backed
   by `getTableSchema`): `undefined` ⇒ table not back (or no oracle) ⇒ group skipped,
   entries stay held.
3. Per held change in a present table: drift-drop a `column` change whose column is
   gone from the re-created table (resolved-and-cleared, never sent to the store);
   otherwise run `resolveChange` (identical LWW / tombstone-block / `allowResurrection`).
4. One `admitGroup` unit: data first → `commitChangeMetadata` + `quarantine.delete`
   of **every considered held entry** (applied, LWW-lost, blocked, or drift-dropped)
   second. **No `watermarkHLC`** (HLCs were merged at the original receive).
5. Emit `onRemoteChange` (grouped by each held change's original `hlc.siteId`) for the
   applied changes + one `onHeldChangesDrained {schema,table,drained,applied,skipped}`
   per drained table. Returns total entries cleared.

`emitRemoteChanges` was extracted from `applyChanges` and is now shared by both paths
(wire apply groups by the relaying changeset's `siteId`; drain groups by origin
`hlc.siteId`). Behavior-identical for `applyChanges` — covered by existing tests.

## Why deleting a non-applied (LWW-loss / blocked / drift) held entry is correct

Once a held change has been resolved against the present table and lost, holding it
longer changes nothing (a later drain resolves it identically). Only entries for
**still-absent** tables remain held. This is the deliberate design decision in the
ticket, not an oversight.

## Use cases / validation map (what the tests assert)

New `drainHeldChanges (revival)` describe block in
`unknown-table-disposition.spec.ts`. The harness was upgraded with a **mutable basis**
(`basis` set + `columnsByTable` map, read live by the oracle so a retired table can be
flipped back mid-test via the `reappear` helper) and a **tiny in-memory data store**
in `applyToStore` so a drained value is queryable. Captured `onHeldChangesDrained` and
`onRemoteChange` streams. Cases:

- Scoped drain of a quarantine change → returns 1, value queryable, hold cleared, one
  drained event (`applied:1`), `onRemoteChange` fired keyed by origin.
- Sweep form `drainHeldChanges()` drains present tables, leaves still-absent ones held.
- Forwardable (`store-and-forward`) entry drains and disappears from `listForwardable()`.
- Schema-drift: held column change for an absent column cleared (no throw), sibling
  present-column change applied (`drained:2, applied:1, skipped:1`).
- LWW loss vs. a newer present cell → `applied:0, skipped:1`, entry cleared, value stands.
- Ordering: a held change **newer** than fresh data wins (converges by HLC).
- Tombstone-blocked (`allowResurrection=false`) → cleared, row stays deleted;
  `allowResurrection=true` with a held HLC past the tombstone → resurrects.
- Multiple held versions of one `(pk, column)` collapse to the max-HLC winner; all cleared.
- Mixed column + delete for one pk both resolve; later delete leaves the row gone.
- Scoped drain of a still-absent table → clean no-op (0, nothing touched).
- No basis oracle → 0, held entry untouched.
- Idempotent re-drain → 0.

## Validation run

- `yarn workspace @quereus/sync typecheck` → clean.
- `yarn workspace @quereus/sync test` → **405 passing** (includes the new block). The
  console `[Sync] ... failed` lines are other suites exercising error paths, not failures.
- `yarn workspace @quereus/sync-client typecheck` → clean; `... test` → **49 passing**.
- `yarn lint` (engine package) → clean (engine untouched; sanity gate only).

## Honest gaps / reviewer attention

- **Tests use an in-memory `applyToStore` stub, not the real store adapter**
  (`createStoreAdapter`). So the drain is NOT exercised end-to-end through the engine
  seam: no real MV maintenance, no `Database.watch` capture, and the "delete of an
  absent pk is a store no-op" / forwardable→drain→relay-stops lifecycle claims are
  verified only at the CRDT-metadata + stub-store level. An integration test through
  the real adapter (LevelDB or the memory vtab seam) would harden the revival path —
  treat the current suite as a floor.
- **No production caller wires `drainHeldChanges` into a host maintenance loop.** This
  is by design (library API; the host decides cadence), but the quoomb-web worker /
  sync-coordinator paths that already call `pruneTombstones` / `pruneQuarantine` /
  `evictExpiredBasisTables` do **not** call `drainHeldChanges`. If host wiring is
  wanted, it's a follow-up (file separately) — out of scope here.
- **Crash-mid-drain idempotency is reasoned, not directly tested.** Correctness rests
  on `admitGroup` ordering (data-apply failure aborts before `commitMetadata`, so the
  held entries stay held). A test that makes `applyToStore` throw during a drain and
  asserts the entries remain held + a re-drain succeeds would pin it.
- **`onHeldChangesDrained.applied` counts each resolved-applied held change** even when
  several collapse to one surviving cell (mirrors `applyChanges`' `applied` counter);
  `applied + skipped === drained` always holds. Confirm this accounting is acceptable.
- **Side fix beyond the ticket's literal scope (flagged):** `MockSyncManager` in
  `sync-client.spec.ts` was missing `recordLensDeployment` / `getBasisTableLifecycle` /
  `evictExpiredBasisTables` at HEAD (left incomplete by the basis-lifecycle ticket),
  which made `@quereus/sync-client` fail `tsc`. Since the file was a listed target and
  I was editing the mock anyway, I added those three stubs so the package typechecks.
  Small, low-risk, but note it touches lifecycle territory the drain ticket doesn't own.
- **Deferred deliberately (per ticket, do not implement here):** inline drain on an
  inbound `create_table` (drain the instant the DDL lands, without waiting for the next
  maintenance tick). The host-driven sweep already covers correctness/timeliness for
  both reappearance modes; file a separate ticket if the optimization is wanted.
