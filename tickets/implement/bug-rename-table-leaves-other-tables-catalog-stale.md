---
description: When one table is renamed, other saved tables that reference it are fixed on disk a moment too late; a crash in that gap can permanently strand them pointing at a table name that no longer exists, silently breaking writes to them.
prereq:
files:
  - packages/quereus/src/runtime/emit/alter-table.ts             # runRenameTable (192-256), propagateTableRename (1505-1580)
  - packages/quereus/src/vtab/module.ts                          # VirtualTableModule.renameTable (433); add finalizeRename hook here
  - packages/quereus-store/src/common/store-module.ts            # renameTable (2093-2250), removeTableDDL (3066), persistQueue/enqueuePersist, dispatchSchemaChange (3211), whenCatalogPersisted (3437)
  - packages/quereus-store/test/rename-catalog-durability.spec.ts # add the multi-table test here
  - docs/schema.md                                               # durability section (~lines 333-364) — document the chosen guarantee
difficulty: medium
---

# `RENAME TABLE` corrects *other* tables' persisted definitions too late

## Confirmed mechanism (reproduced)

Repro: two store tables, `parent(id)` and `child(id, p, foreign key (p) references parent(id))`,
both with at least one row on disk (so their DDL is actually persisted — see "Lazy persistence"
below). Then `alter table parent rename to parent2`. Tracing every catalog `put`/`delete`,
the durable write sequence is:

1. **inside `StoreModule.renameTable`** (synchronous within the ALTER statement):
   - `saveTableDDL(parent2)` → `put main.parent2`
   - `renameTableStores` physically moves `parent`'s data/index stores to `parent2`
   - `removeTableDDL(parent)` → **`delete main.parent`**  ← at this instant `parent` is gone from the catalog, but `child` on disk still says `references parent`
2. **back in the engine**, `runRenameTable` calls `propagateTableRename`, which rewrites
   `child`'s FK to `references parent2` in memory and fires a `table_modified` event for `child`.
3. The store's schema-change listener (`onEngineSchemaChange` → `dispatchSchemaChange`)
   **enqueues** `child`'s corrective write onto `persistQueue` (`enqueuePersist`). The ALTER
   statement does **not** await `persistQueue`; it drains on a later microtask →
   `put main.child` (now naming `parent2`).

So the bug is an **ordering / durability gap**, not a wrong final value. The final on-disk
state is correct. But between step 1's `delete main.parent` and step 3's `put main.child`, the
durable catalog holds a set that does **not** rehydrate into a working database: `child` names
`parent`, and no `parent` exists. A crash, `kill`, or a failed `child` write (the persist chain
only logs on failure) strands that state forever. On reopen `child`'s DDL still parses and its FK
resolves lazily by name, so nothing complains at load — but every insert/update on `child` that
checks the FK then fails looking for the vanished `parent`, exactly the "healthy-looking database
whose child table cannot be written to" the bug describes.

The same window exposes anything else `propagateTableRename` rewrites in another object: a
cross-schema table's FK, a `CHECK` expression naming the renamed table, a view/MV body — all ride
the same deferred `persistQueue` events.

## Why the module hook alone cannot fix it (the difference from the sibling ticket)

`bug-store-rename-column-persists-stale-index-predicate` (complete) fixed the *single-table*
version by rewriting a table's self-references (self-FK, table-qualified CHECK, partial-index
predicate) **inside** `StoreModule.renameTable` before its own `saveTableDDL`. That works because
a table's self-references live in its own definition. This ticket is the *multi-table* sibling:
the offending references live in **other** tables' definitions, and the module's `renameTable`
hook is handed one table — it cannot know which other tables name it. The cross-table rewrite is
the engine's `propagateTableRename`, which by construction runs only **after** the hook returns.

## Root cause, precisely

`StoreModule.renameTable` *swaps* the renamed table's own catalog entry (write new + **delete
old**) synchronously, before the engine has had any chance to rewrite — let alone persist —
the dependents that name the old table. The delete-old happens too early relative to the
dependents' corrective writes.

## Accepted guarantee (see `docs/schema.md`)

`docs/schema.md` documents catalog persistence as **best-effort durability** with no cross-table
atomicity promise. The ticket explicitly accepts a *narrower* guarantee than full atomicity:

> rewrite dependents *before* the renamed table's own entry is swapped, so the transient on-disk
> state names a table that still exists.

Concretely: **do not delete the old `parent` catalog entry until every dependent has been
re-persisted naming `parent2`.** During the window both `parent` and `parent2` coexist on disk;
any dependent naming either resolves, so every intermediate catalog set rehydrates into a working
database. (Full provider-atomic-batch atomicity is a possible future hardening — see Tripwires —
but is out of scope here and unavailable on non-atomic providers.)

## Recommended fix — defer old-entry removal to after dependents persist

Introduce a two-phase rename at the module boundary:

1. **`StoreModule.renameTable`**: write the new bundle + move physical stores as today, but **do
   not** call `removeTableDDL(oldName)`. Leave the old catalog entry in place.
2. **New optional hook `VirtualTableModule.finalizeRename?(db, schemaName, oldName, newName)`**,
   declared in `packages/quereus/src/vtab/module.ts` next to `renameTable`. The engine calls it
   at the **end** of `runRenameTable`, *after* `propagateTableRename` (and after the MV re-key
   block). The store's implementation:
   - `await this.whenCatalogPersisted()` (drain `persistQueue`, i.e. flush every dependent's
     corrective write that `propagateTableRename`'s events just enqueued), then
   - `await this.removeTableDDL(schemaName, oldName)` (optionally routed through `enqueuePersist`
     + a final drain, to serialize with any concurrent catalog work).
3. **Engine `runRenameTable`**: after `propagateTableRename(...)` returns, call
   `module.finalizeRename?.(rctx.db, tableSchema.schemaName, oldName, newName)` if present.

Because `propagateTableRename` fires all dependent `table_modified` / `view_modified` /
`materialized_view_modified` events synchronously before it returns, by the time `finalizeRename`
runs every dependent write is already on `persistQueue`; draining it makes them durable, and only
then is `parent` removed. Resulting on-disk timeline — every crash point rehydrates working:

| after step | `parent` entry | `parent2` entry | `child` names | rehydrates? |
|---|---|---|---|---|
| `renameTable` returns | present | present | `parent` (exists) | ✓ |
| dependents drained | present | present | `parent2` (exists) | ✓ |
| `finalizeRename` deletes old | gone | present | `parent2` (exists) | ✓ |

### Known residue (acceptable, document it)

The physical `renameTableStores` still *moves* (not copies) `parent`'s data store into `parent2`
inside `renameTable`. So during the window `parent`'s catalog entry is present but its data store
has moved; a mid-window crash + reopen makes `parent` rehydrate as an **empty** table (a fresh
store is created on connect). This is a visible, droppable orphan — strictly better than the
current invisible "child cannot be written to" failure, and it never occurs on a clean run. This
is the accepted best-effort *physical* caveat; keep it out of scope and note it in `docs/schema.md`.

### Alternatives considered (and why not)

- **Propagate dependents *before* `module.renameTable`.** Mirror-image bug: dependents would be
  persisted naming `parent2` while `parent2` doesn't yet exist on disk. No better.
- **Store-only: `enqueuePersist(removeTableDDL(old))` in `renameTable`.** FIFO puts the delete
  *before* the dependent writes (which enqueue later, during propagate) → same wrong order. The
  store cannot, from inside its own hook, order a task after events that haven't fired yet — hence
  the engine-side `finalizeRename` signal is required.
- **Provider atomic batch (`beginAtomicBatch`).** Gives true atomicity but only on atomic
  providers, and the dependent set is known only to the engine post-propagate — larger cross-module
  change than this ticket needs. Record as a tripwire, not scope.

## Correcting the reproduction sketch in the source ticket

The source ticket suggested asserting "no recorded write for `child` names `parent` — it will
fail today." **It does not fail today**: `child`'s stale bundle was written at insert time
(before any trace installed after that point), and the only `child` write *during* the rename is
the corrective one naming `parent2`. The real defect is the **ordering of the `parent` delete vs.
the `child` put**. The test must therefore trace both `put` and `delete` on the catalog store and
assert the ordering invariant — see below.

## Lazy persistence gotcha (for the test)

A store table's DDL is persisted lazily (on first store access / first row), not at `create`. A
`child` with no rows has **no** catalog entry, so `persistCatalogIfChanged` early-returns
(`existing === undefined`) and `child` is neither stale nor corrected — the bug can't bite. The
test must force `child`'s (and `parent`'s) DDL onto disk first (e.g. `insert` a row into each)
before renaming.

## TODO

### Phase 1 — reproducing test (red)
- In `packages/quereus-store/test/rename-catalog-durability.spec.ts`, reuse the existing
  `createPersistentProvider` / `traceCatalogWrites` harness but extend the trace to record
  **both** `catalog.put` and `catalog.delete` in order (key + whether put/delete + decoded DDL).
- Schema: `parent(id integer primary key)` and
  `child(id integer primary key, p integer null, foreign key (p) references parent(id))`, both
  `using store`; insert one row into each to force persistence; install the trace; then
  `alter table parent rename to parent2` and `await mod.whenCatalogPersisted()`.
- Assert the ordering invariant: the `delete` of `main.parent` must **not** precede the corrective
  `put` of `main.child` that names `parent2`. Equivalently, at the index of the `main.parent`
  delete, every other recorded entry that still names `parent` must already have been superseded.
- Add a reopen leg (via the file's `reopen()` helper) asserting `child`'s FK enforces against
  `parent2` after reopen (insert violating `p` rejected; valid `p` accepted), and zero rehydration
  errors. Confirm this test FAILS before the fix.

### Phase 2 — engine + module change (green)
- Add `finalizeRename?(db, schemaName, oldName, newName): Promise<void>` to
  `VirtualTableModule` in `packages/quereus/src/vtab/module.ts`, documented as "called after the
  engine's cross-table rename propagation, so the module may drop any now-superseded old-name
  catalog state."
- `runRenameTable` (`alter-table.ts`): after `propagateTableRename(...)` (and the MV re-key
  block), `await module.finalizeRename?.(rctx.db, tableSchema.schemaName, oldName, newName)`.
- `StoreModule.renameTable`: stop calling `removeTableDDL(schemaName, oldName)`; move that into a
  new `finalizeRename` that first `await this.whenCatalogPersisted()` then removes the old entry.
  (Keep the stats re-key that currently follows `removeTableDDL` correctly ordered — it copies the
  old stats key to the new one and deletes the old; ensure it still runs. Decide whether it stays
  in `renameTable` or moves into `finalizeRename`; it reads the old stats key, so it must run
  before the old entry/stores are considered gone — the stats store is separate from the catalog,
  so it can stay in `renameTable`.)
- The memory module owns no persistent catalog, so it needs no `finalizeRename`.

### Phase 3 — docs + validate
- Update `docs/schema.md` durability section (~lines 333-364) to state the chosen guarantee: on
  `RENAME TABLE`, dependent tables/views/MVs are re-persisted before the renamed table's own old
  catalog entry is removed, so no durable catalog set ever names a vanished table; note the
  physical-move best-effort residue (an orphan empty old table possible only on a mid-rename crash).
- Run `yarn workspace @quereus/store test` (or the store spec) — new test green.
- Run `yarn test` (engine) and `yarn lint` — no regressions. Consider `yarn test:store` for the
  LevelDB-backed ALTER path if touching timing-sensitive persistence, but the in-memory persistent
  provider in the spec already exercises the ordering.

## Tripwires (do NOT file as tickets)
- Full cross-table atomicity via `provider.beginAtomicBatch` (bundling parent-delete + all
  dependent rewrites into one atomic commit) would eliminate even the transient two-entry window
  and the physical orphan — but only on atomic providers. Leave a `// NOTE:` at the
  `finalizeRename` site in `store-module.ts` recording this as the atomic-provider hardening path,
  and one line in the review's `## Review findings`.
