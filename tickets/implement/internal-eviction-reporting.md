description: Make internal REPLACE evictions (a UNIQUE conflict resolved against a row at a *different* PK) visible to the DML executor via a new `UpdateResult.evictedRows`, so the one post-write pipeline (change-tracking, row-time MV maintenance, FK ON DELETE cascade, auto-events) runs for them uniformly across memory / store / isolation. Replaces `covering-mv-isolation-layer-enforcement-routing`: once evictions are reported, the isolation layer gets covering-MV backing consistency for free without importing any covering-MV code, and a confirmed FK/change/event gap closes everywhere.
prereq:
files: packages/quereus/src/common/types.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus-isolation/src/isolated-table.ts, packages/quereus/test/logic/54-covering-mv-enforcement.sqllogic, packages/quereus/test/covering-structure.spec.ts, packages/quereus-store/test/unique-constraints.spec.ts, docs/materialized-views.md, docs/module-authoring.md, docs/runtime.md
----

## Problem (confirmed)

A REPLACE conflict resolution comes in two physically distinct shapes, and the engine
only reports one of them upward.

1. **PK-collision REPLACE** — the new row lands on an *occupied PK*. The displaced row
   has the *same PK*. Every substrate surfaces it as `UpdateResult.replacedRow`
   (`manager.ts performInsert`/`performUpdateWithKeyChange`, `store-table.ts` insert/update,
   `isolated-table.ts attachReplacedUnderlying`). The DML executor (`dml-executor.ts`)
   consumes `result.replacedRow` and runs the **full post-write pipeline**: change-tracking
   (`_recordUpdate` / `_recordDelete`), `maintainRowTimeStructures`,
   `executeForeignKeyActions`, and `emitAutoDataEvent`.

2. **Secondary-UNIQUE REPLACE eviction** — the new row satisfies the PK but collides on a
   *non-PK* UNIQUE constraint with some other row at a *different PK*. That row is evicted.
   This eviction is recorded directly on storage inside `vtab.update()`
   (`targetLayer.recordDelete` / `deleteRowAt` / overlay tombstone) and the check returns
   `null` / `continue`. **It is never surfaced in `UpdateResult`.** The executor never sees
   it, so none of the four post-write steps run for it.

The only compensation in the tree today is a single inline
`db._maintainRowTimeCoveringStructures({ op:'delete', oldRow })` call hand-pasted into the
memory `checkUniqueViaMaterializedView` and the store `findUniqueConflictViaCoveringMv`
REPLACE branches. That patches exactly **one** of the four cross-cuts (covering-MV backing
maintenance) on exactly the covering-MV detection path. The result:

- **FK ON DELETE CASCADE / SET NULL** never fire for a secondary-UNIQUE eviction on any
  substrate — children of the evicted row are orphaned (divergence from REPLACE semantics).
- **Change-tracking** (`Database.watch` / `getChangeScope`) never sees the eviction delete.
- **Auto data-events** never emit the eviction delete.
- The **isolation** path (`isolated-table.ts checkMergedUniqueConstraints`) misses even the
  covering-MV backing maintenance, because it owns its own merged-view detection and never
  calls the substrate covering-MV routing — the original symptom that
  `covering-mv-isolation-layer-enforcement-routing` was filed against.

The root cause is a layering inversion: row-time MV maintenance (and FK / change / events)
have exactly one correct home — the DML-executor post-write pipeline — but a secondary
eviction is a *hidden delete below that boundary*, so each storage substrate is forced to
reach back up and re-drive a slice of the pipeline itself. Detection legitimately differs
per substrate (each enumerates "current rows" its own way); **maintenance and cascades do
not** and should not be triplicated.

## Architecture: report, don't maintain

Make internal evictions visible, then let the existing single pipeline handle them.

### Interface (`common/types.ts`)

Extend the success branch of `UpdateResult` with an additive, optional field:

```ts
export type UpdateResult =
  | { status: 'ok'; row?: Row; replacedRow?: Row; evictedRows?: readonly Row[] }
  | { status: 'constraint'; constraint: ConstraintType; message?: string; existingRow?: Row };
```

Contract (document at the type and in `module-authoring.md`):

- `replacedRow` — **unchanged**. The row displaced at the *same PK* by a PK-collision
  REPLACE. Executor models it as an update-in-place of that PK slot: change-tracking as
  `update(replacedRow → newRow)` (INSERT path) or `delete(replacedRow)` (UPDATE move path,
  matching today), FK fired as a *delete* of the old image.
- `evictedRows` — **new**. Rows at *other PKs* fully removed by REPLACE resolving a non-PK
  UNIQUE conflict for this same `update()` call, in user-facing schema (no overlay
  tombstone column). Executor models **each** as a full DELETE: `_recordDelete`,
  `maintainRowTimeStructures({ op:'delete', oldRow })`, `executeForeignKeyActions('delete')`,
  and a delete auto-event. Fired **before** the new row's own insert/update bookkeeping, to
  match the substrate journal order (evict-then-write).

The field is optional and additive: a module that reports nothing behaves exactly as today,
so third-party modules and the leveldb/indexeddb plugins (which inherit `store-table.ts`)
need no change to stay correct — they simply don't yet report secondary evictions.

`replacedRow` and `evictedRows` are independent and may both be present in principle. (Note:
the memory/store INSERT paths currently short-circuit on a PK collision *before* the
secondary-UNIQUE check, so they cannot co-occur there today — a separate latent gap vs.
SQLite, explicitly out of scope here. The executor must still handle both fields cleanly.)

### Executor (`runtime/emit/dml-executor.ts`)

Add one shared helper that, given an `ok` result, drives the full delete pipeline for every
row in `result.evictedRows` (record delete, row-time maintenance, FK delete actions, delete
auto-event), and call it from both `runInsert` and `runUpdate` immediately before the new
row's own post-write bookkeeping. The covering-MV maintenance for evictions now flows
through `maintainRowTimeStructures` here — the same hook used for ordinary writes.

**Reads-own-writes is preserved.** The executor processes a row's `evictedRows` after that
row's `vtab.update()` returns and before the next row's `vtab.update()`. The only cross-row
dependency is the covering-MV *backing* (a separate table consulted by a later row's
detection or by a mid-statement `select from mv`); statement-granularity ordering still
holds because each `vtab.update()` takes a single up-front snapshot of its conflicts
(`_lookupCoveringConflicts` is called once per call, before any eviction in that call).

### Substrates collapse to detection-only

Each substrate's UNIQUE check accumulates the rows it evicts and returns them; **no
substrate calls `_maintainRowTimeCoveringStructures` anymore.**

- **memory (`vtab/memory/layer/manager.ts`)** — thread a `Row[]` eviction accumulator
  through `checkUniqueConstraints` → `checkSingleUniqueConstraint` →
  `checkUniqueVia{Index,MaterializedView,Scanning}`. On a REPLACE eviction, push the evicted
  row instead of (MV path) calling `_maintainRowTimeCoveringStructures`. `performInsert` /
  `performUpdate` / `performUpdateWithKeyChange` return `evictedRows` on success.
- **store (`quereus-store/src/common/store-table.ts`)** — same accumulator through
  `checkUniqueConstraints`; on REPLACE push the evicted row and `deleteRowAt` as today, but
  drop the inline `_maintainRowTimeCoveringStructures` call. The insert/update cases include
  `evictedRows` in their results.
- **isolation (`quereus-isolation/src/isolated-table.ts`)** — `checkMergedUniqueConstraints`
  collects the live merged row it evicts (the `{pk,row}` from `findMergedUniqueConflict`,
  before `insertTombstoneForPK`) and returns them; `update()` attaches them via a helper
  analogous to `attachReplacedUnderlying`, with the trailing overlay tombstone column
  stripped (mirror `stripTombstoneFromResult`). Isolation imports **no** covering-MV code;
  the executor's `maintainRowTimeStructures` keeps the backing consistent for its
  evictions — which is exactly what `covering-mv-isolation-layer-enforcement-routing` asked
  for, now obtained structurally rather than by re-pasting routing into a third place.

### Net effect

Detection stays substrate-local (correct). Maintenance + cascades live solely in the
executor (DRY). Covering-MV backing consistency for evictions is uniform across memory,
store, and isolation. FK ON DELETE actions, `Database.watch`/`ChangeScope`, and auto-events
become correct for secondary-UNIQUE REPLACE evictions everywhere. The isolation routing
ticket dissolves.

## TODO

### Phase 1 — interface + executor
- Add `evictedRows?: readonly Row[]` to the `ok` branch of `UpdateResult` and to the
  `isUpdateOk` guard's narrowed type in `common/types.ts`; document the
  `replacedRow` vs `evictedRows` contract at the type.
- In `dml-executor.ts`, add a shared `processEvictions(ctx, tableSchema, result, …)` helper
  driving `_recordDelete` + `maintainRowTimeStructures({op:'delete'})` +
  `executeForeignKeyActions('delete')` + delete `emitAutoDataEvent` per evicted row.
- Call it in `runInsert` and `runUpdate` before the new row's own post-write block (after
  any `replacedRow` handling, to keep evict-then-write order).

### Phase 2 — memory substrate
- Thread an eviction accumulator through `checkUniqueConstraints` and the three
  `checkUniqueVia*` methods; push evicted rows on REPLACE.
- Remove the inline `_maintainRowTimeCoveringStructures` call from
  `checkUniqueViaMaterializedView`.
- Return `evictedRows` from `performInsert` / `performUpdate` / `performUpdateWithKeyChange`.

### Phase 3 — store substrate
- Thread the accumulator through `store-table.ts checkUniqueConstraints`; push evicted rows
  on REPLACE; drop the inline `_maintainRowTimeCoveringStructures` call.
- Include `evictedRows` in the insert/update `UpdateResult`s.

### Phase 4 — isolation substrate
- Collect evicted merged rows in `checkMergedUniqueConstraints`; surface them (tombstone
  column stripped) from `update()` via an `attachEvicted`-style helper, alongside any
  `replacedRow`.

### Phase 5 — tests
- Promote the omitted backing-consistency assertions in
  `54-covering-mv-enforcement.sqllogic` (internal-eviction `select from mv` cases) into the
  shared body, and delete the NOTE caveat at lines ~39–44 — they must now pass under
  `yarn test:store` (memory, direct store, and isolation paths alike).
- Add coverage proving a **secondary-UNIQUE** `insert or replace` eviction (conflict on a
  non-PK UNIQUE, evictee at a different PK) fires: (a) FK ON DELETE CASCADE / SET NULL on
  the evictee's children, (b) a `Database.watch` / change-scope delta for the evicted row,
  (c) a delete auto-event — across memory (`test/covering-structure.spec.ts` or a new logic
  file) and store (`quereus-store/test/unique-constraints.spec.ts`).
- Keep a non-covered (no MV, plain UNIQUE index/scan) variant so the FK/event fix is
  validated independently of the covering-MV path.

### Phase 6 — docs
- `docs/materialized-views.md` § "Store-module parity": replace the isolation-wrapped
  paragraph (lines ~461–464) — the isolation layer no longer needs covering-MV routing; the
  executor's eviction pipeline maintains the backing uniformly. Note the
  `covering-mv-isolation-layer-enforcement-routing` resolution.
- `docs/module-authoring.md`: document the `replacedRow` vs `evictedRows` `UpdateResult`
  contract for module authors.
- `docs/runtime.md` (DML executor section): note that internal evictions are reported via
  `evictedRows` and processed through the same post-write pipeline as ordinary deletes.

### Validation
- `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).
- `yarn test` then `yarn test:store` (the store sweep is what exercises the isolation path
  and the newly-shared 54-spec assertions). Stream with `Tee-Object`.
