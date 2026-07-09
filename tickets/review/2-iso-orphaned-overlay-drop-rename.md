---
description: Dropping or renaming a table in the middle of a transaction used to abandon that transaction's pending writes without saying so; the layer now cleans up after itself and raises a loud internal error if it ever cannot.
prereq:
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, packages/quereus-store/test/isolated-store.spec.ts, docs/design-isolation-layer.md
difficulty: medium
---

# Review: orphaned overlays on `drop table` / `alter table … rename`

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
for the dropped table across *all* db ids — the table is gone for every connection — before
delegating. Discarding staged writes for a dropped table is the right outcome; it now happens
because we chose it, not because a lookup missed.

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

## Validation

- `yarn build` — clean.
- `yarn test` (whole workspace) — 6580 + 158 + … passing, **0 failing**.
- `yarn test:store` (LevelDB-backed logic suite, which wraps `StoreModule` in `IsolationModule`) —
  6575 passing, 0 failing.
- `yarn lint` — clean.
- `tsc --noEmit -p tsconfig.test.json` in both `quereus-isolation` and `quereus-store` — clean
  (the mocha runner type-strips rather than type-checks, so the spec files needed a direct pass).

### New tests

`packages/quereus-isolation/test/isolation-layer.spec.ts` → `orphaned overlays across DROP TABLE /
RENAME TO`:

- mid-txn `rename to` → the row is asserted **in underlying storage** (via a direct query on the
  storage handle), not through a `select` — a `select` passes even with the bug present, because
  the zombie overlay answers it. No overlay may survive the commit.
- mid-txn `rename to` with nothing staged → storage intact, no overlay.
- two tables, one dropped mid-txn → survivor's row lands, dropped table's overlay is gone, no throw.
- single table written then dropped mid-txn → neither overlay nor savepoint-set entry leaks.
- `drop table` sweeps a *second* connection's staged overlay for the same table.
- hand-planted staged overlay with no storage table → `commitConnectionOverlays` throws INTERNAL.
- hand-planted **clean** overlay with no storage table → cleared, never throws.

`packages/quereus-store/test/isolated-store.spec.ts` → `mid-transaction RENAME TO with staged
writes`: pins the re-connect against a real `StoreModule`, which disposes its `StoreTable` and
re-opens the store during a rename. Asserts the handle is re-resolved under the new name and the
stale one is evicted.

## Known gaps — please probe these

**1. The store path still loses the writes, for a different reason.** This is the biggest thing to
know. `StoreModule.renameTable` calls `removeConnectionsForTable(schema, oldName)`, so after a
mid-transaction rename there is **no registered connection at all** — the database's commit loop
calls `IsolatedConnection.commit()` for nobody, `commitConnectionOverlays` never runs, and the new
INTERNAL guard never fires. The overlay survives the commit as a zombie; `committed.<table>`
returns empty. Traced with a probe:

```
after insert   staging=[118:main.widget]   connections(main.widget)=1
after rename   staging=[118:main.gadget]   connections(main.widget)=0  connections(main.gadget)=0
after commit   staging=[118:main.gadget]   committed.gadget → []   select * from gadget → [{1,'a'}]
```

This is **not** regressed by this change — it is the same on `main`. It is filed as
`fix/iso-rename-in-txn-never-flushes-staged-rows` (that ticket previously described the memory
path, which is now fixed; I re-scoped it to the live residue rather than leave it stale). The
store spec's new test deliberately asserts only what works today and carries a `NOTE:` pointing
there. **If you think the residue should have been fixed inside this ticket, say so** — I judged
the eviction/semantics question (a store rename already DDL-commits the whole module transaction)
too large to settle here.

**2. A stale savepoint set survives a mid-txn rename.** `renameTable` re-keys
`preOverlaySavepoints` old→new, but the registered connection's callback object is the
`IsolatedTable` built under the *old* name, so `onConnectionCommit` clears the old key and the
moved set outlives the transaction. Probed: `[["114:main.gadget", [0]]]` after commit. The next
transaction re-reads it, and a stale depth in that set makes `onConnectionRollbackToSavepoint`
discard the whole overlay. Filed as `fix/iso-preoverlay-savepoints-stranded-by-rename`, with a
`NOTE:` at the site. I did **not** write the SQL-level reproduction of the mis-rollback — only the
stale state. That reproduction is the first thing that ticket needs.

**3. `reconnectUnderlyingAfterRename` passes `pAux: undefined`.** The aux data the engine hands
`IsolationModule.connect()` belongs to this wrapper's registration, not the underlying's, and both
bundled underlyings (`MemoryTableModule`, `StoreModule`) ignore the parameter. A third-party
underlying that reads `pAux` in `connect()` would see `undefined` here. `connect()` itself forwards
its caller's `pAux` straight through, so it already leans on the same assumption — but this site
manufactures the value rather than forwarding one. Worth a second opinion on whether
`IsolationModule` should be capturing the underlying's aux data at registration.

**4. It throws INTERNAL where it used to silently succeed.** The full workspace suite and the store
suite are both green, so no legitimate caller is known to hit it. The attach-lifecycle seams
(`ensureBackingForAttach` / `retireBackingForAttach` / `discardBackingForAttach`) each call
`removeUnderlyingState` without touching overlays — safe today only because backing writes are
privileged and bypass the overlay, so no overlay for those tables is ever staged. That reasoning is
load-bearing for the new throw and is worth checking independently; if a staged overlay can ever
exist for a table that goes through an attach seam, the seams need the same cleanup `destroy` got.

**5. `destroy` clears overlays before delegating to `underlying.destroy`.** If the underlying's
destroy throws, the overlays are already gone. This mirrors the pre-existing `removeUnderlyingState`
ordering, so it is not new — but the blast radius is larger now (another connection's staged writes,
not just a cache entry). Deliberate; flag if you disagree.

## Review findings

_(to be filled in by the review stage)_
