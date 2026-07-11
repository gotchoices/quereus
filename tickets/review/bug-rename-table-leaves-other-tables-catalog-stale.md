---
description: Renaming one table used to briefly leave other tables' saved definitions on disk pointing at a name that no longer exists; a crash in that gap could permanently break writes to them. Fixed by deleting the renamed table's old entry only after the dependents are safely re-saved.
prereq:
files:
  - packages/quereus/src/vtab/module.ts                          # new optional finalizeRename hook on VirtualTableModule
  - packages/quereus/src/runtime/emit/alter-table.ts             # runRenameTable now calls module.finalizeRename after propagateTableRename
  - packages/quereus-store/src/common/store-module.ts            # renameTable no longer deletes old entry; new finalizeRename does, after draining dependents
  - packages/quereus-isolation/src/isolation-module.ts           # forwards finalizeRename to the underlying module
  - packages/quereus-store/test/rename-catalog-durability.spec.ts # new multi-table ordering test + traceCatalogOps helper
  - docs/schema.md                                               # durability guarantee + best-effort residue documented
difficulty: medium
---

# Review: two-phase `RENAME TABLE` — defer old-entry delete until dependents persist

## What the bug was (plain language)

Every store-backed table's schema is saved on disk in a catalog. When you rename table
`parent` to `parent2`, any *other* table that references it (e.g. a child table with a
foreign key `references parent(id)`) must have its saved definition rewritten to say
`references parent2`. Before this fix, the store deleted `parent`'s catalog entry
**immediately** inside its rename hook — but the child's corrective rewrite only happened
a moment later, on a deferred queue. In that gap the durable catalog said: child →
`parent`, and no `parent` exists. A crash there strands that state forever. On reopen the
child's definition parses fine, but every insert/update that checks its foreign key fails
looking for the vanished `parent` — a healthy-looking database whose child table silently
can't be written to.

## The fix

Rename is now **two-phase** at the module boundary:

1. `StoreModule.renameTable` writes the new entry + moves physical stores as before, but
   **no longer deletes** the old catalog entry.
2. New optional engine hook `VirtualTableModule.finalizeRename(db, schema, oldName, newName)`.
   The engine (`runRenameTable`) calls it at the **end** of ALTER … RENAME TO, *after*
   `propagateTableRename` has rewritten every dependent and enqueued their corrective writes.
3. `StoreModule.finalizeRename` drains those writes to durability (`whenCatalogPersisted`)
   and only **then** deletes the old entry — routed through the same FIFO persist queue, so
   it lands strictly after the dependents.

During the window both `parent` and `parent2` entries coexist on disk, so every
intermediate catalog set rehydrates into a working database. `IsolationModule` forwards the
new hook to its underlying module; the memory module owns no persistent catalog and needs no
hook.

Guarantee delivered (documented in `docs/schema.md`): **no durable catalog set ever names a
vanished table.** This is deliberately narrower than full cross-table atomicity — see residue
below.

## How to validate

- **New test** (`rename-catalog-durability.spec.ts` → "RENAME TABLE re-persists a dependent
  table before deleting the renamed table"): creates `parent` + `child` (FK to parent), forces
  both DDLs to disk by inserting a row into each, traces **both** `put` and `delete` on the
  catalog store, renames, and asserts the child's corrective `put` (naming `parent2`) is durable
  **before** the `delete` of `main.parent`. Then closes, reopens (asserting zero rehydration
  errors), and checks the FK now enforces against `parent2`.
- **Red confirmed:** temporarily restoring the old synchronous `removeTableDDL` inside
  `renameTable` makes exactly this test fail on the ordering assertion (`childPut=2` vs
  `parentDelete=1`); the three pre-existing single-table tests stay green. Reverted after.
- Commands run, all green:
  - `yarn workspace @quereus/store test` → 917 passing
  - `yarn test` (engine + all workspaces) → all passing (no failures)
  - `yarn workspace @quereus/isolation test` → 240 passing
  - `yarn lint` → clean (the real lint is `@quereus/quereus`: eslint + tsc on tests)
  - `yarn build` → clean

## Known gaps (treat tests as a floor, not a ceiling)

- **Test covers only the cross-table FK dependent.** The fix is *general* — `finalizeRename`
  drains **all** dependent catalog writes on the queue regardless of kind — but the new test
  exercises only a foreign key. The ticket notes the same window also affects a **cross-schema
  FK**, a **CHECK expression naming another table**, and **view / materialized-view bodies**.
  A reviewer wanting belt-and-suspenders coverage could add a view-body and/or MV-body case and
  a cross-schema case; I judged the FK case sufficient to pin the ordering invariant, since all
  dependents ride the identical `persistQueue` path.
- **No real crash injection.** The test proves *ordering* (trace) + *clean reopen*, not an
  actual mid-window kill. The in-memory persistent provider models durable disk but is not a
  process crash. LevelDB path (`yarn test:store`) was **not** run here — the ordering lives in
  the provider-agnostic store module, so the in-memory provider exercises it, but a reviewer
  doing release-grade diligence may want the LevelDB ALTER path too.
- **Physical-move orphan is documented, not tested.** `renameTableStores` *moves* the old
  table's data store into the new name while the old catalog entry still exists, so a mid-window
  crash reopens the old name as an **empty** table (droppable orphan). This accepted residue is
  written up in `docs/schema.md` but has no test.
- **`finalizeRename` runs only on the success path.** If `propagateTableRename` throws, the old
  entry is never deleted (safe residue: both entries coexist). Not tested.
- **Old-entry delete is best-effort** (enqueued → errors logged, not fatal). Chosen on purpose:
  a failed delete leaves a droppable orphan rather than erroring a rename that already
  succeeded, and rather than stranding a dependent. Confirm this is the desired failure mode.

## Review findings

- **Tripwire (not a ticket): atomic-provider hardening.** Full cross-table atomicity —
  bundling the old-entry delete + every dependent rewrite into one `provider.beginAtomicBatch`
  commit — would eliminate even the transient two-entry window and the physical-move orphan, but
  only on atomic providers and with a larger engine↔module change. Parked as a `NOTE:` in the
  `StoreModule.finalizeRename` docblock (`store-module.ts`) and in the extended best-effort
  section of `docs/schema.md`. Out of scope here.
