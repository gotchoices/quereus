---
description: Dropping or renaming a table in the middle of a transaction used to abandon that transaction's pending writes without saying so; the layer now cleans up after itself and raises a loud internal error if it ever cannot.
prereq:
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, packages/quereus-store/test/isolated-store.spec.ts, docs/design-isolation-layer.md
difficulty: medium
---

# Orphaned overlays on `drop table` / `alter table … rename` — complete

## What the isolation layer does, in one paragraph

Uncommitted writes are staged in a per-connection **overlay** table rather than written straight
to storage. At commit the layer walks every overlay the transaction staged and flushes each into
its real storage table. Finding the storage table means crossing between two maps:
`underlyingTables`, keyed `"<schema>.<table>"`, and `connectionOverlays`, keyed
`"<dbId>:<schema>.<table>"`. Strip the `dbId:` prefix off an overlay key and you should have an
`underlyingTables` key.

## What was wrong

That lookup used to `continue` on a miss. A miss meant: staged rows silently discarded, commit
reports success, and — because the skipped overlay never reached the clear-loop either — a zombie
overlay left behind that kept merging into every later read on that connection. The connection
that lost the data was the last to notice.

Two lifecycle hooks reached the miss:

- **`renameTable`** evicted the storage handle for the old name (correct: the storage module may
  have closed it) and re-keyed the overlay onto the new name, without ever registering a handle
  under the new name.
- **`destroy`** (DROP TABLE) removed the storage handle but left the overlay and its savepoint
  bookkeeping in place.

## What changed

**`renameTable` now re-connects.** When it carries an overlay across to the new name, it connects
a fresh storage table under that name and records it. The vtab module name and args come from the
schema catalog's *pre-rename* entry — read before anything mutates, because the engine
(`runtime/emit/alter-table.ts`) updates the catalog only after this hook returns, and the hook's
own signature carries neither. When no overlay was carried across there is nothing to flush, so
eviction alone is kept and the next `connect()` resolves lazily.

**`destroy` now clears.** It deletes the `connectionOverlays` and `preOverlaySavepoints` entries
for the dropped table across *all* db ids — the table is gone for every connection — and evicts
the storage handle. All three happen only *after* `underlying.destroy` succeeds (see *Review
findings*). Discarding staged writes for a dropped table is the right outcome for the dropping
connection; doing it silently to *other* connections is not, and is now filed separately.

**The miss is now loud.** `commitConnectionOverlays` raises `QuereusError(…, INTERNAL)` when a
*staged* overlay (`hasChanges === true`) cannot resolve its storage table. A **clean** overlay
that cannot resolve staged nothing and is simply deleted — previously it was skipped before
reaching the clear-loop, so it leaked.

**Shared helper.** The four `":<schema>.<table>"` suffix scans (`dropIndex`, `alterTable`,
`rekeyConnectionScopedMap`, the new `destroy` cleanup) now go through one
`connectionScopedKeys()` method.

**Docs.** `docs/design-isolation-layer.md` gained *Invariant: every staged overlay resolves to an
underlying table at commit* under the per-connection-overlay section, plus a bullet under
*Schema Operations (DDL)*.

## Validation (re-run at review, after the review's own edits)

- `yarn build` — clean.
- `yarn lint` — clean (no errors/warnings across the workspace).
- `yarn test` (whole workspace) — 6580 + 161 + 86 + 760 + 443 + … passing, **0 failing**.
- `yarn test:store` (LevelDB-backed logic suite, which wraps `StoreModule` in `IsolationModule`) —
  6575 passing, 14 pending, 0 failing.
- `tsc --noEmit -p tsconfig.test.json` in `quereus-isolation` — clean (the mocha runner type-strips
  rather than type-checks, so the spec file needs a direct pass).

## Review findings

### What was checked

Read the implement diff (`19e27668`) against the current `isolation-module.ts` before reading the
handoff summary. Traced: the two-map key discipline and the suffix-scan helper; every caller of
`connectionScopedKeys` / `rekeyConnectionScopedMap`; `commitConnectionOverlays`' collect → apply →
commit → clear phases and its interaction with the `poison` flag; `MemoryTableModule.connect` /
`renameTable` and `StoreModule`'s dispose-and-reopen, to confirm the re-connect resolves *existing*
storage rather than a fresh empty table; the three `…BackingForAttach` seams; `destroy`'s failure
ordering. Ran build, lint, full workspace suite, store suite, and a direct `tsc` over the isolation
spec files.

### Minor — fixed in this pass

- **`destroy` discarded overlays before the underlying agreed to the drop.** The implementer flagged
  this himself (handoff gap 5) and judged it acceptable because it mirrored the pre-existing
  `removeUnderlyingState` ordering. It is not acceptable: a throwing `underlying.destroy` means the
  table still exists and every connection's staged writes are still flushable, but they had already
  been deleted. Reordered to delegate first, then evict + sweep, matching what `renameTable` already
  does. New test: *a failed underlying destroy leaves the overlay and underlying maps untouched* —
  stubs `MemoryTableModule.destroy` to throw, asserts the overlay and the storage handle both
  survive, then commits and asserts the row reaches storage.

- **`rekeyConnectionScopedMap` computed the old suffix's length from the un-lowercased name.** Map
  keys are stored lowercased, and case folding is not length-preserving for every code point
  (`'İ'.toLowerCase()` is two code units), so a table name containing one would have produced a
  corrupt re-keyed prefix. The pre-diff code took the length from the lowercased suffix; the
  refactor dropped that. Restored, with a comment.

- **Two untested re-connect paths.** The implementer's rename tests only ever renamed a table whose
  storage was *empty* at rename time (the only row lived in the overlay), so a `connect()` that
  returned a fresh empty table would have passed them. Added: *a mid-transaction RENAME TO preserves
  rows committed before the transaction* (pre-existing row + staged row must both land), and *two
  RENAME TOs in one transaction still flush the staged rows* (the second rename re-connects off the
  handle the first one registered). Both pass — `MemoryTableModule.renameTable` re-keys its manager
  before `connect()` runs, so the storage is the same object.

- **`connectionScopedKeys` docstring said "Both maps" while naming three.** Corrected, and noted
  that keys are stored lowercased.

### Major — filed as a new ticket

- **`drop table` silently discards *another* connection's staged writes, and that connection's
  commit still reports success.** `destroy`'s cross-connection sweep is the right shape but the
  wrong ending: `alterTable` faces the same "your staged rows are now invalid" situation and
  *poisons* each foreign overlay so the owning connection's commit fails. `drop table` — strictly
  more destructive — is the only DDL path that loses a foreign connection's data without telling
  it. The implementer's own test (*DROP TABLE discards another connection's staged overlay*)
  enshrines the silent discard. Filed as
  `backlog/bug-iso-drop-table-silently-discards-foreign-staged-writes`; not fixed here because the
  right error surface (reuse the ALTER poison? a new status code? savepoint interaction?) is a
  design call, and the doc + the existing test both have to move with it.

### Conditional — recorded as tripwires, not tickets

- **The three `…BackingForAttach` seams evict `underlyingTables` without sweeping overlays**, so a
  staged overlay crossing a seam would now hit the new INTERNAL guard. Safe today only because
  materialized-view backing writes are privileged and bypass the overlay, so no overlay is ever
  staged against a table that crosses a seam — the implementer's handoff (gap 4) asked this be
  checked independently, and the reasoning holds: the seams are reached only from
  `runtime/emit/materialized-view-helpers.ts` and `runtime/emit/alter-table.ts`'s detach path.
  `NOTE:` comment parked at the seam block in `isolation-module.ts`.

- **`reconnectUnderlyingAfterRename` passes `pAux: undefined`** (handoff gap 3). Confirmed harmless:
  `connect()` already forwards its own caller's `pAux` — the wrapper's aux data, not the
  underlying's — straight through, so this site inherits an assumption the layer already makes, and
  both bundled underlyings ignore the parameter. Retagged the existing prose as `NOTE:` with the
  trigger spelled out: a third-party underlying that reads `pAux` in `connect()` forces
  `IsolationModule` to capture the underlying's aux data at registration.

### Checked, no action

- **The store path still loses the writes** (handoff gap 1). `StoreModule.renameTable` calls
  `removeConnectionsForTable(schema, oldName)`, so no registered connection remains to drive
  `commitConnectionOverlays` and the new guard never fires. Confirmed not regressed by this diff and
  already tracked as `fix/iso-rename-in-txn-never-flushes-staged-rows`. The implementer asked whether
  it should have been fixed here: **no** — it lives in `StoreModule`'s connection registry, not in
  the two-map crossing this ticket owns, and the eviction semantics question (a store rename already
  DDL-commits the whole module transaction) is a separate design call. The store spec's `NOTE:`
  pointing at that ticket is correct as written.

- **A stale savepoint set survives a mid-txn rename** (handoff gap 2). Reproduced state matches the
  handoff; already tracked as `fix/iso-preoverlay-savepoints-stranded-by-rename` with a `NOTE:` at
  the site. Nothing to add.

- **Overlay tables are dropped from the map without being disposed** in `destroy`. Not new: the
  commit clear-loop, the rollback path, and `closeAll` all do the same, and the overlay is a plain
  in-memory `MemoryTable` that the GC reclaims. Consistent with the layer's existing posture, so no
  finding.

- **`connectionInFlight` is not swept by `destroy`.** The memo is identity-guarded and self-clears
  on settle, so a build racing a drop cannot outlive its promise. No finding.

- **Docs.** Re-read `docs/design-isolation-layer.md` in full against the new code. The new
  *Invariant* section and the DDL bullet are accurate for the dropping connection. The one sentence
  that will go stale — "the table is gone for all connections, so discarding their staged writes is
  correct" — is called out explicitly in the new bug ticket as needing to move with the fix; left in
  place because it describes today's behaviour truthfully.

### Empty categories

No performance, resource-leak, or type-safety findings. The suffix scans are O(overlay count) per
DDL statement and DDL is rare; there is no unmanaged resource in the diff; and `tsc` over both the
source and the spec files is clean with no `any` introduced.
