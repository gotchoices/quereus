---
description: Renaming a table in the middle of a transaction still throws away that transaction's writes when the table is stored on disk — the commit reports success but nothing was saved, and later reads on the same connection keep showing the rows as if they had been.
prereq:
files: packages/quereus-store/src/common/store-module.ts (renameTable ~1724), packages/quereus-isolation/src/isolation-module.ts (commitConnectionOverlays), packages/quereus-store/test/isolated-store.spec.ts
difficulty: medium
---

# Rename inside a transaction discards the transaction's writes (disk-backed tables)

## Status: partially fixed — this is the remaining half

The originally-reported version of this bug — against the plain **in-memory** storage
module — is fixed and covered by regression tests (see
`tickets/complete/2-iso-orphaned-overlay-drop-rename.md`). The isolation layer now
re-connects a storage handle under the new name whenever a rename carries staged writes
onto it, and a staged write that cannot be matched to storage at commit is a hard
internal error instead of a silent skip.

The **disk-backed** (`quereus-store`) version is still live, and it is *not* the same
mechanism. It never reaches the new internal error, because it never reaches the commit
flush at all.

## Reproduction

Confirmed at `abacf3ea` + the memory-path fix, using `createIsolatedStoreModule` over a
key-value provider that implements `renameTableStores`:

```ts
await db.exec(`create table widget (id integer primary key, name text) using store`);
await db.exec('begin');
await db.exec(`insert into widget values (1, 'a')`);
await db.exec(`alter table widget rename to gadget`);
await db.exec('commit');                       // reports success

db.eval(`select * from gadget`)            // → [{id: 1, name: 'a'}]   (looks fine)
db.eval(`select * from committed.gadget`)  // → []                     (nothing was stored)
```

`committed.<table>` is the engine's read-through-to-storage syntax; it bypasses the
isolation layer's staging area. It comes back empty: the row never reached storage.

The three compounding symptoms are unchanged from the original report:

1. **The write is lost.** Nothing was written to storage, ever.
2. **The commit lies.** `commit` returns success rather than raising an error.
3. **The loss is masked.** Every later read on that same connection still shows the row,
   because the abandoned staging area is never cleaned up and keeps getting merged into
   reads. The data only visibly disappears once the process restarts or another connection
   looks — long after anyone could connect it to the rename.

## Mechanism

`StoreModule.renameTable` (`store-module.ts` ~1724) deliberately evicts the engine-level
connection registered for the old name:

```ts
// Evict the disposed instance's registered engine connection. It is bound to
// the OLD qualified name and its owning StoreTable is now disposed …
// Safe because the module DDL-commit above already flushed its pending ops
// (no uncommitted writes to lose).
(db as DatabaseInternal).removeConnectionsForTable(schemaName, oldName);
```

That last sentence is the bug. It holds when `StoreModule` is registered directly, where
pending writes live in the module's own transaction coordinator and the DDL-commit just
above really does flush them. It does **not** hold when `StoreModule` is wrapped by
`IsolationModule` (which is what `createIsolatedStoreModule` builds, and what the
`test:store` suite exercises): the uncommitted writes live in the isolation layer's
per-connection staging area, and the evicted connection is the `IsolatedConnection` that
is supposed to drive the flush.

Traced (probe against a real `StoreModule` + isolation wrapper):

```
after insert   staging=[118:main.widget]   connections(main.widget)=1
after rename   staging=[118:main.gadget]   connections(main.widget)=0  connections(main.gadget)=0
after commit   staging=[118:main.gadget]                   ← survived the commit
committed.gadget → []          select * from gadget → [{id:1,name:'a'}]
```

With no connection registered for either name, the database's commit loop calls
`IsolatedConnection.commit()` for nobody, so `IsolationModule.commitConnectionOverlays`
never runs. The staging area is neither flushed nor cleared — it survives as a zombie that
merges into every subsequent read on that connection. The internal error added by the
memory-path fix cannot fire, because the code that raises it is never entered.

Note the storage handle *is* correctly re-connected under the new name by then (the
memory-path fix does that for both modules); the entry sitting in `underlyingTables` is
simply never consulted.

## Expected behavior

- `begin; insert; alter table t rename to t2; commit` on a store-backed isolated table
  leaves the inserted rows readable through `committed.t2`, from a fresh connection, and
  after a restart — or `commit` fails loudly.
- No staging area outlives the transaction that created it. A leaked one keeps masking the
  loss on subsequent reads, which is what makes this so hard to spot.
- Rollback after a mid-transaction rename must still discard, as it does today.
- The same must hold for `alter table … rename to` issued against a table that another
  open connection has staged writes against.

## Notes for whoever picks this up

The tension to resolve: `StoreModule.renameTable` evicts the connection because its own
`StoreTable` instance is disposed and the connection is bound to the stale qualified name —
leaving it registered would leak one connection per rename. But under the isolation wrapper
that connection owns uncommitted state that has not been flushed. Shapes worth weighing:

- Re-register a connection under the **new** qualified name rather than dropping it, so the
  commit loop still reaches the isolation layer. Needs the registered connection object to
  survive the rename (the `IsolatedConnection`'s callback object is an `IsolatedTable` built
  under the old name — see the sibling ticket
  `iso-preoverlay-savepoints-stranded-by-rename`, which is the same staleness biting a
  different map).
- Have `IsolationModule.renameTable` flush its own staged rows before delegating. Simplest,
  but it makes a mid-transaction rename an implicit partial commit of that table, which is a
  deliberate semantic change and needs a doc note. `StoreModule.renameTable` already
  DDL-commits the whole module transaction, so the store path arguably *has* these semantics
  already — worth deciding explicitly rather than inheriting by accident.
- Make the store's connection eviction conditional on there being no wrapper above it. Least
  invasive, most fragile: the module cannot see its wrapper.

Also decide what a mid-transaction rename should mean at all for a store-backed table, given
`StoreModule.renameTable` already commits every table's pending ops in the module coordinator.
Whatever is chosen, document it in `docs/design-isolation-layer.md` next to the *Invariant:
every staged overlay resolves to an underlying table at commit* section.

Regression coverage belongs in `packages/quereus-store/test/isolated-store.spec.ts`, and must
assert through `committed.<table>` or through the storage module directly. Asserting through a
plain `select` on the writing connection passes even with the bug present — that is exactly the
masking described above. The suite's in-memory test provider does **not** implement
`renameTableStores`, so a test that needs physical relocation must supply one that does (the
existing `createInMemoryProvider` helper needs extending).

There is a placeholder test already in that file (`mid-transaction RENAME TO with staged
writes`) which asserts only the parts that work today and carries a `NOTE:` pointing here.
