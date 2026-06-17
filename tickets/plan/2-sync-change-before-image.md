description: Optional inline before-image on the sync wire — carry `priorValue` / `priorHlc` on `ColumnChange` (and the prior row image on `RowDeletion`), mirroring Lamina's `UpdateCellFact(new_value, prior_value?, prior_hlc?)`. Lets a receiver populate ConflictEvent without a metadata re-read, validate transition constraints against the source's prior state, and support cheap undo/audit. Purely additive — receivers ignore it when absent.
files:
  - packages/quereus-sync/src/sync/protocol.ts             # ColumnChange / RowDeletion / ConflictContext
  - packages/quereus-sync/src/sync/sync-manager-impl.ts     # handleDataChange has oldRow/newRow available from DataChangeEvent
  - packages/quereus-sync/src/sync/events.ts                # ConflictEvent (localValue/remoteValue already modeled)
  - packages/quereus-store/src/common/events.ts             # DataChangeEvent already carries oldRow/newRow
  - docs/sync.md                                            # § Sync Protocol / Data Structures, § Reactive Hooks
----

# Optional inline before-image on change facts

## Motivation

Lamina's `UpdateCellFact` carries `(new_value, prior_value?, prior_hlc?)` — the
inline before-image makes per-cell history O(1) and lets "give me the previous
value of this cell" resolve without a backward scan (../lamina/docs/architecture.md §4).

Quereus already wants this in two places:

- `ConflictContext` (`protocol.ts:359`) and `ConflictEvent` (`events.ts`) carry
  `localValue` / `remoteValue`; today the local side is fetched by a metadata
  read at conflict time.
- The engine has `committed.tablename` transition constraints that compare
  current vs. committed state — a sync-wire before-image is the analog that lets
  a receiver validate transitions against the *origin's* prior state.

And the raw material is already on hand: `DataChangeEvent` (store `events.ts`)
carries `oldRow` / `newRow`, so the origin can populate a before-image at record
time at no extra read cost.

## Expected shape

Add **optional** fields, additive to the wire (receivers ignore when absent):

```ts
interface ColumnChange {
  // …existing…
  readonly priorValue?: SqlValue;   // value this write overwrote at the origin
  readonly priorHlc?: HLC;          // HLC of the overwritten value (disambiguates equal-HLC sites)
}

interface RowDeletion {
  // …existing…
  readonly priorRow?: Row;          // last-known row image at the origin (audit/undo)
}
```

Uses unlocked: ConflictEvent populated without a re-read; transition-constraint
validation at the seam; cheap undo / audit trails; debugging of LWW outcomes.

## Notes

- Cheaper for Quereus than Lamina: Quereus does **not** content-hash segments,
  so there is no "prior_value is immutable / must not be stripped" obligation —
  it is a best-effort hint a writer may omit and a reader may ignore.
- Interacts with `sync-seam-throw-retry-mv-divergence`: a before-image is part of
  the "effective before/after images" a re-driven seam would need to recompute
  derived effects for already-committed rows.
- Keep the field optional and the conflict-resolution fast path unchanged when
  it is absent (the no-`conflictResolver` HLC fast path must not regress).
