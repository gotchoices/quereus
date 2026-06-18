description: When a table that was deleted comes back, the edits that were being held on its behalf get replayed into it automatically instead of sitting unused until they expire.
prereq:
files:
  - packages/quereus-sync/src/metadata/quarantine.ts          # held entries (add delete-by-change)
  - packages/quereus-sync/src/metadata/keys.ts                # buildQuarantineKey / buildQuarantineScanBounds (reused)
  - packages/quereus-sync/src/sync/change-applicator.ts       # new drainHeldChanges (sibling of applyChanges); reuses resolveChange/commitChangeMetadata/admitGroup
  - packages/quereus-sync/src/sync/sync-context.ts            # add column-name accessor for the in-basis gate + schema-drift filter
  - packages/quereus-sync/src/sync/admission.ts               # admitGroup (reused)
  - packages/quereus-sync/src/sync/manager.ts                 # SyncManager interface: add drainHeldChanges
  - packages/quereus-sync/src/sync/sync-manager-impl.ts       # implement drainHeldChanges + getTableColumnNames; delegate; emit
  - packages/quereus-sync/src/sync/events.ts                  # onHeldChangesDrained / emitHeldChangesDrained
  - packages/quereus-sync/src/index.ts                        # export any new public types
  - packages/quereus-sync-client/test/sync-client.spec.ts     # MockSyncManager: add drainHeldChanges
  - packages/quereus-sync/test/sync/unknown-table-disposition.spec.ts   # sibling suite for the hold half
  - docs/migration.md                                         # § 4 Contract — document the drain/revival path
difficulty: medium
----

# Drain held out-of-basis changes when their table reappears locally

When a peer holds straggler changes for a table it no longer has — `quarantine`d
or `store-and-forward` (forwardable) entries in the `qt:` store (see the completed
`sync-unknown-table-disposition` and `sync-store-and-forward-*` work) — and that
table later **reappears** in the local basis (re-created app-side, or a
`create_table` for it arrives in an inbound batch), the held changes for it should
be **replayed into the now-present table** through the normal resolution path
rather than waiting on horizon GC or only being relayed to other peers.

A held change is a held change regardless of *why* it was held: this feature
applies identically to plain `quarantine` and forwardable `store-and-forward`
entries. The shipped dispositions already prevent write loss (held changes are
operator-inspectable and reclaimed at the horizon; forwardable ones additionally
reach holders); this ticket closes the timeliness gap on the *revival* path.

## Design decisions (resolved — do not re-litigate)

**Trigger: host-driven sweep, NOT inline in the apply batch.** Add a public
`SyncManager.drainHeldChanges(schema?, table?): Promise<number>`, sibling to
`pruneTombstones` / `pruneQuarantine` / `evictExpiredBasisTables`. The host calls
it from the same periodic maintenance path (and may call it right after it
re-creates a table or applies an inbound `create_table`). The library adds no
timer and does **not** drain inline during `applyChanges`.

Rationale (this settles the ticket's open questions #1 and #2):
- Reappearance happens two ways — an inbound `create_table` migration **and** a
  plain app-side re-create with no inbound DDL. A host-driven sweep handles both
  uniformly; an inline `create_table` hook would miss the app-side case.
- Draining inline would have to interleave older held changes with the same
  batch's fresh changes inside one admission unit (the "drain inside vs. after the
  admission" hazard the plan flagged). Running drain as a **separate** apply, after
  any re-creating batch has fully committed, eliminates that interaction: fresh
  data is already in storage and the drained (older) changes simply LWW-resolve
  against it. No new ordering invariant is introduced.

**Scope semantics mirror `QuarantineStore.list(schema?, table?)`:**
- `drainHeldChanges(schema, table)` — drain one table's held entries.
- `drainHeldChanges(schema)` — drain all held entries in that schema.
- `drainHeldChanges()` — sweep: drain every held entry whose table is now in basis.
- Bounded by the held set (itself bounded by the retention horizon); zero-cost when
  nothing is held.

**Requires the basis oracle.** Drain is a no-op (returns 0) when no `getTableSchema`
oracle was wired — exactly as unknown-table *detection* is inert and
`evictExpiredBasisTables` is a no-op without `dropLocalTable`. Without the oracle a
relay-only coordinator cannot tell which held tables are "back", and replaying into
a table the store does not have would just hit the adapter's defensive throw and
abort. So: oracle absent ⇒ drain does nothing.

**Replay path — reuse, don't duplicate.** `drainHeldChanges` is a new exported
function in `change-applicator.ts` that mirrors the data branch of `applyChanges`
but omits the schema-migration and unknown-table-divert machinery:
1. List held entries for the target scope (`quarantine.list(schema?, table?)`).
2. Group by `(schema, table)`. For each group, resolve the current table state via
   the oracle (`SyncContext.getTableColumnNames`, new — see below). A group whose
   table is **not** in basis (oracle returns `undefined`) is **skipped entirely**
   (its entries stay held).
3. For each held change in a present table:
   - **Schema-drift filter:** if it is a `column` change whose `column` is no longer
     in the current table's column set, treat it as resolved-and-dropped (do not
     send it to `resolveChange` or the store) — the migration intentionally removed
     that column. Still delete its held entry (step 5). This is what keeps a stale
     column from poisoning the whole admission unit (see Edge cases).
   - Otherwise run it through the existing `resolveChange(ctx, change)` — identical
     LWW / tombstone-blocking / `allowResurrection` semantics as a fresh receive.
4. Admit the resolved set via `admitGroup` (data first → metadata second), reusing
   `commitChangeMetadata` (its `keepMaxHLC` in-batch dedup already collapses
   multiple held versions of one `(pk, column)` to the max-HLC winner). Do **not**
   pass `watermarkHLC`: these HLCs were already merged into the local clock at the
   original receive (`applyChanges` merges `maxHLC` of the batch even for diverted
   changes), so re-merging is an idempotent no-op — omit it to keep drain a pure
   replay.
5. In the **same** `commitMetadata` callback, stage deletion of every held entry
   that was *considered* this drain (applied, skipped, conflict, or drift-dropped),
   so the hold clears atomically with the apply. Add `QuarantineStore.delete(batch,
   change)` that rebuilds the `qt:` key from the change via `buildQuarantineKey`
   (symmetric with `put`). Entries for absent tables are never touched.
6. Emit `onHeldChangesDrained` once per drained table and emit `emitRemoteChange`
   for the applied changes (grouped by origin `change.hlc.siteId`, mirroring
   `applyChanges`) so MV maintenance / watches / UI react to the revival.

**Why deleting on a non-applied (LWW-loss / blocked / drift) outcome is correct.**
Once a held change has been resolved against the present table and lost, holding it
longer changes nothing — a future drain resolves it identically. Leaving it would
mean an LWW-losing held change never clears until horizon GC. So a held entry is
removed once its table is present and it has been run through resolution; only
entries for still-absent tables remain held.

**Telemetry — no double-count.** Add a dedicated `onHeldChangesDrained` event
(`{ schema, table, drained, applied, skipped }`) and return the total drained count.
Do **not** fold drain into `getUnknownTableStats()`: that counter partitions *divert
dispositions* (`ignored` / `quarantined` / `forwarded` / `relayed`); drain is the
reverse lifecycle phase and conflating it would muddy the partition. A forwardable
entry that was already relayed and is now drained is fine — receivers are idempotent
by original HLC, and `relayed` (cumulative, observe-only) is unaffected; deleting the
entry merely stops *future* relays, which is correct now that the change is a real
local version relayed via the normal change-log path.

## Interfaces

```ts
// sync/manager.ts (SyncManager)
/**
 * Replay held out-of-basis changes (quarantine + forwardable) into tables that
 * have since reappeared in the local basis. Host-driven — call from the same
 * maintenance path as pruneTombstones / pruneQuarantine / evictExpiredBasisTables,
 * or right after re-creating a table. No-op (returns 0) without a getTableSchema
 * oracle. Returns the number of held entries drained (cleared from the hold).
 */
drainHeldChanges(schema?: string, table?: string): Promise<number>;

// sync/sync-context.ts (SyncContext) — new accessor backing the gate + drift filter
/** Current column names for an in-basis table, or undefined if outside the basis
 *  (or no oracle). Implemented via getTableSchema in SyncManagerImpl. */
getTableColumnNames(schema: string, table: string): readonly string[] | undefined;

// metadata/quarantine.ts (QuarantineStore)
/** Stage deletion of a held entry by its change (rebuilds the qt: key, symmetric
 *  with put). Used by the drain path to clear entries atomically with the apply. */
delete(batch: WriteBatch, change: Change): void;

// sync/events.ts
interface HeldChangesDrainedEvent { schema: string; table: string; drained: number; applied: number; skipped: number; }
onHeldChangesDrained(listener: (event: HeldChangesDrainedEvent) => void): Unsubscribe;
emitHeldChangesDrained(event: HeldChangesDrainedEvent): void;
```

`change-applicator.ts` gains `export async function drainHeldChanges(ctx:
SyncContext, schema?: string, table?: string): Promise<number>`; `SyncManagerImpl`
delegates to it and implements `getTableColumnNames` from `this.getTableSchema`.

## Edge cases & interactions

- **Table still absent (scoped or sweep).** Group skipped; entries remain held;
  returns 0 for that group. A scoped `drainHeldChanges('main','orders')` on an
  absent table is a clean no-op.
- **No basis oracle (relay-only coordinator).** Whole call is a no-op returning 0.
  Add an explicit test.
- **Schema drift on re-create (poison-entry guard).** Table reappears with a column
  dropped/renamed since the held change was captured. A held `column` change for an
  absent column is drift-dropped (resolved-and-deleted, never sent to the store), so
  one stale entry cannot abort the table's whole drain admission. Delete changes for
  a now-absent pk are store no-ops (deleting an absent row is not an error), so they
  do not poison either. Test: hold a column change for `c`, re-create the table
  without `c`, drain → entry cleared, no throw, other entries for present columns
  applied.
- **LWW loss / conflict (local wins).** Resolved as `conflict`/`skipped`, not
  applied, entry still deleted. Test: present table already has a newer version of
  the cell; drain → 0 applied, entry cleared, value unchanged.
- **Tombstone-blocking / resurrection disabled.** A held column change for a pk
  tombstoned since retirement is blocked by `resolveChange` (`isDeletedAndBlocking`,
  `allowResurrection=false`); entry cleared, row stays deleted. With
  `allowResurrection=true` it resurrects. Reuse the existing semantics; test both.
- **Multiple held versions of one (pk, column).** Distinct HLC ⇒ distinct held
  entries; `commitChangeMetadata`'s `keepMaxHLC` collapses to the max-HLC winner;
  all such entries are cleared. Test.
- **Mixed column + delete held entries for the same pk.** Both resolve independently
  (distinct change-log entry types); reuse the existing mixed-batch handling.
- **Crash mid-drain (idempotency).** Data + metadata + held-entry deletes are one
  admission unit; a data-apply failure aborts before `commitMetadata`, so nothing
  commits and the entries stay held — re-drained next sweep (HLC-keyed, safe).
- **Re-create + fresh data for T in the same inbound batch.** Because drain runs
  *after* `applyChanges`, the fresh data is committed first; the older held changes
  LWW-resolve against it (older loses by HLC, newer-than-fresh wins). Converges with
  no intra-admission interleaving. Test the ordering both ways (held older than
  fresh, held newer than fresh).
- **Forwardable entry drained.** Removed from the hold ⇒ no longer surfaced by
  `listForwardable` ⇒ relayed thereafter via the normal change-log (it is a real
  version now), not the forwardable path. `relayed` telemetry unaffected. Test that
  `listForwardable()` no longer returns it post-drain.
- **Idempotent re-drain.** A second `drainHeldChanges` after a successful one finds
  the entries gone ⇒ returns 0; no duplicate store writes.
- **Self-origin entries.** Cannot occur (echo skip precedes diversion in
  `applyChanges`); `resolveChange` would defensively skip+clear anyway.
- **`emitRemoteChange` on revival.** Applied drained changes emit remote-change
  events so downstream reactivity fires, identical to a fresh remote apply.

## Out of scope (deferred deliberately)

- **Inline drain on inbound `create_table`.** A future optimization to drain the
  instant the DDL lands in a batch, without waiting for the host's next maintenance
  tick. Deferred because of the admission-unit ordering care it needs and because
  the host-driven sweep already covers correctness/timeliness for both reappearance
  modes. If pursued later, file a separate ticket.

## Tests (key cases — write up front, TDD)

Extend `packages/quereus-sync/test/sync/unknown-table-disposition.spec.ts` (the
hold-half sibling) with a `drainHeldChanges` describe block. Expected outcomes:

- Hold a quarantine change for retired `orders`; re-add `orders` to the basis;
  `drainHeldChanges('main','orders')` ⇒ returns 1, the value is now queryable in
  `orders`, `quarantine.list('main','orders')` is empty, one `onHeldChangesDrained`
  fired with `applied: 1`.
- Sweep form `drainHeldChanges()` drains held entries for tables now in basis and
  leaves entries for still-absent tables untouched (mixed scenario, assert counts).
- Forwardable (`store-and-forward`) entry drains identically and disappears from
  `listForwardable()` afterward.
- Schema-drift: held column change for a column absent on re-create ⇒ cleared, no
  throw, sibling entries for present columns applied.
- LWW loss: present newer cell ⇒ 0 applied, entry cleared, value unchanged.
- Tombstone-blocked (allowResurrection=false) ⇒ blocked, entry cleared, row stays
  deleted; allowResurrection=true ⇒ resurrected.
- No oracle ⇒ `drainHeldChanges` returns 0 and touches nothing.
- Re-create + fresh data ordering both ways converges by HLC.
- Idempotent re-drain returns 0.

## TODO

- Add `QuarantineStore.delete(batch, change)` (rebuild key via `buildQuarantineKey`).
- Add `SyncContext.getTableColumnNames` and implement it in `SyncManagerImpl` via
  `getTableSchema`.
- Add `HeldChangesDrainedEvent` + `onHeldChangesDrained` / `emitHeldChangesDrained`
  to `events.ts` (interface + impl); export the event type from `index.ts`.
- Implement `drainHeldChanges(ctx, schema?, table?)` in `change-applicator.ts`
  (list → group → gate on basis → drift-filter → `resolveChange` →
  `commitChangeMetadata` + entry deletes in one `admitGroup` unit → emit).
- Add `drainHeldChanges(schema?, table?)` to the `SyncManager` interface and
  delegate from `SyncManagerImpl`.
- Add `drainHeldChanges` to `MockSyncManager` in
  `packages/quereus-sync-client/test/sync-client.spec.ts` (return 0).
- Write the test cases above.
- Update `docs/migration.md` § 4 Contract (Unknown-table disposition) with a short
  "Revival / drain" paragraph: held changes are replayed into a reappeared table via
  the host-driven `drainHeldChanges`, resolved like any inbound change, cleared from
  the hold on resolution; relay-only / no-oracle peers are no-ops.
- Run `yarn workspace @quereus/quereus-sync test` and the repo `yarn lint`
  (single-quote globs on Windows), streaming output with `Tee-Object`.
