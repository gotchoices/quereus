---
description: Renaming a table in the middle of a transaction silently throws away the writes made earlier in that transaction, and the commit still reports success; dropping a table leaves its abandoned staged writes lying around. The layer should clean up properly and shout when it cannot.
prereq: iso-overlay-key-from-connect-args
files: packages/quereus-isolation/src/isolation-module.ts (commitConnectionOverlays ~418, destroy ~695, renameTable ~977, rekeyConnectionScopedMap ~1005), packages/quereus-isolation/test/isolation-layer.spec.ts, docs/design-isolation-layer.md
difficulty: medium
---

# Isolation: orphaned overlays on `drop table` / `alter table … rename`, and the silent `continue`

## Background

`IsolationModule` stages uncommitted writes in a per-connection *overlay* table and flushes it
into the real storage table at commit. Two maps must stay in step:

- `underlyingTables`, keyed `"<schema>.<table>"` — the real storage table.
- `connectionOverlays`, keyed `"<dbId>:<schema>.<table>"` — the staged writes.

At commit, `commitConnectionOverlays` resolves each overlay's underlying table by key. When the
lookup misses it does this:

```ts
const underlyingState = this.underlyingTables.get(underlyingKey);
if (!underlyingState) continue; // no underlying to flush (defensive)
```

…then clears every overlay for the db regardless. So a miss means: staged rows dropped, commit
reports success. The sibling ticket `iso-overlay-key-from-connect-args` fixes one cause of the
miss. This ticket covers two more, both reachable on `main` with a plain `MemoryTableModule`, and
then closes the hole for good by making a genuine miss loud.

## Defect 1 — `alter table … rename` mid-transaction loses the staged writes

`renameTable` deletes the old `underlyingTables` entry (deliberately: the underlying module may
have closed that handle during its own rename) and re-keys the overlay from the old name to the
new one. Nothing ever adds an `underlyingTables` entry under the *new* name — that only happens
on the next `connect()`. So at commit there is a staged overlay with no resolvable underlying.

Traced on `main`:

```
-> renameTable(main, widget, gadget)  BEFORE underlying=[main.widget] overlays=[1:main.widget(hc=true)]
<- renameTable                        AFTER  underlying=[]            overlays=[1:main.gadget(hc=true)]
-> commitConnectionOverlays()         BEFORE underlying=[]            overlays=[1:main.gadget(hc=true)]
```

Reproduction (fails on `main`):

```ts
await db.exec(`create table widget (id integer primary key, name text) using isolated`);
await db.exec(`begin`);
await db.exec(`insert into widget values (1, 'a')`);
await db.exec(`alter table widget rename to gadget`);
await db.exec(`commit`);            // reports success

const merged = await asyncIterableToArray(db.eval(`select * from gadget`));
// → [{"id":1,"name":"a"}]           the row LOOKS committed …

const underlying = iso.getUnderlyingState('main', 'gadget')?.underlyingTable;
// → rows actually in underlying storage = []          … but storage is empty
```

Worse than a plain drop: because the overlay is never added to `entries`, the bottom clear-loop
never removes it either. It survives the "successful" commit as a **zombie overlay**
(`1:main.gadget(hc=true)` is still in the map afterwards) and keeps merging into every subsequent
read on that `Database`. So the row reads back correctly on this connection forever, while
storage stays empty and every other reader sees nothing. This is the exact symptom of the sibling
ticket, reached by a different route.

Fix direction: `renameTable` must leave a resolvable underlying for the new name, or must not
leave a staged overlay under it. The cached `VirtualTable` handle genuinely may be dead after the
underlying module's rename (the existing comment cites `StoreModule` closing and reopening
stores), so simply re-keying `underlyingTables` old→new is not obviously safe. Options to weigh:

- Re-connect the underlying under the new name inside `renameTable` and store the fresh handle.
  `renameTable`'s signature lacks `moduleName` / `options`, so these must come from the schema
  catalog (`db.schemaManager.getTable(schema, newName)` carries the vtab module name and args).
- Have `commitConnectionOverlays` lazily resolve a missing underlying via `connect()` before it
  gives up. Same information problem, deferred to commit time.
- Flush the overlay *before* delegating to `underlying.renameTable`, so the rename always starts
  from a clean staged state. Simplest, but changes transaction semantics: it makes a mid-txn
  rename an implicit partial commit of that table, which needs a deliberate decision and a doc
  note. Probably the wrong trade.

Prefer the first. Whichever is chosen, document the reasoning where `renameTable` removes the old
state.

## Defect 2 — `drop table` abandons the overlay

`destroy()` removes the `underlyingTables` entry but never clears `connectionOverlays` or
`preOverlaySavepoints` for that table. Two shapes, traced on `main`:

```
# single table dropped mid-txn: commitConnectionOverlays never even runs
# (the table's connection was disconnected by the drop) — the overlay leaks for the db's lifetime
-> destroy(isolated, main, widget)  BEFORE underlying=[main.widget] overlays=[2:main.widget(hc=true)]
<- destroy                          AFTER  underlying=[]            overlays=[2:main.widget(hc=true)]

# a second table keeps the transaction alive, so commit runs and hits the silent `continue`
-> destroy(isolated, main, b)       BEFORE underlying=[main.a,main.b] overlays=[3:main.a(hc=true),3:main.b(hc=true)]
<- destroy                          AFTER  underlying=[main.a]        overlays=[3:main.a(hc=true),3:main.b(hc=true)]
-> commitConnectionOverlays()       BEFORE underlying=[main.a]        overlays=[3:main.a(hc=true),3:main.b(hc=true)]
```

Discarding staged writes for a dropped table is the *correct outcome* — the table is gone. But it
must happen because `destroy()` deliberately cleared them, not because a lookup missed at commit.
As it stands the two-table case only "works" by accident, and the single-table case leaks the
overlay (and its `preOverlaySavepoints` set) for the lifetime of the `Database`.

Fix: `destroy()` clears `connectionOverlays` and `preOverlaySavepoints` for that table across
**all** db ids, not just the calling one — the table is gone for every connection. Both maps are
keyed `"<dbId>:<schema>.<table>"`, so this is the same `` `:${schemaName}.${tableName}` ``
suffix scan `dropIndex` and `alterTable` already use. Factor that scan out rather than writing a
fourth copy.

## Defect 3 — make the miss loud

Once defects 1 and 2 are fixed, a staged overlay (`hasChanges === true`) with no resolvable
underlying is an invariant violation, and silently dropping the rows is the worst possible
response. Turn the `continue` into a `QuereusError(..., StatusCode.INTERNAL)`.

**Ordering matters — do this last.** I made the change experimentally on `main` and ran the full
workspace suite: 6580 tests pass, and the only failures were the two paths above. Throwing before
they are fixed converts silent data loss into spurious commit failures on `drop table` and
`alter table … rename`.

Two details:

- Guard the throw on `state.hasChanges`. An overlay that exists but staged nothing is harmless.
- A clean (`!hasChanges`) overlay with no underlying is currently skipped by the `continue`
  *before* it reaches `entries`, so the bottom clear-loop never removes it — it leaks. Collect
  those keys and delete them.
- No overlay may be cleared unless it was applied, or was empty.

## TODO

Phase 1 — stop orphaning overlays

- Extract the `` `:${schemaName}.${tableName}` `` suffix-scan into one helper on
  `IsolationModule`; use it from `dropIndex`, `alterTable`, `rekeyConnectionScopedMap`, and the
  new `destroy()` cleanup.
- `destroy()`: clear `connectionOverlays` and `preOverlaySavepoints` for the table across all db
  ids, before delegating to `underlying.destroy`.
- `renameTable()`: ensure an `underlyingTables` entry exists under the new name whenever a staged
  overlay was re-keyed onto it. Prefer re-connecting the underlying via the schema catalog's vtab
  module name / args; record why in a comment.

Phase 2 — close the hole

- Replace the `if (!underlyingState) continue` in `commitConnectionOverlays` with an INTERNAL
  `QuereusError` when `state.hasChanges`, and an explicit delete when it is clean.
- Confirm no overlay is cleared unless applied or empty.

Phase 3 — tests + docs

- Regression test: insert inside a transaction, `alter table … rename`, commit — the row must be
  present **in the underlying storage**, and no overlay may remain staged afterwards.
- Regression test: two tables written in one transaction, one dropped mid-transaction, then
  commit — the surviving table's row lands, the dropped table's overlay is gone, no throw.
- Regression test: single table written then dropped mid-transaction — no leaked overlay or
  `preOverlaySavepoints` entry.
- Direct unit test for the INTERNAL error: hand-plant a staged overlay with no underlying and
  assert `commitConnectionOverlays` throws rather than dropping it.
- Record the invariant in `docs/design-isolation-layer.md`: *every staged overlay resolves to an
  underlying table at commit; the lifecycle hooks (`destroy`, `renameTable`) are responsible for
  keeping that true, and a violation is an INTERNAL error, never a silent drop.*
- `yarn test` (whole workspace) must stay green.
