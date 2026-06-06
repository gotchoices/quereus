description: Make `IsolationModule.alterTable` isolation-faithful for the cross-connection case. Today any connection's un-backfillable *uncommitted* overlay row (e.g. ADD COLUMN NOT NULL whose per-row `new.x` default yields NULL for a staged row) aborts the *issuer's* ALTER. Change to a hybrid: still reject when the **issuer's own** overlay can't be backfilled (the user issued both the data and the DDL), but for **other** connections' overlays apply the ALTER and mark the un-migratable overlay *poisoned* so its owning connection errors on next read/write/commit — never aborting the issuer and never corrupting the shared base/catalog.
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/src/isolated-table.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, packages/quereus-isolation/README.md, docs/design-isolation-layer.md
----

## Chosen semantics (hybrid B)

The companion ticket `alter-isolation-prevalidate-overlay-backfill` (now in `complete/`)
made the existing abort **atomic**: `IsolationModule.alterTable` dry-run validates every
affected overlay's backfill BEFORE the irreversible `underlying.alterTable`, so a rejection
leaves base + catalog + all overlays untouched. It deliberately preserved the *blast radius*:
**any** connection's un-backfillable overlay still aborts the issuer's ALTER.

This ticket changes the blast radius to be isolation-faithful:

- **Issuer's own overlay un-backfillable → reject the ALTER (unchanged).** The connection
  that issued the ALTER also staged the offending uncommitted row; from its own
  read-your-writes vantage that row exists and violates the new column, exactly as the
  engine's pre-mutation `validateNotNullBackfill` (a *merged* read) already treats committed
  + own-overlay rows. Atomic: nothing is mutated.
- **Another connection's overlay un-backfillable → apply the ALTER, poison that overlay.**
  The shared underlying and the schema catalog change regardless of connection B's
  *uncommitted* state. B's overlay (still in the pre-alter column layout) is marked
  **poisoned**; B's connection raises a `CONSTRAINT` error the next time it reads (merged),
  writes, or commits that table. B can then `rollback` (which discards the poison). The
  issuer's ALTER succeeds; every other connection's overlay that *can* migrate is carried
  forward exactly as today.

Net: connection A's ALTER no longer depends on any *other* connection's uncommitted data —
removing the cross-session coupling / DoS the source ticket flagged — while staying
consistent with the already-shipped behavior that silently migrates migratable overlays
forward.

### Why not the rejected alternatives
- **(A) keep aborting on any overlay.** Inconsistent (migratable B is silently carried, but
  un-migratable B aborts A) and lets one session's uncommitted data block another's DDL.
- **Pure (B) (poison even the issuer's own overlay).** Worse UX than rejecting up front: the
  issuer would succeed-then-error on next touch for a violation it caused in the same
  transaction, and it would diverge from the engine's existing own-overlay rejection.
- **Silently drop un-migratable rows / discard B's whole overlay.** Silent data loss with no
  signal to B; poison-and-error is the least-surprising correct realization.

## The poison mechanism

### State
Add an optional poison marker to `ConnectionOverlayState` (in `isolation-module.ts`):

```ts
export interface ConnectionOverlayState {
	overlayTable: VirtualTable;
	hasChanges: boolean;
	/**
	 * Set by a cross-connection ALTER that could not migrate this (foreign)
	 * overlay to the post-alter column layout. The overlay still holds
	 * PRE-alter rows, so it is structurally inconsistent with the now-committed
	 * schema; any data op that would merge or flush it must throw this message.
	 * Undefined = healthy. Cleared only by discarding the overlay (rollback /
	 * commit-failure → rollback).
	 */
	poison?: { message: string };
}
```

### Where poison is set — `IsolationModule.alterTable`
Restructure the `affected` handling into three tiers, preserving the companion ticket's
atomicity guarantee for the issuer:

1. **Partition** `affected` into the issuer's own overlay vs foreign overlays, by comparing
   each entry's key against `makeConnectionOverlayKey(db, schemaName, tableName)` (the
   `db` arg is the issuer). Also **skip already-poisoned** foreign overlays entirely (do not
   re-validate or re-migrate them — they hold rows from before an earlier ALTER and stay
   poisoned).
2. **Pre-validate the issuer's own overlay first** via the existing `validateOverlayMigration`.
   Any throw here (CONSTRAINT backfill or INTERNAL tombstone guard) propagates BEFORE
   `underlying.alterTable` — underlying + catalog + every overlay untouched (atomic abort,
   identical to today for this case).
3. **Mutate underlying**, then for each foreign overlay: attempt validation; on a
   **`StatusCode.CONSTRAINT`** failure mark it poisoned (`state.poison = { message }`) and do
   NOT migrate it; otherwise migrate it forward as today. The issuer's own overlay (already
   validated) migrates normally.

Distinguish failure classes when deciding poison vs rethrow:
- `StatusCode.CONSTRAINT` (un-backfillable NOT NULL for a staged row) → **poison** the foreign
  overlay. This is "B's data can't satisfy the new column" — B's problem.
- `StatusCode.INTERNAL` (e.g. missing tombstone column) → **rethrow** (abort). This is a
  layer invariant violation, not a data condition, and should fail loud for everyone. (After
  the underlying is already mutated an INTERNAL here is the one residual non-atomic path; it
  indicates a bug, matches the companion ticket's stance on "residual unreachable INTERNAL
  throw sites", and is acceptable to leave loud.)

Because validation runs **per foreign overlay** (catch around each), one bad foreign overlay
poisons only itself; healthy peers still migrate.

### Where poison is observed — `IsolatedTable`
The single read accessor is `getOverlayState()`. Add a guard helper and call it at the data-op
chokepoints (NOT on the committed-snapshot path):

- `update(...)` — throw before staging any write.
- `query(...)` — throw in the **merged** branch only. The fast path
  (`this.readCommitted || !this.overlayTable || !this.hasChanges`) must NOT throw: a poisoned
  overlay always has `hasChanges === true`, so a normal read reaches the merged branch and
  throws; but a `committed.<table>` read (`readCommitted`) reads only the underlying and is
  safe — it must continue to succeed.
- `flushAndClearOverlay()` (commit / `onConnectionCommit`) — throw before flushing. This is how
  a connection that never touches the table again still errors at commit.

The thrown error is `new QuereusError(state.poison.message, StatusCode.CONSTRAINT)`.
Suggested message (set at poison time, naming the table + column):
`"ALTER on '<schema>.<table>' added column '<col>' (NOT NULL) that this connection's uncommitted row cannot satisfy; roll back this transaction."`

### Poison lifecycle vs savepoints / rollback (no extra code needed — verify by test)
- **Full rollback** (`onConnectionRollback`) and **rollback to a pre-overlay savepoint**
  (`onConnectionRollbackToSavepoint` when `savepointsBeforeOverlay.has(index)`) both call
  `clearOverlay()` → the `ConnectionOverlayState` (and its poison) is dropped. Correct: the
  conflicting transaction was abandoned.
- **Rollback to a savepoint taken AFTER the overlay existed** does NOT replace the
  `ConnectionOverlayState`; the overlay's own MemoryTable connection restores row data, but
  the object's `poison` flag persists. Correct and required: the schema change is permanent
  and the overlay's rows are still in the pre-alter layout, so even if the savepoint rollback
  removed the offending row the overlay remains structurally inconsistent and must stay
  poisoned until the transaction ends.

## Edge cases & interactions

- **Issuer-own AND a foreign overlay both un-backfillable** → issuer-own check runs first and
  aborts; nothing is mutated and no foreign overlay is poisoned (atomicity).
- **Mixed foreign overlays** (B un-backfillable, C backfillable) → ALTER succeeds, B poisoned,
  C migrated, issuer's own (clean or migratable) migrated.
- **Clean foreign overlay** (`hasChanges === false`) → `validateOverlayMigration` returns
  early, migration copies nothing, never poisoned (gets a fresh empty post-alter overlay).
- **Second ALTER while a foreign overlay is already poisoned** → that overlay is skipped
  (tier 1); both ALTERs succeed, overlay stays poisoned with its original message. Do not let
  the second ALTER read the poisoned overlay's stale-layout rows.
- **`committed.<table>` read on a connection whose overlay is poisoned** → must succeed
  (reads only underlying; never merges the overlay).
- **Poisoned connection commits a transaction spanning other tables** → its IsolatedConnection
  for the poisoned table still runs `onConnectionCommit` → `flushAndClearOverlay`, which
  throws; the whole commit fails. Correct: the transaction conflicts with the committed schema
  change.
- **INTERNAL (missing-tombstone) on a foreign overlay** → rethrow, not poison (loud layer-bug
  signal).
- **DROP / RENAME of the table while an overlay is poisoned** → out of scope here; existing
  `destroy`/`renameTable` overlay handling is unchanged. Note it as a known follow-up only if
  a test trips it.
- **Concurrency** — `alterTable` mutates `connectionOverlays` non-atomically, as the existing
  migrate loop already does; DDL is engine-serialized. No new concurrency contract introduced;
  do not add locking.
- **Atomicity for the issuer is preserved** end-to-end: the only post-mutation throw added for
  foreign overlays is the INTERNAL rethrow (a bug path), matching the companion ticket's
  accepted residual.

## Key tests (extend `packages/quereus-isolation/test/isolation-layer.spec.ts`)

Use two `Database` instances over **one shared `IsolationModule`** so the two connections get
distinct `dbId`s (the module keys overlays by `getDbId(db)`); inject overlays directly via
`iso.setConnectionOverlay(dbX, 'main', 't', {...})` following the existing
`setupStagedOverlay` pattern (direct injection keeps connection counts deterministic). Drive
ALTER through `iso.alterTable(dbA, 'main', 't', change)` with an `addColumn` change carrying a
`backfillEvaluator` that yields NULL for the offending staged row and a NOT NULL column def.

- **Foreign overlay poisoned, issuer succeeds.** B (dbB) stages a row the new NOT NULL column
  can't backfill; A (dbA, clean or with a backfillable row) ALTERs. Expect: `alterTable`
  resolves; A's post-alter merged read shows the new column; the underlying + catalog reflect
  the new column; B's overlay state has `poison` set.
- **Poison observed at read / write / commit for B; committed read still works.** After the
  above, a merged `query` on a B-connected `IsolatedTable` throws `CONSTRAINT`; an `update`
  throws; `onConnectionCommit`/`flushAndClearOverlay` throws; a `readCommitted` reader for B
  returns the underlying rows without throwing.
- **Issuer's own overlay still aborts, atomically.** A stages the un-backfillable row and A
  ALTERs. Expect: `alterTable` rejects (`CONSTRAINT`); underlying column count unchanged (read
  the **live** schema via the MemoryTable's `getSchema()`, per the companion ticket's
  vacuous-assertion fix — do NOT use the cached `.tableSchema` field); A's overlay intact.
- **Mixed: B poisoned, C migrated.** Three connections; assert only B is poisoned and C's
  staged rows survive under the new layout.
- **Already-poisoned overlay skipped by a second ALTER.** Two sequential ALTERs with B
  poisoned after the first; both succeed; B's poison message unchanged; no throw from reading
  B's stale overlay during the second ALTER.
- **Savepoint stickiness vs full-rollback clearing.** (a) Full rollback on B clears poison
  (next op succeeds / overlay recreated lazily). (b) A post-overlay savepoint rollback on B
  leaves poison set. Exercise via the `onConnection*` callbacks as the existing savepoint
  tests do.
- **Regression:** the existing `alterTable` migration + the companion ticket's atomicity tests
  still pass (98 currently green).

## Docs
- `packages/quereus-isolation/README.md` — update the "Atomic ALTER" note to describe the
  cross-connection poison semantics (issuer-own → reject; foreign → poison-and-continue).
- `docs/design-isolation-layer.md` — the line stating "DDL bypasses the overlay, goes directly
  to underlying" is already stale design-vs-impl drift (overlays ARE migrated on ALTER); add a
  short subsection documenting the overlay-migration + poison semantics so the design doc
  matches the implementation.

## TODO

- Add `poison?: { message: string }` to `ConnectionOverlayState`.
- Refactor `IsolationModule.alterTable`: partition issuer-own vs foreign overlays; skip
  already-poisoned; validate issuer-own first (abort path unchanged); mutate underlying;
  per-foreign-overlay validate → poison on `CONSTRAINT`, rethrow on `INTERNAL`, else migrate.
- Build the poison message at poison time (name schema.table + column).
- Add an `assertOverlayUsable()` (or inline guard) in `IsolatedTable` and call it from
  `update`, the merged branch of `query`, and `flushAndClearOverlay`; ensure the
  `readCommitted` / fast paths never throw.
- Add the cross-connection + poison-lifecycle tests above; keep the live-schema (`getSchema()`)
  probe for the issuer-own atomicity assertion.
- Update `README.md` and `docs/design-isolation-layer.md`.
- Validate: `yarn workspace @quereus/quereus run build` (or the isolation package build) +
  `yarn workspace @quereus/isolation test` (stream with `tee`). `yarn test:store` is slow /
  not agent-runnable — note any deferral; the change is underlying-agnostic.
